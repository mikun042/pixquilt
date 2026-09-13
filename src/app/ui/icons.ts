/**
 * 内联 SVG 图标。
 *
 * 为什么不用字符：Unicode 里没有"吸管"这个符号，最接近的 `⌖` 是**准星**——
 * 用户的原话是"让它看上去更像吸管"，而准星既不像吸管也不像取色。
 * 项目禁止外部资源（单文件、不联网），所以图标只能内联 SVG。
 *
 * 统一规格：24×24 viewBox、`stroke="currentColor"`（跟着按钮文字色走，
 * 悬停/激活态自动变色，不需要为每个状态各写一份）、`fill="none"`。
 * 尺寸由 CSS 控制（`.icon-svg`），这里不写 width/height，
 * 避免与 CSS 打架——写死了以后改样式不生效是最容易踩的一类坑。
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

/** 吸管：左上斜置的管身 + 右上橡胶头 + 左下尖嘴 + 管身上一道高光 */
const EYEDROPPER_PATHS = [
  // 管身：从右上到左下的一条粗斜线（用矩形旋转得到，比手写路径更规整）
  'M11.5 6.5 L17.5 12.5 L9 21 L5.5 21 L5.5 17.5 Z',
  // 橡胶头：管身右上端的一小段
  'M16 2.8 A2.6 2.6 0 0 1 21.2 8 L17.5 12.5 L11.5 6.5 Z',
  // 管身高光：一道短细线，让"管子"读起来是圆柱
  'M10.2 13.8 L13.2 16.8',
]

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
  for (const d of EYEDROPPER_PATHS) {
    const p = document.createElementNS(SVG_NS, 'path')
    p.setAttribute('d', d)
    svg.append(p)
  }
  return svg
}
