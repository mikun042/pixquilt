#!/usr/bin/env node
/**
 * artc —— 像素画批处理 CLI（agent 的主要入口）
 *
 * 设计目标（见 docs/DEVELOPMENT.md §4.1 的 L2）：**agent 不需要浏览器就能产出像素图**。
 * 本工具直接 import `src/core/*`（Node 22.6+ 的类型剥离），因此：
 *   - 不起浏览器、不走 CDP、不做 base64 往返；
 *   - 与页内 UI 走**同一份算法实现**，不会出现两套逻辑漂移。
 *
 * 用法：
 *   node tool/artc.mjs --in <目录或文件> --out <目录> [选项]
 *   node tool/artc.mjs --blank 58x58 --palette beads16 --bead --out out
 *   node tool/artc.mjs --selftest
 *   node tool/artc.mjs --describe
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { inflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

import { runPipeline } from '../src/core/pipeline.ts'
import { applyOps, blankArt } from '../src/core/ops.ts'
import { DEFAULT_PARAMS, coerceParams, normalizeHex, sanitizeParams, STYLE_PRESETS } from '../src/core/types.ts'
import { PRESETS, getPreset, isPresetId, parseHexPalette, serializeHexPalette } from '../src/core/palettes.ts'
import { artHash, encodePixBin, layoutSheet, parseProjectFile, pixelJSONString } from '../src/core/export.ts'
import { ENGINE_EXT, ENGINE_FORMATS, exportSheetMeta, isEngineFormat } from '../src/core/sheetmeta.ts'
import { beadListCsv, beadReport, beadSvg } from '../src/core/bead.ts'
import { beadPdfNode } from '../src/io/node-pdf.ts'
import { countTransparent, countUsage } from '../src/core/stats.ts'
import { describeAll, OP_SPECS } from '../src/core/spec.ts'
import { decodePngNode } from '../src/io/node-png.ts'
import { artToPngBytesNode } from '../src/io/node-export.ts'
import { sliceAuto, sliceByGrid } from '../src/core/slice.ts'
import { encodePngNode } from '../src/io/node-png.ts'
import { artToImageData } from '../src/core/raster.ts'
import { canDecodeInNode, isImagePath, loadImageNode, UnsupportedImageError } from '../src/io/node-image.ts'
import { decodeOneToPng, needsBrowserDecode } from '../src/io/node-decode.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/* ------------------------------------------------------------------ 参数解析 */

/**
 * 布尔开关：出现即为 true。
 * 注意：**不要往这里加没有实现的 flag**——曾经有 `--keep-size` 只登记在此、没有任何消费点，
 * 用户传了既不生效也不报错（静默失效比报错更糟）。新增 flag 必须同时改 buildParams 与帮助文本。
 */
const BOOL_FLAGS = new Set([
  'help', 'selftest', 'describe', 'dry-run', 'json', 'bead', 'alpha', 'transparent',
  'sheet', 'pixbin', 'no-cleanup', 'quiet', 'lock-palette', 'blank-transparent', 'progress', 'pdf',
  // 浏览器通道解码：把 Node 不能直接解的格式（JPEG/WebP/GIF/BMP/AVIF/ICO/SVG）
  // 借无头浏览器原生解码器转成 PNG，再走同一条渲染链路。见 src/io/node-decode.ts
  'browser-decode',
])
/** 可选值开关：后面跟的值不以 -- 开头才算值（`--sheet` 与 `--sheet 4` 都合法） */
const OPTIONAL_VALUE_FLAGS = new Set(['sheet', 'bead'])
/** 取值型开关（后面必须跟一个值） */
const VALUE_FLAGS = new Set([
  'in', 'out', 'name', 'index', 'scale', 'ops', 'ops-file', 'blank', 'blank-color', 'long-edge', 'size',
  'dither', 'contrast', 'saturation', 'brightness', 'crop', 'downsample', 'palette-k',
  'palette', 'preset', 'style', 'matte', 'cleanup-min', 'bead-mm', 'bead-gram', 'board',
  'key-mode', 'key-tolerance', 'slice',
  // 图集元数据的多引擎导出（见 src/core/sheetmeta.ts）：--engine godot|unity|tiled
  'engine', 'texture-path', 'texture-guid', 'ppu', 'tile-size',
])
/** 允许出现的全部开关。新增 flag 必须同时改这里与帮助文本（见 BOOL_FLAGS 上方注释）。 */
export const KNOWN_FLAGS = new Set([...BOOL_FLAGS, ...OPTIONAL_VALUE_FLAGS, ...VALUE_FLAGS])

/** 简单的编辑距离，只用来给拼错的参数提建议 */
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return dp[a.length][b.length]
}

/**
 * 未知参数一律报错。
 *
 * 起因：曾经 `--exact 32x32` 被完全静默忽略——`--exact` 不是任何已实现的 flag，
 * 于是它进了 `args.exact`（没人读），`32x32` 落进位置参数 `_`（也没人读），
 * 命令"成功"退出但输出仍是默认 64×64。调用方（尤其是 agent）会拿这份产物当真，
 * 直到下游发现尺寸不对才回头怀疑引擎。**静默失效比报错更糟**，这里把它变成硬错误。
 */
export function assertKnownFlags(argv) {
  const unknown = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--') || a.length === 2) continue
    const key = a.slice(2)
    if (KNOWN_FLAGS.has(key)) continue
    // 该 flag 是否存在"吞掉下一个值"的副作用：a 之后的第一个非 -- 记号
    const next = argv[i + 1]
    const swallowed = next !== undefined && !next.startsWith('--') ? next : null
    unknown.push({ key, swallowed })
  }
  if (!unknown.length) return
  const lines = unknown.map(({ key, swallowed }) => {
    const near = [...KNOWN_FLAGS]
      .map((k) => ({ k, d: editDistance(key, k) }))
      .filter((x) => x.d <= 2 || x.k.startsWith(key) || key.startsWith(x.k))
      .sort((x, y) => x.d - y.d)
      .slice(0, 3)
      .map((x) => `--${x.k}`)
    const hint = near.length ? `，是否想写 ${near.join(' 或 ')}？` : ''
    const eaten = swallowed ? `（它还吞掉了后面的 "${swallowed}"，该值没有被任何参数使用）` : ''
    return `  --${key}${hint}${eaten}`
  })
  throw new Error(
    `未知参数：\n${lines.join('\n')}\n` +
      `可用参数见 --help。未知参数不会被忽略地"照常执行"——那会让产物与预期不符却看不出原因。`,
  )
}

export function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    const key = a.slice(2)
    if (OPTIONAL_VALUE_FLAGS.has(key)) {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next
        i++
      } else out[key] = true
      continue
    }
    if (BOOL_FLAGS.has(key)) {
      out[key] = true
      continue
    }
    const val = argv[++i]
    if (val === undefined) throw new Error(`参数 --${key} 缺少值`)
    out[key] = val
  }
  return out
}

/**
 * `--blank 58x58` / `--size 32x32`（也接受 58X58 / 58*58 / 58×58）。
 *
 * `flagName` 由调用方传入：同一个解析器被 `--blank` 与 `--size` 共用，而错误文案必须说用户
 * **实际写的那个开关**——原先写死 `--blank`，于是 `--size abc` 会被告知"--blank 需写成 宽x高"。
 */
export function parseBlankSpec(text, flagName = '--blank') {
  const m = String(text).match(/^(\d+)\s*[xX*×]\s*(\d+)$/)
  if (!m) throw new Error(`${flagName} 需写成 宽x高，例如 ${flagName} 58x58`)
  return { width: Number(m[1]), height: Number(m[2]) }
}

/**
 * `--slice` 的取值解析：
 *   auto              自动推断（按全透明行/列分隔）
 *   WxH               显式网格（列数 x 行数），要求能整除图尺寸
 *   WxHpx             每格像素尺寸（后缀 px 消歧义），据此算出列数/行数
 *
 * 为什么需要 `px` 后缀：`32x32` 既可能是"32 列 32 行"也可能是"每格 32 像素"。
 * 早先想靠"能否整除"自动判别，但两种解释常常同时成立（例如 1024 图上 32x32），
 * 猜错会把图切成完全错误的样子。所以**不给后缀就按格数**，要用像素就显式写 `32x32px`。
 */
export function parseSliceSpec(text, imgWidth, imgHeight) {
  const raw = String(text).trim()
  if (raw === 'auto') return { kind: 'auto' }
  const m = raw.match(/^(\d+)\s*[xX*×]\s*(\d+)\s*(px)?$/)
  if (!m) throw new Error(`--slice 需写成 auto | 列数x行数 | 每格像素 WxHpx，例如 --slice 4x2 或 --slice 32x32px；收到 "${text}"`)
  const a = Number(m[1])
  const b = Number(m[2])
  if (a < 1 || b < 1) throw new Error(`--slice 的两个数都必须是正整数，收到 "${text}"`)
  const div = (n, d, label) => {
    if (imgWidth % n !== 0) throw new Error(`--slice ${label}：图宽 ${imgWidth} 不能被 ${n} 整除`)
    if (imgHeight % d !== 0) throw new Error(`--slice ${label}：图高 ${imgHeight} 不能被 ${d} 整除`)
  }
  if (m[3]) {
    div(a, b, `每格 ${a}×${b} 像素`)
    return { kind: 'cell', cellWidth: a, cellHeight: b, columns: imgWidth / a, rows: imgHeight / b }
  }
  div(a, b, `${a} 列 × ${b} 行`)
  return { kind: 'grid', columns: a, rows: b }
}

export function collectInputs(dirOrFile) {
  const p = resolve(dirOrFile)
  const st = statSync(p)
  if (st.isFile()) return [p]
  const out = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (isImagePath(entry.name)) out.push(full)
    }
  }
  walk(p)
  return out.sort()
}

/* ------------------------------------------------------------------ 参数组装 */

/** 把 --palette 的取值解析成参数补丁：auto | 预置 id | *.hex | #aabbcc,... */
export function resolvePaletteFlag(value) {
  if (!value || value === 'auto') return { patch: { paletteMode: 'auto' } }
  if (isPresetId(value)) return { patch: { paletteMode: 'preset', presetPaletteId: value } }
  if (value.startsWith('#')) {
    const colors = value.split(',').map((s) => normalizeHex(s)).filter(Boolean)
    if (!colors.length) throw new Error(`--palette 里的颜色都不合法：${value}`)
    return { patch: { paletteMode: 'custom', customPalette: colors } }
  }
  // 当成 .hex 文件路径（既不是 auto / 预置 id / #颜色，就只剩这条路）
  const path = resolve(value)
  if (!existsSync(path)) {
    // 原先直接 readFileSync，报的是裸 ENOENT（`open '不存在'`）——agent 看不出这个开关接受什么。
    // 与 --preset 的措辞对齐：把可选值列出来。
    throw new Error(
      `未知色板：${value}——--palette 接受 auto / 预置 id（${PRESETS.map((x) => x.id).join(' / ')}）/ ` +
        `*.hex 文件路径 / #rrggbb[,#rrggbb…]；若要按路径加载，确认文件存在`,
    )
  }
  const text = readFileSync(path, 'utf8')
  const parsed = parseHexPalette(text)
  if (!parsed.colors.length) throw new Error(`色板文件里没有合法颜色：${value}（每行一个 #rrggbb，可带号色）`)
  // 号色**同时写进参数**（customPaletteCodes）：只塞进返回值的话，
  // 它活不过一次 `--dry-run`/项目文件往返，也没法被页内 API 或 UI 复用。
  return {
    patch: { paletteMode: 'custom', customPalette: parsed.colors, customPaletteCodes: parsed.codes },
    codes: parsed.codes,
    source: `文件 ${basename(path)}（${parsed.colors.length} 色）`,
  }
}

