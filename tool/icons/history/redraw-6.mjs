// 重画 6 个图标：画笔、填充、撤销、重做、重新转换、快捷键。
//
// 逐个的问题（来自 4× 真机截图确认，不是猜）：
//   画笔   笔杆与笔头连成一体、像把刀 → 要做出"箍"的分界（杆细、头宽）
//   填充   提梁太粗与桶身粘连、没有"滴" → 提梁变细并与桶身留空档；补上那一滴
//   撤销   箭头指向**右下**，而撤销应指向**左**（方向反了）
//   重做   箭头指向左下，重做应指向**右**
//   重新转换 成了实心半圆、**没有箭头** → 要画成"环 + 箭头"
//   快捷键 问号糊成实心块 → 弧要留出内侧空白，点要小
//
// 为什么用 SVG：这 6 个都含弧（笔杆斜线、提梁拱、回转箭头、圆环、问号弧），
// 而实测"含弧的形状用 SVG 一次就准、用像素格反复画不准"。
import { readFileSync, writeFileSync } from 'node:fs'

const p = new URL('./shapes-svg.mjs', import.meta.url)
let s = readFileSync(p, 'utf8')
const CRLF = String.fromCharCode(13, 10)
const LF = String.fromCharCode(10)
const had = s.includes(CRLF)
if (had) s = s.split(CRLF).join(LF)

function replaceExport(name, body, endMarker) {
  const start = s.indexOf(`export const ${name} =`)
  const end = s.indexOf(endMarker, start)
  if (start < 0 || end < 0) throw new Error(`定位失败：${name}`)
  s = s.slice(0, start) + body + s.slice(end)
}

/* 画笔：**细笔杆 + 宽箍 + 尖笔头**，三段分明。
   姿态照惯例：笔头在左下、笔杆伸向右上，整体斜置 45°。
   关键：箍要比杆宽出一圈，否则整支连成一根斜条（上一版就是这样，4× 看像把刀）。 */
replaceExport(
  'pencil',
  `export const pencil = S(
  // 笔杆：细线（3.5 宽），只占右上一段
  \`<path d="M27 5 L19 13" stroke-width="3.5"/>\` +
    // 箍：明显比笔杆宽（9 宽），把杆与头分开——这是"三段分明"的关键
    \`<path d="M15.5 16.5 L19 13" stroke-width="9"/>\` +
    // 笔头：实心楔形，尖端朝左下
    \`<path d="M14 18 L4.5 27.5 L4.5 24 L11 17.5 Z" fill="#000000" stroke-width="2.5"/>\`,
)

`,
  '/**\n * 填充桶',
)

/* 填充桶：**细提梁（拱）+ 桶口稍宽 + 上宽下窄桶身 + 右下分离的一滴**。
   上一版提梁太粗、与桶身粘连，且漏了那一滴（滴是"填充"最关键的辨识件）。 */
replaceExport(
  'bucket',
  `export const bucket = SM(
  // 提梁：细拱（2.6 宽），两端落到桶口上方、与桶身**留空档**
  \`<path d="M11.5 11 A5 5 0 0 1 21.5 11" fill="none" stroke="#000000" stroke-width="2.6"/>\` +
    // 桶口：比桶身宽一点，形成"桶沿"
    \`<path d="M7 15.5 L26 15.5 L21.5 28 L11.5 28 Z"/>\` +
    // 右下：分离的一滴（小圆 + 上方细颈，读作"滴落"）
    \`<circle cx="27" cy="25" r="2.6"/>\` +
    \`<path d="M27 20.5 L27 22" stroke="#000000" stroke-width="2.2"/>\`,
)

`,
  '/**\n * 撤销',
)

/* 撤销：**向左回转**的箭头。
   上一版箭头朝右下（方向反了，看着像"前进"）。
   正确姿态：弧从右下升起、绕过顶部、向左回落，箭头朝**左**。 */
replaceExport(
  'undo',
  `export const undo = SM(
  // 弧：从右下（26,22）绕过顶部到左侧（10,8.5）
  \`<path d="M26.5 21 A11.5 11.5 0 0 0 10 8.5" fill="none" stroke="#000000" stroke-width="3.6" stroke-linecap="round"/>\` +
    // 箭头：左端**向左**的实心三角（贴住弧的末端）
    \`<path d="M3 8.5 L11 4.5 L11 12.5 Z"/>\`,
)

`,
  '/** 重做',
)

/* 重做：撤销的水平镜像（用 transform 保证严格对称，不手抄坐标） */
replaceExport(
  'redo',
  `export const redo =
  \`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">\` +
  \`<rect width="32" height="32" fill="#ffffff"/>\` +
  /* 撤销的水平镜像：用 transform 保证与撤销严格对称（手抄坐标容易差一格） */
  \`<g transform="translate(32,0) scale(-1,1)">\` +
  \`<path d="M26.5 21 A11.5 11.5 0 0 0 10 8.5" fill="none" stroke="#000000" stroke-width="3.6" stroke-linecap="round"/>\` +
  \`<path d="M3 8.5 L11 4.5 L11 12.5 Z" fill="#000000"/>\` +
  \`</g></svg>\`

`,
  '/**\n * 重新转换',
)

/* 重新转换：**闭合环（右上留小缺口）+ 缺口处的箭头**。
   上一版成了实心半圆（环太粗、缺口太大），读不出"循环"。 */
replaceExport(
  'regenerate',
  `export const regenerate = SM(
  // 环：细一圈（3.2 宽），只在右上留约 50° 的缺口
  \`<path d="M24.5 7.5 A11 11 0 1 0 28.5 16" fill="none" stroke="#000000" stroke-width="3.2" stroke-linecap="round"/>\` +
    // 箭头：缺口处，指向顺时针（右下方向）
    \`<path d="M24.5 3.5 L24.5 11.5 L30.5 7.5 Z"/>\`,
)

`,
  '/**\n * 调色盘',
)

/* 快捷键（问号）：**开口的弧 + 下方竖线 + 小方点**。
   上一版弧太粗、内侧没留空白，4× 看是个实心块。
   关键：弧宽要够（≥18 格跨度）让内侧留出空白；点要小且方。 */
replaceExport(
  'help',
  `export const help = S(
  // 上半：开口向下的弧（左起 → 绕顶 → 右侧下落），细一点让内侧留白
  \`<path d="M8.5 11.5 A6.8 6.8 0 1 1 13.5 21 L13.5 22.5" stroke-width="3"/>\` +
    // 点：小的方形（用略粗的短线画，但短到读作"点"而不是"竖杠"）
    \`<path d="M13.5 26.5 L13.5 27.5" stroke-width="4.5"/>\`,
)

`,
  '/**\n * 后处理滑杆',
)

writeFileSync(p, had ? s.split(LF).join(CRLF) : s)
console.log('6 个图标已重画')
