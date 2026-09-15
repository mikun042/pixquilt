// 修辞两个不能直接接入的 SVG 形状：
//  ① cat_palette 用 <ellipse> 画的 → 转成 <path>（否则接入 icons.ts 时取不到 path 数据）
//     用两段弧拼椭圆（与吸管胶头同一手法，见 icons.ts 的注释）
//  ② act_help 的点是 `M14 27 L14 27`（**零长度线段**）→ 靠 round linecap 画圆点，
//     某些渲染下会消失。改成有长度的短线段（方形点）。
import { readFileSync, writeFileSync } from 'node:fs'

const p = new URL('./shapes-svg.mjs', import.meta.url)
let s = readFileSync(p, 'utf8')
const CRLF = String.fromCharCode(13, 10)
const LF = String.fromCharCode(10)
const had = s.includes(CRLF)
if (had) s = s.split(CRLF).join(LF)

// 椭圆 → path（两段弧）。注意用 fill-rule=evenodd 让"孔"被挖空。
const paletteStart = s.indexOf('export const palette =')
const paletteEnd = s.indexOf('</svg>`', paletteStart) + '</svg>`'.length
if (paletteStart < 0 || paletteEnd < 8) throw new Error('palette 定位失败')

const nextPalette = `export const palette =
  \`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">\` +
  \`<rect width="32" height="32" fill="#ffffff"/>\` +
  /*
   * 盘身 + 三个颜料孔，全部用 <path>（而不是 <ellipse>）：
   * 接入 icons.ts 时只提取 path 的 d，用 ellipse 会取不到数据（实测 0 条 path）。
   * 椭圆用两段弧拼（与 icons.ts 里吸管胶头同一手法）；孔靠 fill-rule=evenodd 挖空。
   */
  \`<path fill="#000000" fill-rule="evenodd" d="\` +
  \`M15 4 A11 11 0 1 0 15 26 A11 11 0 1 0 15 4 Z\` +
  \`M14 4.6 A2.6 2.4 0 1 0 14 9.4 A2.6 2.4 0 1 0 14 4.6 Z\` +
  \`M7 9.6 A2.6 2.4 0 1 0 7 14.4 A2.6 2.4 0 1 0 7 9.6 Z\` +
  \`M10 18.6 A2.6 2.4 0 1 0 10 23.4 A2.6 2.4 0 1 0 10 18.6 Z\` +
  \`M22 16.8 A3.6 3.2 0 1 0 22 23.2 A3.6 3.2 0 1 0 22 16.8 Z\` +
  \`"/>\` +
  \`</svg>\``
s = s.slice(0, paletteStart) + nextPalette + s.slice(paletteEnd)

// 修零长度线段：`M14 27 L14 27` → 有长度的短竖线（仍然是 round cap，但不再退化）
s = s.split('`<path d="M14 27 L14 27" stroke-width="7"/>`').join('`<path d="M14 26 L14 29" stroke-width="6"/>`')

writeFileSync(p, had ? s.split(LF).join(CRLF) : s)
console.log('调色盘转 path、帮助的点改为有长度线段')
