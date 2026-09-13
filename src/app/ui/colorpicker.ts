/**
 * 取色器：按 **Blender 取色界面** 的结构实现（用户提供的参考图即 Blender）。
 *
 * Blender 取色器的布局要点（照此实现，不自行发挥）：
 *   ┌──────────────────────────────────────┐
 *   │ [RGB] [HSV] [Hex]                    │  ← 顶部色彩模型标签，切换下方数值行的单位
 *   │                                      │
 *   │      ╭───────────╮   ┌──┐            │  ← 左侧圆形色轮（中心白、外圈饱和）
 *   │      │   ◇游标   │   │  │            │  ← 右侧**竖向明度条**（上亮下暗）
 *   │      ╰───────────╯   └──┘            │
 *   │                                      │
 *   │  R 71   G 114   B 179                │  ← 数值行（单位随标签变化）
 *   │  [透明度横条 ▬▬▬▬▬▬▬▬▬▬]  1.000      │  ← 透明度用横条，最左 = 全透明
 *   │  ■ ■ ■ ■ ■ ■ ■ ■                     │  ← 色板（当前画布用到的颜色）
 *   └──────────────────────────────────────┘
 *
 * 与 Blender 的一个有意差异：**色相方向顺时针**（Blender 也是顺时针，从右侧 0° 起）。
 * 另一处差异：数值内部按 sRGB 处理（与 CSS / PNG / 项目文件一致），不做线性空间转换——
 * 若将来要对齐 Blender 的线性数值，只需在 `hexOfHsv()` / 输入回读处加一次转换，其余逻辑不动。
 *
 * 性能约束（继承上一版的硬要求）：**拖动中不重建 DOM**，只更新数值文本、游标与渐变；
 * 松手才提交（一次拖动 = 一条撤销），并且监听 window blur 兜底收尾，避免拖拽状态悬挂。
 */
