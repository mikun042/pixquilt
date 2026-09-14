/**
 * 像素画工作台 · 界面入口
 *
 * 这一层只做三件事：**装配 UI、把用户动作翻译成 core 调用、把 core 结果写回界面**。
 * 算法一律在 src/core，页内 API 在 src/app/automation.ts；这里不实现任何像素逻辑。
 *
 * 三种用途（图片→像素 / 拼豆图纸 / 游戏资产）**不再是独立的"工作模式"**，而是右侧的预设：
 * 它们本来就只是"一组合适的参数"，与「风格预设」职责重叠且内容不一致（旧模式漏设
 * cleanup、photo 模式是空对象，切换还会互相残留参数）。现在统一由 `src/app/presets.ts`
 * 管理：出厂预设只读、用户可更新/恢复出厂/另存为自定义预设。见 docs/USAGE.md。
 */
import { DEFAULT_PARAMS, DEFAULT_PREFS, TOOLS, coerceParams, sanitizePrefs, type ConvertParams, type EditorPrefs, type PixelArt } from '../core/types.ts'
import { PRESETS, getPreset, parseHexPalette, serializeHexPalette } from '../core/palettes.ts'
import { EXPORT_SCALES, PREFS_DEBOUNCE_MS } from '../core/limits.ts'
import { createExportActions } from './export-actions.ts'
import { artToPngBlob, artToPngDataURL, artToPngDataURLSync } from './canvas-png.ts'
import { runPipeline } from '../core/pipeline.ts'
import { applyOps, blankArt } from '../core/ops.ts'
import { artStats } from '../core/stats.ts'
import { colorTextOn } from '../core/color.ts'
import { clear, el, store } from './store.ts'
import { decodeToRgba, imageFromClipboard, makeThumbnail, looksLikeImage } from './decode.ts'
import { createCanvas } from './ui/canvas.ts'
import { createColorPicker, type ColorPickerApi, type ColorPickerCallbacks } from './ui/colorpicker.ts'
import { createMatteField } from './matte-field.ts'
import { iconEl } from './ui/icons.ts'
import { ArtHistory, normalizeAlphaMask } from './history.ts'
import { addCustomPreset, effectivePresets, removeCustomPreset, resetPreset, sameParams, updatePreset } from './presets.ts'
import { installAutomationApi } from './automation.ts'

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
 * 撤销 / 重做栈。逻辑在 `src/app/history.ts`（纯模块，可脱离浏览器单测）：
 * **双上限**——`HISTORY_MAX_FRAMES` 步 或 累计 `HISTORY_MAX_BYTES`，先到先算。
 *
 * 这里曾经只有硬编码的 `> 50`、没有任何字节记账，而 limits 里的字节上限只写在文档里，
 * 于是 2048² 带 alpha 的画布单帧 8MB × 50 帧最坏约 400MB（弱机 OOM）。
 */
const history = new ArtHistory()

function resetHistory(): void {
  history.reset()
}

/** 一次编辑的提交入口（UI 绘制与自动化接口共用）：进撤销栈后写回并重绘 */
function commitWithHistory(indices: Uint8Array, palette: string[], alphaMask: Uint8Array | null): void {
  if (!app.art) return
  // 入栈必须是**快照**而不是活对象引用：canvas 在提交时会就地改写 art.palette
  // （src/app/ui/canvas.ts 的 `art.palette = palette`），若入栈共享同一对象，
  // 已撤销的颜色会残留在色板里，artHash 与导出的 .hex/项目 JSON 随之被污染（测试报告 P2-05）。
  history.commit(app.art)
  // 提交前把"全不透明的 mask"归一成 null：core 的 fromCanvas 一直这么做，画布路径补上这步后
  // 常见手绘画布的单帧快照从 8MB 降到 4MB（见 history.ts 的 normalizeAlphaMask）
  app.art = { ...app.art, indices, palette, alphaMask: normalizeAlphaMask(alphaMask) }
  store.set('hasEdits', true)
  renderAll()
}

function undo(): void {
  if (!app.art) return
  const prev = history.undo(app.art)
  if (!prev) return
  app.art = prev
  resetCanvasTo(prev)
}

function redo(): void {
  if (!app.art) return
  const next = history.redo(app.art)
  if (!next) return
  app.art = next
  resetCanvasTo(next)
}

function resetCanvasTo(art: PixelArt): void {
  canvasApi.setArt(art)
  store.set('hasEdits', history.canUndo)
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

function toast(message: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
  const host = document.getElementById('toasts')
  if (!host) return
  const node = el('div', { class: `toast ${kind}` }, [message])
  host.append(node)
  setTimeout(() => node.remove(), kind === 'error' ? 7000 : 4000)
}

/**
 * 导出动作集中在 `export-actions.ts`（依赖注入，方向单向：这里 → 那边）。
 * 在这里建一次实例，界面各处直接用它。
 */
const exports = createExportActions({
  getArt: () => app.art,
  getParams: () => app.params,
  getSourceName: () => app.sourceName,
  toast,
})

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
    // 这里曾经写 store.set('busy', ...)，但 store.busy 全 app 层没有任何读取者（死状态）；
    // 若要给大图加"处理中"提示，应重新引入并接上 UI，而不是留一个没人读的字段。
    const image = await decodeToRgba(file)
    app.source = image
    app.sourceName = file.name
    app.refImage = await rgbaToImageElement(image)
    // 参考图交给画布：放大镜的"原图对照"要用它。
    // `show=false` —— 只启用放大镜，**不**把原图半透明叠在像素画上（那是"照着描"，要显式开）。
    canvasApi.setReference(app.refImage, false)
    regenerate()
    toast(`已导入 ${file.name}（${image.width}×${image.height}）`)
  } catch (err) {
    toast(`导入失败：${(err as Error).message}`, 'error')
  }
}

