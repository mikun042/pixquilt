/**
 * 像素画工作台 · 界面入口
 *
 * 这一层只做三件事：**装配 UI、把用户动作翻译成 core 调用、把 core 结果写回界面**。
 * 算法一律在 src/core，页内 API 在 src/app/automation.ts；这里不实现任何像素逻辑。
 *
 * 模式（重构计划 §16.2）：
 *   photo  图片→像素：自由尺寸与自动取色
 *   beads  拼豆图纸：固定号色板 + 锁色板 + 出图纸/清单
 *   asset  游戏资产：精确尺寸 + 锚点 + 图集/引擎元数据
 */
import { DEFAULT_PARAMS, DEFAULT_PREFS, STYLE_PRESETS, TOOLS, sanitizePrefs, type ConvertParams, type EditorPrefs, type PixelArt } from '../core/types.ts'
import { PRESETS, getPreset } from '../core/palettes.ts'
import { EXPORT_SCALES } from '../core/limits.ts'
import { pixelJSONString, projectJSONString, safeFileBase } from '../core/export.ts'
import { artToPngBlob, artToPngDataURL, artToPngDataURLSync } from './canvas-png.ts'
import { runPipeline } from '../core/pipeline.ts'
import { applyOps, blankArt } from '../core/ops.ts'
import { artStats } from '../core/stats.ts'
import { beadListCsv, beadReport, beadSvg } from '../core/bead.ts'
import { colorTextOn } from '../core/color.ts'
import { clear, el, store } from './store.ts'
import { decodeToRgba, imageFromClipboard, makeThumbnail, looksLikeImage } from './decode.ts'
import { createCanvas } from './ui/canvas.ts'
import { createColorPicker, type ColorPickerApi } from './ui/colorpicker.ts'
import { installAutomationApi } from './automation.ts'

const MODE_PRESETS: Record<string, Partial<ConvertParams>> = {
  photo: {},
  beads: { paletteMode: 'preset', presetPaletteId: 'beads16', lockPalette: true, dither: 'none', longEdge: 58, transparent: 'none' },
  asset: { paletteMode: 'preset', presetPaletteId: 'pico8', exactWidth: 32, exactHeight: 32, transparent: 'alpha', downsample: 'nearest' },
}

interface AppState {
  params: ConvertParams
  art: PixelArt | null
  source: { width: number; height: number; data: Uint8ClampedArray } | null
  sourceName: string
  refImage: HTMLImageElement | null
}

const app: AppState = {
  params: { ...DEFAULT_PARAMS },
  art: null,
  source: null,
  sourceName: '',
  refImage: null,
}

/**
 * 撤销栈：存 `PixelArt` 快照（索引是 Uint8Array，浅拷贝即可）。
 * 上限 50 步 + 由 core/limits 的常量约束；全不透明的 alphaMask 在提交前已被 core 归一为 null，
 * 因此这里不必再处理"空 mask 占内存"的问题。
 */
const history = { past: [] as PixelArt[], future: [] as PixelArt[] }

function resetHistory(): void {
  history.past = []
  history.future = []
}

/** 一次编辑的提交入口（UI 绘制与自动化接口共用）：进撤销栈后写回并重绘 */
function commitWithHistory(indices: Uint8Array, palette: string[], alphaMask: Uint8Array | null): void {
  if (!app.art) return
  history.past.push(app.art)
  if (history.past.length > 50) history.past.shift()
  history.future = []
  app.art = { ...app.art, indices, palette, alphaMask }
  store.set('hasEdits', true)
  renderAll()
}

function undo(): void {
  const prev = history.past.pop()
  if (!prev || !app.art) return
  history.future.push(app.art)
  app.art = prev
  resetCanvasTo(prev)
}

function redo(): void {
  const next = history.future.pop()
  if (!next || !app.art) return
  history.past.push(app.art)
  app.art = next
  resetCanvasTo(next)
}

function resetCanvasTo(art: PixelArt): void {
  canvasApi.setArt(art)
  store.set('hasEdits', history.past.length > 0)
  renderAll()
}

/* ------------------------------------------------------------------ 工具函数 */

async function copyPNG(): Promise<void> {
  if (!app.art) return
  try {
    const blob = await artToPngBlob(app.art, 1)
    if (!navigator.clipboard?.write) throw new Error('浏览器不支持写入剪贴板')
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    toast('PNG 已复制到剪贴板')
  } catch (err) {
    toast(`复制失败：${(err as Error).message}`, 'warn')
  }
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

function toast(message: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
  const host = document.getElementById('toasts')
  if (!host) return
  const node = el('div', { class: `toast ${kind}` }, [message])
  host.append(node)
  setTimeout(() => node.remove(), kind === 'error' ? 7000 : 4000)
}

/* ------------------------------------------------------------------ 参数与重转 */

function patchParams(patch: Partial<ConvertParams>, opts: { regenerate?: boolean } = {}): void {
  app.params = { ...app.params, ...patch }
  if (opts.regenerate !== false && app.source) regenerate()
  else renderAll()
}

function regenerate(): void {
  if (!app.source) return
  const t0 = performance.now()
  const { art } = runPipeline(app.source, app.params)
  app.art = art
  const ms = Math.round(performance.now() - t0)
  // 重新转换 = 新的基线：撤销栈必须清空（否则"撤销"会退回上一张图，语义混乱）
  resetHistory()
  canvasApi.setArt(art)
  store.set('hasEdits', false)
  if (ms > 400) toast(`转换完成（${art.width}×${art.height}，${ms}ms）`)
  renderAll()
}

async function importFile(file: File): Promise<void> {
  try {
    store.set('busy', true)
    const image = await decodeToRgba(file)
    app.source = image
    app.sourceName = file.name
    app.refImage = await rgbaToImageElement(image)
    app.params = { ...app.params, ...MODE_PRESETS[store.get('mode')] }
    regenerate()
    toast(`已导入 ${file.name}（${image.width}×${image.height}）`)
  } catch (err) {
    toast(`导入失败：${(err as Error).message}`, 'error')
  } finally {
    store.set('busy', false)
  }
}

async function rgbaToImageElement(image: { width: number; height: number; data: Uint8ClampedArray }): Promise<HTMLImageElement> {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const ctx = canvas.getContext('2d')
  if (ctx) {
    // ImageData 的构造函数要求底层是 ArrayBuffer（不接受 SharedArrayBuffer），
    // 因此这里复制一份带明确 ArrayBuffer 的拷贝，避免类型与运行时的双重不确定。
    const buffer = new Uint8ClampedArray(new ArrayBuffer(image.data.length))
    buffer.set(image.data)
    ctx.putImageData(new ImageData(buffer, image.width, image.height), 0, 0)
  }
  const url = canvas.toDataURL('image/png')
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('参考图层生成失败'))
    img.src = url
  })
  return img
}

