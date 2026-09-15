/**
 * svg-shapes.mjs —— 用 SVG 描述"难用像素格表达"的形状。
 *
 * 适用对象：回转箭头、环形箭头、油漆桶、画笔、滑杆、调色盘、问号。
 * 这些都有明确的**语义结构**（一段弧 + 一个箭头 / 一个梯形 + 一个提梁），
 * 用 SVG 的 stroke 直接画比"在网格上堆格子"可控得多——后者实测磨了 4 轮仍未收敛
 *（撤销被画成"门"、刷新环成了"C"）。
 *
 * 绘制约定：
 *   · viewBox 统一 0 0 32 32（**32 格设计网格**，与像素画布同尺度，方便对照）
 *   · **黑色描边**（栅格化时按亮度阈值二值化）、白底
 *   · 线帽用 round，避免端点被削掉
 *   · 坐标一律写成**绝对坐标**，不写 `<g transform>`：接入侧的 svg-data.mjs
 *     不做坐标变换，遇到 transform 会直接报错（重做图标曾因 transform 被静默丢掉、
 *     与撤销长得一模一样）。
 *
 * ⚠️ **尺度**：这里画的是 32 网格，但图标最终渲染在 `0 0 24 24` 的 viewBox 里，
 * 由 svg-data.mjs 等比缩放到 24（系数 0.75）。所以：
 *   · 32 网格里的 1 个单位 → 16px 显示下只有 **0.5px**
 *   · 想达到"主体厚 ≥1.4px"的门槛，stroke-width 至少要 **2.8**（2.8 × 0.5 = 1.4px）
 *   · 视觉重量比数值更直观：**描边 3.4 ≈ 16px 下 1.7px**
 *
 * 几何一律用下面的小工具算，不手算 45°/极坐标点位：
 * 手算十来个旋转后的坐标极易错一位（错一位就变成"嘴歪了"），而调姿态时只需改几个数。
 */

const DEG = Math.PI / 180

/** 把数值写成 path 里的短字符串（两位小数，去掉多余的 0） */
const n2 = (v) => String(Math.round(v * 100) / 100)

/** 极坐标取点：0° = 正右，90° = 正下（与 SVG 的屏幕坐标一致），顺时针为正 */
const polar = (cx, cy, r, deg) => [cx + r * Math.cos(deg * DEG), cy + r * Math.sin(deg * DEG)]

/** 点 → path 指令里的坐标对 */
const P = ([x, y]) => `${n2(x)} ${n2(y)}`

/**
 * 圆弧：从 a0 度画到 a1 度。
 *
 * `cw = true` 顺时针（角度递增）、`false` 逆时针（角度递减）——
 * **方向必须显式给**，因为它决定弧从哪一侧绕过去（"?"的开口在左下还是右下就靠它）。
 * large-arc 由实际跨过的角度算出，避免手填 0/1 时选了短弧、形状整个反过来。
 */
function arc(cx, cy, r, a0, a1, cw) {
  const span = cw ? (((a1 - a0) % 360) + 360) % 360 : (((a0 - a1) % 360) + 360) % 360
  const large = span > 180 ? 1 : 0
  return `M ${P(polar(cx, cy, r, a0))} A ${n2(r)} ${n2(r)} 0 ${large} ${cw ? 1 : 0} ${P(polar(cx, cy, r, a1))}`
}

/**
 * 椭圆弧：从 a0 度顺时针到 a1 度，rx / ry 可以不同。
 *
 * 单独一个函数是因为**桶提梁必须"宽而扁"**：正圆拱（rx = ry）无论加宽多少，
 * 轮廓都与挂锁的锁梁同形，16px 下整个图标就读成一把锁（实测确认过）。
 * 扁拱（ry ≈ rx × 0.6）才是"提手"的剪影。
 */
function earc(cx, cy, rx, ry, a0, a1) {
  const span = (((a1 - a0) % 360) + 360) % 360
  const large = span > 180 ? 1 : 0
  const at = (deg) => [cx + rx * Math.cos(deg * DEG), cy + ry * Math.sin(deg * DEG)]
  return `M ${P(at(a0))} A ${n2(rx)} ${n2(ry)} 0 ${large} 1 ${P(at(a1))}`
}

/**
 * 切向箭头（实心三角）：锚点 `at`、指向 `degT` 度、长 `len`、底半宽 `half`。
 *
 * 锚点选在**弧的端点**，`degT` 取该点的**运动切向**（顺时针弧的切向 = 该点角度 + 90°）。
 * 箭头略往回坐（`back`）让它与弧搭上，否则细看会有一条缝。
 */
