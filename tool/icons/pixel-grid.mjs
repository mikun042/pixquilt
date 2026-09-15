// pixel-grid.mjs —— 32×32 像素网格 + 几何校验（供 UI 图标素材包使用）
//
// 为什么用 32×32 而不是 16×16：
//   图标最终显示在 16px 的按钮里，viewBox 恒为 24。换算下来
//     16 格画布 → 1 格 = 1.000 屏幕像素 → 任何 1 格宽的线都是 1px，抗锯齿后发灰发糊
//     32 格画布 → 1 格 = 0.500 屏幕像素 → 笔画画到 3~4 格（=1.5~2px）就是实心
//   32 格还给了斜线与弧度表达空间（16 格时 45° 只能是粗糙阶梯）。
//   **注意**：清晰度来自"最终笔画 ≥1.5px"，不是画布大本身——所以本文件的
//   `stroke >= 3 格` 是硬要求，画得细一样会糊。
//
// 校验沿用 tool/e2e-pdf.mjs 对图标的 4 条断言（viewBox / 落在画布内 / ≥12×12 / 无退化笔画），
// 并额外锁住"笔画够粗"——这是本方案能否清晰的关键，必须由工具保证而不是靠画的人自觉。
export const VIEW_BOX = 24
export const GRID = 32
/** 1 格在 viewBox 里占多少单位 */
export const UNIT = VIEW_BOX / GRID

const round = (n) => (Math.round(n * 100) / 100).toString()

export class Grid {
  constructor(n = GRID) {
    this.n = n
    this.g = Array.from({ length: n }, () => Array(n).fill(0))
  }

  set(x, y, v = 1) {
    const xi = Math.round(x)
    const yi = Math.round(y)
    if (xi >= 0 && yi >= 0 && xi < this.n && yi < this.n) this.g[yi][xi] = v
    return this
  }

  get(x, y) {
    if (x < 0 || y < 0 || x >= this.n || y >= this.n) return 0
    return this.g[y][x]
  }

  rect(x0, y0, x1, y1, v = 1) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.set(x, y, v)
    return this
  }

  disc(cx, cy, r, v = 1) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x - cx
        const dy = y - cy
        if (dx * dx + dy * dy <= r * r + 0.2) this.set(x, y, v)
      }
    return this
  }

  ring(cx, cy, r, t, v = 1) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d = Math.hypot(x - cx, y - cy)
        if (d <= r && d >= r - t) this.set(x, y, v)
      }
    return this
  }

  /** 粗线（Bresenham + 方形笔刷）。`t` 建议 ≥3，否则 16px 下会糊 */
  line(x0, y0, x1, y1, t = 3, v = 1) {
    const half = Math.floor(t / 2)
    let dx = Math.abs(x1 - x0)
    let dy = Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx - dy
    for (;;) {
      this.rect(x0 - half, y0 - half, x0 + half, y0 + half, v)
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 > -dy) { err -= dy; x0 += sx }
      if (e2 < dx) { err += dx; y0 += sy }
    }
    return this
  }

  /** 水平镜像（原地） */
  mirrorX() {
    for (const row of this.g) row.reverse()
    return this
  }

  count() {
    let n = 0
    for (const row of this.g) for (const v of row) if (v) n++
    return n
  }

  /** 不透明内容的包围盒（格坐标） */
  bounds() {
    let x0 = this.n, y0 = this.n, x1 = -1, y1 = -1
    for (let y = 0; y < this.n; y++)
      for (let x = 0; x < this.n; x++)
        if (this.g[y][x]) {
          if (x < x0) x0 = x
          if (y < y0) y0 = y
          if (x > x1) x1 = x
          if (y > y1) y1 = y
        }
    return x1 < 0 ? null : { x0, y0, x1, y1 }
  }

  /**
   * 从 ASCII 建网格（`#` = 实心，其余为空）。
   * 有机形状（桶、盘、笔）优先用它：所见即所得，改一个字符就改一个像素，
   * 不用反推几何参数——用图元拼这类形状会得到"两根拐杖""被咬一口的饼"（实测）。
   */
  static from(lines) {
    const n = lines.length
    const g = new Grid(n)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < lines[y].length; x++) if (lines[y][x] === '#') g.set(x, y, 1)
    return g
  }

  /** → 单色 SVG path（逐行游程合并） */
  toPathD() {
    const out = []
    for (let y = 0; y < this.n; y++) {
      let x = 0
      while (x < this.n) {
        if (!this.g[y][x]) { x++; continue }
        let e = x
        while (e + 1 < this.n && this.g[y][e + 1]) e++
        const w = (e - x + 1) * UNIT
        out.push(`M${round(x * UNIT)} ${round(y * UNIT)}h${round(w)}v${round(UNIT)}h${round(-w)}Z`)
        x = e + 1
      }
    }
    return out.join('')
  }

  /** 供人工核对：打印 ASCII */
  toAscii() {
    return this.g.map((row) => row.map((v) => (v ? '#' : '.')).join('')).join('\n')
  }
}

