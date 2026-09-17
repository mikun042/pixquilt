/**
 * 像素化管线：裁剪 → 降采样 → 预处理 → 色板确定 → 量化映射（含抖动）→ 杂色清理。
 *
 * 纯函数、无 DOM：既能被浏览器 UI 调用，也能被 Node CLI 直接调用（docs/开发.md §4.1 的 L3），
 * 这样"页内"与"批处理"走**同一份实现**，不会出现两套逻辑漂移。
 *
 * 四条不肯妥协的顺序约束（改这里之前先读 docs/架构.md §3）：
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
  oklabToRgb,
  rgbToHex,
  rgbToOklab,
  type Lab,
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

/**
 * 通道跨度。**在 OKLab 空间里量**（见 medianCut 的说明）。
 *
 * 初值必须是 `Infinity / -Infinity` 而不是 0–255 量纲的 `255 / 0`——
 * OKLab 的 L∈[0,1]、a/b 约 ±0.4，用 `min=255,max=0` 起手会让每个通道都算出负数跨度，
 * 于是"最大跨度通道"永远选不出来、盒子一次都切不动。
 */
function channelRange(colors: Pt[], from: number, to: number, ch: 'L' | 'a' | 'b'): number {
  let min = Infinity
  let max = -Infinity
  for (let i = from; i < to; i++) {
    const v = colors[i].lab[ch]
    if (v < min) min = v
    if (v > max) max = v
  }
  return max - min
}

/** 排序单位：**把原始 sRGB 与它的 OKLab 绑在一起**。
 *
 * 为什么不并排放两个数组（一个 Lab 用于排序、一个 Rgb 用于取原色）：
 * `work` 会被 `sort` **就地重排**，而平行数组不会跟着重排——那样按 `box.from` 去取
 * 原始颜色就会取到**另一个位置**的颜色。这个错很隐蔽：颜色看着仍是"合法的色板项"，
 * 只是不对应盒内内容；实测在"小色集重复排列"的输入上会让整幅图塌成 1 色。
 * 绑成一个对象就没有"两个数组必须同步重排"这个隐患了。
 */
interface Pt {
  lab: Lab
  src: Rgb
}

