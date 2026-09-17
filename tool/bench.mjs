#!/usr/bin/env node
/**
 * bench —— 性能基准（可复现、零依赖、不起浏览器）。
 *
 * ## 为什么要有它
 *
 * `ARCHITECTURE.md` §6 列了四条性能取舍（抽样取色、量化缓存、离屏画布缓存、pixbin 往返），
 * 但它们此前**只是文字断言**——没有可复现数字，也就无法判断"某次改动是不是把它变慢了"。
 * 这个脚本把每一条都变成一个可测量的场景，并**顺带验证该优化确实在起作用**
 * （不只是"跑得快"，而是"用对比证明快的来源是它"）。
 *
 * ## 三条设计约定
 *
 * 1. **不引入 benchmark 库**：手写"预热 + 多次取中位数"就够，运行期零依赖是硬约束。
 *    取**中位数**而不是平均：单次 GC 尖峰会把平均值拉偏，中位数对这类噪声稳健得多。
 * 2. **合成数据要确定性**（固定种子的线性同余）：否则"同图同参 → 同耗时"不成立，
 *    也没法和上一次的记录对比。噪声图用散列生成，保证每次跑的是同一张图。
 * 3. **同时报告"绝对耗时"与"对比结论"**：绝对耗时随机器浮动（所以不当断言），
 *    而"关缓存比开缓存慢 N 倍"这类**比值**才是优化是否生效的证据（所以可以当断言）。
 *
 * 用法：
 *   node tool/bench.mjs            # 跑全部场景
 *   node tool/bench.mjs --json     # 机器可读（stdout 纯 JSON，与 artc 的约定一致）
 *   node tool/bench.mjs --quick    # 缩小规模，用于快速回归（CI / 改动后随手跑）
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cleanup, medianCut, quantize, runPipeline } from '../src/core/pipeline.ts'
import { decodePixBin, encodePixBin, pixelJSONString } from '../src/core/export.ts'
import { DEFAULT_PARAMS } from '../src/core/types.ts'
import { getPreset } from '../src/core/palettes.ts'
import { applyOps } from '../src/core/ops.ts'
import { hexToRgb, rgbToHex, rgbToOklab } from '../src/core/color.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
void ROOT

const JSON_OUT = process.argv.includes('--json')
const QUICK = process.argv.includes('--quick')
const WARMUP = QUICK ? 1 : 2
const REPEAT = QUICK ? 3 : 5

/* ------------------------------------------------------------------ 计时与数据 */

/**
 * 跑 `fn` 多次取**中位数**（毫秒）。
 *
 * 为什么是中位数：单次 GC 或调度抖动会把平均值明显拉高，而我们要比较的是
 * "同一份实现改动前后"或"开/关某个优化"，中位数对这种噪声稳健得多。
 * 预热若干次是为了排除 JIT 未编译完成的第一轮（否则第一次跑的数字总是偏大）。
 */
function bench(label, fn) {
  for (let i = 0; i < WARMUP; i++) fn()
  const times = []
  for (let i = 0; i < REPEAT; i++) {
    const t0 = performance.now()
    fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const med = times[Math.floor(times.length / 2)]
  return med
}

/** 确定性伪随机（线性同余）：同一种子 → 同一张图，保证基准可复现 */
function makeRng(seed) {
  let s = seed >>> 0
  return () => {
    // Numerical Recipes LCG 常数；只用高位（低位随机性差）
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

/**
 * 合成一张"像照片"的 RGBA 图（平滑渐变 + 噪点）。
 *
 * 为什么不用纯噪声：纯噪声的相邻像素完全不相关，量化缓存的命中率会低到不真实；
 * 真实的照片/生图有大片相近色，缓存命中率才高。所以用"低频渐变 + 少量高频噪点"。
 */
function makePhoto(w, h, seed = 12345) {
  const rng = makeRng(seed)
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const base = (x / w) * 200 + (y / h) * 55
      data[o] = base + rng() * 18
      data[o + 1] = 255 - base * 0.6 + rng() * 18
      data[o + 2] = 128 + Math.sin(x / 7) * 60 + rng() * 18
      data[o + 3] = 255
    }
  }
  return { width: w, height: h, data }
}

/**
 * 合成一张"大片平色"的图（8 个色块区域）。
 *
 * 为什么需要它：本项目的主用途是**拼豆图纸与像素素材**，那些图有大量完全相同的颜色，
 * 量化缓存的命中率很高；而"照片式渐变"几乎每格都不同，缓存基本不命中。
 * 两种形态的性能特征完全相反，所以基准必须分别测——只测一种会得出片面结论。
 */
function makeFlat(w, h, seed = 7) {
  const rng = makeRng(seed)
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const c = (Math.floor(x / 32) + Math.floor(y / 32)) % 8
      data[o] = c * 30 + rng() * 3
      data[o + 1] = c * 20 + 40 + rng() * 3
      data[o + 2] = c * 10 + 80 + rng() * 3
      data[o + 3] = 255
    }
  }
  return { width: w, height: h, data }
}

