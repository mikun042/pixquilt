/**
 * 数据模型与参数 Schema（v3）。
 * 这里定义 core / UI / 页内 API / CLI 四方共用的契约，因此它是"改动要慎重"的文件：
 * 任何字段的增删都必须同步 SCHEMA_VERSION、sanitize、spec.ts 与 docs/AGENT_API.md。
 */
import {
  ALPHA_THRESHOLD,
  CLEANUP_MIN_SIZE_MAX,
  CLEANUP_MIN_SIZE_MIN,
  MAX_CANVAS_SIDE,
  MIN_CANVAS_SIDE,
  PALETTE_K_MAX,
  PALETTE_K_MIN,
  SCHEMA_VERSION,
  SUPPORTED_VERSIONS,
} from './limits.ts'

export { SCHEMA_VERSION, SUPPORTED_VERSIONS, ALPHA_THRESHOLD }

export type DitherMode = 'none' | 'floyd' | 'bayer'
export type PaletteMode = 'auto' | 'preset' | 'custom'
export type DownsampleMode = 'average' | 'nearest'
export type CropRatio = 'free' | '1:1' | '4:3' | '16:9'
export type TransparentMode = 'none' | 'key' | 'alpha'

/** 工具清单单一来源：类型、偏好白名单、UI 按钮顺序、API 校验都由它派生 */
export const TOOLS = ['pencil', 'bucket', 'picker', 'rect', 'ellipse', 'selection'] as const
export type Tool = (typeof TOOLS)[number]

/** 游戏资产/精灵的锚点：决定内容在固定尺寸画布中的落位（不裁边，只给偏移） */
export type Anchor = 'center' | 'bottom-center' | 'top-left'

export interface ConvertParams {
  /** 输出长边格数（8–2048）；游戏资产模式下由 exactWidth/Height 覆盖 */
  longEdge: number
  downsample: DownsampleMode
  cropRatio: CropRatio
  paletteMode: PaletteMode
  /** 自动取色的目标颜色数 2–64 */
  paletteK: number
  /** 预置色卡 id（pico8/gameboy/nes/cga…，含拼豆号色卡） */
  presetPaletteId: string
  /** 自定义色板（'#rrggbb' 数组），paletteMode === 'custom' 时生效；≤256 */
  customPalette: string[]
  dither: DitherMode
  /** 抖动强度 0–100 */
  ditherStrength: number
  cleanup: boolean
  /** 小于该格数的连通色块并入邻域主色；与抖动互斥 */
  cleanupMinSize: number
  brightness: number
  contrast: number
  saturation: number
  /** 透明处理：不透明（合成到 matteColor）/ 单色键控（导出时该色变透明）/ 真 alpha */
  transparent: TransparentMode
  /** alpha 合成与键控用的底色（旧项目叫 flattenBg） */
  matteColor: string
  /** 强制输出精确尺寸（游戏资产模式）：给定时忽略 longEdge 的按比例推导 */
  exactWidth?: number
  exactHeight?: number
  /** 强制"只用给定色板"（拼豆/资产批次）：量化时不允许新增颜色 */
  lockPalette?: boolean
}

export const DEFAULT_PARAMS: ConvertParams = {
  longEdge: 64,
  downsample: 'average',
  cropRatio: 'free',
  paletteMode: 'auto',
  paletteK: 24,
  presetPaletteId: 'pico8',
  customPalette: [],
  dither: 'none',
  ditherStrength: 100,
  cleanup: true,
  cleanupMinSize: 2,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  transparent: 'none',
  matteColor: '#ffffff',
}

export interface PixelArt {
  width: number
  height: number
  /** 每格的色板索引，行主序 */
  indices: Uint8Array
  /** 工作色板（'#rrggbb' 小写；手动绘制可扩充，≤256） */
  palette: string[]
  /** 每格不透明度 0–255（255=不透明）；null/undefined = 全不透明 */
  alphaMask?: Uint8Array | null
  /**
   * 动画帧（**预留**，本期不实现、不读写）。
   * 见 重构计划.md §4.7：先把单画布做扎实，多帧只占字段位，避免半成品 API 冻结。
   */
  frames?: Frame[] | null
}