function arrow(at, degT, len, half, back = 1.4) {
  const t = [Math.cos(degT * DEG), Math.sin(degT * DEG)]
  const nrm = [-t[1], t[0]]
  const tip = [at[0] + t[0] * len, at[1] + t[1] * len]
  const base = [at[0] - t[0] * back, at[1] - t[1] * back]
  const b1 = [base[0] + nrm[0] * half, base[1] + nrm[1] * half]
  const b2 = [base[0] - nrm[0] * half, base[1] - nrm[1] * half]
  return `M ${P(tip)} L ${P(b1)} L ${P(b2)} Z`
}

const S = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">` +
  `<rect width="32" height="32" fill="#ffffff"/>` +
  `<g fill="none" stroke="#000000" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">` +
  body +
  `</g></svg>`

/** 实心部件（箭头三角、胶头等）单独一层，用 fill */
const SF = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">` +
  `<rect width="32" height="32" fill="#ffffff"/>` +
  `<g fill="#000000" stroke="none">` +
  body +
  `</g></svg>`

/**
 * 混合层：默认实心（fill 黑、不描边），但**允许子元素自己声明 stroke**。
 *
 * 为什么需要它：油漆桶这类图标同时含"实心块面"（桶身）与"线条"（提梁）——
 * 只给 SF 的话 `stroke="none"` 会把提梁吃掉，只给 S 的话桶身会变空心轮廓，
 * 而空心轮廓与手绘版的实心块面一眼能看出不同套（掩码诊断确认过）。
 */
const SM = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">` +
  `<rect width="32" height="32" fill="#ffffff"/>` +
  `<g fill="#000000" stroke="none" stroke-linecap="round" stroke-linejoin="round">` +
  body +
  `</g></svg>`

/* ------------------------------------------------------------------ 画笔 */

/**
 * 铅笔（工具·画笔）。
 *
 * 沿 45° 轴用 `(u, v)` 局部坐标描述：u = 距笔尖的距离、v = 垂直方向的偏移，
 * 再由 `pp()` 映射到 32 网格——与 icons.ts 里吸管的 `tubePoint` 同一套手法。
 *
 * **为什么不做"笔杆 + 箍 + 笔头"三段**：箍要比笔杆宽才看得出来，而在 16px 下
 * 箍最多只能有 4~5 个 32 网格宽（≈2px），一旦做出来整支就读成"中间鼓一个包"的骨头
 * （4× 截图确认过）。16px 能承载的信息量只够"笔杆 + 尖"，箍属于低于分辨率极限的细节，
 * 所以这里只保留**轴向宽度突变**（笔尖 0 → 杆 3）这一个对比，靠它表达"这是一支笔"。
 */
const PENCIL = {
  /** 笔尖落点（左下） */
  tip: [6, 26],
  /** 轴向（-45° = 朝右上；画布 y 向下，所以"越走越高"是负角）*/
  deg: -45,
  /** 笔尖锥体的长度（0 → 满宽）与满宽处的半宽 */
  cone: 7,
  coneHalf: 3.2,
  /** 笔杆终点（距笔尖的距离）与半宽 */
  end: 26,
  endHalf: 2.6,
}

/** 铅笔局部坐标 (u, v) → 32 网格坐标 */
function pp(u, v) {
  const a = PENCIL.deg * DEG
  const cu = Math.cos(a)
  const su = Math.sin(a)
  return [PENCIL.tip[0] + u * cu - v * su, PENCIL.tip[1] + u * su + v * cu]
}

/**
 * 铅笔轮廓的**单个闭合多边形**：笔尖 → 一侧锥体肩 → 一侧杆尾 → 另一侧杆尾 → 另一侧肩 → 闭合。
 * 锥体与笔杆在 u = cone 处半宽相同，所以两者无缝连成一个形状（不做分段留缝：
 * 16px 下 1 个网格的缝只有 0.5px，会渲染成一条发灰的虚缝，反而像画坏了）。
 */
export const pencil = SF(
  `<path d="M ${P(pp(0, 0))} ` +
    `L ${P(pp(PENCIL.cone, -PENCIL.coneHalf))} ` +
    `L ${P(pp(PENCIL.end, -PENCIL.endHalf))} ` +
    `L ${P(pp(PENCIL.end, PENCIL.endHalf))} ` +
    `L ${P(pp(PENCIL.cone, PENCIL.coneHalf))} Z"/>`,
)

/* ------------------------------------------------------------------ 填充桶 */

