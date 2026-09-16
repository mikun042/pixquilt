/**
 * 取色器：按 **Blender 取色界面** 的结构实现（用户提供的参考图即 Blender）。
 *
 * 下面这张图不是"凭印象"，而是把参考图逐像素测出来的（tool/ref-analysis.mjs + 定点采样）：
 *   ┌──────────────────────────────────────┐
 *   │ [   RGB   |   HSV   ]                │  ← 两个分段共用圆角容器、无缝隙；激活半段 #4772b3
 *   │       ╭────────────╮  ┌─┐            │  ← 色轮 156px + 右侧明度竖条 14px
 *   │       │     ○      │  │▬│            │  ← 游标是细圈；明度滑块是悬出条宽的浅色方块
 *   │       ╰────────────╯  └─┘            │
 *   │  红 ███████     0.800                │  ← 滑条：蓝色填充宽度 = 数值占满量的比例
 *   │  绿 ███         0.800                │     数值框在滑条**右侧之外**（拖动碰不到它）
 *   │  蓝              0.800               │
 *   │  透明度 ████████ 0.000               │  ← 两态滑条（左半 = 1.000 全透明，右半 = 0.000 实色）
 *   │  Hex   [#E7E7E7]            [吸管]   │  ← Hex 行常驻，右侧吸管按钮（内联 SVG 滴管）
 *   └──────────────────────────────────────┘
 *
 * 实测结论（决定了下面几处"非常规"写法）：
 *   · 色相 0°(红) 在色轮**正下方**，顺时针递增：下 0° / 左 90° / 上 180° / 右 270°（8 方位实测）。
 *     屏幕角 `atan2(dy, dx)` 的 0° 在正右，因此 色相 = 屏幕角 − 90°（见 HUE_OFFSET）。
 *   · 色轮画在当前明度 V 上：参考图数值 0.8（线性）→ 彩色区最亮通道 231 = sRGB(0.8)。本项目
 *     内部就是 sRGB，所以直接用 hsv.v 画即可，不需要任何色彩空间转换。
 *   · 数值行是"滑条"：蓝 #4772b3 从左填充，宽度 = 数值占满量的比例（0.800 实测填充 80.7%）。
 *   · 数值一律归一化 3 位小数（0.800 / 1.000 / 0.000）；输入兼容旧刻度（>1 视为 0-255 / 0-100 / 0-360）。
 *
 * 与参考图的**有意差异**（都写在 docs/UI-COLOR-PICKER.md，不要当成 bug）：
 *   · **数值框在滑条右侧、不在滑条上**：参考图里数字是压在滑条上的，但那样"点数字框"
 *     与"拖滑条"共用一个命中区，输入时必然误触（Alpha 行会被改成透明/实色）。
 *     现在靠结构隔离（数字框不在轨道内），不是靠事件拦截。
 *   · **最后一行是「透明度」而不是「Alpha」**：参考图那一行是连续 alpha（1.000 = 完全不透明），
 *     本工具是"透明色"开关，所以数值改成透明度口径——0.000 = 不透明，1.000 = 全透明，
 *     与界面其它地方的"透明"语言一致（透明色 / 透明挖洞 / 色板「透明」块）。
 *     注意：填充画的是"颜色有多少"，全透明时填充 0%（空条 = 没有颜色），与数字口径相反但同指一事。
 *   · Hex 只显示 6 位（core 的 normalizeHex 只认 6 位；且本工具的 alpha 是"透明色"开关，
 *     不是连续通道，多写两位会假装存在连续 alpha）。
 *   · 色板 + 透明块 + 「收起」保留（参考图是 Blender 的浮窗，没有这些；删掉是本工具的功能倒退）。
 *
 * 性能约束（继承上一版的硬要求）：**拖动中不重建 DOM**，只更新数值文本、游标与填充宽度；
 * 松手才提交（一次拖动 = 一条撤销），并且监听 window blur 兜底收尾，避免拖拽状态悬挂。
 */
