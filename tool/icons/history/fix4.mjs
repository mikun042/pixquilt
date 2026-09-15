// 按掩码诊断出的**具体原因**修 4 个图标（不再盲调）。
//
// 诊断结论（来自 maskToAscii）：
//   · 画笔：整支成了一个宽 11 格的实心粗块，没有"笔头/笔杆"分界
//     → 因为 6 宽的那条线段与其它部件全叠在一起。需要**拉开部件间距、笔杆收细**。
//   · 填充桶：桶身画成了**空心轮廓**（掩码里是 `####......####`），而手绘版是实心梯形
//     → 这就是观感不一致的主因：手绘是"块面"，SVG 版是"描边"。
//       要统一，就得把桶身填成实心（fill），而不是 stroke。
//   · 撤销/重做：弧太单薄且箭头与主体分离
//     → 加粗弧、让箭头与弧相接。
//
// 这条修正体现一个通用原则：**两套混用时，"填充型图标"必须用实心块面，
// 不能用描边轮廓**——否则一眼能看出不是一套（描边是线、块面是面）。
import { readFileSync, writeFileSync } from 'node:fs'

const p = new URL('./shapes-svg.mjs', import.meta.url)
let s = readFileSync(p, 'utf8')
const CRLF = String.fromCharCode(13, 10)
const LF = String.fromCharCode(10)
const had = s.includes(CRLF)
if (had) s = s.split(CRLF).join(LF)

function replaceBlock(startMarker, endMarker, next, label) {
  const a = s.indexOf(startMarker)
  const b = s.indexOf(endMarker)
  if (a < 0 || b < 0) throw new Error(`定位失败：${label}`)
  s = s.slice(0, a) + next + s.slice(b)
}

/* 画笔：笔头是**实心楔形**，笔杆是**细线**，两者要靠"箍"分开。
   上一版整支糊成一个宽块——因为 6 宽的线段与其它部件叠在一起。 */
replaceBlock(
  'export const pencil = S(',
  '/**\n * 填充桶',
  `export const pencil = S(
  // 笔杆：细线（5 宽），只占右上一小段
  \`<path d="M28 4 L19 13" stroke-width="5"/>\` +
    // 箍：明显比笔杆宽的一道（8 宽），把笔杆与笔头分开
    \`<path d="M15 17 L20 12" stroke-width="8"/>\` +
    // 笔头：实心楔形（尖端左下），用 fill 画成块面而不是描边
    \`<path d="M14 18 L17 21 L8 28 L4 28 L4 24 Z"/>\`,
)

`,
  '画笔',
)

/* 填充桶：桶身**实心**（与手绘版的块面一致），提梁用描边、与桶身留空档。
   上一版桶身是空心轮廓，一眼与手绘的实心块面不同套。 */
replaceBlock(
  'export const bucket = S(',
  '/**\n * 撤销',
  `export const bucket = SF(
  // 提梁：拱形（描边式，靠两条粗弧示意），与桶身留空档
  \`<path d="M12 11 A6 6 0 0 1 22 11" fill="none" stroke="#000000" stroke-width="3.4"/>\` +
    // 桶口 + 桶身：**实心梯形**（上宽下窄），与手绘版同为块面
    \`<path d="M6 15 L27 15 L23 29 L11 29 Z"/>\` +
    // 右下：分离的一滴（实心圆）
    \`<circle cx="28" cy="26" r="3"/>\`,
)

`,
  '填充桶',
)

/* 撤销：弧加粗、箭头与弧**相接**（上一版箭头与主体分离成两块）。
   结构：一段从右侧绕到左下的粗弧 + 左端向下的实心箭头。 */
replaceBlock(
  'export const undo = SF(',
  '/** 重做',
  `export const undo = SF(
  // 弧：从右下起，绕过顶部，落到左侧（粗描边）
  \`<path d="M27 22 A12 12 0 0 0 11 9" fill="none" stroke="#000000" stroke-width="4.5" stroke-linecap="round"/>\` +
    // 箭头：左端向下的实心三角，**贴着弧的末端**（否则会散成两块）
    \`<path d="M7 9 L15 9 L11 18 Z"/>\`,
)

`,
  '撤销',
)

writeFileSync(p, had ? s.split(LF).join(CRLF) : s)
console.log('已按掩码诊断修正 3 处（画笔 / 桶 / 撤销）')
