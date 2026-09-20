/**
 * 带滑条的数值字段（标签 + 数值框一排，滑条独占下面一行）。
 *
 * 抽成独立模块的理由与 `matte-field.ts` 同源：**它持有跨渲染的状态**。
 * 参数面板每次 `renderAll()` 都重建 DOM，而"正在拖哪个滑条"必须活过重渲染——
 * 拖动中的每一帧都会触发一次重渲染（参数变了 → 重跑管线 → `renderAll()`），
 * 若把拖拽状态放在渲染函数里，第一帧就把自己冲掉了，表现为"一拖就断"。
 * 所以这里的做法是：**结构与状态只建一次**（`field()` 返回的节点与 `dragging` 都活在闭包里），
 * 面板每次渲染只把同一个节点放回原位、再调 `sync()` 刷新外观。
 *
 * 三个参数（亮度 / 对比度 / 饱和度）各自一个实例，互不共享状态；但都走
 * `parse` → `apply` 两条出口：拖动与手动输入是**同一个 `apply`**，
 * 不会出现"拖出来的值"与"输入的值"刻度不一致。
 *
 * 预算是 400 行（docs/开发.md §4.2），这个文件按"标签行 / 轨道 / 指针 / 数值输入"分段，
 * 每段只做一件事。
 */
import { el } from '../store.ts'

export interface NumSliderOptions {
  /** 主标签，同时用作 `title` 前缀（例：`亮度`） */
  label: string
  min: number
  max: number
  /** 一步的大小（数值框的 step，也用于键盘方向键） */
  step?: number
  /** 中位值：填充从这里向两侧生长；`title` 里也会拿它讲一句"中位" */
  neutral?: number
  /** 数值框右侧单位（例：`格`） */
  unit?: string
  /** 悬浮说明；缺省时用一句按 min/max 生成的通用说明 */
  title?: string
  /** 面板渲染时取当前值（第三方真源：参数在 `app.params` 里，这里不缓存） */
  get: () => number
  /**
   * 提交一个新值。
   *
   * ⚠️ 拖动中会被**连续调用**（每帧一次）。调用方必须在实现里避免昂贵操作——
   * 本项目里画布像素是按需从模型重算的，所以"边拖边看"是免费的；但绝不能在这里
   * 做导出、落盘、弹提示这类有副作用的事（会被调上百次）。
   */
  apply: (value: number) => void
}

export interface NumSliderApi {
  /** 稳定的字段节点。**只创建一次**，面板每次渲染把它放回原位即可 */
  readonly element: HTMLElement
  /** 面板每次渲染时调用：按当前值刷新手柄 / 填充 / 数值框 */
  sync: () => void
}

/**
 * 手柄尺寸，必须与 `style.css` 的 `.num-slider-thumb` 一致。
 * 定位要减掉半个手柄，取值不准手柄就会偏离它代表的数值位置（右端尤其明显）。
 */
const THUMB_SIZE = 14

/**
 * 拖动期的全局类名，与 `style.css` 的 `body.is-dragging-num` 配对。
 *
 * 拖动中把整个页面的光标钉成 `ew-resize` 并禁掉选区（见那条 CSS 的注释）：
 * 指针一旦离开 6px 的轨道（真实鼠标拖动时几乎必然发生），
 * 否则光标会变回箭头/文本光标，而且**沿途的文字会被选中**——
 * 用户看到的就是"鼠标变回去了、滑条不动了"。
 *
 * 用模块级计数而不是布尔量：同一页面上有多个滑条，理论上可能同时进入拖动
 * （触屏多点），谁先松手就把类摘掉会误伤另一个。计数归零才摘。
 */
let activeDrags = 0

function beginGlobalDrag(): void {
  activeDrags += 1
  document.body.classList.add('is-dragging-num')
}

function endGlobalDrag(): void {
  activeDrags = Math.max(0, activeDrags - 1)
  if (activeDrags === 0) document.body.classList.remove('is-dragging-num')
}