/**
 * 油漆桶（工具·填充）。
 *
 * 形状的难点全在"**16px 下不要读成挂锁**"：锁的剪影＝窄的圆拱锁梁 + 下方一块方身，
 * 而"桶 + 提手"很容易落进同一个剪影里。上一版提梁是窄圆拱、又贴着桶沿，
 * 实测 16px 下就是一把锁（4× 最近邻截图确认）。这里用三处差异把它拉开：
 *   1. **提梁宽而扁**（rx 8.5 / ry 5，跨度 17 —— 比桶口还宽），锁梁则是窄而高的正圆拱。
 *   2. **桶沿比桶身宽**（19 : 16），形成一圈"唇"，这是桶的关键特征。
 *   3. **桶身明显收底**（顶 16 → 底 9），锁身是方的。
 * 另外补一颗**分离且够大**的水滴（约 6.4 个网格宽 ≈ 3px）：太小在 16px 下只是一个点，
 * 等于没画。
 */
export const bucket = SM(
  // 提梁：宽扁拱，末端落在桶沿上方，与桶沿留出空档
  `<path d="${earc(13, 12.5, 8.5, 5, 180, 360)}" fill="none" stroke="#000000" stroke-width="3.4"/>` +
    // 桶沿：比桶身宽，形成一圈唇
    `<path d="M3.5 14 L22.5 14 L22.5 17 L3.5 17 Z"/>` +
    // 桶身：上宽下窄
    `<path d="M5 17 L21 17 L17.5 27 L8.5 27 Z"/>` +
    // 右下：分离的一滴（尖顶 + 圆底）
    `<path d="M25.3 17.5 L28.5 22.5 A3.2 3.2 0 0 1 22.1 22.5 Z"/>`,
)

/* ------------------------------------------------------------------ 撤销 / 重做 */

/**
 * 撤销：**向左回转**的箭头。
 * 结构 = 一段从右下绕过顶部的弧 + 左端向下的实心三角。
 */
export const undo = SM(
  `<path d="M26.5 21 A11.5 11.5 0 0 0 10 8.5" fill="none" stroke="#000000" stroke-width="3.6" stroke-linecap="round"/>` +
    `<path d="M3 8.5 L11 4.5 L11 12.5 Z"/>`,
)

/**
 * 重做：**向右回转**的箭头 = 撤销的水平镜像。
 *
 * 镜像坐标是**算好的绝对坐标**，不写 `<g transform>`：
 * 接入侧的 `svg-data.mjs` 只读 `<path>` 属性、不做坐标变换，写 transform 会被静默丢掉——
 * 这正是"重做与撤销长得一模一样（箭头都朝左）"的成因，屏幕上看得出来、工具链却一声不吭。
 * 现在那边遇到 transform 会直接报错，形状一律落在绝对坐标上。
 *
 * 镜像公式（绕 32 网格中线 x=16 翻转）：`x' = 32 − x`，且 **sweep-flag 取反**。
 *   undo 弧 `M26.5 21 A11.5 11.5 0 0 0 10 8.5` → `M5.5 21 A11.5 11.5 0 0 1 22 8.5`
 *   undo 箭头三角 `M3 8.5 L11 4.5 L11 12.5` → `M29 8.5 L21 4.5 L21 12.5`
 */
export const redo = SM(
  `<path d="M5.5 21 A11.5 11.5 0 0 1 22 8.5" fill="none" stroke="#000000" stroke-width="3.6" stroke-linecap="round"/>` +
    `<path d="M29 8.5 L21 4.5 L21 12.5 Z"/>`,
)

/* ------------------------------------------------------------------ 重新转换 */

/**
 * 重新转换：**近乎闭合的环 + 缺口处的切向箭头**。
 *
 * 与"撤销/重做"的区别必须一眼看出来：那两个是**一段弧 + 一个大箭头**，
 * 这个是**一整圈 + 一个小箭头**。所以缺口只留 60°（上一版留了 154°，
 * 260° 的弧看起来仍像"C"），箭头也刻意做小、紧贴缺口。
 *
 * 箭头的指向取端点的**运动切向**（环是顺时针 300°，端点 345° 处切向 = 345+90 = 75°，
 * 即右下），这样箭头指向"转下去"的方向，而不是随手摆一个三角形。
 */
const RING = { cx: 16, cy: 16, r: 9, from: 45, to: 345 }
export const regenerate = SM(
  `<path d="${arc(RING.cx, RING.cy, RING.r, RING.from, RING.to, true)}" fill="none" stroke="#000000" stroke-width="3.4"/>` +
    `<path d="${arrow(polar(RING.cx, RING.cy, RING.r, RING.to), RING.to + 90, 5, 3.4)}"/>`,
)

/* ------------------------------------------------------------------ 调色盘 */

/**
 * 调色盘：椭圆盘 + 三个颜料孔 + 右下拇指孔。
 * 像素格版被读成"对话框"——孔没挖出来。
 */
