#!/usr/bin/env node
/**
 * artc —— 像素画批处理 CLI（agent 的主要入口）
 *
 * 设计目标（见 docs/开发.md §4.1 的 L2）：**agent 不需要浏览器就能产出像素图**。
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
import { PALETTE_MAX } from '../src/core/limits.ts'
import { artHash, encodePixBin, layoutSheet, parseProjectFile, pixelJSONString } from '../src/core/export.ts'
import { ENGINE_EXT, ENGINE_FORMATS, exportSheetMeta, isEngineFormat } from '../src/core/sheetmeta.ts'
import { beadListCsv, beadReport, beadSvg } from '../src/core/bead.ts'
import { qualityReport, qualitySummary } from '../src/core/quality.ts'
import { autoTune, tuneSummary } from '../src/core/auto-tune.ts'
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
  'quality',
])
/** 可选值开关：后面跟的值不以 -- 开头才算值（`--sheet` 与 `--sheet 4` 都合法） */
const OPTIONAL_VALUE_FLAGS = new Set(['sheet', 'bead'])
/** 取值型开关（后面必须跟一个值） */
const VALUE_FLAGS = new Set([
  'in', 'out', 'name', 'index', 'scale', 'ops', 'ops-file', 'blank', 'blank-color', 'long-edge', 'size',
  'dither', 'dither-max-colors', 'auto-tune', 'contrast', 'saturation', 'brightness', 'crop', 'downsample', 'palette-k',
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

/**
 * 把预置卡 id 按**来源分组**排成一行，供报错文案与 `--help` 共用。
 *
 * 为什么不再用 `PRESETS.map(p => p.id).join(' / ')`：加入 13 张品牌卡之后是 19 个 id，
 * 一串逗号连缀既读不出结构、又会把报错信息刷满屏。按来源分组后，
 * 用户一眼能看出哪些是硬件色表、哪些是社区整理的品牌卡、哪些是自造近似色。
 */
function presetIdList() {
  const groups = [
    ['official', '官方'],
    ['community', '社区整理'],
    ['approximate', '近似'],
  ]
  return groups
    .map(([src, label]) => {
      const ids = PRESETS.filter((p) => p.source === src).map((p) => p.id)
      return ids.length ? `${label}（${ids.join(' ')}）` : ''
    })
    .filter(Boolean)
    .join('；')
}

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
      `未知色板：${value}——--palette 接受 auto / 预置 id / *.hex 文件路径 / #rrggbb[,#rrggbb…]。\n` +
        `  预置 id：${presetIdList()}\n` +
        `  若要按路径加载，确认文件存在`,
    )
  }
  const text = readFileSync(path, 'utf8')
  const parsed = parseHexPalette(text)
  if (!parsed.colors.length) throw new Error(`色板文件里没有合法颜色：${value}（每行一个 #rrggbb，可带号色）`)
  // 号色**同时写进参数**（customPaletteCodes）：只塞进返回值的话，
  // 它活不过一次 `--dry-run`/项目文件往返，也没法被页内 API 或 UI 复用。
  //
  // 截断与跳行必须**说出来**：`parseHexPalette` 一直算好了 truncated/skipped，
  // 但这里原先只读 colors/codes，于是 `--palette big.hex` 超过 256 色时静默丢色、
  // 非法行静默跳过——agent 会按文件里的色数做规划，最后拿到一张少了几十色的图纸。
  // 拼进 `source` 是最省的做法：它本来就会被打进进度输出与 `--json` 的结果里（不污染 stdout）。
  const notes = []
  if (parsed.truncated) notes.push(`超出 ${PALETTE_MAX} 的 ${parsed.truncated} 色已截断`)
  if (parsed.skipped) notes.push(`跳过 ${parsed.skipped} 行无法解析的内容`)
  return {
    patch: { paletteMode: 'custom', customPalette: parsed.colors, customPaletteCodes: parsed.codes },
    codes: parsed.codes,
    source: `文件 ${basename(path)}（${parsed.colors.length} 色${notes.length ? `；${notes.join('；')}` : ''}）`,
  }
}

/**
 * 由命令行参数组装最终参数。
 * 基底永远是 `DEFAULT_PARAMS`（或 `--style` 预设），**与任何"当前状态"无关** —— 这是可复现的前提。
 */
