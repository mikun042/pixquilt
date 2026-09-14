/**
 * 编辑算子：画布变换的纯函数实现。
 *
 * 设计要点（改动前必读）：
 *  - **声明式**：一次调用 = 一串算子，返回逐条改动量；调用方（UI 或 API）只负责提交一条撤销。
 *  - **changed 是权威判定**：索引、不透明度、尺寸任一变化都算改动。只改 alpha 的"挖洞"以前被
 *    静默丢弃过，这是最难回归的一类 bug，因此这里把它提升为显式字段。
 *  - **无副作用路径不继承主色**：`render()` / `renderBlank()` 在不碰工作台状态的前提下跑算子，
 *    绘画类算子必须显式给 `color`，否则结果依赖"当前主色"而不可复现。由调用方把 fallback 传成
 *    undefined 来强制这一点。
 *  - 越界坐标**静默裁剪**并计入 cells；宽高上限**夹紧**而不是报错（批处理里"图比预期小"很常见）。
 *
 * 本文件只管"算子语义与画布状态"，纯几何栅格化在 `rasterize.ts`（这边 re-export 出去，
 * 既有的 `from './ops.ts'` 导入路径不用改）。
 */
import { ALPHA_THRESHOLD, MAX_CANVAS_SIDE, PALETTE_MAX } from './limits.ts'
import { normalizeHex, type PixelArt } from './types.ts'
import { buildPaletteLabs, hexToRgb, nearestColorIndex, rgbToOklab } from './color.ts'
import { brushCells, lineCells, rasterizeEllipse, rasterizeRect } from './rasterize.ts'
import { anchorOffset, floodFillRegion, opaqueBounds } from './canvas-query.ts'
import { mirrorCells, outlineCells } from './ops-shapes.ts'

// 转发出去：既有的 `from './ops.ts'` 导入路径保持不变（画布层与单测都在用）
export { brushCells, lineCells, rasterizeEllipse, rasterizeRect }
export { anchorOffset, floodFillRegion, opaqueBounds }
export { mirrorCells, outlineCells }

export type EditOp =
  /** 油漆桶：把 (x,y) 所在连通区域整体换色；erase 则整块挖成透明 */
  | { op: 'fill'; x: number; y: number; color?: string; erase?: boolean }
  /** 指定格子批量上色 / 挖洞 */
  | { op: 'setCells'; cells: [number, number][]; color?: string; erase?: boolean }
  /** 整幅涂色；erase 清空成全透明 */
  | { op: 'setAll'; color?: string; erase?: boolean }
  /** Bresenham 直线（brushSize 1–3，与界面笔刷同一套足迹） */
  | { op: 'line'; x0: number; y0: number; x1: number; y1: number; color?: string; brushSize?: number }
  /** 矩形；filled: false 为空心 */
  | { op: 'rect'; x0: number; y0: number; x1: number; y1: number; color?: string; filled?: boolean }
  /** 椭圆（内切于给定外接框，与界面椭圆工具同一栅格化） */
  | { op: 'ellipse'; x0: number; y0: number; x1: number; y1: number; color?: string; filled?: boolean }
  /** 镜像 / 旋转（90、270 会交换宽高，alpha 一起搬） */
  | { op: 'transform'; kind: 'flipX' | 'flipY' | 'rotate90' | 'rotate180' | 'rotate270' }
  /** 裁掉四周透明边，画布缩到不透明内容的外接框（精灵图紧凑化） */
  | { op: 'trim' }
  /** 便捷算子：把某色全部挖成透明（去白底）；等价于按色选区 + setCells(erase) */
  | { op: 'eraseColor'; color: string }
  /** 便捷算子：把某色整体换成另一色（拼豆"没有这个色，换一个看看"） */
  | { op: 'replaceAny'; color: string; to: string }
  /**
   * 描边：给不透明内容的边界外侧补一圈实色（像素画最常见的收尾工序）。
   *
   * 默认 `connectivity: 8` = 完整一圈（含斜角）；`connectivity: 4` = 只描正交相邻的那圈，
   * 四个斜角留空——真的需要时再显式选它。
   *
   * 只往**空的（透明）格**写，已有内容一律不被覆盖。注意它是**扩张**操作：
   * 对同一张图再描一次会把刚描的一圈当成内容继续向外扩；要加粗请用 `offset`。
   */
  | { op: 'outline'; color?: string; connectivity?: 4 | 8; offset?: number }
  /**
   * 镜像加笔：把当前内容镜像到画布另一侧（对称角色/道具/装饰）。
   * 以画布中线为轴，原内容**保留**，镜像副本叠加上去；副本里的透明格不落笔。
   */
  | { op: 'mirror'; kind: 'h' | 'v' | 'both'; color?: string }