export interface Frame {
  indices: Uint8Array
  alphaMask?: Uint8Array | null
  durationMs?: number
}

/** 项目 JSON：只含参数 + 色板 + 索引矩阵，不含原图（原图只存本地 IndexedDB） */
export interface ProjectFile {
  version: number
  savedAt: string
  params: ConvertParams
  width: number
  height: number
  palette: string[]
  /** base64(Uint8Array) */
  indices: string
  /** base64(Uint8Array)：每格不透明度，全不透明时可省略 */
  alpha?: string
}

export interface StylePreset {
  id: string
  name: string
  /** 面向用户的一句话说明（UI tooltip 与 describe() 共用） */
  desc: string
  params: Partial<ConvertParams>
}

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'photo',
    name: '照片写实',
    desc: '自动取色 32 色、区域平均，适合人像与风景照片',
    params: { paletteMode: 'auto', paletteK: 32, dither: 'none', cleanup: true, cleanupMinSize: 2, downsample: 'average', longEdge: 128 },
  },
  {
    id: 'gameboy',
    name: 'GameBoy',
    desc: 'DMG 四绿 + Bayer 抖动，复古掌机观感',
    params: { paletteMode: 'preset', presetPaletteId: 'gameboy', dither: 'bayer', ditherStrength: 60, cleanup: false, downsample: 'average', longEdge: 64, contrast: 15, saturation: -20 },
  },
  {
    id: 'retro',
    name: '复古主机',
    desc: 'NES 色表 + 最近邻，硬边像素风',
    params: { paletteMode: 'preset', presetPaletteId: 'nes', dither: 'none', cleanup: true, cleanupMinSize: 2, downsample: 'nearest', longEdge: 96, contrast: 10, saturation: 10 },
  },
  {
    id: 'silhouette',
    name: '黑白剪影',
    desc: '2 色 + 强对比 + 去饱和，适合图标与剪影',
    params: { paletteMode: 'auto', paletteK: 2, dither: 'none', cleanup: true, cleanupMinSize: 6, downsample: 'average', longEdge: 64, contrast: 30, saturation: -100 },
  },
  {
    id: 'sprite',
    name: '游戏精灵',
    desc: '固定 32×32、PICO-8 色板、保留透明、不做杂色清理：像素资产起步配置（1px 细节原样保留）',
    // cleanup: false 是这个预设的关键。杂色清理把"小连通块并入邻色"，而像素素材里的
    // 小连通块往往正是**故意画的高光、眼神、描边断点**——实测 64×64 精灵过一遍默认参数，
    // 1px 高光被整块吃掉。清理的目标是照片压缩噪点，像素素材本来就没有噪点。
    params: { paletteMode: 'preset', presetPaletteId: 'pico8', dither: 'none', cleanup: false, downsample: 'nearest', transparent: 'alpha', exactWidth: 32, exactHeight: 32 },
  },
  {
    id: 'beads',
    name: '拼豆图纸',
    desc: '固定号色板 + 只用已有色 + 不抖动，保证图纸可复现且配色统一',
    params: { paletteMode: 'preset', presetPaletteId: 'beads16', dither: 'none', cleanup: true, cleanupMinSize: 2, downsample: 'average', lockPalette: true, longEdge: 58 },
  },
]

const HEX_RE = /^#[0-9a-fA-F]{6}$/

/** 颜色字符串是否合法（'#rrggbb'）；唯一的正则出处 */
export function isHex(v: unknown): v is string {
  return typeof v === 'string' && HEX_RE.test(v)
}

/** 归一化为小写 '#'+6 位；非法返回 null（容忍缺 # 与大小写） */
export function normalizeHex(v: string): string | null {
  const m = String(v).trim().match(/^#?([0-9a-fA-F]{6})$/)
  return m ? `#${m[1].toLowerCase()}` : null
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function hexField(v: unknown, fallback: string): string {
  return isHex(v) ? v.toLowerCase() : fallback
}

function paletteField(v: unknown, max = 256): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const c of v) {
    const n = typeof c === 'string' ? normalizeHex(c) : null
    if (n) out.push(n)
    if (out.length >= max) break
  }
  return out
}

export interface FixedField {
  key: string
  from: unknown
  to: unknown
  reason: string
}

