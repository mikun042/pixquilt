/**
 * 像素化管线：裁剪 → 降采样 → 预处理 → 色板确定 → 量化映射（含抖动）→ 杂色清理。
 *
 * 纯函数、无 DOM：既能被浏览器 UI 调用，也能被 Node CLI 直接调用（docs/DEVELOPMENT.md §4.1 的 L3），
 * 这样"页内"与"批处理"走**同一份实现**，不会出现两套逻辑漂移。
 *
 * 四条不肯妥协的顺序约束（改这里之前先读 docs/ARCHITECTURE.md §3）：
 *  1. 预处理放在降采样之后：亮度/对比度/饱和度是逐像素仿射运算，与区域平均可交换，
 *     而在小图上做能省掉 90% 以上的计算。
 *  2. 抖动必须并入量化映射步：Floyd–Steinberg 要按扫描序把误差扩散给"尚未量化"的邻居，
 *     事后处理拿不到那个中间状态。
 *  3. 杂色清理与抖动互斥：抖动的单像素点恰恰就是"杂色"，同时开会把抖动结果吃掉。
 *  4. OKLab 匹配缓存在抖动开启时必须关闭：误差扩散后每格的实际输入色都带累计误差，
 *     缓存会把后出现的格子匹配到错误索引。
 */
import { MEDIAN_CUT_SAMPLE_LIMIT, PALETTE_MAX } from './limits.ts'
import {
  buildPaletteLabs,
  hexToRgb,
  nearestColorIndex,
  rgbToHex,
  rgbToOklab,
  type Rgb,
} from './color.ts'
import { dedupePalette, getPreset } from './palettes.ts'
import { ALPHA_THRESHOLD, normalizeHex, type ConvertParams, type CropRatio, type PixelArt } from './types.ts'

/** 原始图片像素（RGBA，行主序）。所有解码器（浏览器 ImageBitmap / Node PNG）都归一到这个形状 */
export interface SourceImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

export interface CropRect {
  sx: number
  sy: number
  sw: number
  sh: number
}

export function computeCropRect(imgW: number, imgH: number, ratio: CropRatio): CropRect {
  if (ratio === 'free' || imgW <= 0 || imgH <= 0) return { sx: 0, sy: 0, sw: imgW, sh: imgH }
  const [rw, rh] = ratio.split(':').map(Number)
  const target = rw / rh
  const cur = imgW / imgH
  let sw = imgW
  let sh = imgH
  if (cur > target) sw = Math.round(imgH * target)
  else sh = Math.round(imgW / target)
  return { sx: Math.floor((imgW - sw) / 2), sy: Math.floor((imgH - sh) / 2), sw, sh }
}

/** 输出格数：默认"长边格数 + 按原图宽高比推短边"，给了精确尺寸则直接采用 */
export function computeGridSize(sw: number, sh: number, params: ConvertParams): { w: number; h: number } {
  if (params.exactWidth && params.exactHeight) return { w: params.exactWidth, h: params.exactHeight }
  const long = params.longEdge
  if (sw >= sh) {
    return { w: long, h: Math.max(1, Math.round((sh / sw) * long)) }
  }
  return { w: Math.max(1, Math.round((sw / sh) * long)), h: long }
}

