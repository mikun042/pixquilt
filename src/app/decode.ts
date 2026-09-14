/**
 * 浏览器侧图片解码：把用户拖进来的任意图片变成 core 需要的 RGBA 缓冲。
 *
 * 与 Node 侧（src/io/node-image.ts）的分工：
 *  - 这里是"能力最强"的通道，靠浏览器原生解码覆盖 PNG/JPG/WebP/GIF/BMP/AVIF/ICO/SVG；
 *  - Node 侧只承诺 PNG（其余交给浏览器通道或先转格式）。
 * 两边都产出同一种形状（width/height/data），因此 core 不需要知道自己在哪跑。
 */
import { ALPHA_THRESHOLD, SVG_RASTER_MAX, SVG_RASTER_MIN } from '../core/limits.ts'
import type { SourceImage } from '../core/pipeline.ts'

/** 支持的扩展名 / MIME（与 使用说明 一致，避免"文档说支持但实际报错"） */
export const BROWSER_DECODABLE = ['png', 'jpg', 'jpeg', 'jfif', 'webp', 'gif', 'bmp', 'avif', 'ico', 'cur', 'svg'] as const

export function looksLikeImage(file: { name: string; type: string }): boolean {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase()
  return file.type.startsWith('image/') || (BROWSER_DECODABLE as readonly string[]).includes(ext)
}

/** SVG 需要按"声明尺寸"栅格化：直接 decode 会得到 0×0 或浏览器默认尺寸 */
function svgIntrinsicSize(text: string): { w: number; h: number } | null {
  const svgTag = text.match(/<svg[^>]*>/i)?.[0]
  if (!svgTag) return null
  const attr = (name: string) => svgTag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1]
  const num = (v: string | undefined) => {
    if (!v) return null
    const m = v.match(/^\s*([\d.]+)/)
    return m ? Number(m[1]) : null
  }
  const w = num(attr('width'))
  const h = num(attr('height'))
  if (w && h) return { w, h }
  const vb = attr('viewBox')
  if (vb) {
    const parts = vb.split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) return { w: parts[2], h: parts[3] }
  }
  return null
}

/**
 * 解码为 RGBA。策略：
 *  1. 优先 `createImageBitmap(blob)` —— 快，且支持 EXIF 方向；
 *  2. SVG 走 `<img>` + canvas 栅格化（长边夹到 `SVG_RASTER_MIN`–`SVG_RASTER_MAX`，避免超大画布拖死页面）；
 *  3. `createImageBitmap` 失败时回退 `<img>` 路径（部分旧格式只支持后者）。
 * 注意：**必须走 canvas 才能拿到 RGBA 缓冲**；ImageBitmap 也需要 drawImage 一遍。
 */
export async function decodeToRgba(file: Blob & { name?: string }): Promise<SourceImage> {
  const isSvg = (file.type === 'image/svg+xml') || /\.svg$/i.test(file.name ?? '')

  if (isSvg) {
    const text = await file.text()
    // 没有声明尺寸的 SVG 按栅格化下限当正方形处理
    const size = svgIntrinsicSize(text) ?? { w: SVG_RASTER_MIN, h: SVG_RASTER_MIN }
    const long = Math.max(size.w, size.h)
    const scale = long > SVG_RASTER_MAX ? SVG_RASTER_MAX / long : long < SVG_RASTER_MIN ? SVG_RASTER_MIN / long : 1
    const w = Math.max(1, Math.round(size.w * scale))
    const h = Math.max(1, Math.round(size.h * scale))
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))
    try {
      const img = await loadImageElement(url)
      return drawToRgba(img, w, h)
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  try {
    const bitmap = await createImageBitmap(file)
    try {
      return drawToRgba(bitmap, bitmap.width, bitmap.height)
    } finally {
      bitmap.close?.()
    }
  } catch {
    const url = URL.createObjectURL(file)
    try {
      const img = await loadImageElement(url)
      return drawToRgba(img, img.naturalWidth || img.width, img.naturalHeight || img.height)
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解码失败（格式不支持或文件损坏）'))
    img.src = src
  })
}

function drawToRgba(source: CanvasImageSource, width: number, height: number): SourceImage {
  if (!(width > 0) || !(height > 0)) throw new Error('图片尺寸为 0，无法处理')
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('浏览器不支持 2D 画布，无法解码图片')
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(source, 0, 0, width, height)
  const data = ctx.getImageData(0, 0, width, height).data
  // 硬边化：像素画不该有半透明羽化边，低于阈值的直接透明
  for (let i = 3; i < data.length; i += 4) data[i] = data[i] < ALPHA_THRESHOLD ? 0 : 255
  return { width, height, data }
}

/** 把画布渲染成缩略图（右侧「显示」区用；保持像素硬边） */
export function makeThumbnail(source: SourceImage, maxSide = 160): string {
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height))
  const w = Math.max(1, Math.round(source.width * scale))
  const h = Math.max(1, Math.round(source.height * scale))
  const full = document.createElement('canvas')
  full.width = source.width
  full.height = source.height
  const fctx = full.getContext('2d')
  if (!fctx) return ''
  // ImageData 需要底层是 ArrayBuffer：显式复制一份，避免 SharedArrayBuffer 带来的类型/运行时歧义
  const buffer = new Uint8ClampedArray(new ArrayBuffer(source.data.length))
  buffer.set(source.data)
  fctx.putImageData(new ImageData(buffer, source.width, source.height), 0, 0)

  const small = document.createElement('canvas')
  small.width = w
  small.height = h
  const sctx = small.getContext('2d')
  if (!sctx) return ''
  sctx.imageSmoothingEnabled = true
  sctx.drawImage(full, 0, 0, w, h)
  return small.toDataURL('image/png')
}

/** 从剪贴板事件里取出图片文件 */
export function imageFromClipboard(e: ClipboardEvent): File | null {
  const items = e.clipboardData?.items
  if (!items) return null
  for (const item of Array.from(items)) {
    if (item.type.startsWith('image/')) {
      const f = item.getAsFile()
      if (f) return f
    }
  }
  return null
}