/* ------------------------------------------------------------------ 画布装配 */

const canvasHost = document.getElementById('canvas-host') as HTMLElement
const canvasEl = document.getElementById('board') as HTMLCanvasElement
const magBox = document.getElementById('magnifier') as HTMLElement
const magCanvas = document.getElementById('magnifier-canvas') as HTMLCanvasElement

const canvasApi = createCanvas(canvasHost, canvasEl, {
  onCommit: commitWithHistory,
  onPickColor: (hex) => {
    store.setMany({ primary: hex, transparent: false })
    renderAll()
  },
  onHover: (cell) => store.set('hoverText', cell ? `${cell.x}, ${cell.y}` : ''),
  onSelectionChange: (count) => store.set('selectedCount', count),
  onZoom: (pct) => store.set('zoomPct', pct),
})
;(canvasApi as unknown as { attachMagnifier: (a: HTMLElement, b: HTMLCanvasElement) => void }).attachMagnifier(magBox, magCanvas)

/* ------------------------------------------------------------------ 面板渲染 */

const leftRail = document.getElementById('rail-tools') as HTMLElement
const palettePanel = document.getElementById('panel-palette') as HTMLElement
const paramsPanel = document.getElementById('panel-params') as HTMLElement
const statusbar = document.getElementById('statusbar') as HTMLElement

/** 顶栏按钮引用：结构只建一次，render 时只更新可用状态（避免打断导出菜单的展开状态） */
let fileInput: HTMLInputElement | null = null
let undoBtn: HTMLButtonElement | null = null
let redoBtn: HTMLButtonElement | null = null
let regenerateBtn: HTMLButtonElement | null = null
let newBtn: HTMLButtonElement | null = null

const TOOL_META: Record<string, { icon: string; name: string; key: string }> = {
  pencil: { icon: '✎', name: '画笔', key: 'B' },
  selection: { icon: '⬚', name: '选区', key: 'M' },
  bucket: { icon: '▨', name: '填充', key: 'G' },
  picker: { icon: '⌖', name: '取色', key: 'I' },
  rect: { icon: '▭', name: '矩形', key: 'U' },
  ellipse: { icon: '◯', name: '椭圆', key: 'O' },
}

function renderTools(): void {
  clear(leftRail)
  const grid = el('div', { class: 'tool-grid' })
  for (const id of TOOLS) {
    const meta = TOOL_META[id]
    const active = store.get('tool') === id
    grid.append(
      el('button', {
        class: `tool-btn${active ? ' active' : ''}`,
        'aria-pressed': active ? 'true' : 'false',
        title: `${meta.name}（${meta.key}）`,
        onclick: () => {
          store.set('tool', id)
          renderAll()
        },
      }, [`${meta.icon} ${meta.name}`]),
    )
  }
  leftRail.append(grid)

  const brushes = el('div', { class: 'row' }, [el('span', { class: 'hint' }, ['笔刷'])])
  for (const size of [1, 2, 3]) {
    brushes.append(
      el('button', {
        class: `btn tiny${store.get('brushSize') === size ? ' active' : ''}`,
        onclick: () => {
          store.set('brushSize', size)
          renderAll()
        },
      }, [`${size}×${size}`]),
    )
  }
  leftRail.append(brushes)

  const colors = el('div', { class: 'color-row' })
  colors.append(
    colorSlot('主色', store.get('primary'), () => openPicker('primary')),
    el('button', { class: 'btn tiny', title: '交换主色/背景色（Tab）', onclick: swapColors }, ['⇄']),
    colorSlot('背景', store.get('bg'), () => openPicker('bg')),
  )
  leftRail.append(colors)

  leftRail.append(
    el('div', { class: 'hint lines' }, [
      el('div', {}, ['左键主色 · 右键背景色 · 选中「透明色」后绘制即挖洞']),
      el('div', {}, ['M 框选 · X 挖洞 · F 填色 · 方向键移动 · Ctrl+C/V 复制粘贴']),
      el('div', {}, ['空格拖动平移 · 滚轮缩放 · 0 适配 · Alt+点击取色 · 按住 L 连直线']),
    ]),
  )
}

function colorSlot(label: string, hex: string, onclick: () => void): HTMLElement {
  return el('button', { class: 'color-slot', title: `${label} ${hex}`, onclick }, [
    el('span', { class: 'chip', style: { background: hex } }),
    el('span', { class: 'chip-label' }, [label]),
  ])
}

function swapColors(): void {
  store.setMany({ primary: store.get('bg'), bg: store.get('primary') })
  renderAll()
}

let pickerTarget: 'primary' | 'bg' = 'primary'
function openPicker(target: 'primary' | 'bg'): void {
  pickerTarget = target
  store.set('showPicker', true)
  renderAll()
}

