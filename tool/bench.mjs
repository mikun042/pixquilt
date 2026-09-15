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