/**
 * 由命令行参数组装最终参数。
 * 基底永远是 `DEFAULT_PARAMS`（或 `--style` 预设），**与任何"当前状态"无关** —— 这是可复现的前提。
 */
export function buildParams(args) {
  let params = { ...DEFAULT_PARAMS }
  const notes = []

  if (args.style) {
    const preset = STYLE_PRESETS.find((s) => s.id === args.style)
    if (!preset) throw new Error(`未知风格预设：${args.style}（可选 ${STYLE_PRESETS.map((s) => s.id).join(' / ')}）`)
    params = { ...params, ...preset.params }
    notes.push(`风格预设 ${preset.id}`)
  }

  let codes
  if (args.palette) {
    const r = resolvePaletteFlag(String(args.palette))
    params = { ...params, ...r.patch }
    codes = r.codes
    notes.push(r.source ? `色板 ${r.source}` : `色板 ${args.palette}`)
  }

  /**
   * `--preset <id>` 单独使用时也应切到该预置卡。
   *
   * 原先它只在 `--palette preset` 的分支里被读取，单独写 `--preset beads16` 时
   * `paletteMode` 仍是 auto——用户以为选了色卡，实际还是自动取色（号色当然也取不到）。
   * 显式给了 `--palette` 时以 `--palette` 为准，不覆盖用户的明确选择。
   */
  if (args.preset !== undefined && !args.palette) {
    const id = String(args.preset)
    if (!isPresetId(id)) throw new Error(`未知预置色卡：${id}（可选 ${PRESETS.map((p) => p.id).join(' / ')}）`)
    params = { ...params, paletteMode: 'preset', presetPaletteId: id }
    notes.push(`色板 预置卡 ${id}`)
  }

  if (args['long-edge'] !== undefined) params.longEdge = Number(args['long-edge'])
  if (args.size !== undefined) {
    const spec = parseBlankSpec(args.size, '--size')
    params.exactWidth = spec.width
    params.exactHeight = spec.height
  }
  if (args.dither !== undefined) params.dither = String(args.dither)
  if (args.contrast !== undefined) params.contrast = Number(args.contrast)
  if (args.saturation !== undefined) params.saturation = Number(args.saturation)
  if (args.brightness !== undefined) params.brightness = Number(args.brightness)
  if (args.crop !== undefined) params.cropRatio = String(args.crop)
  if (args.downsample !== undefined) params.downsample = String(args.downsample)
  if (args['palette-k'] !== undefined) {
    params.paletteMode = 'auto'
    params.paletteK = Number(args['palette-k'])
  }
  if (args.alpha) params.transparent = 'alpha'
  if (args.transparent) params.transparent = 'key'
  if (args.matte !== undefined) params.matteColor = String(args.matte)
  if (args['key-mode'] !== undefined) {
    params.transparent = 'key'
    params.keyMode = String(args['key-mode'])
  }
  if (args['key-tolerance'] !== undefined) {
    params.transparent = 'key'
    params.keyTolerance = Number(args['key-tolerance'])
  }
  if (args['no-cleanup']) params.cleanup = false
  if (args['cleanup-min'] !== undefined) params.cleanupMinSize = Number(args['cleanup-min'])
  if (args['lock-palette']) params.lockPalette = true

  // 拼豆模式默认锁定色板：这是"图纸只能用我有的号色"的硬要求（--palette auto 时不锁，否则没有色板可用）
  if (args.bead && params.paletteMode !== 'auto') params.lockPalette = true

  const { params: clean, fixed } = sanitizeParams(params)

  /**
   * 号色（图纸/清单上的编号）来源。
   *
   * 预置色卡自带号色（beads16/beads24 都有），但必须**在这里显式取出**：
   * 预置卡的 `resolvePaletteFlag` 分支原先直接 return、不带 codes，
   * 于是 `--palette beads16 --bead` 出的清单里印的是自动编号 C1/C2…，
   * 预置卡的号色（B01/R01…）被丢掉了——图纸上"编号"与色卡的对应关系就断了。
   * 同时覆盖只用 `--preset beads16`（不带 --palette）的写法。
   */
  if (!codes) {
    const presetCodes =
      clean.paletteMode === 'preset' ? getPreset(clean.presetPaletteId)?.codes : undefined
    if (presetCodes) codes = presetCodes
  }

  return { params: clean, fixed, notes, codes }
}

export function parseOps(text, source) {
  if (!text) return []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`${source} 不是合法 JSON：${e.message}`)
  }
  if (!Array.isArray(parsed)) throw new Error(`${source} 必须是算子数组，例如 [{"op":"trim"}]`)
  const known = new Set(OP_SPECS.map((s) => s.op))
  for (const op of parsed) {
    if (!op || typeof op !== 'object' || typeof op.op !== 'string') throw new Error(`${source} 里有缺少 op 字段的算子`)
    if (!known.has(op.op)) throw new Error(`${source} 里有未知算子 ${op.op}（可用：${[...known].join(' / ')}）`)
  }
  return parsed
}

/**
 * `--ops @文件` / `--ops-file <文件>`：从文件读算子数组。
 *
 * 单独提供它的理由：agent 生成的算子数组动辄 13–16 KB（一个 64×64 精灵的逐格 setCells），
 * 走 `--ops '<json>'` 会把整份 JSON 塞进命令行——既容易撞 shell 长度上限，又要处理引号转义，
 * 而且报错时定位不到第几行。写进文件就没有这些问题。
 */
export function loadOps(args) {
  const fileArg = args['ops-file'] ?? (typeof args.ops === 'string' && args.ops.startsWith('@') ? args.ops.slice(1) : null)
  if (!fileArg) return args.ops ? parseOps(String(args.ops), '--ops') : []
  const path = resolve(String(fileArg))
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    throw new Error(`读不到算子文件：${path}（${e?.code ?? e?.message ?? e}）`)
  }
  return parseOps(text, path)
}

/** 命名模板：{name} {index} {w} {h} {scale}，支持 {index:02} 零填充 */
export function applyTemplate(tpl, vars) {
  return String(tpl).replace(/\{(\w+)(?::(\d+))?\}(?:)/g, (_, key, width) => {
    const v = vars[key]
    if (v === undefined) return `{${key}}`
    const s = String(v)
    return width ? s.padStart(Number(width), '0') : s
  })
}

/**
 * 产物名不许含未解析的 `{…}`。
 *
 * 起因：`--blank --name '{name}_{index:02}_{w}x{h}'` 曾产出 `{name}_{index_02}_{w}x{h}_01_8x8.png`——
 * `{name}` 的替换值本身就是一段含占位符的模板，而 `String.replace` 会在**同一遍扫描**里
 * 继续解析刚插入的 `{index:02}`，于是 `{` / `}` 被拆得七零八落（`{name}` 的 `{` 与 `{index:02}`
 * 的 `}` 配了对）。留下这种名字的文件既难读也难被下游脚本匹配，且不会报错。
 */
export function assertNoPlaceholders(base, template) {
  if (/\{[^}]*\}/.test(base)) {
    throw new Error(
      `命名模板解析后仍含占位符：${base}\n` +
        `模板「${template}」用到的占位符只有 {name} {index} {w} {h} {scale}（可写 {index:02} 补零）。`,
    )
  }
  return base
}

export function sanitizeName(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/[\s.]+$/, '').trim() || 'asset'
}

/* ------------------------------------------------------------------ 单张处理 */

/**
 * 导出图的真实统计：宽高与透明像素数**从导出缓冲上数**，而不是读模型的 alphaMask。
 *
 * 为什么必须这样：`transparent: 'key'` 的底色键控只在**导出这一步**生效
 * （core/raster.ts 的 keyed 判定），管线里根本不建 alphaMask。
 * 早先汇总里的 transparent 读的是 alphaMask，于是 key 模式下恒为 0，
 * 而屏幕上的产物明明有 60% 透明格——agent 按这个字段判断会得出"键控没生效"的错误结论
 * （实测被这条坑过一轮，见 docs/ARCHITECTURE.md §8.10 第 ⑦ 类）。
 */
/**
 * 把透明参数翻译成 core/raster 的 RasterOptions。
 * 集中一处的原因：renderOne / --blank / pngStats 三处都要用，各写一遍必然分叉。
 */
function keyOptions(params) {
  return {
    transparentBg: params.transparent === 'key',
    bgHex: params.matteColor,
    keyMode: params.keyMode,
    keyTolerance: params.keyTolerance,
  }
}

function pngStats(art, scale, pngOpts) {
  const img = artToImageData(art, scale, pngOpts)
  let transparentPixels = 0
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] === 0) transparentPixels++
  return { pngWidth: img.width, pngHeight: img.height, pngTransparent: transparentPixels }
}

