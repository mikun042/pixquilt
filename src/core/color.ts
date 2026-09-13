/**
 * 颜色工具：sRGB ⇄ OKLab（感知均匀，用于最近色匹配）、HSV（取色器）、渐变与文字色。
 * 全部是纯函数，不依赖 DOM —— core 层的硬约束（见 重构计划.md §15.1 R1）。
 */
import { normalizeHex } from './types.ts'

export interface Rgb {
  r: number
  g: number
  b: number
}

export interface Lab {
  L: number
  a: number
  b: number
}

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

/** sRGB 分量（0–255）→ 线性光 */
function srgbToLinear(c: number): number {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(c * 255)))
}

/** OKLab 的立方根分支：负值用符号保持对称（避免 NaN 传染整个匹配过程） */
function cbrt(x: number): number {
  return x >= 0 ? Math.cbrt(x) : -Math.cbrt(-x)
}

export function rgbToOklab(r: number, g: number, b: number): Lab {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)

  const l = cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  }
}

export function oklabToRgb(L: number, a: number, b: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3

  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  }
}

/** 预计算色板的 OKLab 值：量化时每格都要比对，不能每次重算 */
export function buildPaletteLabs(palette: Rgb[]): Lab[] {
  return palette.map((c) => rgbToOklab(c.r, c.g, c.b))
}

/** OKLab 空间里最近色的下标（感知均匀，比 RGB 距离更贴合人眼） */
export function nearestColorIndex(labs: Lab[], L: number, a: number, b: number): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < labs.length; i++) {
    const p = labs[i]
    const dl = p.L - L
    const da = p.a - a
    const db = p.b - b
    const d = dl * dl + da * da + db * db
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max / 255 }
}

export function hsvToRgb(h: number, s: number, v: number): Rgb {
  const hh = ((h % 360) + 360) % 360
  const c = v * s
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = v - c
  let r = 0
  let g = 0
  let b = 0
  if (hh < 60) [r, g, b] = [c, x, 0]
  else if (hh < 120) [r, g, b] = [x, c, 0]
  else if (hh < 180) [r, g, b] = [0, c, x]
  else if (hh < 240) [r, g, b] = [0, x, c]
  else if (hh < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 }
}

/** 感知亮度（用于决定色块上的文字取黑还是白） */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** 色块上的可读文字色 */
export function colorTextOn(hex: string): '#111' | '#fff' {
  const c = hexToRgb(hex)
  return luminance(c.r, c.g, c.b) < 140 ? '#fff' : '#111'
}

/** OKLab 线性插值（渐变行用）：在感知空间混色，不会出现中间发灰 */
export function oklabMix(from: Rgb, to: Rgb, t: number): Rgb {
  const a = rgbToOklab(from.r, from.g, from.b)
  const b = rgbToOklab(to.r, to.g, to.b)
  return oklabToRgb(a.L + (b.L - a.L) * t, a.a + (b.a - a.a) * t, a.b + (b.b - a.b) * t)
}

/** 生成 n 档渐变（含首尾），用于"渐变行"功能 */
export function gradientPalette(fromHex: string, toHex: string, steps: number): string[] {
  const from = normalizeHex(fromHex)
  const to = normalizeHex(toHex)
  if (!from || !to) return []
  const n = Math.max(2, Math.min(64, Math.round(steps)))
  const a = hexToRgb(from)
  const b = hexToRgb(to)
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const c = oklabMix(a, b, n === 1 ? 0 : i / (n - 1))
    out.push(rgbToHex(c.r, c.g, c.b))
  }
  return out
}

/** 取色器轨道段数：段越多越平滑，但每帧重建的成本越高 */
export const PICKER_RAMP_SEGMENTS = 12

/**
 * 轨道渐变的 CSS 色标串。这里用 JS 预采样 OKLab 再交给 CSS 线性插值，
 * 避免每帧让浏览器光栅化 `in oklab`（弱机上肉眼可见的掉帧）。
 */
export function oklabGradientCss(from: Rgb, to: Rgb, direction: 'to right' | 'to bottom', segments = PICKER_RAMP_SEGMENTS): string {
  const stops: string[] = []
  for (let i = 0; i <= segments; i++) {
    const c = oklabMix(from, to, i / segments)
    stops.push(`${rgbToHex(c.r, c.g, c.b)} ${((i / segments) * 100).toFixed(1)}%`)
  }
  return `linear-gradient(${direction}, ${stops.join(', ')})`
}
