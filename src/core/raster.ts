/**
 * 栅格导出：把索引画布放大成 RGBA 缓冲（导出功能的"像素侧"）。
 *
 * 与 `export.ts` 的分工：这里只管**像素**，`export.ts` 管**序列化**（JSON / 项目文件 / 图集 / 指纹）。
 * 分开的原因很实际：浏览器与 Node 都需要"画布 → RGBA"，但只有 Node 需要把 RGBA 压成 PNG 字节，
 * 混在一起会让浏览器包被迫依赖 zlib（分层缺陷，见 docs/DEVELOPMENT.md §6 第 1 条）。
 */
import { ALPHA_THRESHOLD, MAX_EXPORT_PIXELS, MAX_EXPORT_SIDE } from './limits.ts'
import { hexToRgb } from './color.ts'
import type { RgbaImage } from './png.ts'
import type { PixelArt } from './types.ts'

export interface RasterOptions {
  /** 把与 bgHex 相同（或接近，见 keyTolerance）的像素导出为透明（单色键控） */
  transparentBg?: boolean
  bgHex?: string
  /**
   * 键控范围：
   *  - `global`（默认）：**全图**所有等于底色的像素都透明；
   *  - `border`：只有**从四边连通**到、且颜色接近底色的区域才透明。
   *
   * 为什么要 `border`：像素画主体内部常有与底色同色的像素（白底 + 白色高光/眼白），
   * `global` 会把它们一起挖穿成洞（实测：主体内 4×4 的白高光被打成 16 像素空洞）。
   * 生图去背（见 docs/DEVELOPMENT.md A1）要的正是 `border`。
   */
  keyMode?: 'global' | 'border'
  /**
   * 颜色容差（0–255，取三通道最大差），默认 0 = 精确同色。
   *
   * 为什么需要它：扩散模型/V AE 输出的"纯白底"其实是 254/255 混合的噪声，
   * 零容差一个都键不掉（实测 `#fefefe` 底命中率 0%），而这些噪声肉眼就是白底。
   */
  keyTolerance?: number
}

/** 两色在 RGB 三通道上的最大差（键控容差判定用） */
function channelDistance(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b))
}

/**
 * 从四边向内标记「与底色接近且连通」的区域（`keyMode: 'border'` 用）。
 * 4 邻接 BFS；只吃与边界连通的像素，因此主体内部同色区不受影响。
 */
function borderKeyMask(
  indices: Uint8Array,
  w: number,
  h: number,
  rgb: { r: number; g: number; b: number }[],
  keyOut: { r: number; g: number; b: number },
  tol: number,
  alphaMask?: Uint8Array | null,
): Uint8Array {
  const close = (p: number) => {
    // 已被 alphaMask 判为透明的格：视为背景的一部分，让填充能穿过它们继续向内
    if (alphaMask && alphaMask[p] < ALPHA_THRESHOLD) return true
    const c = rgb[indices[p]]
    return c ? channelDistance(c, keyOut) <= tol : false
  }
  const mask = new Uint8Array(w * h)
  const queue = new Int32Array(w * h)
  let head = 0
  let tail = 0
  const push = (p: number) => {
    if (mask[p] || !close(p)) return
    mask[p] = 1
    queue[tail++] = p
  }
  for (let x = 0; x < w; x++) {
    push(x)
    push((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    push(y * w)
    push(y * w + w - 1)
  }
  while (head < tail) {
    const c = queue[head++]
    const cx = c % w
    const cy = (c / w) | 0
    if (cx > 0) push(c - 1)
    if (cx < w - 1) push(c + 1)
    if (cy > 0) push(c - w)
    if (cy < h - 1) push(c + w)
  }
  return mask
}

/** 导出倍数：同时受单边与面积上限约束，自动降档到可行的最大整数倍 */
export function clampScale(art: PixelArt, scale: number): number {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1
  const w = Math.max(1, art.width)
  const h = Math.max(1, art.height)
  const bySide = Math.floor(MAX_EXPORT_SIDE / Math.max(w, h))
  const byArea = Math.floor(Math.sqrt(MAX_EXPORT_PIXELS / (w * h)))
  const cap = Math.max(1, Math.min(bySide, byArea))
  return Math.max(1, Math.min(Math.round(s), cap))
}

/**
 * 画布 → RGBA 缓冲。放大用复制填充（最近邻），保证格子锐利——像素画的放大绝不能用插值。
 */
export function artToImageData(art: PixelArt, scale = 1, opts: RasterOptions = {}): RgbaImage {
  const s = clampScale(art, scale)
  const width = art.width * s
  const height = art.height * s
  const data = new Uint8ClampedArray(width * height * 4)
  const rgb = art.palette.map(hexToRgb)
  const keyOut = opts.transparentBg && opts.bgHex ? hexToRgb(opts.bgHex) : null
  const tol = Math.max(0, opts.keyTolerance ?? 0)
  // border 模式的"哪些格算背景"一次算清（与缩放无关），再逐格取用
  const borderMask =
    keyOut !== null && opts.keyMode === 'border'
      ? borderKeyMask(art.indices, art.width, art.height, rgb, keyOut, tol, art.alphaMask)
      : null

  for (let y = 0; y < art.height; y++) {
    for (let x = 0; x < art.width; x++) {
      const p = y * art.width + x
      const transparent = art.alphaMask ? art.alphaMask[p] < ALPHA_THRESHOLD : false
      const c = rgb[art.indices[p]] ?? { r: 0, g: 0, b: 0 }
      const keyed =
        keyOut !== null &&
        (borderMask ? borderMask[p] === 1 : channelDistance(c, keyOut) <= tol)
      const alpha = transparent || keyed ? 0 : 255

      for (let dy = 0; dy < s; dy++) {
        const rowBase = (y * s + dy) * width * 4
        for (let dx = 0; dx < s; dx++) {
          const o = rowBase + (x * s + dx) * 4
          data[o] = c.r
          data[o + 1] = c.g
          data[o + 2] = c.b
          data[o + 3] = alpha
        }
      }
    }
  }

  return { width, height, data }
}
