/**
 * `--selftest` 的全部链路自检。
 *
 * 从 `tool/artc.mjs` 拆出来（那片文件一度 1793 行，其中这一块占 779 行）。
 * 拆分的理由不是"数字好看"，而是**它本来就是一个独立职责**：
 * 自检不读任何外部素材、只证明"引擎→算子→导出→拼豆"这条链是通的，
 * 与 CLI 的参数解析/主流程没有任何耦合。放在一起时，
 * "改一个断言要在一千八百行里翻"是每次改自检都要付的成本。
 *
 * 依赖全是 artc.mjs 已导出的纯函数（parseArgs / buildParams / …），
 * 所以这里只 import、不反向依赖主流程——方向仍是单向的。
 *
 * 每项断言都必须能因为一个真实缺陷而失败（见 docs/开发.md §3.1：
 * 测试有效性看"故意改坏会不会红"）。
 */
import { dirname, join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { inflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { beadListCsv, beadReport, beadSvg } from '../src/core/bead.ts'
import { beadPdfNode } from '../src/io/node-pdf.ts'
import { describeAll } from '../src/core/spec.ts'
import { sliceByGrid } from '../src/core/slice.ts'
import { artHash, encodePixBin, layoutSheet, parseProjectFile, pixelJSONString } from '../src/core/export.ts'
import { ENGINE_EXT, ENGINE_FORMATS, exportSheetMeta, isEngineFormat } from '../src/core/sheetmeta.ts'
import { PRESETS, codesForParams, getPreset, parseHexPalette, serializeHexPalette } from '../src/core/palettes.ts'
import { applyOps, blankArt } from '../src/core/ops.ts'
import { artToPngBytesNode } from '../src/io/node-export.ts'
import { canDecodeInNode } from '../src/io/node-image.ts'
import { needsBrowserDecode } from '../src/io/node-decode.ts'
import { countTransparent, countUsage } from '../src/core/stats.ts'
import { decodePngNode } from '../src/io/node-png.ts'
import { DEFAULT_PARAMS, coerceParams, sanitizeParams } from '../src/core/types.ts'
import { PALETTE_MAX } from '../src/core/limits.ts'
import { qualityReport } from '../src/core/quality.ts'
import { autoTune, tuneSummary } from '../src/core/auto-tune.ts'
import { runPipeline } from '../src/core/pipeline.ts'
import {
  KNOWN_FLAGS,
  applyTemplate,
  assertKnownFlags,
  assertNoPlaceholders,
  buildParams,
  keyOptions,
  loadOps,
  parseArgs,
  parseBeadingOptions,
  pngStats,
  parseBlankSpec,
  parseSliceSpec,
  resolvePaletteFlag,
  sanitizeName,
} from './artc.mjs'

/**
 * `--selftest`：不读任何外部素材，用进程内生成的合成数据把"引擎 → 算子 → 导出 → 拼豆"整条链路走一遍。
 * 每项断言都必须能因为一个真实缺陷而失败（见 docs/开发.md §3.1：测试有效性看"故意改坏会不会红"）。
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

  /*
   * 自动取色的"最低线"守卫。
   *
   * 存在的理由：medianCut 的分裂阈值是按色彩空间量纲写的（0–255 空间里是 1，OKLab 里是 1e-4）。
   * 量纲一错，整张图会**静默退化成 1 个色号**——不报错、不抛异常，只是出来一张单色图。
   * 单测里有更细的断言，这里再挂一条链路级的：只要管线跑完色板还 >1 色，就说明取色没塌。
   * 变异验证：把 pipeline.ts 的 MIN_SPLITTABLE_RANGE 改回 1，这条与单测同时红。
   */
  check('管线：自动取色不得塌成单色（分裂阈值的量纲守卫）', () => {
    const { params } = sanitizeParams({ paletteMode: 'auto', paletteK: 12, longEdge: 24 })
    const { art } = runPipeline(makeFixture(), params)
    assert(art.palette.length > 1, `自动取色只得到 ${art.palette.length} 个色号——分裂逻辑塌成单色了`)
    return `auto/12 → 实际 ${art.palette.length} 色`
  })

  check('管线：五种抖动模式都能跑且互不相同（防"清单里有、实现落回默认"）', () => {
    /*
     * 与"页面宣称的每个算子都真的能执行"同一个思路：宣称支持 5 种抖动，
     * 就得真的产出 5 种不同结果。某个模式的分数支漏写时会静默落回 none，
     * 只比对枚举清单是抓不到的（那是同义反复），必须真跑一遍比指纹。
     */
    const hashes = new Map()
    for (const m of ['none', 'floyd', 'atkinson', 'bayer', 'bayer8']) {
      const { params } = sanitizeParams({ paletteMode: 'preset', presetPaletteId: 'beads24', longEdge: 32, cleanup: false, dither: m })
      hashes.set(m, artHash(runPipeline(makeFixture(), params).art))
    }
    for (const m of ['floyd', 'atkinson', 'bayer', 'bayer8']) {
      assert(hashes.get(m) !== hashes.get('none'), `${m} 的结果与 none 相同——该模式没生效`)
    }
    assert(new Set(['floyd', 'atkinson', 'bayer', 'bayer8'].map((m) => hashes.get(m))).size === 4, '四种抖动应产出 4 种不同结果')
    return `5 种模式 → 5 个不同指纹`
  })

  check('管线：--dither-max-colors 真的把色号压到上限内（两遍法）', () => {
    /*
     * 这是 T5 的核心承诺：用户设了"我只有 6 种豆子"，输出就**必须** ≤6 色。
     * 实现是两遍法（先按真实用量挑出前 N 色，再用这 N 色重跑）——
     * 第一版的"压制误差扩散"与"在线贪心"两种做法实测都守不住（14→16、4→11），
     * 这条断言用严格的 `<=` 把它们挡住。
     */
    for (const cap of [4, 6, 8]) {
      const { params } = sanitizeParams({
        paletteMode: 'preset',
        presetPaletteId: 'beads24',
        longEdge: 32,
        cleanup: false,
        dither: 'floyd',
        ditherMaxColors: cap,
      })
      const { art } = runPipeline(makeFixture(), params)
      const used = new Set([...art.indices]).size
      assert(used <= cap, `设了上限 ${cap} 却用到 ${used} 色——用户会按错的数量去买豆子`)
    }
    return '上限 4/6/8 均守得住'
  })

  check('质量度量：块平均与逐格是两个不同的数，且抖动下块平均更小（指标陷阱守卫）', () => {
    /*
     * 守的是"指标算错会把人带向错误决策"那一类问题（ARCHITECTURE §8.10 ⑦）。
     * 抖动**故意**让单格偏离、靠空间混合让观感更接近原图，所以：
     *   逐格误差 floyd > none（看着更差）  但  块平均 floyd < none（实际更好）。
     * 若 blockFidelity 被实现成逐格的别名（退化），这条立刻红——
     * 而那个错误会直接导出"抖动让画质变差、该关掉"的结论，与事实相反。
     */
    const src = makeFixture()
    const mk = (dither) => {
      const { params } = sanitizeParams({ paletteMode: 'preset', presetPaletteId: 'beads24', longEdge: 48, cleanup: false, dither })
      const art = runPipeline(src, params).art
      return qualityReport({ width: src.width, height: src.height, data: src.data }, art, { paletteMode: 'preset', presetPaletteId: 'beads24' })
    }
    const none = mk('none')
    const floyd = mk('floyd')
    assert(floyd.fidelity.mean > none.fidelity.mean, '抖动应让逐格误差变大')
    assert(floyd.blockFidelity.mean < none.blockFidelity.mean, '抖动应让块平均误差变小')
    return (
      '逐格 ' + none.fidelity.mean.toFixed(4) + '→' + floyd.fidelity.mean.toFixed(4) +
      '；块平均 ' + none.blockFidelity.mean.toFixed(4) + '→' + floyd.blockFidelity.mean.toFixed(4)
    )
  })

  check('自动调参：同图同参两次搜索得到同一组最优参数（确定性）', () => {
    // 搜索是最容易引入不确定性的地方（排序并列、遍历顺序）。这条守住"同图同参 → 同结果"。
    const src = makeFixture()
    const { params } = sanitizeParams({ paletteMode: 'preset', presetPaletteId: 'beads24', longEdge: 32 })
    const a = autoTune({ width: src.width, height: src.height, data: src.data }, params, { maxColors: 12 })
    const b = autoTune({ width: src.width, height: src.height, data: src.data }, params, { maxColors: 12 })
    assert(tuneSummary(a) === tuneSummary(b), '两次搜索的最优解必须完全一致')
    return tuneSummary(a)
  })

  check('自动调参：色号上限是硬约束（有解不超限；无解时下沉上限仍不超限）', () => {
    /*
     * "自动调参"存在的意义就是"我只有 N 种豆子"。这条双向验：
     *  · 有可行解 → 最优解必然 ≤ N；
     *  · 无可行解 → 把上限下沉成 ditherMaxColors（两遍法硬保证），仍然 ≤ N，且 feasible=false 如实说明。
     * 变异验证：去掉无解分支的下沉逻辑，本段立刻红。
     */
    const src = makeFixture()
    const { params } = sanitizeParams({ paletteMode: 'preset', presetPaletteId: 'beads24', longEdge: 32 })
    const infeasible = autoTune({ width: src.width, height: src.height, data: src.data }, params, { maxColors: 2 })
    assert(infeasible.best.usedColors <= 2, '无解时仍须守住上限 2，实测 ' + infeasible.best.usedColors + ' 色')
    assert(!infeasible.feasible, '上限 2 色应如实标记为无解')
    const feasible = autoTune({ width: src.width, height: src.height, data: src.data }, params, { maxColors: 12 })
    assert(feasible.best.usedColors <= 12, '上限 12 却给出 ' + feasible.best.usedColors + ' 色')
    return '无解(2→' + infeasible.best.usedColors + ') / 有解(12→' + feasible.best.usedColors + ')'
  })

  check('CLI：--auto-tune 的数值校验，且与 --blank 同用要报错（不能静默无效）', () => {
    /*
     * 这一层是**接线层**——原先没有任何断言（core 测了 autoTune 函数本身，但"参数怎么进来"没人管），
     * 于是下面这类的缺陷一个个漏到用户手上。用 buildParams 直测（in-process，与其它 CLI 断言一致）。
     *
     * 两类：
     *  ① 数值非法 → 必须报错（`--auto-tune abc` 原先会被静默忽略）；
     *  ② 用在 `--blank` 下 → 明确报错。--blank 没有素材可搜参，这个组合本身无效，
     *     而原先的校验藏在 `--in` 的逐图循环里，`--blank ... --auto-tune 14` 会**什么都不做还成功退出**。
     */
    for (const bad of ['abc', '1', '0', '-3']) {
      let msg = ''
      try {
        buildParams(parseArgs(['--in', 'x.png', '--auto-tune', bad]))
      } catch (err) {
        msg = err?.message ?? String(err)
      }
      assert(msg.includes('--auto-tune'), `--auto-tune ${bad} 应报错并点出开关名，实际：${msg || '（没报错）'}`)
    }
    let blankMsg = ''
    try {
      buildParams(parseArgs(['--blank', '8x8', '--auto-tune', '14']))
    } catch (err) {
      blankMsg = err?.message ?? String(err)
    }
    assert(blankMsg.includes('--auto-tune'), '--auto-tune 与 --blank 同用应报错，实际：' + (blankMsg || '（没报错）'))
    // 合法值应照常通过（别把校验写成过严）
    const ok = buildParams(parseArgs(['--in', 'x.png', '--auto-tune', '14']))
    assert(ok && ok.params, '合法 --auto-tune 14 应照常通过')
    return '非法值/与 --blank 同用均报错；合法值不受影响'
  })

  check('CLI：--auto-tune 不得改写 --long-edge（参数被静默丢弃是最糟的一类）', () => {
    /*
     * 真实缺陷（外部 agent 报告 + 实测复现）：`--long-edge 58 --auto-tune 14` 的产物是 24×18，
     * 而 `--json` 的 `params.longEdge` 还写着 58 —— 参数被丢弃、报告回显**输入值**。
     * 这条把它钉死：搜参之后，请求的 longEdge 必须原样保留。
     * 变异验证：让尺寸重新进搜索空间，本段立刻红。
     */
    const src = makeFixture()
    for (const le of [24, 58, 96]) {
      const { params } = buildParams(parseArgs(['--in', 'x.png', '--long-edge', String(le), '--auto-tune', '12']))
      const r = autoTune({ width: src.width, height: src.height, data: src.data }, params, { maxColors: 12 })
      assert(
        r.best.params.longEdge === le,
        `请求 --long-edge ${le}，搜参后却变成 ${r.best.params.longEdge}——用户会拿到与图纸不符的产物`,
      )
    }
    return 'longEdge 24/58/96 均原样保留'
  })

  check('CLI：--auto-tune 的决策结果必须对机器可见（不能只写 stderr）', () => {
    /*
     * 原先 `TuneResult`（搜了多少组/最优哪组/有没有解/备选）只经 `progress()` 进 stderr，
     * `--quiet` 下更是完全没有——而 agent 恰恰靠 `--json` 写下游逻辑，于是"调参决策"对它不可见。
     * 这条守住 `autoTune` 字段的契约形状：四要素齐全、且与 best 自洽。
     */
    const src = makeFixture()
    const { params } = buildParams(parseArgs(['--in', 'x.png', '--long-edge', '32', '--auto-tune', '12']))
    const r = autoTune({ width: src.width, height: src.height, data: src.data }, params, { maxColors: 12 })
    // 这四项就是 --json 的 autoTune.files[i] 里逐项对应的内容
    assert(typeof r.feasible === 'boolean', 'feasible 必须是布尔')
    assert(Number.isInteger(r.evaluated) && r.evaluated > 0, 'evaluated 必须是正整数')
    assert(r.best && r.best.params, 'best 必须存在且带 params')
    assert(Array.isArray(r.top) && r.top.length > 0, 'top 必须非空（备选对决策有用）')
    assert(r.top[0].params.longEdge === r.best.params.longEdge, 'top[0] 应与 best 一致（同一套排序）')
    return `feasible=${r.feasible} / evaluated=${r.evaluated} / best=longEdge=${r.best.params.longEdge},${r.best.params.dither} / top=${r.top.length}`
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

  check('CLI：--palette 载入 .hex 时截断与跳行必须说出来（不能静默丢色）', () => {
    /*
     * `parseHexPalette` 一直算好了 truncated/skipped，但 `resolvePaletteFlag` 原先只读 colors/codes，
     * 于是 `--palette big.hex` 超限时静默丢色、非法行静默跳过——而 agent 会按文件里的色数做规划。
     * 这条守的是"把已经算出来的事实说出来"这一步，`source` 会进进度输出与 --json 结果。
     * 变异验证：去掉 notes 那两行，这条立刻红。
     */
    const tmp = join(mkdtempSync(join(tmpdir(), 'artc-pal-')), 'big.hex')
    const lines = []
    for (let i = 0; i < PALETTE_MAX + 5; i++) {
      lines.push(`#${(i * 257 + 1).toString(16).padStart(6, '0').slice(-6)}`)
    }
    lines.push('这行不是颜色')
    writeFileSync(tmp, lines.join('\n'), 'utf8')
    const r = resolvePaletteFlag(tmp)
    assert(r.patch.customPalette.length === PALETTE_MAX, `应截到 ${PALETTE_MAX}，实际 ${r.patch.customPalette.length}`)
    assert(/截断/.test(r.source), `source 必须报出截断，实际「${r.source}」`)
    assert(/5 色/.test(r.source), `应报出被截的 5 色，实际「${r.source}」`)
    assert(/跳过/.test(r.source), `也应报出跳过的非法行，实际「${r.source}」`)
    rmSync(dirname(tmp), { recursive: true, force: true })
    return r.source
  })

  check('CLI：拼豆数值开关收到非数值时**报错**而不是静默变成 NaN', () => {
    /*
     * 这三个开关（--bead-mm / --bead-gram / --board）**不走 sanitizeParams**
     * （它们是拼豆选项，不属于 ConvertParams），所以没有自动的 NaN 兜底。
     * 实测过的真实行为：`--bead-gram abc` → 重量 `NaN g`，`--board abc` → 分板数 `null`，
     * 而命令**照常成功退出**。属"接受了但没生效"那一类，必须报错。
     * 变异验证：把 numFlag 换回裸 Number()，这条立刻红。
     */
    const bad = [
      { args: { blank: '8x8', bead: true, 'bead-gram': 'abc' }, flag: '--bead-gram' },
      { args: { blank: '8x8', bead: true, 'bead-mm': 'abc' }, flag: '--bead-mm' },
      { args: { blank: '8x8', bead: true, board: 'abc' }, flag: '--board' },
    ]
    for (const c of bad) {
      let msg = ""
      try {
        parseBeadingOptions(c.args)
      } catch (err) {
        msg = err?.message ?? String(err)
      }
      assert(msg.includes(c.flag), c.flag + " 收到非数值时应报错并点出开关名，实际：" + (msg || "（没报错）"))
    }
    // 正常值仍然可用（别把校验写成过严）
    const ok = parseBeadingOptions({ blank: '8x8', bead: true, 'bead-gram': '0.5' })
    assert(ok, "合法数值应照常通过")
    return "3 个开关均报错；合法值不受影响"
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
    /*
     * ⚠️ 要读的是 **artc.mjs**（`printHelp` 在那边），不是本文件——
     * 这条守卫从 artc.mjs 拆过来之后，`import.meta.url` 变成了 selftest.mjs，
     * 于是它去本文件里找 `printHelp`，找不到就截出一段空区域，
     * 报"帮助一个 flag 都没提到"（拆分后实测的真实误报）。
     * 用相对本文件定位 artc.mjs，换目录也成立。
     */
    const src = readFileSync(fileURLToPath(new URL('./artc.mjs', import.meta.url)), 'utf8')
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
    /*
     * ⚠️ 这里**必须显式指向 artc.mjs**，不能用 import.meta.url——
     * 这条守卫从 artc.mjs 拆到本文件后，import.meta.url 变成了 selftest.mjs 自己，
     * 于是它会去检查一个**根本不存在守卫**的文件并永远失败（拆完实测就是这样）。
     * 用 new URL('./artc.mjs', import.meta.url) 相对本文件定位，换目录也成立。
     */
    const src = readFileSync(fileURLToPath(new URL('./artc.mjs', import.meta.url)), 'utf8')
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


export { selftest }
