// 把 8 个 SVG 形状写进 icons.ts，并让 iconEl 支持"多条 path + 描边"渲染。
//
// 决定依据（用户判断 + 实测）：图标只有 16px，像素格与矢量在屏幕上**看不出区别**，
// 而 SVG 的形状表达明显更好（回转箭头、环形箭头一次就准）。
// 所以这 8 个直接接入 SVG——与现有吸管同一条路，不经过"栅格化 → 二值化"的绕路。
import { readFileSync, writeFileSync } from 'node:fs'

const svgPaths = JSON.parse(readFileSync('output/UI素材32/tools/svg-paths.json', 'utf8'))
const p = 'src/app/ui/icons.ts'
let s = readFileSync(p, 'utf8')
const CRLF = String.fromCharCode(13, 10)
const LF = String.fromCharCode(10)
const had = s.includes(CRLF)
if (had) s = s.split(CRLF).join(LF)

// ① 在 PIXEL_PATHS 之前插入 SVG_PATHS
const anchor = 'const PIXEL_PATHS = {'
if (!s.includes(anchor)) throw new Error('锚点不匹配')

const lines = []
lines.push('/**')
lines.push(' * SVG 描边图标的 path 数据（32×32 viewBox 坐标，与像素图标同一坐标系）。')
lines.push(' *')
lines.push(' * 为什么这 8 个用 SVG 而不是像素格：它们的形状是"弧 + 箭头"结构（回转箭头、环形箭头、')
lines.push(' * 提梁、问号弧），用像素格堆很难画准——实测手绘磨了 4 轮，撤销被画成"门"、')
lines.push(' * 刷新环成了"C"。改用 SVG 的 stroke 画弧之后一次就对了。')
lines.push(' *')
lines.push(' * 而 16px 的显示尺寸下，像素格与矢量**看不出区别**（用户观察），所以：')
lines.push(' *   **形状好堆的手绘像素格，形状含弧的用 SVG** —— 按形状类型分工。')
lines.push(' *')
lines.push(' * 每项是 path 数组：`d` 是路径，`fill` 给实心部件（箭头三角、桶身），')
lines.push(' * `sw` 是 stroke-width 覆盖（默认走外层 1.7；粗弧需要单独指定）。')
lines.push(' * 一律 currentColor，一套适配正常/悬停/激活/禁用。')
lines.push(' */')
lines.push('const SVG_PATHS: Record<string, { d: string; fill?: string; sw?: string }[]> = {')
for (const [name, paths] of Object.entries(svgPaths)) {
  lines.push(`  ${name}: [`)
  for (const x of paths) {
    const parts = [`d: '${x.d}'`]
    if (x.fill) parts.push(`fill: '${x.fill}'`)
    if (x.sw) parts.push(`sw: '${x.sw}'`)
    lines.push(`    { ${parts.join(', ')} },`)
  }
  lines.push('  ],')
}
lines.push('}')
lines.push('')
lines.push('export type SvgIconName = keyof typeof SVG_PATHS')
lines.push('')
s = s.replace(anchor, lines.join('\n') + anchor)

// ② 更新 IconName：加入 SVG 图标名
s = s.replace(
  "export type IconName = 'eyedropper' | PixelIconName",
  "export type IconName = 'eyedropper' | PixelIconName | SvgIconName",
)

// ③ iconEl：在像素分支之前插入 SVG 分支（SVG 优先，因为同名时它是新方案）
const pixBranch = "  const d: string | undefined = PIXEL_PATHS[name]"
const svgBranch = `  // SVG 描边图标：多条 path，弧 + 箭头这类形状走这条
  const svgPaths = SVG_PATHS[name as SvgIconName]
  if (svgPaths) {
    for (const item of svgPaths) {
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', item.d)
      // 实心部件（箭头三角、桶身）填 currentColor；其余靠外层 stroke 描边
      if (item.fill) path.setAttribute('fill', item.fill === 'none' ? 'none' : 'currentColor')
      if (item.sw) path.setAttribute('stroke-width', item.sw)
      svg.append(path)
    }
    return svg
  }

` + pixBranch
if (!s.includes(pixBranch)) throw new Error('像素分支锚点不匹配')
s = s.replace(pixBranch, svgBranch, 1)

writeFileSync(p, had ? s.split(LF).join(CRLF) : s)
console.log(`已写入 ${Object.keys(svgPaths).length} 个 SVG 图标：${Object.keys(svgPaths).join(' ')}`)