/* ------------------------------------------------------------------ 场景 */

const rows = []
const assertions = []
const assert = (name, ok, detail) => assertions.push({ name, ok, detail })

const LARGE = QUICK ? 1024 : 2048
const MEDIUM = QUICK ? 512 : 1024

/* ① 像素化管线：不同尺寸下的整条链路 -------------------------------------- */
for (const [w, h] of [
  [64, 64],
  [256, 256],
  [MEDIUM, MEDIUM],
  [LARGE, LARGE],
]) {
  const img = makePhoto(w, h)
  const params = { ...DEFAULT_PARAMS, longEdge: Math.min(w, 2048), paletteK: 24 }
  const ms = bench(`pipeline ${w}×${h}`, () => {
    runPipeline(img, params)
  })
  rows.push({ name: `convert ${w}×${h} → ${Math.min(w, 2048)} 格`, ms, note: '裁剪→降采样→量化→清理' })
}

/* ② 取色抽样：>250k 格时抽样是否真的起作用 -------------------------------- */
{
  const big = makePhoto(LARGE, LARGE)
  const colors = []
  // 直接构造 >250k 的颜色数组（绕过管线，单测 medianCut 本身）
  const step = Math.ceil((big.width * big.height) / 400_000)
  for (let i = 0; i < big.width * big.height; i += step) {
    const o = i * 4
    colors.push({ r: big.data[o], g: big.data[o + 1], b: big.data[o + 2] })
  }
  const ms = bench('medianCut 400k 色 → 24', () => {
    medianCut(colors, 24)
  })
  rows.push({ name: `medianCut ${Math.round(colors.length / 1000)}k 色 → 24 色`, ms, note: 'MEDIAN_CUT_SAMPLE_LIMIT=250k 之上会抽样' })

  // 抽样是"统计性聚类"，所以样本更多不必然更慢太多；这里验证它的目的不是速度而是确定性
  const a = medianCut(colors, 24).join(',')
  const b = medianCut(colors, 24).join(',')
  assert('取色确定性：同输入 → 同色板（抽样用固定散列步长）', a === b, a === b ? '两次结果一致' : '两次结果不同！')
}

