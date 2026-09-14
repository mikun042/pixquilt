/**
 * 栅格化几何：矩形 / 椭圆 / 笔刷足迹 / Bresenham 直线。
 *
 * 为什么单独成文件（从 `ops.ts` 拆出）：这些函数**只跟坐标打交道**，不碰画布、色板与 alpha，
 * 却被三个地方共用——编辑算子（`ops.ts`）、界面拖拽预览（`ui/canvas.ts`）、单测。
 * 原先挤在 `ops.ts` 里让那个文件超出 core 的 500 行软门，也让人看不出"哪些是真算子在改画布"。
 *
 * 约定：所有函数都**返回格索引数组**（行主序 `y*w+x`）、并对越界坐标静默夹紧/裁剪——
 * 批处理里"图比预期小"很常见，报错反而碍事（见 `docs/DEVELOPMENT.md` §7）。
 */

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