/** 裁剪 + 降采样 + alpha 处理，直接得到目标格数的 RGBA 缓冲 */
function sampleGrid(
  src: SourceImage,
  crop: CropRect,
  w: number,
  h: number,
  params: ConvertParams,
): { data: Uint8ClampedArray; alpha: Uint8Array | null } {
  const out = new Uint8ClampedArray(w * h * 4)
  const alpha = params.transparent === 'alpha' ? new Uint8Array(w * h) : null
  const matte = hexToRgb(params.matteColor)
  const useNearest = params.downsample === 'nearest'

  for (let gy = 0; gy < h; gy++) {
    const y0 = crop.sy + Math.floor((gy * crop.sh) / h)
    const y1 = Math.max(y0 + 1, crop.sy + Math.floor(((gy + 1) * crop.sh) / h))

    for (let gx = 0; gx < w; gx++) {
      const x0 = crop.sx + Math.floor((gx * crop.sw) / w)
      const x1 = Math.max(x0 + 1, crop.sx + Math.floor(((gx + 1) * crop.sw) / w))

      let r = 0
      let g = 0
      let b = 0
      let aSum = 0
      let n = 0

      if (useNearest) {
        // 最近邻：取区域中心那个像素，保留硬边（已有清晰色块的图更合适）
        const px = Math.min(src.width - 1, Math.floor((x0 + x1) / 2))
        const py = Math.min(src.height - 1, Math.floor((y0 + y1) / 2))
        const i = (py * src.width + px) * 4
        r = src.data[i]
        g = src.data[i + 1]
        b = src.data[i + 2]
        aSum = src.data[i + 3]
        n = 1
      } else {
        // 区域平均：照片首选（面积平均天然抗摩尔纹）
        for (let sy = y0; sy < y1; sy++) {
          if (sy < 0 || sy >= src.height) continue
          const rowBase = sy * src.width
          for (let sx = x0; sx < x1; sx++) {
            if (sx < 0 || sx >= src.width) continue
            const i = (rowBase + sx) * 4
            const a = src.data[i + 3]
            // 透明像素不参与取色：把它的 RGB 按 alpha 加权，避免透明区的黑边被平均进来
            r += src.data[i] * a
            g += src.data[i + 1] * a
            b += src.data[i + 2] * a
            aSum += a
            n++
          }
        }
      }

      const o = (gy * w + gx) * 4
      const aAvg = n > 0 ? aSum / n : 0

      if (alpha) {
        const transparent = aAvg < ALPHA_THRESHOLD
        alpha[gy * w + gx] = transparent ? 0 : 255
        if (aSum > 0 && !useNearest) {
          // 用 alpha 加权平均还原颜色（除以权重和，而不是像素个数）
          out[o] = r / aSum
          out[o + 1] = g / aSum
          out[o + 2] = b / aSum
        } else {
          out[o] = r
          out[o + 1] = g
          out[o + 2] = b
        }
        out[o + 3] = transparent ? 0 : 255
      } else {
        // 不保留透明：按 alpha 合成到 matteColor（否则透明区会变成一片黑）
        if (aSum > 0 && !useNearest) {
          out[o] = r / aSum
          out[o + 1] = g / aSum
          out[o + 2] = b / aSum
        } else {
          out[o] = r
          out[o + 1] = g
          out[o + 2] = b
        }
        const a = Math.max(0, Math.min(1, aAvg / 255))
        out[o] = out[o] * a + matte.r * (1 - a)
        out[o + 1] = out[o + 1] * a + matte.g * (1 - a)
        out[o + 2] = out[o + 2] * a + matte.b * (1 - a)
        out[o + 3] = 255
      }
    }
  }

  return { data: out, alpha }
}

/** 亮度/对比度/饱和度（在小图上做，见文件头约束 1） */
export function preprocess(data: Uint8ClampedArray, brightness: number, contrast: number, saturation: number): void {
  if (brightness === 0 && contrast === 0 && saturation === 0) return
  const b = (brightness / 100) * 255
  const c = contrast / 100
  const sat = 1 + saturation / 100

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i]
    let g = data[i + 1]
    let bl = data[i + 2]

    if (b !== 0) {
      r += b
      g += b
      bl += b
    }
    if (c !== 0) {
      // 绕中灰旋转的对比度曲线（保留 0/255 端点，避免高光溢出成死白）
      const f = (1 + c) / (1 - Math.min(0.99, c * 0.999))
      r = (r - 128) * f + 128
      g = (g - 128) * f + 128
      bl = (bl - 128) * f + 128
    }
    if (sat !== 1) {
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * bl
      r = lum + (r - lum) * sat
      g = lum + (g - lum) * sat
      bl = lum + (bl - lum) * sat
    }

    data[i] = r
    data[i + 1] = g
    data[i + 2] = bl
  }
}

interface Box {
  from: number
  to: number
}

