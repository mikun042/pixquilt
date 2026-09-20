/**
 * 导出：PNG（整数倍放大）/ 像素数据 JSON / 项目 JSON / 图集拼合 / 画布指纹。
 *
 * 分层约束：这里**不做下载**（`document`/`Blob` 只属于浏览器层），只把画布变成字节或字符串。
 * 这样 Node CLI 与浏览器 UI 能共用同一套导出实现（docs/开发.md §4.1 的 L3 就是靠这条成立）。
 */
import { ALPHA_THRESHOLD, PALETTE_MAX, SCHEMA_VERSION, SUPPORTED_VERSIONS } from './limits.ts'
import { base64ToBytes, bytesToBase64, safeFileBase } from './binary.ts'
import { coerceParams, normalizeHex, type ConvertParams, type PixelArt, type ProjectFile } from './types.ts'
import { artToImageData, clampScale, type RasterOptions } from './raster.ts'
import { countTransparent, countUsage } from './stats.ts'

export { clampScale, safeFileBase }
export type { RasterOptions }

/**
 * PNG 编码**不在这里**：它需要平台的压缩器（Node 用 zlib，浏览器用 canvas）。
 * 放进来会让浏览器包被迫依赖 `node:zlib`（重构时踩到的真实分层缺陷）。
 * 需要字节的调用方直接用对应平台：
 *   Node    → `src/io/node-png.ts` 的 `encodePngNode()`
 *   浏览器  → `src/app/canvas-png.ts` 的 `artToPngBlob()` / `artToPngDataURLSync()`
 */
export { artToImageData }

/**
 * 像素数据 JSON（含每色用量表，拼豆原料清单）。
 * **紧凑输出**：2048² 约 40MB，缩进会让它翻倍；需要更小请用 pixbin 或项目 JSON。
 */
export function pixelJSONString(art: PixelArt, opts: { pretty?: boolean; codes?: string[] } = {}): string {
  const usage = countUsage(art.indices, art.palette, art.alphaMask)
  const transparent = countTransparent(art.indices, art.alphaMask)
  const pixels: (string | null)[] = []
  for (let i = 0; i < art.indices.length; i++) {
    if (art.alphaMask && art.alphaMask[i] < ALPHA_THRESHOLD) pixels.push(null)
    else pixels.push((art.palette[art.indices[i]] ?? '#000000').toLowerCase())
  }
  const payload: Record<string, unknown> = {
    width: art.width,
    height: art.height,
    palette: art.palette,
    usage,
    transparentCells: transparent,
    pixels,
  }
  if (opts.codes) payload.codes = opts.codes
  if (art.alphaMask) payload.alphaThreshold = ALPHA_THRESHOLD
  return opts.pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload)
}

/** 项目文件：参数 + 色板 + 索引矩阵（base64）+ 可选 alpha；**不含原图** */
export function buildProjectFile(art: PixelArt, params: ConvertParams): ProjectFile {
  const file: ProjectFile = {
    version: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    params,
    width: art.width,
    height: art.height,
    palette: art.palette,
    indices: bytesToBase64(art.indices),
  }
  if (art.alphaMask && art.alphaMask.some((v) => v < ALPHA_THRESHOLD)) file.alpha = bytesToBase64(art.alphaMask)
  return file
}

export function projectJSONString(art: PixelArt, params: ConvertParams, pretty = false): string {
  const file = buildProjectFile(art, params)
  return pretty ? JSON.stringify(file, null, 2) : JSON.stringify(file)
}

export class ProjectParseError extends Error {}

/**
 * 解析项目 JSON。**严格校验**：尺寸上限、base64 长度、色板合法性都要过，
 * 宁可明确报错，也不要还原出一张错画布（这条上踩过坑）。
 */
