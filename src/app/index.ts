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

function renderPalette(): void {
  clear(palettePanel)
  const art = app.art
  palettePanel.append(el('div', { class: 'panel-title' }, ['工作色板']))
  if (!art || art.palette.length === 0) {
    palettePanel.append(el('p', { class: 'hint' }, ['导入图片后显示']))
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

  if (store.get('showPicker')) {
    const value = pickerTarget === 'primary' ? store.get('primary') : store.get('bg')
    palettePanel.append(
      el('div', { class: 'picker-wrap' }, [
        el('div', { class: 'row' }, [
          el('span', { class: 'hint' }, [`编辑${pickerTarget === 'primary' ? '主色' : '背景'}：`]),
          el('input', {
            type: 'color',
            value,
            oninput: (e: Event) => {
              const hex = (e.target as HTMLInputElement).value.toLowerCase()
              if (pickerTarget === 'primary') store.set('primary', hex)
              else store.set('bg', hex)
              renderAll()
            },
          }),
          el('input', {
            class: 'hex-input',
            value,
            maxlength: '7',
            oninput: (e: Event) => {
              const raw = (e.target as HTMLInputElement).value.trim()
              if (!/^#[0-9a-fA-F]{6}$/.test(raw)) return
              const hex = raw.toLowerCase()
              if (pickerTarget === 'primary') store.set('primary', hex)
              else store.set('bg', hex)
              renderAll()
            },
          }),
          el('button', { class: 'btn tiny', onclick: () => { store.set('showPicker', false); renderAll() } }, ['收起']),
        ]),
      ]),
    )
  }
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

function buildHeader(): void {
  const header = document.getElementById('header-actions')
  if (!header) return
  const art = app.art
  const fileInput = el('input', {
    type: 'file',
    accept: 'image/*,.avif,.ico,.svg',
    style: { display: 'none' },
    onchange: (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0]
      if (f) void importFile(f)
      ;(e.target as HTMLInputElement).value = ''
    },
  })
  header.append(fileInput)

  const btn = (label: string, title: string, onclick: () => void, disabled = false) =>
    el('button', { class: 'btn', title, disabled: disabled ? true : false, onclick }, [label])

  const modeSelect = selectInput(store.get('mode'), [['photo', '图片→像素'], ['beads', '拼豆图纸'], ['asset', '游戏资产']], (v) => {
    store.set('mode', v as 'photo' | 'beads' | 'asset')
    patchParams(MODE_PRESETS[v] ?? {})
  })
  modeSelect.className = 'mode-select'

  header.append(
    modeSelect,
    btn('导入图片', '打开或拖入图片', () => fileInput.click()),
    btn('重新转换', '用当前参数重跑（有手动编辑时会确认）', () => {
      if (store.get('hasEdits') && !confirm('重新转换会覆盖当前手动编辑，继续？')) return
      regenerate()
    }, !app.source),
    btn('新建', '清空画布与素材', () => {
      if (app.art && !confirm('清空当前画布？未导出的内容会丢失。')) return
      app.art = null
      app.source = null
      app.sourceName = ''
      app.refImage = null
      resetHistory()
      canvasApi.setArt(null)
      store.setMany({ hasEdits: false, selectedCount: 0, clipboardHas: false })
      renderAll()
    }),
    btn('导出 PNG', '按 1 倍导出（其它倍数见下方按钮）', () => void exportPNG(1), !art),
    btn('拼豆图纸', '导出图纸 SVG + 缺口清单 CSV', exportBeadFiles, !art),
    btn('项目 JSON', '保存参数+像素（不含原图）', exportProject, !art),
    btn('? 快捷键', '快捷键速查', () => showHelp()),
  )

  const scaleRow = el('div', { class: 'row tiny-gap' })
  for (const s of EXPORT_SCALES) {
    scaleRow.append(el('button', { class: 'btn tiny', disabled: art ? false : true, onclick: () => void exportPNG(s) }, [`${s}x`]))
  }
  header.append(scaleRow)
  header.append(
    el('div', { class: 'row tiny-gap' }, [
      el('button', { class: 'btn tiny', disabled: art ? false : true, onclick: exportPixelJSON }, ['像素 JSON']),
      el('button', { class: 'btn tiny', disabled: art ? false : true, onclick: () => void copyPNG() }, ['复制 PNG']),
      el('button', { class: 'btn tiny', disabled: art ? false : true, title: '新建空白画布（不导入图片）', onclick: () => makeBlank() }, ['空白画布']),
    ]),
  )
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
