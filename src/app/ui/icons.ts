/**
 * 内联 SVG 图标。
 *
 * 为什么不用字符：Unicode 里没有"吸管"这个符号，最接近的 `⌖` 是**准星**——
 * 用户的原话是"让它看上去更像吸管"，而准星既不像吸管也不像取色。
 * 项目禁止外部资源（单文件、不联网），所以图标只能内联 SVG。
 *
 * 统一规格：24×24 viewBox、`stroke="currentColor"`（跟着按钮文字色走，
 * 悬停/激活态自动变色，不需要为每个状态各写一份）。尺寸由 CSS 控制（`.icon-svg`），
 * 这里不写 width/height，避免与 CSS 打架——写死了以后改样式不生效是最容易踩的一类坑。
 *
 * ⚠️ `tool/e2e-pdf.mjs` 有一组几何断言锁着吸管图标（≥2 条 path、viewBox 固定为
 * `0 0 24 24`、笔画落在画布内、包围盒 ≥12×12、无退化笔画）。**改形状后必须重跑
 * `npm run e2e:pdf`**——`npm run shoot` 出的截图只能看个大概，断言才是硬约束。
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * 吸管（滴管）的外形参数。
 *
 * 姿态照 **Blender 取色界面里那颗吸管按钮**（项目参考图 `屏幕截图 2026-09-12 183650.png`
 * 的右下角就是它）：尖端在左下、胶头在右上、整体斜置 45°。
 *
 * 拆开看它其实是三件东西，少一件就会读错（每一版都截图对过）：
 *   1. **实心的圆胶头**（右上）——最关键的一件。之前几版把胶头画成**空心**的圆/半圆，
 *      结果分别读成"钩子""图钉""钢笔"；只有填成实心球才立刻变成滴管。
 *      这也解释了为什么参考图里胶头是实心、管身是空心线——实空对比正是"橡胶头 + 玻璃管"。
 *   2. **空心的锥形管身**（中间，两条平行线向尖端收成一点）。
 *   3. **靠近尖端的一圈"箍"**（比管身宽一点的横杠）——滴管口的接口。
 *      注意它必须配合实心胶头：只有它、没有实心胶头时，整支会读成带护手的剑。
 *
 * 坐标分两层：形状在**局部坐标**里描述（`u` = 沿管身向前、尖端处 u=0；
 * `v` = 垂直管身、两侧对称），再由 `tubePoint()` 一次性映射到 24×24。
 * 这么做的原因很实际：手算十来个 45° 旋转后的点极易错一位（错一位就变成
 * "嘴歪了"或"胶头长在管身中间"），而将来调姿态只需改下面这几个数。
 */
const DROPPER = {
  /** 尖端在画布上的落点 */
  pivot: { x: 3, y: 21 },
  /** 管身倾角（度）。-45 = 朝右上；画布 y 轴向下，所以"越走越高"是负角 */
  angle: -45,
  /** 尖端锥体长度（尖端 → 管身满宽处）*/
  tip: 3.6,
  /** 管身外缘半宽（两条线各自的中心线位置，描边宽 1.7）*/
  tube: 1.9,
  /** 管顶位置：**要伸进胶头内部**，那条封口线才会被实心胶头盖住 */
  neck: 15.5,
  /** "箍"的位置（局部 u，靠近尖端）与半宽（比管身宽才看得出来）*/
  collarAt: 4.6,
  collarHalf: 2.9,
  /** 实心胶头的圆心（局部 u）与半径 */
  bulbAt: 18.5,
  bulb: 4,
} as const

/** 局部坐标 (u, v) → 24×24 画布坐标 */
function tubePoint(u: number, v: number): [number, number] {
  const rad = (DROPPER.angle * Math.PI) / 180
  const cu = Math.cos(rad)
  const su = Math.sin(rad)
  // 垂直方向 = 轴向旋转 90°，于是 (u,v) 是一组正交基
  return [DROPPER.pivot.x + u * cu - v * su, DROPPER.pivot.y + u * su + v * cu]
}

/** 画布坐标 → path 指令里的数字（两位小数足够，且避免超长字符串） */
const xy = ([x, y]: [number, number]): string => `${x.toFixed(2)} ${y.toFixed(2)}`

/** 一条吸管的路径 + 该条要不要填实（胶头实心、管身空心）*/
interface IconPath {
  d: string
  filled?: boolean
}

/**
 * 吸管的三条路径：
 *  1. **管身**（空心闭合）——尖端 → 一侧管壁 → 管顶 → 另一侧管壁 → 回尖端。
 *  2. **箍**（空心）——靠近尖端的一道横杠。
 *  3. **胶头**（实心）——一个正圆。用两段半圆弧拼成，而不是 `<circle>`：
 *     e2e 的几何断言只统计 `<path>`，用 circle 会少一条路径、直接判失败。
 */
function eyedropperPaths(): IconPath[] {
  const { tip, tube, neck, collarAt, collarHalf, bulbAt, bulb } = DROPPER

  const body: IconPath = {
    d: [
      `M ${xy(tubePoint(0, 0))}`,
      `L ${xy(tubePoint(tip, -tube))}`,
      `L ${xy(tubePoint(neck, -tube))}`,
      `L ${xy(tubePoint(neck, tube))}`,
      `L ${xy(tubePoint(tip, tube))}`,
      'Z',
    ].join(' '),
  }

  const collar: IconPath = {
    d: `M ${xy(tubePoint(collarAt, -collarHalf))} L ${xy(tubePoint(collarAt, collarHalf))}`,
  }

  const [cx, cy] = tubePoint(bulbAt, 0)
  const bulbPath: IconPath = {
    // a r r 0 1 0 2r 0 走半圈，再来一次绕回来
    d: `M ${(cx - bulb).toFixed(2)} ${cy.toFixed(2)} a ${bulb} ${bulb} 0 1 0 ${(bulb * 2).toFixed(2)} 0 a ${bulb} ${bulb} 0 1 0 ${(-bulb * 2).toFixed(2)} 0 Z`,
    filled: true,
  }

  return [body, collar, bulbPath]
}

/**
 * 创建一个 SVG 图标元素。
 * 返回 `null` 表示没有该图标——调用方应回退到文字/字符，**不要**静默产出空按钮。
 */
export function iconEl(name: 'eyedropper'): SVGSVGElement | null {
  if (name !== 'eyedropper') return null
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.7')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', 'icon-svg')
  for (const { d, filled } of eyedropperPaths()) {
    const p = document.createElementNS(SVG_NS, 'path')
    p.setAttribute('d', d)
    // 胶头填实：与空心管身形成"橡胶头 + 玻璃管"的实空对比（见 DROPPER 注释）
    if (filled) p.setAttribute('fill', 'currentColor')
    svg.append(p)
  }
  return svg
}
