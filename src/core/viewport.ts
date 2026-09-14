/**
 * 视口数学：适配居中、按锚点缩放、屏幕坐标 → 格子坐标。
 *
 * 单独成文件的原因：这是**最容易算错又最难肉眼发现**的一类逻辑（差半格、缩放漂移、"以鼠标为中心"
 * 实际以左上角为中心），抽成纯函数后可以被单测逐条钉住，UI 层只负责把事件坐标喂进来。
 *
 * 坐标约定：屏幕坐标以画布元素的左上角为原点；格子坐标 (0,0) 是画布左上角那一格。
 */

export interface ViewState {
  /** 每格多少 CSS 像素 */
  cell: number
  /** 画布左上角在屏幕上的位置 */
  ox: number
  oy: number
}

/** 单格最小/最大像素：小于 0.5 看不清网格，大于 120 一屏都放不下一格 */
export const MIN_CELL = 0.5
export const MAX_CELL = 120

export function clampCell(cell: number): number {
  if (!Number.isFinite(cell)) return 1
  return Math.max(MIN_CELL, Math.min(MAX_CELL, cell))
}

/** 适配居中：整幅画布按容器大小缩放并居中，四周留 pad 像素 */
export function fitViewState(cols: number, rows: number, containerW: number, containerH: number, pad = 24): ViewState {
  const w = Math.max(1, cols)
  const h = Math.max(1, rows)
  const availW = Math.max(16, containerW - pad * 2)
  const availH = Math.max(16, containerH - pad * 2)
  const cell = clampCell(Math.min(availW / w, availH / h))
  return {
    cell,
    ox: Math.round((containerW - w * cell) / 2),
    oy: Math.round((containerH - h * cell) / 2),
  }
}

/**
 * 以屏幕点 (mx,my) 为锚点缩放：缩放后该点对应的**画布位置保持不变**。
 * 这是"滚轮以鼠标为中心"的实现基础；factor 为倍数（>1 放大）。
 */
export function zoomAtPoint(v: ViewState, mx: number, my: number, factor: number): ViewState {
  const cell = clampCell(v.cell * factor)
  if (cell === v.cell) return v
  const k = cell / v.cell
  return {
    cell,
    ox: mx - (mx - v.ox) * k,
    oy: my - (my - v.oy) * k,
  }
}

/**
 * 屏幕坐标 → 格子坐标，**越界时夹到边界**。
 * 框选与形状拖拽需要它：用户从画布外的面板空白处按下去、一路拖进画布是常见操作，
 * 直接返回 null 会让"从外面起手"失效（旧项目为此返工过两次）。
 * 因此这里只做夹紧、不判空——"指针是否还在画布元素内"由调用方用元素事件决定。
 */
export function pointToCellClamped(v: ViewState, mx: number, my: number, cols: number, rows: number): { x: number; y: number } | null {
  if (cols < 1 || rows < 1 || v.cell <= 0) return null
  const rawX = Math.floor((mx - v.ox) / v.cell)
  const rawY = Math.floor((my - v.oy) / v.cell)
  return {
    x: Math.max(0, Math.min(cols - 1, rawX)),
    y: Math.max(0, Math.min(rows - 1, rawY)),
  }
}