/** 取色器实例（按 Blender 取色界面的结构实现，见 ui/colorpicker.ts） */
let picker: ColorPickerApi | null = null

/** 颜色变化：拖动中只预览，提交才进撤销栈（一次拖动 = 一条撤销） */
function handlePickerPreview(hex: string): void {
  if (pickerTarget === 'primary') store.set('primary', hex)
  else store.set('bg', hex)
  renderAll()
}

function handlePickerCommit(hex: string): void {
  if (pickerTarget === 'primary') {
    store.setMany({ primary: hex, transparent: false })
    addRecent(hex)
  } else {
    store.setMany({ bg: hex, transparent: false })
  }
  renderAll()
  canvasApi.redraw()
}

function ensurePicker(host: HTMLElement): ColorPickerApi {
  const currentValue = pickerTarget === 'primary' ? store.get('primary') : store.get('bg')
  if (!picker) {
    picker = createColorPicker(host, {
      target: pickerTarget,
      value: currentValue,
      groups: pickerGroups(),
    }, {
      onPreview: handlePickerPreview,
      onCommit: handlePickerCommit,
      onTransparent: () => {
        store.setMany({ transparent: true, tool: 'pencil' })
        renderAll()
      },
      isTransparent: () => store.get('transparent'),
      onPickFromCanvas: () => {
        store.set('tool', 'picker')
        toast('吸管已就绪：到画布上点一格即可取色（Esc 取消）')
        renderAll()
      },
      onClose: () => {
        store.set('showPicker', false)
        renderAll()
      },
    })
  }
  return picker
}

/** 取色器下方的色板分组：预置色卡（含拼豆号色）+ 最近使用 + 工作色板 */
function pickerGroups(): { name: string; colors: string[] }[] {
  const rows = readRecents()
  const preset = getPreset(app.params.presetPaletteId)
  const work = app.art?.palette ?? []
  return [
    { name: '本图', colors: work.slice(0, 32) },
    { name: '最近', colors: rows.slice(0, 16) },
    { name: preset?.name ?? '预置', colors: (preset?.colors ?? []).slice(0, 32) },
    { name: 'PICO-8', colors: (getPreset('pico8')?.colors ?? []).slice(0, 16) },
  ].filter((g) => g.colors.length > 0)
}

/** 最近使用色（localStorage 持久化） */
const RECENT_KEY = 'pixel-build.recents'
function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr) ? (arr.filter((c) => typeof c === 'string') as string[]) : []
  } catch {
    return []
  }
}
function addRecent(hex: string): void {
  const norm = hex.toLowerCase()
  const next = [norm, ...readRecents().filter((c) => c !== norm)].slice(0, 24)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* 无痕模式等场景忽略 */
  }
}

/**
 * 取色器面板（Blender 结构）。两条踩过的坑写在这里，避免以后重犯：
 *  1. **必须在"没有画布"的提前 return 之前挂载**：曾经放在 return 之后，导致"还没导入图片时点主色块没反应"。
 *  2. **宿主元素必须跨渲染持久化**：面板每次渲染都重建 DOM，若宿主也跟着重建，取色器实例的 DOM
 *     仍挂在旧宿主上，表现为"打开正常、一拖动就消失"（拖动会触发一次重渲染）。
 */
let pickerHost: HTMLElement | null = null

function renderPickerPanel(): void {
  if (!store.get('showPicker')) {
    if (picker) {
      // 收起时释放全局监听（pointerup / blur），避免监听器越积越多
      picker.dispose()
      picker = null
    }
    pickerHost?.remove()
    return
  }
  if (!pickerHost) {
    pickerHost = el('div', { class: 'picker-wrap' })
    palettePanel.append(pickerHost)
  }
  try {
    const instance = ensurePicker(pickerHost)
    instance.update({
      target: pickerTarget,
      value: pickerTarget === 'primary' ? store.get('primary') : store.get('bg'),
      groups: pickerGroups(),
    })
  } catch (err) {
    // 构建失败不能静默：否则表现为"点了没反应"，排查要花很久（这里踩过一次）
    const target = document.getElementById('canvas-host')
    if (target) target.dataset.pickerError = (err as Error)?.message ?? String(err)
    console.error('[取色器] 构建失败：', err)
    clear(pickerHost)
    pickerHost.append(el('div', { class: 'hint' }, [`取色器不可用：${(err as Error)?.message ?? err}`]))
  }
}

function renderPalette(): void {
  // 只移除色板自己的子节点，**保留取色器宿主**（宿主必须跨渲染存活，见上面注释）
  for (const child of [...palettePanel.children]) {
    if (child !== pickerHost) child.remove()
  }
  renderPickerPanel()

  const art = app.art
  palettePanel.append(el('div', { class: 'panel-title' }, ['工作色板']))
  if (!art || art.palette.length === 0) {
    palettePanel.append(el('p', { class: 'hint' }, ['导入图片后显示；现在也可以用上方取色器手选颜色']))
    return
  }

  const usage = artStats(art).usage
  const grid = el('div', { class: 'swatch-grid' })
  const transparent = store.get('transparent')
  // 透明色是第一格：不进 palette 数组（索引/上限/.hex 导出都基于该数组）
  grid.append(
    el('button', {
      class: `swatch transparent${transparent ? ' selected' : ''}`,
      title: `透明色（E）· 共 ${artStats(art).transparent} 格`,
      onclick: () => {
        store.set('transparent', true)
        renderAll()
      },
    }, [el('span', { class: 'count' }, [String(artStats(art).transparent)])]),
  )
  for (const hex of art.palette) {
    const count = usage[hex] ?? 0
    grid.append(
      el('button', {
        class: `swatch${hex === store.get('primary').toLowerCase() && !transparent ? ' selected' : ''}${count === 0 ? ' unused' : ''}`,
        style: { background: hex, color: colorTextOn(hex) },
        title: `${hex} · 用量 ${count} 格 · 左键选为主色`,
        onclick: () => {
          store.setMany({ primary: hex, transparent: false })
          renderAll()
        },
      }, [el('span', { class: 'count' }, [count > 999 ? '1k' : String(count)])]),
    )
  }
  palettePanel.append(grid)
  // 取色器宿主永远排在面板末尾：保证"色板在上、调色器在下"的稳定阅读顺序
  if (pickerHost) palettePanel.append(pickerHost)
}

