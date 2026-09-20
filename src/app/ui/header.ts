/**
 * 顶栏：导入 / 导出菜单 / 撤销重做 / 新建 / 快捷键，以及**侧栏开合开关**。
 *
 * 顶栏结构与侧栏开关都是"只构建一次、之后只更新可用状态"的：导出菜单是展开/收起状态机，
 * 若每次 renderAll 重建 DOM，一次重绘就会把刚点开的菜单冲掉（踩过）。
 * 所以这里把"结构"（`build()`，boot 时调一次）与"状态"（`updateState()`，renderAll 里调）分开。
 *
 * 侧栏开关的两个布尔量也放在这里：它们必须跨 renderAll 存活，且**两侧各自独立**——
 * 早先用单个 'none'|'tools'|'panel' 三值状态，四个组合里有一个不可达（收起工具列再收参数列时，
 * 赋值顺手把 no-rail 摘掉，第一个又弹回来）。见 docs/架构.md §8.9。
 */
import { EXPORT_SCALES } from '../../core/limits.ts'
import { clear, el } from '../store.ts'
import { iconEl } from './icons.ts'
import type { ExportActions } from '../export-actions.ts'

export interface HeaderDeps {
  canUndo: () => boolean
  canRedo: () => boolean
  hasSource: () => boolean
  hasArt: () => boolean
  /** 「重新转换」前要确认是否覆盖手动编辑 */
  hasEdits: () => boolean
  /** 当前「透明处理」模式（导出菜单的提示语据此提一句"透明底"） */
  transparentMode: () => string
  undo: () => void
  redo: () => void
  regenerate: () => void
  importFile: (file: File) => void
  makeBlank: () => void
  /**
   * 「新建」的完整语义：没有画布就直接建空白画布，已有画布则确认后清空重来。
   * 实现留在 index（它要动 app 的四个字段与撤销栈），这里只表达意图。
   */
  newBlankOrClear: () => void
  copyPNG: () => void
  showHelp: () => void
  rerender: () => void
  /** 侧栏开合会改变画布可视区域：请调用方重绘一次，别让画布停在屏幕外 */
  onLayoutChange: () => void
  exports: ExportActions
}

export interface HeaderApi {
  /** 建结构（boot 时调一次） */
  build: () => void
  /** 只更新按钮可用状态（renderAll 里调；不重建 DOM，因此不会打断展开中的菜单） */
  updateState: () => void
  /** 打开常驻的隐藏文件选择器（空状态的「导入图片…」按钮复用它） */
  openFilePicker: () => void
}


/**
 * 顶栏动作图标：优先用像素 SVG，外面仍套 `.act-icon`（CSS 靠这个类控制尺寸与对齐）。
 * `iconEl` 返回 null 时回退成字符——**不要静默产出空按钮**（见 icons.ts 的约定）。
 *
 * 现状（2026-09-15）：撤销 / 重做 / 重新转换 / 新建 / 快捷键**都已换成图标**，
 * 字符只是 `iconEl` 返回 null 时的兜底。改形状请改 `tool/icons/` 的形状定义
 * （这里是生成物的消费方），详见 `tool/icons/README.md`。
 */
function iconSpan(name: Parameters<typeof iconEl>[0], fallback = ''): HTMLElement {
  const svg = iconEl(name)
  const span = el('span', { class: 'act-icon' })
  if (svg) span.append(svg)
  else span.append(document.createTextNode(fallback))
  return span
}