/** 通道是否"有内容"：范围小于 1 视为纯色，切它没有意义 */
function channelRange(colors: Rgb[], from: number, to: number, ch: 'r' | 'g' | 'b'): number {
  let min = 255
  let max = 0
  for (let i = from; i < to; i++) {
    const v = colors[i][ch]
    if (v < min) min = v
    if (v > max) max = v
  }
  return max - min
}

/**
 * Median Cut 取色：把像素集合装进盒子，反复按"跨度最大的通道"从中间切开，直到得到 K 个盒子。
 *
 * 两个刻意设计：
 *  - **抽样**：超过 MEDIAN_CUT_SAMPLE_LIMIT 格时按固定步长（乘法散列）抽样。切分是统计性聚类，
 *    几百万像素只会让盒内排序白白变慢；固定散列保证"同图同参 → 同色板"。
 *  - **换轴而非排序**：每轮只按目标通道排序一次（O(n log n) 而非全通道扫描），把排序键缓存进临时数组。
 */
export function medianCut(colors: Rgb[], k: number): string[] {
  if (colors.length === 0) return []
  const target = Math.max(1, Math.min(PALETTE_MAX, Math.round(k)))

  // 抽样：超过阈值时取固定间距的子集（散列步长避免与图像周期结构共振）
  let sample = colors
  if (colors.length > MEDIAN_CUT_SAMPLE_LIMIT) {
    const step = Math.max(1, Math.floor(colors.length / MEDIAN_CUT_SAMPLE_LIMIT))
    const picked: Rgb[] = []
    for (let i = 0, j = 0; i < colors.length; i += 1, j += 1) {
      // 乘法散列：0.618… 的整数近似，保证样本在整幅图上均匀散布
      if ((j * 2654435761) % step === 0) picked.push(colors[i])
      if (picked.length >= MEDIAN_CUT_SAMPLE_LIMIT) break
    }
    sample = picked.length > 0 ? picked : colors.slice(0, MEDIAN_CUT_SAMPLE_LIMIT)
  }

  const work = sample.slice()
  const boxes: Box[] = [{ from: 0, to: work.length }]

  while (boxes.length < target) {
    let bestIdx = -1
    let bestRange = 1
    let bestCh: 'r' | 'g' | 'b' = 'r'
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]
      if (box.to - box.from < 2) continue
      for (const ch of ['r', 'g', 'b'] as const) {
        const range = channelRange(work, box.from, box.to, ch)
        if (range > bestRange) {
          bestRange = range
          bestIdx = i
          bestCh = ch
        }
      }
    }
    if (bestIdx < 0) break // 所有盒子都不可再分

    const box = boxes[bestIdx]
    const slice = work.slice(box.from, box.to)
    slice.sort((p, q) => p[bestCh] - q[bestCh])
    for (let i = 0; i < slice.length; i++) work[box.from + i] = slice[i]

    const mid = box.from + ((box.to - box.from) >> 1)
    boxes.splice(bestIdx, 1, { from: box.from, to: mid }, { from: mid, to: box.to })
  }

  const out: string[] = []
  for (const box of boxes) {
    if (box.to <= box.from) continue
    let r = 0
    let g = 0
    let b = 0
    for (let i = box.from; i < box.to; i++) {
      r += work[i].r
      g += work[i].g
      b += work[i].b
    }
    const n = box.to - box.from
    out.push(rgbToHex(r / n, g / n, b / n))
  }
  return dedupePalette(out)
}

/** 按参数确定工作色板（自动取色 / 预置色卡 / 自定义） */
export function resolvePalette(data: Uint8ClampedArray, alpha: Uint8Array | null, params: ConvertParams): string[] {
  if (params.paletteMode === 'preset') {
    const preset = getPreset(params.presetPaletteId)
    if (preset) return preset.colors.slice(0, PALETTE_MAX).map((c) => c.toLowerCase())
    // 未知预置 id：退回自动取色而不是报错 —— 参数已被 sanitize 过一次，这里只做兜底
  }
  if (params.paletteMode === 'custom' && params.customPalette.length > 0) {
    return params.customPalette.map((c) => (normalizeHex(c) ?? '#000000')).slice(0, PALETTE_MAX)
  }

  const colors: Rgb[] = []
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (alpha && alpha[p] === 0) continue // 透明格不参与取色
    colors.push({ r: data[i], g: data[i + 1], b: data[i + 2] })
  }
  return medianCut(colors, params.paletteK)
}