/**
 * 把 RGBA 缓冲变成 `<img>`（放大镜按原图取景需要 `naturalWidth/naturalHeight` 与 `drawImage`）。
 *
 * 用 `toBlob` + `createObjectURL` 而不是 `toDataURL`：后者要把整个 PNG 编成 **base64 字符串**
 * 再交给浏览器解析回来，大图上多一份全量字符串的编码与驻留；blob URL 只是一个引用。
 */
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
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('参考图层生成失败（画布尺寸可能超出浏览器上限）')
  const url = URL.createObjectURL(blob)
  const img = new Image()
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('参考图层生成失败'))
      img.src = url
    })
  } finally {
    // 图已解码完成，URL 不必再留着（不撤会一直占着这份 blob）
    URL.revokeObjectURL(url)
  }
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
    /*
     * 合成底色吸管的**去向**：那一侧的取色盘按下吸管时会置一个待办，这里必须消费它——
     * 否则颜色悄悄写进主色，而提示语说的是另回事，界面没有任何错误信号
     * （这正是本项目最忌讳的一类，e2e 有一条真实鼠标断言守在这里）。
     */
    if (matteField.takePendingPick()) {
      const back = pickRestoreTool
      pickRestoreTool = null
      // 一次性动作：取完把工具还原，别让用户莫名停在吸管上（下一次点击又变成取色）
      if (back) store.set('tool', back)
      addRecent(hex)
      patchParams({ matteColor: hex })
      toast(`合成底色已取为 ${hex}`)
      return
    }
    store.setMany({ primary: hex, transparent: false })
    renderAll()
  },
  onHover: (cell) => store.set('hoverText', cell ? `${cell.x}, ${cell.y}` : ''),
  onSelectionChange: (count) => store.set('selectedCount', count),
  onZoom: (pct) => store.set('zoomPct', pct),
  // 画布层没有 toast，需要提示时（目前只有"色板已满用了近似色"）从这里注入
  onNotice: (message) => toast(message, 'warn'),
})
canvasApi.attachMagnifier(magBox, magCanvas)

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

/**
 * 工具按钮的图标。`icon` 是字符兜底，`svg` 指定时优先用内联 SVG。
 *
 * 取色用 SVG 吸管：Unicode 里没有吸管符号，原先用 `⌖`（准星）——
 * 用户反馈"看上去不像吸管"。图标语义错了会让人根本找不到这个工具。
 */
const TOOL_META: Record<string, { icon: string; svg?: 'eyedropper'; name: string; key: string }> = {
  pencil: { icon: '✎', name: '画笔', key: 'B' },
  selection: { icon: '⬚', name: '选区', key: 'M' },
  bucket: { icon: '▨', name: '填充', key: 'G' },
  picker: { icon: '⌖', svg: 'eyedropper', name: '取色', key: 'I' },
  rect: { icon: '▭', name: '矩形', key: 'U' },
  ellipse: { icon: '◯', name: '椭圆', key: 'O' },
}

