/**
 * 工作色板的色块编辑器：**微调此颜色**（改色板条目的值）与**替换为…**（把该色的格子全换成另一色）。
 *
 * 为什么是独立工厂（与 `matte-field.ts` 同构）：这里的状态必须**跨渲染存活**。
 * 色板每次 `renderAll()` 都重建 DOM，而"正在编辑哪个色块、取色器实例、预览中的色板"
 * 一旦跟着重建，指针捕获就丢了——表现为"一拖就断"。所以宿主只创建一次、
 * 实例只 `update` 不重建，调用方每次渲染只把它放回原位。
 *
 * ## 提交模型：**会话级提交**（与既有取色器不同，这是有意的）
 *
 * | 时机 | 行为 |
 * |---|---|
 * | 拖动中 | **只预览**：改画布显示，模型不动、撤销栈不动 |
 * | 「完成」/ 收起 | **提交一条撤销** |
 * | **Esc** | **放弃**：还原显示、关闭、**不产生任何撤销帧** |
 *
 * 为什么不像主色取色器那样"松手就提交"：色板是一次**连续调色**的过程，
 * 松手即提交会让一次调色产生几十条撤销（每帧一条），历史立刻被冲垮。
 * 会话级提交保证"一次编辑 = 恰好一条撤销"，不管中间拖了多少下；
 * 并且让"取消"成为**纯取消**——不必去撤销栈里回退若干帧。
 *
 * 取消用 **Esc** 而不是右键：右键在浏览器里自带上下文菜单语义，
 * 拿它当"取消"与用户预期打架（早期版本实现过右键取消，已移除）。
 *
 * ## 两个功能共用一个预览原语
 *
 * 像素存的是色板下标，所以"把色板第 i 项临时改成新色"这一个动作，
 * **对两个功能都是正确的预览**（微调 = 那条色变；替换 = 用该色的格子看起来变成新色）。
 * 区别只在提交：微调改色板条目，替换跑 `replaceAny` 改下标。
 * 这也是本模块只需要一个预览状态机的原因。
 */
import type { PixelArt } from '../../core/types.ts'
import type { ColorPickerApi, ColorPickerCallbacks } from './colorpicker.ts'
import { createColorPicker } from './colorpicker.ts'
import { clear, el } from '../store.ts'

/** `tune` = 改色板条目的值；`replace` = 把该色的格子换成目标色（replaceAny） */
export type SwatchAction = 'tune' | 'replace'

export interface SwatchEditorDeps {
  getArt: () => PixelArt | null
  /**
   * 拖动预览：**只改画布显示**，不动模型、不进撤销栈。
   * 传 `null` 表示回到模型真值（放弃 / 未预览时用）。
   */
  previewPalette: (palette: string[] | null) => void
  /** 提交微调：把下标 `index` 处的色板条目改成 `hex`（与已有色重复由调用方合并） */
  commitTuned: (index: number, hex: string) => void
  /** 提交替换：把下标 `index` 处的颜色整体换成 `hex` */
  commitReplaced: (index: number, hex: string) => void
  /** 取色器下方的色板分组（复用调用方的 pickerGroups） */
  groups: () => { name: string; colors: string[] }[]
  /** 状态变化后请调用方重渲染（色块高亮、预览中的色板底色都要跟着更新） */
  rerender: () => void
  toast: (message: string, kind?: 'info' | 'warn' | 'error') => void
}

export interface SwatchEditorApi {
  /** 稳定宿主：**只创建一次**，调用方每次渲染把它放回原位即可 */
  readonly host: HTMLElement
  /** 打开编辑器。`index` 是**色板下标**（不是 hex——色板允许重复 hex，只有下标唯一） */
  open: (index: number, action: SwatchAction) => void
  /** 提交并关闭（「完成」按钮 / 取色器「收起」） */
  commit: () => void
  /** 放弃并关闭（**Esc**）：还原画布显示，不产生撤销帧 */
  abandon: () => void
  isOpen: () => boolean
  /** 正在编辑的下标；未打开为 null（供色块高亮） */
  editingIndex: () => number | null
  /** 当前动作（供标题文案与 e2e 断言） */
  action: () => SwatchAction | null
  /**
   * 预览中的色板；**未预览时为 null**。
   * 调用方用它渲染色块底色——否则会出现"画布变了色、色板还是旧色"的矛盾画面。
   */
  displayPalette: () => string[] | null
  /** 每次渲染时调用：同步标题，并把取色器挂上或摘掉 */
  render: () => void
}