/** 参数面板：按模式分组，避免把 19 个参数全堆在一个长列表里 */
function renderParams(): void {
  clear(paramsPanel)
  const mode = store.get('mode')
  const p = app.params

  paramsPanel.append(el('div', { class: 'panel-title' }, ['风格预设']))
  const presetRow = el('div', { class: 'row wrap' })
  for (const sp of STYLE_PRESETS) {
    presetRow.append(el('button', { class: 'btn small', title: sp.desc, onclick: () => patchParams(sp.params) }, [sp.name]))
  }
  paramsPanel.append(presetRow)

  paramsPanel.append(el('div', { class: 'panel-title' }, [`转换参数（${mode === 'beads' ? '拼豆' : mode === 'asset' ? '游戏资产' : '图片'}）`]))

  const field = (label: string, control: HTMLElement, hint?: string) =>
    el('div', { class: 'field' }, [el('label', {}, [label]), control, hint ? el('span', { class: 'hint' }, [hint]) : null])

  // 尺寸：拼豆/资产用精确尺寸；照片用长边
  if (mode === 'photo') {
    paramsPanel.append(field('像素数量（长边）', numberInput(p.longEdge, 8, 2048, (v) => patchParams({ longEdge: v })), `${p.longEdge} 格`))
    const quick = el('div', { class: 'row wrap' })
    for (const n of [16, 32, 48, 64, 96, 128, 256, 512]) {
      quick.append(el('button', { class: `btn tiny${p.longEdge === n ? ' active' : ''}`, onclick: () => patchParams({ longEdge: n }) }, [String(n)]))
    }
    paramsPanel.append(quick)
  } else {
    const w = p.exactWidth ?? 58
    const h = p.exactHeight ?? 58
    paramsPanel.append(
      field(
        '画布尺寸（格）',
        el('div', { class: 'row' }, [
          numberInput(w, 1, 2048, (v) => patchParams({ exactWidth: v, exactHeight: p.exactHeight ?? v })),
          el('span', {}, ['×']),
          numberInput(h, 1, 2048, (v) => patchParams({ exactWidth: p.exactWidth ?? v, exactHeight: v })),
        ]),
        mode === 'beads' ? '常见大方板 = 58×58 格（29×29 孔）' : '游戏资产请用 16/24/32/48/64/128',
      ),
    )
  }

  paramsPanel.append(
    field('色板', selectInput(p.paletteMode, [['auto', '自动提取'], ['preset', '预置色卡'], ['custom', '自定义 / .hex']], (v) => patchParams({ paletteMode: v as ConvertParams['paletteMode'] }))),
  )
  if (p.paletteMode === 'preset') {
    const colors = PRESETS.map((x) => [x.id, `${x.name}`] as [string, string])
    paramsPanel.append(
      el('div', { class: 'field-inner' }, [
        selectInput(p.presetPaletteId, colors, (v) => patchParams({ presetPaletteId: v })),
        el('span', { class: 'hint' }, [getPreset(p.presetPaletteId)?.desc ?? '']),
      ]),
    )
  }
  if (p.paletteMode === 'auto') {
    paramsPanel.append(field('颜色数', numberInput(p.paletteK, 2, 64, (v) => patchParams({ paletteK: v }))))
  }

  paramsPanel.append(
    field('降采样', selectInput(p.downsample, [['average', '区域平均（照片）'], ['nearest', '最近邻（硬边）']], (v) => patchParams({ downsample: v as ConvertParams['downsample'] }))),
    field('抖动', selectInput(p.dither, [['none', '关闭'], ['floyd', 'Floyd–Steinberg'], ['bayer', 'Bayer']], (v) => patchParams({ dither: v as ConvertParams['dither'] }))),
    field('杂色清理', checkbox(p.cleanup, (v) => patchParams({ cleanup: v })), '开启抖动时自动关闭（抖动的点就是杂色）'),
    field('亮度 / 对比度 / 饱和度', el('div', { class: 'row' }, [
      numberInput(p.brightness, -100, 100, (v) => patchParams({ brightness: v })),
      numberInput(p.contrast, -100, 100, (v) => patchParams({ contrast: v })),
      numberInput(p.saturation, -100, 100, (v) => patchParams({ saturation: v })),
    ])),
    field('透明处理', selectInput(p.transparent, [['none', '不透明（合成到底色）'], ['key', '单色键控（导出透明）'], ['alpha', '真 alpha（保留原图透明）']], (v) => patchParams({ transparent: v as ConvertParams['transparent'] }))),
  )
  if (p.transparent !== 'alpha') {
    paramsPanel.append(field('合成底色', el('input', { type: 'color', value: p.matteColor, oninput: (e: Event) => patchParams({ matteColor: (e.target as HTMLInputElement).value }) })))
  }
  if (mode !== 'photo') {
    paramsPanel.append(field('锁定色板', checkbox(!!p.lockPalette, (v) => patchParams({ lockPalette: v })), '只用给定色板，绝不新增颜色（图纸/批次必备）'))
  }

  paramsPanel.append(el('div', { class: 'panel-title' }, ['显示']))
  paramsPanel.append(
    el('div', { class: 'field' }, [
      checkbox(store.get('showGrid'), (v) => { store.set('showGrid', v) }),
      el('span', {}, [' 网格线']),
      el('br'),
      checkbox(store.get('showMag'), (v) => { store.set('showMag', v) }),
      el('span', {}, [' 笔刷预览 / 放大镜']),
    ]),
  )
}

