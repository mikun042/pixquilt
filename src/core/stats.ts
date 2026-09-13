/**
 * 像素统计：每色用量（拼豆原料清单 / 素材核对 / API 共用）。
 *
 * 口径（这是项目里被问得最多的一条，改动必须同步文档）：
 *  - **透明格不计入用量**：拼豆不用珠子、素材不带像素，透明是"没有东西"。
 *  - 透明格数量另有 `countTransparent()`，两者相加才是画布总格数。
 *  - 色板里可能存在重复 hex（自定义色板可追加同色），计数会合并到同一个键。
 */
import { ALPHA_THRESHOLD, type PixelArt } from './types.ts'

/** 每色使用计数（hex 小写 → 格数），只包含真正用到的颜色 */
export function countUsage(indices: Uint8Array, palette: string[], alphaMask?: Uint8Array | null): Record<string, number> {
  const counts = new Uint32Array(palette.length)
  for (let i = 0; i < indices.length; i++) {
    if (alphaMask && alphaMask[i] < ALPHA_THRESHOLD) continue
    const k = indices[i]
    if (k < counts.length) counts[k]++
  }
  const out: Record<string, number> = {}
  for (let i = 0; i < counts.length; i++) {
    if (!counts[i]) continue
    const hex = (palette[i] ?? '').toLowerCase()
    if (hex) out[hex] = (out[hex] ?? 0) + counts[i]
  }
  return out
}

/** 透明格数量（无 mask 时为 0） */
export function countTransparent(indices: Uint8Array, alphaMask?: Uint8Array | null): number {
  if (!alphaMask) return 0
  let n = 0
  for (let i = 0; i < indices.length; i++) if (alphaMask[i] < ALPHA_THRESHOLD) n++
  return n
}

/** 是否含真正的透明格（全不透明的 mask 视为无 alpha，省内存也让项目文件回到简洁形态） */
export function hasRealAlpha(alphaMask?: Uint8Array | null): boolean {
  if (!alphaMask) return false
  for (let i = 0; i < alphaMask.length; i++) if (alphaMask[i] < ALPHA_THRESHOLD) return true
  return false
}

/** 画布摘要（UI 状态栏与 API getInfo 共用，避免两处各算一遍） */
export function artStats(art: PixelArt): {
  width: number
  height: number
  cells: number
  transparent: number
  paletteSize: number
  usage: Record<string, number>
} {
  return {
    width: art.width,
    height: art.height,
    cells: art.width * art.height,
    transparent: countTransparent(art.indices, art.alphaMask),
    paletteSize: art.palette.length,
    usage: countUsage(art.indices, art.palette, art.alphaMask),
  }
}