/** Bayer 4×4 有序抖动阈值矩阵（归一化到 -0.5..0.5 的偏移） */
const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
]

export interface QuantizeResult {
  indices: Uint8Array
  /** 因色板已满而没能精确匹配的格数（lockPalette 时必须为 0，否则说明色板选错了） */
  overflow: number
}

/**
 * 量化映射：为每格选最近色。抖动在这一步内完成（见文件头约束 2）。
 *
 * - 关抖动时启用 RGB→索引的直接映射缓存（≤2^20 槽）：照片里大量重复色能省掉重复的 OKLab 比对。
 * - 开抖动时**必须关闭缓存**：F-S 扩散后每格的实际输入色带累计误差，缓存会算出错误结果。
 */
export function quantize(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  palette: string[],
  params: ConvertParams,
  alpha: Uint8Array | null,
): QuantizeResult {
  const indices = new Uint8Array(w * h)
  const rgbs = palette.map(hexToRgb)
  const labs = buildPaletteLabs(rgbs)
  const dither = params.dither
  const strength = params.ditherStrength / 100

  // 抖动与清理互斥由调用方（runPipeline）强制，这里只负责映射本身
  const useCache = dither === 'none'
  /**
   * RGB→索引 的直接映射缓存（三个平行数组，命中条件一句话说清：**完整 RGB 完全相同**）。
   *
   *  - `slotKeys`：截断键（每通道 5 bit）→ 决定落在哪个槽，纯粹为了寻址快；
   *  - `fullKeys`：完整 24 位 RGB → **命中时校验的是它**，避免"键前缀相同但颜色不同"被错误复用；
   *  - `cacheIdx`：该颜色对应的最近色索引。
   *
   * 早先的版本用"截断键"当唯一身份，导致 top-5-bit 相同的两个颜色拿到同一个索引，
   * 表现为"固定色板下整幅图只剩几种颜色"且完全静默（实测 1200 格里错 4 格、极端情况下只剩 1 色）。
   */
  const CACHE_BITS = 5
  const CACHE_SIZE = 1 << (CACHE_BITS * 3)
  const slotKeys = useCache ? new Int32Array(CACHE_SIZE).fill(-1) : null
  const fullKeys = useCache ? new Int32Array(CACHE_SIZE) : null
  const cacheIdx = useCache ? new Uint8Array(CACHE_SIZE) : null

  const work = new Float32Array(data.length)
  for (let i = 0; i < data.length; i++) work[i] = data[i]

  let overflow = 0
  const lastIndex = palette.length - 1

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const o = p * 4
      const isTransparent = alpha ? alpha[p] === 0 : false

      let r = work[o]
      let g = work[o + 1]
      let b = work[o + 2]

      if (!isTransparent && dither === 'bayer') {
        const t = (BAYER4[y & 3][x & 3] / 15 - 0.5) * 255 * strength
        r += t
        g += t
        b += t
      }

      // 先夹到 0–255 并取整：缓存键与色距计算都用这份夹紧后的整数颜色
      const ri = Math.max(0, Math.min(255, Math.round(r)))
      const gi = Math.max(0, Math.min(255, Math.round(g)))
      const bi = Math.max(0, Math.min(255, Math.round(b)))

      let idx: number
      if (slotKeys && fullKeys && cacheIdx) {
        const full = (ri << 16) | (gi << 8) | bi
        const slot = ((ri >> (8 - CACHE_BITS)) << (CACHE_BITS * 2)) | ((gi >> (8 - CACHE_BITS)) << CACHE_BITS) | (bi >> (8 - CACHE_BITS))
        if (slotKeys[slot] === slot && fullKeys[slot] === full) {
          idx = cacheIdx[slot]
        } else {
          const lab = rgbToOklab(ri, gi, bi)
          idx = nearestColorIndex(labs, lab.L, lab.a, lab.b)
          slotKeys[slot] = slot
          fullKeys[slot] = full
          cacheIdx[slot] = idx
        }
      } else {
        const lab = rgbToOklab(ri, gi, bi)
        idx = nearestColorIndex(labs, lab.L, lab.a, lab.b)
      }

      if (idx > lastIndex) {
        idx = lastIndex
        overflow++
      }
      indices[p] = idx

      if (!isTransparent && dither === 'floyd' && strength > 0) {
        // F-S 误差扩散：按扫描序把量化误差分给右、左下、下、右下四个邻居
        const target = rgbs[idx]
        const er = (r - target.r) * strength
        const eg = (g - target.g) * strength
        const eb = (b - target.b) * strength
        const spread = (dx: number, dy: number, f: number) => {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || nx >= w || ny >= h) return
          const no = (ny * w + nx) * 4
          work[no] += er * f
          work[no + 1] += eg * f
          work[no + 2] += eb * f
        }
        spread(1, 0, 7 / 16)
        spread(-1, 1, 3 / 16)
        spread(0, 1, 5 / 16)
        spread(1, 1, 1 / 16)
      }
    }
  }

  return { indices, overflow }
}

