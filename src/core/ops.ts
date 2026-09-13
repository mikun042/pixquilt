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
 */
import { ALPHA_THRESHOLD, MAX_CANVAS_SIDE, PALETTE_MAX } from './limits.ts'
import { normalizeHex, type Anchor, type PixelArt } from './types.ts'
import { buildPaletteLabs, hexToRgb, nearestColorIndex, rgbToOklab } from './color.ts'
import { dedupePalette } from './palettes.ts'

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

function inBounds(c: Canvas, x: number, y: number): boolean {
  return x >= 0 && x < c.w && y >= 0 && y < c.h
}

/** 实心/空心矩形栅格化（导出给单测与 UI 预览共用，避免各写一套坐标夹紧逻辑） */
export function rasterizeRect(w: number, h: number, x0: number, y0: number, x1: number, y1: number, filled = true): number[] {
  return filled ? rasterizeRectFilled(w, h, x0, y0, x1, y1) : rasterizeRectOutline(w, h, x0, y0, x1, y1)
}

function rasterizeRectFilled(w: number, h: number, x0: number, y0: number, x1: number, y1: number): number[] {
  const ax = Math.max(0, Math.min(w - 1, Math.min(x0, x1)))
  const bx = Math.max(0, Math.min(w - 1, Math.max(x0, x1)))
  const ay = Math.max(0, Math.min(h - 1, Math.min(y0, y1)))
  const by = Math.max(0, Math.min(h - 1, Math.max(y0, y1)))
  const out: number[] = []
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) out.push(y * w + x)
  return out
}

function rasterizeRectOutline(w: number, h: number, x0: number, y0: number, x1: number, y1: number): number[] {
  const ax = Math.max(0, Math.min(w - 1, Math.min(x0, x1)))
  const bx = Math.max(0, Math.min(w - 1, Math.max(x0, x1)))
  const ay = Math.max(0, Math.min(h - 1, Math.min(y0, y1)))
  const by = Math.max(0, Math.min(h - 1, Math.max(y0, y1)))
  const out: number[] = []
  for (let x = ax; x <= bx; x++) {
    out.push(ay * w + x)
    if (by !== ay) out.push(by * w + x)
  }
  for (let y = ay + 1; y < by; y++) {
    out.push(y * w + ax)
    if (bx !== ax) out.push(y * w + bx)
  }
  return out
}

/** 椭圆：按像素中心到外接框中心的归一化距离判定，保证与界面拖拽预览一致 */
export function rasterizeEllipse(w: number, h: number, x0: number, y0: number, x1: number, y1: number, filled = true): number[] {
  const ax = Math.max(0, Math.min(w - 1, Math.min(x0, x1)))
  const bx = Math.max(0, Math.min(w - 1, Math.max(x0, x1)))
  const ay = Math.max(0, Math.min(h - 1, Math.min(y0, y1)))
  const by = Math.max(0, Math.min(h - 1, Math.max(y0, y1)))
  const cx = (ax + bx) / 2
  const cy = (ay + by) / 2
  const rx = Math.max(0.5, (bx - ax) / 2 + 0.5)
  const ry = Math.max(0.5, (by - ay) / 2 + 0.5)
  const inside = (x: number, y: number) => {
    const dx = (x - cx) / rx
    const dy = (y - cy) / ry
    return dx * dx + dy * dy <= 1
  }

  const out: number[] = []
  if (filled) {
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) if (inside(x, y)) out.push(y * w + x)
    return out
  }
  for (let y = ay; y <= by; y++) {
    for (let x = ax; x <= bx; x++) {
      if (!inside(x, y)) continue
      // 空心：只保留"有一个四邻不在内部"的边界格
      const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)
      if (edge) out.push(y * w + x)
    }
  }
  return out
}

/** 笔刷足迹：size×size 的方块，围绕中心格（与界面悬停预览同一套） */
export function brushCells(w: number, h: number, cx: number, cy: number, size: number): number[] {
  const s = Math.max(1, Math.min(3, Math.round(size)))
  const half = (s - 1) >> 1
  const out: number[] = []
  for (let dy = 0; dy < s; dy++) {
    for (let dx = 0; dx < s; dx++) {
      const x = cx - half + dx
      const y = cy - half + dy
      if (x >= 0 && x < w && y >= 0 && y < h) out.push(y * w + x)
    }
  }
  return out
}