/* ②b 取色质量：OKLab 构造 vs sRGB 构造（本基准里唯一一条"两套算法互比"） ------
 *
 * 为什么要在基准里内联一份 sRGB 参考实现，而不是直接断言绝对误差：
 * 基准的既有范式全是"同一实现的两种配置比值"（缓存开/关、pixbin/JSON），与机器无关、可复现。
 * 但"medianCut 改成 OKLab 到底有没有变好"是个**跨实现**问题——改造之后旧实现已经不在代码里了，
 * 不内联基线就没有对照物，只能写绝对阈值，而绝对阈值既不可复现也说明不了"变好了"。
 * 所以这里把改造前的 sRGB 版本原样内联成基线。
 *
 * ## 实测结论（2026-09-16 本机，--quick。必须如实记下来，别写成"全面改善"）
 *
 * 各图型 × k 的平均 OKLab 误差比值（新/旧，越小越好）：
 *
 * | 图型 | k=8 | k=16 | k=32 |
 * |---|---|---|---|
 * | 照片式渐变 | 1.013 | 0.997 | 1.024 |
 * | 暗部密集+亮部稀疏 | **0.915** | **0.925** | **0.934** |
 * | 高饱和 | 1.013 | 0.883 | 0.915 |
 * | 平色块+噪点 | 1.000 | 0.970 | 1.042 |
 *
 * **池化比值 0.984**（Σ新 0.1409 / Σ旧 0.1432）。
 *
 * 诚实读法：**这是一次小幅度、非均匀的改善**——
 * · 目标场景（暗部密集）稳定好 6–9%，这正是本次改造的动机（sRGB 在暗部过采样）；
 * · 平滑渐变在个别 k 上反而差 1–2%，高饱和/平色块也各有波动；
 * · 池化后整体只有约 1.6% 的改善。
 *
 * 所以断言写成三条（目标场景 / 池化整体 / 已量化零失真），而**不是**一个漂亮的统一阈值——
 * 后者只能靠挑样本得到。若哪天要声称"大幅提升"，先来跑这段并看池化比值。
 */
{
  /** 改造前的 sRGB 版 medianCut（照抄 git 历史，**只用于对照**，不参与产品路径） */
  function medianCutSrgbReference(input, k) {
    const target = Math.max(1, Math.min(256, Math.round(k)))
    const work = input.slice()
    const boxes = [{ from: 0, to: work.length }]
    const range = (from, to, ch) => {
      let min = 255
      let max = 0
      for (let i = from; i < to; i++) {
        const v = work[i][ch]
        if (v < min) min = v
        if (v > max) max = v
      }
      return max - min
    }
    while (boxes.length < target) {
      let bestIdx = -1
      let bestRange = 1
      let bestCh = 'r'
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i]
        if (box.to - box.from < 2) continue
        for (const ch of ['r', 'g', 'b']) {
          const r = range(box.from, box.to, ch)
          if (r > bestRange) {
            bestRange = r
            bestIdx = i
            bestCh = ch
          }
        }
      }
      if (bestIdx < 0) break
      const box = boxes[bestIdx]
      const slice = work.slice(box.from, box.to)
      slice.sort((p, q) => p[bestCh] - q[bestCh])
      for (let i = 0; i < slice.length; i++) work[box.from + i] = slice[i]
      const mid = box.from + ((box.to - box.from) >> 1)
      boxes.splice(bestIdx, 1, { from: box.from, to: mid }, { from: mid, to: box.to })
    }
    const seen = new Set()
    const out = []
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
      const hex = rgbToHex(r / n, g / n, b / n)
      if (!seen.has(hex)) {
        seen.add(hex)
        out.push(hex)
      }
    }
    return out
  }

  /** 每个采样色到色板的**最小 OKLab 距离**的均值（越小越贴近原图的感知） */
  function meanOklabError(palette, samples) {
    const labs = palette.map((h) => {
      const c = hexToRgb(h)
      return rgbToOklab(c.r, c.g, c.b)
    })
    let sum = 0
    for (const s of samples) {
      const L = rgbToOklab(s.r, s.g, s.b)
      let best = Infinity
      for (const p of labs) {
        const dl = L.L - p.L
        const da = L.a - p.a
        const db = L.b - p.b
        const d = dl * dl + da * da + db * db
        if (d < best) best = d
      }
      sum += Math.sqrt(best)
    }
    return sum / samples.length
  }

  /** 大面积暗部 + 亮部稀疏：这是"OKLab 该赢"的目标场景（sRGB 在暗部过采样） */
  function makeDarkDetail(w, h) {
    const r = makeRng(7)
    const px = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (r() < 0.82) px.push({ r: 8 + (x % 9), g: 8 + (y % 8), b: 14 + (x % 7) })
        else px.push({ r: 200 + (x % 40), g: 190 + (y % 35), b: 170 + (y % 30) })
      }
    }
    return px
  }

  /** 高饱和双色系 */
  function makeSaturated(w, h) {
    const r = makeRng(99)
    const px = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        px.push(r() < 0.5 ? { r: 255, g: (x * 3) % 80, b: (y * 5) % 60 } : { r: (x * 7) % 50, g: 255, b: (y * 3) % 90 })
      }
    }
    return px
  }

  const sample = (px) => px.filter((_, i) => i % 7 === 0)
  /** 把基准既有的 `{width,height,data(RGBA)}` 图转成 RGB 像素数组 */
  const toPixels = (img) => {
    const out = []
    for (let i = 0; i < img.width * img.height; i++) {
      const o = i * 4
      out.push({ r: img.data[o], g: img.data[o + 1], b: img.data[o + 2] })
    }
    return out
  }
  const KS = [8, 16, 32]
  const byCase = new Map()
  /** 池化用：把每个组合的绝对误差都攒起来 */
  let sumNew = 0
  let sumOld = 0

  for (const [label, px] of [
    ['照片式渐变', toPixels(makePhoto(256, 256))],
    ['暗部密集+亮部稀疏', makeDarkDetail(256, 256)],
    ['高饱和', makeSaturated(256, 256)],
    ['平色块+噪点', toPixels(makeFlat(256, 256))],
  ]) {
    const s = sample(px)
    const perK = []
    for (const k of KS) {
      const newErr = meanOklabError(medianCut(s, k), s)
      const oldErr = meanOklabError(medianCutSrgbReference(s, k), s)
      perK.push(newErr / oldErr)
      sumNew += newErr
      sumOld += oldErr
    }
    byCase.set(label, perK)
  }

  const fmt = (arr) => arr.map((r) => r.toFixed(3)).join(' / ')
  const pooled = sumNew / sumOld

  /*
   * ① 目标场景必须**一致改善**：暗部密集的图在每个 k 上都要比旧实现更贴近原图。
   * 这条是这次改造的**动机本身**——任务书说的"该分开的暗部被合成一个色号"就指它。
   */
  {
    const dark = byCase.get('暗部密集+亮部稀疏')
    const worst = Math.max(...dark)
    assert(
      '取色质量：暗部密集的图在 OKLab 下一致优于 sRGB（本次改造的目标场景）',
      worst <= 0.95,
      `k=${KS.join('/')} 比值 ${fmt(dark)}（最差 ${worst.toFixed(3)}，期望全部 ≤0.95）`,
    )
  }

  /*
   * ② 整体不得劣化：**池化**比值（Σ新误差 / Σ旧误差）≤ 1.0。
   *
   * 为什么用池化而不是"各组合比值的平均"：后者会被**误差本身接近 0** 的组合主导——
   * 已量化的图两边误差都在 1e-3 量级（远小于一个 8 位色阶，感知上无从区分），
   * 那里 2.8 : 1 的比值在数值上成立，却对"哪个更像原图"毫无意义，
   * 一个这样的项就能把平均值从 0.95 抬到 1.07、把结论整个翻过来。
   * 池化按误差大小加权，天然不让近乎为零的项说话。**实测的绝对值也一并打出来**，便于判断。
   */
  {
    assert(
      '取色质量：整体平均感知误差不高于 sRGB 实现（按误差池化，越大越有话语权）',
      pooled <= 1.0,
      `池化比值 ${pooled.toFixed(3)}（Σ新 ${sumNew.toFixed(4)} / Σ旧 ${sumOld.toFixed(4)}）；逐项 ${[...byCase].map(([n, v]) => `${n} ${fmt(v)}`).join(' | ')}`,
    )
  }

  /*
   * ③ 已量化输入**零失真**：均匀重复的 8 色、k=8 时输出必须**精确**是那 8 个色。
   *
   * 这里刻意用**属性断言**而不是误差比值：该短路的契约就是"盒内同色 → 原样输出"，
   * 比值形式反而测不准（k 大于色数时盒子会跨色，两边都不精确，比的是噪声）。
   * 这条直接守住 `medianCut` 的 verbatim 短路——它防的是"像素画源图凭空多出 1/255 偏色"。
   */
  {
    const pal = ['#1a1a1a', '#7f7f7f', '#e6e6e6', '#c82828', '#28c83c', '#283cc8', '#dcc828', '#963cc8']
    const rgb = pal.map((h) => ({
      r: parseInt(h.slice(1, 3), 16),
      g: parseInt(h.slice(3, 5), 16),
      b: parseInt(h.slice(5, 7), 16),
    }))
    const colors = []
    for (let rep = 0; rep < 40; rep++) for (const c of rgb) colors.push(c)
    const out = medianCut(colors, pal.length)
    const exact = new Set(pal)
    const bad = out.filter((h) => !exact.has(h))
    assert(
      '取色质量：已量化输入零失真（盒内同色走 verbatim，不引入 OKLab 往返误差）',
      out.length === pal.length && bad.length === 0,
      `${pal.length} 色精确重复 → 输出 ${out.length} 色，非原始色 ${bad.length} 个${bad.length ? `（${bad.slice(0, 3).join(',')}）` : ''}`,
    )
  }
}