function renderOne({ src, params, ops, scale, codes, beading, beadingOptions, wantSheet, wantPixbin, wantPdf, nameTemplate, index }) {
  const image = loadImageNode(src)
  const { art: rendered, overflow, paletteSource, cleanup } = runPipeline({ width: image.width, height: image.height, data: image.data }, params)
  const applied = ops.length ? applyOps(rendered, ops, { allowApproxColor: !params.lockPalette }) : { art: rendered, changes: [], applied: false }
  const art = applied.art

  // 键控三件套（bgHex / keyMode / keyTolerance）只有一个来源，避免导出与统计用了不同的口径
  const pngOpts = keyOptions(params)
  const png = artToPngBytesNode(art, scale, pngOpts)
  const vars = { name: basename(src, extname(src)), index, w: art.width, h: art.height, scale }
  const base = sanitizeName(assertNoPlaceholders(applyTemplate(nameTemplate, vars), nameTemplate))

  const result = {
    src,
    base,
    width: art.width,
    height: art.height,
    // 模型侧：格数与 alphaMask 透明格（与导出倍数无关）
    paletteSize: art.palette.length,
    paletteSource,
    overflow,
    cleanup,
    transparent: countTransparent(art.indices, art.alphaMask),
    // 产物侧：导出 PNG 的真实宽高与透明像素数（含 --scale 放大与 key 键控的影响）
    ...pngStats(art, scale, pngOpts),
    usage: countUsage(art.indices, art.palette, art.alphaMask),
    changes: applied.changes,
    hash: artHash(art),
    png,
    paletteHex: serializeHexPalette(art.palette, codes),
    pixelJSON: pixelJSONString(art, { codes }),
    art,
    sheet: null,
    pixbin: wantPixbin ? encodePixBin(art) : null,
    beadCsv: null,
    beadSvg: null,
    beadPdfBytes: null,
    beadSummary: null,
  }

  if (beading) {
    const opts = { codes, ...beadingOptions }
    result.beadCsv = beadListCsv(art, opts)
    result.beadSvg = beadSvg(art, { ...opts, title: `${vars.name} 拼豆图纸 ${art.width}×${art.height}` })
    // PDF 标题只能用 ASCII：标准 14 字体是 WinAnsi 编码，塞中文会变成 ???（见 core/pdf.ts）。
    // 文件名走 `${base}_拼豆图纸.pdf`，中文标题在那里保留。
    result.beadPdfBytes = wantPdf ? beadPdfNode(art, { ...opts, title: `Bead Pattern ${art.width}x${art.height}` }) : null
    const rep = beadReport(art, opts)
    result.beadSummary = {
      colorCount: rep.colorCount,
      totalBeads: rep.totalBeads,
      totalGrams: rep.totalGrams,
      totalBags: rep.totalBags,
      transparentCells: rep.transparentCells,
      boards: `${rep.board.columns}x${rep.board.rows}`,
      physicalMm: `${rep.physical.widthMm}x${rep.physical.heightMm}`,
    }
  }

  if (wantSheet) result.sheet = { width: art.width, height: art.height, name: base }
  return result
}

/* ------------------------------------------------------------------ 自检 */

/**
 * `--selftest`：不读任何外部素材，用进程内生成的合成数据把"引擎 → 算子 → 导出 → 拼豆"整条链路走一遍。
 * 每项断言都必须能因为一个真实缺陷而失败（见 docs/DEVELOPMENT.md §3.1：测试有效性看"故意改坏会不会红"）。
 */