/**
 * 杂色清理：把连通域小于阈值的色块并入"邻域出现最多的颜色"。
 * 目的不是降噪而是让色块成形（像素画里孤立的单像素点几乎总是量化噪声）。
 * 与抖动互斥的理由见文件头约束 3 —— 调用方负责保证不会同时开。
 */
export function cleanup(indices: Uint8Array, w: number, h: number, minSize: number, alpha: Uint8Array | null): Uint8Array {
  const total = w * h
  const out = indices.slice()
  const visited = new Uint8Array(total)
  const queue = new Int32Array(total)
  const stack = new Int32Array(8)

  for (let start = 0; start < total; start++) {
    if (visited[start]) continue
    const color = indices[start]
    // 透明格不参与清理：它们不是"色块"，被并入邻色会凭空造出像素
    if (alpha && alpha[start] === 0) {
      visited[start] = 1
      continue
    }

    let head = 0
    let tail = 0
    queue[tail++] = start
    visited[start] = 1
    const region: number[] = []

    while (head < tail) {
      const c = queue[head++]
      region.push(c)
      const x = c % w
      const y = (c / w) | 0
      let sp = 0
      if (x > 0) stack[sp++] = c - 1
      if (x < w - 1) stack[sp++] = c + 1
      if (y > 0) stack[sp++] = c - w
      if (y < h - 1) stack[sp++] = c + w
      for (let i = 0; i < sp; i++) {
        const n = stack[i]
        if (visited[n]) continue
        if (indices[n] !== color) continue
        if (alpha && alpha[n] === 0) continue
        visited[n] = 1
        queue[tail++] = n
      }
    }

    if (region.length >= minSize) continue

    // 找邻域主色：统计与区域相邻、但不属于该区域的颜色出现次数
    const counts = new Map<number, number>()
    for (const c of region) {
      const x = c % w
      const y = (c / w) | 0
      const consider = (nx: number, ny: number) => {
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) return
        const n = ny * w + nx
        if (indices[n] === color) return
        if (alpha && alpha[n] === 0) return
        counts.set(indices[n], (counts.get(indices[n]) ?? 0) + 1)
      }
      consider(x - 1, y)
      consider(x + 1, y)
      consider(x, y - 1)
      consider(x, y + 1)
    }
    if (counts.size === 0) continue // 整幅图只有这一种颜色：没有可并入的邻色

    let bestColor = color
    let bestCount = -1
    for (const [c, n] of counts) {
      if (n > bestCount) {
        bestCount = n
        bestColor = c
      }
    }
    for (const c of region) out[c] = bestColor
  }

  return out
}

export interface CleanupReport {
  /** 实际被清理改掉的格子数 */
  changedCells: number
  /** 清理前存在、清理后整幅图不再出现的色（调色板索引 + 原 hex） */
  removedColors: { index: number; hex: string; cells: number }[]
  /** removedColors 是否因数量上限被截断 */
  truncated: boolean
}