export interface OpChange {
  op: string
  kind?: string
  /** 受影响的格数（形状重排记 0，用 kind 说明发生了什么） */
  cells: number
  /** 是否真的改动了画布（权威判定，含只改 alpha 的编辑） */
  changed: boolean
  /** 语义补充：同色替换、色板已满退化为近似色等 */
  note?: string
}

export interface ApplyOpsResult {
  art: PixelArt
  changes: OpChange[]
  applied: boolean
}

/** 色板索引上限：查询表用，避免越界读到 undefined */
function paletteIndexOf(palette: string[], hex: string): number[] {
  const norm = normalizeHex(hex)
  if (!norm) return []
  const out: number[] = []
  for (let i = 0; i < palette.length; i++) if (palette[i].toLowerCase() === norm) out.push(i)
  return out
}

/**
 * 把颜色加入色板并返回索引。
 * 色板满时的行为由 `allowApprox` 决定：
 *  - true（自由模式）：退化为 OKLab 最近色并记 note，**不报错**（用户宁可要图也不要报错）
 *  - false（拼豆/资产模式，lockPalette）：返回 -1，调用方报错——"只能用我有的号色"是硬要求
 */
export function ensurePaletteColor(palette: string[], hex: string, allowApprox: boolean): { index: number; approx: boolean } {
  const norm = normalizeHex(hex)
  if (!norm) return { index: -1, approx: false }
  const existing = palette.findIndex((c) => c.toLowerCase() === norm)
  if (existing >= 0) return { index: existing, approx: false }

  // 还有空位就直接追加（这是最常见路径，不要走到下面的换算）
  if (palette.length < PALETTE_MAX) return { index: palette.length, approx: false }
  if (!allowApprox) return { index: -1, approx: false }

  // 色板已满且允许近似：找感知最近色
  if (palette.length === 0) return { index: -1, approx: false }
  const rgb = hexToRgb(norm)
  const lab = rgbToOklab(rgb.r, rgb.g, rgb.b)
  const labs = buildPaletteLabs(palette.map(hexToRgb))
  return { index: nearestColorIndex(labs, lab.L, lab.a, lab.b), approx: true }
}

/** 带 alpha 的画布视图：indices 与 alphaMask 始终等长，alphaMask 为 null 表示全不透明 */
interface Canvas {
  w: number
  h: number
  indices: Uint8Array
  palette: string[]
  alpha: Uint8Array | null
}

function toCanvas(art: PixelArt): Canvas {
  const total = art.width * art.height
  const alpha = art.alphaMask && art.alphaMask.length === total ? art.alphaMask.slice() : null
  return { w: art.width, h: art.height, indices: art.indices.slice(), palette: [...art.palette], alpha }
}

function fromCanvas(c: Canvas): PixelArt {
  const normalized = c.alpha && c.alpha.some((v) => v < ALPHA_THRESHOLD) ? c.alpha : null
  return { width: c.w, height: c.h, indices: c.indices, palette: c.palette.map((x) => x.toLowerCase()), alphaMask: normalized }
}

/** 懒建 alphaMask：手绘作品第一次挖洞时才有必要分配整张 mask */
function ensureAlpha(c: Canvas): Uint8Array {
  if (!c.alpha) {
    c.alpha = new Uint8Array(c.w * c.h).fill(255)
  }
  return c.alpha
}

export interface ApplyOpsOptions {
  /** 算子省略 color 时用的默认色；无副作用路径必须传 undefined（结果才可复现） */
  fallbackColor?: string
  /** 允许色板满时退化为最近色（自由模式 true；拼豆/资产批次 false） */
  allowApproxColor?: boolean
}

/**
 * 依次执行算子。`changed` 逐条如实汇报；整串都没改动时 `applied: false`（不产生撤销帧）。
 */