/**
 * Median Cut 取色：把像素集合装进盒子，反复按"跨度最大的通道"从中间切开，直到得到 K 个盒子。
 *
 * **全程在 OKLab 感知空间里做决策**（选盒 / 排序 / 代表色质心）。为什么必须这样：
 * 调色板构造正是"决定用户要用几个色号"的一步，而 sRGB 的体积与人眼感知严重不成比例
 * （绿色通道权重大、暗部过采样）——在该空间里切分会让"该分开的暗部被合成一个色号 /
 * 该合开的亮部占了好几个色号"，对拼豆就是直接的买豆成本。匹配阶段（`quantize`）一直用 OKLab，
 * 这里统一之后，**取色与映射首次处在同一个感知空间**。
 *
 * 两个刻意设计（保留，别当成优化对象）：
 *  - **抽样**：超过 MEDIAN_CUT_SAMPLE_LIMIT 格时按固定步长（乘法散列）抽样。切分是统计性聚类，
 *    几百万像素只会让盒内排序白白变慢；固定散列保证"同图同参 → 同色板"。
 *    抽样**按下标**进行，与本函数用的色彩空间无关。
 *  - **换轴而非排序**：每轮只按一个目标通道排序一次（O(n log n) 而非全通道扫描）。
 *
 * ⚠️ 改色彩空间时最容易踩的两个坑（都踩过，都有断言守着）：
 *  1. 下面循环里的"最小可切跨度"阈值必须跟着换量纲。它曾是按 0–255 写死的 `1`，
 *     而 OKLab 三个通道的跨度只有约 0.4–1.0——阈值不换会让"有内容的盒子"全被判成纯色，
 *     **整张图静默退化成 1 个色号**（不报错）。
 *  2. 排序会就地重排 `work`，所以**任何按位置回查原始数据的地方都必须与排序同步**
 *     （见 `Pt` 的说明）。
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
      // 乘法散列：0.618… 的整数近似，保证样本在整幅图上均匀散布。
      // 用 `Math.imul`（32 位乘法）而不是 `j * 2654435761`：后者在 j 超过约 2^53/2654435761 ≈ 3.39M
      // 之后会超出双精度整数精确表示范围（2048² = 4.19M 会命中），抽样分布随之退化。
      // imul 依然是确定性的，只是把乘法钉在 32 位内。
      if ((Math.imul(j, 2654435761) >>> 0) % step === 0) picked.push(colors[i])
      if (picked.length >= MEDIAN_CUT_SAMPLE_LIMIT) break
    }
    sample = picked.length > 0 ? picked : colors.slice(0, MEDIAN_CUT_SAMPLE_LIMIT)
  }

  // 抽样之后一次性转 OKLab：之后所有距离/排序都在感知空间里算
  const work: Pt[] = sample.map((c) => ({ lab: rgbToOklab(c.r, c.g, c.b), src: c }))
  const boxes: Box[] = [{ from: 0, to: work.length }]

  /*
   * 最小可切跨度。OKLab 量纲下取 1e-4：
   * L 满量程才 1，a/b 约 ±0.4，8 位色深下相邻色的感知差在 1e-3 量级——
   * 1e-4 已经小到"只挡住真正无内容的纯色盒"，同时不会像 `1` 那样把所有盒子都判成不可切。
   */
  const MIN_SPLITTABLE_RANGE = 1e-4

  while (boxes.length < target) {
    let bestIdx = -1
    let bestRange = MIN_SPLITTABLE_RANGE
    let bestCh: 'L' | 'a' | 'b' = 'L'
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]
      if (box.to - box.from < 2) continue
      for (const ch of ['L', 'a', 'b'] as const) {
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
    // 排序键是浮点了，但 `Array.prototype.sort` 自 ES2019 起保证稳定，
    // 且 work 来自确定性抽样，所以"同图同参 → 同色板"仍然成立
    slice.sort((p, q) => p.lab[bestCh] - q.lab[bestCh])
    for (let i = 0; i < slice.length; i++) work[box.from + i] = slice[i]

    const mid = box.from + ((box.to - box.from) >> 1)
    boxes.splice(bestIdx, 1, { from: box.from, to: mid }, { from: mid, to: box.to })
  }

  const out: string[] = []
  for (const box of boxes) {
    if (box.to <= box.from) continue
    /*
     * 盒内**全是同一个颜色**时直接用它，不走 OKLab 往返。
     *
     * 为什么必须留这条短路：`rgbToOklab → oklabToRgb` 有 ≤1/255 的取整误差，
     * 而"盒内同色"时 sRGB 算术平均**精确等于**该色。少了这条短路，
     * 对已经量化好的输入（像素画源图——**拼豆与像素素材的常见形态**）
     * 会凭空引入 1/255 的偏色。加了它之后这类输入与旧实现严格一致（误差 0），
     * 而暗部密集的图仍拿到 OKLab 的收益。
     */
    let same = true
    for (let i = box.from + 1; i < box.to; i++) {
      const p = work[i].lab
      const q = work[box.from].lab
      if (p.L !== q.L || p.a !== q.a || p.b !== q.b) {
        same = false
        break
      }
    }
    if (same) {
      const only = work[box.from].src
      out.push(rgbToHex(only.r, only.g, only.b))
      continue
    }
    // 代表色 = **盒内 OKLab 质心**再转回 sRGB。
    // 不用 sRGB 逐通道平均：那正是"暗部被过度合并"的来源——sRGB 的数值中位
    // 与感知中位不是一回事。`oklabToRgb` 内部已 clamp 到 0–255 并取整，无需再夹。
    let L = 0
    let a = 0
    let b = 0
    for (let i = box.from; i < box.to; i++) {
      L += work[i].lab.L
      a += work[i].lab.a
      b += work[i].lab.b
    }
    const n = box.to - box.from
    const rgb = oklabToRgb(L / n, a / n, b / n)
    out.push(rgbToHex(rgb.r, rgb.g, rgb.b))
  }
  return dedupePalette(out)
}

