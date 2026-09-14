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
import { PRESETS, getPreset, serializeHexPalette } from '../core/palettes.ts'
import { applyOps, blankArt, type EditOp } from '../core/ops.ts'
import { runPipeline } from '../core/pipeline.ts'
import { artHash, decodePixBin, encodePixBin, layoutSheet, parseProjectFile, pixelJSONString, projectJSONString } from '../core/export.ts'
import { base64ToBytes, bytesToBase64 } from '../core/binary.ts'
import { artStats, countTransparent, countUsage, hasRealAlpha } from '../core/stats.ts'
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
  /**
   * 提交一次**模型发起**的编辑（进撤销栈）：入参是整份新画布。
   *
   * 必须是整份 `PixelArt` 而不是"只有像素"的三个数组：算子里的 `transform`/`trim` 会改尺寸，
   * 而且画布层需要被回灌一次（它自己那份像素副本是旧的）。见 `edit()` 的注释与
   * docs/ARCHITECTURE.md §8.10 ⑥。
   */
  commitArt: (art: PixelArt) => void
  undo: () => void
  redo: () => void
  toast: (msg: string, kind?: 'info' | 'warn' | 'error') => void
  /** 导出当前画布为 PNG dataURL。键控透明需要同时给出键控色：bgHex 缺省时由注入方补 matteColor */
  exportPNG: (scale: number, opts?: { transparentBg?: boolean; bgHex?: string }) => string
  /** 把临时画布编码成 PNG dataURL（由平台层注入：浏览器走 canvas，Node 走 zlib），
   *  这样 core 的导出模块就不必依赖任何平台 API —— 浏览器包才不会被 node:zlib 拖住。 */
  pngDataURL: (art: PixelArt, scale: number, opts?: { transparentBg?: boolean; bgHex?: string }) => Promise<string>
  setPrefs: (patch: { tool?: string; primary?: string; bg?: string; brushSize?: number; transparent?: boolean }) => void
  getPrefs: () => { tool: string; primary: string; bg: string; brushSize: number; eraserToAlpha: boolean }
  importImage: (file: File) => Promise<void>
  decodeImage: (file: Blob & { name?: string }) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>
  makeThumbnail: (img: { width: number; height: number; data: Uint8ClampedArray }, maxSide?: number) => string
  /**
   * 画布是否有手动编辑（相对最近一次自动转换）。
   * 原先这个字段在 getInfo() 里写死 `false`，导致"编辑后仍报 hasEdits:false"，
   * 是**主动误导**——脚本会据此以为画布是纯转换结果。改由 UI 的 store 提供真值。
   */
  hasEdits: () => boolean
  /** 清空「有手动编辑」标记：newCanvas 产出的是新基线，不应延续上一张画布的标记 */
  resetEdits: () => void
  /**
   * 「从 params 推导空白画布」（尺寸 + 底色），UI 的 makeBlank 与 API 的 newCanvas 共用。
   *
   * 此前 `blank: () => void` 只声明与注入、**全文件 0 次调用**，而 UI 的 makeBlank 与 API 的
   * newCanvas 各有一套尺寸/底色推导规则（一方用 matteColor、一方默认 #000000），
   * 行为已经分叉。现在统一成本函数。
   */
  blankSpec: () => { width: number; height: number; color: string; transparent: boolean }
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
    hasAlpha: hasRealAlpha(art.alphaMask),
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
        hasAlpha: hasRealAlpha(art?.alphaMask),
        transparent: stats?.transparent ?? 0,
        // 真值来自 UI 的 store（最近一次自动转换之后是否有手动编辑），不再写死 false
        hasEdits: deps.hasEdits(),
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
      return hasRealAlpha(art.alphaMask)
    },
    countTransparent: (): number => {
      const art = requireArt()
      return countTransparent(art.indices, art.alphaMask)
    },
    /** 画布指纹：跨运行比对（同图同参应得到同一个值） */
    artHash: (): string => artHash(requireArt()),

    /* ---------------------------------------------------------- 导出（返回字符串/字节，不触发下载） */
    exportPNG: (scale = 1, opts?: { transparentBg?: boolean; bgHex?: string }): string => {
      requireArt()
      // 键控（transparentBg）必须配合键控色才有意义：core/raster.ts 里 keyOut 需要两者同时具备。
      // 原先只透传 transparentBg，导致"按文档调用 API 却拿到不透明的图"——这里补上 matteColor 兜底。
      const merged = opts?.transparentBg ? { ...opts, bgHex: opts.bgHex ?? deps.getParams().matteColor } : opts
      return deps.exportPNG(scale, merged)
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
      /*
       * 走 `commitArt`（整份画布）而不是画布那条"只交像素"的提交回调：这里的新画布是**外部算出来的**，
       * 画布里的像素副本还是旧的，必须由模型层回灌一次，否则屏幕不更新、并且下一次画笔会拿旧副本
       * 把这次编辑覆盖掉。顺带把宽高一起交出去——`transform`/`trim` 会改尺寸，只交 indices 会丢尺寸。
       */
      if (r.applied) deps.commitArt(r.art)
      return summaryOf(r.art, r.changes, r.applied)
    },
    undo: (): void => deps.undo(),
    redo: (): void => deps.redo(),
    /** 新建空白画布（不必先有原图）；transparent 则整幅透明 */
    newCanvas: (opts: { width: number; height: number; color?: string; transparent?: boolean }): EditSummary => {
      // 尺寸必填（脚本要精确控制），底色/透明缺省时与 UI「新建空白画布」保持一致：
      // 底色的默认值来自参数里的 matteColor（而不是写死 #000000），避免两处行为分叉。
      const spec = deps.blankSpec()
      const art = blankArt(
        opts.width,
        opts.height,
        opts.color ?? spec.color,
        opts.transparent === undefined ? spec.transparent : !!opts.transparent,
      )
      deps.setSource(null, '')
      deps.setArt(art)
      // 新画布 = 新基线：编辑标记归零，否则 getInfo().hasEdits 会延续上一张画布的状态
      deps.resetEdits()
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

    /**
     * 一站式空白画布（**无副作用**）：建画布 → 跑算子 → 导出，不碰工作台状态与草稿。
     *
     * **这个方法此前只有文档、没有实现**（`core/ops.ts`、`core/spec.ts` 的注释与生成的
     * `AGENT_API.md` 都在提它，但 `automation.ts` 里 0 处定义）——agent 按文档调用会直接
     * `is not a function`。语法与参数以文档为准，这里把它补齐（CLI 的 `--blank` 走的就是同一套
     * `blankArt + applyOps`）。
     */
    renderBlank: async (
      opts: { width: number; height: number; color?: string; transparent?: boolean; ops?: EditOp[] },
      params?: Partial<ConvertParams>,
      scale = 1,
      exp?: { transparentBg?: boolean; ops?: unknown },
    ): Promise<{
      width: number
      height: number
      palette: string[]
      usage: Record<string, number>
      transparent: number
      changes: { op: string; cells: number }[]
      png: string
      pixelJSON: string
      paletteHex: string
      hash: string
    }> => {
      // renderBlank 的 ops 在**第 1 个参数**里，而 render 的 ops 在第 4 个——两者返回值形状却一样，
      // 于是照 render 的样子调用会把算子静默丢掉：调用方拿到一张干净画布，还以为算子生效了。
      // 这与"未知参数静默忽略"是同一类失败，必须点名报错而不是忍着。
      if (exp && 'ops' in exp) {
        throw new Error(
          'renderBlank 的 ops 要放在第 1 个参数里（例如 renderBlank({ width, height, ops })），' +
            '不是第 4 个——那是 render(src, params, scale, { ops }) 的写法。' +
            '放在第 4 个会被静默忽略，所以这里直接报错。',
        )
      }
      const p = coerceParams({ ...DEFAULT_PARAMS, ...(params ?? {}) })
      const base = blankArt(opts.width, opts.height, opts.color ?? '#000000', !!opts.transparent)
      // 无副作用路径**不继承主色**：绘画类算子必须显式给 color，结果才与工作区状态无关
      const r = opts.ops?.length ? applyOps(base, opts.ops, { allowApproxColor: !p.lockPalette }) : null
      const art = r ? r.art : base
      const png = await deps.pngDataURL(art, scale, { transparentBg: exp?.transparentBg, bgHex: p.matteColor })
      return {
        width: art.width,
        height: art.height,
        palette: [...art.palette],
        usage: countUsage(art.indices, art.palette, art.alphaMask),
        transparent: countTransparent(art.indices, art.alphaMask),
        changes: r ? r.changes.map((c) => ({ op: c.op, cells: c.cells })) : [],
        png,
        pixelJSON: pixelJSONString(art),
        paletteHex: serializeHexPalette(art.palette),
        hash: artHash(art),
      }
    },

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