function numberInput(value: number, min: number, max: number, onCommit: (v: number) => void): HTMLInputElement {
  return el('input', {
    class: 'num',
    type: 'number',
    value: String(value),
    min: String(min),
    max: String(max),
    onchange: (e: Event) => {
      const raw = Number((e.target as HTMLInputElement).value)
      const v = Math.min(max, Math.max(min, Number.isFinite(raw) ? Math.round(raw) : value))
      onCommit(v)
    },
  })
}

function selectInput(value: string, options: [string, string][], onChange: (v: string) => void): HTMLSelectElement {
  const sel = el('select', { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) })
  for (const [val, label] of options) {
    const opt = el('option', { value: val }, [label])
    if (val === value) opt.setAttribute('selected', '')
    sel.append(opt)
  }
  return sel
}

function checkbox(checked: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const input = el('input', { type: 'checkbox', onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) })
  if (checked) input.setAttribute('checked', '')
  input.checked = checked
  return input
}

function renderStatusbar(): void {
  clear(statusbar)
  const art = app.art
  const bits: string[] = []
  bits.push(art ? `画布 ${art.width}×${art.height}` : '未导入')
  if (art) {
    bits.push(`工具 ${TOOL_META[store.get('tool')]?.name ?? store.get('tool')}`)
    if (store.get('transparent')) bits.push('透明挖洞')
    else if (store.get('tool') === 'pencil') bits.push(`笔刷 ${store.get('brushSize')}×${store.get('brushSize')}`)
    const st = artStats(art)
    bits.push(`${st.paletteSize} 色`)
    if (st.transparent) bits.push(`透明 ${st.transparent} 格`)
    if (store.get('selectedCount')) bits.push(`已选 ${store.get('selectedCount')} 格`)
    if (store.get('clipboardHas')) bits.push('已复制选区')
    bits.push(`${store.get('zoomPct')}%`)
    if (store.get('hasEdits')) bits.push('● 有编辑')
  }
  if (store.get('hoverText')) bits.push(store.get('hoverText'))
  bits.push(app.sourceName || '')
  for (const b of bits.filter(Boolean)) statusbar.append(el('span', {}, [b]))
}

/** 空状态：**按需插入**（有画布时必须移除，否则会盖住画好的内容） */
function renderEmptyState(): void {
  const host = canvasHost
  const existing = host.querySelector('.empty-state')
  if (app.art) {
    existing?.remove()
    return
  }
  if (existing) return
  host.append(
    el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-icon' }, ['▦']),
      el('div', { class: 'empty-title' }, ['拖入图片，或用顶栏「导入图片」']),
      el('div', { class: 'empty-hint' }, ['支持 PNG / JPG / WebP / GIF / BMP / AVIF / ICO / SVG · 也可 Ctrl+V 粘贴']),
    ]),
  )
}

function renderAll(): void {
  renderTools()
  renderPalette()
  renderParams()
  renderStatusbar()
  renderEmptyState()
  updateHeaderState()
  canvasApi.redraw()
}

/* ------------------------------------------------------------------ 导出 */

async function exportPNG(scale: number): Promise<void> {
  if (!app.art) {
    toast('还没有画布', 'warn')
    return
  }
  try {
    const blob = await artToPngBlob(app.art, scale, { transparentBg: app.params.transparent === 'key', bgHex: app.params.matteColor })
    const name = `${safeFileBase(app.sourceName)}_${app.art.width}x${app.art.height}_${scale}x.png`
    download(blob, name)
    toast(`已导出 ${name}`)
  } catch (err) {
    toast(`导出失败：${(err as Error).message}`, 'error')
  }
}

function exportBeadFiles(): void {
  if (!app.art) return toast('还没有画布', 'warn')
  const codes = getPreset(app.params.presetPaletteId)?.codes
  const base = safeFileBase(app.sourceName || 'beads')
  download(new Blob([beadSvg(app.art, { codes, title: `${base} 拼豆图纸` })], { type: 'image/svg+xml' }), `${base}_图纸.svg`)
  download(new Blob([`\ufeff${beadListCsv(app.art, { codes })}`], { type: 'text/csv' }), `${base}_缺口清单.csv`)
  const rep = beadReport(app.art, { codes })
  toast(`图纸与清单已导出：${rep.colorCount} 色 / ${rep.totalBeads} 颗 / ${rep.totalGrams} g`)
}

function exportPixelJSON(): void {
  if (!app.art) return
  download(new Blob([pixelJSONString(app.art)], { type: 'application/json' }), `${safeFileBase(app.sourceName)}_像素数据.json`)
}

function exportProject(): void {
  if (!app.art) return
  download(new Blob([projectJSONString(app.art, app.params, true)], { type: 'application/json' }), `${safeFileBase(app.sourceName)}_项目.json`)
}

/* ------------------------------------------------------------------ 顶栏装配 */

/**
 * 顶栏只构建一次，之后只更新按钮的可用状态。
 *
 * 为什么不在每次 render 里重建：导出菜单是展开/收起状态机，重建会把菜单状态一起冲掉
 * （点开菜单 → 触发一次渲染 → 菜单消失）。这里把"结构"与"状态"分开：
 * 结构在 boot 时建好，render 只调 updateHeaderState()。
 */