/* ③ 量化缓存：它的价值**强依赖图的类型**（这条是本基准最有价值的发现） -------- */
{
  const w = MEDIUM
  const h = MEDIUM
  const palette = getPreset('pico8').colors
  const base = { ...DEFAULT_PARAMS, paletteMode: 'preset', presetPaletteId: 'pico8' }

  /** 关缓存的做法：`quantize` 内部 `useCache = dither === 'none'`，所以 dither 非 none 必然逐格匹配 */
  const measure = (rgba) => ({
    withCache: bench('quantize 缓存开', () => {
      quantize(rgba, w, h, palette, { ...base, dither: 'none', cleanup: false }, null)
    }),
    noCache: bench('quantize 缓存关（bayer 路径）', () => {
      quantize(rgba, w, h, palette, { ...base, dither: 'bayer', ditherStrength: 0, cleanup: false }, null)
    }),
  })

  // 场景 A：大片平色（**真实像素画 / 拼豆图纸的形态**，也是本项目的主用途）
  const flat = makeFlat(w, h)
  const A = measure(flat)
  rows.push({ name: `quantize ${w}²（平色图 · 缓存开）`, ms: A.withCache, note: '拼豆/像素画的典型形态' })
  rows.push({ name: `quantize ${w}²（平色图 · 逐格匹配）`, ms: A.noCache, note: '关缓存对照' })
  assert(
    '量化缓存在**平色图**上确实加速（拼豆/像素画的主用途）',
    A.noCache / A.withCache >= 1.5,
    `缓存 ${A.withCache.toFixed(1)}ms vs 逐格 ${A.noCache.toFixed(1)}ms（快 ${(A.noCache / A.withCache).toFixed(2)}×）`,
  )

  /*
   * 场景 B：照片式渐变（**几乎每格颜色都不同** → 缓存命中率≈0，却仍要分配 288KB）。
   *
   * 这条断言刻意写成"**不显著变慢**"而不是"更快"：实测在这个场景下缓存与逐格匹配基本打平
   * （有时因分配开销反而略慢）。文档原先只说"量化使用缓存"、没说它的收益取决于图，
   * 于是容易让人以为它总是净赚。基准把这件事如实摆出来，也让将来"想给缓存加更多槽位"
   * 的人先看到分配成本。
   */
  const photo = makePhoto(w, h)
  const B = measure(photo)
  rows.push({ name: `quantize ${w}²（渐变图 · 缓存开）`, ms: B.withCache, note: '命中率≈0，仍付 288KB 分配' })
  rows.push({ name: `quantize ${w}²（渐变图 · 逐格匹配）`, ms: B.noCache, note: '关缓存对照' })
  assert(
    '量化缓存在**渐变图**上不至于显著变慢（收益取决于图，不是无条件加速）',
    B.withCache <= B.noCache * 1.6,
    `缓存 ${B.withCache.toFixed(1)}ms vs 逐格 ${B.noCache.toFixed(1)}ms（比值 ${(B.noCache / B.withCache).toFixed(2)}×）`,
  )
}

