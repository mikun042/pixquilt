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
  /** 把与 bgHex 相同的像素导出为透明（单色键控） */
  transparentBg?: boolean
  bgHex?: string
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

  for (let y = 0; y < art.height; y++) {
    for (let x = 0; x < art.width; x++) {
      const p = y * art.width + x
      const transparent = art.alphaMask ? art.alphaMask[p] < ALPHA_THRESHOLD : false
      const c = rgb[art.indices[p]] ?? { r: 0, g: 0, b: 0 }
      const keyed = keyOut !== null && c.r === keyOut.r && c.g === keyOut.g && c.b === keyOut.b
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
