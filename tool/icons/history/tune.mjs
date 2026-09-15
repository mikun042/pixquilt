// 调齐观感：把 SVG 组向手绘组靠（实心格 190~520 区间）。
//
// 量化依据：主体的"最大内切厚度"两组已基本一致（手绘 2~6px / SVG 2~5px），
// 差异在**实心格总数**——SVG 组偏少，因为 stroke 缩放后偏细。所以加粗 stroke。
import { readFileSync, writeFileSync } from 'node:fs'

const p = new URL('./shapes-svg.mjs', import.meta.url)
let s = readFileSync(p, 'utf8')
const CRLF = String.fromCharCode(13, 10)
const LF = String.fromCharCode(10)
const had = s.includes(CRLF)
if (had) s = s.split(CRLF).join(LF)

// ① 默认 stroke-width：3 → 4（整体加粗一档，补齐"实心格偏少"）
s = s.replace('stroke-width="3" stroke-linecap="round"', 'stroke-width="4" stroke-linecap="round"')

// ② 画笔：加粗笔杆与笔头（实心格 164 → 目标 ≥200）
s = s.replace('`<path d="M27 5 L17 15"/>`', '`<path d="M27 5 L17 15" stroke-width="5"/>`')
s = s.replace('`<path d="M6 26 L13 19" stroke-width="4"/>`', '`<path d="M6 26 L13 19" stroke-width="6"/>`')
s = s.replace('`<path d="M14.5 17.5 L19.5 12.5" stroke-width="7"/>`', '`<path d="M14.5 17.5 L19.5 12.5" stroke-width="8"/>`')

// ③ 问号：加粗整条弧（实心格 137 → 目标 ≥200）
s = s.replace('`<path d="M8 11 A7 7 0 1 1 14 21 L14 23"/>`', '`<path d="M8 11 A7 7 0 1 1 14 21 L14 23" stroke-width="5"/>`')
s = s.replace('`<path d="M14 27 L14 27" stroke-width="6"/>`', '`<path d="M14 27 L14 27" stroke-width="7"/>`')

// ④ 刷新环：加粗环（实心格 213，偏细一档）
s = s.replace('`<path d="M24 6 A11 11 0 1 0 28 17"/>`', '`<path d="M24 6 A11 11 0 1 0 28 17" stroke-width="4.5"/>`')

// ⑤ 滑杆：轨道略加粗（实心格 306 尚可，但轨道比手绘的细）
s = s.replace('`<path d="M5 8 H27"/>`', '`<path d="M5 8 H27" stroke-width="4"/>`')
s = s.replace('`<path d="M5 16 H27"/>`', '`<path d="M5 16 H27" stroke-width="4"/>`')
s = s.replace('`<path d="M5 24 H27"/>`', '`<path d="M5 24 H27" stroke-width="4"/>`')

writeFileSync(p, had ? s.split(LF).join(CRLF) : s)
console.log('已按量化基线调齐 stroke')