import { colorTextOn, hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from '../../core/color.ts'
import { normalizeHex } from '../../core/types.ts'
import { clear, el } from '../store.ts'
import { iconEl } from './icons.ts'

export interface ColorPickerCallbacks {
  /** 拖动过程中持续回调（实时预览，不进撤销栈） */
  onPreview: (hex: string) => void
  /** 松手 / 数值输入 / 点色块：提交（进撤销栈） */
  onCommit: (hex: string) => void
  /**
   * Alpha 滑条拖到**左半边**：选「透明色」。
   * 与 onPreview 一样是拖动中的实时反馈，不进撤销栈。
   */
  onTransparent: () => void
  /**
   * Alpha 滑条拖到**右半边**：恢复实色（同样只做实时预览，松手才 onCommit）。
   *
   * 为什么需要它：只靠 onPreview 的话，从透明拖回实色时 `transparent` 仍是 true，
   * 填充会一直停在 0%、数字停在 0.000，拖起来"没反应"，松手才跳一下。
   */
  onOpaque: () => void
  /** 当前绘制色是否为透明色 */
  isTransparent: () => boolean
  /** 点吸管：让画布进入取色模式（下一次点击画布即取色） */
  onPickFromCanvas: () => void
  /** 关闭面板 */
  onClose: () => void
}

export interface ColorPickerState {
  /**
   * 正在编辑哪一路颜色。
   *
   * **仅信息用途**（`targetChanged` 判断与状态记录）；真正的写回完全由调用方的回调决定，
   * 所以这个值不同不会改变取色器行为，它只回答"这个面板现在在改谁"。
   *  `'palette'` = 工作色板里某个条目（彩色微调），见 `src/app/ui/swatch-editor.ts`。
   */
  target: 'primary' | 'bg' | 'matte' | 'palette'
  value: string
  /** 色板（工作色板 + 预置卡；分组显示） */
  groups: { name: string; colors: string[] }[]
  /**
   * 是否显示「透明度」行与透明色块。默认 true。
   *
   * 编辑**主色 / 背景色**时为 true——本工具的"透明色"是画笔挖洞用的开关。
   * 编辑**合成底色**（`matteColor`）时为 false：它是 6 位 hex、根本没有 alpha，
   * 摆一个"透明度 1.000 = 全透明"的行只会让人以为能给底色设透明度（点了还会去改画笔的透明开关）。
   */
  showAlpha?: boolean
}

export interface ColorPickerApi {
  update: (patch: Partial<ColorPickerState>) => void
  dispose: () => void
}

/**
 * 色轮直径。参考图色轮 238px 占面板 292px 的 81.5%；本项目的左栏给取色器的内容宽是 176px，
 * 于是取 156 + 间隙 6 + 明度条 14 = 176（正好填满，不溢出，比例 0.80 ≈ 参考图 0.815）。
 * 要更大的轮子就必须加宽全局左栏（232px），那属于全站布局，不在取色器范围内。
 */
const WHEEL_SIZE = 156
/** 右侧明度竖条的宽高（参考图 16px / 高=轮径，这里按比例取 14px） */
const BAR_W = 14
const BAR_H = WHEEL_SIZE
/** 色轮与明度条的间隙 */
const WHEEL_GAP = 6
/** 游标半径（直径 13px ≈ 轮径的 8%，与参考图一致）：positionCursor 用它把游标居中到指针处 */
const CURSOR_R = 6.5

/**
 * 色相起点偏移（度）。参考图实测：0°(红) 在色轮正下方，顺时针递增
 * （下 0° / 左 90° / 上 180° / 右 270°）。屏幕角 atan2(dy,dx) 的 0° 在正右，
 * 所以 色相 = 屏幕角 − 90°。**要改回"0° 在正右"只需把这里改成 0**（三处换算都走这两个函数）。
 */
const HUE_OFFSET = -90
/** 屏幕角（度，0=正右、90=正下）→ 色相（度） */
const angleToHue = (a: number): number => (a + HUE_OFFSET + 360) % 360
/** 色相（度）→ 屏幕角（度） */
const hueToAngle = (h: number): number => (h - HUE_OFFSET + 360) % 360

/**
 * 透明度滑条的分界比例（50%）。
 *
 * 本工具的透明度**不是连续通道**，而是"透明色"开关（见文件头部"有意差异"），
 * 所以这条滑条只有**两个位置**：拖到左半边 = 全透明（1.000），右半边 = 实色（0.000）。
 *
 * 为什么是 50% 而不是"左端一小段死区"：旧实现只有最左 6%（约 8px）算透明，
 * 其余全算实色——用户拖动中段时什么都没发生，看起来就是"这条滑条拖不动"
 * （2026-09-13 实测复现：在 128px 轨道上从 0.9 拖到 0.2，值纹丝不动）。
 * 现在整条轨道都有响应：越过中线就翻状态，来回拖会实时来回翻。
 */
const ALPHA_MID = 0.5

type ColorModel = 'rgb' | 'hsv'

/** 数值行定义：模型切换时只换 H/S/V ↔ R/G/B 三行，Alpha 与 Hex 常驻 */
const ROW_SPECS: { key: string; label: string; model: ColorModel }[] = [
  { key: 'R', label: '红', model: 'rgb' },
  { key: 'G', label: '绿', model: 'rgb' },
  { key: 'B', label: '蓝', model: 'rgb' },
  { key: 'H', label: '色相', model: 'hsv' },
  { key: 'S', label: '饱和度', model: 'hsv' },
  { key: 'V', label: '明度', model: 'hsv' },
]

/** 数值显示：归一化 3 位小数（参考图 0.800 / 1.000） */
const norm3 = (v: number): string => Math.max(0, Math.min(1, v)).toFixed(3)

export function createColorPicker(host: HTMLElement, initial: ColorPickerState, cb: ColorPickerCallbacks): ColorPickerApi {
  let state: ColorPickerState = { ...initial }
  /**
   * 当前颜色的 hex。
   *
   * **为什么需要它**：HSV⇄RGB 与 hex 解析各自都有取整，只要让"改一个通道"经过
   * `hex → RGB → 改字节 → HSV → hex → RGB` 这条链，就会累积 ±1 误差——实测把 G 拖到 0.1
   * 之后颜色会"弹"回原值、继续拖也几乎不变。因此把 hex 作为**字节级真源**：
   *   · RGB 通道操作：直接在 hexToRgb(currentHex) 上改字节，最后只反推一次 HSV；
   *   · HSV 操作（色轮 / 明度 / H·S·V 滑条）：改 hsv，再同步 currentHex。
   */
  let currentHex = normalizeHex(state.value) ?? '#000000'
  let hsv = rgbToHsv(...rgbTuple(currentHex))
  /** 见 ColorPickerState.showAlpha：合成底色这类没有 alpha 的颜色要把透明度行藏掉 */
  let showAlpha = state.showAlpha !== false
  /**
   * 当前拖动对象：`'value'`（明度竖条）/ `'alpha'`（透明度行）/ 任意数值行 key（R/G/B/H/S/V）。
   * 之所以用字符串而不是联合类型：数值行的 key 来自 ROW_SPECS，新增通道时这里不必跟着改。
   */
  let dragging: string | null = null
  /** 本次 Alpha 拖动是否落在实色区（>死区）：决定松手时要不要提交"恢复实色" */
  let alphaOpaque = false
  let model: ColorModel = 'rgb'

  /* ------------------------------------------------------------ 结构 */

  // 参考图只有 RGB / HSV 两段：Hex 是下面常驻的一行，不是第三个标签
  const tabKeys: ColorModel[] = ['rgb', 'hsv']
  const tabLabels: Record<ColorModel, string> = { rgb: 'RGB', hsv: 'HSV' }
  const tabs = el('div', { class: 'cp-tabs', role: 'tablist' })
  const tabEls = new Map<ColorModel, HTMLButtonElement>()
  for (const key of tabKeys) {
    const b = el('button', { class: 'cp-tab', type: 'button', role: 'tab', onclick: () => setModel(key) }, [tabLabels[key]])
    tabEls.set(key, b)
    tabs.append(b)
  }

  /* ---- 色轮 + 圆环游标 ---- */
  const wheelCanvas = el('canvas', { class: 'cp-wheel', width: WHEEL_SIZE, height: WHEEL_SIZE })
  const cursor = el('div', { class: 'cp-cursor' })
  const wheelWrap = el('div', { class: 'cp-wheel-wrap', style: { width: `${WHEEL_SIZE}px`, height: `${WHEEL_SIZE}px` } }, [wheelCanvas, cursor])

  /* ---- 右侧竖向明度条（Blender 的 V 条） ---- */
  const valueBarCanvas = el('canvas', { class: 'cp-bar', width: BAR_W, height: BAR_H })
  const valueKnob = el('div', { class: 'cp-vknob' })
  const valueBar = el('div', { class: 'cp-bar-wrap', style: { width: `${BAR_W}px`, height: `${BAR_H}px` } }, [valueBarCanvas, valueKnob])
  valueBar.title = '明度（V）：上亮下暗'

  const wheelRow = el('div', { class: 'cp-wheel-row', style: { gap: `${WHEEL_GAP}px` } }, [wheelWrap, valueBar])

  /**
   * 数值行 = **[滑条轨道][数值框]**，数值框在轨道之外。
   *
   * 为什么必须分开：轨道整条都是拖动命中区。数字框若坐在轨道里面，点进数字框的那一刻
   * 事件就已经落到滑条上了——Alpha 行尤其严重，它整行可拖、又用 clientX 换算状态，
   * 点数字框就会按点击位置把颜色改成"透明/实色"。
   * 现在数字框与轨道是互不重叠的两个命中区，**输入数字永远碰不到滑条**（不是靠事件拦截，
   * 而是靠结构：数字框根本不在滑条里）。
   * 代价：滑条只占行宽的约 3/4，填充看起来比参考图短——参考图里数字是压在滑条上的。
   */
  const fieldsHost = el('div', { class: 'cp-fields' })
  const fieldInputs = new Map<string, HTMLInputElement>()
  /** 行（只用来按模型切换显隐） */
  const rowEls = new Map<string, HTMLElement>()
  /** 滑条轨道：拖动基准 + 填充的裁剪容器 */
  const rowTracks = new Map<string, HTMLElement>()
  const rowFills = new Map<string, HTMLElement>()
  /** 六个数值行（R/G/B/H/S/V）按模型切换显隐；它们都是可拖动滑条 */
  const sliderKeys = new Set(['R', 'G', 'B', 'H', 'S', 'V'])

  const numRow = (key: string, label: string) => {
    const input = el('input', {
      class: 'cp-num',
      type: 'text',
      inputmode: 'decimal',
      dataset: { field: key },
      onchange: (e: Event) => applyNumberField(key, (e.target as HTMLInputElement).value),
    })
    const fill = el('div', { class: 'cp-row-fill' })
    const track = el('div', { class: 'cp-row-track' }, [fill, el('span', { class: 'cp-row-label' }, [label])])
    const row = el('div', { class: 'cp-row', dataset: { row: key } }, [track, input])
    fieldInputs.set(key, input)
    rowEls.set(key, row)
    rowTracks.set(key, track)
    rowFills.set(key, fill)
    return row
  }
  for (const spec of ROW_SPECS) fieldsHost.append(numRow(spec.key, spec.label))

  /*
   * ---- 透明度行：与上面同一组滑条 ----
   *
   * 数值走的是**透明度**（0.000 = 不透明，1.000 = 全透明），不是 alpha。
   * 理由：本工具的 alpha 是"透明色"开关，界面上其它地方一律用"透明"这套语言
   * （透明色 / 透明挖洞 / 色板里的「透明」块），只有这一行原来写着 Alpha + 1.000，
   * 反而要说"1.000 = 完全不透明"，与直觉相反。
   * 类名保持 `.cp-alpha`（自动化断言与文档引用的稳定钩子），内部键名用 `Opacity` 以免语义混淆。
   */
  const alphaInput = el('input', {
    class: 'cp-num',
    type: 'text',
    inputmode: 'decimal',
    dataset: { field: 'Opacity' },
    onchange: (e: Event) => applyNumberField('Opacity', (e.target as HTMLInputElement).value),
  })
  const alphaFill = el('div', { class: 'cp-row-fill' })
  const alphaTrack = el('div', { class: 'cp-row-track' }, [alphaFill, el('span', { class: 'cp-row-label' }, ['透明度'])])
  const alphaRow = el('div', { class: 'cp-row cp-alpha' }, [alphaTrack, alphaInput])
  fieldInputs.set('Opacity', alphaInput)
  rowFills.set('Opacity', alphaFill)
  fieldsHost.append(alphaRow)

  /* ---- Hex 行（常驻）：标签 + 输入框 + 吸管 ---- */
  const hexInput = el('input', {
    class: 'cp-num',
    type: 'text',
    spellcheck: false,
    dataset: { field: 'Hex' },
    onchange: (e: Event) => applyNumberField('Hex', (e.target as HTMLInputElement).value),
  })
  fieldInputs.set('Hex', hexInput)
  const pickerBtn = el(
    'button',
    { class: 'cp-icon-btn', type: 'button', title: '吸管：点这里，然后到画布上点一格取色', onclick: () => cb.onPickFromCanvas() },
    [],
  )
  {
    // 吸管用内联 SVG：Unicode 里没有吸管符号，原先的 `⌖` 是准星（用户反馈"不像吸管"）。
    // 没有图标时回退到字符——绝不产出空按钮，空按钮点不动是最难查的一类问题。
    const svg = iconEl('eyedropper')
    if (svg) pickerBtn.append(svg)
    else pickerBtn.append(document.createTextNode('⌖'))
  }
  const hexRow = el('div', { class: 'cp-hexrow' }, [el('span', { class: 'cp-hex-label' }, ['Hex']), hexInput, pickerBtn])

  /* ---- 色板 ---- */
  const swatchHost = el('div', { class: 'cp-swatches' })

  const closeBtn = el('button', { class: 'btn tiny', type: 'button', onclick: () => cb.onClose() }, ['收起'])

  const panel = el('div', { class: 'cp' }, [tabs, wheelRow, fieldsHost, hexRow, swatchHost, el('div', { class: 'cp-foot' }, [closeBtn])])
  clear(host)
  host.append(panel)

  /* ------------------------------------------------------------ 绘制 */

  const wheelCtx = wheelCanvas.getContext('2d')
  let lastDrawnV = Number.NaN

  /**
   * 画色轮：**中心白、外圈饱和**（HSV 圆盘 = 饱和度沿半径线性递增、色相沿角度）。
   * 实测：0°(红) 在正下方、顺时针；整体画在当前明度 V 上。
   * 只在明度变化时重画（拖动游标只改 transform，避免每帧重算 156² 像素）。
   */
  function drawWheel(): void {
    if (!wheelCtx) return
    const size = WHEEL_SIZE
    const r = size / 2
    const img = wheelCtx.createImageData(size, size)
    const v = hsv.v
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x + 0.5 - r) / r
        const dy = (y + 0.5 - r) / r
        const d = Math.sqrt(dx * dx + dy * dy)
        const o = (y * size + x) * 4
        if (d > 1) {
          img.data[o + 3] = 0
          continue
        }
        const ang = (Math.atan2(dy, dx) * 180) / Math.PI
        const c = hsvToRgb(angleToHue(ang < 0 ? ang + 360 : ang), Math.min(1, d), v)
        img.data[o] = c.r
        img.data[o + 1] = c.g
        img.data[o + 2] = c.b
        // 最外 0.5% 做 1px 羽化，避免圆边锯齿
        img.data[o + 3] = d > 0.995 ? Math.round(255 * (1 - (d - 0.995) / 0.005)) : 255
      }
    }
    wheelCtx.putImageData(img, 0, 0)
    lastDrawnV = v
  }

  /** 明度竖条：上亮下暗（与参考图一致），底部固定为黑 */
  function drawValueBar(): void {
    const ctx = valueBarCanvas.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(BAR_W, BAR_H)
    const { h, s } = hsv
    for (let y = 0; y < BAR_H; y++) {
      const v = 1 - y / (BAR_H - 1) // 顶=1 亮，底=0 黑
      const c = hsvToRgb(h, s, v)
      for (let x = 0; x < BAR_W; x++) {
        const o = (y * BAR_W + x) * 4
        img.data[o] = c.r
        img.data[o + 1] = c.g
        img.data[o + 2] = c.b
        img.data[o + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
  }

  function positionCursor(): void {
    const r = WHEEL_SIZE / 2
    const ang = (hueToAngle(hsv.h) * Math.PI) / 180
    const dist = Math.max(0, Math.min(1, hsv.s)) * r
    cursor.style.transform = `translate(${r + Math.cos(ang) * dist - CURSOR_R}px, ${r + Math.sin(ang) * dist - CURSOR_R}px)`
  }

  function paintTracks(): void {
    // 明度滑块（顶=1，底=0）
    valueKnob.style.top = `${(1 - hsv.v) * 100}%`
    // 透明度是两态开关：状态靠"填充 0/100% + 数字 1.000/0.000"表达（见 paintFields），
    // 这里补一句 tooltip，让"左半边全透明 / 右半边实色"这个手势能被发现
    const transparent = cb.isTransparent()
    alphaRow.title = transparent
      ? '当前「全透明」（1.000）：拖到滑条右半边恢复实色（0.000），或点下方色板选色'
      : '拖到滑条左半边 = 「全透明」（1.000）：画笔 / 填充 / 形状 / X 删除都变成挖洞'
  }

  function paintFields(): void {
    const hex = currentHex
    const c = hexToRgb(hex)
    const transparent = cb.isTransparent()
    const set = (key: string, value: string) => {
      const input = fieldInputs.get(key)
      if (input && document.activeElement !== input) input.value = value
    }
    const fill = (key: string, ratio: number) => {
      const node = rowFills.get(key)
      if (node) node.style.width = `${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(2)}%`
    }
    set('R', norm3(c.r / 255))
    fill('R', c.r / 255)
    set('G', norm3(c.g / 255))
    fill('G', c.g / 255)
    set('B', norm3(c.b / 255))
    fill('B', c.b / 255)
    set('H', norm3(hsv.h / 360))
    fill('H', hsv.h / 360)
    set('S', norm3(hsv.s))
    fill('S', hsv.s)
    set('V', norm3(hsv.v))
    fill('V', hsv.v)
    // 透明度：1.000 = 全透明。填充画的是"颜色有多少"（alpha），所以全透明时填充为 0%——
    // 空条 = 没有颜色 = 透明，数字与填充指向同一件事，只是口径相反（一个说"多少透明"、一个说"多少颜色"）
    set('Opacity', transparent ? '1.000' : '0.000')
    fill('Opacity', transparent ? 0 : 1)
    set('Hex', hex.toUpperCase())
    // 三行模型行共用：切换标签只换 R/G/B ↔ H/S/V 的显隐（透明度 / Hex 常驻）
    for (const spec of ROW_SPECS) {
      const node = rowEls.get(spec.key)
      if (node) node.style.display = spec.model === model ? '' : 'none'
    }
    alphaRow.style.display = showAlpha ? '' : 'none'
  }

  function paintSwatches(): void {
    clear(swatchHost)
    let any = false
    for (const group of state.groups) {
      if (group.colors.length === 0) continue
      any = true
      swatchHost.append(
        el('div', { class: 'cp-swatch-row' }, [
          el('span', { class: 'cp-swatch-name' }, [group.name]),
          ...group.colors.slice(0, 32).map((hex) =>
            el('button', {
              class: 'cp-swatch',
              type: 'button',
              title: hex,
              style: { background: hex, color: colorTextOn(hex) },
              onclick: () => applyColor(hex),
            }),
          ),
        ]),
      )
    }
    if (!any) swatchHost.append(el('span', { class: 'hint' }, ['导入或绘制后出现常用色']))
    // 透明色块：Blender 没有，但本工具需要（画笔/填充挖洞），放在最后。
    // 只有编辑"带透明语义"的颜色时才出现（见 ColorPickerState.showAlpha）。
    if (showAlpha) {
      swatchHost.append(
        el('div', { class: 'cp-swatch-row' }, [
          el('span', { class: 'cp-swatch-name' }, ['透明']),
          el('button', {
            class: `cp-swatch transparent${cb.isTransparent() ? ' active' : ''}`,
            type: 'button',
            title: '选中后画笔 / 填充 / 形状 / X 删除都变成挖洞',
            onclick: () => {
              cb.onTransparent()
              repaint()
            },
          }, ['∅']),
        ]),
      )
    }
  }

  /** 数值行（按当前模型解析输入） */
  function applyNumberField(key: string, raw: string): void {
    if (key === 'Opacity') {
      // 透明度只有"全透明 / 实色"两态。输入用**与拖动同一条分界**（ALPHA_MID）：
      // 输入 0.5 及以上 = 全透明，低于 0.5 = 实色（0 = 不透明）。避免出现两套阈值。
      const v = Number(raw)
      if (!Number.isFinite(v)) return
      if (v >= ALPHA_MID) cb.onTransparent()
      else cb.onCommit(currentHex)
      repaint()
      return
    }
    if (key === 'Hex') {
      const norm = normalizeHex(raw)
      if (!norm) return
      hsv = rgbToHsv(...rgbTuple(norm))
      cb.onCommit(norm)
      repaint()
      return
    }
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    // 输入兼容两种刻度：0–1（界面显示值）与旧习惯刻度（R/G/B 用 0–255、H 用 0–360、S/V 用 0–100）。
    // 统一换算成"归一化比例"后交给 setChannelRatio——与拖动滑条走同一条路径。
    const legacy = key === 'R' || key === 'G' || key === 'B' ? 255 : key === 'H' ? 360 : 100
    setChannelRatio(key, value > 1 ? value / legacy : value)
    cb.onCommit(currentHex)
    repaint()
  }

  function setModel(next: ColorModel): void {
    model = next
    paintTabs()
    paintFields()
  }

  function paintTabs(): void {
    for (const [key, node] of tabEls) {
      const active = model === key
      node.className = `cp-tab${active ? ' active' : ''}`
      node.setAttribute('aria-selected', active ? 'true' : 'false')
    }
  }

  /** 拖动中的轻量刷新：只动数值/游标/填充宽度（不重建 DOM） */
  function refresh(): void {
    if (!Number.isFinite(lastDrawnV) || Math.abs(lastDrawnV - hsv.v) > 1e-6) drawWheel()
    drawValueBar()
    positionCursor()
    paintTracks()
    paintFields()
  }

  /** HSV 变更后把 hex 同步回来（保持 currentHex 始终等于当前显示色） */
  function syncHexFromHsv(): void {
    currentHex = hexOfHsv()
  }

  /** 结构性刷新（切换颜色 / 色板变化） */
  function repaint(): void {
    refresh()
    paintTabs()
    paintSwatches()
  }

  /* ------------------------------------------------------------ 交互 */

  function hexOfHsv(): string {
    const c = hsvToRgb(hsv.h, hsv.s, hsv.v)
    return rgbToHex(c.r, c.g, c.b)
  }

  function applyColor(hex: string): void {
    const norm = normalizeHex(hex)
    if (!norm) return
    hsv = rgbToHsv(...rgbTuple(norm))
    currentHex = norm
    cb.onCommit(norm)
    repaint()
  }

  function wheelFromEvent(e: PointerEvent): { h: number; s: number } | null {
    const rect = wheelCanvas.getBoundingClientRect()
    // 元素不可见（侧栏收起 / 面板在 display:none 内 / 尚未布局）时 rect 全是 0。
    // 这里必须返回 null 而不是继续算：除以 0 会得到 NaN，并沿"色相/饱和度"一路污染成
    // #NaNNaNNaN 这种非法颜色（本项目在自动化验证里真实踩到过）。
    if (!(rect.width > 0) || !(rect.height > 0)) return null
    const r = rect.width / 2
    const dx = (e.clientX - rect.left - r) / r
    const dy = (e.clientY - rect.top - r) / r
    const d = Math.sqrt(dx * dx + dy * dy)
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI
    // 拖到圆外时饱和度夹到 1（参考图同样如此），不把游标甩出去
    return { h: angleToHue(ang < 0 ? ang + 360 : ang), s: Math.min(1, d) }
  }

  wheelCanvas.addEventListener('pointerdown', (e: PointerEvent) => {
    const pos = wheelFromEvent(e)
    if (!pos) return
    dragging = 'wheel'
    safeCapture(wheelCanvas, e.pointerId)
    hsv = { ...hsv, h: pos.h, s: pos.s }
    syncHexFromHsv()
    cb.onPreview(currentHex)
    refresh()
  })
  wheelCanvas.addEventListener('pointermove', (e: PointerEvent) => {
    if (dragging !== 'wheel') return
    const pos = wheelFromEvent(e)
    if (!pos) return
    hsv = { ...hsv, h: pos.h, s: pos.s }
    syncHexFromHsv()
    cb.onPreview(currentHex)
    refresh()
  })

  const valueFromEvent = (e: PointerEvent): void => {
    const rect = valueBar.getBoundingClientRect()
    if (!(rect.height > 0)) return
    const ratio = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height))
    hsv = { ...hsv, v: ratio }
    syncHexFromHsv()
    cb.onPreview(currentHex)
    refresh()
  }
  valueBar.addEventListener('pointerdown', (e: PointerEvent) => {
    dragging = 'value'
    safeCapture(valueBar, e.pointerId)
    valueFromEvent(e)
  })
  valueBar.addEventListener('pointermove', (e: PointerEvent) => {
    if (dragging === 'value') valueFromEvent(e)
  })

  /**
   * 按"归一化比例"设置某个通道（0–1）。唯一实现，供两条输入路径共用：
   *   · 拖动滑条 → 位置比例 → 本函数
   *   · 手动输入数字 → 解析成比例 → 本函数
   * 共用一套语义，避免"拖出来的值"和"输入的值"刻度不一致。
   *
   * **R/G/B 走字节直改**（不经过 HSV 往返）：HSV⇄RGB 各自都有取整，
   * 往返一次就可能把值"弹"回原字节——实测把 G 拖到 0.1（期望字节 26）会算回 26，
   * 于是"怎么拖都不变"。现在直接改字节、只在最后从结果反推一次 HSV，微调能精确落位。
   */
  function setChannelRatio(key: string, ratio: number): void {
    const r = Math.max(0, Math.min(1, ratio))
    if (key === 'R' || key === 'G' || key === 'B') {
      // 以 currentHex 为准改一个字节；HSV 只反推一次（不再走 hexOfHsv 造成第二次往返）
      const c = hexToRgb(currentHex)
      const byte = Math.max(0, Math.min(255, Math.round(r * 255)))
      const next = { ...c, [key.toLowerCase()]: byte }
      currentHex = rgbToHex(next.r, next.g, next.b)
      hsv = rgbToHsv(next.r, next.g, next.b)
      return
    }
    if (key === 'H') {
      hsv = { ...hsv, h: r * 360 }
      syncHexFromHsv()
      return
    }
    if (key === 'S') {
      hsv = { ...hsv, s: r }
      syncHexFromHsv()
      return
    }
    if (key === 'V') {
      hsv = { ...hsv, v: r }
      syncHexFromHsv()
    }
  }

  /**
   * 数值行的拖动：几何基准是**滑条轨道**（不是整行）。
   *
   * 用轨道而不是整行有两个原因：① 填充是画在轨道里的，"点在轨道的哪里"必须等于
   * "填充画到哪里"，否则轨道右端永远拖不到 1.0；② 数值框在轨道之外，点它不会触发这里。
   *
   * 之所以要绑这六个行：这些行看上去就是滑条，但当初只有 Alpha 绑了指针事件时，
   * 另外六行"能看不能拖"——用户反馈的"RGB / HSV 滑条划不动"就是这个原因。
   */
  const rowFromEvent = (key: string) => (e: PointerEvent): void => {
    const track = rowTracks.get(key)
    if (!track) return
    const rect = track.getBoundingClientRect()
    if (!(rect.width > 0)) return // 不可见时 rect 全 0，继续算会除零产生 NaN
    setChannelRatio(key, (e.clientX - rect.left) / rect.width)
    cb.onPreview(currentHex)
    refresh()
  }

  for (const key of sliderKeys) {
    const track = rowTracks.get(key)
    if (!track) continue
    const handler = rowFromEvent(key)
    track.addEventListener('pointerdown', (e: PointerEvent) => {
      dragging = key
      safeCapture(track, e.pointerId)
      handler(e)
    })
    track.addEventListener('pointermove', (e: PointerEvent) => {
      if (dragging === key) handler(e)
    })
  }

  const alphaFromEvent = (e: PointerEvent): void => {
    // 同样以轨道为几何基准：数值框在轨道外，拖不动它
    const rect = alphaTrack.getBoundingClientRect()
    if (!(rect.width > 0)) return
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    // 越过中线就翻状态：整条轨道都有响应，来回拖会实时来回翻（见 ALPHA_MID 注释）
    alphaOpaque = ratio >= ALPHA_MID
    if (alphaOpaque) {
      cb.onOpaque()
      cb.onPreview(currentHex)
    } else {
      cb.onTransparent()
    }
    refresh()
  }
  alphaTrack.addEventListener('pointerdown', (e: PointerEvent) => {
    dragging = 'alpha'
    safeCapture(alphaTrack, e.pointerId)
    alphaFromEvent(e)
  })
  alphaTrack.addEventListener('pointermove', (e: PointerEvent) => {
    if (dragging === 'alpha') alphaFromEvent(e)
  })

  function endDrag(): void {
    if (!dragging) return
    const finished = dragging
    dragging = null
    // 停在透明区：不提交（透明色由 onTransparent 直接改 store，不进撤销栈）
    if (finished === 'alpha' && !alphaOpaque) return
    cb.onCommit(currentHex)
    // 回写显示值：整行拖动时输入框可能正处于聚焦状态，
    // 而 paintFields 会跳过聚焦的输入框，于是它会停留在旧数字上；
    // 用户后续在这格按回车/失焦就会用旧值把拖动结果覆盖掉。
    paintFields()
  }
  window.addEventListener('pointerup', endDrag)
  window.addEventListener('pointercancel', endDrag)
  // 失焦兜底：拖到窗口外松手时不会把拖拽状态悬挂住
  window.addEventListener('blur', endDrag)

  repaint()

  return {
    update: (patch) => {
      const targetChanged = patch.target !== undefined && patch.target !== state.target
      const prevValue = state.value
      state = { ...state, ...patch }
      if (patch.showAlpha !== undefined) showAlpha = patch.showAlpha !== false
      if (patch.value && (targetChanged || patch.value !== prevValue) && dragging === null) {
        const norm = normalizeHex(patch.value)
        if (norm) {
          currentHex = norm
          hsv = rgbToHsv(...rgbTuple(norm))
        }
      }
      repaint()
    },
    dispose: () => {
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
      window.removeEventListener('blur', endDrag)
    },
  }
}

function rgbTuple(hex: string): [number, number, number] {
  const c = hexToRgb(hex)
  return [c.r, c.g, c.b]
}

/**
 * 安全地捕获指针：`setPointerCapture` 在"pointerId 不是当前活跃指针"时会抛 NotFoundError
 * （合成事件、程序化派发、部分触控设备都会命中）。一旦它抛在处理器开头，后面的取色逻辑整段不执行，
 * 表现为"拖动没反应"——本项目在自动化验证里真实踩到过。捕获失败只影响"拖出元素后是否继续收事件"，
 * 不影响取色，因此这里直接吞掉。
 */
function safeCapture(el: HTMLElement, pointerId: number): void {
  try {
    el.setPointerCapture?.(pointerId)
  } catch {
    /* 指针未注册或已释放：忽略 */
  }
}