export function createHeader(deps: HeaderDeps): HeaderApi {
  let fileInput: HTMLInputElement | null = null
  let undoBtn: HTMLButtonElement | null = null
  let redoBtn: HTMLButtonElement | null = null
  let regenerateBtn: HTMLButtonElement | null = null

  /* ------------------------------------------------------------------ 顶栏装配 */

  /**
   * 顶栏只构建一次，之后只更新按钮的可用状态。
   *
   * 为什么不在每次 render 里重建：导出菜单是展开/收起状态机，重建会把菜单状态一起冲掉
   * （点开菜单 → 触发一次渲染 → 菜单消失）。这里把"结构"与"状态"分开：
   * 结构在 boot 时建好，render 只调 updateState()。
   */
  function build(): void {
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
        if (f) void deps.importFile(f)
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
      { class: 'btn act', title: '撤销（Ctrl+Z）', 'aria-label': '撤销', onclick: () => deps.undo() },
      [iconSpan('undo', '↶'), el('span', { class: 'act-label' }, ['撤销'])],
    )
    redoBtn = el(
      'button',
      { class: 'btn act', title: '重做（Ctrl+Y / Ctrl+Shift+Z）', 'aria-label': '重做', onclick: () => deps.redo() },
      [iconSpan('redo', '↷'), el('span', { class: 'act-label' }, ['重做'])],
    )
    regenerateBtn = el(
      'button',
      {
        class: 'btn act',
        title: '用当前参数重新转换（有手动编辑时会先确认）',
        'aria-label': '重新转换',
        onclick: () => {
          if (deps.hasEdits() && !confirm('重新转换会覆盖当前的手动编辑，继续？')) return
          deps.regenerate()
        },
      },
      [iconSpan('regenerate', '⟳'), el('span', { class: 'act-label' }, ['重新转换'])],
    )
    const newBtn = el(
      'button',
      {
        class: 'btn act',
        title: '新建：还没有画布时直接建一张空白画布；已有画布时清空重来',
        'aria-label': '新建',
        onclick: () => {
          /*
           * 「新建」在没有画布时曾经是**禁用**的（`updateState` 里 `!art && !src`），
           * 于是第一次打开工作台的人卡在空状态：唯一的"新建空白画布"入口藏在
           * 「导出 ▾」菜单里，而"导出"这个词不会让人想到"新建"。现在改成：
           *  - 已有画布 → 确认后清空（原行为，仍是"清空与素材，重新开始"）
           *  - 还没有画布 → 直接建空白画布，按钮不再是死路
           */
          deps.newBlankOrClear()
        },
      },
      [iconSpan('new', '✚'), el('span', { class: 'act-label' }, ['新建'])],
    )
    const helpBtn = document.getElementById('btn-help') as HTMLButtonElement | null
    if (helpBtn) {
      // 「? 快捷键」放在顶栏最右侧：与其它按钮拉开距离，避免误触
      helpBtn.append(iconSpan('help', '?'), el('span', { class: 'act-label' }, ['快捷键']))
      helpBtn.title = '快捷键速查（按 ? 也能打开）'
      helpBtn.setAttribute('aria-label', '快捷键速查')
      helpBtn.dataset.testid = 'help'
      helpBtn.addEventListener('click', () => deps.showHelp())
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
        deps.onLayoutChange()
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
      renderMenu(menu)
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

    updateState()
  }

  /** 导出菜单内容：每次打开时重建，因此"透明底"等状态永远是最新的 */
  function renderMenu(menu: HTMLElement): void {
    clear(menu)
    const hasArt = deps.hasArt()
    const keyed = deps.transparentMode() === 'key'

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
        closeMenu()
        void deps.exports.exportPNG(1)
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
            closeMenu()
            void deps.exports.exportPNG(s)
          },
        }, [`${s}x`]),
      )
    }
    menu.append(scaleRow)
    menu.append(
      item('复制 PNG（1x）', '直接粘进聊天 / 文档', () => {
        closeMenu()
        void deps.copyPNG()
      }, { disabled: !hasArt }),
    )

    menu.append(el('div', { class: 'dropdown-group' }, ['拼豆']))
    menu.append(
      item('图纸 SVG + 缺口清单 CSV', '格内标号色、分板、图例；清单含珠数与重量', () => {
        closeMenu()
        deps.exports.exportBeadFiles()
      }, { disabled: !hasArt, testid: 'export-bead' }),
      item('可打印图纸 PDF（A4 分页）', '每块板一页，含号色与图例；打印/送人比 SVG 稳', () => {
        closeMenu()
        void deps.exports.exportBeadPdf()
      }, { disabled: !hasArt, testid: 'export-bead-pdf' }),
    )

    menu.append(el('div', { class: 'dropdown-group' }, ['数据']))
    menu.append(
      item('像素数据 JSON', '每格颜色 + 每色用量表（原料清单）', () => {
        closeMenu()
        deps.exports.exportPixelJSON()
      }, { disabled: !hasArt }),
      item('色板 .hex', '当前画布用到的颜色，可导入 Lospec 等工具', () => {
        closeMenu()
        deps.exports.exportPaletteHex()
      }, { disabled: !hasArt }),
      item('项目 JSON', '参数 + 色板 + 像素，不含原图，可分享继续编辑', () => {
        closeMenu()
        deps.exports.exportProject()
      }, { disabled: !hasArt }),
    )

    menu.append(el('div', { class: 'dropdown-group' }, ['画布']))
    menu.append(
      item('新建空白画布', '不导入图片，直接开画（拼豆/资产原型常用）', () => {
        closeMenu()
        deps.makeBlank()
      }, { testid: 'blank-canvas' }),
    )
  }

  /** 关闭导出菜单（供菜单项回调复用，避免互相引用） */
  function closeMenu(): void {
    const menu = document.getElementById('export-menu')
    const btn = document.getElementById('btn-export')
    if (menu) menu.hidden = true
    btn?.setAttribute('aria-expanded', 'false')
  }

  /** 只更新顶栏按钮的可用状态（不重建 DOM，因此不会打断菜单） */
  function updateState(): void {
    const art = deps.hasArt()
    if (undoBtn) undoBtn.disabled = !deps.canUndo()
    if (redoBtn) redoBtn.disabled = !deps.canRedo()
    if (regenerateBtn) regenerateBtn.disabled = !deps.hasSource()
    // 「新建」不再因"没有画布"而禁用——那是第一次使用时的死路（点不动、又找不到别的入口）。
    // 它的语义随之变成"没有画布就直接建一张，有画布才确认清空"，见顶栏按钮的 onclick。
    const exportBtn = document.getElementById('btn-export') as HTMLButtonElement | null
    // 导出按钮**不因"没有画布"而禁用**：否则用户不知道去哪导出，点开菜单会看到明确提示
    if (exportBtn) exportBtn.classList.toggle('is-empty', !art)
  }

  return { build, updateState, openFilePicker: () => fileInput?.click() }
}