/**
 * 拼豆相关的数值开关 → `beadingOptions`（供 `beadReport` / 图纸 / 清单用）。
 *
 * 单独成函数是为了**可被自检直接调用**：这几个数**不走 `sanitizeParams`**
 * （它们是拼豆选项，不属于 `ConvertParams`），因此没有自动的 NaN/越界兜底。
 * 实测过的真实行为（修之前）：`--bead-gram abc` → 重量 `NaN g`、
 * `--board abc` → 分板数 `null`，而命令**照常成功退出**。
 * 那正是本项目最忌讳的"接受了但没生效"（`AGENTS.md` §5 第 1 条）。
 *
 * 放在 `buildParams` 旁边、`main` 之外，好处是自检能直接调它，
 * 而不必起子进程（`execFileSync` 的 stdout 在本机会漏到父进程，见 §6 第 6 条）。
 */
export function parseBeadingOptions(args) {
  const numFlag = (raw, flag) => {
    const v = Number(raw)
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${flag} 需要一个大于 0 的数值，收到：${raw}`)
    return v
  }
  const out = {}
  if (args['bead-mm'] !== undefined) out.beadMm = numFlag(args['bead-mm'], '--bead-mm')
  if (args['bead-gram'] !== undefined) out.beadGram = numFlag(args['bead-gram'], '--bead-gram')
  if (args['board'] !== undefined) out.boardCells = numFlag(args['board'], '--board')
  // `--bead` 既能当开关（true）也能带板规格（58x58 那类），所以只在它是字符串时取值
  else if (typeof args.bead === 'string') out.boardCells = numFlag(args.bead, '--bead')
  return out
}

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
    if (!isPresetId(id)) throw new Error(`未知预置色卡：${id}（可选：${presetIdList()}）`)
    params = { ...params, paletteMode: 'preset', presetPaletteId: id }
    notes.push(`色板 预置卡 ${id}`)
  }

  if (args['long-edge'] !== undefined) params.longEdge = Number(args['long-edge'])
  /*
   * `--auto-tune` 的数值校验**必须在这里**，不能只放在逐图循环里。
   *
   * 原先只在 `--in` 的循环内校验，于是 `--blank ... --auto-tune abc` 会**被静默忽略**——
   * 而 `--blank` 下确实没有素材可搜参，所以这个组合本身也是无效的。
   * 两件事一起处理：① 数值非法 → 立刻报错（不管走哪条路径）；
   * ② 用在 `--blank` 下 → 明确告知它不生效，而不是假装接受。
   */
  if (args['auto-tune'] !== undefined) {
    const maxColors = Number(args['auto-tune'])
    if (!Number.isFinite(maxColors) || maxColors < 2) {
      throw new Error(`--auto-tune 需要一个色号上限（≥2），收到：${args['auto-tune']}`)
    }
    if (args.blank) {
      throw new Error('--auto-tune 需要素材才能搜参，与 --blank 同用无效；请用 --in 指定素材')
    }
  }
  if (args.size !== undefined) {
    const spec = parseBlankSpec(args.size, '--size')
    params.exactWidth = spec.width
    params.exactHeight = spec.height
  }
  if (args.dither !== undefined) params.dither = String(args.dither)
  if (args['dither-max-colors'] !== undefined) params.ditherMaxColors = Number(args['dither-max-colors'])
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
 * （实测被这条坑过一轮，见 docs/架构.md §8.10 第 ⑦ 类）。
 */
/**
 * 把透明参数翻译成 core/raster 的 RasterOptions。
 * 集中一处的原因：renderOne / --blank / pngStats 三处都要用，各写一遍必然分叉。
 */
export function keyOptions(params) {
  return {
    transparentBg: params.transparent === 'key',
    bgHex: params.matteColor,
    keyMode: params.keyMode,
    keyTolerance: params.keyTolerance,
  }
}

export function pngStats(art, scale, pngOpts) {
  const img = artToImageData(art, scale, pngOpts)
  let transparentPixels = 0
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] === 0) transparentPixels++
  return { pngWidth: img.width, pngHeight: img.height, pngTransparent: transparentPixels }
}

/**
 * 质量报告：把"原图 ↔ 产物"的差距量化。
 *
 * 为什么要跑两遍管线：`ditherExtraColors`（抖动多用了几种色）需要"同参数关抖动"作对照。
 * 只在开了抖动时跑第二遍——关抖动时没有可比对象，硬跑一遍纯属浪费。
 * 第二遍用 `{...params, dither:"none"}`，其余参数完全一致，所以差值可以干净地归因到抖动上。
 */
function qualityFor(image, art, params) {
  let noDitherBaseline
  if (params.dither !== 'none') {
    const base = runPipeline(
      { width: image.width, height: image.height, data: image.data },
      { ...params, dither: 'none' },
    )
    noDitherBaseline = { usedColors: new Set([...base.art.indices]).size }
  }
  return qualityReport(
    { width: image.width, height: image.height, data: image.data },
    art,
    {
      paletteMode: params.paletteMode,
      presetPaletteId: params.presetPaletteId,
      transparent: params.transparent,
      customPaletteCodes: params.customPaletteCodes,
    },
    { noDitherBaseline },
  )
}

function renderOne({ src, params, ops, scale, codes, beading, beadingOptions, wantSheet, wantPixbin, wantPdf,
          wantQuality, nameTemplate, index }) {
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
    quality: wantQuality ? qualityFor(image, art, params) : null,
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
    // selftest 已拆到 ./selftest.mjs（它占过本文件 779 行）。动态 import：
    // 只有真跑 --selftest 时才加载那一大坨断言，不影响普通出图的启动开销。
    const { selftest } = await import('./selftest.mjs')
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

  const beadingOptions = parseBeadingOptions(args)

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
  /**
   * `--auto-tune` 的逐图决策记录（进 `--json` 的 `autoTune` 字段）。
   * 原先这些信息只写 stderr，机器读不到。
   */
  const tuneLog = []
  /**
   * **全局实际生效的参数**。`--auto-tune` 是逐图改写参数，所以严格说没有单一的"生效参数"；
   * 这里取最后一张的（单图批处理时就是它本身），逐图的准确值在 `results[].paramsEffective`。
   * 没有它的时候，`--json` 里只有用户请求值，agent 无从判断参数到底生效没有。
   */
  let paramsEffective = params

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
        /*
         * `--auto-tune <n>`：在"色号数 ≤ n"的约束下自动搜参。
         *
         * 放在**每张图各自的循环里**（而不是 buildParams 里）有两个理由：
         *  1. 搜索需要解码后的像素（`runPipeline` 的输入），buildParams 阶段还没有；
         *  2. "最优参数"是**逐图不同**的——一张平色图和一张照片该用不同档位，
         *     批量处理时这正是它比"手动调一套参数套所有图"强的地方。
         */
        let fileParams = params
        let tuneResult = null
        if (args['auto-tune'] !== undefined) {
          // 数值与适用性已在 buildParams 里校验过（那里对 --blank 也生效），此处直接用
          const maxColors = Number(args['auto-tune'])
          const img = loadImageNode(src)
          /*
           * 尺寸**不进搜索空间**（`autoTune` 的默认行为）：`--long-edge N` 就是要 N 格。
           *
           * 不这么做的后果实测过：`--long-edge 58 --auto-tune 14` 的产物是 24×18，
           * 而 `--json` 里 `params.longEdge` 还写着 58——参数被静默丢弃、报告回显输入值，
           * 正好撞在 AGENTS.md 那条"别把命令成功当成参数生效"上。拼豆用户按板数算好 58 格，
           * 拿到 24 格等于图白做了。
           *
           * 而"让工具自己挑尺寸"这条路本身也不成立：跨尺寸的两个候选指标
           * （块平均误差、色号数）都会随画布变小而变小，等于一致奖励"更糊"的方案。
           * 详见 `core/auto-tune.ts` 的 `DEFAULT_TUNE_SPACE` 注释。
           */
          tuneResult = autoTune(
            { width: img.width, height: img.height, data: img.data },
            params,
            { maxColors },
          )
          fileParams = tuneResult.best.params
          tuneLog.push({
            src: basename(src),
            feasible: tuneResult.feasible,
            evaluated: tuneResult.evaluated,
            best: {
              longEdge: tuneResult.best.params.longEdge,
              paletteK: tuneResult.best.params.paletteK,
              dither: tuneResult.best.params.dither,
              cleanup: tuneResult.best.params.cleanup,
              blockError: tuneResult.best.blockError,
              meanError: tuneResult.best.meanError,
              usedColors: tuneResult.best.usedColors,
              beads: tuneResult.best.beads,
            },
            top: tuneResult.top.map((c) => ({
              longEdge: c.params.longEdge,
              dither: c.params.dither,
              cleanup: c.params.cleanup,
              blockError: c.blockError,
              usedColors: c.usedColors,
              beads: c.beads,
            })),
          })
          if (!args.quiet) progress(`↻ ${basename(src)} 搜参：${tuneSummary(tuneResult)}`)
        }
        paramsEffective = fileParams
        const r = renderOne({
          src,
          params: fileParams,
          ops,
          scale,
          codes,
          beading: !!args.bead,
          beadingOptions,
          wantSheet,
          wantPixbin: !!args.pixbin,
          wantPdf: !!args.pdf,
          wantQuality: !!args.quality,
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
          // 质量报告只在 --quality 时产出；不加就如实为 undefined，不留一个"看着像有值"的空壳
          quality: r.quality ?? undefined,
          /*
           * **这张图实际生效的参数**。与顶层 `params`（用户请求值）可能不同——
           * `--auto-tune` 会逐图改写尺寸/抖动/清理。顶层那个是"你要什么"，
           * 这个是"实际用了什么"；下游要判断产物就得看这个。
           */
          paramsEffective: fileParams,
          _sheet: r.sheet,
        })
        // 进度行报**产物**的透明像素：key 模式下模型侧恒为 0，按它显示会少报
        // （实测一次键控出 60% 透明格，屏幕上却什么都没说）。
        if (!args.quiet) progress(`✔ ${basename(src)} → ${r.base}.png（${r.width}×${r.height}${r.pngWidth !== r.width ? ` → 导出 ${r.pngWidth}×${r.pngHeight}` : ''}，${r.paletteSize} 色${r.pngTransparent ? `，透明 ${r.pngTransparent} 像素` : ''}${r.beadSummary ? `，拼豆 ${r.beadSummary.totalBeads} 颗` : ''}）`)
        if (r.quality && !args.quiet) progress(`   质量：${qualitySummary(r.quality)}`)
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
    /*
     * `params` 是**用户请求值**（`buildParams` 的解析结果）。
     * 开了 `--auto-tune` 时它可能与实际产出的参数不同——真正生效的看
     * `paramsEffective`（全局）与 `results[].paramsEffective`（逐图）。
     */
    params,
    /*
     * `--auto-tune` 的**决策结果**。
     *
     * 以前这些只走 `progress()`（stderr），`--quiet` 下更是完全不输出——
     * 于是"搜了多少组、最优是哪组、有没有解、备选是什么"对 agent 一个字都不可见，
     * 而 agent 恰恰是靠 `--json` 写下游逻辑的。放进顶层让它机器可读。
     */
    autoTune: tuneLog.length
      ? {
          maxColors: Number(args['auto-tune']),
          /** 尺寸是否参与了搜索（恒 false：跨尺寸无可靠判据，见 core/auto-tune.ts） */
          searchedLongEdge: false,
          /** 搜索用的尺寸（= 用户请求的 longEdge） */
          longEdge: params.longEdge,
          files: tuneLog,
        }
      : undefined,
    paramsEffective,
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
                          参数也有两套：params 是**用户请求值**，paramsEffective 是
                          **实际生效值**（逐图在 results[].paramsEffective）——开了
                          --auto-tune 时两者会不同，判断产物要看后者；调参决策在 autoTune 字段
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
                          预置 id：${presetIdList()}
  --preset <id>           只指定预置色卡（等价于 --palette <预置 id>；带号色的卡会把号色写进
                          图纸/清单/.hex/像素 JSON，拼豆出图请用它）
  --palette-k <n>         自动取色颜色数（2–64）
  --style <id>            先套风格预设：${STYLE_PRESETS.map((s) => s.id).join(' / ')}
  --dither <m>            none | floyd | atkinson | bayer | bayer8
  --dither-max-colors <n> 抖动时最多用到几种色号（0=不限）。拼豆场景用它约束到
                          "我手上只有这么多种豆子"；超出时自动收敛到用量最大的 n 色
  --quality               额外输出图纸质量报告（保真误差 / 色号数 / 珠子数 / 抖动代价）
  --auto-tune <n>         自动搜参：在"色号数 ≤ n"的约束下找观感最好的参数组合，
                          并把结果写进本次转换（确定性：同图同参必得同一组）
                          **只在当前尺寸内搜**抖动/清理——尺寸由 --long-edge 决定，
                          不会被自动改掉（跨尺寸没有可靠判据，见 docs/架构.md）
                          决策结果进 --json 的 autoTune 字段
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