export function createSwatchEditor(deps: SwatchEditorDeps): SwatchEditorApi {
  /**
   * 宿主（只创建一次、跨渲染存活，见文件头）。
   *
   * 结构 = **[标题行 + 手势提示][取色器槽]**，即"操作头"排在取色器**上方**。
   * 为什么把「完成」放上面、而不是像合成底色那样放底下：取色器本体接近 900px 高，
   * 左栏又是个滚动容器——按钮放底下时，`scrollIntoView` 把编辑器滚进视野后，
   * 用户第一眼看到的是色轮、而"怎么提交/怎么放弃"要往下滚一屏才看得到。
   * 排在顶部则一展开就同时看见"在改哪个色、怎么结束"。
   */
  const headLabel = el('span', { class: 'swatch-editor-title' })
  const hint = el('span', { class: 'hint' }, ['拖动实时预览 · 「完成」= 提交 · Esc = 放弃'])
  const doneBtn = el('button', {
    class: 'btn tiny primary swatch-editor-done',
    type: 'button',
    'data-testid': 'swatch-editor-done',
    onclick: () => commit(),
  }, ['完成'])
  const pickerSlot = el('div', { class: 'swatch-editor-slot' })
  const host = el('div', { class: 'picker-wrap swatch-editor', 'data-testid': 'swatch-editor' }, [
    el('div', { class: 'swatch-editor-info' }, [
      el('div', { class: 'swatch-editor-head' }, [headLabel, doneBtn]),
      hint,
    ]),
    pickerSlot,
  ])

  let picker: ColorPickerApi | null = null
  let index: number | null = null
  let act: SwatchAction | null = null
  /** 打开时的色板快照：放弃要还原到这里；提交也算"相对它改了什么" */
  let original: string[] = []
  /** 预览中的色板（null = 没有预览，显示模型真值） */
  let preview: string[] | null = null
  /**
   * 「刚展开」一次性标记：展开后把编辑器滚进视野。
   * 色板可能有 256 格（很高），编辑器排在网格之后就直接落到视口外——
   * 用户点完看到的画面毫无变化，反馈就是"点击没反应"。只滚一次，
   * 之后的重渲染不再滚（否则拖动调色时会跟用户自己的滚动打架）。
   */
  let justOpened = false

  const art = (): PixelArt | null => deps.getArt()

  /*
   * 这里曾经把**右键**实现成"放弃"。已移除：浏览器里右键自带上下文菜单语义，
   * 拿它当取消与用户预期打架（实测还得分 `contextmenu` 与 `buttons & 2` 两条信号才收得全）。
   * 取消改由 **Esc** 承担——那是浏览器里通用的"取消当前操作"，见 `abandon()`。
   */

  /** 预览用的色板：把第 index 项换成 hex */
  function withColor(i: number, hex: string): string[] {
    const next = [...original]
    next[i] = hex
    return next
  }

  /** 还原画布显示到模型真值 */
  function revert(): void {
    if (preview === null) return
    preview = null
    deps.previewPalette(null)
  }

  /** 清空会话状态并摘掉宿主（不碰模型、不碰撤销栈） */
  function closeInternal(): void {
    index = null
    act = null
    preview = null
    original = []
    picker?.dispose()
    picker = null
    clear(pickerSlot)
    host.remove()
  }

  function open(i: number, action: SwatchAction): void {
    const a = art()
    if (!a) return
    if (!Number.isInteger(i) || i < 0 || i >= a.palette.length) return
    /*
     * 只要已经开着会话，就先把上一轮**提交**掉——无论接下来是不是同一个色块。
     *
     * 这里踩过两次（都属于"用户的调整无声无息消失"这一类，最难排查）：
     *  1. 原先是 `revert()` → "改完色块 A 不点完成、直接去改色块 B"会让 A 的调整被丢掉；
     *  2. 改成"仅当 i 不同才 commit"后，**同一个色块**再点一次微调又会丢掉上一轮
     *     （`index === i` 时跳过了提交，而紧接着的 `preview = null` 把成果抹掉了）。
     * 所以判据不是"换了目标没有"，而是"**有没有开着会话**"——有就先收尾。
     *
     * 会话级提交（拖动只预览）是为了让**取消**成为纯取消，不该顺带把"切目标 / 重新打开"
     * 也变成取消：那几个动作在用户心里与"放弃"完全是两回事。
     *
     * 走 `commit()` 而不是就地处理：它已封装"有改动才提交、没改动不产生撤销帧"，
     * 复用即可与点「完成」走同一条路径（含合并重复色等语义），且它会 `closeInternal()`
     * 把 index 清空，所以随后的赋值是干净的开新会话。
     */
    if (index !== null) commit()
    original = [...a.palette]
    index = i
    act = action
    preview = null
    justOpened = true
    deps.rerender()
  }

  function commit(): void {
    const i = index
    const a = art()
    if (i === null || !a) {
      closeInternal()
      deps.rerender()
      return
    }
    const hex = preview?.[i]
    const action = act
    const changed = hex !== undefined && hex !== original[i]
    closeInternal()
    if (changed && hex !== undefined) {
      if (action === 'replace') deps.commitReplaced(i, hex)
      else deps.commitTuned(i, hex)
    } else {
      // 没有任何改动：不产生撤销帧、不弹提示（没发生过的事不该有反馈）
      deps.previewPalette(null)
      deps.rerender()
    }
  }

  /** 放弃：还原画布显示并按原样关闭（不产生撤销帧）。由 **Esc** 触发，见文件的右键注释 */
  function abandon(): void {
    if (index === null) return
    const hadChange = preview !== null
    revert()
    closeInternal()
    deps.rerender()
    if (hadChange) deps.toast('已放弃本次调整（Esc）')
  }

  /** 构建（或更新）取色器；未打开时释放实例——收起后不该留着全局监听 */
  function renderPicker(): void {
    if (index === null) return
    const a = art()
    if (!a) return
    const value = preview?.[index] ?? a.palette[index] ?? '#000000'
    try {
      if (!picker) {
        // 传槽而不是宿主：这样页脚能稳定排在取色器下方（`.cp` 是它自己 append 的）
        picker = createColorPicker(pickerSlot, { target: 'palette', value, groups: deps.groups(), showAlpha: false }, callbacks())
      }
      picker.update({ target: 'palette', value, groups: deps.groups(), showAlpha: false })
    } catch (err) {
      // 构建失败不能静默（否则又是"点了没反应"，排查要花很久）：把原因留在 DOM 上并显示出来
      const target = document.getElementById('canvas-host')
      if (target) target.dataset.pickerError = (err as Error)?.message ?? String(err)
      console.error('[取色器] 色板编辑器构建失败：', err)
      clear(pickerSlot)
      pickerSlot.append(el('div', { class: 'hint' }, [`取色器不可用：${(err as Error)?.message ?? err}`]))
    }
  }

  function callbacks(): ColorPickerCallbacks {
    return {
      /*
       * 拖动中**只预览**：改画布显示 + 让色板那边的底色跟着变。
       * 不碰模型、不进撤销栈——这是会话级提交能成立的关键。
       */
      onPreview: (hex) => applyPreview(hex),
      /*
       * 取色器在"松手 / 输入 / 点色板"时会回调 onCommit——但这里**不提交**，
       * 只把预览值固定下来（会话级提交，见文件头）。真正落库在「完成」。
       */
      onCommit: (hex) => applyPreview(hex),
      /*
       * 透明色那条路（Alpha 滑条 / 透明块）在本编辑器里没有意义——改的是画布上的实色。
       * `showAlpha: false` 已把它们从界面藏掉，但接口要求给全，故给空实现：
       * 万一将来哪里漏出一次调用，也不会把 `store.transparent` 打开（那才是真正有害的副作用）。
       */
      onTransparent: () => {},
      onOpaque: () => {},
      isTransparent: () => false,
      /*
       * 吸管：本编辑器**不提供**（要取画布上的色，应当关掉这里再去画布上吸）。
       * 给一句明确提示而不是静默——取色器里那个按钮是可见的，点了没反应正是本项目最忌讳的。
       */
      onPickFromCanvas: () => {
        deps.toast('这里不支持吸管：请拖动色轮选色，或先用主色取色器的吸管取好再回来', 'warn')
      },
      /** 取色器的「收起」= "就这样" → 提交（与页脚「完成」同义） */
      onClose: () => commit(),
    }
  }

  function applyPreview(hex: string): void {
    if (index === null) return
    preview = withColor(index, hex)
    deps.previewPalette(preview)
    deps.rerender()
  }

  return {
    host,
    open,
    commit,
    abandon,
    isOpen: () => index !== null,
    editingIndex: () => index,
    action: () => act,
    displayPalette: () => preview,
    render: () => {
      if (index === null) {
        host.remove()
        return
      }
      const a = art()
      // 画布没了（清空/重置）或色板变短了：编辑器无从编辑，直接收掉，
      // 别留一个指向不存在下标的浮层（那会让后续提交写到错的位置）
      if (!a || index >= a.palette.length) {
        closeInternal()
        return
      }
      const src = original[index] ?? a.palette[index]
      headLabel.textContent = act === 'replace' ? `替换 ${src} 为` : `微调 ${src}`
      renderPicker()
      if (justOpened) {
        justOpened = false
        // 'nearest'：已经看得见就不动，避免每次重渲染都抢用户的滚动
        host.scrollIntoView({ block: 'nearest' })
      }
    },
  }
}
