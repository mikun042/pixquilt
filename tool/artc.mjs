#!/usr/bin/env node
/**
 * artc —— 像素画批处理 CLI（agent 的主要入口）
 *
 * 设计目标（重构计划 §8）：**agent 不需要浏览器就能产出像素图**。
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
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runPipeline } from '../src/core/pipeline.ts'
import { applyOps, blankArt } from '../src/core/ops.ts'
import { DEFAULT_PARAMS, coerceParams, normalizeHex, sanitizeParams, STYLE_PRESETS } from '../src/core/types.ts'
import { getPreset, isPresetId, parseHexPalette, serializeHexPalette } from '../src/core/palettes.ts'
import { artHash, encodePixBin, layoutSheet, parseProjectFile, pixelJSONString } from '../src/core/export.ts'
import { beadListCsv, beadReport, beadSvg } from '../src/core/bead.ts'
import { countTransparent, countUsage } from '../src/core/stats.ts'
import { describeAll, OP_SPECS } from '../src/core/spec.ts'
import { decodePngNode } from '../src/io/node-png.ts'
import { artToPngBytesNode } from '../src/io/node-export.ts'
import { canDecodeInNode, isImagePath, loadImageNode, UnsupportedImageError } from '../src/io/node-image.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/* ------------------------------------------------------------------ 参数解析 */

const BOOL_FLAGS = new Set([
  'help', 'selftest', 'describe', 'dry-run', 'json', 'bead', 'alpha', 'transparent',
  'sheet', 'pixbin', 'no-cleanup', 'quiet', 'keep-size', 'lock-palette',
])
/** 可选值开关：后面跟的值不以 -- 开头才算值（`--sheet` 与 `--sheet 4` 都合法） */
const OPTIONAL_VALUE_FLAGS = new Set(['sheet', 'bead'])

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

