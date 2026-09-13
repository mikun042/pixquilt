/**
 * 页内自动化接口 `window.pixelArtStudio`（apiLevel 2）。
 *
 * 定位：**这是给 AI agent / 脚本用的产品接口，不是内部胶水**。因此有三条硬要求：
 *  1. **既有方法名/参数/返回形状保持稳定**（旧项目已有的点位逐字继承，老脚本不必改）；
 *  2. **只做校验与状态同步**，像素逻辑一律调用 core（这个文件不允许出现算法）；
 *  3. **自描述**：`describe()` / `describeOps()` / `describeParams()` / `validateParams()`
 *     让 agent 冷启动即可自省，不必猜文档（文档若与实现漂移，漂移会被测试抓住）。
 *
 * 与 CLI（tool/artc.mjs）的关系：两者都只是 core 的调用方，参数语义与算子表完全一致，
 * 因此"页内调好参数后交给 CLI 批量跑"是安全的。
 */
import { DEFAULT_PARAMS, STYLE_PRESETS, TOOLS, coerceParams, sanitizeParams, type ConvertParams, type PixelArt } from '../core/types.ts'
import { PALETTE_MAX, PRESETS, getPreset, isPresetId, serializeHexPalette } from '../core/palettes.ts'
import { applyOps, blankArt, type EditOp } from '../core/ops.ts'
import { runPipeline } from '../core/pipeline.ts'
import { artHash, decodePixBin, encodePixBin, layoutSheet, parseProjectFile, pixelJSONString, projectJSONString } from '../core/export.ts'
import { base64ToBytes, bytesToBase64 } from '../core/binary.ts'
import { artStats, countTransparent, countUsage } from '../core/stats.ts'
import { beadListCsv, beadReport, beadSvg } from '../core/bead.ts'
import { CAPABILITIES, OP_SPECS, PARAM_SPECS, describeAll } from '../core/spec.ts'

export interface AutomationDeps {
  getParams: () => ConvertParams
  setParams: (params: ConvertParams) => void
  getArt: () => PixelArt | null
  setArt: (art: PixelArt | null) => void
  getSource: () => { width: number; height: number; data: Uint8ClampedArray } | null
  setSource: (img: { width: number; height: number; data: Uint8ClampedArray } | null, name: string) => void
  regenerate: () => void
  /** 提交一次编辑（进撤销栈） */
  commit: (indices: Uint8Array, palette: string[], alphaMask: Uint8Array | null) => void
  undo: () => void
  redo: () => void
  toast: (msg: string, kind?: 'info' | 'warn' | 'error') => void
  exportPNG: (scale: number, opts?: { transparentBg?: boolean }) => string
  /** 把临时画布编码成 PNG dataURL（由平台层注入：浏览器走 canvas，Node 走 zlib），
   *  这样 core 的导出模块就不必依赖任何平台 API —— 浏览器包才不会被 node:zlib 拖住。 */
  pngDataURL: (art: PixelArt, scale: number, opts?: { transparentBg?: boolean; bgHex?: string }) => Promise<string>
  setPrefs: (patch: { tool?: string; primary?: string; bg?: string; brushSize?: number; transparent?: boolean }) => void
  getPrefs: () => { tool: string; primary: string; bg: string; brushSize: number; eraserToAlpha: boolean }
  importImage: (file: File) => Promise<void>
  decodeImage: (file: Blob & { name?: string }) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>
  makeThumbnail: (img: { width: number; height: number; data: Uint8ClampedArray }, maxSide?: number) => string
  blank: () => void
  applyOpsToArt: (ops: EditOp[]) => { art: PixelArt; changes: { op: string; kind?: string; cells: number; changed: boolean; note?: string }[]; applied: boolean } | null
}

export interface EditSummary {
  applied: boolean
  changes: { op: string; kind?: string; cells: number; changed: boolean; note?: string }[]
  width: number
  height: number
  paletteSize: number
  hasAlpha: boolean
  transparent: number
  usage: Record<string, number>
}

