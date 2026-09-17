/**
 * 快捷键速查表（`?` 与顶栏「快捷键」按钮共用）。
 *
 * 从 `index.ts` 搬出来：它是**纯静态内容 + 一个模态浮层**，
 * 对 app/store/canvas 零依赖（搬之前核实过），是那片 1400 行文件里
 * 内聚度最高、耦合最低的一块。
 *
 * 表本身是快捷键的**唯一出处**（界面里没有第二份），所以改快捷键只改这里。
 * 项目约定：tooltip 里承诺的必须有实现、界面承诺的必须有断言——
 * `e2e` 有一条守着"按 ? 能打开速查表，且表里列了这一条"。
 */
import { el } from '../store.ts'

export function showHelp(): void {
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
