/**
 * 预置色卡 + .hex 解析/序列化。
 *
 * ## 三类来源，必须分清（`PaletteSource`）
 *
 * | 来源 | 是什么 | 例 |
 * |---|---|---|
 * | `official` | **厂商/规范公开的色表**，色号与颜色是权威的 | PICO-8 / GameBoy / NES / CGA |
 * | `community` | **社区整理**的品牌拼豆色卡，有据可查但不保证与实物零偏差 | Hama / Perler / Artkal / Nabbi / Yant |
 * | `approximate` | **我们自造的通用近似色**，只为让图纸有稳定号色 | beads16 / beads24 |
 *
 * 为什么要把这三类拆开而不是一个 `official: boolean`：
 * "官方"与"社区整理"在语义上差得很远（前者可直接引用，后者要以实物为准），
 * 而"自造近似色"更不是同一回事。合成一个布尔值后，前两者都只能标 false，
 * 界面与文档就没法给出正确的措辞。三值枚举也让断言能双向锁住每一类。
 *
 * 用户自己的色卡走 `.hex` 导入（支持 `#rrggbb` 每行一个，或 `编号 #rrggbb` 两列带号色），
 * 那条路不受这里限制，任意品牌任意色数。
 */
import { PALETTE_MAX } from './limits.ts'
import { normalizeHex } from './types.ts'
import { BEAD_BRAND_PALETTES } from './palettes-beads.ts'

export { PALETTE_MAX }

/**
 * 色卡的来源类别。见文件头表格。
 *
 * 用字面量联合而不是 enum：项目里 `ConvertParams` 的枚举字段全是这个风格，
 * 且 `capabilities()` 要把它序列化进 `--describe` 的 JSON（字符串更直白）。
 */
export type PaletteSource = 'official' | 'community' | 'approximate'

export function dedupePalette(colors: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of colors) {
    if (!seen.has(c)) {
      seen.add(c)
      out.push(c)
    }
  }
  return out
}

export interface PalettePreset {
  id: string
  name: string
  /** 一句话说明（UI 下拉与 describe() 共用） */
  desc: string
  colors: string[]
  /** 拼豆号色：与 colors 等长，供图纸标注与清单使用 */
  codes?: string[]
  /**
   * 来源类别（见文件头表格）。**必填**——正是靠它必填，漏标的新卡才会在 tsc 阶段就报错，
   * 而不是悄悄混进去当"官方"用。
   */
  source: PaletteSource
}

/** PICO-8 官方 16 色 */
const PICO8 = ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8', '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa']

/** GameBoy DMG 四绿 */
const GAMEBOY = ['#0f380f', '#306230', '#8bac0f', '#9bbc0f']

/** CGA 16 色 */
const CGA = ['#000000', '#0000aa', '#00aa00', '#00aaaa', '#aa0000', '#aa00aa', '#aa5500', '#aaaaaa', '#555555', '#5555ff', '#55ff55', '#55ffff', '#ff5555', '#ff55ff', '#ffff55', '#ffffff']

/** NES 2C02 常用色表（去重后 55 色） */
const NES = [
  '#7c7c7c', '#0000fc', '#0000bc', '#4428bc', '#940084', '#a80020', '#a81000', '#881400', '#503000', '#007800', '#006800', '#005800', '#004058', '#000000', '#bcbcbc', '#0078f8',
  '#0058f8', '#6844fc', '#d800cc', '#e40058', '#f83800', '#e45c10', '#ac7c00', '#00b800', '#00a800', '#00a844', '#008888', '#f8f8f8', '#3cbcfc', '#6888fc', '#9878f8', '#f878f8',
  '#f85898', '#f87858', '#fca044', '#f8b800', '#b8f818', '#58d854', '#58f898', '#00e8d8', '#787878', '#fcfcfc', '#a4e4fc', '#b8b8f8', '#d8b8f8', '#f8b8f8', '#f8a4c0', '#f0d0b0',
  '#fce0a8', '#f8d878', '#d8f878', '#b8f8b8', '#b8f8d8', '#00fcfc', '#f8d8f8',
]