export function installAutomationApi(deps: AutomationDeps): void {
  const requireArt = (): PixelArt => {
    const art = deps.getArt()
    if (!art) throw new Error('还没有画布：请先 importImage() 或 newCanvas()')
    return art
  }
  const requireSource = () => {
    const src = deps.getSource()
    if (!src) throw new Error('还没有原图：请先 importImage()（newCanvas 之后没有原图，用 edit() 而不是 convert()）')
    return src
  }
  const summaryOf = (art: PixelArt, changed: EditSummary['changes'], applied: boolean): EditSummary => ({
    applied,
    changes: changed,
    width: art.width,
    height: art.height,
    paletteSize: art.palette.length,
    hasAlpha: !!(art.alphaMask && art.alphaMask.some((v) => v < 128)),
    transparent: countTransparent(art.indices, art.alphaMask),
    usage: countUsage(art.indices, art.palette, art.alphaMask),
  })

  const api = {
    /* ---------------------------------------------------------- 元信息 */
    version: CAPABILITIES.version,
    apiLevel: CAPABILITIES.apiLevel,
    /** 一次拿全能力与契约（agent 冷启动第一调用） */
    describe: (): Record<string, unknown> => describeAll(),
    describeOps: () => OP_SPECS.map((s) => ({ op: s.op, desc: s.desc, fields: s.fields, notes: s.notes ?? [] })),
    describeParams: () => PARAM_SPECS,
    capabilities: () => ({ ...CAPABILITIES }),
    /**
     * 干跑参数校验：**不落状态**，只告诉你哪些值会被夹紧/回退。
     * agent 改参前的预演入口（避免"传了 99999 却以为生效了"）。
     */
    validateParams: (patch: Partial<ConvertParams> = {}) => {
      const report = sanitizeParams({ ...deps.getParams(), ...patch })
      return { ok: report.fixed.length === 0, params: report.params, fixed: report.fixed }
    },

    /* ---------------------------------------------------------- 参数与转换 */
    /** 就绪信号：UI 初始化完成后 resolve（脚本开头调用一次） */
    whenReady: (): Promise<void> => Promise.resolve(),
    getParams: (): ConvertParams => ({ ...deps.getParams() }),
    setParams: (patch: Partial<ConvertParams>): ConvertParams => {
      const next = coerceParams({ ...deps.getParams(), ...patch })
      deps.setParams(next)
      // 有原图就立即重转：脚本在**同一次调用内**紧接着读 getInfo/exportPNG 必须拿到新结果
      if (deps.getSource()) deps.regenerate()
      return { ...deps.getParams() }
    },
    applyStylePreset: (id: string): ConvertParams | null => {
      const preset = STYLE_PRESETS.find((s) => s.id === id)
      if (!preset) return null
      const next = coerceParams({ ...deps.getParams(), ...preset.params })
      deps.setParams(next)
      if (deps.getSource()) deps.regenerate()
      return { ...deps.getParams() }
    },
    /** 只读查询风格预设（批处理据此拼出完整参数，结果与工作台当前状态无关） */
    stylePreset: (id: string): Partial<ConvertParams> | null => {
      const preset = STYLE_PRESETS.find((s) => s.id === id)
      return preset ? { ...preset.params } : null
    },
    defaultParams: (): ConvertParams => ({ ...DEFAULT_PARAMS }),
    presetPalettes: () => PRESETS.map((p) => ({ id: p.id, name: p.name, desc: p.desc, colors: [...p.colors] })),
    /** 通过 URL / dataURL / File 导入并转换 */
    importImage: async (src: File | Blob | string): Promise<{ name: string; width: number; height: number }> => {
      const file = await toFile(src)
      await deps.importImage(file)
      const image = deps.getSource()
      if (!image) throw new Error('图片导入失败（格式不支持或解码失败）')
      return { name: file.name, width: image.width, height: image.height }
    },
    convert: (): { width: number; height: number; paletteSize: number } => {
      const src = requireSource()
      const { art } = runPipeline(src, deps.getParams())
      deps.setArt(art)
      deps.regenerate()
      return { width: art.width, height: art.height, paletteSize: art.palette.length }
    },
    /** 清空工作区（不弹确认）：批量逐张处理的安全起点 */
    reset: (): void => {
      deps.setArt(null)
      deps.setSource(null, '')
    },

    /* ---------------------------------------------------------- 读取 */
    getInfo: () => {
      const art = deps.getArt()
      const src = deps.getSource()
      const prefs = deps.getPrefs()
      const stats = art ? artStats(art) : null
      return {
        hasImage: !!src,
        imageWidth: src?.width ?? 0,
        imageHeight: src?.height ?? 0,
        hasArt: !!art,
        width: art?.width ?? 0,
        height: art?.height ?? 0,
        paletteSize: art?.palette.length ?? 0,
        hasAlpha: !!(art?.alphaMask && art.alphaMask.some((v) => v < 128)),
        transparent: stats?.transparent ?? 0,
        hasEdits: false as boolean,
        tool: prefs.tool,
        primary: prefs.primary,
        bg: prefs.bg,
        brushSize: prefs.brushSize,
        eraserToAlpha: prefs.eraserToAlpha,
        params: { ...deps.getParams() },
      }
    },
    getPalette: (): string[] => [...requireArt().palette],
    getUsage: (): Record<string, number> => {
      const art = requireArt()
      return countUsage(art.indices, art.palette, art.alphaMask)
    },
    hasAlpha: (): boolean => {
      const art = requireArt()
      return !!art.alphaMask && art.alphaMask.some((v) => v < 128)
    },
    countTransparent: (): number => {
      const art = requireArt()
      return countTransparent(art.indices, art.alphaMask)
    },
    /** 画布指纹：跨运行比对（同图同参应得到同一个值） */
    artHash: (): string => artHash(requireArt()),

    /* ---------------------------------------------------------- 导出（返回字符串/字节，不触发下载） */
    exportPNG: (scale = 1, opts?: { transparentBg?: boolean }): string => {
      requireArt()
      return deps.exportPNG(scale, opts)
    },
    exportPaletteHex: (): string => {
      const art = requireArt()
      return serializeHexPalette(art.palette)
    },
    exportPixelJSON: (): string => pixelJSONString(requireArt()),
    exportProject: (): string => projectJSONString(requireArt(), deps.getParams()),
    /** 二进制像素数据（大画布往返比 base64 快一个量级）；第三个参数给出色板以便回读 */
    exportPixBin: (): string => {
      const art = requireArt()
      return bytesToBase64(encodePixBin(art))
    },
    importPixBin: (base64: string, palette?: string[]): EditSummary => {
      const art = decodePixBin(base64ToBytes(base64), palette ?? requireArt().palette)
      deps.setArt(art)
      return summaryOf(art, [], true)
    },
    loadProject: (json: string): { width: number; height: number; paletteSize: number } => {
      const parsed = parseProjectFile(json)
      deps.setParams(parsed.params)
      deps.setArt(parsed.art)
      return { width: parsed.art.width, height: parsed.art.height, paletteSize: parsed.art.palette.length }
    },

    /* ---------------------------------------------------------- 后台编辑（声明式算子） */
    edit: (ops: EditOp[]): EditSummary => {
      const art = requireArt()
      const params = deps.getParams()
      const r = applyOps(art, ops, { fallbackColor: deps.getPrefs().primary, allowApproxColor: !params.lockPalette })
      if (r.applied) deps.commit(r.art.indices, r.art.palette, r.art.alphaMask ?? null)
      return summaryOf(r.art, r.changes, r.applied)
    },
    undo: (): void => deps.undo(),
    redo: (): void => deps.redo(),
    /** 新建空白画布（不必先有原图）；transparent 则整幅透明 */
    newCanvas: (opts: { width: number; height: number; color?: string; transparent?: boolean }): EditSummary => {
      const art = blankArt(opts.width, opts.height, opts.color ?? '#000000', !!opts.transparent)
      deps.setSource(null, '')
      deps.setArt(art)
      return summaryOf(art, [], true)
    },

    /**
     * 一站式（**无副作用**）：解码 → 管线 → 可选算子 → 返回 PNG/JSON/用量。
     * 批处理主入口：不碰当前画布、撤销栈与偏好，因此可以并行/连续调用。
     */
    render: async (
      src: File | Blob | string,
      params?: Partial<ConvertParams>,
      scale = 1,
      opts?: { transparentBg?: boolean; ops?: EditOp[] },
    ): Promise<{
      width: number
      height: number
      palette: string[]
      usage: Record<string, number>
      transparent: number
      png: string
      pixelJSON: string
      paletteHex: string
      hash: string
    }> => {
      const file = await toFile(src)
      const image = await deps.decodeImage(file)
      const p = coerceParams({ ...DEFAULT_PARAMS, ...(params ?? {}) })
      const { art: base } = runPipeline(image, p)
      // 无副作用路径**不继承主色**：绘画类算子必须显式给 color，结果才与工作区状态无关
      const art = opts?.ops?.length ? applyOps(base, opts.ops, { allowApproxColor: !p.lockPalette }).art : base
      const pngOpts = { transparentBg: opts?.transparentBg, bgHex: p.matteColor }
      return {
        width: art.width,
        height: art.height,
        palette: [...art.palette],
        usage: countUsage(art.indices, art.palette, art.alphaMask),
        transparent: countTransparent(art.indices, art.alphaMask),
        png: await deps.pngDataURL(art, scale, pngOpts),
        pixelJSON: pixelJSONString(art),
        paletteHex: serializeHexPalette(art.palette),
        hash: artHash(art),
      }
    },

    /* ---------------------------------------------------------- 拼豆与游戏资产（本项目的两个主要用途） */
    /** 拼豆用量报告：号色 / 格数 / 珠数 / 重量 / 袋数 / 分板 */
    beadReport: (opts: { codes?: string[]; beadMm?: number; beadGram?: number; boardCells?: number } = {}) => {
      const art = requireArt()
      const preset = getPreset(deps.getParams().presetPaletteId)
      return beadReport(art, { codes: opts.codes ?? preset?.codes, ...opts })
    },
    /** 拼豆图纸 SVG（可打印/可缩放） */
    exportBeadSvg: (opts: Record<string, unknown> = {}): string => {
      const art = requireArt()
      const preset = getPreset(deps.getParams().presetPaletteId)
      return beadSvg(art, { codes: preset?.codes, ...opts })
    },
    /** 缺口清单 CSV（照着买） */
    exportBeadCsv: (opts: Record<string, unknown> = {}): string => {
      const art = requireArt()
      const preset = getPreset(deps.getParams().presetPaletteId)
      return beadListCsv(art, { codes: preset?.codes, ...opts })
    },
    /** 图集坐标表：帧等尺寸 + offsetX/offsetY（引擎侧直接用），不渲染像素 */
    layoutSheet: (frames: { name: string; width: number; height: number }[], columns = 0, padding = 0) =>
      layoutSheet(frames, columns, padding),

    /* ---------------------------------------------------------- 编辑器状态写入 */
    setTool: (tool: string): string => {
      if (!(TOOLS as readonly string[]).includes(tool)) throw new Error(`未知工具：${tool}（可选 ${TOOLS.join(' / ')}）`)
      deps.setPrefs({ tool })
      return tool
    },
    setPrimary: (hex: string): string => {
      const norm = coerceHex(hex, '主色')
      deps.setPrefs({ primary: norm, transparent: false })
      return norm
    },
    setBg: (hex: string): string => {
      const norm = coerceHex(hex, '背景色')
      deps.setPrefs({ bg: norm })
      return norm
    },
    setBrushSize: (size: number): number => {
      const v = Math.max(1, Math.min(3, Math.floor(Number(size)) || 1))
      deps.setPrefs({ brushSize: v })
      return v
    },
    setEraseToAlpha: (on: boolean): boolean => {
      deps.setPrefs({ transparent: !!on })
      return !!on
    },
    setLockPalette: (on: boolean): boolean => {
      const next = coerceParams({ ...deps.getParams(), lockPalette: !!on })
      deps.setParams(next)
      return !!next.lockPalette
    },
    /** 主/背景色交换（与 Tab 键、⇄ 按钮同一行为） */
    swapColors: (): { primary: string; bg: string } => {
      const p = deps.getPrefs()
      deps.setPrefs({ primary: p.bg, bg: p.primary })
      return { primary: p.bg, bg: p.primary }
    },
    /** 缩略图（dataURL）：给外部工具做预览列表 */
    thumbnail: (maxSide = 160): string => {
      const src = deps.getSource()
      if (!src) throw new Error('还没有原图')
      return deps.makeThumbnail(src, maxSide)
    },
  }

  ;(window as unknown as { pixelArtStudio?: unknown }).pixelArtStudio = api
}

