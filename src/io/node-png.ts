/**
 * Node 侧 PNG 编解码适配：把平台相关的 zlib 注入给纯编解码器。
 *
 * 存在的意义：`src/core/png.ts` 是纯的（浏览器也能用），但压缩/解压必须由平台提供。
 * Node 用 `node:zlib`；浏览器用 canvas（`src/app/canvas-png.ts`）。这样"平台绑定"只在这两个薄文件里，
 * core 永远可被单测与 CLI 直接使用。
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { assemblePng, decodePng, rawScanlines, type RgbaImage } from '../core/png.ts'

/** 编码为 PNG 字节（level 9：导出的图通常不大，压缩率优先于速度） */
export function encodePngNode(img: RgbaImage, level = 9): Uint8Array {
  return assemblePng(img, new Uint8Array(deflateSync(rawScanlines(img), { level })))
}

/** 解码 PNG 字节为 RGBA */
export function decodePngNode(bytes: Uint8Array): RgbaImage {
  return decodePng(bytes, (data) => new Uint8Array(inflateSync(data)))
}