export function applyOps(art: PixelArt, ops: EditOp[], options: ApplyOpsOptions = {}): ApplyOpsResult {
  const allowApprox = options.allowApproxColor ?? true
  const c = toCanvas(art)
  const changes: OpChange[] = []

  const resolveColor = (color?: string): { index: number; approx: boolean; missing: boolean } => {
    const hex = normalizeHex(color ?? options.fallbackColor ?? '')
    if (!hex) return { index: -1, approx: false, missing: true }
    const r = ensurePaletteColor(c.palette, hex, allowApprox)
    if (r.index >= 0 && !r.approx && c.palette[r.index] !== hex) c.palette[r.index] = hex
    if (r.index === c.palette.length) c.palette.push(hex)
    return { ...r, missing: false }
  }

  for (const op of ops) {
    const before = snapshot(c)

    switch (op.op) {
      case 'fill': {
        if (op.erase) {
          const cells = floodFillRegion(c.indices, c.w, c.h, Math.floor(op.x), Math.floor(op.y), c.alpha)
          if (cells.length) {
            const mask = ensureAlpha(c)
            for (const p of cells) mask[p] = 0
          }
          changes.push({ op: 'fill', kind: 'erase', cells: cells.length, changed: differs(before, c) })
        } else {
          const col = resolveColor(op.color)
          if (col.missing) throw new Error('fill 需要 color 或 fallbackColor（无副作用路径必须显式给 color）')
          if (col.index < 0) throw new Error(`色板已满（${PALETTE_MAX} 色）且不允许近似色，无法加入 ${op.color}`)
          const cells = floodFillRegion(c.indices, c.w, c.h, Math.floor(op.x), Math.floor(op.y), c.alpha)
          for (const p of cells) c.indices[p] = col.index
          if (c.alpha && cells.length) for (const p of cells) c.alpha[p] = 255
          changes.push({ op: 'fill', cells: cells.length, changed: differs(before, c), note: col.approx ? '色板已满：退化为最近色' : undefined })
        }
        break
      }

      case 'setCells': {
        const list: number[] = []
        for (const [x, y] of op.cells) {
          const ix = Math.floor(x)
          const iy = Math.floor(y)
          if (ix >= 0 && ix < c.w && iy >= 0 && iy < c.h) list.push(iy * c.w + ix)
        }
        if (op.erase) {
          if (list.length) {
            const mask = ensureAlpha(c)
            for (const p of list) mask[p] = 0
          }
          changes.push({ op: 'setCells', kind: 'erase', cells: list.length, changed: differs(before, c) })
        } else {
          const col = resolveColor(op.color)
          if (col.missing || col.index < 0) throw new Error('setCells 需要合法的 color')
          for (const p of list) c.indices[p] = col.index
          if (c.alpha && list.length) for (const p of list) c.alpha[p] = 255
          changes.push({ op: 'setCells', cells: list.length, changed: differs(before, c) })
        }
        break
      }

      case 'setAll': {
        if (op.erase) {
          const mask = ensureAlpha(c)
          mask.fill(0)
          changes.push({ op: 'setAll', kind: 'erase', cells: c.w * c.h, changed: differs(before, c) })
        } else {
          const col = resolveColor(op.color)
          if (col.missing || col.index < 0) throw new Error('setAll 需要合法的 color')
          c.indices.fill(col.index)
          // 整幅涂色不能顺手擦掉已有 alpha，否则"填个底色"会把挖好的洞补上
          if (c.alpha) c.alpha.fill(255)
          changes.push({ op: 'setAll', cells: c.w * c.h, changed: differs(before, c) })
        }
        break
      }

      case 'line': {
        const col = resolveColor(op.color)
        if (col.missing || col.index < 0) throw new Error('line 需要合法的 color')
        const cells = lineCells(c.w, c.h, Math.floor(op.x0), Math.floor(op.y0), Math.floor(op.x1), Math.floor(op.y1), op.brushSize ?? 1)
        for (const p of cells) c.indices[p] = col.index
        if (c.alpha) for (const p of cells) c.alpha[p] = 255
        changes.push({ op: 'line', cells: cells.length, changed: differs(before, c) })
        break
      }

      case 'rect':
      case 'ellipse': {
        const col = resolveColor(op.color)
        if (col.missing || col.index < 0) throw new Error(`${op.op} 需要合法的 color`)
        const filled = op.filled ?? true
        // 实心/空心由 rasterizeRect / rasterizeEllipse 自己的 filled 参数决定（别在这里再分一遍支，
        // 之前那种"实心走这、空心走那"的写法在拆出几何模块后找不到 rasterizeRectOutline 了）
        const cells =
          op.op === 'rect'
            ? rasterizeRect(c.w, c.h, op.x0, op.y0, op.x1, op.y1, filled)
            : rasterizeEllipse(c.w, c.h, op.x0, op.y0, op.x1, op.y1, filled)
        for (const p of cells) c.indices[p] = col.index
        if (c.alpha) for (const p of cells) c.alpha[p] = 255
        changes.push({ op: op.op, cells: cells.length, changed: differs(before, c) })
        break
      }

      case 'transform': {
        transformCanvas(c, op.kind)
        // 形状重排时 cells 记 0：受影响的是"整幅"，用 kind 说明；changed 仍按真实变化判定
        changes.push({ op: 'transform', kind: op.kind, cells: 0, changed: differs(before, c) })
        break
      }

      case 'outline': {
        // 先算格子再解析颜色：没有可描的格子时不该把描边色塞进色板——
        // 那会让一次"什么都没做"的调用报告 changed:true，并污染 `.hex` 与拼豆清单的颜色表。
        const cells = outlineCells(c.w, c.h, c.alpha, op.connectivity ?? 8, op.offset ?? 1)
        if (!cells.length) {
          changes.push({ op: 'outline', cells: 0, changed: false, note: '外侧没有可描边的空格' })
          break
        }
        const col = resolveColor(op.color)
        if (col.missing || col.index < 0) throw new Error('outline 需要合法的 color')
        // 描边是不透光的：确保 mask 存在，否则"挖过洞"的画布上描边会整圈看不见
        const mask = ensureAlpha(c)
        for (const p of cells) {
          c.indices[p] = col.index
          mask[p] = 255
        }
        changes.push({ op: 'outline', cells: cells.length, changed: differs(before, c) })
        break
      }

      case 'mirror': {
        // 同 outline：没有可落笔的格子时不要动色板
        const cells = mirrorCells(c.w, c.h, c.alpha, op.kind)
        if (!cells.length) {
          changes.push({ op: 'mirror', kind: op.kind, cells: 0, changed: false, note: '另一侧没有可落笔的空格' })
          break
        }
        const col = resolveColor(op.color)
        if (col.missing || col.index < 0) throw new Error('mirror 需要合法的 color')
        const mask = ensureAlpha(c)
        for (const p of cells) {
          c.indices[p] = col.index
          mask[p] = 255
        }
        changes.push({ op: 'mirror', kind: op.kind, cells: cells.length, changed: differs(before, c) })
        break
      }

      case 'trim': {
        const bounds = opaqueBounds(fromCanvas(c))
        if (!bounds) {
          changes.push({ op: 'trim', cells: 0, changed: false, note: '全透明或无透明边，无可裁剪' })
          break
        }
        const nw = bounds.x1 - bounds.x0 + 1
        const nh = bounds.y1 - bounds.y0 + 1
        if (nw === c.w && nh === c.h) {
          changes.push({ op: 'trim', cells: 0, changed: false, note: '已无透明边' })
          break
        }
        const ni = new Uint8Array(nw * nh)
        const na = c.alpha ? new Uint8Array(nw * nh).fill(255) : null
        for (let y = 0; y < nh; y++) {
          for (let x = 0; x < nw; x++) {
            const src = (bounds.y0 + y) * c.w + (bounds.x0 + x)
            const dst = y * nw + x
            ni[dst] = c.indices[src]
            if (na && c.alpha) na[dst] = c.alpha[src]
          }
        }
        c.w = nw
        c.h = nh
        c.indices = ni
        c.alpha = na
        changes.push({ op: 'trim', cells: nw * nh, changed: true, note: `裁剪为 ${nw}×${nh}` })
        break
      }

      case 'eraseColor': {
        const idxs = paletteIndexOf(c.palette, op.color)
        if (idxs.length === 0) throw new Error(`色板中没有 ${op.color}（eraseColor 只能作用于画布已有颜色）`)
        const mask = ensureAlpha(c)
        let cells = 0
        for (let p = 0; p < c.indices.length; p++) {
          if (idxs.includes(c.indices[p]) && mask[p] !== 0) {
            mask[p] = 0
            cells++
          }
        }
        changes.push({ op: 'eraseColor', cells, changed: cells > 0 })
        break
      }

      case 'replaceAny': {
        const froms = paletteIndexOf(c.palette, op.color)
        if (froms.length === 0) throw new Error(`色板中没有 ${op.color}（replaceAny 只能作用于画布已有颜色）`)
        const to = normalizeHex(op.to)
        if (!to) throw new Error(`replaceAny 的目标色不合法：${op.to}`)
        const col = ensurePaletteColor(c.palette, to, allowApprox)
        if (col.index < 0) throw new Error(`色板已满（${PALETTE_MAX} 色）且不允许近似色，无法加入 ${to}`)
        if (col.index === c.palette.length) c.palette.push(to)
        if (froms.includes(col.index)) {
          changes.push({ op: 'replaceAny', cells: 0, changed: false, note: '源色与目标色相同，无需替换' })
          break
        }
        let cells = 0
        for (let p = 0; p < c.indices.length; p++) {
          if (froms.includes(c.indices[p])) {
            c.indices[p] = col.index
            cells++
          }
        }
        changes.push({ op: 'replaceAny', cells, changed: cells > 0, note: col.approx ? '色板已满：退化为最近色' : undefined })
        break
      }

      default: {
        // 未知算子必须报错：静默忽略会让 agent 以为命令生效了
        const unknown = op as { op: string }
        throw new Error(`未知算子：${unknown.op}`)
      }
    }
  }

  const applied = changes.some((x) => x.changed)
  return { art: fromCanvas(c), changes, applied }
}

