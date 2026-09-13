/**
 * PNG 编解码（纯 JS 编 / 纯 JS 解，零平台依赖）。
 *
 * 分工说明（这是分层的关键，别混）：
 *  - **纯编码**（本文件 `encodePng`）：只用 `Uint8Array`，所以浏览器与 Node 都能用。
 *    压缩交给调用方（Node 传 zlib；浏览器传 CompressionStream 或直接用 canvas 编码）。
 *  - **纯解码**（本文件 `decodePng`）：浏览器也能用（兜底路径），Node 侧是主路径。
 *  - Node 专属的 zlib 压缩在 `src/io/node-png.ts`；浏览器专属的 canvas 编码在 `src/app/canvas-png.ts`。
 *
 * 之所以要守住这条线：core 一旦 import `node:zlib`，浏览器包就构建不出来
 * （这正是本次重构踩到并修掉的第一个分层缺陷）。
 */
import { crc32 } from './binary.ts'
import { ALPHA_THRESHOLD } from './limits.ts'

export interface RgbaImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** PNG 原始扫描线（filter 字节 + 像素），encodePng 与压缩器之间的唯一接口 */
export function rawScanlines(img: RgbaImage): Uint8Array {
  const { width, height, data } = img
  const raw = new Uint8Array(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4)
    // filter 固定 None：导出的是硬边像素画，用过滤器收益极低而 CPU 成本明显
    raw[rowStart] = 0
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), rowStart + 1)
  }
  return raw
}

/** 用给定的 IDAT 压缩结果组装完整 PNG 字节流（压缩由平台层提供） */
export function assemblePng(img: RgbaImage, compressed: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13)
  const iv = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength)
  iv.setUint32(0, img.width)
  iv.setUint32(4, img.height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  const parts = [new Uint8Array(PNG_SIGNATURE), chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

export class PngDecodeError extends Error {}

interface Header {
  width: number
  height: number
  bitDepth: number
  colorType: number
  interlace: number
}

function parseHeader(bytes: Uint8Array): Header {
  if (bytes.length < 33) throw new PngDecodeError('PNG 数据过短')
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) throw new PngDecodeError('不是 PNG 文件（签名不符）')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const type = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
  if (type !== 'IHDR') throw new PngDecodeError('PNG 缺少 IHDR')
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
    interlace: bytes[28],
  }
}

function* iterateChunks(bytes: Uint8Array): Generator<{ type: string; data: Uint8Array }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let off = 8
  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off)
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7])
    const start = off + 8
    const end = start + len
    if (end > bytes.length) throw new PngDecodeError(`PNG chunk ${type} 长度越界`)
    yield { type, data: bytes.subarray(start, end) }
    off = end + 4 // 跳过 CRC
    if (type === 'IEND') break
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** 按 PNG 规范逐行反过滤（filter 0–4） */
function unfilter(raw: Uint8Array, height: number, stride: number, bpp: number): Uint8Array {
  const out = new Uint8Array(height * stride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const rowStart = y * stride
    const prevStart = (y - 1) * stride
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[pos + x]
      const a = x >= bpp ? out[rowStart + x - bpp] : 0
      const b = y > 0 ? out[prevStart + x] : 0
      const c = y > 0 && x >= bpp ? out[prevStart + x - bpp] : 0
      let value: number
      switch (filter) {
        case 0: value = rawByte; break
        case 1: value = rawByte + a; break
        case 2: value = rawByte + b; break
        case 3: value = rawByte + ((a + b) >> 1); break
        case 4: value = rawByte + paeth(a, b, c); break
        default: throw new PngDecodeError(`不支持的 PNG filter 类型：${filter}`)
      }
      out[rowStart + x] = value & 255
    }
    pos += stride
  }
  return out
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/**
 * 解码 PNG 为 RGBA。支持位深 8/16、颜色类型 0/2/3/4/6、非隔行。
 * 16 位取高字节（视觉等价于 /257，避免为了极少见的 16 位图引入浮点缩放表）。
 */
export function decodePng(bytes: Uint8Array, inflate: (data: Uint8Array) => Uint8Array): RgbaImage {
  const header = parseHeader(bytes)
  const { width, height, bitDepth, colorType, interlace } = header
  if (interlace !== 0) throw new PngDecodeError('暂不支持隔行（Adam7）PNG，请另存为普通 PNG')
  if (bitDepth !== 8 && bitDepth !== 16) throw new PngDecodeError(`暂不支持位深 ${bitDepth} 的 PNG`)
  const channels = CHANNELS[colorType]
  if (!channels) throw new PngDecodeError(`暂不支持的颜色类型 ${colorType}`)
  if (width < 1 || height < 1) throw new PngDecodeError('PNG 尺寸非法')

  const idat: Uint8Array[] = []
  let paletteRgb: Uint8Array | null = null
  let paletteAlpha: Uint8Array | null = null
  for (const c of iterateChunks(bytes)) {
    if (c.type === 'IDAT') idat.push(c.data)
    else if (c.type === 'PLTE') paletteRgb = c.data
    else if (c.type === 'tRNS') paletteAlpha = c.data
    else if (c.type === 'IEND') break
  }
  if (idat.length === 0) throw new PngDecodeError('PNG 没有 IDAT 数据')

  const merged = new Uint8Array(idat.reduce((n, d) => n + d.length, 0))
  let off = 0
  for (const d of idat) {
    merged.set(d, off)
    off += d.length
  }
  const pixels = unfilter(inflate(merged), height, width * channels * (bitDepth / 8), channels * (bitDepth / 8))

  const bytesPerSample = bitDepth / 8
  const bpp = channels * bytesPerSample
  const stride = width * bpp
  const out = new Uint8ClampedArray(width * height * 4)
  const sample = (row: number, x: number, ch: number): number => pixels[row * stride + x * bpp + ch * bytesPerSample]

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (colorType === 3) {
        const idx = sample(y, x, 0)
        out[o] = paletteRgb ? paletteRgb[idx * 3] : 0
        out[o + 1] = paletteRgb ? paletteRgb[idx * 3 + 1] : 0
        out[o + 2] = paletteRgb ? paletteRgb[idx * 3 + 2] : 0
        out[o + 3] = paletteAlpha && idx < paletteAlpha.length ? paletteAlpha[idx] : 255
      } else if (colorType === 0 || colorType === 4) {
        const g = sample(y, x, 0)
        out[o] = g
        out[o + 1] = g
        out[o + 2] = g
        out[o + 3] = colorType === 4 ? sample(y, x, 1) : 255
      } else {
        out[o] = sample(y, x, 0)
        out[o + 1] = sample(y, x, 1)
        out[o + 2] = sample(y, x, 2)
        out[o + 3] = colorType === 6 ? sample(y, x, 3) : 255
      }
    }
  }

  return { width, height, data: out }
}

/** 把 RGBA 缓冲转成硬边 alpha（像素画不该有半透明羽化边） */
export function hardenAlpha(img: RgbaImage, threshold = ALPHA_THRESHOLD): RgbaImage {
  const data = img.data.slice()
  for (let i = 0; i < data.length; i += 4) data[i + 3] = data[i + 3] < threshold ? 0 : 255
  return { width: img.width, height: img.height, data }
}
