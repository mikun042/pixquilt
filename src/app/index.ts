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
import { DEFAULT_PARAMS, DEFAULT_PREFS, TOOLS, sanitizePrefs, type ConvertParams, type EditorPrefs, type PixelArt } from '../core/types.ts'
import { getPreset } from '../core/palettes.ts'
import { PREFS_DEBOUNCE_MS } from '../core/limits.ts'
import { createExportActions } from './export-actions.ts'
import { artToPngBlob, artToPngDataURL, artToPngDataURLSync } from './canvas-png.ts'
import { runPipeline } from '../core/pipeline.ts'
import { blankArt } from '../core/ops.ts'
import { artStats } from '../core/stats.ts'
import { colorTextOn } from '../core/color.ts'
import { clear, el, store } from './store.ts'
import { decodeToRgba, imageFromClipboard, makeThumbnail, looksLikeImage } from './decode.ts'
import { createCanvas } from './ui/canvas.ts'
import { createColorPicker, type ColorPickerApi, type ColorPickerCallbacks } from './ui/colorpicker.ts'
import { createMatteField } from './matte-field.ts'
import { createParamsPanel } from './ui/params-panel.ts'
import { createHeader } from './ui/header.ts'
import { iconEl } from './ui/icons.ts'
import { ArtHistory, normalizeAlphaMask } from './history.ts'
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

/**
 * 一次编辑的提交入口（**画布自绘**路径）：画笔 / 油漆桶 / 形状 / 选区操作 / 粘贴走后这条。
 *
 * 画布已经在自己的像素副本上改完了，这里只把拷贝写回模型，**不需要回灌画布**（回灌反而多一次全量拷贝）。
 * 与之相对的"模型发起"路径见下面的 `commitModelArt`：那条必须回灌，否则画布会停在旧像素上。
 */
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

/**
 * 一次编辑的提交入口（**模型发起**路径）：页内 API 的 `ps.edit(ops)` 这类"外部先算出新画布"的调用。
 *
 * 与 `commitWithHistory` 只差一步，但少了那一步曾经丢掉整幅编辑：**画布的像素是另一份副本**
 * （`ui/canvas.ts` 的 `indices`/`palette`/`alpha`）。画布自绘那条路里副本本来就是新的，
 * 所以不必回灌；这条路里副本还是**旧的**，不回灌就会：屏幕不显示这次编辑、画布侧取色
 * （`pickAt`）读到旧像素、并且**下一次画笔把旧副本提交上去，把这次编辑静默覆盖掉**。
 * 详见 docs/ARCHITECTURE.md §8.10 ⑥。
 *
 * 同步用 `applyIndices` 而不是 `setArt`：前者只换像素副本，**保留选区与视图**；后者会清空选区
 * （`ui/canvas.ts` 的 `setArt` 里有 `selection = new Set()`）。只有尺寸真的变了
 * （算子里含 `transform` / `trim`）才走 `setArt`——那种情况必须重算视图。
 */
