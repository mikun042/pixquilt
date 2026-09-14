/**
 * 「合成底色」字段 + **就地展开**的取色盘。
 *
 * 为什么单独一个模块：这一块的状态**必须跨渲染存活**，而参数面板每次 `renderAll()` 都会重建 DOM。
 * 原先它们散在 `index.ts` 里（取色盘实例、宿主元素、开合状态、"刚展开"标记、吸管待办标记），
 * 其中 4 个被 `renderParams` **既读又写**（例如 `mattePickerOpen = !mattePickerOpen` 写在控件的
 * `onclick` 闭包里）——这正是上一轮"想把参数面板拆成模块"失败的原因：机械搬代码必然改错语义。
 * 收进工厂后，面板那边只剩"把 `element` 放好 + 调 `render()`"，才可能被安全地拆出去。
 *
 * 三条踩过的坑（搬过来时一并保留原因，别当成可有可无的注释）：
 *  1. **取色盘要就地展开在这个字段下方**。第一版复用了左侧那个取色器，功能是通的、合成
 *     `.click()` 的断言也是绿的，但用户反馈"点击没反应"——他的视线在右侧面板，左边冒出来的
 *     东西根本不会被注意到。色块在这里，取色盘就该在这里。
 *  2. **宿主元素必须跨渲染存活**：拖动中若把它摘出文档，指针捕获会丢（拖动会触发重渲染，
 *     于是表现为"一拖就断"）。所以 `host` 只创建一次，收起时摘出文档但不销毁。
 *  3. **构建失败不能静默**：出错就把原因写到 `#canvas-host` 的 `dataset.pickerError` 并显示
 *     一行提示——否则表现就是"点了没反应"，排查要花很久（这里踩过一次）。
 */
import type { ColorPickerApi, ColorPickerCallbacks } from './ui/colorpicker.ts'
import { createColorPicker } from './ui/colorpicker.ts'
import { clear, el } from './store.ts'

export interface MatteFieldDeps {
  /** 当前合成底色（6 位 hex，无 alpha） */
  getValue: () => string
  /** 拖动中的实时预览：只改状态，**不重转管线** */
  preview: (hex: string) => void
  /** 提交（松手 / 输入 / 点色块）：写回参数并重转 */
  commit: (hex: string) => void
  /** 取色盘下方的色板分组（本图用色 / 最近使用 / 当前预置色卡） */
  groups: () => { name: string; colors: string[] }[]
  /**
   * 取色盘里的吸管被按下：请调用方把画布切进取色模式。
   * 之后画布取到的颜色会经 `takePendingPick()` 交给调用方写进合成底色。
   */
  armPick: () => void
  /** 面板状态变化（展开/收起）：请调用方重渲染参数面板 */
  rerender: () => void
  /**
   * 以下三个是 `ColorPickerCallbacks` 要求的"透明色"回调。合成底色传 `showAlpha: false`，
   * 界面上根本不出现那一行；但接口要求给全，故原样透传（不是死参数——换成主色/背景色时会用到）。
   */
  isTransparent: () => boolean
  setTransparent: () => void
  setOpaque: () => void
}

export interface MatteFieldApi {
  /** 稳定的字段节点（含标签 + 色块按钮）。**只创建一次**，面板每次渲染把它放回原位即可。 */
  readonly element: HTMLElement
  /** 每次参数面板渲染时调用：同步按钮外观，并决定取色盘挂上还是摘掉 */
  render: () => void
  /**
   * 画布取到颜色时调用：本次取色若来自本字段的吸管，则**消费掉待办**并返回 true。
   *
   * 返回 true 表示"这一格颜色属于合成底色"；调用方据此改写 `matteColor` 而不是主色。
   * 置位点在 `armPick` 触发的吸管回调里，消费点只有这一处——标志位必须成对，见
   * `docs/ARCHITECTURE.md` §8.10（只写不读的标志会连带提示语一起撒谎）。
   */
  takePendingPick: () => boolean
  /** 放弃待办取色（Esc / 关闭取色盘）：返回是否**原本**有待办 */
  clearPendingPick: () => boolean
  /** 切到「真 alpha」时字段会消失：把就地的取色盘一起收掉，别留孤儿宿主 */
  collapseForAlpha: () => void
}