export function parseProjectFile(text: string): { params: ConvertParams; art: PixelArt; savedAt: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ProjectParseError('项目文件不是合法 JSON')
  }
  const f = raw as Partial<ProjectFile>
  if (!f || typeof f !== 'object') throw new ProjectParseError('项目文件结构不对')

  const version = typeof f.version === 'number' ? f.version : 0
  if (version === 0) throw new ProjectParseError('项目文件缺少 version 字段')
  if (!(SUPPORTED_VERSIONS as readonly number[]).includes(version)) {
    throw new ProjectParseError(`不支持的项目版本 ${version}（本版本支持 ${SUPPORTED_VERSIONS.join('/')}）`)
  }

  const width = Math.floor(Number(f.width))
  const height = Math.floor(Number(f.height))
  if (!(width >= 1) || !(height >= 1)) throw new ProjectParseError('项目文件的画布尺寸非法')
  if (width > 2048 || height > 2048) throw new ProjectParseError(`项目文件的画布尺寸超上限（${width}×${height} > 2048）`)

  const total = width * height
  if (typeof f.indices !== 'string') throw new ProjectParseError('项目文件缺少像素数据')
  const indices = base64ToBytes(f.indices)
  if (indices.length !== total) throw new ProjectParseError(`像素数据长度不符（期望 ${total}，实际 ${indices.length}）`)

  if (!Array.isArray(f.palette) || f.palette.length === 0) throw new ProjectParseError('项目文件缺少色板')
  const palette: string[] = []
  for (const c of f.palette) {
    const n = typeof c === 'string' ? normalizeHex(c) : null
    if (!n) throw new ProjectParseError(`色板里有非法颜色：${String(c)}`)
    palette.push(n)
  }
  if (palette.length > PALETTE_MAX) throw new ProjectParseError(`色板超过 ${PALETTE_MAX} 色`)

  let alphaMask: Uint8Array | null = null
  if (typeof f.alpha === 'string' && f.alpha.length > 0) {
    const mask = base64ToBytes(f.alpha)
    if (mask.length !== total) throw new ProjectParseError(`alpha 数据长度不符（期望 ${total}，实际 ${mask.length}）`)
    alphaMask = mask.some((v) => v < ALPHA_THRESHOLD) ? mask : null
  }

  // 越界索引会让导出读到 undefined 颜色：这里直接判定为坏文件
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= palette.length) throw new ProjectParseError(`像素数据引用了不存在的色板索引（第 ${i} 格）`)
  }

  return {
    params: coerceParams(f.params),
    art: { width, height, indices, palette, alphaMask },
    savedAt: typeof f.savedAt === 'string' ? f.savedAt : '',
  }
}

/**
 * 二进制伴生格式 pixbin：12 字节头 + indices + 可选 alphaMask。
 *
 * 头布局（**必须逐字节对齐，写错一位就会读出 0**）：
 *   [0..4]  'PIXB1'        魔数
 *   [5]     flags           bit0 = 是否带 alphaMask
 *   [6..7]  width  uint16 BE  （画布单边上限 2048，uint16 足够，且不会与相邻字段重叠）
 *   [8..9]  height uint16 BE
 *   [10..11] 保留（写 0，便于将来扩展时不必改版本号）
 * 大画布走这条通道比像素 JSON（`pixelJSONString`）快**两个数量级**
 * （无 4/3 膨胀、无字符串解析）。见 `docs/架构.md` §6 的实测。
 */
export const PIXBIN_MAGIC = 'PIXB1'
export const PIXBIN_HEADER = 12

export function encodePixBin(art: PixelArt): Uint8Array {
  const hasAlpha = !!art.alphaMask && art.alphaMask.some((v) => v < ALPHA_THRESHOLD)
  const out = new Uint8Array(PIXBIN_HEADER + art.indices.length + (hasAlpha ? art.indices.length : 0))
  for (let i = 0; i < 5; i++) out[i] = PIXBIN_MAGIC.charCodeAt(i)
  out[5] = hasAlpha ? 1 : 0
  out[6] = (art.width >> 8) & 255
  out[7] = art.width & 255
  out[8] = (art.height >> 8) & 255
  out[9] = art.height & 255
  out[10] = 0
  out[11] = 0
  out.set(art.indices, PIXBIN_HEADER)
  if (hasAlpha && art.alphaMask) out.set(art.alphaMask, PIXBIN_HEADER + art.indices.length)
  return out
}