export interface RunPipelineResult {
  art: PixelArt
  /** 色板是否因色板已满而出现近似匹配（lockPalette 时应为 0） */
  overflow: number
  /** 实际使用的色板来源，便于日志与复现 */
  paletteSource: 'preset' | 'custom' | 'auto'
  /** 杂色清理的实际改动；未启用清理时为 null */
  cleanup: CleanupReport | null
}

/**
 * 统计杂色清理到底改了什么。
 *
 * 为什么必须上报：`cleanup` 出厂默认开启（cleanupMinSize=2），而它的作用是"把小连通块并入邻色"，
 * 对像素画资产来说"小连通块"往往正是**故意画的 1px 细节**——高光、眼神、描边断点。
 * 实测 64×64 精灵过一遍默认参数，1px 高光被整块吃掉且毫无提示，调用方只能靠对图才看得出来。
 * 因此这里如实报出"改了多少格、哪些颜色整幅消失"，让损失可见、可判断、可回退（--no-cleanup）。
 */
function measureCleanup(
  before: Uint8Array,
  after: Uint8Array,
  palette: string[],
): CleanupReport {
  const MAX_REPORTED = 16
  const beforeCounts = new Map<number, number>()
  const afterSeen = new Set<number>()
  let changedCells = 0
  for (let i = 0; i < before.length; i++) {
    beforeCounts.set(before[i], (beforeCounts.get(before[i]) ?? 0) + 1)
    afterSeen.add(after[i])
    if (before[i] !== after[i]) changedCells++
  }
  const removed: CleanupReport['removedColors'] = []
  for (const [index, cells] of beforeCounts) {
    if (afterSeen.has(index)) continue
    removed.push({ index, hex: palette[index] ?? '#??????', cells })
  }
  // 稳定排序：先按消失格数降序（损失最大的先看到），同格数按索引升序，保证同一输入产出同一份报告
  removed.sort((a, b) => b.cells - a.cells || a.index - b.index)
  const truncated = removed.length > MAX_REPORTED
  return { changedCells, removedColors: removed.slice(0, MAX_REPORTED), truncated }
}

/** 像素化主管线：原始像素 → PixelArt */
export function runPipeline(src: SourceImage, params: ConvertParams): RunPipelineResult {
  const crop = computeCropRect(src.width, src.height, params.cropRatio)
  const { w, h } = computeGridSize(crop.sw, crop.sh, params)
  const { data, alpha } = sampleGrid(src, crop, w, h, params)

  preprocess(data, params.brightness, params.contrast, params.saturation)

  const palette = resolvePalette(data, alpha, params)
  // 如实报告色板来源：custom 模式但色板为空时会退回自动取色（resolvePalette 的兜底），
  // 此时必须报 'auto'——否则日志与 --json 会声称用了自定义色板，排查时被误导。
  const paletteSource: RunPipelineResult['paletteSource'] =
    params.paletteMode === 'preset'
      ? 'preset'
      : params.paletteMode === 'custom' && params.customPalette.length > 0
        ? 'custom'
        : 'auto'

  // 抖动与清理互斥：以抖动为准（用户显式开了抖动，说明要那个纹理）
  const effective: ConvertParams = params.dither !== 'none' ? { ...params, cleanup: false } : params

  const { indices, overflow } = quantize(data, w, h, palette, effective, alpha)
  const willClean = effective.cleanup && effective.cleanupMinSize > 1
  const finalIndices = willClean ? cleanup(indices, w, h, effective.cleanupMinSize, alpha) : indices

  return {
    art: {
      width: w,
      height: h,
      indices: finalIndices,
      palette: palette.map((c) => c.toLowerCase()),
      alphaMask: alpha && alpha.some((v) => v < ALPHA_THRESHOLD) ? alpha : null,
    },
    overflow,
    paletteSource,
    cleanup: willClean ? measureCleanup(indices, finalIndices, palette) : null,
  }
}