/** 图集布局与色板常量转发：让 UI/文档从同一处读取，避免各写一遍 */
function coerceHex(hex: string, what: string): string {
  const m = String(hex).trim().match(/^#?([0-9a-fA-F]{6})$/)
  if (!m) throw new Error(`${what}格式不对：${hex}（应为 #rrggbb）`)
  return `#${m[1].toLowerCase()}`
}

async function toFile(src: File | Blob | string): Promise<File> {
  if (typeof src !== 'string') {
    if (src instanceof File) return src
    return new File([src], 'input.png', { type: src.type || 'image/png' })
  }
  if (src.startsWith('data:') || src.startsWith('blob:')) {
    const res = await fetch(src)
    const blob = await res.blob()
    return new File([blob], 'input.png', { type: blob.type || 'image/png' })
  }
  const res = await fetch(src)
  if (!res.ok) throw new Error(`图片下载失败（HTTP ${res.status}）：${src}`)
  const blob = await res.blob()
  const name = src.split('/').pop()?.split('?')[0] || 'input.png'
  return new File([blob], name, { type: blob.type || 'image/png' })
}

/** 常量转发：让 UI/文档能从同一处读到上限（避免各写一遍） */
export const LIMITS = { paletteMax: PALETTE_MAX, presetIds: PRESETS.map((p) => p.id), isPresetId }