export function createMatteField(deps: MatteFieldDeps): MatteFieldApi {
  let picker: ColorPickerApi | null = null
  /**
   * 取色盘宿主。**只创建一次**，跨渲染存活（见文件头第 2 条坑）。
   *
   * 宿主内部由取色器自己管理；收起时我们把它摘出文档并清空，但对象本身留着复用，
   * 因为"同一个宿主 + 同一个实例"才能保住拖动中的指针捕获。
   */
  const host = el('div', { class: 'picker-wrap inline' })
  let open = false
  /**
   * 「刚展开」的一次性标记：展开后要把取色盘滚进视野。
   *
   * 为什么需要：合成底色这个字段本来就在参数面板**靠底部**的位置，取色盘插在它下面就直接落到
   * 视口之外——用户点完看到的画面毫无变化，反馈就是"点击没反应"。只在刚展开时滚一次，
   * 之后的每次重渲染不再滚（否则拖动调色时会跟用户自己的滚动打架）。
   */
  let justOpened = false
  /** 吸管待办：按下吸管后置位，画布取到颜色时由 `takePendingPick()` 消费 */
  let pendingPick = false

  const chip = el('span', { class: 'chip' })
  const hexLabel = el('span', { class: 'color-pick-hex' })
  const button = el('button', {
    class: 'btn tiny color-pick',
    type: 'button',
    // id 给 `<label for>` 用：用户点「合成底色」那四个字而没点色块是很常见的，
    // 而 `<label for>` 对 `<button>` 同样有效（e2e 有一条专门守这个）
    id: 'matte-swatch-btn',
    'data-testid': 'matte-swatch',
    onclick: () => {
      open = !open
      justOpened = open
      if (!open) pendingPick = false
      deps.rerender()
    },
  }, [chip, hexLabel])
  const element = el('div', { class: 'field' }, [
    el('label', { for: 'matte-swatch-btn' }, ['合成底色']),
    button,
    el('span', { class: 'hint' }, ['不透明模式把原图透明区合成到这个颜色；单色键控模式下它就是要被扣掉的键控色']),
  ])

  /** 构建（或更新）取色盘实例；`open === false` 时释放实例——收起后不该留着全局监听 */
  function renderPicker(): void {
    if (!open) {
      picker?.dispose()
      picker = null
      return
    }
    try {
      if (!picker) {
        picker = createColorPicker(
          host,
          {
            target: 'matte',
            value: deps.getValue(),
            groups: deps.groups(),
            // 合成底色是 6 位 hex、没有 alpha：透明度行（画笔的"透明色"开关）放在这里会误导。
            // 见 colorpicker.ts 的 showAlpha。
            showAlpha: false,
          },
          callbacks(),
        )
      }
      picker.update({ target: 'matte', value: deps.getValue(), groups: deps.groups(), showAlpha: false })
    } catch (err) {
      // 构建失败不能静默（否则又是"点了没反应"）：把原因留在 DOM 上并把错误显示出来
      const target = document.getElementById('canvas-host')
      if (target) target.dataset.pickerError = (err as Error)?.message ?? String(err)
      console.error('[取色器] 合成底色取色器构建失败：', err)
      clear(host)
      host.append(el('div', { class: 'hint' }, [`取色器不可用：${(err as Error)?.message ?? err}`]))
    }
  }

  function callbacks(): ColorPickerCallbacks {
    return {
      onPreview: (hex) => deps.preview(hex),
      onCommit: (hex) => deps.commit(hex),
      onTransparent: () => deps.setTransparent(),
      onOpaque: () => deps.setOpaque(),
      isTransparent: () => deps.isTransparent(),
      onPickFromCanvas: () => {
        pendingPick = true
        deps.armPick()
      },
      onClose: () => {
        open = false
        pendingPick = false
        deps.rerender()
      },
    }
  }

  return {
    element,
    render: () => {
      const value = deps.getValue()
      button.className = `btn tiny color-pick${open ? ' active' : ''}`
      button.setAttribute('aria-expanded', open ? 'true' : 'false')
      button.title = `合成底色 ${value}——点击${open ? '收起' : '展开'}取色盘（Blender 式色轮）`
      chip.setAttribute('style', `background: ${value}`)
      hexLabel.textContent = value.toUpperCase()
      if (open) {
        // 宿主必须跨渲染存活：拖动中若把它摘出文档，指针捕获会丢、手感直接断掉。
        if (host.parentNode !== element) element.append(host)
        renderPicker()
        if (justOpened) {
          justOpened = false
          // 'nearest'：已经看得见就不动，避免每次重渲染都抢用户的滚动
          host.scrollIntoView({ block: 'nearest' })
        }
      } else {
        // 收起：`dispose()` 只摘全局监听，不会清 DOM，所以这里要显式摘掉并清空
        host.remove()
        clear(host)
        renderPicker()
      }
    },
    takePendingPick: () => {
      if (!pendingPick) return false
      pendingPick = false
      return true
    },
    clearPendingPick: () => {
      const had = pendingPick
      pendingPick = false
      return had
    },
    collapseForAlpha: () => {
      if (!open) return
      open = false
      pendingPick = false
      host.remove()
      clear(host)
      renderPicker()
    },
  }
}