export function createNumSlider(opts: NumSliderOptions): NumSliderApi {
  const { min, max } = opts
  const step = opts.step ?? 1
  /** 中位：夹进合法区间，避免调用方给个越界值让填充算到轨道外 */
  const neutral = Math.max(min, Math.min(max, opts.neutral ?? min))
  const unit = opts.unit ?? ''

  /**
   * 正在拖动本滑条？跨渲染存活（见文件头）。记 `pointerId` 而不是布尔量：
   * 同一滑条上可能先后有两个指针（触屏多点），只认最初按下的那一个——
   * 否则第二个手指落下会把第一个手指的拖动状态顶掉。
   *
   * `fallback` 记录"指针捕获没成功、只能靠 window 那条通道"。
   * 目前两个字段的取值都不影响判定（两条通道都在跑），但它让
   * "捕获到底成没成功"在调试时可见——这个词曾经是静默吞掉的。
   */
  let dragging: { id: number; fallback: boolean } | null = null

  const clamp = (v: number): number => Math.max(min, Math.min(max, v))
  const fmt = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2))

  /* ------------------------------------------------------------ 结构 */

  const input = el('input', {
    class: 'num num-slider-num',
    type: 'number',
    // 数值框自带 min/max/step：浏览器会管住方向键与上下微调按钮的量
    min: String(min),
    max: String(max),
    step: String(step),
    // 拖动中不重建 DOM，但输入框的 value 要跟着手柄走（sync 里写），
    // 所以这里不绑 input 事件——每次按键都提交会白跑管线，与号色表同一个理由。
    onchange: (e: Event) => {
      const raw = Number((e.target as HTMLInputElement).value)
      // 非数字（清空后失焦）一律回退到当前值，不要把 NaN 写进参数
      apply(Number.isFinite(raw) ? raw : value())
    },
  })

  const fill = el('div', { class: 'num-slider-fill' })
  const thumb = el('div', { class: 'num-slider-thumb' })
  const track = el('div', { class: 'num-slider-track' }, [fill, thumb])
  /**
   * 真正接收指针事件的是外面这层 24px 高的透明命中区（见 style.css 里 `.num-slider-hit` 的注释）。
   *
   * 拖动期间**不把指针留在轨道上**才算手感对：真实鼠标总会有纵向抖动，
   * 只有 6px 高的轨道留不住它。命中区给足余量，再叠加拖动期的全局光标，
   * 才做到"按住之后怎么动都不掉"。几何换算一律以 `track` 为准
   * （命中区上下多出来的高度不属于数值行程，用它会让两端拖不满）。
   */
  const hit = el('div', { class: 'num-slider-hit' }, [track])

  const title =
    opts.title ?? `${opts.label}（${fmt(min)}…${fmt(max)}，中位 ${fmt(neutral)}）——拖动滑条或直接输入，画面实时更新`
  track.title = title
  input.title = title
  // 数值框右侧的"格"这类单位：不参与 input 的值，只是给眼睛一个刻度提示。
  // 用 `title` 而不是直接拼进 value：拼进去会被 Number() 解析成 NaN。
  const head = el('div', { class: 'num-slider-head' }, [
    el('label', { for: id() }, [opts.label]),
    input,
    unit ? el('span', { class: 'hint' }, [unit]) : null,
  ])
  input.id = id()

  const element = el('div', { class: 'field num-slider', 'data-testid': `num-slider-${testKey()}` }, [head, hit])

  /**
   * 每个实例一个稳定 id / testid。
   * `for` 与 `id` 必须成对（标签可点即聚焦数值框），而 `data-testid` 让断言不必靠
   * DOM 顺序或文本匹配定位——面板重排时后者会**静默指错元素**（docs/开发.md §3.2 的教训）。
   */
  function id(): string {
    return `num-slider-${slug(opts.label)}`
  }
  function testKey(): string {
    return slug(opts.label)
  }
  function slug(s: string): string {
    // 中文标签 → 拼音会让断言依赖翻译，所以直接用 UTF-8 码点编号，稳定且无歧义
    let out = ''
    for (const ch of s) out += /[a-z0-9]/i.test(ch) ? ch.toLowerCase() : `u${ch.codePointAt(0)?.toString(16)}`
    return out
  }

  /* ------------------------------------------------------------ 取值与绘制 */

  /** 当前真值（来自调用方，不缓存——见 `get` 的注释） */
  const value = (): number => clamp(Number(opts.get()) || 0)

  const apply = (v: number): void => {
    const next = clamp(Math.round(v / step) * step)
    // 同值不提交：拖动时会连续落在同一个整数上，重复提交等于白跑一遍管线
    if (next === value()) {
      paint(next)
      return
    }
    opts.apply(next)
    paint(next)
  }

  /**
   * 画手柄与填充。
   *
   * 位置一律按**比例**算（不是按像素），因此轨道多宽都正确；`sync()` 与拖动中共用这一条，
   * 不会出现"拖到哪"与"画到哪"两套算法。
   */
  function paint(v: number): void {
    const span = max - min
    const ratio = span > 0 ? (v - min) / span : 0
    thumb.style.left = `calc(${(ratio * 100).toFixed(3)}% - ${THUMB_SIZE / 2}px)`
    const nRatio = span > 0 ? (v - neutral) / span : 0
    // 填充从中点向单侧生长：正值向右（left:50%）、负值向左（right:50%）、0 则宽度为 0
    const width = `${(Math.abs(nRatio) * 100).toFixed(3)}%`
    if (nRatio >= 0) {
      fill.style.left = '50%'
      fill.style.right = 'auto'
    } else {
      fill.style.left = 'auto'
      fill.style.right = '50%'
    }
    fill.style.width = width
    // 正在输入时不回写：否则用户打了一半的数字会被真值覆盖（与取色器 paintFields 同一处理）
    if (document.activeElement !== input) input.value = String(v)
  }

  /* ------------------------------------------------------------ 指针拖动 */

  /**
   * 由指针位置换算数值。
   *
   * 轨道不可见时 `rect.width === 0`（侧栏收起 / 抽屉关着 / 分组折叠），
   * 此时**直接返回不动作**：除零会得到 Infinity/NaN，一路写进参数就是 `#NaNNaNNaN`
   * 那一类非法状态（取色器与滑条断言都专门守过这条）。
   */
  function valueFromPointer(e: PointerEvent): number | null {
    const rect = track.getBoundingClientRect()
    if (!(rect.width > 0)) return null
    const ratio = e.clientX <= rect.left ? 0 : e.clientX >= rect.right ? 1 : (e.clientX - rect.left) / rect.width
    return min + ratio * (max - min)
  }

  track.addEventListener('pointerdown', (e: PointerEvent) => {
    const v = valueFromPointer(e)
    if (v === null) return
    /*
     * 左键以外不接管（右键菜单、中键粘贴等）。`button` 在触摸/笔上是 0，所以触屏照样能拖。
     * 不做这一步的话，右键按下也会开始拖并改参数，然后弹出上下文菜单——手上就变成"跳一下"。
     */
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.preventDefault()
    dragging = { id: e.pointerId, fallback: false }
    beginGlobalDrag()
    /*
     * 指针捕获只是**优化**（让事件即使离开元素也继续投递给它），不是正确性的前提：
     * 下面 window 上的 pointermove 是并行的第二条通道。两者同时存在是**故意冗余**的——
     * 捕获成功时事件被重定向到轨道、冒泡仍会到 window，靠 pointerId 去重；
     * 捕获失败（合成事件 / 部分设备 / 指针已失效）时 window 那条照常工作。
     * 之前只依赖捕获、失败又静默吞掉，结果就是"指针一离开轨道就再也拖不动"。
     */
    if (!safeCapture(track, e.pointerId)) dragging.fallback = true
    // 点哪跳哪（与取色器滑条一致）：先跳再拖，用户不会觉得"必须先抓住手柄"
    apply(v)
  })

  /** 拖动中：按指针位置更新数值。轨道被隐藏时 `valueFromPointer` 返回 null，这里自然不动 */
  const dragTo = (e: PointerEvent): void => {
    if (!dragging || dragging.id !== e.pointerId) return
    const v = valueFromPointer(e)
    if (v === null) return
    apply(v)
  }

  /*
   * 两条投递通道都接上同一个 `dragTo`（见 pointerdown 里的说明）：
   *  · 轨道上：指针还在轨道内（或捕获成功后事件被重定向过来）时的主通道；
   *  · window 上：指针离开轨道后的兜底通道，**带捕获去重是必需的**——
   *    捕获成功时事件会先在轨道上触发、再冒泡到 window，两条都调就会对同一个事件
   *    算两遍（虽然结果幂等，但每帧多跑一次换算与重绘是白费）。
   *
   * 用捕获阶段（`true`）监听 window：面板上的其它控件若在冒泡路径上
   * `stopPropagation()`，冒泡那条就断了；捕获阶段先于目标节点触发，挡不住。
   */
  track.addEventListener('pointermove', dragTo)
  window.addEventListener('pointermove', dragTo, true)

  /**
   * 收尾。三个来源都要挂：`pointerup`（正常松手）、`pointercancel`（触摸被系统手势打断）、
   * `blur`（拖到窗口外松手，此时浏览器不一定再发 pointerup）。
   *
   * 挂在 window 上而不是轨道上：指针捕获若失败，事件根本不会回到轨道；
   * 而 window 在冒泡链的最外层，两种情况都能收到。`pointerup` 用捕获阶段，
   * 与 pointermove 同理（别人 stopPropagation 也挡不住收尾，否则会留下"松手了还在拖"）。
   */
  const endDrag = (e?: PointerEvent): void => {
    if (!dragging) return
    if (e && e.pointerId !== dragging.id) return
    dragging = null
    endGlobalDrag()
    // 松手时按真值回写一次：拖动中若数值框处于聚焦状态，paint 会跳过它，
    // 于是它停在旧数字上，用户之后在这格按回车就会把拖动结果覆盖掉。
    paint(value())
  }
  window.addEventListener('pointerup', endDrag, true)
  window.addEventListener('pointercancel', endDrag, true)
  window.addEventListener('blur', () => endDrag())

  /*
   * 这里曾经实现过"右键放弃本次调整"，已移除：浏览器里右键自带上下文菜单语义，
   * 拿它当"取消"与用户预期打架（且 Windows 与 macOS 的 contextmenu 时机不同，
   * 拖动中还要额外靠 `buttons & 2` 兜底才收得到）。参数拖错了就反向拖回去。
   */

  const api: NumSliderApi = {
    element,
    sync: () => paint(value()),
  }
  api.sync()
  return api
}

/**
 * 安全地捕获指针，返回**是否捕获成功**。
 *
 * `setPointerCapture` 在"pointerId 不是当前活跃指针"时会抛 `NotFoundError`
 * （合成事件、程序化派发、部分触控设备都会命中）。这里必须把失败**如实返回**而不是吞掉：
 * 调用方据此知道"只能靠 window 那条兜底通道"，而不是以为捕获成功、
 * 结果指针一离开轨道就再也收不到事件（这正是此前"拖出滑条就断了"的成因）。
 *
 * 捕获失败本身不影响本次取值（pointerdown 是直接落在轨道上的），
 * 只影响"拖出元素后事件还回不回来"——所以它是可降级的，不是错误。
 */
function safeCapture(node: HTMLElement, pointerId: number): boolean {
  try {
    node.setPointerCapture?.(pointerId)
    return node.hasPointerCapture ? node.hasPointerCapture(pointerId) : true
  } catch {
    return false
  }
}