function snapshot(c: Canvas): { w: number; h: number; indices: Uint8Array; alpha: Uint8Array | null; palette: string } {
  return { w: c.w, h: c.h, indices: c.indices.slice(), alpha: c.alpha ? c.alpha.slice() : null, palette: c.palette.join(',') }
}

function differs(before: ReturnType<typeof snapshot>, c: Canvas): boolean {
  if (before.w !== c.w || before.h !== c.h) return true
  if (before.palette !== c.palette.join(',')) return true
  for (let i = 0; i < c.indices.length; i++) if (before.indices[i] !== c.indices[i]) return true
  if (before.alpha || c.alpha) {
    if (!before.alpha || !c.alpha) {
      // 从"无 mask"变成"有 mask"：只有存在真正透明的格子才算改动
      const mask = c.alpha ?? before.alpha
      if (mask) for (const v of mask) if (v < ALPHA_THRESHOLD) return true
    } else {
      for (let i = 0; i < c.alpha.length; i++) if (before.alpha[i] !== c.alpha[i]) return true
    }
  }
  return false
}

function transformCanvas(c: Canvas, kind: Extract<EditOp, { op: 'transform' }>['kind']): void {
  const { w, h, indices, alpha } = c
  const rotate = kind === 'rotate90' || kind === 'rotate270'
  const nw = rotate ? h : w
  const nh = rotate ? w : h
  const ni = new Uint8Array(nw * nh)
  const na = alpha ? new Uint8Array(nw * nh).fill(255) : null

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx = x
      let ny = y
      if (kind === 'flipX') nx = w - 1 - x
      else if (kind === 'flipY') ny = h - 1 - y
      else if (kind === 'rotate90') {
        nx = h - 1 - y
        ny = x
      } else if (kind === 'rotate180') {
        nx = w - 1 - x
        ny = h - 1 - y
      } else if (kind === 'rotate270') {
        nx = y
        ny = w - 1 - x
      }
      const src = y * w + x
      const dst = ny * nw + nx
      ni[dst] = indices[src]
      if (na && alpha) na[dst] = alpha[src]
    }
  }

  c.w = nw
  c.h = nh
  c.indices = ni
  c.alpha = na
}

/** 从空白画布开始（游戏资产/拼豆图纸的纯程序化起点） */
export function blankArt(width: number, height: number, color: string, transparent: boolean): PixelArt {
  const w = Math.max(1, Math.min(MAX_CANVAS_SIDE, Math.floor(width)))
  const h = Math.max(1, Math.min(MAX_CANVAS_SIDE, Math.floor(height)))
  const hex = normalizeHex(color) ?? '#000000'
  return {
    width: w,
    height: h,
    indices: new Uint8Array(w * h),
    palette: [hex.toLowerCase()],
    alphaMask: transparent ? new Uint8Array(w * h) : null,
  }
}