/** path 里所有坐标点（几何校验用；只解析我们生成的 M/h/v/Z） */
export function pathPoints(d) {
  const pts = []
  let cx = 0, cy = 0
  const toks = d.match(/[MhvZ]|-?\d*\.?\d+/g) ?? []
  let i = 0
  while (i < toks.length) {
    const t = toks[i]
    if (t === 'M') { cx = +toks[i + 1]; cy = +toks[i + 2]; pts.push([cx, cy]); i += 3 }
    else if (t === 'h') { cx += +toks[i + 1]; pts.push([cx, cy]); i += 2 }
    else if (t === 'v') { cy += +toks[i + 1]; pts.push([cx, cy]); i += 2 }
    else i++
  }
  return pts
}

/**
 * 视觉单元的最小厚度（格）：对不透明区域做形态学腐蚀，
 * 数"腐蚀多少次后整片消失"——即区域内最大的内切方形半径 × 2。
 *
 * 为什么必须从**网格**量、而不能从 path 指令量：path 里每段都是 `v{UNIT}`，
 * 那个值是行高（恒为 1 格），与笔画粗细无关。第一版就是这么量错的，
 * 导致 20 个图标全被误判成"笔画 0.5px"（实测踩过）。
 *
 * 取"最大的内切半径"而不是"最小的"：一条有粗细变化的笔画（例如笔头粗、笔尾细）
 * 只要主体够厚就能看清；我们要拒绝的是"整体像发丝"的图标。
 */
export function maxInscribedRadius(grid) {
  const n = grid.n
  // 距离变换：到最近空白格的距离（4 邻接的近似）
  const dist = Array.from({ length: n }, () => Array(n).fill(0))
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (!grid.g[y][x]) continue
      let d = 1
      for (;;) {
        const r = d
        let solid = true
        for (let dy = -r; dy <= r && solid; dy++)
          for (let dx = -r; dx <= r && solid; dx++) {
            const px = x + dx
            const py = y + dy
            if (px < 0 || py < 0 || px >= n || py >= n || !grid.g[py][px]) solid = false
          }
        if (!solid) break
        d++
        if (d > n) break
      }
      dist[y][x] = d
    }
  let best = 0
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (dist[y][x] > best) best = dist[y][x]
  return best
}
/**
 * 几何校验：镜像 `tool/e2e-pdf.mjs` 的 4 条断言，另加"笔画够粗"。
 *
 * 签名接收 `grid`（不只是 path）：因为"笔画粗细"必须从网格的连通区域量，
 * path 里量不到（每段都是 v{UNIT}，那是行高）。
 *
 * `skipSizeCheck`：折叠三角这类**天生非方形**的指示符跳过 ≥12×12
 * （那条断言本意是"别把图标画太小"，扁指示符硬凑方形会变成笨重大三角）。
 */
export function checkGeometry(grid, { skipSizeCheck = false } = {}) {
  const d = grid.toPathD()
  const problems = []
  const pts = pathPoints(d)
  if (!pts.length) return { ok: false, problems: ['path 为空'], bbox: null, w: 0, h: 0, strokePx: 0 }
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
  if (box.x0 < 0 || box.y0 < 0 || box.x1 > VIEW_BOX || box.y1 > VIEW_BOX) {
    problems.push(`笔画超出画布 [0,24]²：${JSON.stringify(box)}`)
  }
  const w = box.x1 - box.x0
  const h = box.y1 - box.y0
  if (!skipSizeCheck && (w < 12 || h < 12)) problems.push(`图标过小：${w.toFixed(1)}×${h.toFixed(1)}（需 ≥12×12）`)

  /*
   * 笔画厚度：从网格量"最大内切方形半径 ×2"（见 maxInscribedRadius 的说明：
   * path 里的 v 值是行高、不是粗细，第一版这么量过错判了全部 20 个图标）。
   * 换算到屏幕：16px 显示 / viewBox 24 → 1 单位 = 0.667px；1 格 = 0.75 单位 = 0.5px。
   * 主体厚度 <1.4px 时会被抗锯齿糊掉，这是本方案清晰与否的量化门槛。
   */
  const radiusCells = maxInscribedRadius(grid)
  const strokeCells = radiusCells * 2
  const strokePx = strokeCells * UNIT * (16 / VIEW_BOX)
  if (strokePx < 1.4) {
    problems.push(
      `主体过细：最大内切厚 ${strokeCells.toFixed(0)} 格 = ${strokePx.toFixed(2)}px` +
        `（16px 显示时需 ≥1.4px，否则抗锯齿发糊；请把主体画粗到 3 格以上）`,
    )
  }
  return { ok: problems.length === 0, problems, bbox: box, w, h, strokeCells, strokePx }
}

/** 生成完整 SVG 字符串（可直接替换 icons.ts 里的 path 数据） */
export function svgFor(grid) {
  const d = grid.toPathD()
  return `<svg viewBox="0 0 ${VIEW_BOX} ${VIEW_BOX}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icon-svg"><path fill="currentColor" fill-rule="evenodd" d="${d}"/></svg>`
}