/** Bresenham 直线（含两端点），每步应用笔刷足迹 */
export function lineCells(w: number, h: number, x0: number, y0: number, x1: number, y1: number, brushSize = 1): number[] {
  const out = new Set<number>()
  let x = x0
  let y = y0
  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx - dy
  // 上限保护：坐标可能来自越界拖拽（夹紧后仍可能很大），避免死循环
  let guard = dx + dy + 2
  for (;;) {
    for (const c of brushCells(w, h, x, y, brushSize)) out.add(c)
    if ((x === x1 && y === y1) || guard-- <= 0) break
    const e2 = 2 * err
    if (e2 > -dy) {
      err -= dy
      x += sx
    }
    if (e2 < dx) {
      err += dx
      y += sy
    }
  }
  return [...out]
}

/** 不透明内容的外接框（trim 用）；全透明返回 null */
export function opaqueBounds(art: PixelArt): { x0: number; y0: number; x1: number; y1: number } | null {
  const { width: w, height: h, alphaMask } = art
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const opaque = !alphaMask || alphaMask[p] >= ALPHA_THRESHOLD
      if (!opaque) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 }
}

/** 内容相对固定尺寸画布的偏移（游戏资产锚点用：不裁边，只给引擎一个 pivot） */
export function anchorOffset(art: PixelArt, anchor: Anchor): { offsetX: number; offsetY: number } {
  const b = opaqueBounds(art)
  if (!b) return { offsetX: 0, offsetY: 0 }
  const cx = (b.x0 + b.x1) / 2
  const cy = (b.y0 + b.y1) / 2
  const mx = (art.width - 1) / 2
  const my = (art.height - 1) / 2
  if (anchor === 'top-left') return { offsetX: -b.x0, offsetY: -b.y0 }
  if (anchor === 'bottom-center') return { offsetX: Math.round(mx - cx), offsetY: -(b.y1 - my) }
  return { offsetX: Math.round(cx - mx), offsetY: Math.round(cy - my) }
}

