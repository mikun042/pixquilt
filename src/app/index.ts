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
import { DRAFT_DEBOUNCE_MS, DRAFT_VERSION, PREFS_DEBOUNCE_MS } from '../core/limits.ts'
import { createExportActions } from './export-actions.ts'
import { artToPngBlob, artToPngDataURL, artToPngDataURLSync } from './canvas-png.ts'
import { runPipeline } from '../core/pipeline.ts'
import { applyOps, blankArt } from '../core/ops.ts'
import { replacePaletteEntry } from '../core/palette-edit.ts'
import { artStats } from '../core/stats.ts'
import { colorTextOn } from '../core/color.ts'
import { parseProjectFile, projectJSONString } from '../core/export.ts'
import { clear, el, store } from './store.ts'
import { decodeToRgba, imageFromClipboard, makeThumbnail, looksLikeImage } from './decode.ts'
import { createCanvas } from './ui/canvas.ts'
import { createColorPicker, type ColorPickerApi, type ColorPickerCallbacks } from './ui/colorpicker.ts'
import { createMatteField } from './matte-field.ts'
import { createSwatchEditor } from './ui/swatch-editor.ts'
import { createContextMenu } from './ui/context-menu.ts'
import { createParamsPanel } from './ui/params-panel.ts'
import { createHeader } from './ui/header.ts'
import { iconEl, type IconName } from './ui/icons.ts'
import { ArtHistory, normalizeAlphaMask } from './history.ts'
import { clearDraft, createDraftWriter, draftSupported, isUsableDraft, isUsableSource, loadDraft, loadDraftSource } from './storage.ts'
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

/**
 * 自动草稿写入器（防抖落盘 + 可取消）。
 *
 * 挂在**模型层的三个提交点之后**（`commitWithHistory` / `commitModelArt` / `replaceArt`），
 * 不画布侧直接触发——`app.art` 是唯一真源，草稿必须存真源（见 storage.ts 的文件头说明）。
 *
 * `snapshot()` 每次现取：直接读 `app.art` 与 `app.source`，不缓存副本，
 * 否则又会多出"副本与真源不一致"的机会（正是这个项目反复踩的那类问题）。
 */
const draftWriter = createDraftWriter({
  debounceMs: DRAFT_DEBOUNCE_MS,
  version: DRAFT_VERSION,
  snapshot: () => {
    if (!app.art) return null
    return {
      project: projectJSONString(app.art, app.params),
      source: app.source && app.sourceName ? { name: app.sourceName, ...app.source } : null,
    }
  },
  onError: () => {
    /* 配额满 / 存储被禁用：静默降级为"没有草稿"，不影响正在进行的编辑 */
  },
})

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
  draftWriter.schedule()
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
  draftWriter.schedule()
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
  /*
   * 「整体替换 = 新基线」：草稿要跟着换成新内容，**但不能靠"先清后写"**。
   *
   * ## 为什么不能先清草稿
   *
   * 早先的写法是"`clearDraft()` + 排一次防抖写"。实测有个**真实的丢数据窗口**：
   * 用户还没有过任何草稿时（第一次新建/导入）执行"编辑 → 800ms 内刷新"，
   * 盘上是空的（刚被清掉）、新的又还没到点，`pagehide` 里那次 flush 也来不及——
   * 于是**什么都没剩下**。这恰恰是最常见的用法（导入图 → 调两下 → 刷新重来）。
   * 实测：首编辑后等 0/100/300/600ms 再刷新，**四次全部丢失**。
   *
   * 所以改成：**有画布就立刻写一次（`flush`，不等防抖）**，只有 `art === null`
   * （清空 / 重置 / 载入失败）才真的清盘。这样盘上任何时刻都是"最近一次真实基线"。
   *
   * ## 与路线图那个"顺序坑"的关系
   *
   * 坑是"清了草稿、却被排期中的定时器写回旧画布"。这里同时做两件事防它：
   *  ① `cancel()` 先取消上一张画布排的定时器（防线是**这个顺序**，不是 snapshot 现读——
   *     实测把 snapshot 在排期时固化，行为不变，说明起作用的是 cancel+重排）；
   *  ② 此后要么立刻 `flush()`（新内容马上落盘、没有空窗），要么 `clearDraft()`（art 为 null）。
   * 两个分支都不会留下"待写的东西还在飞"的状态。
   */
  draftWriter.cancel()
  if (art) {
    // 立刻落盘，不留"清空了但还没写"的空窗（见上面"为什么不能先清草稿"）
    void draftWriter.flush()
  } else {
    void clearDraft().catch(() => {
      /* 存储不可用（无痕/配额满）：草稿功能降级，不影响正常使用 */
    })
  }
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
 * 现状（2026-09-15）：**6 个工具已全部换成图标**（画笔/填充/矩形/椭圆/选区是像素格，
 * 取色是手绘 SVG 吸管）。字符只作为 `iconEl` 返回 null 时的兜底保留。
 *
 * 改图标形状请改 `tool/icons/` 里的形状定义（**不要改这里的 path 数据**，
 * 那是生成物），详见 `tool/icons/README.md`。
 *
 * 取色用 SVG 吸管：Unicode 里没有吸管符号，原先用 `⌖`（准星）——
 * 用户反馈"看上去不像吸管"。图标语义错了会让人根本找不到这个工具。
 *
 * ⚠️ **`picker.name` 不要改**：`e2e-pdf.mjs` 靠 `title.includes('取色')` 定位这个按钮，
 * 而 title 由 `name` 拼出。改成"吸管"会让那条断言报"工具条里找不到取色工具"。
 */
