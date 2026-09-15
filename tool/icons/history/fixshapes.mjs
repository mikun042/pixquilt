// 修正 shapes-svg.mjs 里的两个形状：桶（提梁与桶身要留空档）、问号（弧要覆盖左右两侧）
import { readFileSync, writeFileSync } from 'node:fs'
const p = new URL('./shapes-svg.mjs', import.meta.url)
let s = readFileSync(p, 'utf8')
const CRLF = String.fromCharCode(13, 10)
const LF = String.fromCharCode(10)
const had = s.includes(CRLF)
if (had) s = s.split(CRLF).join(LF)

// ① 桶：提梁与桶身之间必须留空档，否则连成封闭的"灯笼"（实测）。
const bStart = s.indexOf('export const bucket = S(')
const bEnd = s.indexOf('/**\n * 撤销')
if (bStart < 0 || bEnd < 0) throw new Error('桶的定位失败')
const newBucket = `export const bucket = S(
  // 提梁：小拱，两端只到桶口上方，与桶身之间**留空档**（否则连成封闭的灯笼——实测踩过）
  \`<path d="M12 10 A5 5 0 0 1 22 10"/>\` +
    // 桶口：比提梁宽，两端超出形成"桶沿"
    \`<path d="M7 15 L27 15"/>\` +
    // 桶身：左壁 / 底 / 右壁（上宽下窄的梯形），只与桶口相接
    \`<path d="M9 17 L13 28 L20 28 L24 17"/>\` +
    // 右下：分离的一滴
    \`<path d="M26 25 L26 26" stroke-width="4"/>\`,
)

`
s = s.slice(0, bStart) + newBucket + s.slice(bEnd)

// ② 问号：弧要完整覆盖左右两侧（上一版起点偏右，左半被削掉、宽度不足 12）。
const hStart = s.indexOf('export const help = S(')
const hEnd = s.indexOf('/**\n * 后处理滑杆')
if (hStart < 0 || hEnd < 0) throw new Error('问号的定位失败')
const newHelp = `export const help = S(
  // 上半：开口向下的弧（左侧起 → 绕顶部 → 右侧下落），要覆盖整个宽度
  \`<path d="M8 11 A7 7 0 1 1 14 21 L14 23"/>\` +
    // 点：粗短线段（round cap 会变圆点，这里用 6 宽画成近方形）
    \`<path d="M14 27 L14 27" stroke-width="6"/>\`,
)

`
s = s.slice(0, hStart) + newHelp + s.slice(hEnd)

writeFileSync(p, had ? s.split(LF).join(CRLF) : s)
console.log('桶与问号已修正')