/** 拼豆 16 色常用近似色（通用配色，非某品牌官方色卡） */
const BEADS16 = ['#ffffff', '#000000', '#8c8c8c', '#d9d9d9', '#e02020', '#f28c28', '#f2d024', '#3fa34d', '#0f7a4a', '#2a6fd6', '#7ec8f2', '#6b3fa0', '#f2a0c0', '#8b5a2b', '#f7e0b5', '#4a4a4a']
const BEADS16_CODES = ['B01', 'B02', 'B03', 'B04', 'R01', 'O01', 'Y01', 'G01', 'G02', 'U01', 'U02', 'P01', 'K01', 'N01', 'N02', 'B05']

/** 拼豆 24 色常用近似色（在 16 色基础上补中间色，减少大面积量化误差） */
const BEADS24 = [
  '#ffffff', '#f2f2f2', '#c9c9c9', '#8c8c8c', '#4a4a4a', '#000000',
  '#f7c5c5', '#e02020', '#9e1b1b', '#f28c28', '#a85a12', '#f2d024',
  '#c9d94a', '#3fa34d', '#0f7a4a', '#7ec8f2', '#2a6fd6', '#1b3f8b',
  '#c9a0f2', '#6b3fa0', '#f2a0c0', '#8b5a2b', '#f7e0b5', '#5a3b1a',
]
const BEADS24_CODES = [
  'B01', 'B02', 'B03', 'B04', 'B05', 'B06',
  'P02', 'R01', 'R02', 'O01', 'N03', 'Y01',
  'Y02', 'G01', 'G02', 'U02', 'U01', 'U03',
  'P03', 'P01', 'K01', 'N01', 'N02', 'N04',
]

export const PRESETS: PalettePreset[] = [
  // ---- 官方硬件色表 ----
  { id: 'pico8', name: 'PICO-8 (16色)', desc: '幻想主机 16 色，像素游戏最通用的一套', colors: PICO8, source: 'official' },
  { id: 'gameboy', name: 'GameBoy (4色)', desc: 'DMG 四绿，配合 Bayer 抖动出复古掌机感', colors: GAMEBOY, source: 'official' },
  { id: 'nes', name: 'NES 主机 (55色)', desc: '2C02 色表，硬边像素风', colors: NES, source: 'official' },
  { id: 'cga', name: 'CGA (16色)', desc: '早期 PC 十六色，怀旧配色', colors: CGA, source: 'official' },

  // ---- 通用近似色（自造，与品牌无关） ----
  { id: 'beads16', name: '拼豆 16 色（近似）', desc: '通用近似配色，不属任何品牌；带号色，可出图纸与缺口清单', colors: BEADS16, codes: BEADS16_CODES, source: 'approximate' },
  { id: 'beads24', name: '拼豆 24 色（近似）', desc: '在 16 色基础上补中间色，不属任何品牌', colors: BEADS24, codes: BEADS24_CODES, source: 'approximate' },

  /*
   * ---- 品牌拼豆色卡（社区整理）----
   *
   * 数据由 `tool/bead-palettes.mjs` 从 maxcleme/beadcolors（MIT）生成，
   * 统一标 `source: 'community'`：**有据可查、但不保证与实物零偏差**，
   * 界面与文档都要写明"以实物为准"。见 `palettes-beads.ts` 的文件头。
   *
   * 为什么用 `.map` 而不是把 13 条手写在这里：量太大（1340 色）且是生成物，
   * 手抄一遍就多一份会漂移的副本。`source` 在这里统一加上——
   * 生成文件只负责"颜色 + 号色 + 名字"，不该知道业务语义。
   */
  ...BEAD_BRAND_PALETTES.map((b) => ({
    id: b.id,
    name: `${b.name}（${b.colors.length}色）`,
    desc: `${b.desc}· 社区整理色卡，以实物为准`,
    colors: b.colors,
    codes: b.codes,
    source: 'community' as const,
  })),
]

export function getPreset(id: string): PalettePreset | null {
  return PRESETS.find((p) => p.id === id) ?? null
}

/** 预置列表里是否有该 id（CLI 与 API 的参数校验用） */
export function isPresetId(id: string): boolean {
  return PRESETS.some((p) => p.id === id)
}