const TOOL_META: Record<string, { icon: string; svg?: IconName; name: string; key: string }> = {
  pencil: { icon: '✎', svg: 'pencil', name: '画笔', key: 'B' },
  selection: { icon: '⬚', svg: 'selection', name: '选区', key: 'M' },
  bucket: { icon: '▨', svg: 'bucket', name: '填充', key: 'G' },
  // 取色保留手绘曲线的吸管：Unicode 里没有吸管符号，而它经多轮截图校准、并被两条断言锁着
  picker: { icon: '⌖', svg: 'eyedropper', name: '取色', key: 'I' },
  rect: { icon: '▭', svg: 'rect', name: '矩形', key: 'U' },
  ellipse: { icon: '◯', svg: 'ellipse', name: '椭圆', key: 'O' },
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
  // 只有"正在编辑的那一路"才提示"点击收起"——另一路点下去是切换编辑目标，不是收起
  const pickerOpen = store.get('showPicker')
  colors.append(
    colorSlot('主色', store.get('primary'), pickerOpen && pickerTarget === 'primary', () => togglePicker('primary')),
    el('button', { class: 'btn tiny', title: '交换主色/背景色（Tab）', onclick: swapColors }, ['⇄']),
    colorSlot('背景', store.get('bg'), pickerOpen && pickerTarget === 'bg', () => togglePicker('bg')),
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

/**
 * 主色 / 背景色的色块按钮。
 *
 * `open` 决定提示语：展开着的时候要告诉用户"再点一下能收起"，
 * 否则这个交互完全不可发现（用户只会去找那颗「收起」按钮）。
 */
function colorSlot(label: string, hex: string, open: boolean, onclick: () => void): HTMLElement {
  const hint = open ? '点击收起取色器' : '点击打开取色器'
  return el('button', { class: 'color-slot', title: `${label} ${hex} · ${hint}`, onclick }, [
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

/**
 * 点主色 / 背景色色块：打开取色器；**再点同一个色块则收起**。
 *
 * 为什么按 target 分别判断而不是简单地"点一下就切开关"：
 *  - 点**另一个**色块是"改编辑目标"，应当**切过去并保持展开**，不能顺手收起来——
 *    否则"主色 → 背景"这样连点两下会变成"开了又关"，用户得点三次才换得过去；
 *  - 只有点**当前正在编辑的**那个色块才是"我知道它是开着的，我要收起它"。
 * 收起这一路交给 `closePicker`，与「收起」按钮、Esc 走同一条出口。
 */
function togglePicker(target: PickerTarget): void {
  if (store.get('showPicker') && pickerTarget === target) {
    closePicker()
    return
  }
  pickerTarget = target
  store.set('showPicker', true)
  renderAll()
}

/**
 * 收起取色器（「收起」按钮 / 再点色块 / 载入预设等都要走这条出口）。
 *
 * 集中成一处的原因：`showPicker=false` 只是标志位，真正让它消失要等 `renderPickerPanel`
 * 把宿主摘掉并 `dispose()`（见那边的注释）。散着写容易出现"状态关了、界面还在"。
 */
function closePicker(): void {
  store.set('showPicker', false)
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
      closePicker()
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
 * 工作色板的色块编辑器（微调 / 替换）+ 它的右键菜单。
 *
 * 两个提交出口都走 `commitModelArt`（模型发起路径）——它会 `history.commit` → `applyIndices`
 * （同尺寸，保留选区与视图）→ `hasEdits` → 草稿落盘 → `renderAll`。
 * 色板改动属于"模型侧算出来的新画布"，**不能**走 `commitWithHistory`（那条要求像素已在画布副本里改完）。
 */
const swatchMenu = createContextMenu()

const swatchEditor = createSwatchEditor({
  getArt: () => app.art,
  /**
   * 拖动预览：只改画布**内部副本**的颜色表，模型与撤销栈都不动。
   *
   * 用 `setPalette` 而不是 `applyIndices`：像素存的是下标，改色板就等于改全图显示，
   * 一个 `indices` 都不用碰；而拖动是按帧回调的，`applyIndices` 每帧复制一次 indices
   * （2048² 是 4MB）会卡。`null` 表示回到模型真值（放弃时用）。
   */
  previewPalette: (palette) => {
    canvasApi.setPalette(palette ?? app.art?.palette ?? [])
  },
  commitTuned: (index, hex) => {
    const art = app.art
    if (!art) return
    const r = replacePaletteEntry(art.palette, art.indices, index, hex)
    // 合并（与已有色重复）时 indices 一起交出去；普通改值只换色板，像素不动
    commitModelArt({ ...art, palette: r.palette, indices: r.indices ?? art.indices })
    addRecent(hex)
    toast(
      r.mergedInto === null
        ? `已把色板第 ${index + 1} 项改为 ${hex}`
        : `${hex} 与色板里已有的一项合并（原色已移除）`,
    )
  },
  commitReplaced: (index, hex) => {
    const art = app.art
    if (!art) return
    // 源色必须取**模型里**的那一项：预览期间画布显示的是目标色，从显示读会读成目标色自身
    const from = art.palette[index]
    if (from === undefined) return
    try {
      const r = applyOps(art, [{ op: 'replaceAny', color: from, to: hex }], {
        // 拼豆/资产批次（lockPalette）下色板满要**报错**而不是退化为近似色——买不到的颜色不能静默替换
        allowApproxColor: !app.params.lockPalette,
      })
      if (!r.applied) {
        toast(`${from} 没有可替换的格子（或目标色与它相同）`, 'warn')
        renderAll()
        return
      }
      commitModelArt(r.art)
      addRecent(hex)
      toast(`已把 ${from} 全部替换为 ${hex}`)
    } catch (err) {
      // 不静默：源色不在色板、色板满且不允许近似色等都要如实告诉用户
      toast(`替换失败：${(err as Error).message}`, 'error')
      renderAll()
    }
  },
  groups: () => pickerGroups(),
  rerender: () => renderAll(),
  toast,
})

/*
 * 编辑器开着时，用户若直接到画布上落笔，画布会拿**内部的预览色板**去 `onCommit`，
 * 等于把预览静默并入那一笔提交上去（画布副本与模型的色板不是同一份）。
 * 在捕获阶段先提交并关闭编辑器，这一笔随后照常进行——用户不会发现中间发生过一次提交，
 * 但"预览色意外混进笔触"这条静默路径就此堵死。
 */
canvasHost.addEventListener(
  'pointerdown',
  () => {
    if (swatchEditor.isOpen()) swatchEditor.commit()
  },
  true,
)

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
    /*
     * ⚠️ 摘掉宿主之后**必须把变量也置空**。
     *
     * 原先只写 `pickerHost?.remove()`，变量仍指向那个已脱离文档的元素，
     * 于是重新打开时 `if (!pickerHost)` 判为假、走 else 分支，
     * `ensurePicker()` 把取色器渲染进一个**不在页面里的**容器——
     * 屏幕上什么都不出现（而 `showPicker` 已是 true），用户表现为
     * "点收起后左侧调色板再也打不开了"（用户报的 bug）。
     */
    pickerHost?.remove()
    pickerHost = null
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
  /*
   * 只移除色板自己的子节点，**保留两个取色器宿主**。
   *
   * 宿主必须跨渲染存活：拖动中若把它摘出文档，指针捕获会丢，表现为"一拖就断"
   * （`matte-field.ts` 文件头第 2 条坑）。这里曾经只豁免 `pickerHost`，
   * 加色块编辑器时漏豁免就会让"微调颜色"一拖就断——所以两个都列在条件里，
   * 而不是靠"记得也加一个"。
   */
  const keep = new Set<Element | null>([pickerHost, swatchEditor.host])
  for (const child of [...palettePanel.children]) {
    if (!keep.has(child)) child.remove()
  }
  renderPickerPanel()

  const art = app.art
  palettePanel.append(el('div', { class: 'panel-title' }, ['工作色板']))
  if (!art || art.palette.length === 0) {
    palettePanel.append(el('p', { class: 'hint' }, ['导入图片后显示；现在也可以用上方取色器手选颜色']))
    swatchEditor.render()
    return
  }

  const stats = artStats(art)
  const usage = stats.usage
  const grid = el('div', { class: 'swatch-grid' })
  const transparent = store.get('transparent')
  // 透明色是第一格：不进 palette 数组（索引/上限/.hex 导出都基于该数组）
  grid.append(
    el('button', {
      class: `swatch transparent${transparent ? ' selected' : ''}`,
      title: `透明色（E）· 共 ${stats.transparent} 格`,
      onclick: () => {
        store.set('transparent', true)
        renderAll()
      },
    }, [el('span', { class: 'count' }, [String(stats.transparent)])]),
  )
  /*
   * **按下标遍历**，不再 `for (const hex of art.palette)`。
   * 两个理由：① 色块编辑器要按**下标**定位（色板允许重复 hex，只有下标唯一）；
   * ② 预览时底色要取"预览中的色板"，按下标才不会拿错项。
   */
  const shown = swatchEditor.displayPalette() ?? art.palette
  const editing = swatchEditor.editingIndex()
  const primary = store.get('primary').toLowerCase()
  for (let i = 0; i < art.palette.length; i++) {
    const hex = shown[i] ?? art.palette[i]
    // 用量按**原色**统计：预览只是换显示，别让色块上的数字跟着跳（那会误导"格数变了"）
    const count = usage[art.palette[i]] ?? 0
    const cls = [
      'swatch',
      hex === primary && !transparent ? 'selected' : '',
      count === 0 ? 'unused' : '',
      editing === i ? 'editing' : '',
    ].filter(Boolean).join(' ')
    const btn = el('button', {
      class: cls,
      type: 'button',
      style: { background: hex, color: colorTextOn(hex) },
      // tooltip 必须写明右键：没有视觉痕迹的手势不写就完全不可发现（tooltip 是这里唯一的发现渠道）
      title: `${art.palette[i]} · 用量 ${count} 格 · 左键选为主色 · 右键：微调 / 替换`,
      'data-testid': `swatch-${i}`,
      onclick: () => {
        store.setMany({ primary: art.palette[i], transparent: false })
        renderAll()
      },
      oncontextmenu: (e: Event) => {
        e.preventDefault()
        openSwatchMenu(i, e as MouseEvent)
      },
    }, [el('span', { class: 'count' }, [count > 999 ? '1k' : String(count)])])
    grid.append(btn)
  }
  palettePanel.append(grid)
  /*
   * 顺序有讲究：**先挂进文档再 render**。
   * `render()` 在"刚展开"时会 `scrollIntoView`——宿主还在游离状态时它什么都做不了
   * **且不报错**，表现为"点了色块、编辑器在视口外，用户以为没反应"（matte-field 记过同一条坑）。
   * 排在色板网格之后、主色取色器之前，保证"色板 → 编辑器 → 调色器"的稳定阅读顺序。
   */
  if (swatchEditor.isOpen()) palettePanel.append(swatchEditor.host)
  swatchEditor.render()
  if (pickerHost) palettePanel.append(pickerHost)
}

/**
 * 色块右键菜单：**微调此颜色**（改色板条目的值）与**替换为…**（把该色的格子全换成另一色）。
 *
 * 为什么不给色块加左键以外的点击区（如角落小图标）：色板最多 256 格，每格多一个子节点
 * 既撑 DOM 又挤坏 26px 的格子；右键是桌面软件的既有约定，成本为零。
 * 两项都**只打开编辑器、不当场改色**——真正的动作在编辑器里（那里能实时预览）。
 */
function openSwatchMenu(index: number, e: MouseEvent): void {
  const art = app.art
  if (!art) return
  const hex = art.palette[index]
  if (hex === undefined) return
  swatchMenu.open(e.clientX, e.clientY, [
    {
      label: '微调此颜色…',
      hint: '改这个颜色本身，全图同步变',
      testId: 'swatch-menu-tune',
      onSelect: () => swatchEditor.open(index, 'tune'),
    },
    {
      label: '替换为…',
      hint: '把用到它的格子换成另一个颜色',
      testId: 'swatch-menu-replace',
      onSelect: () => swatchEditor.open(index, 'replace'),
    },
  ])
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
    ['右键工作色板色块', '微调此颜色（改色板条目，全图实时变色）/ 替换为…（把该色的格子换成另一色）'],
    ['Esc', '放弃正在进行的色板微调（还原成改之前的样子，不占用撤销）'],
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
   * Esc 的**第一优先级**给色块编辑器：它是当前最"模态"的临时状态
   * （画布上正显示着未提交的预览色），必须先收掉它，否则后面那些分支
   * （退出吸管工具等）会先把别的东西改掉，用户想要的"取消"就落空了。
   * 走 `abandon()` 而不是 `commit()`——Esc 在本项目里一律是"取消"。
   * 色板编辑器的取消入口**只有 Esc**（右键取消已移除，见 ui/swatch-editor.ts 的说明）。
   */
  if (k === 'escape' && swatchEditor.isOpen()) {
    swatchEditor.abandon()
    return
  }
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

/* ------------------------------------------------------------------ 自动草稿的恢复提示 */

/**
 * 启动时检查草稿并（可选地）弹提示条。
 *
 * 恢复做的事**等同于载入一个项目文件**：解码草稿里的项目 JSON → `setParams` + `replaceArt`。
 * 这样"恢复"与"导入项目"走的是同一条已经过校验的路径，不必另写一套像素装载逻辑。
 *
 * 三个必须处理的边界：
 *  - **草稿损坏**：`parseProjectFile` 会抛（长度不符、色板非法、版本不支持…）。
 *    这里**清掉坏草稿并静默继续**——留着它会让每次打开都弹一个点了会报错的提示。
 *  - **存储不可用**（无痕 / 配额满）：整条路径静默跳过，与项目"存储不可用就降级"的既有约定一致。
 *  - **原图缺失**：草稿分两条写，原图可能因超配额没写进去。此时画布照样恢复，
 *    只是"重新转换"没有原图可用——要如实告知，不能让用户以为原图也回来了。
 */
async function maybeOfferDraftRestore(): Promise<void> {
  if (!draftSupported()) return

  let record: Awaited<ReturnType<typeof loadDraft>> = null
  try {
    record = await loadDraft()
  } catch {
    return // 读不出来（被禁用/被占用）：当作没有草稿
  }
  if (!record) return

  if (!isUsableDraft(record, DRAFT_VERSION)) {
    // 版本不符或结构不对：直接丢弃，不做猜测式迁移（理由见 storage.ts）
    void clearDraft().catch(() => {})
    return
  }

  let parsed: ReturnType<typeof parseProjectFile>
  try {
    parsed = parseProjectFile(record.project)
  } catch {
    // 坏草稿：清掉，别让它每次启动都弹一个点了会报错的提示
    void clearDraft().catch(() => {})
    return
  }

  const { art, params } = parsed
  const when = new Date(record.savedAt)
  const stamp = Number.isNaN(when.getTime())
    ? ''
    : `${when.getMonth() + 1}-${String(when.getDate()).padStart(2, '0')} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`

  const bar = el('div', { class: 'draft-bar', 'data-testid': 'draft-bar' }, [
    el('span', { class: 'draft-text' }, [
      `发现上次未导出的编辑（${art.width}×${art.height}${stamp ? ` · ${stamp}` : ''}）`,
    ]),
    el('button', {
      class: 'btn tiny primary',
      type: 'button',
      'data-testid': 'draft-restore',
      onclick: () => {
        void (async () => {
          /*
           * 先摘掉提示条再做恢复。
           *
           * `renderAll()` 不会碰这条浮层（它是 `document.body` 下的独立节点，
           * 不属于任何被重绘的区域），所以必须**显式移除**——否则恢复完它一直赖在屏幕上，
           * 用户会以为"还没生效"而反复点（本次 e2e 就抓到了这个：画布恢复了、提示条还在）。
           */
          bar.remove()
          app.params = params
          replaceArt(art)
          // 原图尽力恢复（可能因超配额没存进去）
          let restoredSource = false
          try {
            const src = await loadDraftSource()
            if (isUsableSource(src, DRAFT_VERSION)) {
              const data = new Uint8ClampedArray(src.data)
              app.source = { width: src.width, height: src.height, data }
              app.sourceName = src.name
              app.refImage = await rgbaToImageElement(app.source)
              canvasApi.setReference(app.refImage, false)
              restoredSource = true
            }
          } catch {
            /* 原图没恢复出来：只影响"重新转换"，画布与编辑都在 */
          }
          renderAll()
          toast(
            restoredSource
              ? `已恢复上次编辑（${art.width}×${art.height}）`
              : `已恢复画布（${art.width}×${art.height}）；原图未能恢复，右侧参数改动不会再重转（可用「导出 ▾ → 项目 JSON」留档）`,
            restoredSource ? 'info' : 'warn',
          )
        })()
      },
    }, ['恢复']),
    el('button', {
      class: 'btn tiny',
      type: 'button',
      'data-testid': 'draft-discard',
      onclick: () => {
        bar.remove()
        // 用户明确不要：先取消待写（虽然此刻不该有），再清盘
        draftWriter.cancel()
        void clearDraft().catch(() => {})
        toast('已丢弃上次的草稿')
      },
    }, ['放弃']),
  ])

  document.body.append(bar)
}

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

  /*
   * 自动草稿：启动时若有可用草稿，出**一条可关闭的提示条**让用户决定是否恢复。
   *
   * 为什么不静默恢复（这是用户拍板的形态）：静默恢复会让"打开工具想从头开始"的人
   * 莫名看到上次的旧画布，比丢失更困惑。所以这里只提示，恢复与否由用户点。
   *
   * 两个顺序要点：
   *  1. **在 `renderAll()` 之后**再弹：否则提示条会被随后的整屏渲染冲掉。
   *  2. **不自动写入**草稿（不 `schedule()`）：用户还没做任何操作，
   *     此时写盘只会在"用户选了放弃、我们又写回去"之间制造竞态。
   *     真正开始写入是从第一次提交（画/改参）起。
   */
  void maybeOfferDraftRestore()

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
   * 页面要关了：**把待写的草稿立刻落盘**，别等那 800ms 防抖。
   *
   * 这一条是草稿能不能救命的关键：用户"画完最后一笔就关标签页/刷新"是最常见的丢数据场景，
   * 而那一笔的防抖定时器多半还没到点。`visibilitychange → hidden` 比 `beforeunload` 可靠
   * （移动端与部分浏览器不一定触发 beforeunload），两个都挂上，`flush()` 内部幂等。
   */
  const flushDraft = (): void => {
    void draftWriter.flush()
  }
  window.addEventListener('pagehide', flushDraft)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushDraft()
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

// 供调试与端到端断言用的内部挂钩（**不是**对外契约——对外请用 window.pixelArtStudio）。
// `history` 在这里暴露，是因为撤销栈的双上限只能从内部读到（`ps` 只给 artHash/getInfo）：
// 详见 tool/e2e.mjs 里那条"撤销栈按上限记账"的断言。
;(window as unknown as { __app?: unknown }).__app = { app, store, canvasApi, history }