function commitModelArt(next: PixelArt): void {
  if (!app.art) return
  history.commit(app.art)
  const sizeChanged = app.art.width !== next.width || app.art.height !== next.height
  const alphaMask = normalizeAlphaMask(next.alphaMask ?? null)
  app.art = { ...next, alphaMask }
  if (sizeChanged) canvasApi.setArt(app.art)
  else canvasApi.applyIndices(app.art.indices, app.art.palette, alphaMask)
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

/**
 * 撤销/重做专用：把某一份历史帧放回画布。**不能**重置撤销栈（否则栈自己就没了）。
 * 这两条也是"模型 → 画布"同步路径的一个例子（经 `setArt`）。
 */
function resetCanvasTo(art: PixelArt): void {
  canvasApi.setArt(art)
  store.set('hasEdits', history.canUndo)
  renderAll()
}

/**
 * **整体替换**画布：新画布 = 新基线，因此撤销栈一并清空。
 *
 * 为什么必须清空：撤销栈里存的是**上一张画布**的帧。若不重置，"撤销"会把上一张画布搬回来
 * ——尺寸、内容都可能完全不同，用户看到的是一次莫名其妙的换图（`regenerate` 早就这么做，
 * 注释写着"重新转换 = 新的基线"；`newCanvas` 的注释也写着"新画布 = 新基线"，
 * 但此前只重置了 `hasEdits`，撤销栈漏了——见 docs/ARCHITECTURE.md §8.10 ⑥ 那一族）。
 *
 * 调用方：导入/重转（`regenerate`）、新建空白（`makeBlank`）、清空（`newBlankOrClear`）、
 * 以及页内 API 的 `newCanvas` / `loadProject` / `importPixBin` / `reset`。
 * 唯独 `undo`/`redo` 走 `resetCanvasTo`。
 */
function replaceArt(art: PixelArt | null): void {
  app.art = art
  canvasApi.setArt(art)
  resetHistory()
  store.set('hasEdits', false)
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

/**
 * 写入**整份**参数并决定后续：有原图就重转，没有就重绘。
 *
 * 参数面板（`ui/params-panel.ts`）里"套用预设"与"从精确尺寸切回长边"都需要这个决策，
 * 因此从 `patchParams` 里提出来成为它的一条 dep——**决策留在这一层**，面板只负责收集用户意图。
 */
function commitParams(next: ConvertParams): void {
  app.params = next
  if (app.source) regenerate()
  else renderAll()
}

/** 改一小组参数（原先还带一个 `opts.regenerate`，全仓无人传，已删） */
function patchParams(patch: Partial<ConvertParams>): void {
  commitParams({ ...app.params, ...patch })
}

function regenerate(): void {
  if (!app.source) return
  const t0 = performance.now()
  const { art } = runPipeline(app.source, app.params)
  const ms = Math.round(performance.now() - t0)
  replaceArt(art)
  if (ms > 400) toast(`转换完成（${art.width}×${art.height}，${ms}ms）`)
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
const paramsHost = document.getElementById('panel-params') as HTMLElement
const statusbar = document.getElementById('statusbar') as HTMLElement

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

/**
 * 参数面板（预设区 + 转换参数 + 显示开关），实现在 `src/app/ui/params-panel.ts`。
 * 那边只做渲染，所有状态读写经下面这个 deps 走回来——方向单向：这里 → 那边。
 */
const paramsPanel = createParamsPanel({
  host: paramsHost,
  getParams: () => app.params,
  patch: (patch) => patchParams(patch),
  commitParams: (next) => commitParams(next),
  getArt: () => app.art,
  rerender: () => renderAll(),
  toast,
  getFlag: (key) => store.get(key),
  setFlag: (key, value) => {
    store.set(key, value)
    // 必须顺带重绘：画布是在 draw() 里读这两个开关的，只改 store 会"勾了没反应"（§8.10 ④）
    canvasApi.redraw()
  },
  matte: matteField,
})

/**
 * 顶栏（导入 / 导出菜单 / 撤销重做 / 新建 / 快捷键 / 侧栏开关），实现在 `src/app/ui/header.ts`。
 * 这里只提供动作与只读状态；顶栏内部不碰 `app`，所以「新建」那种会改多处状态的动作，
 * 在这边实现成 `newBlankOrClear()` 一个整体。
 */
const header = createHeader({
  canUndo: () => history.canUndo,
  canRedo: () => history.canRedo,
  hasSource: () => !!app.source,
  hasArt: () => !!app.art,
  hasEdits: () => store.get('hasEdits'),
  transparentMode: () => app.params.transparent,
  undo,
  redo,
  regenerate,
  importFile: (file) => void importFile(file),
  makeBlank,
  newBlankOrClear,
  copyPNG: () => void copyPNG(),
  showHelp,
  rerender: () => renderAll(),
  onLayoutChange: () => canvasApi.redraw(),
  exports,
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
            onclick: () => header.openFilePicker(),
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
  paramsPanel.render()
  renderStatusbar()
  renderEmptyState()
  header.updateState()
  canvasApi.redraw()
}

/**
 * 「新建」的完整语义：**没有画布就直接建一张空白画布**；已有画布则确认后清空重来。
 *
 * 「新建」在没有画布时曾经是**禁用**的（状态更新里 `!art && !src`），于是第一次打开工作台的人
 * 卡在空状态：唯一的"新建空白画布"入口藏在「导出 ▾」菜单里，而"导出"这个词不会让人想到"新建"。
 * 现在这个按钮不再是死路。实现留在这里——它要动 app 的四个字段、参考图层与撤销栈。
 */
function newBlankOrClear(): void {
  if (!app.art && !app.source) {
    makeBlank()
    return
  }
  if (!confirm('清空当前画布？未导出的内容会丢失。')) return
  app.source = null
  app.sourceName = ''
  app.refImage = null
  canvasApi.setReference(null, false)
  replaceArt(null)
  store.setMany({ selectedCount: 0, clipboardHas: false })
}

function makeBlank(): void {
  const w = app.params.exactWidth ?? Math.min(58, app.params.longEdge)
  const h = app.params.exactHeight ?? Math.min(58, app.params.longEdge)
  replaceArt(blankArt(w, h, app.params.matteColor, app.params.transparent === 'alpha'))
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
    ['?', '打开这张速查表'],
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
  } else if (k === '?') {
    /*
     * 顶栏那个「? 快捷键」按钮的 tooltip 一直写着"按 ? 也能打开"，而全仓没有 `?` 的键盘处理——
     * 按了没反应。速查表自己又声明"快捷键以本表为唯一出处"、表里却没有 `?` 这一行，
     * 两处界面互相矛盾。这里兑现 tooltip 那句，并把 `?` 补进表里（见 showHelp 的 rows）。
     */
    showHelp()
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

  header.build()
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
    replaceArt,
    getSource: () => app.source,
    setSource: (img, name) => {
      app.source = img
      app.sourceName = name
    },
    regenerate,
    commitArt: commitModelArt,
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
    /**
     * 从 params 推导空白画布规格：UI 的 makeBlank 与 API 的 newCanvas 共用同一份规则。
     * 此前两者各有一套（尺寸推导相同，但底色一个用 matteColor、一个默认 #000000），行为已分叉。
     */
    blankSpec: () => {
      const w = app.params.exactWidth ?? Math.min(58, app.params.longEdge)
      const h = app.params.exactHeight ?? Math.min(58, app.params.longEdge)
      return { width: w, height: h, color: app.params.matteColor, transparent: app.params.transparent === 'alpha' }
    },
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