function buildHeader(): void {
  const modeHost = document.getElementById('header-mode') as HTMLElement | null
  const actionsHost = document.getElementById('header-actions') as HTMLElement | null
  const importBtn = document.getElementById('btn-import') as HTMLButtonElement | null
  const exportBtn = document.getElementById('btn-export') as HTMLButtonElement | null
  const menu = document.getElementById('export-menu') as HTMLElement | null
  const anchor = document.getElementById('export-anchor') as HTMLElement | null
  if (!modeHost || !actionsHost || !importBtn || !exportBtn || !menu || !anchor) {
    throw new Error('顶栏结构缺失（index.html 模板被改动过？）')
  }

  // 文件选择器常驻在 DOM 里（隐藏），"导入图片"与"新建空白画布"共用它
  fileInput = el('input', {
    type: 'file',
    accept: 'image/*,.avif,.ico,.svg',
    style: { display: 'none' },
    onchange: (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0]
      if (f) void importFile(f)
      ;(e.target as HTMLInputElement).value = ''
    },
  })
  document.body.append(fileInput)

  /* ---- 左侧：模式切换（位置与之前一致，只是不再和文件操作混在一起） ---- */
  const modeSelect = selectInput(
    store.get('mode'),
    [
      ['photo', '图片→像素'],
      ['beads', '拼豆图纸'],
      ['asset', '游戏资产'],
    ],
    (v) => {
      store.set('mode', v as 'photo' | 'beads' | 'asset')
      patchParams(MODE_PRESETS[v] ?? {})
      renderAll()
    },
  )
  modeSelect.className = 'mode-select'
  modeSelect.title = '选择用途：切换后会自动套一组合适的参数'
  modeSelect.setAttribute('aria-label', '工作模式')
  modeSelect.dataset.testid = 'mode'
  modeHost.append(modeSelect)

  /* ---- 右侧：编辑操作（与导入/导出同处右上角；窄屏自动收成图标） ---- */
  undoBtn = el(
    'button',
    { class: 'btn act', title: '撤销（Ctrl+Z）', 'aria-label': '撤销', onclick: undo },
    [el('span', { class: 'act-icon' }, ['↶']), el('span', { class: 'act-label' }, ['撤销'])],
  )
  redoBtn = el(
    'button',
    { class: 'btn act', title: '重做（Ctrl+Y / Ctrl+Shift+Z）', 'aria-label': '重做', onclick: redo },
    [el('span', { class: 'act-icon' }, ['↷']), el('span', { class: 'act-label' }, ['重做'])],
  )
  regenerateBtn = el(
    'button',
    {
      class: 'btn act',
      title: '用当前参数重新转换（有手动编辑时会先确认）',
      'aria-label': '重新转换',
      onclick: () => {
        if (store.get('hasEdits') && !confirm('重新转换会覆盖当前的手动编辑，继续？')) return
        regenerate()
      },
    },
    [el('span', { class: 'act-icon' }, ['⟳']), el('span', { class: 'act-label' }, ['重新转换'])],
  )
  newBtn = el(
    'button',
    {
      class: 'btn act',
      title: '清空画布与素材，重新开始',
      'aria-label': '新建',
      onclick: () => {
        if (app.art && !confirm('清空当前画布？未导出的内容会丢失。')) return
        app.art = null
        app.source = null
        app.sourceName = ''
        app.refImage = null
        resetHistory()
        canvasApi.setArt(null)
        store.setMany({ hasEdits: false, selectedCount: 0, clipboardHas: false })
        renderAll()
      },
    },
    [el('span', { class: 'act-icon' }, ['✚']), el('span', { class: 'act-label' }, ['新建'])],
  )
  const helpBtn = document.getElementById('btn-help') as HTMLButtonElement | null
  if (helpBtn) {
    // 「? 快捷键」放在顶栏最右侧：与其它按钮拉开距离，避免误触
    helpBtn.append(el('span', { class: 'act-icon' }, ['?']), el('span', { class: 'act-label' }, ['快捷键']))
    helpBtn.title = '快捷键速查（按 ? 也能打开）'
    helpBtn.setAttribute('aria-label', '快捷键速查')
    helpBtn.dataset.testid = 'help'
    helpBtn.addEventListener('click', showHelp)
  }
  actionsHost.append(undoBtn, redoBtn, regenerateBtn, newBtn)

  /* ---- 右上角：导入图片 ---- */
  importBtn.textContent = '导入图片'
  importBtn.title = '打开图片文件（也可以直接拖进窗口，或 Ctrl+V 粘贴）'
  importBtn.dataset.testid = 'import'
  const pickFile = fileInput
  importBtn.addEventListener('click', () => pickFile.click())

  /* ---- 右上角：导出菜单（把原先铺在顶栏的 9 个倍数按钮收进菜单） ---- */
  exportBtn.textContent = '导出 ▾'
  exportBtn.title = '导出 PNG / 图纸 / 数据（Ctrl+S 直接存 1 倍 PNG）'
  exportBtn.dataset.testid = 'export'
  const openMenu = () => {
    renderExportMenu(menu)
    menu.hidden = false
    exportBtn.setAttribute('aria-expanded', 'true')
  }
  const closeMenu = () => {
    menu.hidden = true
    exportBtn.setAttribute('aria-expanded', 'false')
  }
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (menu.hidden) openMenu()
    else closeMenu()
  })
  // 点菜单内部不关闭（除非显式点了某个条目）；点外面关闭
  menu.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    if (target.closest('[data-close]')) closeMenu()
  })
  window.addEventListener('click', (e) => {
    if (menu.hidden) return
    if (!anchor.contains(e.target as Node)) closeMenu()
  })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) closeMenu()
  })

  updateHeaderState()
}