export interface SanitizeReport {
  params: ConvertParams
  /** 被夹紧/回退/迁移过的字段，供 validateParams() 如实告知调用方（agent 改参前预演） */
  fixed: FixedField[]
}

/**
 * 参数校验：坏值回退默认、越界夹紧，并**如实报告**每一处修正。
 *
 * 为什么必须报告而不是静默：agent 传了 `longEdge: 99999`，若只默默变成 2048 而不说，
 * 它会以为自己要的尺寸生效了，后续按 99999 做规划，最后拿到一张"莫名其妙的图"。
 * 这是"agent 友好"的具体落点之一，不是可选的锦上添花。
 */
export function sanitizeParams(raw: unknown): SanitizeReport {
  const d = DEFAULT_PARAMS
  const fixed: FixedField[] = []
  if (!raw || typeof raw !== 'object') {
    return { params: { ...d }, fixed: raw === undefined ? [] : [{ key: '*', from: raw, to: '默认参数', reason: '不是对象' }] }
  }
  const p = raw as Record<string, unknown>

  /** 数值：越界或类型不符时记录（含"只被夹紧、未回退默认"的情况） */
  const numP = (key: keyof ConvertParams, min: number, max: number, fb: number): number => {
    const rawV = p[key]
    if (typeof rawV !== 'number' || !Number.isFinite(rawV)) {
      if (rawV !== undefined) fixed.push({ key, from: rawV, to: fb, reason: '不是有限数值，回退默认' })
      return fb
    }
    const v = Math.min(max, Math.max(min, rawV))
    if (v !== rawV) fixed.push({ key, from: rawV, to: v, reason: `越界，夹到 ${min}..${max}` })
    return v
  }
  /** 枚举：不在枚举内时记录 */
  const enumP = <T extends string>(key: keyof ConvertParams, allowed: readonly T[], fb: T): T => {
    const rawV = p[key]
    if (typeof rawV === 'string' && (allowed as readonly string[]).includes(rawV)) return rawV as T
    if (rawV !== undefined) fixed.push({ key, from: rawV, to: fb, reason: `不是 ${allowed.join('/')} 之一，回退默认` })
    return fb
  }
  const boolP = (key: keyof ConvertParams, fb: boolean): boolean => {
    const rawV = p[key]
    if (typeof rawV === 'boolean') return rawV
    if (rawV !== undefined) fixed.push({ key, from: rawV, to: fb, reason: '不是布尔值，回退默认' })
    return fb
  }

  // 透明：v2 的 alpha:boolean 迁移到 v3 的 transparent 三态
  let transparent: TransparentMode
  if (p.transparent === 'alpha' || p.transparent === 'key' || p.transparent === 'none') {
    transparent = p.transparent
  } else if (typeof p.alpha === 'boolean') {
    transparent = p.alpha ? 'alpha' : 'none'
    fixed.push({ key: 'transparent', from: p.alpha, to: transparent, reason: '旧字段 alpha(boolean) 迁移为 transparent' })
  } else {
    transparent = enumP('transparent', ['none', 'key', 'alpha'] as const, d.transparent)
  }

  // 旧字段 flattenBg → matteColor
  const matteRaw = p.matteColor ?? p.flattenBg
  if (p.matteColor === undefined && p.flattenBg !== undefined) {
    fixed.push({ key: 'matteColor', from: p.flattenBg, to: matteRaw, reason: '旧字段 flattenBg 改名为 matteColor' })
  }

  const params: ConvertParams = {
    longEdge: numP('longEdge', MIN_CANVAS_SIDE, MAX_CANVAS_SIDE, d.longEdge),
    downsample: enumP('downsample', ['average', 'nearest'] as const, d.downsample),
    cropRatio: enumP('cropRatio', ['free', '1:1', '4:3', '16:9'] as const, d.cropRatio),
    paletteMode: enumP('paletteMode', ['auto', 'preset', 'custom'] as const, d.paletteMode),
    paletteK: numP('paletteK', PALETTE_K_MIN, PALETTE_K_MAX, d.paletteK),
    presetPaletteId: (() => {
      const rawV = p.presetPaletteId
      if (typeof rawV === 'string' && rawV) return rawV
      if (rawV !== undefined) fixed.push({ key: 'presetPaletteId', from: rawV, to: d.presetPaletteId, reason: '不是非空字符串，回退默认' })
      return d.presetPaletteId
    })(),
    customPalette: paletteField(p.customPalette, 256),
    dither: enumP('dither', ['none', 'floyd', 'bayer'] as const, d.dither),
    ditherStrength: numP('ditherStrength', 0, 100, d.ditherStrength),
    cleanup: boolP('cleanup', d.cleanup),
    cleanupMinSize: numP('cleanupMinSize', CLEANUP_MIN_SIZE_MIN, CLEANUP_MIN_SIZE_MAX, d.cleanupMinSize),
    brightness: numP('brightness', -100, 100, 0),
    contrast: numP('contrast', -100, 100, 0),
    saturation: numP('saturation', -100, 100, 0),
    transparent,
    matteColor: hexField(matteRaw, d.matteColor),
  }

  // exactWidth/Height：给了就必须是正整数，否则两个一起丢弃（半给会让尺寸推导自相矛盾）
  const ew = p.exactWidth
  const eh = p.exactHeight
  const okW = typeof ew === 'number' && Number.isFinite(ew) && Math.floor(ew) >= 1
  const okH = typeof eh === 'number' && Number.isFinite(eh) && Math.floor(eh) >= 1
  if (okW && okH) {
    const w = Math.min(MAX_CANVAS_SIDE, Math.floor(ew))
    const h = Math.min(MAX_CANVAS_SIDE, Math.floor(eh))
    if (w !== ew) fixed.push({ key: 'exactWidth', from: ew, to: w, reason: `越界，夹到 1..${MAX_CANVAS_SIDE}` })
    if (h !== eh) fixed.push({ key: 'exactHeight', from: eh, to: h, reason: `越界，夹到 1..${MAX_CANVAS_SIDE}` })
    params.exactWidth = w
    params.exactHeight = h
  } else if (ew !== undefined || eh !== undefined) {
    fixed.push({ key: 'exactWidth/exactHeight', from: [ew, eh], to: null, reason: '两者必须同时为正整数，已忽略' })
  }
  if (p.lockPalette !== undefined) params.lockPalette = boolP('lockPalette', false)

  return { params, fixed }
}