/**
 * 按参数确定工作色板（自动取色 / 预置色卡 / 自定义）。
 *
 * 返回 `note` 用于**如实报告兜底**：未知预置 id 会退回自动取色而不是报错
 * （一个坏 id 不该让整批任务失败），但必须说出来——否则调用方以为用的是那张预置卡。
 * `sanitizeParams` 只校验 `presetPaletteId` 是非空字符串、不校验 id 是否存在，
 * 所以 `setParams({ presetPaletteId: 'nope' })` 真的会走到这里。
 */
export function resolvePalette(
  data: Uint8ClampedArray,
  alpha: Uint8Array | null,
  params: ConvertParams,
): { palette: string[]; note: string | null } {
  if (params.paletteMode === 'preset') {
    const preset = getPreset(params.presetPaletteId)
    if (preset) {
      /*
       * **超限即报错，不静默截断。**
       *
       * 内建色卡由我们保证 ≤ PALETTE_MAX（单测 + selftest 双重自证），所以走到这里
       * 就说明是**数据错误**（有人加了一张超限的卡）——那必须当场炸出来：
       * 静默截断的后果是"图纸少了几十色而没人知道"，比直接失败糟得多。
       * 用户自己导入的超限色卡走 customPalette 分支，那条已在 sanitizeParams 里封顶并上报。
       */
      if (preset.colors.length > PALETTE_MAX) {
        throw new Error(
          `预置色卡 "${preset.id}" 有 ${preset.colors.length} 色，超过色板上限 ${PALETTE_MAX}——` +
            `该卡数据有问题（索引是 Uint8Array，超限会让颜色回绕出错误结果）`,
        )
      }
      return { palette: preset.colors.map((c) => c.toLowerCase()), note: null }
    }
    return { palette: [], note: `未知预置色卡 id "${params.presetPaletteId}"，已退回自动取色` }
  }
  if (params.paletteMode === 'custom' && params.customPalette.length > 0) {
    // customPalette 已由 sanitizeParams 封顶并上报截断，这里不再二次截断（避免两处口径不一致）
    return { palette: params.customPalette.map((c) => (normalizeHex(c) ?? '#000000')), note: null }
  }

  const colors: Rgb[] = []
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (alpha && alpha[p] === 0) continue // 透明格不参与取色
    colors.push({ r: data[i], g: data[i + 1], b: data[i + 2] })
  }
  return { palette: medianCut(colors, params.paletteK), note: null }
}

/** Bayer 4×4 有序抖动阈值矩阵（归一化到 -0.5..0.5 的偏移） */
const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
]

/**
 * Bayer 8×8 有序抖动阈值矩阵（值域 0..63）。
 *
 * 与 4×4 的差别不是"更大"而是**阈值层次多两级**（64 级 vs 16 级）：
 * 大面积渐变里 4×4 容易出现可见的阶梯带，8×8 把它磨得更细。
 * 代价是同色像素的分布更"碎"——拼豆用户如果只想要大色块，4×4 反而更省珠子。
 *
 * 值由标准递归构造得出（Bayer2 → 4Bayer2+1 的经典递推），不是手抄的魔数。
 */
const BAYER8 = (() => {
  const b2 = [
    [0, 2],
    [3, 1],
  ]
  const step = (m: number[][]): number[][] => {
    const n = m.length
    const out = Array.from({ length: n * 2 }, () => new Array<number>(n * 2).fill(0))
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        // 经典递推：四象限各放 4*m+偏移，偏移决定阈值递增的走位
        out[y][x] = 4 * m[y][x] + 0
        out[y][x + n] = 4 * m[y][x] + 2
        out[y + n][x] = 4 * m[y][x] + 3
        out[y + n][x + n] = 4 * m[y][x] + 1
      }
    }
    return out
  }
  return step(step(b2)) // 2 → 4 → 8
})()