/* ④ 杂色清理：O(格数) 的连通域扫描 ---------------------------------------- */
{
  const w = MEDIUM
  const h = MEDIUM
  const n = w * h
  const idx = new Uint8Array(n)
  const rng = makeRng(999)
  for (let i = 0; i < n; i++) idx[i] = Math.floor(rng() * 8)
  const ms = bench('cleanup', () => {
    cleanup(idx, w, h, 2, null)
  })
  rows.push({ name: `cleanup ${w}×${h}（8 色噪点，minSize=2）`, ms, note: '最坏情况：连通块极小、遍历最多' })
}

/* ⑤ 算子链：声明式编辑的开销 ---------------------------------------------- */
{
  const art = { width: 256, height: 256, indices: new Uint8Array(256 * 256), palette: ['#000000', '#ff0000', '#00ff00', '#0000ff'] }
  const ops = [
    { op: 'setAll', color: '#ff0000' },
    { op: 'rect', x0: 10, y0: 10, x1: 100, y1: 100, color: '#00ff00', filled: true },
    { op: 'ellipse', x0: 40, y0: 40, x1: 180, y1: 180, color: '#0000ff', filled: false },
    { op: 'outline', color: '#000000' },
    { op: 'mirror', kind: 'h', color: '#ff0000' },
    { op: 'transform', kind: 'rotate90' },
    { op: 'trim' },
    { op: 'fit', width: 128, height: 128 },
  ]
  const ms = bench('ops 8 条链', () => {
    applyOps(art, ops, { allowApproxColor: true })
  })
  rows.push({ name: '8 条算子链（256² 画布）', ms, note: 'setAll/rect/ellipse/outline/mirror/rotate/trim/fit' })
}

