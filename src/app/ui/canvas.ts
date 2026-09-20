/**
 * 画布编辑器：视口（缩放/平移）、绘制（画笔/填充/形状）、选区、快捷键。
 *
 * 设计取舍（见 docs/使用手册.md 与 docs/架构.md）：
 *  - **绝不整树重渲染**：绘制、悬停、缩放都只重画画布本身；只有结构性变化（工具/颜色/选区计数）
 *    才通过 store 通知面板。
 *  - **工作副本**：笔画期间改的是本地 `indices/alpha` 副本，抬笔才 commit 一次（= 一条撤销）。
 *  - 选区是 `Set<number>`（格索引），不在 store 里：每次点选都进 store 会让状态栏抖动。
 *  - 悬停坐标走回调，不触发 store（为此专门做事件总线是多余的，这里一个入参就够了）。
 */
import { ALPHA_THRESHOLD, type PixelArt } from '../../core/types.ts'
import { PALETTE_MAX } from '../../core/limits.ts'
import { clampCell, fitViewState, pointToCellClamped, zoomAtPoint, type ViewState } from '../../core/viewport.ts'
import { brushCells, ensurePaletteColor as coreEnsurePaletteColor, floodFillRegion, lineCells, rasterizeEllipse, rasterizeRect } from '../../core/ops.ts'
import { hexToRgb } from '../../core/color.ts'
import { store } from '../store.ts'

export interface CanvasCallbacks {
  /** 一次编辑提交（已改尺寸时用 art，否则传 indices/alpha） */
  onCommit: (indices: Uint8Array, palette: string[], alphaMask: Uint8Array | null) => void
  /** 取色（吸管 / Alt+点击） */
  onPickColor: (hex: string) => void
  /** 悬停格子（null = 移出画布） */
  onHover: (cell: { x: number; y: number } | null) => void
  /** 选区格数变化 */
  onSelectionChange: (count: number) => void
  /** 缩放百分比（供状态栏） */
  onZoom: (pct: number) => void
  /**
   * 一句面向用户的提示（可选）。目前只用在"色板已满、这一笔用了最接近的颜色"——
   * 画布层没有 toast，靠注入拿到；缺省时静默（不影响功能，只是少了提示）。
   */
  onNotice?: (message: string) => void
}

export interface CanvasApi {
  setArt: (art: PixelArt | null) => void
  /**
   * 模型 → 画布的**同尺寸**同步原语（只换像素副本，保留选区与视图）。
   *
   * 为什么不用 `setArt` 代替：`setArt` 会清空选区，而"算子编辑后选区还在"是有用的行为。
   * 见 docs/架构.md §2.1 的四条同步路径。
   */
  applyIndices: (indices: Uint8Array, palette?: string[], alphaMask?: Uint8Array | null) => void
  /**
   * **只换色板、不动像素**：色板条目改值时用。
   *
   * 像素存的是色板下标（`indices[p]`），颜色只在 `palette` 里，所以改色板第 i 项
   * 就等于改掉图上所有用该色的格子——不必碰 `indices`。比 `applyIndices` 便宜：
   * 后者每次都 `indices.slice()`，2048² 是 4MB，拖动预览按帧调会卡。
   * 语义也更准：这次确实没动像素，不该让"像素变了"的错觉进入任何判断。
   *
   * ⚠️ 只改画布**内部副本**，绝不写回 `art.palette`（见 `commit()` 上方关于 P2-05 的说明）。
   */
  setPalette: (palette: string[]) => void
  redraw: () => void
  /**
   * 适配窗口 / 按倍数缩放。
   *
   * 调用点只有画布自己：快捷键（`0` / `+` / `-`）调 `fitView` / `zoomBy`，
   * 另外 `setArt` 在**尺寸变化**时会调一次 `fitView`（否则换图后视图停在旧缩放上）。
   * 外部（UI / 页内 API）**没有调用者**；留在接口里是因为它们与 `redraw` 同属"视图控制"这一组，
   * 将来若加回视图浮层或做自动化视图断言就直接可用
   * （曾经的视图工具栏因从未接线而被删除，见 docs/架构.md §8.10 ②）。
   */
  fitView: () => void
  zoomBy: (factor: number, atCenter?: boolean) => void
  /**
   * 参考图层：由 UI 传入原图。
   * `show=false` 时**不叠原图**，但放大镜仍然取它做"原图对照"——
   * 放大镜需要这张图，UI 又不一定想要那层半透明叠加，所以两者共用一个入参但彼此独立。
   */
  setReference: (img: HTMLImageElement | null, show: boolean) => void
  /** 放大镜容器由 UI 提供（Canvas 模块只负责更新内容） */
  attachMagnifier: (box: HTMLElement, canvas: HTMLCanvasElement) => void
  dispose: () => void
}