import { colorTextOn, hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from '../../core/color.ts'
import { normalizeHex } from '../../core/types.ts'
import { clear, el } from '../store.ts'

export interface ColorPickerCallbacks {
  /** 拖动过程中持续回调（实时预览，不进撤销栈） */
  onPreview: (hex: string) => void
  /** 松手 / 数值输入 / 点色块：提交（进撤销栈） */
  onCommit: (hex: string) => void
  /** 透明度拖到最左 = 选「透明色」 */
  onTransparent: () => void
  /** 当前绘制色是否为透明色 */
  isTransparent: () => boolean
  /** 点吸管：让画布进入取色模式（下一次点击画布即取色） */
  onPickFromCanvas: () => void
  /** 关闭面板 */
  onClose: () => void
}

export interface ColorPickerState {
  target: 'primary' | 'bg'
  value: string
  /** 色板（工作色板 + 预置卡；分组显示） */
  groups: { name: string; colors: string[] }[]
}

export interface ColorPickerApi {
  update: (patch: Partial<ColorPickerState>) => void
  dispose: () => void
}

/** 色轮直径：与参考图里色轮占面板宽度的比例一致（约 200px 面板里的主视觉元素） */
const WHEEL_SIZE = 184
/** 右侧明度竖条的宽高 */
const BAR_W = 22
const BAR_H = WHEEL_SIZE

/**
 * 透明度滑条左端的"死区"比例（6%）。
 *
 * 为什么需要它：`getBoundingClientRect()` 返回小数，鼠标落在最左 1px 处算出来的比例可能是 0.006
 * 而不是 0——用 `<= 0.001` 判断会判定"没拖到底"，用户很难精确点到全透明。
 * 现在只要落进左端 6% 就视为"选了透明色"（该区域视觉上本来就是最透明的部分）。
 */
const ALPHA_ZERO_ZONE = 0.06

type ColorModel = 'rgb' | 'hsv' | 'hex'

export function createColorPicker(host: HTMLElement, initial: ColorPickerState, cb: ColorPickerCallbacks): ColorPickerApi {
  let state: ColorPickerState = { ...initial }
  let hsv = rgbToHsv(...rgbTuple(state.value))
  let dragging: 'wheel' | 'value' | 'alpha' | null = null
  let model: ColorModel = 'rgb'

  /* ------------------------------------------------------------ 结构 */

  const tabKeys: ColorModel[] = ['rgb', 'hsv', 'hex']
  const tabLabels: Record<ColorModel, string> = { rgb: 'RGB', hsv: 'HSV', hex: 'Hex' }
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
  valueBar.title = '明度（V）'

  const pickerBtn = el(
    'button',
    { class: 'cp-icon-btn', type: 'button', title: '吸管：点这里，然后到画布上点一格取色', onclick: () => cb.onPickFromCanvas() },
    ['✚'],
  )

  const wheelRow = el('div', { class: 'cp-wheel-row' }, [wheelWrap, el('div', { class: 'cp-bar-col' }, [valueBar, pickerBtn])])

  /* ---- 透明度横条 ---- */
  const alphaTrack = el('div', { class: 'cp-alpha' })
  const alphaKnob = el('div', { class: 'cp-knob' })
  alphaTrack.append(alphaKnob)

  /* ---- 数值行（按模型切换单位） ---- */
  const fieldsHost = el('div', { class: 'cp-fields' })
  const numField = (label: string, key: string) => {
    const input = el('input', {
      class: 'cp-num',
      type: 'text',
      inputmode: 'numeric',
      dataset: { field: key },
      onchange: (e: Event) => applyNumberField(key, (e.target as HTMLInputElement).value),
    })
    return el('label', { class: 'cp-field' }, [el('span', { class: 'cp-field-label' }, [label]), input])
  }
  const fieldInputs = new Map<string, HTMLInputElement>()
  for (const key of ['R', 'G', 'B', 'H', 'S', 'V', 'Hex']) {
    const node = numField(key === 'Hex' ? 'Hex' : key, key)
    fieldsHost.append(node)
    const input = node.querySelector('input') as HTMLInputElement
    fieldInputs.set(key, input)
  }

  /* ---- 色板 ---- */
  const swatchHost = el('div', { class: 'cp-swatches' })

  const closeBtn = el('button', { class: 'btn tiny', type: 'button', onclick: () => cb.onClose() }, ['收起'])

  const panel = el('div', { class: 'cp' }, [tabs, wheelRow, alphaTrack, fieldsHost, swatchHost, el('div', { class: 'cp-foot' }, [closeBtn])])
  clear(host)
  host.append(panel)

  /* ------------------------------------------------------------ 绘制 */

  const wheelCtx = wheelCanvas.getContext('2d')
  let lastDrawnV = Number.NaN

  /**
   * 画色轮：**中心白、外圈饱和**（Blender 的 HSV 圆盘 = 饱和度沿半径、色相沿角度）。
   * 只在明度变化时重画（拖动游标只改 transform，避免每帧重算 184² 像素）。
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
        let ang = (Math.atan2(dy, dx) * 180) / Math.PI
        if (ang < 0) ang += 360
        const c = hsvToRgb(ang, Math.min(1, d), v)
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

  /** 明度竖条：上亮下暗（与 Blender 一致），底部固定为黑 */
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
    const ang = (hsv.h * Math.PI) / 180
    const dist = Math.max(0, Math.min(1, hsv.s)) * r
    cursor.style.transform = `translate(${r + Math.cos(ang) * dist - 7}px, ${r + Math.sin(ang) * dist - 7}px)`
  }

  function paintTracks(): void {
    const hex = hexOfHsv()
    // 明度竖条游标（顶=100，底=0）
    valueKnob.style.top = `${(1 - hsv.v) * 100}%`
    // 透明度横条：左透明 → 右当前色
    alphaTrack.style.setProperty('--alpha-color', hex)
    // 透明态 = 游标在最左（与"最左 = 全透明"的语义一致）
    alphaKnob.style.left = `${cb.isTransparent() ? 0 : 100}%`
  }

  function paintFields(): void {
    const hex = hexOfHsv()
    const c = hexToRgb(hex)
    const set = (key: string, value: string) => {
      const input = fieldInputs.get(key)
      if (input && document.activeElement !== input) input.value = value
    }
    // 三个模型共用同一组输入框：切换标签时换单位与显隐
    for (const key of ['R', 'G', 'B', 'H', 'S', 'V', 'Hex']) {
      const node = fieldInputs.get(key)?.parentElement
      if (!node) continue
      const show = model === 'rgb' ? key === 'R' || key === 'G' || key === 'B' : model === 'hsv' ? key === 'H' || key === 'S' || key === 'V' : key === 'Hex'
      node.style.display = show ? '' : 'none'
    }
    set('R', String(c.r))
    set('G', String(c.g))
    set('B', String(c.b))
    set('H', String(Math.round(hsv.h)))
    set('S', String(Math.round(hsv.s * 100)))
    set('V', String(Math.round(hsv.v * 100)))
    set('Hex', hex.toUpperCase())
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
              class: `cp-swatch${cb.isTransparent() ? '' : ''}`,
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
    // 透明色块：Blender 没有，但本工具需要（画笔/填充挖洞），放在最后
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

  /** 数值行（按当前模型解析输入） */
  function applyNumberField(key: string, raw: string): void {
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
    const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)))
    if (key === 'R' || key === 'G' || key === 'B') {
      const c = hexToRgb(hexOfHsv())
      const next = { ...c, [key.toLowerCase()]: clamp(value, 255) }
      hsv = rgbToHsv(next.r, next.g, next.b)
    } else {
      const map: Record<string, [keyof typeof hsv, number]> = { H: ['h', 360], S: ['s', 100], V: ['v', 100] }
      const [field, max] = map[key]
      const v = clamp(value, max)
      hsv = { ...hsv, [field]: max === 100 ? v / 100 : v }
    }
    cb.onCommit(hexOfHsv())
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

  /** 拖动中的轻量刷新：只动数值/游标/渐变 */
  function refresh(): void {
    if (!Number.isFinite(lastDrawnV) || Math.abs(lastDrawnV - hsv.v) > 1e-6) drawWheel()
    drawValueBar()
    positionCursor()
    paintTracks()
    paintFields()
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
    let ang = (Math.atan2(dy, dx) * 180) / Math.PI
    if (ang < 0) ang += 360
    // 拖到圆外时饱和度夹到 1（Blender 同样如此），不把游标甩出去
    return { h: ang, s: Math.min(1, d) }
  }

  wheelCanvas.addEventListener('pointerdown', (e: PointerEvent) => {
    const pos = wheelFromEvent(e)
    if (!pos) return
    dragging = 'wheel'
    safeCapture(wheelCanvas, e.pointerId)
    hsv = { ...hsv, h: pos.h, s: pos.s }
    cb.onPreview(hexOfHsv())
    refresh()
  })
  wheelCanvas.addEventListener('pointermove', (e: PointerEvent) => {
    if (dragging !== 'wheel') return
    const pos = wheelFromEvent(e)
    if (!pos) return
    hsv = { ...hsv, h: pos.h, s: pos.s }
    cb.onPreview(hexOfHsv())
    refresh()
  })

  const valueFromEvent = (e: PointerEvent): void => {
    const rect = valueBar.getBoundingClientRect()
    if (!(rect.height > 0)) return
    const ratio = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height))
    hsv = { ...hsv, v: ratio }
    cb.onPreview(hexOfHsv())
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

  const alphaFromEvent = (e: PointerEvent): void => {
    const rect = alphaTrack.getBoundingClientRect()
    if (!(rect.width > 0)) return
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    if (ratio <= ALPHA_ZERO_ZONE) {
      cb.onTransparent()
    } else {
      cb.onPreview(hexOfHsv())
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
    if (finished === 'alpha' && cb.isTransparent()) return
    cb.onCommit(hexOfHsv())
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
      if (patch.value && (targetChanged || patch.value !== prevValue) && dragging === null) {
        hsv = rgbToHsv(...rgbTuple(patch.value))
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