/**
 * 按坐标取有序抖动的阈值偏移（已归一化到 -0.5..0.5 再乘 255）。
 * `size` 只能是 4 或 8，矩阵在编译期就定好了。
 */
function orderedThreshold(x: number, y: number, size: 4 | 8, strength: number): number {
  const m = size === 4 ? BAYER4 : BAYER8
  const max = size * size - 1
  return (m[y & (size - 1)][x & (size - 1)] / max - 0.5) * 255 * strength
}

/**
 * Atkinson 误差扩散的权值（x/y 偏移 → 比例）。
 *
 * 与 Floyd–Steinberg 的关键差别：**六个邻居各拿 1/8，总共只扩散 6/8 = 3/4**，
 * 剩下 1/4 误差**主动丢弃**。这正是它的性格来源——
 * 对比度保持得更好、色点更干净（不会像 F-S 那样把误差一路带到画面另一头），
 * 代价是高光与暗部细节会丢一些。在有限色板（拼豆）上常常比 F-S 更耐看。
 */
const ATKINSON_WEIGHTS: [number, number, number][] = [
  [1, 0, 1 / 8],
  [2, 0, 1 / 8],
  [-1, 1, 1 / 8],
  [0, 1, 1 / 8],
  [1, 1, 1 / 8],
  [0, 2, 1 / 8],
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
/**
 * 色号上限的实现：**两遍法**（第二遍才带上限）。
 *
 * ## 为什么不能一遍搞定（第一版两种做法都实测失败）
 *
 * 目标是"抖动后实际用到的色号 ≤ N"，但抖动是**在线**过程：每个像素的输入色取决于
 * 前面已经扩散过来的误差，而误差又取决于前面选了哪些色。于是：
 *
 * 1. **压制误差扩散**（超限就衰减扩散幅度）——实测色号反而**变多**（14 → 16）：
 *    扩散被压小后，早期像素各自量化到不同色号，色号更早、更密地出现。
 * 2. **在线的"只用已用色"贪心**（达上限后只在已用色里选，除非新色明显更近）——
 *    实测**不可靠且非单调**：上限 4→11 色、6→14 色、8→9 色、12→12 色。
 *    根因是"早期偶然引入的颜色"无法撤销：一次早早的误判会永久占掉一个名额，
 *    而后面真正需要的颜色被挤掉。
 *
 * ## 两遍法：先知道"该用哪 N 个色"，再带着这个约束量化
 *
 * - **第一遍**：正常跑一遍量化（含抖动），统计每个色号被用了多少格；
 *   取用量最大的 N 个作为**候选色板**（这就是"该用哪 N 个色"的依据，
 *   它来自真实用量而非在线误判，因此稳定）。
 * - **第二遍**：把调色板限制到那 N 个色重跑一次。此时色号数**天然 ≤ N**，
 *   因为可选项就只有 N 个——不需要任何启发式，约束是硬的。
 *
 * 代价是量化跑两遍（O(2n)），换来"上限一定守得住"与单调性（N 越小色号越少）。
 * 这个取舍值得：设了上限却守不住，比慢一点糟得多——用户会按"我只有 8 种豆子"去下单。
 *
 * 返回的 `colorCapReport` 如实报告：是否启用、请求几个、实际几个、有没有被换掉。
 */
function quantizeOnce(
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

      if (!isTransparent && (dither === 'bayer' || dither === 'bayer8')) {
        const t = orderedThreshold(x, y, dither === 'bayer' ? 4 : 8, strength)
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

      if (!isTransparent && (dither === 'floyd' || dither === 'atkinson') && strength > 0) {
        /*
         * 误差扩散：把量化误差按权值分给**尚未量化**的邻居。
         *
         * 两种模式的差别只在权值表：F-S 扩散 16/16（全量），Atkinson 只扩散 6/8 = 3/4
         * 并主动丢弃其余 1/4（见 ATKINSON_WEIGHTS 的说明）。共用同一段循环，
         * 避免"两份几乎一样的扩散代码"——那正是本项目反复避免的那种重复。
         *
         */
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
        if (dither === 'floyd') {
          spread(1, 0, 7 / 16)
          spread(-1, 1, 3 / 16)
          spread(0, 1, 5 / 16)
          spread(1, 1, 1 / 16)
        } else {
          for (const [dx, dy, f] of ATKINSON_WEIGHTS) spread(dx, dy, f)
        }
      }
    }
  }

  return { indices, overflow }
}