/** 导出菜单内容：每次打开时重建，因此"透明底"等状态永远是最新的 */
function renderExportMenu(menu: HTMLElement): void {
  clear(menu)
  const hasArt = !!app.art
  const keyed = app.params.transparent === 'key'

  const item = (label: string, hint: string, onclick: () => void, opts: { disabled?: boolean; testid?: string } = {}) => {
    const b = el('button', {
      class: 'dropdown-item',
      type: 'button',
      role: 'menuitem',
      title: hint,
      disabled: opts.disabled ? true : false,
      onclick,
    }, [
      el('span', { class: 'di-label' }, [label]),
      el('span', { class: 'di-hint' }, [hint]),
    ])
    if (opts.testid) b.dataset.testid = opts.testid
    return b
  }

  if (!hasArt) {
    menu.append(el('div', { class: 'dropdown-empty' }, ['还没有画布：先导入图片，或点「新建 → 空白画布」']))
  }

  menu.append(el('div', { class: 'dropdown-group' }, ['图片']))
  menu.append(
    item('PNG 1x（原尺寸）', `文件名自动带源图名${keyed ? ' · 透明底' : ''}`, () => {
      closeExportMenu()
      void exportPNG(1)
    }, { disabled: !hasArt, testid: 'export-png' }),
  )
  const scaleRow = el('div', { class: 'dropdown-row' })
  scaleRow.append(el('span', { class: 'dropdown-row-label' }, ['放大倍数']))
  for (const s of EXPORT_SCALES) {
    scaleRow.append(
      el('button', {
        class: 'btn tiny',
        type: 'button',
        disabled: hasArt ? false : true,
        title: `按 ${s} 倍最近邻放大导出`,
        onclick: () => {
          closeExportMenu()
          void exportPNG(s)
        },
      }, [`${s}x`]),
    )
  }
  menu.append(scaleRow)
  menu.append(
    item('复制 PNG（1x）', '直接粘进聊天 / 文档', () => {
      closeExportMenu()
      void copyPNG()
    }, { disabled: !hasArt }),
  )

  menu.append(el('div', { class: 'dropdown-group' }, ['拼豆']))
  menu.append(
    item('图纸 SVG + 缺口清单 CSV', '格内标号色、分板、图例；清单含珠数与重量', () => {
      closeExportMenu()
      exportBeadFiles()
    }, { disabled: !hasArt, testid: 'export-bead' }),
  )

  menu.append(el('div', { class: 'dropdown-group' }, ['数据']))
  menu.append(
    item('像素数据 JSON', '每格颜色 + 每色用量表（原料清单）', () => {
      closeExportMenu()
      exportPixelJSON()
    }, { disabled: !hasArt }),
    item('项目 JSON', '参数 + 色板 + 像素，不含原图，可分享继续编辑', () => {
      closeExportMenu()
      exportProject()
    }, { disabled: !hasArt }),
  )

  menu.append(el('div', { class: 'dropdown-group' }, ['画布']))
  menu.append(
    item('新建空白画布', '不导入图片，直接开画（拼豆/资产原型常用）', () => {
      closeExportMenu()
      makeBlank()
    }, { testid: 'blank-canvas' }),
  )
}

/** 关闭导出菜单（供菜单项回调复用，避免互相引用） */
function closeExportMenu(): void {
  const menu = document.getElementById('export-menu')
  const btn = document.getElementById('btn-export')
  if (menu) menu.hidden = true
  btn?.setAttribute('aria-expanded', 'false')
}

/** 只更新顶栏按钮的可用状态（不重建 DOM，因此不会打断菜单） */
function updateHeaderState(): void {
  const art = app.art
  const src = app.source
  if (undoBtn) undoBtn.disabled = history.past.length === 0
  if (redoBtn) redoBtn.disabled = history.future.length === 0
  if (regenerateBtn) regenerateBtn.disabled = !src
  if (newBtn) newBtn.disabled = !art && !src
  const exportBtn = document.getElementById('btn-export') as HTMLButtonElement | null
  // 导出按钮**不因"没有画布"而禁用**：否则用户不知道去哪导出，点开菜单会看到明确提示
  if (exportBtn) exportBtn.classList.toggle('is-empty', !art)
}

function makeBlank(): void {
  const w = app.params.exactWidth ?? Math.min(58, app.params.longEdge)
  const h = app.params.exactHeight ?? Math.min(58, app.params.longEdge)
  const art = blankArt(w, h, app.params.matteColor, app.params.transparent === 'alpha')
  app.art = art
  canvasApi.setArt(art)
  store.set('hasEdits', false)
  renderAll()
  toast(`已新建空白画布 ${w}×${h}`)
}

function showHelp(): void {
  const rows: [string, string][] = [
    ['B / M / G / I', '画笔 / 选区 / 填充 / 取色'],
    ['U / O', '矩形 / 椭圆（拖拽绘制）'],
    ['E', '选中「透明色」：画笔/填充/形状即挖洞'],
    ['Tab', '交换主色 / 背景色'],
    ['Alt + 点击', '临时取色（不切换工具）'],
    ['按住 L 点击', '从上次落笔处画直线'],
    ['M 拖动', '框选（Shift 并入选区）'],
    ['X / Del / Backspace', '把选区挖成透明'],
    ['F', '选区填主色'],
    ['Ctrl+C / Ctrl+V', '复制 / 粘贴选区（粘贴锚点=鼠标格）'],
    ['方向键 / Shift+方向键', '移动选区内容 1 / 10 格'],
    ['滚轮 / + / − / 0', '缩放 / 适配窗口'],
    ['空格+拖动 / 中键拖动', '平移画布'],
    ['Ctrl+Z / Ctrl+Y', '撤销 / 重做'],
    ['Ctrl+S', '导出 PNG（1 倍）'],
    ['点主色/背景色块', '打开取色器（Blender 结构：色轮 + 明度条 + 透明度条 + RGB/HSV/Hex）'],
    ['右上角「导出 ▾」', 'PNG 各倍数 / 拼豆图纸 / 像素与项目 JSON'],
  ]
  const table = el('table')
  for (const [k, v] of rows) table.append(el('tr', {}, [el('td', {}, [k]), el('td', {}, [v])]))
  const modal = el('div', { class: 'modal-mask', onclick: (e: Event) => { if (e.target === e.currentTarget) modal.remove() } }, [
    el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
      el('div', { class: 'modal-head' }, [
        el('span', {}, ['快捷键速查']),
        el('button', { class: 'btn tiny', onclick: () => modal.remove() }, ['关闭（Esc）']),
      ]),
      table,
      el('p', { class: 'hint' }, ['提示：快捷键以本表为唯一出处；文档与界面若不一致，以界面为准。']),
    ]),
  ])
  document.body.append(modal)
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      modal.remove()
      window.removeEventListener('keydown', onEsc)
    }
  }
  window.addEventListener('keydown', onEsc)
}

