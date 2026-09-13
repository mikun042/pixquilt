/**
 * Node 侧 PDF 适配：把平台相关的 zlib 注入给纯 PDF 生成器。
 *
 * 与 `node-png.ts` 同一模式：`src/core/pdf.ts` 是纯的（浏览器也能用），
 * 但压缩必须由平台提供。Node 用 `node:zlib`，浏览器用 `CompressionStream`。
 * 平台绑定只在这两个薄文件里，core 永远可被单测与 CLI 直接使用。
 */
import { deflateSync } from 'node:zlib'
import { beadPdf, type BeadPdfOptions } from '../core/bead-pdf.ts'
import type { PixelArt } from '../core/types.ts'

/** level 9：图纸文本量大、图像少，压缩率优先 */
export const deflateNode = (data: Uint8Array): Uint8Array =>
  new Uint8Array(deflateSync(data, { level: 9 }))

/** 拼豆图纸 PDF 字节 */
export function beadPdfNode(art: PixelArt, options: BeadPdfOptions = {}): Uint8Array {
  return beadPdf(art, { ...options, deflate: deflateNode })
}