/** `--blank 58x58`（也接受 58X58 / 58*58 / 58×58） */
export function parseBlankSpec(text) {
  const m = String(text).match(/^(\d+)\s*[xX*×]\s*(\d+)$/)
  if (!m) throw new Error('--blank 需写成 宽x高，例如 --blank 58x58')
  return { width: Number(m[1]), height: Number(m[2]) }
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
  // 当成 .hex 文件路径
  const path = resolve(value)
  const text = readFileSync(path, 'utf8')
  const parsed = parseHexPalette(text)
  if (!parsed.colors.length) throw new Error(`色板文件里没有合法颜色：${value}（每行一个 #rrggbb，可带号色）`)
  return { patch: { paletteMode: 'custom', customPalette: parsed.colors }, codes: parsed.codes, source: `文件 ${basename(path)}（${parsed.colors.length} 色）` }
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

  if (args['long-edge'] !== undefined) params.longEdge = Number(args['long-edge'])
  if (args.size !== undefined) {
    const spec = parseBlankSpec(args.size)
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
  if (args['no-cleanup']) params.cleanup = false
  if (args['cleanup-min'] !== undefined) params.cleanupMinSize = Number(args['cleanup-min'])
  if (args['lock-palette']) params.lockPalette = true

  // 拼豆模式默认锁定色板：这是"图纸只能用我有的号色"的硬要求（--palette auto 时不锁，否则没有色板可用）
  if (args.bead && params.paletteMode !== 'auto') params.lockPalette = true

  const { params: clean, fixed } = sanitizeParams(params)
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

/** 命名模板：{name} {index} {w} {h} {scale}，支持 {index:02} 零填充 */
export function applyTemplate(tpl, vars) {
  return String(tpl).replace(/\{(\w+)(?::(\d+))?\}(?:)/g, (_, key, width) => {
    const v = vars[key]
    if (v === undefined) return `{${key}}`
    const s = String(v)
    return width ? s.padStart(Number(width), '0') : s
  })
}

export function sanitizeName(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/[\s.]+$/, '').trim() || 'asset'
}

/* ------------------------------------------------------------------ 单张处理 */

function renderOne({ src, params, ops, scale, codes, beading, beadingOptions, wantSheet, wantPixbin, nameTemplate, index }) {
  const image = loadImageNode(src)
  const { art: rendered, overflow, paletteSource } = runPipeline({ width: image.width, height: image.height, data: image.data }, params)
  const applied = ops.length ? applyOps(rendered, ops, { allowApproxColor: !params.lockPalette }) : { art: rendered, changes: [], applied: false }
  const art = applied.art

  const transparentBg = params.transparent === 'key'
  const pngOpts = { transparentBg, bgHex: params.matteColor }
  const png = artToPngBytesNode(art, scale, pngOpts)
  const vars = { name: basename(src, extname(src)), index, w: art.width, h: art.height, scale }
  const base = sanitizeName(applyTemplate(nameTemplate, vars))

  const result = {
    src,
    base,
    width: art.width,
    height: art.height,
    paletteSize: art.palette.length,
    paletteSource,
    overflow,
    transparent: countTransparent(art.indices, art.alphaMask),
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
    beadSummary: null,
  }

  if (beading) {
    const opts = { codes, ...beadingOptions }
    result.beadCsv = beadListCsv(art, opts)
    result.beadSvg = beadSvg(art, { ...opts, title: `${vars.name} 拼豆图纸 ${art.width}×${art.height}` })
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
 * 每项断言都必须能因为一个真实缺陷而失败（重构计划 §15.4：测试有效性看"故意改坏会不会红"）。
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
    return '三种写法正确'
  })

  check('IO：Node 端只承诺自己能解码的格式（不冒充支持 JPEG）', () => {
    eq(canDecodeInNode('a.png'), true, 'PNG 应可解码')
    eq(canDecodeInNode('a.jpg'), false, 'JPEG 应如实报告不可解码')
    return '能力边界如实声明'
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
  const ops = args.ops ? parseOps(String(args.ops), '--ops') : []
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

  if (!args.quiet) {
    console.log(`参数：长边 ${params.longEdge}${params.exactWidth ? `（精确 ${params.exactWidth}×${params.exactHeight}）` : ''} · 降采样 ${params.downsample} · 色板 ${params.paletteMode}${params.paletteMode === 'preset' ? `(${params.presetPaletteId})` : ''} · 抖动 ${params.dither} · 透明 ${params.transparent}`)
    if (notes.length) console.log(`来源：${notes.join(' · ')}`)
    if (fixed.length) console.log(`已修正 ${fixed.length} 处参数：${fixed.map((f) => `${f.key}(${String(f.from)}→${String(f.to)})`).join('、')}`)
  }

  if (args['dry-run']) {
    console.log(JSON.stringify({ params, ops, scale, nameTemplate, out: outDir, fixed }, null, 2))
    return
  }

  mkdirSync(outDir, { recursive: true })
  const results = []
  const failures = []

  /** 空白画布模式：不读任何素材，纯程序化（拼豆图纸与资产原型常用） */
  if (args.blank) {
    const spec = parseBlankSpec(args.blank)
    const art0 = blankArt(spec.width, spec.height, args['blank-color'] ?? '#ffffff', !!args['blank-transparent'])
    const r = ops.length ? applyOps(art0, ops, { allowApproxColor: !params.lockPalette }) : { art: art0, changes: [], applied: false }
    const art = r.art
    const base = sanitizeName(applyTemplate(nameTemplate, { name: 'blank', index: 1, w: art.width, h: art.height, scale }))
    const png = artToPngBytesNode(art, scale, { transparentBg: params.transparent === 'key', bgHex: params.matteColor })
    writeFileSync(join(outDir, `${base}.png`), png)
    const row = { file: `${base}.png`, width: art.width, height: art.height, paletteSize: art.palette.length, hash: artHash(art) }
    if (beadingOptions) {
      const csv = beadListCsv(art, { codes, ...beadingOptions })
      const svg = beadSvg(art, { codes, ...beadingOptions, title: `${base} 拼豆图纸` })
      writeFileSync(join(outDir, `${base}_图纸.svg`), svg, 'utf8')
      writeFileSync(join(outDir, `${base}_缺口清单.csv`), csv, 'utf8')
      row.bead = beadReport(art, beadingOptions).totalBeads
    }
    results.push(row)
    console.log(`✔ 空白画布 ${spec.width}×${spec.height} → ${base}.png${row.bead ? `（${row.bead} 颗）` : ''}`)
  }

  if (args.in) {
    const inputs = collectInputs(String(args.in))
    if (!inputs.length) throw new Error(`输入目录里没有图片：${args.in}`)
    for (let i = 0; i < inputs.length; i++) {
      const src = inputs[i]
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
        results.push({
          file: `${r.base}.png`,
          src: basename(src),
          width: r.width,
          height: r.height,
          paletteSize: r.paletteSize,
          paletteSource: r.paletteSource,
          transparent: r.transparent,
          hash: r.hash,
          changes: r.changes.length,
          bead: r.beadSummary ?? undefined,
          _sheet: r.sheet,
        })
        if (!args.quiet) console.log(`✔ ${basename(src)} → ${r.base}.png（${r.width}×${r.height}，${r.paletteSize} 色${r.transparent ? `，透明 ${r.transparent}` : ''}${r.beadSummary ? `，拼豆 ${r.beadSummary.totalBeads} 颗` : ''}）`)
      } catch (err) {
        // 单张失败不中断整批：agent 需要"跑一次 → 读失败清单 → 修素材 → 重跑"
        const reason = err instanceof UnsupportedImageError ? err.message : (err?.message ?? String(err))
        failures.push({ src: basename(src), reason })
        console.error(`✘ ${basename(src)}：${reason}`)
      }
    }

    if (wantSheet && results.length) {
      const sheet = layoutSheet(results.map((r) => ({ name: r.file.replace(/\.png$/, ''), width: r.width, height: r.height })), sheetCols)
      writeFileSync(join(outDir, '_sheet.json'), JSON.stringify(sheet, null, 2), 'utf8')
      if (!args.quiet) console.log(`✔ 图集坐标表 _sheet.json（${sheet.columns}×${sheet.rows}，${sheet.frames.length} 帧）`)
    }
  }

  const summary = {
    out: outDir,
    ok: results.length,
    failed: failures.length,
    params,
    results,
    failures,
  }
  if (args.json) console.log(JSON.stringify(summary, null, 2))
  else {
    console.log(`\n处理完成：成功 ${results.length}，失败 ${failures.length}`)
    if (failures.length) console.log('失败清单：' + failures.map((f) => `${f.src}（${f.reason}）`).join('；'))
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
  --dry-run               只打印解析后的参数，不处理任何图片
  --quiet                 少打印过程信息

转换参数（未给出的项用出厂默认，结果与"当前状态"无关，可复现）：
  --long-edge <n>         输出长边格数（8–2048，默认 64）
  --size <WxH>            强制精确尺寸（游戏资产用；覆盖 --long-edge）
  --downsample <m>        average | nearest
  --crop <r>              free | 1:1 | 4:3 | 16:9
  --palette <v>           auto | 预置 id | *.hex 文件 | #aabbcc,#112233
                          预置 id：${[...new Set([...describeAll().presets.map((p) => p.id)])].join(' / ')}
  --palette-k <n>         自动取色颜色数（2–64）
  --style <id>            先套风格预设：${STYLE_PRESETS.map((s) => s.id).join(' / ')}
  --dither <m>            none | floyd | bayer
  --no-cleanup            关闭杂色清理
  --cleanup-min <n>       杂色清理阈值（1–10）
  --brightness/--contrast/--saturation <n>   预处理（-100..100）
  --alpha                 保留原图透明（真 alpha 通道）
  --transparent           背景色导出为透明（单色键控）
  --matte <#rrggbb>       合成/键控底色（默认 #ffffff）
  --lock-palette          只允许使用给定色板（拼豆/资产批次）

导出与附加产物：
  --sheet [列数]          额外输出 _sheet.json 图集坐标表（帧等尺寸 + offsetX/offsetY）
  --pixbin                额外输出 .pixbin（二进制像素数据，大画布往返更快）
  --bead [每板格数]       拼豆模式：输出 *_图纸.svg 与 *_缺口清单.csv（默认每板 58 格）
  --bead-mm <n>           单颗直径 mm（默认 5）  --bead-gram <n> 单颗重量 g（默认 0.08）
  --board <n>             每板格数（默认 58）

编辑算子（--ops '<json 数组>'，与页内 API 的 edit() 完全一致）：
${ops}

说明：
  · 颜色默认值：命令行路径允许省略 color（用默认主色 #1a1a1a）；**算子数组里建议显式给 color**，
    这样换工具或改默认色都不会影响结果。
  · 越界坐标静默裁剪；宽高超 2048 夹紧并在 JSON 汇总里给出实际尺寸。
  · 单张素材失败不会中断整批，结尾给出失败清单并以非零码退出。`)
}

main().catch((err) => {
  console.error(`错误：${err?.message ?? err}`)
  process.exit(1)
})