export const palette =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">` +
  `<rect width="32" height="32" fill="#ffffff"/>` +
  /*
   * 盘身 + 三个颜料孔，全部用 <path>（而不是 <ellipse>）：
   * 接入 icons.ts 时只提取 path 的 d，用 ellipse 会取不到数据（实测 0 条 path）。
   * 椭圆用两段弧拼（与 icons.ts 里吸管胶头同一手法）；孔靠 fill-rule=evenodd 挖空。
   */
  `<path fill="#000000" fill-rule="evenodd" d="` +
  `M15 4 A11 11 0 1 0 15 26 A11 11 0 1 0 15 4 Z` +
  `M14 4.6 A2.6 2.4 0 1 0 14 9.4 A2.6 2.4 0 1 0 14 4.6 Z` +
  `M7 9.6 A2.6 2.4 0 1 0 7 14.4 A2.6 2.4 0 1 0 7 9.6 Z` +
  `M10 18.6 A2.6 2.4 0 1 0 10 23.4 A2.6 2.4 0 1 0 10 18.6 Z` +
  `M22 16.8 A3.6 3.2 0 1 0 22 23.2 A3.6 3.2 0 1 0 22 16.8 Z` +
  `"/>` +
  `</svg>`

/* ------------------------------------------------------------------ 快捷键 */

/**
 * 快捷键（问号）。
 *
 * 上一版读成"实心块 / 灯泡"，三个原因，逐个修掉：
 *   1. **弧包得太多**（约 256°，几乎是个闭合圆）→ 内侧的空白被挤没了。
 *      现在收成 280° 的钩，并把**半径放大到 7、描边收细到 2.9**：
 *      内孔半径 = 7 − 1.45 = 5.55 个网格 ≈ **5.5px @16px**，空白才真的看得见。
 *      这一条是 16px 下的生死线——内孔小于 ~5px 时抗锯齿会把孔糊死，
 *      整个问号退化成一个实心疙瘩（上一版内孔 4.25px 就是这样）。
 *      代价是描边降到 2.9（≈1.45px @16px），刚好卡在"主体厚 ≥1.4px"的门槛上。
 *   2. **开口方向错了**：问号的开口应落在**左下**，上一版的弧首尾都在底部。
 *      现在从正下方（90°）逆时针绕 280° 收到 170°（九点钟略偏上）。
 *   3. **点被裁掉了**：方点原本落在 y=25..30.4，而 viewBox 只有 24（缩放前是 32 网格，
 *      点在 25..30.4 没超 32，但**缩放到 24 后**就跑到画布外了）。现在点在 y=23.5..29，
 *      且整体下移前先确认 32→24 缩放后仍在框内（由 svg-data.mjs 的数值自检兜底）。
 */
const HELP = { cx: 16, cy: 10.5, r: 7 }
export const help =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">` +
  `<rect width="32" height="32" fill="#ffffff"/>` +
  // 钩：正下方起、逆时针绕到九点钟略偏上（开口留在左下）
  `<g fill="none" stroke="#000000" stroke-width="2.9" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="${arc(HELP.cx, HELP.cy, HELP.r, 90, 170, false)}"/>` +
  // 竖：从钩的起点（正下方）垂下去，构成问号的尾巴
  `<path d="M${HELP.cx} ${HELP.cy + HELP.r} L${HELP.cx} 20.5"/>` +
  `</g>` +
  // 点：实心方块（比线段清晰；上一版用长度 1 的线段 + 圆帽，渲染成模糊小短杠）。
  // 宽度取 5（≈2.5px @16px）：6 会渲染成 4px 的实心块，比 1.45px 的笔画重太多、喧宾夺主。
  `<rect x="13.5" y="23.5" width="5" height="5" fill="#000000"/>` +
  `</svg>`

/* ------------------------------------------------------------------ 后处理滑杆 */

/**
 * 后处理滑杆：三条轨道 + 三个滑块（圆角矩形）。
 * 滑块落在轨道**中部范围**；像素格版滑块贴两端，读成"旗子"。
 */
export const sliders = S(
  `<path d="M5 8 H27" stroke-width="4"/>` +
    `<path d="M5 16 H27" stroke-width="4"/>` +
    `<path d="M5 24 H27" stroke-width="4"/>` +
    `<g stroke-width="7">` +
    `<path d="M11 8 L11 8"/>` +
    `<path d="M20 16 L20 16"/>` +
    `<path d="M9 24 L9 24"/>` +
    `</g>`,
)

/** 需要重新栅格化的图标（其余 13 个像素版已达标，保留） */
export const SVG_SHAPES = {
  tool_pencil: pencil,
  tool_bucket: bucket,
  act_undo: undo,
  act_redo: redo,
  act_regenerate: regenerate,
  cat_palette: palette,
  act_help: help,
  cat_sliders: sliders,
}
