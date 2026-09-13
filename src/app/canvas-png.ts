/**
 * 浏览器侧 PNG 编码：走 canvas 的 `toBlob`。
 *
 * 为什么不用 core 的纯 JS 编码器：那条路需要 zlib（Node 专属），把 `node:zlib` 拉进浏览器包会直接构建失败；
 * 而浏览器自带高性能 PNG 编码器，走 `toBlob` 既快又不引入任何依赖。
 * 像素数据仍来自 core 的 `artToImageData`（最近邻放大），因此**像素结果与 CLI 完全一致**，
 * 差异只可能出现在 PNG 的压缩参数上（像素值与透明通道不受影响）。
 */
import { artToImageData, type RasterOptions } from '../core/raster.ts'
import type { PixelArt } from '../core/types.ts'

export async function artToPngBlob(art: PixelArt, scale = 1, opts: RasterOptions = {}): Promise<Blob> {
  const img = artToImageData(art, scale, opts)
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持 2D 画布，无法编码 PNG')
  // ImageData 要求底层是 ArrayBuffer：显式拷贝一份，规避 SharedArrayBuffer 带来的类型歧义
  const buffer = new Uint8ClampedArray(new ArrayBuffer(img.data.length))
  buffer.set(img.data)
  ctx.putImageData(new ImageData(buffer, img.width, img.height), 0, 0)

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
  if (!blob) throw new Error('PNG 编码失败（画布尺寸可能超出浏览器上限，可降低导出倍数）')
  return blob
}

export async function artToPngDataURL(art: PixelArt, scale = 1, opts: RasterOptions = {}): Promise<string> {
  return await blobToDataURL(await artToPngBlob(art, scale, opts))
}

/**
 * 同步 dataURL（走 canvas.toDataURL）。
 * 供**页内 API 的 `exportPNG()` 使用**：脚本端期待一个同步返回的字符串，
 * 改成 Promise 会破坏既有调用方式（API 稳定性优先于内部实现的整洁）。
 * 导出下载仍走 `artToPngBlob`（Blob 路径更省内存，也不阻塞主线程）。
 */
export function artToPngDataURLSync(art: PixelArt, scale = 1, opts: RasterOptions = {}): string {
  const img = artToImageData(art, scale, opts)
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持 2D 画布，无法编码 PNG')
  const buffer = new Uint8ClampedArray(new ArrayBuffer(img.data.length))
  buffer.set(img.data)
  ctx.putImageData(new ImageData(buffer, img.width, img.height), 0, 0)
  return canvas.toDataURL('image/png')
}

export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取 PNG 字节失败'))
    reader.readAsDataURL(blob)
  })
}
