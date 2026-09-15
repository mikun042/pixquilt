/**
 * Node 侧图片读取（无浏览器）。
 *
 * 存在意义：docs/DEVELOPMENT.md §4.1 的 L3 —— agent 批处理不该被"必须起一个浏览器"绑架。
 * 一个纯 PNG 素材目录的批处理，用这里的实现可以完全不起浏览器、不走 CDP、不做 base64 往返。
 *
 * 能力边界（**如实声明，不做半成品**）：
 *  - 支持：PNG（位深 8/16，颜色类型 0/2/3/4/6，非隔行）
 *  - 不支持：JPEG / WebP / GIF / AVIF / BMP / ICO / SVG
 *    → 三条真实可用的替代路径：
 *      ① 先用图像工具转 PNG；
 *      ② 经浏览器通道（页内 API `window.pixelArtStudio.importImage`，浏览器原生解码这些格式）；
 *      ③ CLI 加 `--browser-decode`（见 `src/io/node-decode.ts`）——借无头浏览器原生解码器
 *         批量转 PNG 再走同一条渲染链路。**需要本机有浏览器**。
 *    ⚠️ 注意这两件事的区别：`canDecodeInNode()` **仍然只对 PNG 返回 true**——
 *      `--browser-decode` 是"另一条通道"，不是"Node 现在支持所有格式了"。
 *      把能力声明跟着通道一起放宽，就等于给下游一句假话（mock 掉的能力最容易被误信）。
 *    ⚠️ 也不要在这里提及任何**未实现**的 CLI flag——本项目曾出现"报错让用户改用
 *      某个 flag，但该 flag 从未实现"的死路文案（正是 `--browser-decode` 的前身）。
 */
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { PngDecodeError, type RgbaImage } from '../core/png.ts'
import { decodePngNode } from './node-png.ts'

export const NODE_DECODABLE = ['.png'] as const
export const BROWSER_ONLY = ['.jpg', '.jpeg', '.jfif', '.webp', '.gif', '.bmp', '.avif', '.ico', '.cur', '.svg'] as const
export const ALL_IMAGE_EXT = [...NODE_DECODABLE, ...BROWSER_ONLY] as const

export function isImagePath(file: string): boolean {
  return (ALL_IMAGE_EXT as readonly string[]).includes(extname(file).toLowerCase())
}

/** 该扩展名能否在 Node 里直接解码（否则 CLI 会提示需要浏览器通道） */
export function canDecodeInNode(file: string): boolean {
  return (NODE_DECODABLE as readonly string[]).includes(extname(file).toLowerCase())
}

/** 文件头嗅探：扩展名可能骗人，真格式以签名为准 */
export function sniffFormat(bytes: Uint8Array): 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'avif-or-heif' | 'unknown' {
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  if (b.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp'
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'avif-or-heif'
  return 'unknown'
}

export class UnsupportedImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedImageError'
  }
}

/**
 * 读取并解码一张图片。只处理 PNG；其他格式抛出 `UnsupportedImageError`，
 * 由调用方决定如何提示（CLI 会把中文原因打进失败清单）。
 */
export function loadImageNode(file: string): RgbaImage {
  const bytes = new Uint8Array(readFileSync(file))
  const format = sniffFormat(bytes)
  if (format === 'png') {
    try {
      return decodePngNode(bytes)
    } catch (err) {
      if (err instanceof PngDecodeError) throw new UnsupportedImageError(`PNG 解码失败（${file}）：${err.message}`)
      throw err
    }
  }
  const ext = extname(file).toLowerCase()
  // 注意：这里**不能**推荐一个不存在的 CLI flag。此前文案让用户"改用 --browser-decode"，
  // 但 tool/artc.mjs 从未实现它（传了只会打印帮助并 exit 1）——那是死路。
  // 现在给出两条真实可用的替代做法。
  throw new UnsupportedImageError(
    `Node 端只能直接解码 PNG，而 ${file} 的实际格式是 ${format}（扩展名 ${ext || '无'}）。` +
      `替代做法：① 先用图像工具把它另存为 PNG；` +
      `② 用浏览器打开工作台、通过页内 API（window.pixelArtStudio.importImage）导入——浏览器原生解码支持这些格式。`,
  )
}