function floodFillRegion(indices: Uint8Array, w: number, h: number, x: number, y: number, alpha: Uint8Array | null): number[] {
  if (!inBounds({ w, h } as Canvas, x, y)) return []
  const start = y * w + x
  // 透明格之间也算同一连通区域（"把这块背景抠掉"期望整片一起走）
  const startTransparent = alpha ? alpha[start] === 0 : false
  const target = indices[start]

  const visited = new Uint8Array(w * h)
  const queue = new Int32Array(w * h)
  let head = 0
  let tail = 0
  queue[tail++] = start
  visited[start] = 1
  const out: number[] = []

  while (head < tail) {
    const c = queue[head++]
    out.push(c)
    const cx = c % w
    const cy = (c / w) | 0
    const neighbors = [
      cx > 0 ? c - 1 : -1,
      cx < w - 1 ? c + 1 : -1,
      cy > 0 ? c - w : -1,
      cy < h - 1 ? c + w : -1,
    ]
    for (const n of neighbors) {
      if (n < 0 || visited[n]) continue
      const nTransparent = alpha ? alpha[n] === 0 : false
      // 同色且同为透明/不透明才算连通：否则"透明"会把所有颜色格串起来
      if (indices[n] !== target || nTransparent !== startTransparent) continue
      visited[n] = 1
      queue[tail++] = n
    }
  }
  return out
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
        const cells =
          op.op === 'rect'
            ? filled
              ? rasterizeRect(c.w, c.h, op.x0, op.y0, op.x1, op.y1)
              : rasterizeRectOutline(c.w, c.h, op.x0, op.y0, op.x1, op.y1)
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

/**
 * 描边：找出所有"需要补色"的空白格（返回格子索引）。
 *
 * 语义分两层，都能一格格验证：
 *  - **第一圈**：与实心区切比雪夫距离 1 的空白格，即紧贴内容的完整外圈
 *    （2×2 方块外侧是 12 格；`connectivity:4` 时只保留正交相邻的那些）。
 *  - **第 n 圈**（`offset ≥ 2`）：从上一圈再向外扩一圈，仍是切比雪夫 1 环。
 *
 * 为什么先算出整圈再扩张，而不是逐格边搜边写：早期实现把"已描上的格"混进实心集合里同步扩张，
 * 9×9 上单像素 `offset:2` 只得到 12 格（正确是 33 = 3×3 + 5×5 两个外框减中心）。
 * 分两步写虽多一遍扫描，但每一步都能对上几何直觉。
 *
 * 只看 alpha 不看颜色索引：挖过洞的格子里仍留着旧索引值，只看索引会把透明格当成实心，
 * 描边就会贴着看不见的东西走。
 *
 * 只返回空白格，所以已有内容不会被覆盖，重复执行也不会越描越粗。
 */
export function outlineCells(
  w: number,
  h: number,
  alpha: Uint8Array | null,
  connectivity: 4 | 8,
  offset: number,
): number[] {
  const layers = Math.max(1, Math.floor(offset))
  const isSolid = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false
    if (!alpha) return true
    return alpha[y * w + x] >= ALPHA_THRESHOLD
  }
  const chebyshev1 = (x: number, y: number, test: (x: number, y: number) => boolean): boolean => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        if (test(x + dx, y + dy)) return true
      }
    }
    return false
  }

  // 第一圈：紧贴内容的空白格。connectivity=4 时只保留正交相邻的那些，
  // 只在对角相接的角落格留到第二圈（otherwise 描边会在凹角处出现孤立补丁）。
  const outlined = new Set<number>()
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isSolid(x, y)) continue
      if (!chebyshev1(x, y, isSolid)) continue
      if (connectivity === 4) {
        const orth =
          isSolid(x - 1, y) || isSolid(x + 1, y) || isSolid(x, y - 1) || isSolid(x, y + 1)
        if (!orth) continue
      }
      outlined.add(y * w + x)
    }
  }

  // 第 2..offset 圈：从上一圈的成果继续向外扩，仍然是切比雪夫 1 环。
  // 分趟计算而不是边搜边写：中间状态混进判定里会漏格（9×9 单像素 offset:2 曾只得 12 格，应为 33）。
  for (let layer = 2; layer <= layers; layer++) {
    const found: number[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x
        if (isSolid(x, y) || outlined.has(p)) continue
        if (found.includes(p)) continue
        if (chebyshev1(x, y, (nx, ny) => {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) return false
          return outlined.has(ny * w + nx)
        })) {
          found.push(p)
        }
      }
    }
    if (!found.length) break
    for (const p of found) outlined.add(p)
  }

  // 按坐标顺序输出：同一输入必须产出同一顺序（确定性）
  return [...outlined].sort((a, b) => a - b)
}

/**
 * 镜像加笔：以画布中线为轴，把内容镜像叠到另一侧。原内容保留。
 *
 * 用 `(w-1-x)` 而不是 `((w-x) % w)`：后者在 x=0 时会折到 x=w-1，
 * 内容是"贴着左边缘 8 格"时镜像副本会贴到右上角，而不是左侧留白 8 格——
 * 中线对称的意义就是让左右留白量相等。
 *
 * 副本里的透明格**不落笔**：否则镜像一次会顺手把原内容抹掉一半（对称图形看不出来，
 * 非对称图形必错）。
 */
function mirrorCells(
  w: number,
  h: number,
  alpha: Uint8Array | null,
  kind: 'h' | 'v' | 'both',
): number[] {
  const solid = (x: number, y: number): boolean => {
    const p = y * w + x
    return alpha ? alpha[p] >= ALPHA_THRESHOLD : true
  }
  const result: number[] = []
  const seen = new Set<number>()
  const put = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const p = y * w + x
    if (seen.has(p)) return
    if (solid(x, y)) return // 已有内容不动
    seen.add(p)
    result.push(p)
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!solid(x, y)) continue
      if (kind === 'h' || kind === 'both') put(w - 1 - x, y)
      if (kind === 'v' || kind === 'both') put(x, h - 1 - y)
      if (kind === 'both') put(w - 1 - x, h - 1 - y)
    }
  }
  return result
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

/** 用色板把画布扩到至少包含给定颜色（手动绘制时用） */
export function withPaletteColor(art: PixelArt, hex: string): PixelArt {
  const norm = normalizeHex(hex)
  if (!norm) return art
  if (art.palette.some((c) => c.toLowerCase() === norm)) return art
  if (art.palette.length >= PALETTE_MAX) return art
  return { ...art, palette: dedupePalette([...art.palette, norm.toLowerCase()]) }
}