/** 只取参数（不关心修正明细时的便捷入口） */
export function coerceParams(raw: unknown): ConvertParams {
  return sanitizeParams(raw).params
}

/** 编辑器偏好（工具/颜色/显示开关），持久化到 localStorage 与草稿 */
export interface EditorPrefs {
  tool: Tool
  primary: string
  bg: string
  showGrid: boolean
  showMag: boolean
  showPicker: boolean
  brushSize: number
  /** 当前绘制色是否为调色板的「透明色」（画笔/填充/形状/清选区都挖洞） */
  eraseToAlpha: boolean
}

export const DEFAULT_PREFS: EditorPrefs = {
  tool: 'pencil',
  primary: '#1a1a1a',
  bg: '#ffffff',
  showGrid: true,
  showMag: true,
  showPicker: false,
  brushSize: 1,
  eraseToAlpha: false,
}

export function sanitizePrefs(raw: unknown): EditorPrefs {
  const d = DEFAULT_PREFS
  if (!raw || typeof raw !== 'object') return { ...d }
  const p = raw as Record<string, unknown>
  // 旧版本有独立的橡皮工具（tool: 'eraser'）：迁移成「画笔 + 选中透明色」
  const wasEraser = p.tool === 'eraser'
  const tool = !wasEraser && typeof p.tool === 'string' && (TOOLS as readonly string[]).includes(p.tool) ? (p.tool as Tool) : 'pencil'
  return {
    tool,
    primary: hexField(p.primary, d.primary),
    bg: hexField(p.bg, d.bg),
    showGrid: bool(p.showGrid, d.showGrid),
    showMag: bool(p.showMag, d.showMag),
    showPicker: bool(p.showPicker, d.showPicker),
    brushSize: p.brushSize === 2 || p.brushSize === 3 ? p.brushSize : 1,
    eraseToAlpha: wasEraser ? true : bool(p.eraseToAlpha, d.eraseToAlpha),
  }
}
