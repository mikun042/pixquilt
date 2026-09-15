// 把达标的 12 个像素图标的 path 数据写进 src/app/ui/icons.ts，并扩 iconEl 的联合类型。
//
// 只接**已达标**的 12 个（手绘像素格那套，边缘干净）；未达标的 8 个继续用字符图标。
// 用 Node 脚本而不是手改：path 数据很长（单个 1KB+），手抄必错。
import { readFileSync, writeFileSync } from 'node:fs'

const ready = JSON.parse(readFileSync('output/_work/ready-paths.json', 'utf8'))
const p = 'src/app/ui/icons.ts'
let s = readFileSync(p, 'utf8')
const CRLF = String.fromCharCode(13, 10)
const LF = String.fromCharCode(10)
const had = s.includes(CRLF)
if (had) s = s.split(CRLF).join(LF)

/* ① 在 iconEl 之前插入 PIXEL_PATHS 与类型 */
const anchor = `/**
 * 创建一个 SVG 图标元素。`
if (!s.includes(anchor)) throw new Error('锚点不匹配')

const names = ready.map((r) => r.id)
const shortName = (id) =>
  id
    .replace(/^tool_/, '')
    .replace(/^act_/, '')
    .replace(/^cat_/, '')
    .replace(/^caret_/, 'caret')
    .replace(/^panel_/, 'panel')
    .replace(/_([a-z])/g, (_, c) => c.toUpperCase())

const lines = []
lines.push('/**')
lines.push(' * 像素化图标的 path 数据（32×32 像素格 → 24×24 viewBox，经几何校验）。')
lines.push(' *')
lines.push(' * 来源：`output/UI素材32/`（本仓库的像素画工作台生成，逐个通过校验：viewBox、')
lines.push(' * 笔画落在画布内、包围盒 ≥12×12、**主体厚度 ≥1.4px @16px 显示**）。')
lines.push(' * 改形状请改那边的生成器后重跑，不要手改这些数字。')
lines.push(' *')
lines.push(' * 为什么用 32 格而不是 16 格：图标显示在 16px 的按钮里，viewBox 恒为 24，于是')
lines.push(' *   16 格 → 1 格 = 1.000px（任何 1 格线都是 1px，抗锯齿后发灰）')
lines.push(' *   32 格 → 1 格 = 0.500px（笔画画到 3 格 = 1.5px 就是实心）')
lines.push(' * 清晰度来自"最终笔画够厚"，不是画布大本身——所以校验里锁了主体厚度。')
lines.push(' *')
lines.push(' * 一律 `fill="currentColor"`：一套图标适配正常/悬停/激活/禁用全部状态。')
lines.push(' */')
lines.push('const PIXEL_PATHS = {')
for (const r of ready) {
  lines.push(`  ${shortName(r.id)}: '${r.d}',`)
}
lines.push('} as const')
lines.push('')
lines.push('export type PixelIconName = keyof typeof PIXEL_PATHS')
lines.push('')
lines.push('/** 全部可用图标名：吸管（手绘曲线）+ 像素图标（块面） */')
lines.push("export type IconName = 'eyedropper' | PixelIconName")
lines.push('')
s = s.replace(anchor, lines.join('\n') + anchor)

/* ② 改写 iconEl：吸管走原逻辑，像素图标走单条 fill path */
const oldFnStart = s.indexOf('export function iconEl(')
const oldFnEnd = s.indexOf('\n}', s.indexOf('return svg', oldFnStart)) + 2
if (oldFnStart < 0 || oldFnEnd < 2) throw new Error('iconEl 定位失败')

const newFn = `export function iconEl(name: IconName): SVGSVGElement | null {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.7')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', 'icon-svg')

  if (name === 'eyedropper') {
    for (const { d, filled } of eyedropperPaths()) {
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', d)
      // 胶头填实：与空心管身形成"橡胶头 + 玻璃管"的实空对比（见 DROPPER 注释）
      if (filled) path.setAttribute('fill', 'currentColor')
      svg.append(path)
    }
    return svg
  }

  const d: string | undefined = PIXEL_PATHS[name]
  if (!d) return null
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', d)
  // 像素图标是实心块面（不是描边线），所以填 currentColor；
  // fill-rule=evenodd 让路径里"孔"（如选区框内部）被正确挖空。
  path.setAttribute('fill', 'currentColor')
  path.setAttribute('fill-rule', 'evenodd')
  svg.append(path)
  return svg
}
`
s = s.slice(0, oldFnStart) + newFn + s.slice(oldFnEnd)

writeFileSync(p, had ? s.split(LF).join(CRLF) : s)
console.log(`已写入 ${ready.length} 个图标：${names.join(' ')}`)