/**
 * 量化映射（对外入口）。抖动在这一步内完成（见文件头约束 2）。
 *
 * 不做色号上限时就是一遍 `quantizeOnce`；启用上限（`ditherMaxColors > 0` 且开了抖动）
 * 时走**两遍法**：先正常量化一遍看哪些色号真被用上，取用量最大的 N 个作候选色板，
 * 再带着这个缩小的色板重跑一遍。见文件头 `ditherMaxColors` 的说明。
 */
export function quantize(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  palette: string[],
  params: ConvertParams,
  alpha: Uint8Array | null,
): QuantizeResult {
  const cap = params.ditherMaxColors
  // `cap >= 2` 而不是 `> 0`：1 色时抖动毫无意义（全图同色），按"不限制"处理更安全
  const capEnabled = cap >= 2 && params.dither !== 'none'
  if (!capEnabled) return quantizeOnce(data, w, h, palette, params, alpha)

  /*
   * 第一遍：不限色号地量化，统计每个色号用了多少格。
   *
   * "用量最大的 N 个"这个判据来自**真实用量**，而不是在线贪心里的"先到先得"——
   * 后者实测不可靠（早期偶然引入的颜色占住名额无法撤销，上限 4→11 色、6→14 色）。
   */
  const first = quantizeOnce(data, w, h, palette, params, alpha)
  const usedCounts = new Uint32Array(palette.length)
  for (let i = 0; i < first.indices.length; i++) usedCounts[first.indices[i]]++

  const ranked: number[] = []
  for (let i = 0; i < palette.length; i++) if (usedCounts[i] > 0) ranked.push(i)
  // 并列时按下标升序——保证确定性（同图同参必须同结果）
  ranked.sort((a, b) => usedCounts[b] - usedCounts[a] || a - b)

  if (ranked.length <= cap) {
    // 本来就没超上限：直接用第一遍的结果，避免无意义地重跑
    return first
  }

  /*
   * 第二遍：只保留用量最大的 N 个色作候选，重跑。
   *
   * 这一遍的色号数**天然 ≤ N**（可选项就只有 N 个），约束是硬的——
   * 不需要任何启发式，也就不会出现"设了 8 却出 9 色"这种守不住的情况。
   * 代价是量化跑两遍（O(2n)）；这个取舍值得：用户会按"我只有 8 种豆子"去下单。
   */
  const keep = new Set(ranked.slice(0, cap))
  const cappedPalette = palette.filter((_, i) => keep.has(i))
  const second = quantizeOnce(data, w, h, cappedPalette, params, alpha)
  return { indices: second.indices, overflow: second.overflow }
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
  /**
   * 色板相关的**兜底说明**；正常情况下为 null。
   * 目前只有一种：`paletteMode: 'preset'` 但 id 不认识 → 已退回自动取色。
   * 存在的理由是"静默兜底 = 撒谎"：调用方从 `paletteSource` 只会看到 `'preset'`，
   * 不额外说一句它就以为那张色卡生效了。
   */
  paletteNote: string | null
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

  const resolved = resolvePalette(data, alpha, params)
  const palette = resolved.palette
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
    paletteNote: resolved.note,
    cleanup: willClean ? measureCleanup(indices, finalIndices, palette) : null,
  }
}
