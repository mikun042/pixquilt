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
/** 键控范围：全图同色 / 只键与四边连通的底色区域（后者保护主体内部同色像素） */
export type KeyMode = 'global' | 'border'

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
  /**
   * 自定义色板的**号色/编号**，与 `customPalette` 按下标一一对应（可缺省）。
   *
   * 为什么它必须进参数、而不能只当"导入时的临时值"：拼豆用户最在意的就是
   * **图纸上的编号与自己的色卡对不对得上**。`.hex` 一直支持 `编号 #rrggbb` 两列，
   * 但导入后号色**被直接丢掉**（只留 colors），于是图纸/清单/PDF 只能用自动编号 C1/C2…
   * ——用户的 S12/R01 根本印不出来。把它放进参数，四个入口（页内 API / CLI / Node 直调 /
   * 导出）就都能拿到，不必各自再想办法传。
   *
   * 约定：长度与 `customPalette` 对齐；缺项用空串（下游 `paletteCodes()` 会回退成 C1/C2…）。
   * 全空数组会被归一成 undefined（省得项目文件里留一堆空串）。
   */
  customPaletteCodes?: string[]
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
  /**
   * 键控范围：`global` 全图同色都透明；`border` 只键掉与四边连通的底色区域。
   * 白底 + 主体内部有白色高光时必须用 `border`，否则高光会被挖穿。
   */
  keyMode: KeyMode
  /** 键控颜色容差（0–255，三通道最大差）；AI 生图的白底是 254/255 噪声，需要 >0 */
  keyTolerance: number
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
  keyMode: 'global',
  keyTolerance: 0,
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
   * 见 docs/DEVELOPMENT.md §8 的 B1：先把单画布做扎实，多帧只占字段位，避免半成品 API 冻结。
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

/**
 * 号色数组的校验：**只做"是不是短字符串"这一层**，不校验语义（号色格式各品牌不同，
 * 有的是 `S12`、有的是 `B01`、有的带横线，收紧了反而挡住用户的真实色卡）。
 *
 * 三条关键处理：
 *  1. 非字符串项一律当空串（而不是丢弃）——**保下标对齐**：号色靠下标与颜色对应，
 *     中间丢一项会让后面全部错位（图纸上的编号整体串行，比没有编号更糟）。
 *  2. 截断到 `max`，与 `customPalette` 同一个上限。
 *  3. **全是空串时返回 undefined**：让"没有号色"和"号色都是空"是同一种形态，
 *     项目文件里就不会留一堆空串（导出侧的 JSON 也不至于变长）。
 */
function paletteCodesField(v: unknown, max = 256): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: string[] = []
  for (const c of v.slice(0, max)) {
    out.push(typeof c === 'string' ? c.trim() : '')
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  return out.some((c) => c !== '') ? out : undefined
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
    customPaletteCodes: paletteCodesField(p.customPaletteCodes, 256),
    dither: enumP('dither', ['none', 'floyd', 'bayer'] as const, d.dither),
    ditherStrength: numP('ditherStrength', 0, 100, d.ditherStrength),
    cleanup: boolP('cleanup', d.cleanup),
    cleanupMinSize: numP('cleanupMinSize', CLEANUP_MIN_SIZE_MIN, CLEANUP_MIN_SIZE_MAX, d.cleanupMinSize),
    brightness: numP('brightness', -100, 100, 0),
    contrast: numP('contrast', -100, 100, 0),
    saturation: numP('saturation', -100, 100, 0),
    transparent,
    matteColor: hexField(matteRaw, d.matteColor),
    keyMode: enumP('keyMode', ['global', 'border'] as const, d.keyMode),
    keyTolerance: numP('keyTolerance', 0, 255, d.keyTolerance),
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