export function decodePixBin(bytes: Uint8Array, palette: string[]): PixelArt {
  if (bytes.length < PIXBIN_HEADER) throw new ProjectParseError('pixbin 数据过短')
  for (let i = 0; i < 5; i++) if (bytes[i] !== PIXBIN_MAGIC.charCodeAt(i)) throw new ProjectParseError('pixbin 魔数不符')
  const hasAlpha = (bytes[5] & 1) === 1
  const width = (bytes[6] << 8) | bytes[7]
  const height = (bytes[8] << 8) | bytes[9]
  if (width < 1 || height < 1) throw new ProjectParseError(`pixbin 头里的尺寸非法：${width}×${height}`)
  const total = width * height
  if (bytes.length !== PIXBIN_HEADER + total + (hasAlpha ? total : 0)) {
    throw new ProjectParseError(`pixbin 长度与尺寸不符（头 ${width}×${height}，实际 ${bytes.length} 字节）`)
  }
  const indices = bytes.slice(PIXBIN_HEADER, PIXBIN_HEADER + total)
  const alphaMask = hasAlpha ? bytes.slice(PIXBIN_HEADER + total) : null
  return { width, height, indices, palette, alphaMask }
}

export interface SheetFrame {
  name: string
  x: number
  y: number
  width: number
  height: number
  /** 内容相对单元格中心的偏移（游戏引擎 pivot 用；帧尺寸恒等，不裁边） */
  offsetX: number
  offsetY: number
}

export interface SheetResult {
  width: number
  height: number
  columns: number
  rows: number
  frames: SheetFrame[]
}

/**
 * 图集布局计算（**不渲染**，纯几何）：等尺寸单元格网格。
 *
 * 为什么用等尺寸网格而不是紧排：游戏引擎按固定帧尺寸切片最省事，
 * 帧尺寸不等会让导出侧和引擎侧都要额外处理 offset。这里把"对齐"交给 offset 字段表达。
 */
export function layoutSheet(frames: { name: string; width: number; height: number; offsetX?: number; offsetY?: number }[], columns = 0, padding = 0): SheetResult {
  if (frames.length === 0) return { width: 0, height: 0, columns: 0, rows: 0, frames: [] }
  const cw = Math.max(...frames.map((f) => f.width))
  const ch = Math.max(...frames.map((f) => f.height))
  const cols = columns > 0 ? Math.floor(columns) : Math.max(1, Math.ceil(Math.sqrt(frames.length)))
  const rows = Math.ceil(frames.length / cols)

  const out: SheetFrame[] = frames.map((f, i) => {
    const cx = i % cols
    const cy = Math.floor(i / cols)
    // 小于单元格的帧居中放置，offset 记录内容相对中心的位移（引擎侧直接用）
    const padX = Math.floor((cw - f.width) / 2)
    const padY = Math.floor((ch - f.height) / 2)
    return {
      name: f.name,
      x: cx * (cw + padding) + padX,
      y: cy * (ch + padding) + padY,
      width: f.width,
      height: f.height,
      offsetX: f.offsetX ?? -(padX - Math.floor((cw - f.width) / 2)),
      offsetY: f.offsetY ?? -(padY - Math.floor((ch - f.height) / 2)),
    }
  })

  return {
    width: cols * cw + Math.max(0, cols - 1) * padding,
    height: rows * ch + Math.max(0, rows - 1) * padding,
    columns: cols,
    rows,
    frames: out,
  }
}

/** 画布指纹：跨运行比对"同图同参是否逐位一致"（确定性验证用） */
export function artHash(art: PixelArt): string {
  let h1 = 0x811c9dc5
  const mix = (v: number) => {
    h1 ^= v
    h1 = Math.imul(h1, 0x01000193) >>> 0
  }
  mix(art.width & 255)
  mix((art.width >> 8) & 255)
  mix(art.height & 255)
  mix((art.height >> 8) & 255)
  mix(art.palette.length)
  for (const c of art.palette) for (let i = 1; i < c.length; i++) mix(c.charCodeAt(i))
  for (let i = 0; i < art.indices.length; i++) mix(art.indices[i])
  if (art.alphaMask) for (let i = 0; i < art.alphaMask.length; i++) mix(art.alphaMask[i])
  return h1.toString(16).padStart(8, '0')
}