export interface ParsedHexPalette {
  colors: string[]
  /** 与 colors 等长的号色（来源没有号色时为 undefined） */
  codes?: string[]
  /** 无法解析的行数（用于如实报告而不是静默丢弃） */
  skipped: number
  /** 因为超过 256 色被截掉的数量 */
  truncated: number
}

/**
 * 解析色板文本。支持两种行式：
 *   1) `#rrggbb`（Lospec 风格，每行一个）
 *   2) `S12 #ff8800` 或 `S12,ff8800`（带号色，拼豆图纸需要）
 * 忽略空行与 `//` 注释行；非法行计入 skipped 而不是抛错（用户手上的色卡常带噪声）。
 */
export function parseHexPalette(text: string): ParsedHexPalette {
  const colors: string[] = []
  const codes: string[] = []
  let hasCode = false
  let skipped = 0

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('//')) continue
    // 一行里可能有 "编号 颜色" 或 "颜色 编号"
    const tokens = line.split(/[\s,;\t]+/).filter(Boolean)
    let hex: string | null = null
    let code: string | null = null
    for (const t of tokens) {
      const n = normalizeHex(t)
      if (n) {
        if (!hex) hex = n
      } else if (!code) {
        // 号色只接受短标识（避免把一句话当编号）
        const cleaned = t.replace(/[#;]/g, '')
        if (cleaned.length <= 12) code = cleaned
      }
    }
    if (!hex) {
      skipped++
      continue
    }
    colors.push(hex)
    codes.push(code ?? '')
    if (code) hasCode = true
  }

  const deduped: string[] = []
  const dedupedCodes: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < colors.length; i++) {
    const key = colors[i]
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(key)
    dedupedCodes.push(codes[i] ?? '')
  }

  return {
    colors: deduped.slice(0, PALETTE_MAX),
    codes: hasCode ? dedupedCodes.slice(0, PALETTE_MAX) : undefined,
    skipped,
    truncated: Math.max(0, deduped.length - PALETTE_MAX),
  }
}

/** 序列化为 .hex：有号色时写成 "编号 颜色" 两列，便于往返导入 */
export function serializeHexPalette(colors: string[], codes?: string[]): string {
  const useCodes = codes && codes.some(Boolean)
  const lines = colors.map((c, i) => {
    const hex = c.replace('#', '').toUpperCase()
    return useCodes ? `${(codes?.[i] ?? '').trim() || `C${i + 1}`} ${hex}` : hex
  })
  return lines.join('\n') + '\n'
}

/** 取号色（没有号色时退回 C1、C2…，保证图纸与清单永远有"编号"可读） */
export function paletteCodes(colors: string[], codes?: string[]): string[] {
  return colors.map((_, i) => (codes?.[i] ?? '').trim() || `C${i + 1}`)
}

/**
 * 按当前参数解析出"这次导出该用哪套号色"，**唯一出处**。
 *
 * 为什么要集中一处：导出链路上有 6 个地方要用号色（图纸 SVG、缺口清单 CSV、
 * 用量报告、打印 PDF、`.hex`、页内 API 的三个导出方法），而它们原先各自写着
 * `getPreset(params.presetPaletteId)?.codes`——那行只认**内建预置卡**，
 * 于是用户导入自己的 `.hex`（带号色）后，号色在导入那一步就被丢掉了，
 * 图纸上印的还是自动编号 C1/C2…（拼豆用户最在意的事）。
 *
 * 现在的规则，与 `resolvePalette()` 选色板的规则严格对应：
 *  - `preset` 档 → 用预置卡自带的 codes
 *  - `custom` 档 → 用参数里存的 customPaletteCodes（本次新增）
 *  - 其余（auto）→ 无号色，交给 `paletteCodes()` 回退成 C1/C2…
 */
export function codesForParams(params: {
  paletteMode: string
  presetPaletteId: string
  customPaletteCodes?: string[]
}): string[] | undefined {
  if (params.paletteMode === 'preset') return getPreset(params.presetPaletteId)?.codes
  if (params.paletteMode === 'custom') return params.customPaletteCodes
  return undefined
}