/* ⑥ pixbin vs 项目 JSON：文档说"快一个量级" ------------------------------- */
{
  const w = QUICK ? 512 : 1024
  const h = w
  const art = {
    width: w,
    height: h,
    indices: new Uint8Array(w * h),
    palette: getPreset('pico8').colors,
    alphaMask: null,
  }
  const rng = makeRng(4242)
  for (let i = 0; i < art.indices.length; i++) art.indices[i] = Math.floor(rng() * art.palette.length)

  const tPix = bench('encodePixBin', () => {
    encodePixBin(art)
  })
  const tJson = bench('pixelJSONString', () => {
    pixelJSONString(art)
  })
  // 往返（含解码）也测一遍——文档说的是"大画布往返"
  const bin = encodePixBin(art)
  const tPixRound = bench('pixbin 往返', () => {
    decodePixBin(bin, art.palette)
  })
  const jsonText = pixelJSONString(art)
  rows.push({ name: `编码 pixbin（${w}²）`, ms: tPix, note: '12 字节头 + 索引' })
  rows.push({ name: `编码 像素 JSON（${w}²）`, ms: tJson, note: 'base64 + 字符串拼接' })
  rows.push({ name: `解码 pixbin（${w}²）`, ms: tPixRound, note: '回读路径' })
  const ratio = tJson / tPix
  assert(
    'pixbin 比 base64 项目 JSON 快（文档称"快一个量级"）',
    ratio >= 2,
    `JSON ${tJson.toFixed(1)}ms vs pixbin ${tPix.toFixed(1)}ms（快 ${ratio.toFixed(1)}×）`,
  )
  void jsonText
}

/* ------------------------------------------------------------------ 输出 */

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        quick: QUICK,
        repeat: REPEAT,
        warmup: WARMUP,
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        rows,
        assertions,
        // 绝对耗时随机器浮动，**不作为断言**；断言只针对"优化是否生效"这类比值关系
        failed: assertions.filter((a) => !a.ok).length,
      },
      null,
      2,
    ),
  )
} else {
  console.log(`\n性能基准（Node ${process.version} · ${process.platform}/${process.arch}${QUICK ? ' · --quick' : ''}）`)
  console.log(`预热 ${WARMUP} 次 / 取 ${REPEAT} 次中位数\n`)
  const pad = Math.max(...rows.map((r) => r.name.length))
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(pad)}  ${r.ms.toFixed(1).padStart(8)} ms   ${r.note}`)
  }
  console.log('\n优化是否生效（这些是断言，不是参考值）：')
  for (const a of assertions) console.log(`  ${a.ok ? '✔' : '✘'} ${a.name} — ${a.detail}`)
  const failed = assertions.filter((a) => !a.ok)
  console.log(
    failed.length === 0
      ? '\n✔ 全部性能结论成立'
      : `\n✘ ${failed.length} 条性能结论不成立——说明对应的优化没生效或被改坏了`,
  )
  console.log('\n注意：绝对耗时随机器浮动，**不要**把它当断言或写进文档；比值类结论才有意义。')
  if (failed.length) process.exit(1)
}