function renderTools(): void {
  clear(leftRail)
  const grid = el('div', { class: 'tool-grid' })
  for (const id of TOOLS) {
    const meta = TOOL_META[id]
    const active = store.get('tool') === id
    const btn = el('button', {
      class: `tool-btn${active ? ' active' : ''}`,
      'aria-pressed': active ? 'true' : 'false',
      title: `${meta.name}（${meta.key}）`,
      onclick: () => {
        store.set('tool', id)
        renderAll()
      },
    })
    const svg = meta.svg ? iconEl(meta.svg) : null
    if (svg) btn.append(svg)
    else btn.append(document.createTextNode(meta.icon))
    btn.append(el('span', { class: 'tool-name' }, [meta.name]))
    grid.append(btn)
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

/** 左侧取色器编辑的两路**绘制色**（合成底色不走这里，它是 `matte-field.ts` 里的独立实例） */
type PickerTarget = 'primary' | 'bg'

let pickerTarget: PickerTarget = 'primary'
function openPicker(target: PickerTarget): void {
  pickerTarget = target
  store.set('showPicker', true)
  renderAll()
}

/** 主色 / 背景色的取色器实例（挂在左侧色板列里，见 ui/colorpicker.ts） */
let picker: ColorPickerApi | null = null
/**
 * 进吸管之前正在用的工具。吸管是**一次性**动作（提示语就是"点一格"），
 * 取完/取消后还原，否则用户会莫名停在吸管上——下一次点击又变成取色，而不是继续画。
 */
let pickRestoreTool: string | null = null

/** 取色器当前编辑的那路颜色的值（创建实例与每次 update 都用它，避免两处各写一遍判断） */
function currentPickerValue(): string {
  return pickerTarget === 'primary' ? store.get('primary') : store.get('bg')
}

/** 预览（拖动中每帧都会调）：只改状态，**不重转管线** */
function applyPickerPreview(target: PickerTarget, hex: string): void {
  if (target === 'primary') store.set('primary', hex)
  else store.set('bg', hex)
  renderAll()
}

/** 提交（松手 / 输入 / 点色块）：一次拖动进一条撤销 */
function applyPickerCommit(target: PickerTarget, hex: string): void {
  if (target === 'primary') {
    store.setMany({ primary: hex, transparent: false })
    addRecent(hex)
  } else {
    store.setMany({ bg: hex, transparent: false })
  }
  renderAll()
  canvasApi.redraw()
}

/** 左侧取色器（主色 / 背景色）的一套回调；`getTarget` 让回调自己知道在编辑哪一路颜色 */
function pickerCallbacks(getTarget: () => PickerTarget): ColorPickerCallbacks {
  return {
    onPreview: (hex) => applyPickerPreview(getTarget(), hex),
    onCommit: (hex) => applyPickerCommit(getTarget(), hex),
    onTransparent: () => {
      store.setMany({ transparent: true, tool: 'pencil' })
      renderAll()
    },
    // Alpha 滑条右半边：实时恢复实色（拖动中的预览，松手由 onCommit 收尾）。
    // 特意不换 tool——用户可能正拿着填充/形状工具，切回实色不该顺手把工具改成画笔。
    onOpaque: () => {
      store.set('transparent', false)
      renderAll()
    },
    isTransparent: () => store.get('transparent'),
    onPickFromCanvas: () => {
      pickRestoreTool = store.get('tool')
      store.set('tool', 'picker')
      toast('吸管已就绪：到画布上点一格即可取色（Esc 取消）')
      renderAll()
    },
    onClose: () => {
      store.set('showPicker', false)
      renderAll()
    },
  }
}

/**
 * 合成底色字段（含就地展开的取色盘）。状态与三条踩坑记录都搬进了 `matte-field.ts`：
 * 那几个变量原先既被这里的渲染读、又被控件闭包写，正是"拆参数面板"上一轮失败的原因。
 *
 * deps 全是延迟调用的闭包（`patchParams` / `renderAll` / `addRecent` 都是提升的函数声明），
 * 因此此刻创建不会碰到未初始化的绑定；画布的 `onPickColor` 引用它也是同一个道理
 * （真正调用发生在用户点击时，那时模块早已求值完毕）。
 */
const matteField = createMatteField({
  getValue: () => app.params.matteColor,
  preview: (hex) => {
    app.params = { ...app.params, matteColor: hex }
    renderAll()
  },
  commit: (hex) => {
    addRecent(hex)
    // 预览期刻意没重转，这里补上那一次（patchParams 在有原图时会走 regenerate）
    patchParams({ matteColor: hex })
  },
  groups: () => pickerGroups(),
  armPick: () => {
    pickRestoreTool = store.get('tool')
    store.set('tool', 'picker')
    toast('吸管已就绪：到画布点一格，颜色会填到「合成底色」（Esc 取消）')
    renderAll()
  },
  rerender: () => renderAll(),
  isTransparent: () => store.get('transparent'),
  setTransparent: () => {
    store.setMany({ transparent: true, tool: 'pencil' })
    renderAll()
  },
  setOpaque: () => {
    store.set('transparent', false)
    renderAll()
  },
})

function ensurePicker(host: HTMLElement): ColorPickerApi {
  if (!picker) {
    picker = createColorPicker(
      host,
      { target: pickerTarget, value: currentPickerValue(), groups: pickerGroups() },
      pickerCallbacks(() => pickerTarget),
    )
  }
  return picker
}

/** 取色器下方的色板分组：本图用色 + 最近使用 + 当前预置色卡 */
function pickerGroups(): { name: string; colors: string[] }[] {
  const rows = readRecents()
  const preset = getPreset(app.params.presetPaletteId)
  const work = app.art?.palette ?? []
  // 曾经在这里额外硬编码一个 'PICO-8' 组：当 presetPaletteId 本身就是 pico8 时，
  // 会渲染出两行同名同色的色块（重复）。预置色卡由上面的"预置"组表达即可。
  return [
    { name: '本图', colors: work.slice(0, 32) },
    { name: '最近', colors: rows.slice(0, 16) },
    { name: preset?.name ?? '预置', colors: (preset?.colors ?? []).slice(0, 32) },
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
      value: currentPickerValue(),
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
/**
 * 自定义 / .hex 色板编辑区。
 *
 * 为什么需要它：`paletteMode: 'custom'` 与 `customPalette` 一直是 core 与 CLI/页内 API 支持的能力
 * （CLI 的 `--palette xxx.hex` 就是走它），但**参数面板从来没有对应控件**——
 * 《使用说明》却写了"支持导入 .hex"，于是用户选中"自定义 / .hex"后什么也做不了，
 * 转换还静默按自动取色进行。这是"文档说支持、界面不支持"的典型，测试报告里列为 P1。
 *
 * 输入兼容两种 .hex 行式（见 core/palettes.ts 的 parseHexPalette）：
 *   `#rrggbb` 每行一个；或 `S12 #ff8800` 两列带号色（拼豆图纸用）。
 */
function renderCustomPaletteField(p: ConvertParams): HTMLElement {
  const count = p.customPalette.length
  const fileInput = el('input', {
    type: 'file',
    accept: '.hex,.txt,text/plain',
    style: { display: 'none' },
    onchange: (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0]
      ;(e.target as HTMLInputElement).value = ''
      if (!f) return
      void f.text().then((text) => {
        const parsed = parseHexPalette(text)
        if (parsed.colors.length === 0) {
          toast('这个文件里没有解析出颜色（需要每行一个 #rrggbb，或「编号 #rrggbb」两列）', 'warn')
          return
        }
        patchParams({ paletteMode: 'custom', customPalette: parsed.colors })
        toast(`已载入 ${parsed.colors.length} 个颜色${parsed.truncated ? `（超出 256 的部分已截断）` : ''}${parsed.skipped ? `，跳过 ${parsed.skipped} 行无法解析的内容` : ''}`)
      })
    },
  })

  const textarea = el('textarea', {
    class: 'hex-textarea',
    spellcheck: 'false',
    rows: '5',
    placeholder: '#0f380f\n#306230\n或带号色：S12 #ff8800',
    onchange: (e: Event) => {
      const parsed = parseHexPalette((e.target as HTMLTextAreaElement).value)
      if (parsed.colors.length === 0) {
        toast('没有解析出颜色：每行一个 #rrggbb，或「编号 #rrggbb」两列', 'warn')
        return
      }
      patchParams({ customPalette: parsed.colors })
      toast(`自定义色板已更新为 ${parsed.colors.length} 色`)
    },
  })

  const row = el('div', { class: 'row wrap' })
  row.append(
    el('button', { class: 'btn tiny', type: 'button', onclick: () => fileInput.click() }, ['导入 .hex 文件']),
    el('button', {
      class: 'btn tiny',
      type: 'button',
      title: '把当前画布色板填进上面的输入框（便于改几个色再导入）',
      disabled: app.art ? false : true,
      onclick: () => {
        if (!app.art) return
        textarea.value = serializeHexPalette(app.art.palette).trim()
        toast('已填入当前画布色板，改完按回车（或在别处点一下）生效')
      },
    }, ['填入当前画布色板']),
    el('button', {
      class: 'btn tiny',
      type: 'button',
      disabled: count === 0 ? true : false,
      onclick: () => {
        textarea.value = ''
        patchParams({ customPalette: [] })
      },
    }, ['清空']),
  )

  textarea.value = count > 0 ? serializeHexPalette(p.customPalette).trim() : ''

  return el('div', { class: 'field-inner' }, [
    el('span', { class: 'hint' }, [
      count > 0
        ? `当前自定义色板：${count} 色（超 256 截断，空色板会退回自动取色）`
        : '⚠ 自定义色板为空：此时会退回「自动取色」，请在下面输入颜色或导入 .hex 文件',
    ]),
    textarea,
    row,
    el('span', { class: 'hint' }, ['每行一个 #rrggbb；也可用「编号 #rrggbb」两列（拼豆号色，图纸与清单会带上编号）']),
    fileInput,
  ])
}

/** 预设「管理」区是否展开。模块级持有：面板每次 render 都重建，状态不能放在渲染函数里 */
let presetEditorOpen = false

/**
 * 套用预设 = **替换**，不是合并。
 *
 * 旧实现（模式与预设都）用 `patchParams(preset.params)` 合并进当前参数，于是上一个预设留下的
 * `exactWidth/exactHeight`、`lockPalette` 会残留——换预设后尺寸/锁色板并不是你选的那个
 * （实测：拼豆→游戏资产→图片，最后仍带着 exact 32×32 与锁色板）。以**出厂默认**为基底再叠预设，
 * 结果就只取决于"点了哪个预设"。
 */
function applyPreset(params: Partial<ConvertParams>): void {
  app.params = coerceParams({ ...DEFAULT_PARAMS, ...params })
  if (app.source) regenerate()
  else renderAll()
}

/** 当前参数的快照（自定义色板要复制，否则存下来的预设会跟着后续编辑一起变） */
function presetSnapshot(): ConvertParams {
  return { ...app.params, customPalette: [...app.params.customPalette] }
}

function saveCurrentAsPreset(): void {
  const input = prompt('新预设名称（会出现在右侧预设里）', '我的预设')
  if (input === null) return
  const name = input.trim()
  if (!name) {
    toast('预设名称不能为空', 'warn')
    return
  }
  const created = addCustomPreset(name, presetSnapshot())
  if (!created) {
    toast('自定义预设已达数量上限，请先删掉几个', 'warn')
    return
  }
  toast(`已保存预设「${created.name}」`)
  renderAll()
}

/**
 * 预设区：一排 chip（点击套用）+ 一行动作（存为预设 / 管理预设）。
 *
 * 「管理」默认收起——预设是"一次点一个"的控件，把更新/恢复出厂/删除全铺开会把面板压得很长。
 * 展开后每个预设一行：内置可「用当前参数更新」「恢复出厂」，自定义可「更新」「删除」。
 */
function renderPresetSection(): void {
  const presets = effectivePresets()
  // 当前参数正好等于某个预设时高亮它——不然用户看不出"我现在用的是哪套"
  const activeId = presets.find((ps) => sameParams(ps.params, app.params))?.id ?? ''

  paramsPanel.append(el('div', { class: 'panel-title' }, ['预设']))
  const row = el('div', { class: 'row wrap preset-row' })
  for (const ps of presets) {
    row.append(
      el('button', {
        class: `btn small preset-chip${ps.builtin ? '' : ' custom'}${ps.modified ? ' modified' : ''}${activeId === ps.id ? ' active' : ''}`,
        title: `${ps.desc}${ps.modified ? '\n（已按你的参数改过）' : ''}\n点击套用；要改它请用下面的「管理预设」`,
        onclick: () => applyPreset(ps.params),
      }, [ps.builtin ? ps.name : `★ ${ps.name}`]),
    )
  }
  paramsPanel.append(row)

  const bar = el('div', { class: 'row wrap preset-bar' })
  bar.append(
    el('button', { class: 'btn tiny', title: '把当前面板里的参数存成一个新预设（可命名、可删除）', onclick: saveCurrentAsPreset }, ['＋ 存为预设']),
    el('button', { class: 'btn tiny', onclick: () => { presetEditorOpen = !presetEditorOpen; renderAll() } }, [presetEditorOpen ? '收起管理 ▴' : '管理预设 ▾']),
  )
  paramsPanel.append(bar)

  if (!presetEditorOpen) return
  const list = el('div', { class: 'preset-editor' })
  for (const ps of presets) {
    list.append(
      el('div', { class: 'preset-line' }, [
        el('span', { class: 'preset-line-name', title: ps.desc }, [`${ps.name}${ps.modified ? ' ·已改' : ''}`]),
        el('button', {
          class: 'btn tiny',
          title: '把当前面板里的参数写回这个预设',
          onclick: () => {
            updatePreset(ps.id, presetSnapshot())
            toast(`已用当前参数更新「${ps.name}」`)
            renderAll()
          },
        }, ['用当前参数更新']),
        ps.builtin
          ? el('button', {
              class: 'btn tiny',
              disabled: !ps.modified,
              title: '丢弃你的改动，恢复出厂参数',
              onclick: () => {
                resetPreset(ps.id)
                toast(`「${ps.name}」已恢复出厂`)
                renderAll()
              },
            }, ['恢复出厂'])
          : el('button', {
              class: 'btn tiny',
              title: '删除这个自定义预设',
              onclick: () => {
                removeCustomPreset(ps.id)
                toast(`已删除预设「${ps.name}」`)
                renderAll()
              },
            }, ['删除']),
      ]),
    )
  }
  paramsPanel.append(list)
}

/**
 * 从「精确尺寸」切回「长边格数」：**必须显式删掉这两个字段**。
 * 留着它们时 `computeGridSize` 会用精确尺寸（exact 优先于 longEdge），
 * 于是长边控件看起来调了却没效果——实测踩过，所以单独一个函数、不走 patchParams。
 */
function clearExactSize(): void {
  const next = { ...app.params }
  delete next.exactWidth
  delete next.exactHeight
  app.params = next
  if (app.source) regenerate()
  else renderAll()
}

function renderParams(): void {
  // 只移除面板自己的子节点，**保留合成底色字段**（它含取色盘宿主，必须跨渲染存活，
  // 否则拖动中指针捕获会断、手感全失）——见 matte-field.ts 顶部第 2 条坑
  for (const child of [...paramsPanel.children]) {
    if (child !== matteField.element) child.remove()
  }
  const p = app.params

  renderPresetSection()

  paramsPanel.append(el('div', { class: 'panel-title' }, ['转换参数']))

  /**
   * 一行参数：标签 + 控件 + 提示。
   * `forId` 可选：给了就把标签关联到那个控件——`<label for>` 对 `<button>` 同样有效，
   * 于是"点标签也能触发"（用户点"合成底色"那四个字而没点色块是很常见的）。
   */
  const field = (label: string, control: HTMLElement, hint?: string, forId?: string) =>
    el('div', { class: 'field' }, [
      el('label', forId ? { for: forId } : {}, [label]),
      control,
      hint ? el('span', { class: 'hint' }, [hint]) : null,
    ])

  // 尺寸：**一套控件管两种方式**。「精确尺寸」时写入 exactWidth/Height，「长边」时显式删除（见 clearExactSize）
  const exactW = p.exactWidth ?? 0
  const exactH = p.exactHeight ?? 0
  const exact = exactW > 0 && exactH > 0
  paramsPanel.append(
    field(
      '尺寸方式',
      selectInput(
        exact ? 'exact' : 'long',
        [
          ['long', '长边格数（按比例）'],
          ['exact', '精确尺寸 W×H'],
        ],
        (v) => {
          if (v === 'exact') {
            const side = Math.max(1, Math.min(2048, Math.min(58, p.longEdge) || 32))
            patchParams({ exactWidth: exact ? exactW : side, exactHeight: exact ? exactH : side })
          } else {
            clearExactSize()
          }
        },
      ),
      exact ? '帧尺寸恒等，引擎侧无需二次对齐' : '短边按原图宽高比取整',
    ),
  )
  if (exact) {
    paramsPanel.append(
      field(
        '画布尺寸（格）',
        el('div', { class: 'row' }, [
          numberInput(exactW, 1, 2048, (v) => patchParams({ exactWidth: v, exactHeight: exactH })),
          el('span', {}, ['×']),
          numberInput(exactH, 1, 2048, (v) => patchParams({ exactWidth: exactW, exactHeight: v })),
        ]),
        '常见：拼豆方板 58×58（29×29 孔）· 游戏资产 16/24/32/48/64/128',
      ),
    )
    const quick = el('div', { class: 'row wrap' })
    for (const n of [16, 24, 32, 48, 58, 64, 96, 128]) {
      quick.append(el('button', { class: `btn tiny${exactW === n && exactH === n ? ' active' : ''}`, onclick: () => patchParams({ exactWidth: n, exactHeight: n }) }, [`${n}²`]))
    }
    paramsPanel.append(quick)
  } else {
    paramsPanel.append(field('长边格数', numberInput(p.longEdge, 8, 2048, (v) => patchParams({ longEdge: v })), `${p.longEdge} 格`))
    const quick = el('div', { class: 'row wrap' })
    for (const n of [16, 32, 48, 64, 96, 128, 256, 512]) {
      quick.append(el('button', { class: `btn tiny${p.longEdge === n ? ' active' : ''}`, onclick: () => patchParams({ longEdge: n }) }, [String(n)]))
    }
    paramsPanel.append(quick)
  }

  // 裁剪比例：core 与 CLI（--crop）一直支持，但参数面板此前没有入口——
  // 用户只能靠 CLI/API 设置（测试报告 B6）。这里补上四档选择。
  paramsPanel.append(
    field(
      '裁剪比例',
      selectInput(
        p.cropRatio,
        [
          ['free', '保持原比例'],
          ['1:1', '1:1 方形'],
          ['4:3', '4:3'],
          ['16:9', '16:9'],
        ],
        (v) => patchParams({ cropRatio: v as ConvertParams['cropRatio'] }),
      ),
      '按所选比例从中心裁剪原图（拼豆常用 1:1，游戏资产常用 1:1）',
    ),
  )

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
  if (p.paletteMode === 'custom') {
    paramsPanel.append(renderCustomPaletteField(p))
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
    /*
     * 合成底色用**自家取色盘**，不用原生 `<input type="color">`：原生控件会弹出操作系统的调色板
     * （Windows 那个带吸管的弹窗），外观与本工具的取色器完全两回事，也没法用"本图用色 / 最近 / 预置色卡"。
     *
     * 字段本身（含就地展开的取色盘）由 `matte-field.ts` 的工厂负责：它持有那 5 个必须跨渲染
     * 存活的状态。这里只做两件事——**把稳定的 `element` 放回序列中的位置**，再让它同步一次外观。
     * `element` 是同一个节点（只创建一次），所以拖动中的指针捕获不会因为重渲染而断。
     */
    paramsPanel.append(matteField.element)
    matteField.render()
  } else {
    // 切到「真 alpha」后这个字段会消失，把就地的取色器一起收掉，别留下孤儿宿主
    matteField.collapseForAlpha()
  }
  // 锁定色板对三种用途都成立（拼豆/资产批次），因此常显，不再按"模式"藏起来
  paramsPanel.append(field('锁定色板', checkbox(!!p.lockPalette, (v) => patchParams({ lockPalette: v })), '只用给定色板，绝不新增颜色（拼豆/资产批次必备）'))

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
      // 「空白画布」只挂在导出菜单里时，新用户找不到入口（他们会直接找「新建」，而那个按钮
      // 在没有画布时是灰的）。这里给出显式按钮——空状态本来就是"你还没有画布"的求助界面。
      el('div', { class: 'empty-actions' }, [
        el(
          'button',
          {
            class: 'btn act',
            type: 'button',
            'data-testid': 'empty-new-blank',
            onclick: () => makeBlank(),
          },
          ['✚ 新建空白画布'],
        ),
        el(
          'button',
          {
            class: 'btn',
            type: 'button',
            'data-testid': 'empty-import',
            onclick: () => fileInput?.click(),
          },
          ['导入图片…'],
        ),
      ]),
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

/* ------------------------------------------------------------------ 顶栏装配 */

/**
 * 顶栏只构建一次，之后只更新按钮的可用状态。
 *
 * 为什么不在每次 render 里重建：导出菜单是展开/收起状态机，重建会把菜单状态一起冲掉
 * （点开菜单 → 触发一次渲染 → 菜单消失）。这里把"结构"与"状态"分开：
 * 结构在 boot 时建好，render 只调 updateHeaderState()。
 */
function buildHeader(): void {
  const actionsHost = document.getElementById('header-actions') as HTMLElement | null
  const importBtn = document.getElementById('btn-import') as HTMLButtonElement | null
  const exportBtn = document.getElementById('btn-export') as HTMLButtonElement | null
  const menu = document.getElementById('export-menu') as HTMLElement | null
  const anchor = document.getElementById('export-anchor') as HTMLElement | null
  if (!actionsHost || !importBtn || !exportBtn || !menu || !anchor) {
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

  /*
   * 左侧原来还有一个「工作模式」选择器（图片→像素 / 拼豆图纸 / 游戏资产），现已移除：
   * 它与右侧的「预设」是同一类东西（都只是"往参数里套一小组值"），却各写一套、内容还不一致
   * （旧模式漏设 cleanup、图片模式是空对象、切换会互相残留参数）。现在三个用途由预设承担，
   * 顶栏左侧只剩品牌。相应的 e2e 断言也一并更新（原来是"左侧必须有 3 个选项的模式选择器"）。
   */

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
      title: '新建：还没有画布时直接建一张空白画布；已有画布时清空重来',
      'aria-label': '新建',
      onclick: () => {
        /*
         * 「新建」在没有画布时曾经是**禁用**的（updateHeaderState 里 `!art && !src`），
         * 于是第一次打开工作台的人卡在空状态：唯一的"新建空白画布"入口藏在
         * 「导出 ▾」菜单里，而"导出"这个词不会让人想到"新建"。现在改成：
         *  - 已有画布 → 确认后清空（原行为，仍是"清空与素材，重新开始"）
         *  - 还没有画布 → 直接建空白画布，按钮不再是死路
         */
        if (!app.art && !app.source) {
          makeBlank()
          return
        }
        if (!confirm('清空当前画布？未导出的内容会丢失。')) return
        app.art = null
        app.source = null
        app.sourceName = ''
        app.refImage = null
        canvasApi.setReference(null, false)
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

  /*
   * ---- 侧栏折叠开关：**浮在栏外的画布边上**（画布左上角 / 右上角，紧贴对应侧栏）----
   *
   * 图标是**三角形箭头**，指向"点下去会往哪收"：左栏展开时是 ◀（往左收）、收起后是 ▶（往右展开）；
   * 右栏对称（展开 ▶ / 收起 ◀）。
   *
   * 为什么放栏外而不是栏内：栏内的话面板一 `display:none` 开关就跟着没了，只能让面板收成
   * 一条窄边来"顺便"留住开关（空窄边还会白占宽度）。浮在栏外则面板可以真正收干净，
   * 开关永远在原地——栏收起后它自然贴到画布/屏幕边缘。
   *
   * CSS 按宽度决定"展开"长什么样（桌面=常驻列 / 窄屏=浮层抽屉），JS 只维护两个布尔量。
   */
  const drawerToolsBtn = document.getElementById('btn-drawer-tools') as HTMLButtonElement | null
  const drawerPanelBtn = document.getElementById('btn-drawer-panel') as HTMLButtonElement | null
  const scrim = document.getElementById('drawer-scrim') as HTMLElement | null

  if (drawerToolsBtn && drawerPanelBtn) {
    drawerToolsBtn.dataset.testid = 'drawer-tools'
    drawerPanelBtn.dataset.testid = 'drawer-panel'

    const NARROW = 980
    const isNarrow = (): boolean => window.innerWidth <= NARROW
    /*
     * 每一侧一个布尔量，**两侧各自独立**，跨 renderAll 保留。
     *
     * 这里原先是单个 'none' | 'tools' | 'panel' 三值状态，导致四个组合里有一个**不可达**：
     * 收起了工具列再收参数列时，赋值 'panel' 顺手把 'no-rail' 摘掉了，
     * 于是"想关第二个、第一个又弹回来"——用户看到的就是这个现象。
     * 两个布尔量才能表达"两边都收起"。
     */
    let railHidden = isNarrow()
    let panelHidden = isNarrow()
    let wasNarrow = isNarrow()

    /** 三角形箭头 + 提示：展开时指向收纳方向，收起后指向展开方向 */
    const updateRailToggle = (): void => {
      const set = (btn: HTMLButtonElement, hidden: boolean, what: string, expandArrow: string, collapseArrow: string): void => {
        btn.textContent = hidden ? expandArrow : collapseArrow
        btn.title = `${hidden ? '展开' : '收起'}${what}`
        btn.setAttribute('aria-label', btn.title)
        btn.setAttribute('aria-pressed', hidden ? 'false' : 'true')
      }
      // 左栏：展开 ◀（往左收）/ 收起 ▶（往右展开）
      set(drawerToolsBtn, railHidden, '工具与色板面板', '▶', '◀')
      // 右栏：展开 ▶（往右收）/ 收起 ◀（往左展开）
      set(drawerPanelBtn, panelHidden, '参数面板', '◀', '▶')
    }

    /**
     * 把两个布尔量写进 body 的类，呈现方式交给 CSS：
     *  - 桌面（>980）：展开 = 常驻列；收起 = 整栏隐藏（箭头浮在栏外，不受影响）。
     *  - 窄屏（≤980）：展开 = 浮层抽屉 + 遮罩；收起 = 隐藏。
     * 两种宽度下都是"同一个箭头、同一个开合动作"，用户只需要一套心智模型。
     */
    const applyRails = (): void => {
      const narrow = isNarrow()
      const anyOpen = !railHidden || !panelHidden
      document.body.classList.toggle('no-rail', railHidden)
      document.body.classList.toggle('no-panel', panelHidden)
      document.body.classList.toggle('drawer-tools', narrow && !railHidden)
      document.body.classList.toggle('drawer-panel', narrow && !panelHidden)
      document.body.classList.toggle('drawer-open', narrow && anyOpen)
      document.body.dataset.drawer = railHidden && panelHidden ? 'none' : !railHidden ? 'tools' : 'panel'
      if (scrim) scrim.hidden = !(narrow && anyOpen)
      updateRailToggle()
      // 开合会改变画布可视区域：重绘一次，别让画布停在屏幕外
      canvasApi.redraw()
    }

    const toggleTools = (): void => {
      railHidden = !railHidden
      // 窄屏一次只开一个：两个浮层同时开出来会互相遮挡
      if (isNarrow() && !railHidden) panelHidden = true
      applyRails()
    }
    const togglePanel = (): void => {
      panelHidden = !panelHidden
      if (isNarrow() && !panelHidden) railHidden = true
      applyRails()
    }
    const collapseAll = (): void => {
      railHidden = true
      panelHidden = true
      applyRails()
    }

    drawerToolsBtn.addEventListener('click', toggleTools)
    drawerPanelBtn.addEventListener('click', togglePanel)
    scrim?.addEventListener('click', collapseAll)
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isNarrow() && (!railHidden || !panelHidden)) collapseAll()
    })
    /*
     * 跨过 980px 阈值时重置成该宽度下的合理初值：窄屏两侧都收起（浮层会盖住画布），
     * 回桌面两侧都展开。只认"跨阈值"，不在每次 resize 都动——否则用户拖窗口时会把
     * 自己刚收/刚开的状态一次次抹掉。
     */
    window.addEventListener('resize', () => {
      const narrow = isNarrow()
      if (narrow !== wasNarrow) {
        wasNarrow = narrow
        railHidden = narrow
        panelHidden = narrow
      }
      applyRails()
    })
    applyRails()
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
      void exports.exportPNG(1)
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
          void exports.exportPNG(s)
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
      exports.exportBeadFiles()
    }, { disabled: !hasArt, testid: 'export-bead' }),
    item('可打印图纸 PDF（A4 分页）', '每块板一页，含号色与图例；打印/送人比 SVG 稳', () => {
      closeExportMenu()
      void exports.exportBeadPdf()
    }, { disabled: !hasArt, testid: 'export-bead-pdf' }),
  )

  menu.append(el('div', { class: 'dropdown-group' }, ['数据']))
  menu.append(
    item('像素数据 JSON', '每格颜色 + 每色用量表（原料清单）', () => {
      closeExportMenu()
      exports.exportPixelJSON()
    }, { disabled: !hasArt }),
    item('色板 .hex', '当前画布用到的颜色，可导入 Lospec 等工具', () => {
      closeExportMenu()
      exports.exportPaletteHex()
    }, { disabled: !hasArt }),
    item('项目 JSON', '参数 + 色板 + 像素，不含原图，可分享继续编辑', () => {
      closeExportMenu()
      exports.exportProject()
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
  if (undoBtn) undoBtn.disabled = !history.canUndo
  if (redoBtn) redoBtn.disabled = !history.canRedo
  if (regenerateBtn) regenerateBtn.disabled = !app.source
  // 「新建」不再因"没有画布"而禁用——那是第一次使用时的死路（点不动、又找不到别的入口）。
  // 它的语义随之变成"没有画布就直接建一张，有画布才确认清空"，见顶栏按钮的 onclick。
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
    ['点主色/背景色块', '打开取色器（Blender 结构：色轮 + 明度条 + RGB/HSV 两段 + 红/绿/蓝、Alpha 滑条 + Hex 行）'],
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
    void exports.exportPNG(1)
    return
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return
  /*
   * 吸管提示语里承诺了「Esc 取消」，这里必须兑现（否则又是一句空头承诺）：
   * 退出取色、还原进吸管前的工具，并清掉"取到的颜色写进合成底色"的待办标记。
   */
  if (k === 'escape' && store.get('tool') === 'picker') {
    store.set('tool', pickRestoreTool ?? 'pencil')
    pickRestoreTool = null
    matteField.clearPendingPick()
    renderAll()
    return
  }
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
    timer = window.setTimeout(() => writePrefs(s), PREFS_DEBOUNCE_MS)
  })

  /**
   * 状态栏的实时刷新。
   *
   * 这几个字段（选区格数 / 悬停坐标 / 缩放百分比 / 已复制）由画布回调直接写进 store，
   * 不经过任何 `renderAll()`，所以原先**要等下一次无关重绘才会显示**：表现为"框选后状态栏
   * 没有已选格数、悬停没有坐标、滚轮缩放后百分比不动"（测试报告 P2-04）。
   * 这里只重绘状态栏而不是 renderAll，保持 store「按 key 精确通知」的既定性能设计。
   */
  store.subscribe(['selectedCount', 'hoverText', 'zoomPct', 'clipboardHas', 'hasEdits'], () => {
    renderStatusbar()
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
    // 注意：canvas 编码路径与 core/raster.ts 共用同一份 artToImageData，键控语义一致
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
    // 供 getInfo().hasEdits 读取真值（此前 API 写死 false，编辑后仍报 false，属主动误导）
    hasEdits: () => store.get('hasEdits'),
    resetEdits: () => store.set('hasEdits', false),
    /**
     * 从 params 推导空白画布规格：UI 的 makeBlank 与 API 的 newCanvas 共用同一份规则。
     * 此前两者各有一套（尺寸推导相同，但底色一个用 matteColor、一个默认 #000000），行为已分叉。
     */
    blankSpec: () => {
      const w = app.params.exactWidth ?? Math.min(58, app.params.longEdge)
      const h = app.params.exactHeight ?? Math.min(58, app.params.longEdge)
      return { width: w, height: h, color: app.params.matteColor, transparent: app.params.transparent === 'alpha' }
    },
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
// 供自动化接口与调试使用（`history` 暴露出来是为了让 e2e 能断言"双上限真的生效"）
;(window as unknown as { __app?: unknown }).__app = { app, store, canvasApi, history }
