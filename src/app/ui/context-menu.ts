/**
 * 通用右键菜单：在指定屏幕坐标弹一个小菜单，选完/点外部/Esc 关闭。
 *
 * 抽成独立模块的理由：它是**位置相关**的浮层（跟着鼠标走），与页内任何面板的布局都无关，
 * 所以只能挂 `document.body` 并绝对定位——这部分逻辑与"菜单里有什么"完全解耦，
 * 将来别处要右键菜单可以直接复用。
 *
 * 为什么不复用顶栏那个 `.dropdown`：那个是**锚定在按钮上**的（`position:absolute` 挂在
 * `.menu-anchor` 里，靠 CSS 定位），而右键菜单要落在任意指针坐标上。两者的定位来源不同，
 * 硬套会让顶栏那套（以及它的 `e.stopPropagation` 关菜单逻辑）变复杂。
 * 视觉语言（配色、分组标题、条目排版）则沿用同一套 CSS 类，保证看起来是一个软件。
 */
import { el } from '../store.ts'

export interface ContextMenuItem {
  label: string
  /** 第二行小字说明（可选） */
  hint?: string
  /** 置灰不可选（例如"当前色板为空"时的操作） */
  disabled?: boolean
  /** `data-testid`，供 e2e 稳定定位 */
  testId?: string
  onSelect: () => void
}

export interface ContextMenuApi {
  /** 在 (x, y) 弹出；已开着会先关掉旧的 */
  open: (x: number, y: number, items: ContextMenuItem[]) => void
  close: () => void
  isOpen: () => boolean
}

/**
 * 创建菜单。**全局只有一个实例**——同一时刻不该有两个右键菜单。
 * 返回的 api 是长期存活的，`open` 每次重建内容与位置。
 */
export function createContextMenu(): ContextMenuApi {
  let node: HTMLElement | null = null
  /** 当前这一轮菜单的关闭函数（作用域内的监听器要靠它配对摘掉） */
  let detach: (() => void) | null = null

  function close(): void {
    if (!node) return
    node.remove()
    node = null
    detach?.()
    detach = null
  }

  function open(x: number, y: number, items: ContextMenuItem[]): void {
    close()
    // 空菜单不弹：没有任何可选项时弹一个空框比不弹更让人困惑
    if (items.length === 0) return

    const menu = el('div', { class: 'ctx-menu', role: 'menu', 'data-testid': 'ctx-menu' })
    for (const item of items) {
      const btn = el('button', {
        class: 'dropdown-item ctx-item',
        type: 'button',
        role: 'menuitem',
        disabled: item.disabled ? true : false,
        onclick: () => {
          close()
          item.onSelect()
        },
      }, [
        el('span', { class: 'di-label' }, [item.label]),
        item.hint ? el('span', { class: 'di-hint' }, [item.hint]) : null,
      ])
      if (item.testId) btn.dataset.testid = item.testId
      menu.append(btn)
    }

    document.body.append(menu)
    node = menu
    // 先量尺寸再定位：菜单若贴着视口右/下边缘，翻到反方向，别让用户看不到条目
    const r = menu.getBoundingClientRect()
    const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4))
    const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4))
    menu.style.left = `${Math.round(left)}px`
    menu.style.top = `${Math.round(top)}px`

    /*
     * 关闭路径。用**捕获阶段**监听：菜单外的 mousedown 若在冒泡路径上被
     * `stopPropagation()`（画布与面板里都有这类处理器），冒泡那条就收不到，
     * 菜单会赖在屏幕上关不掉——那正是"点哪都没反应"一类问题的温床。
     *
     * `contextmenu` 也要监听：用户在别处**再次右键**时应当先把这一个关掉，
     * 否则新旧两个菜单会同时挂着（下一次 open 才会 close，中间那一帧是两个）。
     */
    const onDown = (e: Event): void => {
      if (node && !node.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    const onOther = (): void => close()
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('contextmenu', onOther, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onOther)
    window.addEventListener('resize', onOther)
    detach = () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('contextmenu', onOther, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onOther)
      window.removeEventListener('resize', onOther)
    }
  }

  return { open, close, isOpen: () => node !== null }
}
