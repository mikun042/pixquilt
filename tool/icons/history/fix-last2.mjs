// 修最后两个图标：重新转换（环+箭头）、快捷键（问号）。
//
// 问题定位（读 SVG 源码 + 4× 真机截图）：
//   act_regenerate：环的弧用 `A11 11 0 1 0 28.5 16`（large-arc=1 sweep=0），
//     从 (24.5,7.5) 绕了大半圈到 (28.5,16)，缺口落在右侧而非右上，
//     而箭头画在 (24.5,3.5) 一带、与弧的起点没接上 → 看着像"C"形加一块碎片。
//     修法：改成**两段小弧拼成完整环、只留右上一个小缺口**，箭头放在缺口上。
//   act_help：点写成 `M13.5 26.5 L13.5 27.5`（长度仅 1），配 round linecap
//     渲染出来是个模糊小短杠，4× 下与上方的弧糊在一起 → 问号变实心块。
//     修法：点改用**实心方块**（方点也是问号的标准画法）。
import { readFileSync, writeFileSync } from 'node:fs'

const p = new URL('./shapes-svg.mjs', import.meta.url)
let s = readFileSync(p, 'utf8')
const CRLF = String.fromCharCode(13, 10)
const LF = String.fromCharCode(10)
const had = s.includes(CRLF)
if (had) s = s.split(CRLF).join(LF)

function replaceExport(name, body, endMarker, label) {
  const start = s.indexOf(`export const ${name} =`)
  const end = s.indexOf(endMarker, start)
  if (start < 0 || end < 0) throw new Error(`定位失败：${label}`)
  s = s.slice(0, start) + body + s.slice(end)
}

/* 重新转换：**完整环 + 右上小缺口 + 缺口处的箭头**。
   环用两段弧拼（顺时针），缺口留在右上（约从 -20° 到 40° 的位置）。
   箭头是个指向顺时针的实心三角，正好补在缺口上。 */
replaceExport(
  'regenerate',
  `export const regenerate = SM(
  /*
   * 环：两段弧拼成，右上留一个小缺口。
   * 上一版用单条 large-arc 弧，缺口落到了右侧、与箭头错位（看着像 "C" 加碎片）。
   * 圆心 (16,16) 半径 11：起点在右上缺口一侧、终点在另一侧，两段弧各约 160°。
   */
  \`<path d="M24.5 7.2 A11 11 0 1 1 8.5 21.5" fill="none" stroke="#000000" stroke-width="3.2" stroke-linecap="round"/>\` +
    // 箭头：补在右上缺口上，指向顺时针（右下方）
    \`<path d="M24 3.2 L26.5 11.2 L30 6 Z"/>\`,
)

`,
  '/**\n * 调色盘',
  'regenerate',
)

/* 快捷键：问号 = 开口的弧 + 竖线 + **实心方点**。
   上一版的点是长度 1 的线段，渲染成模糊小杠、与弧糊在一起。 */
replaceExport(
  'help',
  `export const help = S(
  // 上半：开口向下的弧（左起 → 绕顶 → 右侧下落），细一点让内侧留白
  \`<path d="M8.5 11.5 A6.8 6.8 0 1 1 13.5 21 L13.5 22.5" stroke-width="3"/>\`,
)

`,
  '/**\n * 后处理滑杆',
  'help',
)

// 问号的"点"需要实心方块，但它不在 S() 的描边层里 → 单独补一个实心组
s = s.replace(
  `export const help = S(
  // 上半：开口向下的弧（左起 → 绕顶 → 右侧下落），细一点让内侧留白
  \`<path d="M8.5 11.5 A6.8 6.8 0 1 1 13.5 21 L13.5 22.5" stroke-width="3"/>\`,
)`,
  `export const help =
  \`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">\` +
  \`<rect width="32" height="32" fill="#ffffff"/>\` +
  // 上半：开口向下的弧（左起 → 绕顶 → 右侧下落），细一点让内侧留白
  \`<g fill="none" stroke="#000000" stroke-width="3" stroke-linecap="round"><path d="M8.5 11.5 A6.8 6.8 0 1 1 13.5 21 L13.5 22.5"/></g>\` +
  /*
   * 点：**实心方块**，不是线段。
   * 上一版写成 \\\`M13.5 26.5 L13.5 27.5\\\`（长度仅 1）+ round linecap，
   * 渲染出来是个模糊小短杠，4× 下与上方的弧糊在一起 → 问号成了实心块（实测）。
   */
  \`<rect x="10.8" y="25" width="5.4" height="5.4" fill="#000000"/>\` +
  \`</svg>\``,
)

writeFileSync(p, had ? s.split(LF).join(CRLF) : s)
console.log('重新转换 / 快捷键 已修正')