interface Drag {
  kind: 'stroke' | 'shape' | 'select' | 'pan'
  start: { x: number; y: number }
  cur: { x: number; y: number }
  button: number
  color: string
  last: { x: number; y: number }
  mode: 'replace' | 'union'
}

const CHECKER = 8

export function createCanvas(container: HTMLElement, canvasEl: HTMLCanvasElement, callbacks: CanvasCallbacks): CanvasApi {
  const maybeCtx = canvasEl.getContext('2d')
  if (!maybeCtx) throw new Error('无法获取 2D 上下文')
  // 收窄成非空别名：TS 不会把 `const ctx` 的收窄带进下面那些嵌套函数里
  const ctx = maybeCtx

  let art: PixelArt | null = null
  let indices = new Uint8Array(0)
  let alpha: Uint8Array | null = null
  let palette: string[] = []
  let view: ViewState = { cell: 8, ox: 0, oy: 0 }
  let drag: Drag | null = null
  let selection = new Set<number>()
  let clipboard: { w: number; h: number; indices: Uint8Array; alpha: Uint8Array | null } | null = null
  let spaceDown = false
  let lKeyDown = false
  let lastStrokeCell: { x: number; y: number } | null = null
  let magEl: HTMLElement | null = null
  let magCanvas: HTMLCanvasElement | null = null
  let refImage: HTMLImageElement | null = null
  let showRef = false
  let rafId = 0
  let fallbackTimer = 0
  let disposed = false
  /** 「色板已满」只提示一次，避免用户每落一笔都被打断 */
  let warnedFullPalette = false

  /* ------------------------------------------------------------ 脏区渲染 */

  /**
   * 安排一次重绘。
   *
   * **为什么不用 `requestAnimationFrame` 单独兜底**：后台标签页、无头浏览器、
   * 以及被合成器挂起的情形下 rAF **可能永不回调**；而 `scheduleDraw` 用 `rafId` 做去重标志，
   * 一次永不回调的 rAF 会把之后所有重绘都堵死（画布表现为"完全空白"）。
   * 这是端到端测试真实抓到过的缺陷，因此这里改成 rAF 与定时器**双保险，谁先到用谁**。
   */
  function scheduleDraw(): void {
    if (disposed) return
    if (rafId || fallbackTimer) return
    const run = () => {
      if (rafId) cancelAnimationFrame(rafId)
      if (fallbackTimer) clearTimeout(fallbackTimer)
      rafId = 0
      fallbackTimer = 0
      try {
        draw()
      } catch (err) {
        // 绘制异常不能静默：一次抛错就会让画布永远空白，而用户只看到"没反应"。
        // 把原因留在 DOM 上（端到端测试会断言它为空），同时打到控制台便于排查。
        canvasEl.dataset.drawError = (err as Error)?.message ?? String(err)
        console.error('[canvas] 绘制失败：', err)
      }
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      rafId = requestAnimationFrame(run)
    }
    // 80ms 兜底：足够让可见页面走完一帧，又不会让"看不见的页面"卡住
    fallbackTimer = window.setTimeout(run, 80)
  }

  function resizeBacking(): void {
    const dpr = window.devicePixelRatio || 1
    const rect = container.getBoundingClientRect()
    const w = Math.max(1, Math.floor(rect.width))
    const h = Math.max(1, Math.floor(rect.height))
    if (canvasEl.width !== Math.floor(w * dpr) || canvasEl.height !== Math.floor(h * dpr)) {
      canvasEl.width = Math.floor(w * dpr)
      canvasEl.height = Math.floor(h * dpr)
      canvasEl.style.width = `${w}px`
      canvasEl.style.height = `${h}px`
    }
  }

  /** 把画布像素画成一个离屏 canvas（只在画布内容变化时重建） */
  let artCanvas: HTMLCanvasElement | null = null
  let artDirty = true

  function buildArtCanvas(): void {
    if (!art) return
    if (!artCanvas) artCanvas = document.createElement('canvas')
    if (artCanvas.width !== art.width || artCanvas.height !== art.height) {
      artCanvas.width = art.width
      artCanvas.height = art.height
    }
    const actx = artCanvas.getContext('2d')
    if (!actx) return
    const img = actx.createImageData(art.width, art.height)
    const rgbCache = palette.map(hexToRgb)
    for (let p = 0; p < art.width * art.height; p++) {
      const o = p * 4
      const transparent = alpha ? alpha[p] < ALPHA_THRESHOLD : false
      if (transparent) {
        img.data[o + 3] = 0
        continue
      }
      const c = rgbCache[indices[p]] ?? { r: 0, g: 0, b: 0 }
      img.data[o] = c.r
      img.data[o + 1] = c.g
      img.data[o + 2] = c.b
      img.data[o + 3] = 255
    }
    actx.putImageData(img, 0, 0)
    artDirty = false
  }

  function draw(): void {
    resizeBacking()
    const dpr = window.devicePixelRatio || 1
    const rect = container.getBoundingClientRect()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, rect.width, rect.height)
    if (!art) return
    if (artDirty) buildArtCanvas()
    if (!artCanvas) return

    const w = art.width * view.cell
    const h = art.height * view.cell

    // 透明棋盘底：只在有透明格时画，省掉大部分情况下的无谓绘制
    if (alpha) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(view.ox, view.oy, w, h)
      ctx.clip()
      ctx.fillStyle = '#2e2e2e'
      ctx.fillRect(view.ox, view.oy, w, h)
      ctx.fillStyle = '#3a3a3a'
      for (let y = 0; y * CHECKER < h; y++) {
        for (let x = 0; x * CHECKER < w; x++) {
          if ((x + y) % 2 === 0) ctx.fillRect(view.ox + x * CHECKER, view.oy + y * CHECKER, CHECKER, CHECKER)
        }
      }
      ctx.restore()
    }

    // 参考图层：半透明原图叠在下面（照着描）
    if (showRef && refImage) {
      ctx.globalAlpha = 0.45
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(refImage, view.ox, view.oy, w, h)
      ctx.globalAlpha = 1
    }

    ctx.imageSmoothingEnabled = false
    ctx.drawImage(artCanvas, view.ox, view.oy, w, h)

    // 网格：格子 ≥ 4px 才画细线，≥ 8px 才画 8 格加强线（避免小格时糊成一片）
    if (store.get('showGrid') && view.cell >= 4) {
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(255,255,255,0.10)'
      ctx.beginPath()
      for (let x = 0; x <= art.width; x++) {
        const px = Math.round(view.ox + x * view.cell) + 0.5
        ctx.moveTo(px, view.oy)
        ctx.lineTo(px, view.oy + h)
      }
      for (let y = 0; y <= art.height; y++) {
        const py = Math.round(view.oy + y * view.cell) + 0.5
        ctx.moveTo(view.ox, py)
        ctx.lineTo(view.ox + w, py)
      }
      ctx.stroke()

      if (view.cell >= 8) {
        ctx.strokeStyle = 'rgba(255,255,255,0.28)'
        ctx.beginPath()
        for (let x = 8; x < art.width; x += 8) {
          const px = Math.round(view.ox + x * view.cell) + 0.5
          ctx.moveTo(px, view.oy)
          ctx.lineTo(px, view.oy + h)
        }
        for (let y = 8; y < art.height; y += 8) {
          const py = Math.round(view.oy + y * view.cell) + 0.5
          ctx.moveTo(view.ox, py)
          ctx.lineTo(view.ox + w, py)
        }
        ctx.stroke()
      }
    }

    // 画布外框
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth = 1
    ctx.strokeRect(view.ox + 0.5, view.oy + 0.5, w - 1, h - 1)

    // 选区：每个选中格描边 + 整块外框（逐格描边在几千格时也够快，且视觉最清楚）
    if (selection.size > 0) {
      ctx.fillStyle = 'rgba(71,114,179,0.28)'
      ctx.strokeStyle = 'rgba(90,134,201,0.95)'
      for (const p of selection) {
        const x = p % art.width
        const y = (p / art.width) | 0
        const px = view.ox + x * view.cell
        const py = view.oy + y * view.cell
        ctx.fillRect(px, py, view.cell, view.cell)
        ctx.strokeRect(px + 0.5, py + 0.5, view.cell - 1, view.cell - 1)
      }
    }

    // 形状拖拽预览
    if (drag && drag.kind === 'shape') {
      const cells = currentShapeCells()
      ctx.fillStyle = 'rgba(255,255,255,0.25)'
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'
      for (const p of cells) {
        const x = p % art.width
        const y = (p / art.width) | 0
        ctx.strokeRect(view.ox + x * view.cell + 0.5, view.oy + y * view.cell + 0.5, view.cell - 1, view.cell - 1)
      }
    }

    // 笔刷足迹预览（悬停在画布上时）
    if (store.get('showMag') && hoverCell && !drag && (store.get('tool') === 'pencil' || store.get('tool') === 'rect')) {
      const size = store.get('brushSize')
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'
      ctx.lineWidth = 1
      for (const p of brushCells(art.width, art.height, hoverCell.x, hoverCell.y, size)) {
        const x = p % art.width
        const y = (p / art.width) | 0
        ctx.strokeRect(view.ox + x * view.cell + 0.5, view.oy + y * view.cell + 0.5, view.cell - 1, view.cell - 1)
      }
    }

    // 自检标记：把"这一帧到底画了什么"留在 DOM 上，便于端到端断言与故障定位
    // （曾经出现过"UI 装好了但画布全空白"，靠这行一眼看出是绘制没跑还是尺寸为 0）
    canvasEl.dataset.draws = String((Number(canvasEl.dataset.draws) || 0) + 1)
    canvasEl.dataset.lastDraw = JSON.stringify({ cell: view.cell, ox: view.ox, oy: view.oy, w: art.width, h: art.height })
  }

  /** 形状工具的目标格（Shift 约束正方/正圆） */
  function currentShapeCells(): number[] {
    if (!art || !drag) return []
    let { x: x0, y: y0 } = drag.start
    let { x: x1, y: y1 } = drag.cur
    if (shiftDown) {
      const size = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
      x1 = x0 + Math.sign(x1 - x0 || 1) * size
      y1 = y0 + Math.sign(y1 - y0 || 1) * size
    }
    const tool = store.get('tool')
    if (tool === 'rect') return rasterizeRect(art.width, art.height, x0, y0, x1, y1, true)
    if (tool === 'ellipse') return rasterizeEllipse(art.width, art.height, x0, y0, x1, y1, true)
    return []
  }

  /* ------------------------------------------------------------ 坐标换算 */

  let hoverCell: { x: number; y: number } | null = null
  let shiftDown = false

  function toCell(e: PointerEvent | MouseEvent): { x: number; y: number } | null {
    const rect = canvasEl.getBoundingClientRect()
    return pointToCellClamped(view, e.clientX - rect.left, e.clientY - rect.top, art?.width ?? 0, art?.height ?? 0)
  }

  /* ------------------------------------------------------------ 绘制操作 */

  function paintCells(cells: number[], erase: boolean): void {
    if (!art) return
    if (erase) {
      if (!alpha) alpha = new Uint8Array(art.width * art.height).fill(255)
      for (const p of cells) alpha[p] = 0
    } else {
      const idx = ensurePaletteColor(store.get('primary'))
      if (idx < 0) return
      for (const p of cells) {
        indices[p] = idx
        if (alpha) alpha[p] = 255
      }
    }
    artDirty = true
  }

  /**
   * 色板扩色：**复用 core 的规则**（`ensurePaletteColor` 负责校验与"色板满"的策略），
   * 这里只补画布特有的那一步——把新颜色追加进本地工作色板。
   *
   * 色板满（256）时退化为 OKLab 最近色，并**提示一次**：旧实现是静默 `return -1`（那一笔不落），
   * 用户会觉得"画不上去"却不知道原因——静默失效是本项目最忌讳的一类。
   */
  function ensurePaletteColor(hex: string): number {
    const r = coreEnsurePaletteColor(palette, hex, true)
    if (r.index < 0) return -1
    if (r.index === palette.length) palette = [...palette, hex.toLowerCase()]
    if (r.approx && !warnedFullPalette) {
      warnedFullPalette = true
      callbacks.onNotice?.(`色板已满（${PALETTE_MAX} 色），这一笔用了最接近的颜色`)
    }
    return r.index
  }

  /** 油漆桶：连通区域的判定走 core（`floodFillRegion`），画布层只做"线性索引 → 格子坐标"的适配 */
  function floodFill(start: number): number[] {
    if (!art) return []
    const w = art.width
    return floodFillRegion(indices, w, art.height, start % w, Math.floor(start / w), alpha)
  }

  function commit(): void {
    if (!art) return
    /**
     * **不要在这里写 `art.palette = palette`。**
     *
     * canvas 持有的 `art` 可能正是被压进撤销栈的那个对象（例如 `newCanvas()` 之后的基线），
     * 而 canvas 内部的 `palette` 会随落笔就地扩容。一旦写回，历史快照里的色板数组就被同步改写——
     * 表现为"撤销后像素对了、但色板多出已撤销的颜色，artHash 也不再回到初始值"（测试报告 P2-05）。
     * 提交只通过 `onCommit` 传出**拷贝**，由上层决定新的画布对象。
     */
    callbacks.onCommit(indices.slice(), [...palette], alpha ? alpha.slice() : null)
  }

  /* ------------------------------------------------------------ 指针交互 */

  function onPointerDown(e: PointerEvent): void {
    if (!art) return
    const cell = toCell(e)
    if (!cell) return
    canvasEl.setPointerCapture?.(e.pointerId)
    const tool = store.get('tool')

    // 平移优先：中键或空格
    if (e.button === 1 || spaceDown) {
      drag = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, cur: { x: e.clientX, y: e.clientY }, button: e.button, color: '', last: cell, mode: 'replace' }
      e.preventDefault()
      return
    }
    // Alt+点击 = 临时取色（不切换工具）
    if (e.altKey && e.button === 0) {
      pickAt(cell)
      return
    }
    if (tool === 'picker' && e.button === 0) {
      pickAt(cell)
      return
    }
    if (tool === 'selection') {
      if (e.button !== 0) return
      const mode = e.shiftKey ? 'union' : 'replace'
      if (!e.shiftKey) {
        selection = new Set()
      }
      drag = { kind: 'select', start: cell, cur: cell, button: e.button, color: '', last: cell, mode }
      applySelectionRect()
      return
    }

    const erase = store.get('transparent') && e.button !== 2
    const color = e.button === 2 ? store.get('bg') : store.get('primary')

    if (tool === 'bucket') {
      const cells = floodFill(cell.y * art.width + cell.x)
      if (erase) {
        paintCells(cells, true)
      } else {
        const idx = ensurePaletteColor(color)
        if (idx >= 0) {
          if (!alpha) alpha = null
          for (const p of cells) {
            indices[p] = idx
            if (alpha) alpha[p] = 255
          }
          artDirty = true
        }
      }
      commit()
      scheduleDraw()
      return
    }

    if (tool === 'rect' || tool === 'ellipse') {
      drag = { kind: 'shape', start: cell, cur: cell, button: e.button, color, last: cell, mode: 'replace' }
      scheduleDraw()
      return
    }

    // 画笔（含按住 L 的直线模式）
    drag = { kind: 'stroke', start: cell, cur: cell, button: e.button, color, last: cell, mode: 'replace' }
    if (lKeyDown && lastStrokeCell) {
      const cells = lineCells(art.width, art.height, lastStrokeCell.x, lastStrokeCell.y, cell.x, cell.y, store.get('brushSize'))
      paintCellsWithColor(cells, color, erase)
    } else {
      paintCellsWithColor(brushCells(art.width, art.height, cell.x, cell.y, store.get('brushSize')), color, erase)
    }
    /**
     * 每次落笔都推进"上次落笔点"锚点。
     *
     * 必须在这里（而不是只在 pointermove 里）推进：否则"按住 L 连续点击"永远从最初那一笔的终点发散
     * （画出来是一束扇形而不是链式折线）——这是测试报告里的 P2-03。
     */
    lastStrokeCell = cell
    artDirty = true
    scheduleDraw()
  }

  /** 画笔落色：统一处理"挖洞"与"上色"两条路径（形状/直线也走它） */
  function paintCellsWithColor(cells: number[], color: string, erase: boolean): void {
    if (!art) return
    if (erase) {
      paintCells(cells, true)
      return
    }
    const idx = ensurePaletteColor(color)
    if (idx < 0) return
    for (const p of cells) {
      indices[p] = idx
      if (alpha) alpha[p] = 255
    }
    artDirty = true
  }

  function onPointerMove(e: PointerEvent): void {
    if (!art) return
    const cell = toCell(e)
    if (!drag) {
      if (cell) {
        if (!hoverCell || hoverCell.x !== cell.x || hoverCell.y !== cell.y) {
          hoverCell = cell
          callbacks.onHover(cell)
          updateMagnifier(e)
          scheduleDraw()
        }
      } else if (hoverCell) {
        hoverCell = null
        callbacks.onHover(null)
        hideMagnifier()
        scheduleDraw()
      }
      return
    }

    if (drag.kind === 'pan') {
      view = { ...view, ox: view.ox + (e.clientX - drag.cur.x), oy: view.oy + (e.clientY - drag.cur.y) }
      drag.cur = { x: e.clientX, y: e.clientY }
      scheduleDraw()
      return
    }
    if (!cell) return

    if (drag.kind === 'select') {
      drag.cur = cell
      applySelectionRect()
      scheduleDraw()
      return
    }
    if (drag.kind === 'shape') {
      drag.cur = cell
      scheduleDraw()
      return
    }
    // 笔画：从上一格连直线到当前格，保证快速拖动不留断点
    if (cell.x === drag.last.x && cell.y === drag.last.y) return
    const erase = store.get('transparent') && drag.button !== 2
    const cells = lineCells(art.width, art.height, drag.last.x, drag.last.y, cell.x, cell.y, store.get('brushSize'))
    paintCellsWithColor(cells, drag.color, erase)
    drag.last = cell
    lastStrokeCell = cell
    scheduleDraw()
  }

  function onPointerUp(e: PointerEvent): void {
    if (!drag) return
    const kind = drag.kind
    if (kind === 'shape') {
      const cells = currentShapeCells()
      const erase = store.get('transparent') && drag.button !== 2
      paintCellsWithColor(cells, drag.color, erase)
    }
    drag = null
    canvasEl.releasePointerCapture?.(e.pointerId)
    if (kind === 'stroke' || kind === 'shape' || kind === 'select') {
      if (kind !== 'select') commit()
      lastStrokeCell = kind === 'stroke' ? lastStrokeCell : null
      callbacks.onSelectionChange(selection.size)
    }
    scheduleDraw()
  }

  function applySelectionRect(): void {
    if (!art || !drag) return
    const { start, cur, mode } = drag
    const next = mode === 'replace' ? new Set<number>() : new Set(selection)
    for (const p of rasterizeRect(art.width, art.height, start.x, start.y, cur.x, cur.y, true)) next.add(p)
    selection = next
    callbacks.onSelectionChange(selection.size)
  }

  function pickAt(cell: { x: number; y: number }): void {
    if (!art) return
    const p = cell.y * art.width + cell.x
    if (alpha && alpha[p] < ALPHA_THRESHOLD) {
      store.set('transparent', true)
      return
    }
    const hex = palette[indices[p]]
    if (hex) callbacks.onPickColor(hex)
  }

  /* ------------------------------------------------------------ 放大镜 */

  function updateMagnifier(e: PointerEvent): void {
    if (!magEl || !magCanvas || !art || !hoverCell || !refImage) return
    if (!store.get('showMag')) return
    const rect = canvasEl.getBoundingClientRect()
    magEl.style.display = 'block'
    const x = Math.min(rect.width - 140, e.clientX - rect.left + 18)
    const y = Math.min(rect.height - 140, e.clientY - rect.top + 18)
    magEl.style.transform = `translate(${x}px, ${y}px)`
    const mctx = magCanvas.getContext('2d')
    if (!mctx) return
    mctx.imageSmoothingEnabled = false
    mctx.clearRect(0, 0, magCanvas.width, magCanvas.height)
    // 显示原图对应区域：以当前格为中心取 5×5 格的原始像素范围
    const srcX = (hoverCell.x / art.width) * refImage.naturalWidth
    const srcY = (hoverCell.y / art.height) * refImage.naturalHeight
    const srcW = refImage.naturalWidth / art.width
    const srcH = refImage.naturalHeight / art.height
    const zoom = 5
    mctx.drawImage(refImage, srcX - srcW * (zoom - 1) / 2, srcY - srcH * (zoom - 1) / 2, srcW * zoom, srcH * zoom, 0, 0, magCanvas.width, magCanvas.height)
  }

  function hideMagnifier(): void {
    if (magEl) magEl.style.display = 'none'
  }

  /* ------------------------------------------------------------ 选区操作 */

  function clipSelection(): void {
    if (!art || selection.size === 0) return
    let minX = art.width
    let minY = art.height
    let maxX = 0
    let maxY = 0
    for (const p of selection) {
      const x = p % art.width
      const y = (p / art.width) | 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    const w = maxX - minX + 1
    const h = maxY - minY + 1
    const ci = new Uint8Array(w * h)
    const ca = alpha ? new Uint8Array(w * h) : null
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const src = (minY + y) * art.width + (minX + x)
        const dst = y * w + x
        if (!selection.has(src)) continue
        ci[dst] = indices[src]
        if (ca && alpha) ca[dst] = alpha[src]
      }
    }
    clipboard = { w, h, indices: ci, alpha: ca }
    store.set('clipboardHas', true)
  }

  function pasteSelection(at: { x: number; y: number }): void {
    if (!art || !clipboard) return
    const { w, h, indices: ci, alpha: ca } = clipboard
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const tx = at.x + x
        const ty = at.y + y
        if (tx < 0 || tx >= art.width || ty < 0 || ty >= art.height) continue
        const dst = ty * art.width + tx
        const src = y * w + x
        indices[dst] = ci[src]
        if (ca) {
          if (!alpha) alpha = new Uint8Array(art.width * art.height).fill(255)
          alpha[dst] = ca[src]
        }
      }
    }
    artDirty = true
    commit()
    scheduleDraw()
  }

  function operateSelection(op: 'erase' | 'fill' | 'move', dx = 0, dy = 0): void {
    if (!art || selection.size === 0) return
    if (op === 'erase') {
      if (!alpha) alpha = new Uint8Array(art.width * art.height).fill(255)
      for (const p of selection) alpha[p] = 0
      artDirty = true
      commit()
    } else if (op === 'fill') {
      const idx = ensurePaletteColor(store.get('primary'))
      if (idx < 0) return
      for (const p of selection) {
        indices[p] = idx
        if (alpha) alpha[p] = 255
      }
      artDirty = true
      commit()
    } else {
      // 移动选区内容：先把选区内容取出，再清空原位置，最后贴到新位置
      const moved = new Set<number>()
      const buf: { p: number; i: number; a: number }[] = []
      for (const p of selection) {
        const x = p % art.width
        const y = (p / art.width) | 0
        const nx = x + dx
        const ny = y + dy
        buf.push({ p, i: indices[p], a: alpha ? alpha[p] : 255 })
        if (nx >= 0 && nx < art.width && ny >= 0 && ny < art.height) moved.add(ny * art.width + nx)
      }
      for (const b of buf) {
        const x = b.p % art.width
        const y = (b.p / art.width) | 0
        indices[y * art.width + x] = 0
        if (alpha) alpha[y * art.width + x] = 0
      }
      for (let k = 0; k < buf.length; k++) {
        const b = buf[k]
        const x = b.p % art.width
        const y = (b.p / art.width) | 0
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || nx >= art.width || ny < 0 || ny >= art.height) continue
        indices[ny * art.width + nx] = b.i
        if (alpha) alpha[ny * art.width + nx] = b.a
      }
      selection = moved
      callbacks.onSelectionChange(selection.size)
      artDirty = true
      commit()
    }
    scheduleDraw()
  }

  /* ------------------------------------------------------------ 快捷键 */

  function onKeyDown(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
    const k = e.key
    const mod = e.ctrlKey || e.metaKey
    if (k === 'Shift') shiftDown = true
    if (e.code === 'Space') {
      spaceDown = true
      e.preventDefault()
      return
    }
    if (k === 'l' || k === 'L') lKeyDown = true
    if (mod && (k === 'c' || k === 'C')) {
      clipSelection()
      return
    }
    if (mod && (k === 'v' || k === 'V')) {
      if (clipboard) {
        e.preventDefault()
        pasteSelection(hoverCell ?? { x: 0, y: 0 })
      }
      return
    }
    if (mod) return
    if (k === 'Escape') {
      selection = new Set()
      callbacks.onSelectionChange(0)
      // 已复制的那片也一起丢掉：`Ctrl+V` 的分支只看 clipboard 非空，而它此前从不置空，
      // 于是"复制过一次"就等于永久占住了 `Ctrl+V`——图片粘贴（window 的 paste 监听）
      // 再也轮不到，且没有任何办法退出，只能刷新页面。Esc 是本项目统一的"放弃"手势
      // （取色器、色板微调都是它），把剪贴板纳入同一语义。
      clipboard = null
      store.set('clipboardHas', false)
      scheduleDraw()
      return
    }
    if (k === 'Delete' || k === 'Backspace' || k === 'x' || k === 'X') {
      if (selection.size) {
        e.preventDefault()
        operateSelection('erase')
      }
      return
    }
    if (k === 'f' || k === 'F') {
      if (selection.size) {
        e.preventDefault()
        operateSelection('fill')
      }
      return
    }
    if (k.startsWith('Arrow')) {
      if (!selection.size) return
      e.preventDefault()
      const step = e.shiftKey ? 10 : 1
      const dx = k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0
      const dy = k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0
      operateSelection('move', dx, dy)
      return
    }
    if (k === '+' || k === '=') {
      e.preventDefault()
      zoomBy(1.2, true)
    } else if (k === '-') {
      e.preventDefault()
      zoomBy(1 / 1.2, true)
    } else if (k === '0') {
      e.preventDefault()
      fitView()
    }
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (e.key === 'Shift') shiftDown = false
    if (e.code === 'Space') spaceDown = false
    if (e.key === 'l' || e.key === 'L') lKeyDown = false
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault()
    const rect = canvasEl.getBoundingClientRect()
    const next = zoomAtPoint(view, e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15)
    view = next
    reportZoom()
    scheduleDraw()
  }

  function reportZoom(): void {
    callbacks.onZoom(Math.round(view.cell * 100))
  }

  /* ------------------------------------------------------------ 视口 */

  function fitView(): void {
    if (!art) return
    const rect = container.getBoundingClientRect()
    view = fitViewState(art.width, art.height, rect.width, rect.height, 24)
    reportZoom()
    scheduleDraw()
  }

  function zoomBy(factor: number, atCenter = false): void {
    if (!art) return
    const rect = container.getBoundingClientRect()
    const mx = atCenter ? rect.width / 2 : view.ox + (art.width * view.cell) / 2
    const my = atCenter ? rect.height / 2 : view.oy + (art.height * view.cell) / 2
    view = { ...view, cell: clampCell(view.cell * factor) }
    view = zoomAtPoint(view, mx, my, 1)
    reportZoom()
    scheduleDraw()
  }

  /* ------------------------------------------------------------ 外部接口 */

  function syncFromArt(): void {
    if (!art) {
      indices = new Uint8Array(0)
      alpha = null
      palette = []
      artDirty = true
      scheduleDraw()
      return
    }
    indices = art.indices.slice()
    alpha = art.alphaMask ? art.alphaMask.slice() : null
    palette = [...art.palette]
    artDirty = true
    scheduleDraw()
  }

  function setArt(next: PixelArt | null): void {
    const sizeChanged = !art || !next || art.width !== next.width || art.height !== next.height
    art = next
    selection = new Set()
    callbacks.onSelectionChange(0)
    syncFromArt()
    if (sizeChanged) fitView()
  }

  const api: CanvasApi = {
    setArt,
    applyIndices: (nextIndices, nextPalette, nextAlpha) => {
      indices = nextIndices.slice()
      if (nextPalette) palette = [...nextPalette]
      if (nextAlpha !== undefined) alpha = nextAlpha ? nextAlpha.slice() : null
      artDirty = true
      scheduleDraw()
    },
    redraw: scheduleDraw,
    setPalette: (nextPalette) => {
      palette = [...nextPalette]
      artDirty = true
      scheduleDraw()
    },
    fitView,
    zoomBy,
    /** 参考图层（半透明叠原图"照着描"）：`show=false` 时不叠，但放大镜仍用这张图 */
    setReference: (img, show) => {
      refImage = img
      showRef = show
      scheduleDraw()
    },
    /** 放大镜容器由 UI 提供（Canvas 模块只负责更新内容） */
    attachMagnifier: (box, canvas) => {
      magEl = box
      magCanvas = canvas
    },
    dispose: () => {
      disposed = true
      if (rafId) cancelAnimationFrame(rafId)
      if (fallbackTimer) clearTimeout(fallbackTimer)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      canvasEl.removeEventListener('wheel', onWheel)
      canvasEl.removeEventListener('pointerdown', onPointerDown)
      canvasEl.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      ro.disconnect()
    },
  }

  // 事件绑定
  canvasEl.addEventListener('pointerdown', onPointerDown)
  canvasEl.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  canvasEl.addEventListener('wheel', onWheel, { passive: false })
  canvasEl.addEventListener('contextmenu', (e) => e.preventDefault())
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)

  const ro = new ResizeObserver(() => {
    const rect = container.getBoundingClientRect()
    void rect
    scheduleDraw()
  })
  ro.observe(container)

  return api
}