/* ------------------------------------------------------------------ 全局快捷键 */

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
  const k = e.key.toLowerCase()
  if ((e.ctrlKey || e.metaKey) && k === 'z') {
    e.preventDefault()
    if (e.shiftKey) redo()
    else undo()
    return
  }
  if ((e.ctrlKey || e.metaKey) && k === 'y') {
    e.preventDefault()
    redo()
    return
  }
  if ((e.ctrlKey || e.metaKey) && k === 's') {
    // 主流软件的肌肉记忆：Ctrl+S = 导出图片（这里是浏览器工具，没有"保存文件"的概念）
    e.preventDefault()
    void exportPNG(1)
    return
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return
  const toolKey: Record<string, string> = { b: 'pencil', m: 'selection', g: 'bucket', i: 'picker', u: 'rect', o: 'ellipse' }
  if (toolKey[k]) {
    store.set('tool', toolKey[k])
    renderAll()
  } else if (k === 'e') {
    store.setMany({ transparent: true, tool: 'pencil' })
    renderAll()
  } else if (k === 'tab') {
    if (!t || (t.tagName !== 'BUTTON' && t.tagName !== 'A')) {
      e.preventDefault()
      swapColors()
    }
  }
})

/* ------------------------------------------------------------------ 启动 */

function boot(): void {
  const prefs = sanitizePrefs(readPrefs())
  store.setMany({
    tool: prefs.tool,
    primary: prefs.primary,
    bg: prefs.bg,
    brushSize: prefs.brushSize,
    showGrid: prefs.showGrid,
    showMag: prefs.showMag,
    showPicker: prefs.showPicker,
    transparent: prefs.eraseToAlpha,
  })

  buildHeader()
  renderAll()

  // 拖拽导入
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    const f = e.dataTransfer?.files?.[0]
    if (f && looksLikeImage(f)) void importFile(f)
  })
  // 粘贴导入
  window.addEventListener('paste', (e) => {
    const f = imageFromClipboard(e)
    if (f) void importFile(f)
  })

  // 偏好持久化（防抖，避免拖色时频繁写盘）
  let timer = 0
  store.subscribe(['tool', 'primary', 'bg', 'brushSize', 'showGrid', 'showMag', 'showPicker', 'transparent'], (s) => {
    clearTimeout(timer)
    timer = window.setTimeout(() => writePrefs(s), 400)
  })

  // 自动化接口（window.pixelArtStudio）——与 UI 共用同一份 core
  installAutomationApi({
    getParams: () => app.params,
    setParams: (p) => {
      app.params = p
      renderAll()
    },
    getArt: () => app.art,
    setArt: (next) => {
      app.art = next
      canvasApi.setArt(next)
      renderAll()
    },
    getSource: () => app.source,
    setSource: (img, name) => {
      app.source = img
      app.sourceName = name
    },
    regenerate,
    commit: commitWithHistory,
    undo,
    redo,
    toast,
    exportPNG: (scale, opts) => (app.art ? artToPngDataURLSync(app.art, scale, opts) : ''),
    pngDataURL: (art, scale, opts) => artToPngDataURL(art, scale, opts),
    setPrefs: (patch) => {
      store.setMany(patch)
      renderAll()
    },
    getPrefs: () => ({
      tool: store.get('tool'),
      primary: store.get('primary'),
      bg: store.get('bg'),
      brushSize: store.get('brushSize'),
      eraserToAlpha: store.get('transparent'),
    }),
    importImage: importFile,
    decodeImage: decodeToRgba,
    makeThumbnail,
    blank: makeBlank,
    applyOpsToArt: (ops) => (app.art ? applyOps(app.art, ops, { fallbackColor: store.get('primary'), allowApproxColor: !app.params.lockPalette }) : null),
  })

  console.log('[像素画工作台] 已就绪。agent 可调用 window.pixelArtStudio.describe() 自省接口。')
}

function readPrefs(): EditorPrefs | null {
  try {
    const raw = localStorage.getItem('pixel-build.prefs')
    return raw ? (JSON.parse(raw) as EditorPrefs) : null
  } catch {
    return null
  }
}

function writePrefs(s: {
  tool: string
  primary: string
  bg: string
  brushSize: number
  showGrid: boolean
  showMag: boolean
  showPicker: boolean
  transparent: boolean
}): void {
  try {
    localStorage.setItem(
      'pixel-build.prefs',
      JSON.stringify({ ...DEFAULT_PREFS, tool: s.tool, primary: s.primary, bg: s.bg, brushSize: s.brushSize, showGrid: s.showGrid, showMag: s.showMag, showPicker: s.showPicker, eraseToAlpha: s.transparent }),
    )
  } catch {
    /* 无痕模式等场景忽略 */
  }
}

boot()

// 供自动化接口与调试使用
;(window as unknown as { __app?: unknown }).__app = { app, store, canvasApi }