async function selftest() {
  const checks = []
  const check = (name, fn) => {
    try {
      const detail = fn()
      checks.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) })
    } catch (err) {
      checks.push({ name, ok: false, detail: err?.message ?? String(err) })
    }
  }
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg)
  }
  const eq = (a, b, msg) => assert(a === b, `${msg}（期望 ${b}，实际 ${a}）`)

  /** 合成测试图：横向渐变 + 左侧半透明块 + 右下纯色块（覆盖取色、透明、区域平均三条路径） */
  const makeFixture = (w = 64, h = 48) => {
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4
        data[o] = Math.round((x / (w - 1)) * 255)
        data[o + 1] = Math.round((y / (h - 1)) * 255)
        data[o + 2] = 80
        data[o + 3] = 255
      }
    }
    for (let y = 8; y < 20; y++) for (let x = 4; x < 16; x++) data[(y * w + x) * 4 + 3] = 0
    for (let y = h - 12; y < h; y++) for (let x = w - 12; x < w; x++) {
      const o = (y * w + x) * 4
      data[o] = 200
      data[o + 1] = 30
      data[o + 2] = 30
    }
    return { width: w, height: h, data }
  }

  check('自描述：describe() 含版本/算子/参数/能力', () => {
    const d = describeAll()
    assert(typeof d.version === 'string' && d.version.length > 0, 'version 缺失')
    assert(Array.isArray(d.ops) && d.ops.length > 0, 'ops 缺失')
    assert(Array.isArray(d.params) && d.params.length > 0, 'params 缺失')
    assert(d.animation === false, 'animation 应为 false（本期不实现多帧）')
    assert(d.eyeDropper === false, 'eyeDropper 应为 false（刻意不实现）')
    return `${d.ops.length} 算子 / ${d.params.length} 参数`
  })

  check('参数校验：越界被夹紧并如实报告', () => {
    const r = sanitizeParams({ longEdge: 99999, dither: 'nope', paletteK: 999 })
    eq(r.params.longEdge, 2048, 'longEdge 应夹到上限')
    eq(r.params.dither, 'none', 'dither 应回退默认')
    eq(r.params.paletteK, 64, 'paletteK 应夹到上限')
    assert(r.fixed.length >= 3, `应报告至少 3 处修正，实际 ${r.fixed.length}`)
    return `${r.fixed.length} 处修正`
  })

  check('旧字段迁移：alpha(boolean) → transparent，flattenBg → matteColor', () => {
    const r = sanitizeParams({ alpha: true, flattenBg: '#123456' })
    eq(r.params.transparent, 'alpha', 'alpha=true 应迁移为 transparent=alpha')
    eq(r.params.matteColor, '#123456', 'flattenBg 应迁移为 matteColor')
    return 'v2 → v3 迁移正常'
  })

  check('管线：合成图 + 固定色板 → 所有格子都在色板内', () => {
    const preset = getPreset('beads16')
    const { params } = sanitizeParams({ paletteMode: 'preset', presetPaletteId: 'beads16', longEdge: 32, lockPalette: true })
    const { art } = runPipeline(makeFixture(), params)
    eq(art.width, 32, '长边应为 32')
    eq(art.height, 24, '短边应按比例推到 24')
    const allowed = new Set(preset.colors.map((c) => c.toLowerCase()))
    for (let i = 0; i < art.indices.length; i++) {
      const c = art.palette[art.indices[i]]
      assert(allowed.has(c), `第 ${i} 格的 ${c} 不在给定色板内（lockPalette 下不该新增颜色）`)
    }
    return `${art.width}×${art.height}，${art.palette.length} 色全部命中`
  })

  check('管线：确定性（同图同参两次 → artHash 一致）', () => {
    const { params } = sanitizeParams({ paletteMode: 'auto', paletteK: 12, longEdge: 24 })
    const a = runPipeline(makeFixture(), params).art
    const b = runPipeline(makeFixture(), params).art
    eq(artHash(a), artHash(b), '两次运行的画布指纹应一致')
    return `hash ${artHash(a)}`
  })

  check('管线：抖动开启时杂色清理被自动关闭（互斥约束）', () => {
    const { params } = sanitizeParams({ dither: 'floyd', cleanup: true, longEdge: 24, paletteMode: 'auto', paletteK: 8 })
    const { art } = runPipeline(makeFixture(), params)
    assert(art.indices.length === 24 * 18, '尺寸应符合预期')
    return '抖动 + cleanup=true 未报错，互斥由管线强制'
  })

  check('管线：真 alpha（transparent=alpha）产出透明格', () => {
    const { params } = sanitizeParams({ transparent: 'alpha', longEdge: 48, paletteMode: 'auto', paletteK: 8 })
    const { art } = runPipeline(makeFixture(), params)
    const n = countTransparent(art.indices, art.alphaMask)
    assert(n > 0, '透明块应产生透明格')
    assert(art.alphaMask !== null, 'alphaMask 应被建立')
    return `${n} 个透明格`
  })

  check('管线：不透明模式把透明区合成到 matteColor（不出现黑边）', () => {
    const { params } = sanitizeParams({ transparent: 'none', matteColor: '#ff00ff', longEdge: 48, paletteMode: 'custom', customPalette: ['#ff00ff'] })
    const { art } = runPipeline(makeFixture(), params)
    eq(art.palette[0], '#ff00ff', '唯一色应为合成色')
    eq(countTransparent(art.indices, art.alphaMask), 0, '不透明模式不应有透明格')
    return '合成色命中'
  })

  check('算子：rect/setAll/transform/trim 语义与 changed 判定', () => {
    const art = blankArt(8, 8, '#000000', true)
    const r1 = applyOps(art, [{ op: 'rect', x0: 2, y0: 2, x1: 5, y1: 5, color: '#ff0000' }])
    assert(r1.applied, '实心矩形应产生改动')
    eq(r1.changes[0].cells, 16, '4×4 矩形应为 16 格')
    eq(countTransparent(r1.art.indices, r1.art.alphaMask), 64 - 16, '矩形外应保持透明')
    const r2 = applyOps(r1.art, [{ op: 'trim' }])
    assert(r2.applied, 'trim 应裁掉透明边')
    eq(r2.art.width, 4, 'trim 后宽应为 4')
    eq(r2.art.height, 4, 'trim 后高应为 4')

    // 对称图形旋转 180° 理应"无变化"——这条断言本身就是对 changed 判定的回归防线
    const sym = applyOps(r2.art, [{ op: 'transform', kind: 'rotate180' }])
    assert(!sym.applied, '对称内容旋转 180° 不应报告改动')
    eq(sym.changes[0].changed, false, 'changed 应为 false')

    // 不对称内容必须报告改动，且 hash 真的变了
    const notch = applyOps(r2.art, [{ op: 'setCells', cells: [[0, 0]], color: '#00ff00' }])
    const rotated = applyOps(notch.art, [{ op: 'transform', kind: 'rotate180' }])
    assert(rotated.applied, '不对称内容旋转 180° 应报告改动')
    assert(artHash(rotated.art) !== artHash(notch.art), '旋转后画布指纹应变化')
    eq(rotated.changes[0].kind, 'rotate180', 'transform 应汇报 kind')

    // 90° 旋转交换宽高
    const tall = blankArt(3, 5, '#123456', false)
    const q = applyOps(tall, [{ op: 'transform', kind: 'rotate90' }])
    eq(q.art.width, 5, 'rotate90 后宽应为原高')
    eq(q.art.height, 3, 'rotate90 后高应为原宽')
    return `${r1.changes[0].cells} 格 → trim ${r2.art.width}×${r2.art.height} → rotate90 换宽高`
  })

  check('算子：只改 alpha 的编辑必须被记为 changed（回归防线）', () => {
    const art = blankArt(4, 4, '#ffffff', false)
    const r = applyOps(art, [{ op: 'setCells', cells: [[1, 1]], erase: true }])
    assert(r.applied, '挖洞必须算作改动（曾出现被静默丢弃的缺陷）')
    eq(r.changes[0].changed, true, 'changed 应为 true')
    eq(countTransparent(r.art.indices, r.art.alphaMask), 1, '应恰好 1 个透明格')
    return 'changed=true'
  })

  check('算子：未知算子必须报错而不是静默忽略', () => {
    let threw = false
    try {
      applyOps(blankArt(2, 2, '#000000', false), [{ op: 'nope' }])
    } catch {
      threw = true
    }
    assert(threw, '未知算子应抛错')
    return '已抛错'
  })

  check('算子：lockPalette 下色板满/色板外颜色会报错', () => {
    const art = blankArt(2, 2, '#000000', false)
    let threw = false
    try {
      applyOps(art, [{ op: 'rect', x0: 0, y0: 0, x1: 1, y1: 1, color: '#ffffff' }], { allowApproxColor: false, fallbackColor: undefined })
    } catch {
      threw = true
    }
    // 色板未满时允许新增颜色，因此这里应当**成功**（锁色板只影响"满了之后"与近似色退化）
    assert(!threw, '色板未满时新增颜色应被允许')
    return '未满时允许新增（符合设计）'
  })

  check('导出：PNG 编解码往返（像素逐位一致）', () => {
    const art = blankArt(5, 3, '#3366cc', false)
    const bytes = artToPngBytesNode(art, 3)
    const decoded = decodePngNode(bytes)
    eq(decoded.width, 15, '放大 3 倍后宽应为 15')
    eq(decoded.height, 9, '放大 3 倍后高应为 9')
    const o = (4 * 15 + 4) * 4
    eq(decoded.data[o], 0x33, 'R 分量应保持')
    eq(decoded.data[o + 1], 0x66, 'G 分量应保持')
    eq(decoded.data[o + 2], 0xcc, 'B 分量应保持')
    eq(decoded.data[o + 3], 255, 'A 分量应不透明')
    return `${bytes.length} 字节往返一致`
  })

  check('导出：透明底（单色键控）把背景色变透明', () => {
    const art = { width: 2, height: 2, indices: new Uint8Array([0, 0, 0, 0]), palette: ['#ffffff'], alphaMask: null }
    const keyed = decodePngNode(artToPngBytesNode(art, 1, { transparentBg: true, bgHex: '#ffffff' }))
    eq(keyed.data[3], 0, '键控后 alpha 应为 0')
    const kept = decodePngNode(artToPngBytesNode(art, 1, { transparentBg: false }))
    eq(kept.data[3], 255, '不键控时应保持不透明')
    return '键控生效'
  })

  // 下面这条是回归防线：汇总里的 transparent 读的是模型 alphaMask，而 key 模式
  // 只在导出时生效、管线里不建 mask，两者会不一致。pngStats 必须反映**产物**。
  check('汇总：key 模式的 pngTransparent 必须反映产物（而不是恒为 0 的模型 mask）', () => {
    const art = { width: 4, height: 4, indices: new Uint8Array(16), palette: ['#ffffff'], alphaMask: null }
    const modelSide = countTransparent(art.indices, art.alphaMask)
    eq(modelSide, 0, '前提：key 模式下模型侧透明格就是 0（这正是当年误判的来源）')
    const st = pngStats(art, 1, { transparentBg: true, bgHex: '#ffffff' })
    eq(st.pngTransparent, 16, 'key 后产物应全透明（16 像素）')
    const off = pngStats(art, 1, { transparentBg: false, bgHex: '#ffffff' })
    eq(off.pngTransparent, 0, '不键控时产物应无透明像素')
    return `模型侧 ${modelSide} vs 产物侧 ${st.pngTransparent}（已如实汇报）`
  })

  check('汇总：pngWidth/pngHeight 必须计入 --scale（而不是只报格数）', () => {
    const art = blankArt(5, 3, '#3366cc', false)
    eq(pngStats(art, 1, {}).pngWidth, 5, 'scale=1 时宽 = 格数')
    const x4 = pngStats(art, 4, {})
    eq(x4.pngWidth, 20, 'scale=4 时宽应为 20')
    eq(x4.pngHeight, 12, 'scale=4 时高应为 12')
    return '5×3 → 20×12'
  })

  check('汇总：--alpha 模式下 pngTransparent 与模型侧 transparent 一致', () => {
    // blankArt(..., transparent=true) 造的是**整幅透明**的底，必须先把要保留的格补成不透明，
    // 否则测的是"全透明画布"，模型侧会是 16 而不是 1。
    const art = blankArt(4, 4, '#000000', true)
    art.alphaMask.fill(255)
    art.alphaMask[0] = 0
    const modelSide = countTransparent(art.indices, art.alphaMask)
    const st = pngStats(art, 2, {})
    eq(modelSide, 1, '模型侧应有 1 个透明格')
    eq(st.pngTransparent, 4, 'scale=2 时产物应为 2×2=4 个透明像素')
    return `模型 1 格 → 产物 4 像素`
  })

  // 键控新选项的 CLI 侧接线：--key-mode / --key-tolerance 必须真的进 params 并被 keyOptions 透传
  check('算子：fit 把内容适配成精确尺寸，且 trim+fit 组合能定尺寸', () => {
    // 32×32 画布，中央 8×4 内容（周围全是透明边）
    const art = blankArt(32, 32, '#ffffff', true)
    for (let y = 14; y < 18; y++) for (let x = 12; x < 20; x++) art.alphaMask[y * 32 + x] = 255
    const onlyTrim = applyOps(art, [{ op: 'trim' }]).art
    eq(onlyTrim.width, 8, '前提：trim 只裁边，得到内容原始尺寸 8×4')
    eq(onlyTrim.height, 4, 'trim 后高应为 4')
    const fitted = applyOps(art, [{ op: 'trim' }, { op: 'fit', width: 16, height: 16, mode: 'contain' }]).art
    eq(fitted.width, 16, 'trim+fit 后宽应为目标 16')
    eq(fitted.height, 16, 'trim+fit 后高应为目标 16')
    const kept = countTransparent(fitted.indices, fitted.alphaMask)
    eq(kept, 16 * 16 - 16 * 8, 'contain 应等比成 16×8，上下各留 4 行透明')
    return `8×4 → trim → fit → 16×16（透明 ${kept} 格）`
  })

  check('CLI：--slice 解析三种写法，并对不可整除的网格报错', () => {
    eq(parseSliceSpec('auto', 64, 32).kind, 'auto', 'auto 应识别为自动推断')
    const g = parseSliceSpec('4x2', 64, 32)
    eq(g.kind, 'grid', '4x2 应识别为网格')
    eq(g.columns * g.rows, 8, '4×2 网格应有 8 格')
    const c = parseSliceSpec('16x16px', 64, 32)
    eq(c.kind, 'cell', '16x16px 应识别为每格像素')
    eq(c.columns, 4, '64/16 = 4 列')
    eq(c.rows, 2, '32/16 = 2 行')
    // 不可整除必须报错，而不是静默丢掉余下像素
    let threw = ''
    try { parseSliceSpec('4x3', 64, 32) } catch (e) { threw = e.message }
    assert(/不能被 3 整除/.test(threw), `不可整除应报错并指名，实际："${threw}"`)
    return 'auto / 4x2 / 16x16px 三种写法正确；4x3 被拒'
  })

  check('核心：切片按网格拆图，像素逐块对应', () => {
    // 4×2 的纯色块图（每块 2×2），切成 4 列 2 行
    const W = 8
    const H = 4
    const data = new Uint8ClampedArray(W * H * 4)
    const put = (x, y, rgb) => { const i = (y * W + x) * 4; data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255 }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, [x < 4 ? 255 : 0, y < 2 ? 255 : 0, 128])
    const pieces = sliceByGrid({ width: W, height: H, data }, 4, 2, { baseName: 'f' })
    eq(pieces.length, 8, '应切出 8 块')
    eq(pieces[0].image.width, 2, '每块宽 2')
    eq(pieces[0].image.height, 2, '每块高 2')
    eq(pieces[0].name, 'f_00', '首块命名应零填充')
    eq(pieces[7].name, 'f_07', '末块命名应零填充')
    // 第 0 块取自左上（红+绿），第 7 块取自右下（无红无绿）
    eq(pieces[0].image.data[0], 255, '第 0 块 R 应为 255')
    eq(pieces[0].image.data[1], 255, '第 0 块 G 应为 255')
    eq(pieces[7].image.data[0], 0, '第 7 块 R 应为 0')
    eq(pieces[7].image.data[1], 0, '第 7 块 G 应为 0')
    return '8 块，像素对应正确'
  })

  check('CLI：--key-mode / --key-tolerance 进入参数并被导出采用', () => {
    const a = buildParams({ 'key-mode': 'border' })
    eq(a.params.transparent, 'key', '给了 --key-mode 就应自动进入键控模式（否则选项静默失效）')
    eq(a.params.keyMode, 'border', 'keyMode 应传进参数')
    const b = buildParams({ 'key-tolerance': '3' })
    eq(b.params.transparent, 'key', '给了 --key-tolerance 也应自动进入键控模式')
    eq(b.params.keyTolerance, 3, 'keyTolerance 应为数字 3')
    const opts = keyOptions(a.params)
    eq(opts.keyMode, 'border', 'keyOptions 应把 keyMode 透传给 core/raster')
    return 'keyMode=border / keyTolerance=3 均已接线'
  })

  check('CLI：--key-mode border 保护主体内部同色高光（与 global 形成对照）', () => {
    // 白底 7×7，中央 3×3 深绿主体，主体**正中** 1 格白高光（与背景同色且被主体完全包围）
    const w = 7
    const indices = new Uint8Array(w * w)
    const palette = ['#ffffff', '#007800']
    for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) indices[y * w + x] = 1
    indices[3 * w + 3] = 0 // 正中高光：四周都被绿色包围，与背景不连通
    const art = { width: w, height: w, indices, palette, alphaMask: null }
    const g = pngStats(art, 1, { transparentBg: true, bgHex: '#ffffff', keyMode: 'global', keyTolerance: 0 })
    const b = pngStats(art, 1, { transparentBg: true, bgHex: '#ffffff', keyMode: 'border', keyTolerance: 0 })
    // 7×7=49 格：主体 9 格（含 1 格高光），背景 40 格
    eq(g.pngTransparent, 41, 'global 应键掉背景 40 格 + 主体内高光 1 格 = 41')
    eq(b.pngTransparent, 40, 'border 应只键掉背景 40 格，被围住的高光保留')
    eq(g.pngTransparent - b.pngTransparent, 1, '两种模式的差值必须恰好等于被保护的那 1 格高光')
    return `global ${g.pngTransparent} 格 vs border ${b.pngTransparent} 格（差的就是高光那 1 格）`
  })

  check('导出：pixbin 往返', () => {
    const art = blankArt(7, 4, '#123456', true)
    const bytes = encodePixBin(art)
    eq(bytes[0], 'P'.charCodeAt(0), '魔数应为 PIXB1')
    eq(bytes.length, 12 + 7 * 4 * 2, '长度应为头 + indices + alphaMask')
    return `${bytes.length} 字节`
  })

  check('导出：项目 JSON 严格校验（引用越界索引必须报错）', () => {
    const art = blankArt(2, 2, '#000000', false)
    const okJson = JSON.stringify({
      version: 3,
      savedAt: new Date().toISOString(),
      params: DEFAULT_PARAMS,
      width: 2,
      height: 2,
      palette: ['#000000'],
      indices: Buffer.from(new Uint8Array([0, 0, 0, 0])).toString('base64'),
    })
    const parsed = parseProjectFile(okJson)
    eq(parsed.art.width, 2, '应能解析合法项目')
    const badJson = okJson.replace(/indexes|indices/, 'indices').replace(/("indices":")[^"]+/, `$1${Buffer.from(new Uint8Array([5, 0, 0, 0])).toString('base64')}`)
    let threw = false
    try {
      parseProjectFile(badJson)
    } catch {
      threw = true
    }
    assert(threw, '越界色板索引应报错')
    return '合法可解析 / 越界被拒'
  })

  check('图集：等尺寸网格布局互不重叠', () => {
    const frames = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, width: 32, height: 32 }))
    const sheet = layoutSheet(frames, 3, 0)
    eq(sheet.columns, 3, '列数应为 3')
    eq(sheet.rows, 2, '行数应为 2')
    eq(sheet.width, 96, '宽度应为 3×32')
    const seen = new Set()
    for (const f of sheet.frames) {
      const key = `${f.x},${f.y}`
      assert(!seen.has(key), `帧 ${f.name} 与其它帧重叠于 ${key}`)
      seen.add(key)
    }
    return `${sheet.width}×${sheet.height} / ${sheet.frames.length} 帧`
  })

  check('拼豆：清单不变量（每色格数之和 + 透明格 == 总格数）', () => {
    const { params } = sanitizeParams({ paletteMode: 'preset', presetPaletteId: 'beads16', longEdge: 40, transparent: 'alpha', lockPalette: true })
    const { art } = runPipeline(makeFixture(), params)
    const rep = beadReport(art, { codes: getPreset('beads16').codes })
    const sum = rep.rows.reduce((n, r) => n + r.cells, 0)
    eq(sum + rep.transparentCells, art.width * art.height, '格数守恒')
    eq(rep.totalBeads, sum, '珠子数应等于格数（1 格 1 颗）')
    for (const r of rep.rows) assert(getPreset('beads16').codes.includes(r.code), `号色 ${r.code} 不在色卡内`)
    return `${rep.colorCount} 色 / ${rep.totalBeads} 颗 / ${rep.totalGrams} g`
  })

  check('拼豆：图纸 SVG 结构完整（含图例与板标注）', () => {
    const { params } = sanitizeParams({ paletteMode: 'preset', presetPaletteId: 'beads16', longEdge: 40, lockPalette: true })
    const { art } = runPipeline(makeFixture(), params)
    const svg = beadSvg(art, { codes: getPreset('beads16').codes, cellPx: 18 })
    assert(svg.startsWith('<svg'), 'SVG 应以 <svg 开头')
    assert(svg.trimEnd().endsWith('</svg>'), 'SVG 应闭合')
    assert(svg.includes('<text'), '应含文字（编号/图例）')
    assert(/板 1,1/.test(svg), '应含板编号标注')
    const rects = (svg.match(/<rect/g) ?? []).length
    assert(rects > 100, `矩形数量应覆盖整幅图纸，实际 ${rects}`)
    return `${svg.length} 字节 / ${rects} 个矩形`
  })

  check('拼豆：预置色卡的号色必须被用上（不是自动编号 C1/C2）', () => {
    // 回归防线：resolvePaletteFlag 对 .hex 会返回 codes，但预置卡分支曾经直接 return、不带 codes，
    // 于是 `--palette beads16 --bead` 的清单印出 C1/C2…，预置卡的 B01/G02… 被丢掉。
    const a = buildParams({ palette: 'beads16' })
    assert(a.codes && a.codes.length > 0, '通过 --palette beads16 应取到预置卡号色')
    assert(a.codes[0] === 'B01', `首个号色应为 B01，实际 ${a.codes[0]}`)
    // 只用 --preset（不带 --palette）时同样要能取到
    const b = buildParams({ preset: 'beads16' })
    assert(b.params.presetPaletteId === 'beads16' && b.codes && b.codes[0] === 'B01', '--preset beads16 也应取到号色')
    // 自动取色没有号色可言，不应伪造
    const c = buildParams({ palette: 'auto' })
    assert(!c.codes, 'auto 模式不应带号色')
    return `--palette beads16 → ${a.codes.slice(0, 3).join('/')}…`
  })

  check('拼豆：缺口清单 CSV 表头与合计行', () => {
    const { params } = sanitizeParams({ paletteMode: 'preset', presetPaletteId: 'beads16', longEdge: 40, lockPalette: true })
    const { art } = runPipeline(makeFixture(), params)
    const csv = beadListCsv(art, { codes: getPreset('beads16').codes })
    const lines = csv.trim().split('\n')
    assert(lines[0].startsWith('编号,颜色,格数'), '表头顺序应符合采购习惯')
    assert(lines.some((l) => l.startsWith('合计,')), '应含合计行')
    assert(lines.some((l) => l.startsWith('透明格,')), '应含透明格行')
    return `${lines.length} 行`
  })

  check('拼豆：可打印 PDF 结构合法且内容真的被压缩', () => {
    const { params } = sanitizeParams({ paletteMode: 'preset', presetPaletteId: 'beads16', longEdge: 40, lockPalette: true })
    const { art } = runPipeline(makeFixture(), params)
    const bytes = beadPdfNode(art, { codes: getPreset('beads16').codes })
    const text = Buffer.from(bytes).toString('latin1')
    assert(text.startsWith('%PDF-1.4'), 'PDF 头缺失')
    assert(text.trimEnd().endsWith('%%EOF'), 'PDF 尾缺失')
    // xref 的 startxref 必须指向 xref 表本身（手写 PDF 最常见的错处）
    const xrefIdx = text.search(/^xref$/m)
    const startxref = Number(/^startxref\r?\n(\d+)/m.exec(text)?.[1])
    eq(startxref, xrefIdx, 'startxref 应指向 xref 表')
    // 声明压缩的流必须真能解开——防"声称 FlateDecode 却写明文"
    const streamAt = text.search(/^stream$/m)
    assert(streamAt > 0, '没有内容流')
    const body = bytes.subarray(streamAt + 7, text.indexOf('\nendstream', streamAt))
    eq(body[0], 0x78, 'zlib 容器首字节应为 0x78')
    const inflated = inflateSync(Buffer.from(body))
    assert(inflated.includes('Tj'), '解压后应是绘制指令')
    return `${Math.round(bytes.length / 1024)} KB，解压 ${Math.round(inflated.length / 1024)} KB`
  })

  check('CLI：参数解析（布尔 / 可选值 / 缺值报错）', () => {
    const a = parseArgs(['--in', 'x', '--alpha', '--sheet', '4', '--json'])
    eq(a.in, 'x', '--in 应取值')
    eq(a.alpha, true, '--alpha 应为 true')
    eq(a.sheet, '4', '--sheet 4 应取值为 4')
    const b = parseArgs(['--sheet'])
    eq(b.sheet, true, '裸 --sheet 应为 true')
    let threw = false
    try {
      parseArgs(['--in'])
    } catch {
      threw = true
    }
    assert(threw, '缺值应报错')
    return '布尔/可选值/缺值三种情况正确'
  })

  check('CLI：命名模板支持 {name}{index:02}{w}{h}{scale}', () => {
    eq(applyTemplate('{name}_{w}x{h}_{scale}x', { name: 'hero', w: 32, h: 32, scale: 4 }), 'hero_32x32_4x', '基本占位符')
    eq(applyTemplate('{index:02}_{name}', { index: 7, name: 'a' }), '07_a', '零填充')
    return '模板正确'
  })

  check('CLI：--palette 三种取值形态', () => {
    eq(resolvePaletteFlag('gameboy').patch.presetPaletteId, 'gameboy', '预置 id')
    eq(resolvePaletteFlag('#112233,#445566').patch.customPalette.length, 2, '内联色表')
    eq(resolvePaletteFlag('auto').patch.paletteMode, 'auto', 'auto')
    return '预置 / 内联 / auto 均正确'
  })

  check('CLI：--blank 规格解析', () => {
    eq(parseBlankSpec('58x58').width, 58, '小写 x')
    eq(parseBlankSpec('32×32').height, 32, '全角 ×')
    let threw = false
    try {
      parseBlankSpec('abc')
    } catch {
      threw = true
    }
    assert(threw, '非法规格应报错')
    // 文案必须指认用户实际写的开关（原先写死 --blank，--size abc 也会被说成 --blank）
    let msg = ''
    try {
      parseBlankSpec('abc', '--size')
    } catch (err) {
      msg = err.message
    }
    assert(msg.includes('--size') && !msg.includes('--blank'), `--size 的报错不该提 --blank，实际：${msg}`)
    return '三种写法正确；报错文案跟随调用方的开关名'
  })

  check('IO：Node 端只承诺自己能解码的格式（不冒充支持 JPEG）', () => {
    eq(canDecodeInNode('a.png'), true, 'PNG 应可解码')
    eq(canDecodeInNode('a.jpg'), false, 'JPEG 应如实报告不可解码')
    return '能力边界如实声明'
  })

  /*
   * ↓↓↓ 以下为「工具问题记录」修复的回归防线。
   * 每条都必须能因为一个真实缺陷而失败——这正是它们存在的理由。
   */

  check('CLI：未知参数必须报错，不能静默忽略', () => {
    // 曾经 `--exact 32x32` 完全静默：它进了没人读的 args.exact，32x32 落进没人读的位置参数，
    // 命令"成功"退出但产物仍是默认尺寸。调用方会拿这份产物当真。
    let threw = false
    try {
      assertKnownFlags(['--in', 'a.png', '--exact', '32x32'])
    } catch (e) {
      threw = true
      assert(/--exact/.test(e.message), '错误信息要点出是哪个参数')
      assert(/32x32/.test(e.message), '要提示它吞掉了后面的值')
    }
    assert(threw, '未知参数 --exact 应报错')
    // 合法参数不能被误伤
    assertKnownFlags(['--in', 'a.png', '--size', '32x32', '--no-cleanup', '--sheet', '4'])
    return '未知参数报错且带纠正提示，合法参数不受影响'
  })

  check('CLI：帮助文本与参数允许集完全一致（两个方向）', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    // 用 lastIndexOf 而不是 indexOf：本断言自身的说明文字里也含 'function printHelp()'，
    // 取第一个会把区域截在自己的字符串里（真实踩过，表现为"帮助一个 flag 都没提到"）。
    const start = src.lastIndexOf('function printHelp()')
    const region = src.slice(start, src.indexOf('\n}\n', start))
    const mentioned = new Set([...region.matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1]))
    const missingInSet = [...mentioned].filter((k) => !KNOWN_FLAGS.has(k))
    const missingInHelp = [...KNOWN_FLAGS].filter((k) => !mentioned.has(k))
    assert(missingInSet.length === 0, `帮助提到但未实现：${missingInSet.join(', ')}`)
    assert(missingInHelp.length === 0, `已实现但帮助未提：${missingInHelp.join(', ')}`)
    return `${mentioned.size} 个 flag 双向一致`
  })

  /*
   * --browser-decode 的两条能力边界。
   *
   * 这条守的是**声明与实现一致**：`src/io/node-image.ts` 一直如实声明"Node 端只直接解码 PNG"，
   * 而 `--browser-decode` 是另一条通道（借浏览器原生解码器）。两者必须分得清——
   * 不能因为加了这条通道，就把 `canDecodeInNode('a.jpg')` 悄悄改成 true
   * （那会让"Node 端能力"这块招牌变成假话，而 mock 掉的能力最容易被下游误信）。
   */
  check('CLI：--browser-decode 只覆盖"浏览器能解"的格式，且不篡改 Node 端能力声明', () => {
    // Node 端的能力声明**不因新通道改变**：仍然只承诺 PNG
    eq(canDecodeInNode('a.png'), true, 'PNG 仍应可解码')
    eq(canDecodeInNode('a.jpg'), false, 'JPEG 在 Node 端仍不可直接解码（能力声明不能被新通道篡改）')
    // 但"需不需要走浏览器通道"要如实回答
    eq(needsBrowserDecode('a.jpg'), true, 'JPEG 应可由浏览器通道解码')
    eq(needsBrowserDecode('a.webp'), true, 'WebP 应可由浏览器通道解码')
    eq(needsBrowserDecode('a.gif'), true, 'GIF 应可由浏览器通道解码')
    eq(needsBrowserDecode('a.bmp'), true, 'BMP 应可由浏览器通道解码')
    eq(needsBrowserDecode('a.png'), false, 'PNG 不该走浏览器通道（没必要起浏览器）')
    eq(needsBrowserDecode('a.txt'), false, '非图片不该被当成可解码')
    return '4 种浏览器格式可解；Node 端仍只承诺 PNG'
  })

  /*
   * 性能基准脚本的存在性与自洽性。
   *
   * 为什么**不在这里跑基准**：绝对耗时随机器浮动，把它当断言会变成"在慢机器上永远红"的假警报。
   * 这里只守两件不会因机器而异的事：
   *  ① `tool/bench.mjs` 还在，且 package.json 里有 `npm run bench`（否则会像"文档提到但不存在
   *     的文件"那样静默腐坏——本项目已有 `tool/bench.mjs` 曾被 ARCHITECTURE 引用却不存在的前例）；
   *  ② 它**声明了自己的用法与取舍**（`--quick` 与"耗时不当断言"的说明），
   *     免得后来者把它当成"跑一次就能判定性能好坏"的测试。
   * 真正的性能结论由 `npm run bench` 自己断言（比值类，与机器无关）。
   */
  check('工程：性能基准脚本存在、已接线，且声明了"耗时不当断言"', () => {
    const benchPath = join(dirname(fileURLToPath(import.meta.url)), 'bench.mjs')
    assert(existsSync(benchPath), 'tool/bench.mjs 不见了——ARCHITECTURE「性能」一节的结论就没有可复现依据了')
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
    assert(pkg.scripts && pkg.scripts.bench, 'package.json 里没有 bench 脚本（npm run bench）')
    const src = readFileSync(benchPath, 'utf8')
    assert(/--quick/.test(src), 'bench.mjs 应支持 --quick（缩小规模，用于改动后随手跑）')
    assert(/不要\*\*把它当断言|不要\*\*把它当断言或写进文档|绝对耗时随机器浮动/.test(src), 'bench.mjs 应写明"绝对耗时不当断言"')
    return 'bench.mjs 存在、已接线、含 --quick 与免责说明'
  })

  check('工程：artc.mjs 被 import 时不得执行 main()（否则导入方会被 process.exit 带走）', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    assert(/const invokedDirectly =/.test(src), '缺少"直接执行"守卫')
    assert(/if \(invokedDirectly\)/.test(src), 'main() 未被守卫包裹')
    return '有直接执行守卫，可安全导入'
  })

  check('算子：--ops @文件 / --ops-file 读文件，路径错要报错', () => {
    const tmp = join(tmpdir(), `artc-ops-${process.pid}.json`)
    writeFileSync(tmp, '[{"op":"setAll","color":"#ff0000"}]', 'utf8')
    try {
      eq(loadOps({ 'ops-file': tmp }).length, 1, '--ops-file 应读到 1 条算子')
      eq(loadOps({ ops: `@${tmp}` }).length, 1, '--ops @file 简写应等价')
      eq(loadOps({}).length, 0, '不给算子时为空数组')
      let threw = false
      try {
        loadOps({ 'ops-file': join(tmpdir(), 'definitely-missing-artc.json') })
      } catch {
        threw = true
      }
      assert(threw, '算子文件不存在必须报错，不能当成"没有算子"继续跑')
    } finally {
      try {
        unlinkSync(tmp)
      } catch {
        /* 清理失败不影响断言结论 */
      }
    }
    return '文件读取 + 缺失报错均正确'
  })

  check('管线：cleanup 吃掉的颜色必须如实上报（像素画的 1px 细节最容易被吞）', () => {
    // 合成一张 32×32 图：一片实色 + 一个孤立像素。
    // cleanupMinSize=2 必然把孤立像素并入邻色，而它正是像素画里的高光/眼神。
    const w = 32
    const h = 32
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4
        const isolated = x === 20 && y === 20
        data[o] = isolated ? 255 : 30
        data[o + 1] = isolated ? 215 : 30
        data[o + 2] = isolated ? 0 : 30
        data[o + 3] = 255
      }
    }
    const base = { ...DEFAULT_PARAMS, paletteMode: 'auto', paletteK: 8, cleanup: true, cleanupMinSize: 2, longEdge: 32, exactWidth: 32, exactHeight: 32 }
    const withClean = runPipeline({ width: w, height: h, data }, coerceParams(base))
    assert(withClean.cleanup !== null, '启用 cleanup 时必须给出报告，不能是 null')
    assert(withClean.cleanup.changedCells > 0, '孤立像素应被清理改掉')
    assert(withClean.cleanup.removedColors.length > 0, '被整幅吃掉的颜色必须出现在报告里')

    const noClean = runPipeline({ width: w, height: h, data }, coerceParams({ ...base, cleanup: false }))
    eq(noClean.cleanup, null, '关闭 cleanup 时不应报"有清理动作"')
    // 报告的语义是"这些色在最终产物里一格都不剩"。cleanup 只改 indices 不动 palette，
    // 所以消失的颜色仍留在色板里，但在最终像素中引用数必须为 0——这比对比色板长度更贴近事实。
    for (const gone of withClean.cleanup.removedColors) {
      assert(withClean.art.palette[gone.index] === gone.hex, `报告里的 hex 与色板第 ${gone.index} 项不一致`)
      const stillUsed = withClean.art.indices.includes(gone.index)
      assert(!stillUsed, `被报为"整幅消失"的 ${gone.hex} 其实仍在最终像素里被引用`)
      assert(noClean.art.indices.includes(gone.index), `${gone.hex} 在关闭 cleanup 后应当仍在像素里`)
    }
    return `改掉 ${withClean.cleanup.changedCells} 格，消失 ${withClean.cleanup.removedColors.map((c) => c.hex).join('/')}`
  })

  const passed = checks.filter((c) => c.ok).length
  const failed = checks.length - passed
  for (const c of checks) {
    const mark = c.ok ? '✔' : '✘'
    console.log(` ${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  }
  console.log(`\n自检：${passed}/${checks.length} 通过${failed ? `，${failed} 项失败` : ''}`)
  return failed === 0
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const args = parseArgs(process.argv.slice(2))
  assertKnownFlags(process.argv.slice(2))
  /**
   * 进度输出统一出口。
   *
   * `--json` 时默认静默：stdout 必须只剩那一份 JSON（原先进度行与 JSON 混在 stdout，
   * 首字符是 ✔，JSON.parse / jq / ConvertFrom-Json 全部直接失败——而"给 agent 读"正是
   * 这个开关存在的唯一理由）。要同时看进度就加 --progress，它会把人类可读行写到 stderr，
   * 这样 `artc … --json --progress | jq` 依然成立。
   */
  const wantProgress = !args.quiet && (!args.json || !!args.progress)
  const progress = wantProgress ? console.error : () => {}

  if (args.help || (!args.in && !args.blank && !args.selftest && !args.describe)) {
    printHelp()
    process.exit(args.help ? 0 : 1)
  }

  if (args.describe) {
    console.log(JSON.stringify(describeAll(), null, 2))
    return
  }

  if (args.selftest) {
    const ok = await selftest()
    process.exit(ok ? 0 : 1)
  }

  const { params, fixed, notes, codes } = buildParams(args)
  const ops = loadOps(args)
  const scale = args.scale !== undefined ? Number(args.scale) : 1
  const nameTemplate = args.name ?? '{name}_{w}x{h}_{scale}x'
  const outDir = resolve(String(args.out ?? 'out'))
  const wantSheet = args.sheet !== undefined && args.sheet !== false
  const sheetCols = typeof args.sheet === 'string' ? Number(args.sheet) : 0

  const beadingOptions = {}
  if (args['bead-mm'] !== undefined) beadingOptions.beadMm = Number(args['bead-mm'])
  if (args['bead-gram'] !== undefined) beadingOptions.beadGram = Number(args['bead-gram'])
  if (args['board'] !== undefined) beadingOptions.boardCells = Number(args['board'])
  else if (typeof args.bead === 'string') beadingOptions.boardCells = Number(args.bead)

  if (wantProgress) {
    progress(`参数：长边 ${params.longEdge}${params.exactWidth ? `（精确 ${params.exactWidth}×${params.exactHeight}）` : ''} · 降采样 ${params.downsample} · 色板 ${params.paletteMode}${params.paletteMode === 'preset' ? `(${params.presetPaletteId})` : ''} · 抖动 ${params.dither} · 透明 ${params.transparent}`)
    if (notes.length) progress(`来源：${notes.join(' · ')}`)
    if (fixed.length) progress(`已修正 ${fixed.length} 处参数：${fixed.map((f) => `${f.key}(${String(f.from)}→${String(f.to)})`).join('、')}`)
  }

  if (args['dry-run']) {
    console.log(JSON.stringify({ params, ops, scale, nameTemplate, out: outDir, fixed }, null, 2))
    return
  }

  mkdirSync(outDir, { recursive: true })
  const results = []
  const failures = []
  /** 非本命中的素材（例如目录里混进的 .svg/.jpg）：既不算成功也不算失败，只报数量 */
  const skipped = []

  /** 空白画布模式：不读任何素材，纯程序化（拼豆图纸与资产原型常用） */
  if (args.blank) {
    const spec = parseBlankSpec(args.blank)
    // 空白画布没有素材名，所以 {name} 恒为 'blank'，而 --name 只当**模板**用。
    //
    // 不要把 --name 的值再喂回 {name}：那会形成自引用（{name} → '{name}_…'），
    // `String.replace` 虽然不会重扫替换结果，但结果里会残留字面占位符，
    // 于是产出 `{name}_{index_02}_{w}x{h}_01_8x8.png` 这种既难读也难被脚本匹配的文件名。
    // （--in 路径的 --name 是"素材名"，模板由 '{name}_{w}x{h}_{scale}x' 再拼；空白路径没有素材名，
    //   --name 自然就退化为纯模板。）
    const blankName = 'blank'
    const blankIndex = Number(args.index ?? 1)
    const art0 = blankArt(spec.width, spec.height, args['blank-color'] ?? '#ffffff', !!args['blank-transparent'])
    const r = ops.length ? applyOps(art0, ops, { allowApproxColor: !params.lockPalette }) : { art: art0, changes: [], applied: false }
    const art = r.art
    // index 用 blankIndex 而非写死 1：默认模板不含 index，但用户一旦用 --name '{name}_{index:02}'，
    // 写死 1 会让同批多张空白画布全部撞名覆盖。
    const blankVars = { name: blankName, index: blankIndex, w: art.width, h: art.height, scale }
    const base = sanitizeName(assertNoPlaceholders(applyTemplate(nameTemplate, blankVars), nameTemplate))
    const png = artToPngBytesNode(art, scale, keyOptions(params))
    writeFileSync(join(outDir, `${base}.png`), png)
    writeFileSync(join(outDir, `${base}.hex`), serializeHexPalette(art.palette, codes), 'utf8')
    writeFileSync(join(outDir, `${base}.json`), pixelJSONString(art, { codes }), 'utf8')
    if (args.pixbin) writeFileSync(join(outDir, `${base}.pixbin`), encodePixBin(art))
    const row = {
      file: `${base}.png`,
      width: art.width,
      height: art.height,
      paletteSize: art.palette.length,
      transparent: countTransparent(art.indices, art.alphaMask),
      ...pngStats(art, scale, keyOptions(params)),
      hash: artHash(art),
      changes: r.changes.length,
    }
    // 只有显式 --bead 才产出拼豆文件。原先这里写 `if (beadingOptions)`，而 beadingOptions 在
    // 上方恒为 {}（对象恒真），于是每次 --blank 都无条件多写一份 SVG+CSV——既不是用户要的产物，
    // 也会在批量空白资产里堆一堆没人看的图纸。
    if (args.bead) {
      const csv = beadListCsv(art, { codes, ...beadingOptions })
      const svg = beadSvg(art, { codes, ...beadingOptions, title: `${base} 拼豆图纸` })
      writeFileSync(join(outDir, `${base}_图纸.svg`), svg, 'utf8')
      writeFileSync(join(outDir, `${base}_缺口清单.csv`), csv, 'utf8')
      if (args.pdf) {
        writeFileSync(
          join(outDir, `${base}_拼豆图纸.pdf`),
          beadPdfNode(art, { codes, ...beadingOptions, title: `Bead Pattern ${art.width}x${art.height}` }),
        )
      }
      row.bead = beadReport(art, beadingOptions).totalBeads
    }
    results.push(row)
    progress(`✔ 空白画布 ${spec.width}×${spec.height} → ${base}.png${row.bead ? `（${row.bead} 颗）` : ''}`)
  }

  if (args.in) {
    const inputs = collectInputs(String(args.in))
    // collectInputs 按"是图片扩展名"收文件（含 .svg/.jpg/.webp），但 Node 端只有 PNG 解码器。
    // 不预筛的话，素材目录里混进一张参考图 .svg 就会让整批以 exit 1 结束——而失败清单指向的
    // 其实是一张本就不该被处理的文件。真正的 decode 失败（.png 损坏）才配得上非零退出。
    let decodable = []
    const browserDecodeQueue = []
    for (const f of inputs) {
      if (canDecodeInNode(f)) decodable.push(f)
      else if (args['browser-decode'] && needsBrowserDecode(f)) browserDecodeQueue.push(f)
      else {
        skipped.push({
          src: basename(f),
          reason: args['browser-decode']
            ? `浏览器通道也解不了这个格式（${extname(f) || '（无扩展名）'}），已跳过`
            : `Node 端只解码 PNG，已跳过 ${extname(f) || '（无扩展名）'}（加 --browser-decode 可借浏览器解码）`,
        })
      }
    }

    /*
     * --browser-decode：把浏览器能解、Node 不能解的格式先转成 PNG 落到临时目录，
     * 再并入 decodable 走**同一条**渲染链路（与 --slice 落临时文件的理由一致：
     * renderOne 的入口是文件路径，走文件才不会长出第二套渲染逻辑）。
     */
    let decodeTmp = null
    if (browserDecodeQueue.length) {
      const { startBrowser } = await import('./cdp.mjs')
      // browserPath 不用传：startBrowser 内部已经走 browserFromEnv()（--browser > PIXEL_BROWSER > 候选路径）
      const session = await startBrowser({ profilePrefix: 'artc-decode-' })
      decodeTmp = mkdtempSync(join(tmpdir(), 'artc-decode-'))
      try {
        await session.cdp.send('Runtime.enable')
        await session.cdp.send('Page.navigate', { url: 'about:blank' })
        for (const f of browserDecodeQueue) {
          try {
            const r = await decodeOneToPng(session, f, decodeTmp)
            decodable.push(r.dest)
            if (!args.quiet) progress(`⟳ 浏览器解码 ${basename(f)} → PNG（${r.width}×${r.height}）`)
          } catch (err) {
            // 单张失败不中断整批（与下面的渲染失败同一条约定）
            failures.push({ src: basename(f), reason: `浏览器解码失败：${err?.message ?? err}` })
          }
        }
      } finally {
        await session.close?.()
      }
      decodable = decodable.sort()
    }
    // --slice：把每张输入图先切成多张子图（写到临时文件），再走下面同一条渲染链路。
    // 之所以落临时文件而不是把内存图直接喂给 renderOne：renderOne 的入口是**文件路径**
    // （它内部要 loadImageNode、还要用 basename 生成 {name}），走文件能让切片与正常输入
    // 完全共用一条代码路径——否则切片会变成第二套渲染逻辑，迟早分叉。
    let sliceUnits = null
    if (args.slice) {
      sliceUnits = []
      const tmpRoot = mkdtempSync(join(tmpdir(), 'artc-slice-'))
      let pieceCount = 0
      for (const f of decodable) {
        const img = decodePngNode(new Uint8Array(readFileSync(f)))
        const spec = parseSliceSpec(String(args.slice), img.width, img.height)
        const base = basename(f, extname(f))
        const pieces = spec.kind === 'auto' ? sliceAuto(img, { baseName: base }) : sliceByGrid(img, spec.columns, spec.rows, { baseName: base })
        if (!pieces.length) throw new Error(`${basename(f)} 切片后没有任何子图`)
        for (const p of pieces) {
          const tmp = join(tmpRoot, `${p.name}.png`)
          writeFileSync(tmp, encodePngNode(p.image))
          sliceUnits.push(tmp)
        }
        pieceCount += pieces.length
      }
      if (!args.quiet) progress(`切片：${decodable.length} 张 → ${pieceCount} 张子图（--slice ${args.slice}）`)
    }
    const renderList = sliceUnits ?? decodable
    // 切片临时目录用完即清（放在 try/finally 之外也可以：下面每张各自 try/catch，
    // 不会带着异常跳过清理；这里在循环后统一删）。
    const sliceTmp = sliceUnits ? dirname(sliceUnits[0]) : null
    if (!renderList.length) {
      const exts = [...new Set(inputs.map((f) => extname(f).toLowerCase() || '（无扩展名）'))].join('、')
      // 目录里全是非 PNG 时，**直接把出路写进错误信息**：这是最常见的第一次使用失败
      // （AI 生图常给 .jpg/.webp），用户/agent 不该靠翻文档才知道有这个开关。
      const hint = args['browser-decode']
        ? '（已开 --browser-decode，但这些格式浏览器也解不了）'
        : '——这些格式可以加 --browser-decode 借浏览器解码'
      throw new Error(`输入目录里没有可处理的 PNG：${args.in}（发现 ${inputs.length} 个文件，扩展名 ${exts}）${hint}`)
    }
    for (let i = 0; i < renderList.length; i++) {
      const src = renderList[i]
      try {
        const r = renderOne({
          src,
          params,
          ops,
          scale,
          codes,
          beading: !!args.bead,
          beadingOptions,
          wantSheet,
          wantPixbin: !!args.pixbin,
          wantPdf: !!args.pdf,
          nameTemplate,
          index: i + 1,
        })
        writeFileSync(join(outDir, `${r.base}.png`), r.png)
        writeFileSync(join(outDir, `${r.base}.hex`), r.paletteHex, 'utf8')
        writeFileSync(join(outDir, `${r.base}.json`), r.pixelJSON, 'utf8')
        if (r.pixbin) writeFileSync(join(outDir, `${r.base}.pixbin`), r.pixbin)
        if (r.beadCsv && r.beadSvg) {
          writeFileSync(join(outDir, `${r.base}_缺口清单.csv`), r.beadCsv, 'utf8')
          writeFileSync(join(outDir, `${r.base}_图纸.svg`), r.beadSvg, 'utf8')
        }
        if (r.beadPdfBytes) writeFileSync(join(outDir, `${r.base}_拼豆图纸.pdf`), r.beadPdfBytes)
        results.push({
          file: `${r.base}.png`,
          src: basename(src),
          width: r.width,
          height: r.height,
          paletteSize: r.paletteSize,
          paletteSource: r.paletteSource,
          transparent: r.transparent,
          pngWidth: r.pngWidth,
          pngHeight: r.pngHeight,
          pngTransparent: r.pngTransparent,
          hash: r.hash,
          changes: r.changes.length,
          bead: r.beadSummary ?? undefined,
          cleanup: r.cleanup ?? undefined,
          _sheet: r.sheet,
        })
        // 进度行报**产物**的透明像素：key 模式下模型侧恒为 0，按它显示会少报
        // （实测一次键控出 60% 透明格，屏幕上却什么都没说）。
        if (!args.quiet) progress(`✔ ${basename(src)} → ${r.base}.png（${r.width}×${r.height}${r.pngWidth !== r.width ? ` → 导出 ${r.pngWidth}×${r.pngHeight}` : ''}，${r.paletteSize} 色${r.pngTransparent ? `，透明 ${r.pngTransparent} 像素` : ''}${r.beadSummary ? `，拼豆 ${r.beadSummary.totalBeads} 颗` : ''}）`)
        // 杂色清理吃掉了整幅消失的颜色时必须说出来。像素画资产里的"小连通块"常常正是
        // 故意画的 1px 细节（高光/眼神/描边断点），被静默并入邻色后只能靠对图才发现。
        if (r.cleanup && r.cleanup.removedColors.length) {
          const detail = r.cleanup.removedColors.map((c) => `${c.hex}(${c.cells}格)`).join('、')
          console.warn(
            `⚠ ${basename(src)}：杂色清理改掉 ${r.cleanup.changedCells} 格，${r.cleanup.removedColors.length}${r.cleanup.truncated ? '+' : ''} 种颜色整幅消失：${detail}` +
              `\n  若这些是刻意画的细节，请加 --no-cleanup（本张产物已按清理后写出）`,
          )
        }
      } catch (err) {
        // 单张失败不中断整批：agent 需要"跑一次 → 读失败清单 → 修素材 → 重跑"
        const reason = err instanceof UnsupportedImageError ? err.message : (err?.message ?? String(err))
        failures.push({ src: basename(src), reason })
        console.error(`✘ ${basename(src)}：${reason}`)
      }
    }
    // 切片/解码临时目录只服务于本轮渲染，渲染完即删（不清会像 CDP 的 profile 那样在系统 temp 里堆积）
    if (sliceTmp) rmSync(sliceTmp, { recursive: true, force: true })
    if (decodeTmp) rmSync(decodeTmp, { recursive: true, force: true })
  }

  // 图集坐标表对 --blank 与 --in 两条产出路径同样成立，因此放在两者之外：
  // 原先它嵌在 if (args.in) 里，导致 `--blank 32x32 --sheet` 静默不产出 _sheet.json。
  if (wantSheet && results.length) {
    const sheet = layoutSheet(results.map((r) => ({ name: r.file.replace(/\.png$/, ''), width: r.width, height: r.height })), sheetCols)
    writeFileSync(join(outDir, '_sheet.json'), JSON.stringify(sheet, null, 2), 'utf8')
    if (!args.quiet) progress(`✔ 图集坐标表 _sheet.json（${sheet.columns}×${sheet.rows}，${sheet.frames.length} 帧）`)

    /*
     * --engine：把同一份坐标翻译成引擎认识的格式（见 src/core/sheetmeta.ts）。
     *
     * 与 _sheet.json **并存**而不是替换：json 是"通用可读"的那份，引擎格式是"能直接吃"的那份，
     * 两者面向不同用法，没有谁替代谁。
     */
    if (args.engine !== undefined) {
      const fmt = String(args.engine)
      if (!isEngineFormat(fmt)) {
        throw new Error(`未知引擎格式：${fmt}（可选 ${ENGINE_FORMATS.join(' / ')}）`)
      }
      const tileSize = args['tile-size'] !== undefined ? parseBlankSpec(String(args['tile-size']), '--tile-size') : null
      const meta = exportSheetMeta(fmt, sheet, {
        // 贴图路径：默认用图集文件名，用户可用 --texture-path 覆盖成引擎里的实际路径
        texturePath: args['texture-path'] !== undefined ? String(args['texture-path']) : '_sheet.png',
        textureGuid: args['texture-guid'] !== undefined ? String(args['texture-guid']) : undefined,
        name: args.name !== undefined ? basename(String(args.name), extname(String(args.name))) : 'sheet',
        pixelsPerUnit: args.ppu !== undefined ? Number(args.ppu) : undefined,
        tileWidth: tileSize?.width,
        tileHeight: tileSize?.height,
      })
      const dest = join(outDir, `_sheet${ENGINE_EXT[fmt]}`)
      writeFileSync(dest, meta, 'utf8')
      if (!args.quiet) progress(`✔ ${fmt} 元数据 _sheet${ENGINE_EXT[fmt]}（${sheet.frames.length} 帧）`)
    }
  }

  const summary = {
    out: outDir,
    ok: results.length,
    failed: failures.length,
    skipped: skipped.length,
    params,
    results,
    failures,
    skippedFiles: skipped,
  }
  if (args.json) console.log(JSON.stringify(summary, null, 2))
  else {
    console.log(`\n处理完成：成功 ${results.length}，失败 ${failures.length}${skipped.length ? `，跳过 ${skipped.length}` : ''}`)
    if (failures.length) console.log('失败清单：' + failures.map((f) => `${f.src}（${f.reason}）`).join('；'))
    if (skipped.length) console.log('跳过清单：' + skipped.map((f) => `${f.src}（${f.reason}）`).join('；'))
  }
  process.exit(failures.length ? 1 : 0)
}

function printHelp() {
  const ops = OP_SPECS.map((s) => `      ${s.op}`).join('\n')
  console.log(`artc —— 像素画批处理 CLI（零浏览器依赖，agent 友好）

用法：
  node tool/artc.mjs --in <目录或文件> --out <目录> [选项]
  node tool/artc.mjs --blank 58x58 --bead --palette beads16 --out out
  node tool/artc.mjs --selftest          # 自检（无需任何素材）
  node tool/artc.mjs --describe          # 输出完整能力/算子/参数（JSON，给 agent 读）

输入输出：
  --in <路径>             输入目录（递归）或单张图片（Node 端仅支持 PNG）
  --out <目录>            输出目录（默认 out/）
  --name <模板>           命名模板，占位符 {name} {index} {w} {h} {scale}，支持 {index:02}
  --scale <n>             PNG 整数倍放大（默认 1，超限自动降档）
  --json                  以 JSON 打印汇总（含每张的 hash/尺寸/用量）
                          尺寸与透明有两套字段：width/height/transparent 是模型侧（格数、
                          alphaMask），pngWidth/pngHeight/pngTransparent 是产物侧（含 --scale
                          放大与 --transparent 键控）；判断产物请用 png* 那三个
  --dry-run               只打印解析后的参数，不处理任何图片
  --quiet                 少打印过程信息
  --progress              与 --json 同用时把进度行写到 stderr（保证 stdout 仍是纯 JSON）
  --help                  打印本帮助

空白画布（--blank，不读任何素材）：
  --blank <WxH>           建一张空画布，可继续用 --ops 作画
  --blank-color <#rrggbb> 空白填充色（默认 #ffffff）
  --blank-transparent     空白为透明（与 --palette/--size 无关，仅影响底）
  --index <n>             命名模板里 {index} 的取值（批量时用于区分同名产物）

转换参数（未给出的项用出厂默认，结果与"当前状态"无关，可复现）：
  --long-edge <n>         输出长边格数（8–2048，默认 64）
  --size <WxH>            强制精确尺寸（游戏资产用；覆盖 --long-edge）
  --downsample <m>        average | nearest
  --crop <r>              free | 1:1 | 4:3 | 16:9
  --palette <v>           auto | 预置 id | *.hex 文件 | #aabbcc,#112233
                          预置 id：${[...new Set([...describeAll().presets.map((p) => p.id)])].join(' / ')}
  --preset <id>           只指定预置色卡（等价于 --palette <预置 id>；带号色的卡会把号色写进
                          图纸/清单/.hex/像素 JSON，拼豆出图请用它）
  --palette-k <n>         自动取色颜色数（2–64）
  --style <id>            先套风格预设：${STYLE_PRESETS.map((s) => s.id).join(' / ')}
  --dither <m>            none | floyd | bayer
  --no-cleanup            关闭杂色清理
  --cleanup-min <n>       杂色清理阈值（1–10）
  --brightness/--contrast/--saturation <n>   预处理（-100..100）
  --alpha                 保留原图透明（真 alpha 通道）
  --transparent           背景色导出为透明（单色键控）
  --slice <规格>          把输入图**切成多张**（与 --sheet 方向相反：--sheet 拼图集、--slice 拆图集）
                          auto 按全透明行/列自动推断 | 列数x行数 | 每格像素 WxHpx
  --browser-decode        借无头浏览器原生解码器，把 Node 解不了的格式（JPEG/WebP/GIF/BMP/
                          AVIF/ICO/SVG）先转成 PNG 再处理。**需要本机有 Chrome/Edge/Chromium**；
                          不加这个开关时非 PNG 会被跳过并如实报告（不是静默忽略）
  --matte <#rrggbb>       合成/键控底色（默认 #ffffff）
  --key-mode <模式>       global（默认）全图同色都透明 | border 只键与四边连通的底色区域
                          （白底 + 主体内部有同色高光时必须用 border，否则高光会被挖穿）
  --key-tolerance <n>     键控颜色容差 0–255（三通道最大差，默认 0=精确同色）；
                          AI 生图的"白底"常是 254/255 噪声，需要 1–3 才能键掉
  --lock-palette          只允许使用给定色板（拼豆/资产批次）

导出与附加产物：
  --sheet [列数]          额外输出 _sheet.json 图集坐标表（帧等尺寸 + offsetX/offsetY）
  --engine <格式>         再输出一份引擎能直接吃的元数据：godot（.tres SpriteFrames）/ 
                          unity（.meta 的 spriteSheet 段，需 --texture-guid）/ tiled（.tsx）
  --texture-path <路径>   --engine 里引用的贴图路径（默认 _sheet.png）
  --texture-guid <guid>   Unity 格式必需：从你那份 .png.meta 里取
  --ppu <n>               Unity 的 pixelsPerUnit（默认取帧高）
  --tile-size <WxH>       Tiled 的瓦片尺寸（默认取帧尺寸）
  --pixbin                额外输出 .pixbin（二进制像素数据，大画布往返更快）
  --bead [每板格数]       拼豆模式：输出 *_图纸.svg 与 *_缺口清单.csv（默认每板 58 格）
  --pdf                   额外输出 *_拼豆图纸.pdf（A4 分页可打印；需同时用 --bead）
  --bead-mm <n>           单颗直径 mm（默认 5）  --bead-gram <n> 单颗重量 g（默认 0.08）
  --board <n>             每板格数（默认 58）

编辑算子（--ops '<json 数组>'，与页内 API 的 edit() 完全一致）：
${ops}
  --ops '<json>'          直接给出算子数组
  --ops @file.json        从文件读算子数组（也写作 --ops-file file.json）；
                          批量 setCells 动辄十几 KB，走文件可避开 shell 长度与引号转义

说明：
  · 颜色默认值：命令行路径允许省略 color（用默认主色 #1a1a1a）；**算子数组里建议显式给 color**，
    这样换工具或改默认色都不会影响结果。
  · 越界坐标静默裁剪；宽高超 2048 夹紧并在 JSON 汇总里给出实际尺寸。
  · 单张素材失败不会中断整批，结尾给出失败清单并以非零码退出。`)
}

/**
 * 只在**直接被当命令行跑**时执行 main()。
 *
 * 没有这个守卫时，任何 `import './artc.mjs'` 都会顺带跑一遍 main()：
 * 它读的是**导入方**的 process.argv，于是要么误处理参数、要么报错打印帮助并 process.exit(1)，
 * 把导入方一起终结（真实踩过：一个只读 KNOWN_FLAGS 的检查脚本被它整死）。
 * 顺带让本文件可被测试直接导入，不必 spawn 子进程。
 */
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`错误：${err?.message ?? err}`)
    process.exit(1)
  })
}
