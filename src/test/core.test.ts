/**
 * core 层单元测试（node:test，经 Node 的类型剥离直接跑 .ts，不需要先构建）。
 *
 * 覆盖原则：**每条断言都要能因为一个真实缺陷而失败**（见 docs/开发.md §3.1）。
 * 因此这里断言的是不变量与语义，而不是"跑通不报错"：
 *   - 色板约束（拼豆模式下不允许出现色板外的颜色）
 *   - 确定性（同图同参 → 同一指纹）
 *   - changed 的权威判定（只改 alpha 也算改动）
 *   - 口径（用量不含透明格，与 countTransparent 互补）
 *   - 序列化往返（PNG / 项目 JSON / pixbin）
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { deflateSync, inflateSync } from 'node:zlib'

import { runPipeline, computeCropRect, computeGridSize, medianCut, quantize } from '../core/pipeline.ts'
import { applyOps, blankArt, brushCells, lineCells, rasterizeEllipse, rasterizeRect, anchorOffset, type EditOp } from '../core/ops.ts'
import { DEFAULT_PARAMS, STYLE_PRESETS, coerceParams, sanitizeParams, sanitizePrefs } from '../core/types.ts'
import { PRESETS, codesForParams, getPreset, parseHexPalette, serializeHexPalette, paletteCodes } from '../core/palettes.ts'
import { PARAM_SPECS } from '../core/spec.ts'
import { qualityReport } from '../core/quality.ts'
import { MAX_CELL, MIN_CELL, clampCell, fitViewState, pointToCellClamped, zoomAtPoint } from '../core/viewport.ts'
import { autoTune, tuneSummary } from '../core/auto-tune.ts'
import { artHash, decodePixBin, encodePixBin, layoutSheet, parseProjectFile, pixelJSONString, projectJSONString } from '../core/export.ts'
import { base64ToBytes, bytesToBase64 } from '../core/binary.ts'
import { countTransparent, countUsage, hasRealAlpha } from '../core/stats.ts'
import { PALETTE_MAX } from '../core/limits.ts'
import { replacePaletteEntry } from '../core/palette-edit.ts'
import { hardenAlpha } from '../core/png.ts'
import { decodePngNode, encodePngNode } from '../io/node-png.ts'
import { artToPngBytesNode } from '../io/node-export.ts'
import { beadListCsv, beadReport, beadSvg } from '../core/bead.ts'
import { beadPdf } from '../core/bead-pdf.ts'
import { buildPdf, buildPdfAsync } from '../core/pdf.ts'
import { OP_SPECS } from '../core/spec.ts'
import { artToImageData } from '../core/raster.ts'
import { sliceAuto, sliceByGrid } from '../core/slice.ts'
import { hexToRgb, rgbToHex, rgbToOklab, oklabToRgb, gradientPalette } from '../core/color.ts'
import type { PixelArt } from '../core/types.ts'

/**
 * 生成一张"已经降采样到目标格数"的平滑渐变像素缓冲。
 * 用途：把量化器单独拎出来测（不经过采样的抗锯齿影响），让缓存路径与无缓存路径可被逐位比对。
 */
function gradientGrid(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      data[o] = Math.round((x / Math.max(1, width - 1)) * 255)
      data[o + 1] = Math.round((y / Math.max(1, height - 1)) * 255)
      data[o + 2] = 80
      data[o + 3] = 255
    }
  }
  return data
}

/** 无缓存的参考实现：逐格直接算 OKLab 最近色（独立于 core 的缓存代码路径） */
function directNearestIndices(data: Uint8ClampedArray, palette: string[]): number[] {
  const labs = palette.map((hex) => {
    const n = parseInt(hex.slice(1), 16)
    return rgbToOklab((n >> 16) & 255, (n >> 8) & 255, n & 255)
  })
  const out: number[] = []
  for (let i = 0; i < data.length; i += 4) {
    const lab = rgbToOklab(data[i], data[i + 1], data[i + 2])
    let best = 0
    let bestD = Infinity
    for (let k = 0; k < labs.length; k++) {
      const dl = labs[k].L - lab.L
      const da = labs[k].a - lab.a
      const db = labs[k].b - lab.b
      const d = dl * dl + da * da + db * db
      if (d < bestD) {
        bestD = d
        best = k
      }
    }
    out.push(best)
  }
  return out
}

/** 合成测试图：渐变 + 半透明块 + 纯色块，覆盖取色/透明/平均三条路径 */function fixture(w = 64, h = 48) {
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

describe('参数 Schema', () => {
  /*
   * 元数据对账（R2「单一真源」）。
   *
   * 算子那边一直有严格对账（`spec.ts` 的算子集 == `ops.ts` 的 switch 集 == 数量常量），
   * **参数这边原本没有任何对账**——`PARAM_SPECS` 全仓只有 4 处引用（定义 / describeAll /
   * describe.mjs 渲染 / describeParams），漏加一条 `ParamSpec` 不会被任何测试抓到：
   * `--describe` 里少一行、手册少一项，而代码照常工作。这正是本项目最忌讳的"静默漂移"。
   *
   * 加这条的时机也重要：T5/T3 都要往 `ConvertParams` 加字段，先有防线再改，改动才可验收。
   *
   * 为什么用 `DEFAULT_PARAMS` 的键而不是 `ConvertParams` 接口的键：接口是**类型**，
   * 运行时枚举不出来（TS 类型在编译后不存在）。而 `DEFAULT_PARAMS` 是 `ConvertParams` 类型的
   * 完整字面量——少写一个必填字段 tsc 就会报错，所以它天然是"必填字段全集"。
   * 可选字段（`?`）不在其中，所以下面用白名单显式列出，并要求它**正好**是那四个。
   */
  it('参数元数据与实现一致：每个参数都有 ParamSpec，且没有多余条目（漂移会被这条抓住）', () => {
    // 用 Set<string> 而不是 Set<keyof ConvertParams>：下面要拿它跟 Object.keys() 的
    // string[] 比对，而 `keyof ConvertParams` 是窄类型，TS 不接受"窄集合查宽键"这种用法
    const specKeys = new Set<string>(PARAM_SPECS.map((s) => s.key))
    const defaultKeys: string[] = Object.keys(DEFAULT_PARAMS)

    // ① 每个「必有默认值」的参数都必须有元数据，否则 --describe / 文档会漏掉它
    const missingSpec = defaultKeys.filter((k) => !specKeys.has(k))
    assert.deepEqual(
      missingSpec,
      [],
      `这些参数在 DEFAULT_PARAMS 里但没有 ParamSpec，--describe 与手册会漏掉：${missingSpec.join(', ')}`,
    )

    // ② 反过来：ParamSpec 不该有 DEFAULT_PARAMS 里不存在的键（拼错或已删除的字段）
    //    例外是**可选字段**——它们没有默认值（undefined 有意义，表示"不启用"），
    //    这个白名单必须精确，不能写成"包含即通过"，否则真拼错的键会被放行。
    const OPTIONAL_FIELDS = ['customPaletteCodes', 'exactWidth', 'exactHeight', 'lockPalette']
    const specOnly = [...specKeys].filter((k) => !defaultKeys.includes(k)).sort()
    assert.deepEqual(
      specOnly,
      [...OPTIONAL_FIELDS].sort(),
      `ParamSpec 里出现了 DEFAULT_PARAMS 之外的键。若这是**新加的可选字段**，请把它加进本测试的白名单；` +
        `若是拼错的键或已删除的字段，请从 PARAM_SPECS 移除。实际多出：${specOnly.join(', ')}`,
    )

    // ③ id 不能重复（重复会让 describe 输出两条同名条目，且 Object 化时后者覆盖前者）
    assert.equal(specKeys.size, PARAM_SPECS.length, 'PARAM_SPECS 里有重复的 key')

    // ④ 数量锁：加参数时这条会红，提醒同步文档与测试（与算子那条同一个套路）
    assert.equal(PARAM_SPECS.length, 23, '参数数量变化时必须同步文档与测试')
  })

  it('越界值被夹紧并如实报告（agent 必须能发现自己传的值没生效）', () => {
    const r = sanitizeParams({ longEdge: 99999, paletteK: 0, dither: 'x', brightness: -500 })
    assert.equal(r.params.longEdge, 2048)
    assert.equal(r.params.paletteK, 2)
    assert.equal(r.params.dither, 'none')
    assert.equal(r.params.brightness, -100)
    assert.deepEqual(r.fixed.map((f) => f.key).sort(), ['brightness', 'dither', 'longEdge', 'paletteK'])
  })

  it('v2 字段迁移到 v3：alpha(boolean) 与 flattenBg', () => {
    const r = sanitizeParams({ alpha: true, flattenBg: '#123456' })
    assert.equal(r.params.transparent, 'alpha')
    assert.equal(r.params.matteColor, '#123456')
    assert.ok(r.fixed.some((f) => f.key === 'transparent'))
    assert.ok(r.fixed.some((f) => f.key === 'matteColor'))
  })

  it('exactWidth/Height 必须成对，半给会被忽略（尺寸推导不能自相矛盾）', () => {
    assert.equal(coerceParams({ exactWidth: 32 }).exactWidth, undefined)
    const both = coerceParams({ exactWidth: 32, exactHeight: 24 })
    assert.equal(both.exactWidth, 32)
    assert.equal(both.exactHeight, 24)
  })

  it('未知类型回退默认而不是抛错（旧草稿/手改 JSON 不应炸掉启动）', () => {
    const r = sanitizeParams({ longEdge: 'huge', customPalette: ['#zzzzzz', '#00ff00', 5] })
    assert.equal(r.params.longEdge, DEFAULT_PARAMS.longEdge)
    assert.deepEqual(r.params.customPalette, ['#00ff00'])
  })

  /*
   * 色板与颜色字段的**如实上报**（2026-09-16 补）。
   *
   * 背景：`paletteField` 长度封顶、`hexField` 非法回退，**原先都不产出 `FixedField`**——
   * 于是 `validateParams()` 与 CLI 的"已修正 N 处参数"完全看不到，
   * 而 agent 会按自己传的色板长度规划后续步骤，最后拿到一张少了几十色的图纸。
   * `numP`/`enumP` 一直有上报，色板这条路是缺口。
   *
   * 变异验证：把 `paletteField` 的 truncated/dropped 上报或 `matteColor` 的上报删掉，这两条立刻红。
   */
  it('超长色板要如实上报截断（不能静默丢色）', () => {
    const big = Array.from({ length: PALETTE_MAX + 7 }, (_, i) => `#${(i * 257 + 1).toString(16).padStart(6, '0').slice(-6)}`)
    const r = sanitizeParams({ customPalette: big })
    assert.equal(r.params.customPalette.length, PALETTE_MAX, `色板应被截到 ${PALETTE_MAX}`)
    const hit = r.fixed.find((f) => f.key === 'customPalette' && /截掉/.test(f.reason))
    assert.ok(hit, `截断必须记进 FixedField，实际 fixed=${JSON.stringify(r.fixed)}`)
    assert.match(hit.reason, /截掉 7 色/, `应报出真实被截条数，实际「${hit.reason}」`)
  })

  it('色板里的非法颜色要如实上报丢弃条数', () => {
    const r = sanitizeParams({ customPalette: ['#ff0000', 'not-a-color', '#00ff00', 42] })
    assert.deepEqual(r.params.customPalette, ['#ff0000', '#00ff00'])
    const hit = r.fixed.find((f) => f.key === 'customPalette' && /非法颜色/.test(f.reason))
    assert.ok(hit, `丢弃项必须记进 FixedField，实际 fixed=${JSON.stringify(r.fixed)}`)
    assert.match(hit.reason, /2 项/, `应报出 2 项，实际「${hit.reason}」`)
  })

  it('非法的 matteColor 要如实上报回退（否则原图透明区会合成到另一个颜色上）', () => {
    const r = sanitizeParams({ matteColor: 'garbage' })
    assert.equal(r.params.matteColor, DEFAULT_PARAMS.matteColor)
    const hit = r.fixed.find((f) => f.key === 'matteColor')
    assert.ok(hit, `回退必须记进 FixedField，实际 fixed=${JSON.stringify(r.fixed)}`)
    assert.match(hit.reason, /回退默认/)
    // 合法值不该产生噪音上报
    assert.equal(sanitizeParams({ matteColor: '#123456' }).fixed.some((f) => f.key === 'matteColor'), false)
  })

  /*
   * 号色（customPaletteCodes）：拼豆用户靠它让自己的色卡编号印在图纸上。
   * 三条都是"错了会静默出问题"的地方，所以逐条钉住。
   */
  it('号色与颜色**按下标对齐**：中间的非字符串项要留空位，不能丢弃', () => {
    // 丢掉中间项会让后面所有号色整体前移一格——图纸上编号集体串行，比没有编号更糟
    const r = sanitizeParams({ customPalette: ['#ff0000', '#00ff00', '#0000ff'], customPaletteCodes: ['S1', 5, 'S3'] })
    assert.deepEqual(r.params.customPaletteCodes, ['S1', '', 'S3'])
  })

  it('号色全是空时归一成 undefined（不在项目文件里留一堆空串）', () => {
    const r = sanitizeParams({ customPaletteCodes: ['', '  ', ''] })
    assert.equal(r.params.customPaletteCodes, undefined)
    // 尾部空串也裁掉，但中间的空位要保留（同上，位置就是信息）
    const r2 = sanitizeParams({ customPaletteCodes: ['S1', '', '', ''] })
    assert.deepEqual(r2.params.customPaletteCodes, ['S1'])
  })

  it('号色长度与颜色无关地各自夹紧在 256 以内', () => {
    const many = Array.from({ length: 300 }, (_, i) => `S${i}`)
    const r = sanitizeParams({ customPaletteCodes: many })
    assert.equal(r.params.customPaletteCodes?.length, 256)
  })

  it('号色不影响"没给就别多出字段"：不传时是 undefined，项目文件保持简洁', () => {
    const r = sanitizeParams({ longEdge: 32 })
    assert.equal(r.params.customPaletteCodes, undefined)
  })

  it('偏好旧字段 tool=eraser 迁移为「画笔 + 透明色」', () => {
    const p = sanitizePrefs({ tool: 'eraser' })
    assert.equal(p.tool, 'pencil')
    assert.equal(p.eraseToAlpha, true)
  })
})

describe('OKLab 颜色', () => {
  it('hex ↔ rgb 往返', () => {
    assert.deepEqual(hexToRgb('#ff8800'), { r: 255, g: 136, b: 0 })
    assert.equal(rgbToHex(255, 136, 0), '#ff8800')
  })

  it('OKLab 往返误差在 1/255 以内（量化匹配依赖这个精度）', () => {
    for (const hex of ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#7f7f7f', '#123456']) {
      const c = hexToRgb(hex)
      const lab = rgbToOklab(c.r, c.g, c.b)
      const back = oklabToRgb(lab.L, lab.a, lab.b)
      assert.ok(Math.abs(back.r - c.r) <= 1, `${hex} R 误差 ${Math.abs(back.r - c.r)}`)
      assert.ok(Math.abs(back.g - c.g) <= 1, `${hex} G 误差 ${Math.abs(back.g - c.g)}`)
      assert.ok(Math.abs(back.b - c.b) <= 1, `${hex} B 误差 ${Math.abs(back.b - c.b)}`)
    }
  })

  it('渐变首尾精确命中端点色', () => {
    const g = gradientPalette('#000000', '#ffffff', 5)
    assert.equal(g.length, 5)
    assert.equal(g[0], '#000000')
    assert.equal(g[4], '#ffffff')
  })
})

describe('取色（Median Cut）', () => {
  it('全部同色时只返回一个颜色，且不进入死循环', () => {
    const colors = Array.from({ length: 100 }, () => ({ r: 10, g: 20, b: 30 }))
    assert.deepEqual(medianCut(colors, 16), ['#0a141e'])
  })

  it('两种色各半时能分出两色', () => {
    const colors = [
      ...Array.from({ length: 50 }, () => ({ r: 0, g: 0, b: 0 })),
      ...Array.from({ length: 50 }, () => ({ r: 255, g: 255, b: 255 })),
    ]
    const out = medianCut(colors, 2)
    assert.equal(out.length, 2)
    assert.ok(out.includes('#000000'))
    assert.ok(out.includes('#ffffff'))
  })

  it('抽样路径下仍然确定（大图取色必须可复现）', () => {
    const colors = Array.from({ length: 300_000 }, (_, i) => ({ r: i % 256, g: (i * 7) % 256, b: (i * 13) % 256 }))
    const a = medianCut(colors, 8)
    const b = medianCut(colors, 8)
    assert.deepEqual(a, b)
  })

  /*
   * 下面两条守的是"改色彩空间时阈值必须跟着换量纲"这个坑（2026-09-16 把 medianCut
   * 从 sRGB 换成 OKLab 时引入的守卫）。
   *
   * 分裂循环里的"最小可切跨度"原本写死 `1`，那是 **0–255 量纲**的值；而 OKLab 的
   * L∈[0,1]、a/b 约 ±0.4，跨度只有 0.4–1.0 量级。阈值不换 → 每个盒子都被判成"纯色、不可切"
   * → `bestIdx` 永远 -1 → 直接 break → **整张图只输出 1 个色号**。
   * 它不报错、不抛异常，只是静默退化——所以必须有断言当场抓住。
   * 变异验证：把阈值改回 `1`，这两条立刻红（实测输出 1 色）。
   */
  it('多色图取色不得塌成单色（守住分裂阈值与色彩空间的量纲一致）', () => {
    // 造一张"暗部密集 + 亮部稀疏"的图——这正是 sRGB 体积与感知不成比例的典型形态
    const colors = [
      ...Array.from({ length: 3000 }, (_, i) => ({ r: 10 + (i % 40), g: 10 + (i % 35), b: 20 + (i % 30) })),
      ...Array.from({ length: 1000 }, (_, i) => ({ r: 200 + (i % 50), g: 180 + (i % 60), b: 150 + (i % 70) })),
    ]
    for (const k of [4, 16, 32]) {
      const out = medianCut(colors, k)
      assert.ok(out.length > 1, `k=${k} 时塌成了 ${out.length} 色——分裂阈值与 OKLab 量纲不一致`)
    }
  })

  it('取色数量随 k 单调不减（k 变大不该反而给出更少的色号）', () => {
    const colors = Array.from({ length: 4000 }, (_, i) => ({
      r: (i * 37) % 256,
      g: (i * 91) % 256,
      b: (i * 53) % 256,
    }))
    let prev = 0
    for (const k of [2, 4, 8, 16, 32]) {
      const n = medianCut(colors, k).length
      assert.ok(n >= prev, `k=${k} 给出 ${n} 色，比更小的 k 还少（${prev}）`)
      // 撞色去重会让实际色数 ≤ k，这是既有语义（dedupePalette），但要如实受这条上界约束
      assert.ok(n <= k, `k=${k} 却给出 ${n} 色，超过请求值`)
      prev = n
    }
  })

  /*
   * 下面两条守的是"**排序会就地重排，按位置回查原始数据必须与排序同步**"这个坑。
   *
   * 背景：medianCut 内部会 `sort` 一份 OKLab 数组。第一版把原始 sRGB 放在**平行数组**里、
   * 用 `box.from` 回查原始色——但排序只重排了 OKLab 那一份，原始数组没跟着动，
   * 于是取到的是**另一个位置**的颜色。它不会抛错、取到的也仍是"合法色板项"，
   * 只是不对应盒内内容。
   *
   * 触发条件很具体：**少量颜色重复排列**时，排序会把同色聚到一起，
   * 使 `box.from` 恰好落在同一个色上——实测 8 色各重复 40 次、k=8 时整幅图塌成 1 色。
   * 所以这两条用该形态构造，而不是用"每个像素都不同"的合成图（那种图抓不到）。
   */
  it('少量颜色重复排列时不得塌成单色，且盒内同色必须原样输出（排序与原始色不同步的防线）', () => {
    const base = ['#1a1a1a', '#7f7f7f', '#e6e6e6', '#c82828', '#28c83c', '#283cc8', '#dcc828', '#963cc8']
    const rgb = base.map((h) => ({
      r: parseInt(h.slice(1, 3), 16),
      g: parseInt(h.slice(3, 5), 16),
      b: parseInt(h.slice(5, 7), 16),
    }))
    // 逐色轮转排列（不是每个色连续 40 个）——正是这个交错让"按位置回查"错位
    const colors: { r: number; g: number; b: number }[] = []
    for (let rep = 0; rep < 40; rep++) for (const c of rgb) colors.push(c)

    const exact = new Set(base)
    for (const k of [8, 16]) {
      const out = medianCut(colors, k)
      assert.equal(out.length, base.length, `k=${k} 应还原出 ${base.length} 个不同色，实际 ${out.length}`)
      // 盒内全是同一个已知色时，走 verbatim 短路，输出必须**精确**等于该色
      for (const h of out) assert.ok(exact.has(h), `输出了非原始色 ${h}——原始色与排序不同步`)
    }
    // k 小于色数时是正常的"合并"，只要求不塌成单色
    for (const k of [2, 4]) {
      const out = medianCut(colors, k)
      assert.ok(out.length > 1 && out.length <= k, `k=${k} 给出 ${out.length} 色`)
    }
  })

  it('单调性在"少量颜色重复排列"上同样成立（该形态曾触发反向退化）', () => {
    const pal = [
      [26, 26, 26], [127, 127, 127], [230, 230, 230], [200, 40, 40],
      [40, 200, 60], [40, 60, 200], [220, 200, 40], [150, 60, 200],
    ]
    const colors: { r: number; g: number; b: number }[] = []
    for (let rep = 0; rep < 40; rep++) for (const c of pal) colors.push({ r: c[0], g: c[1], b: c[2] })
    let prev = 0
    for (const k of [2, 4, 6, 8, 10, 16]) {
      const n = medianCut(colors, k).length
      assert.ok(n >= prev, `k=${k} 给出 ${n} 色，比更小的 k 还少（${prev}）——真实发生过这种反向退化`)
      prev = n
    }
  })
})

describe('像素化管线', () => {
  it('裁剪比例按目标比例居中裁', () => {
    assert.deepEqual(computeCropRect(100, 100, 'free'), { sx: 0, sy: 0, sw: 100, sh: 100 })
    const r = computeCropRect(200, 100, '1:1')
    assert.equal(r.sw, 100)
    assert.equal(r.sx, 50)
    assert.equal(r.sh, 100)
    assert.equal(r.sy, 0)
  })

  it('长边格数 → 网格尺寸（短边按比例取整，最小 1）', () => {
    assert.deepEqual(computeGridSize(100, 50, { ...DEFAULT_PARAMS, longEdge: 64 }), { w: 64, h: 32 })
    assert.deepEqual(computeGridSize(50, 100, { ...DEFAULT_PARAMS, longEdge: 64 }), { w: 32, h: 64 })
    assert.deepEqual(computeGridSize(1000, 1, { ...DEFAULT_PARAMS, longEdge: 64 }), { w: 64, h: 1 })
  })

  it('exactWidth/Height 覆盖长边推导（游戏资产要精确尺寸）', () => {
    assert.deepEqual(computeGridSize(100, 37, { ...DEFAULT_PARAMS, exactWidth: 32, exactHeight: 32 }), { w: 32, h: 32 })
  })

  it('固定色板 + lockPalette：输出颜色绝不越出给定色板', () => {
    const preset = getPreset('beads16')
    assert.ok(preset, 'beads16 预置色卡必须存在（拼豆功能的基础）')
    const { params } = sanitizeParams({ paletteMode: 'preset', presetPaletteId: 'beads16', longEdge: 32, lockPalette: true })
    const { art } = runPipeline(fixture(), params)
    const allowed = new Set(preset.colors.map((c) => c.toLowerCase()))
    for (const c of art.palette) assert.ok(allowed.has(c), `${c} 不应出现在锁定的色板里`)
    for (let i = 0; i < art.indices.length; i++) assert.ok(art.indices[i] < art.palette.length, '索引越界')
  })

  it('固定色板 + 关抖动：缓存路径不能塌成单色（真实缺陷回归防线）', () => {
    // 曾经的实现只按坐标取模当缓存槽、命中即复用索引，导致不同颜色撞槽后拿到错误索引，
    // 表现为"整幅图只剩一种颜色"且**不报错**。这条断言用 core 的公开量化器做无缓存对照：
    //   ① 带缓存的 quantize 与"逐格直接算最近色"必须逐位一致；
    //   ② 渐变图在 16 色固定色板下必须用到多种颜色。
    const preset = getPreset('beads16')
    assert.ok(preset, 'beads16 必须存在')
    const base = { paletteMode: 'preset' as const, presetPaletteId: 'beads16', longEdge: 40, lockPalette: true }
    const params = coerceParams(base)

    // 取管线采样后的像素，再分别用两条路径量化同一份输入
    const sampled = { data: gradientGrid(40, 30), width: 40, height: 30 }
    const palette = getPreset('beads16')!.colors.map((c) => c.toLowerCase())
    const cached = quantize(sampled.data, sampled.width, sampled.height, palette, params, null).indices
    const direct = directNearestIndices(sampled.data, palette)

    assert.deepEqual([...cached], [...direct], '缓存路径与逐格直接匹配必须逐位一致')
    const used = new Set(cached)
    assert.ok(used.size >= 4, `渐变图在 16 色固定色板下应用到多种颜色，实际只用了 ${used.size} 种`)
    for (const i of used) assert.ok(i < palette.length, '索引越界')
  })

  it('透明模式不影响不透明区域的量化结果（键控只改导出，不改像素）', () => {
    const none = runPipeline(fixture(), coerceParams({ transparent: 'none', paletteMode: 'auto', paletteK: 12, longEdge: 32, matteColor: '#ffffff' })).art
    const key = runPipeline(fixture(), coerceParams({ transparent: 'key', paletteMode: 'auto', paletteK: 12, longEdge: 32, matteColor: '#ffffff' })).art
    // key 模式在管线里同样把透明像素合成到 matteColor（只是导出时再变透明），因此索引矩阵应逐位一致
    assert.equal(artHash(none), artHash(key), 'key 与 none 的像素结果应一致（差异只应出现在导出阶段）')
  })

  it('确定性：同图同参 → 同一指纹', () => {
    const { params } = sanitizeParams({ paletteMode: 'auto', paletteK: 16, longEdge: 32, dither: 'floyd' })
    assert.equal(artHash(runPipeline(fixture(), params).art), artHash(runPipeline(fixture(), params).art))
  })

  it('抖动开启时杂色清理被强制关闭（互斥约束）', () => {
    const base = { paletteMode: 'auto' as const, paletteK: 8, longEdge: 24 }
    const withDither = runPipeline(fixture(), coerceParams({ ...base, dither: 'floyd', cleanup: true })).art
    const noCleanup = runPipeline(fixture(), coerceParams({ ...base, dither: 'none', cleanup: false })).art
    const floydOnly = runPipeline(fixture(), coerceParams({ ...base, dither: 'floyd', cleanup: false })).art
    assert.equal(artHash(withDither), artHash(floydOnly), 'cleanup=true 不应改变抖动结果（应被强制关闭）')
    assert.notEqual(artHash(withDither), artHash(noCleanup), '抖动与不抖动应产生不同结果')
  })

  /* ------------------------------------------------------------------ 抖动：新增算法与色号上限 */

  /** 用一张多色渐变图统计"实际用到了几个色号"（抖动会逼出比色板更多的中间色） */
  const usedColors = (art: { indices: Uint8Array }): number => new Set([...art.indices]).size
  it('五种抖动模式都能跑，且各自产出可区分的结果（不是同一份实现换名字）', () => {
    /*
     * 这条守的是"宣称支持了几种抖动，就得真的各不相同"。本项目最忌讳
     * "清单里有、实现没有"——若某个模式只是 `dither` 分支漏写而落回默认，
     * 结果会与 none 完全一致，这条就会红。
     */
    const hashes = new Map<string, string>()
    for (const m of ['none', 'floyd', 'atkinson', 'bayer', 'bayer8'] as const) {
      const art = runPipeline(
        fixture(96, 96),
        sanitizeParams({ paletteMode: 'preset', presetPaletteId: 'beads24', longEdge: 64, cleanup: false, dither: m }).params,
      ).art
      hashes.set(m, artHash(art))
    }
    // none 之外的四者必须互不相同，且都与 none 不同
    for (const m of ['floyd', 'atkinson', 'bayer', 'bayer8'] as const) {
      assert.notEqual(hashes.get(m), hashes.get('none'), `${m} 的结果与 none 相同——该模式没生效`)
    }
    const four = ['floyd', 'atkinson', 'bayer', 'bayer8'].map((m) => hashes.get(m))
    assert.equal(new Set(four).size, 4, `四种抖动模式应产出 4 种不同结果，实际 ${new Set(four).size} 种`)
  })

  it('Atkinson 比 Floyd–Steinberg 用更少的色号（它主动丢弃 1/4 误差，这是它的性格）', () => {
    /*
     * 这条把 Atkinson 与 F-S 的**设计差别**钉成可验证的事实：Atkinson 六个邻居各拿 1/8、
     * 总共只扩散 3/4，剩下 1/4 主动丢弃 → 色点更干净、色号更少。
     * 若哪天有人把它的权值改成"补齐到 1"（看着更"正确"），这条会红——
     * 那正是我们要避免的"修掉了一个特性"。
     */
    const base = { paletteMode: 'preset' as const, presetPaletteId: 'beads24', longEdge: 64, cleanup: false }
    const floyd = usedColors(runPipeline(fixture(96, 96), sanitizeParams({ ...base, dither: 'floyd' }).params).art)
    const atk = usedColors(runPipeline(fixture(96, 96), sanitizeParams({ ...base, dither: 'atkinson' }).params).art)
    assert.ok(atk < floyd, `Atkinson 应比 F-S 用更少色号（实测 atkinson=${atk} vs floyd=${floyd}）`)
  })

  it('ditherMaxColors=0 表示不限制（默认值不能被夹成 2）', () => {
    /*
     * 真实踩过的坑：`DITHER_MAX_COLORS_MIN` 一度写成 2，而 0 是"不限制"的载体——
     * `sanitizeParams` 的 numP 会把 0 夹到 min，于是**默认值 0 被静默变成"限成 2 色"**，
     * 整幅图只剩两种颜色。这条守住"0 必须原样保留"。
     */
    assert.equal(sanitizeParams({}).params.ditherMaxColors, 0, '默认必须是 0（不限制）')
    assert.equal(sanitizeParams({ ditherMaxColors: 0 }).params.ditherMaxColors, 0, '0 不能被夹紧')
  })

  it('ditherMaxColors 真的把色号数压到上限内（且各上限都守得住）', () => {
    /*
     * 这是 T5 的核心承诺：用户设了"我只有 8 种豆子"，输出就**必须**不超过 8 色。
     *
     * 实现是**两遍法**（先看真实用量挑出用量最大的 N 色，再用这 N 色重跑一遍）——
     * 第一版试过两种"在线"做法，都实测失败并记录在案：
     *  · 压制误差扩散 → 色号反而变多（14→16）；
     *  · 在线的"只用已用色"贪心 → 不可靠且非单调（上限 4→11 色、6→14 色、8→9 色）。
     * 这条断言就是防止有人再退回那两种做法（它们都通不过下面的严格 `<=`）。
     */
    for (const cap of [4, 6, 8, 12]) {
      const art = runPipeline(
        fixture(96, 96),
        sanitizeParams({
          paletteMode: 'preset',
          presetPaletteId: 'beads24',
          longEdge: 64,
          cleanup: false,
          dither: 'floyd',
          ditherMaxColors: cap,
        }).params,
      ).art
      const used = usedColors(art)
      assert.ok(used <= cap, `设了上限 ${cap} 却用到 ${used} 色——上限没守住，用户会按错的数量去买豆子`)
    }
  })

  it('ditherMaxColors 越小色号越少（单调），且下限不低于 1', () => {
    // 单调性是人能理解这个参数的前提："我少要几种色"就该真的更少
    const run = (cap: number) =>
      usedColors(
        runPipeline(
          fixture(96, 96),
          sanitizeParams({
            paletteMode: 'preset',
            presetPaletteId: 'beads24',
            longEdge: 64,
            cleanup: false,
            dither: 'atkinson',
            ditherMaxColors: cap,
          }).params,
        ).art,
      )
    let prev = Infinity
    for (const cap of [16, 12, 8, 6, 4, 2]) {
      const n = run(cap)
      assert.ok(n <= prev, `上限 ${cap} 给出 ${n} 色，比更大的上限还多（上一个 ${prev}）`)
      assert.ok(n >= 1, `色号数不该为 0（实测 ${n}）`)
      prev = n
    }
  })

  it('色号上限不影响确定性（同图同参两次同结果）', () => {
    // 两遍法引入了排序（按用量降序、并列按下标升序），排序必须稳定，
    // 否则"同图同参 → 同结果"这条核心承诺会被破坏
    const p = sanitizeParams({ paletteMode: 'preset', presetPaletteId: 'beads24', longEdge: 48, dither: 'floyd', ditherMaxColors: 8 }).params
    assert.equal(artHash(runPipeline(fixture(96, 96), p).art), artHash(runPipeline(fixture(96, 96), p).art))
  })

  it('ditherMaxColors 在 dither=none 时不生效（没有抖动就没有抖动带来的色号膨胀）', () => {
    // 语义边界：上限是"约束抖动"的，不是"约束量化"的。关抖动时设它不该改变任何东西
    const base = { paletteMode: 'preset' as const, presetPaletteId: 'beads24', longEdge: 48, cleanup: false }
    const a = artHash(runPipeline(fixture(), sanitizeParams({ ...base, dither: 'none', ditherMaxColors: 0 }).params).art)
    const b = artHash(runPipeline(fixture(), sanitizeParams({ ...base, dither: 'none', ditherMaxColors: 8 }).params).art)
    assert.equal(a, b, '关抖动时 ditherMaxColors 不应产生任何影响')
  })

  it('transparent=alpha：透明区不参与取色，且透明格可被统计', () => {
    const { params } = sanitizeParams({ transparent: 'alpha', longEdge: 48, paletteMode: 'auto', paletteK: 8 })
    const { art } = runPipeline(fixture(), params)
    const t = countTransparent(art.indices, art.alphaMask)
    assert.ok(t > 0)
    assert.ok(hasRealAlpha(art.alphaMask))
    // 用量口径：用量之和 + 透明格 = 总格数
    const sum = Object.values(countUsage(art.indices, art.palette, art.alphaMask)).reduce((a, b) => a + b, 0)
    assert.equal(sum + t, art.width * art.height)
  })

  it('transparent=none：透明区合成到底色，不产生黑边', () => {
    const { params } = sanitizeParams({ transparent: 'none', matteColor: '#ff00ff', paletteMode: 'custom', customPalette: ['#ff00ff'], longEdge: 48 })
    const { art } = runPipeline(fixture(), params)
    assert.equal(art.palette.length, 1)
    assert.equal(art.palette[0], '#ff00ff')
    assert.equal(countTransparent(art.indices, art.alphaMask), 0)
  })

  it('多级降采样：nearest 与 average 产生不同结果（两种模式都真的生效）', () => {
    const a = runPipeline(fixture(), coerceParams({ downsample: 'average', paletteMode: 'auto', paletteK: 8, longEdge: 24 })).art
    const b = runPipeline(fixture(), coerceParams({ downsample: 'nearest', paletteMode: 'auto', paletteK: 8, longEdge: 24 })).art
    assert.notEqual(artHash(a), artHash(b))
  })
})

describe('编辑算子', () => {
  it('矩形/椭圆栅格化：格数与几何一致', () => {
    assert.equal(rasterizeRect(8, 8, 2, 2, 5, 5).length, 16)
    // 10×10 外接框的实心椭圆约 π·r² —— 允许 ±10% 的栅格化误差
    const e = rasterizeEllipse(20, 20, 0, 0, 19, 19, true).length
    assert.ok(Math.abs(e - Math.PI * 100) / (Math.PI * 100) < 0.1, `椭圆面积 ${e} 偏离过大`)
  })

  it('Bresenham 直线端点在位、笔刷放大足迹', () => {
    const line = lineCells(10, 10, 0, 0, 9, 9, 1)
    assert.ok(line.includes(0))
    assert.ok(line.includes(9 * 10 + 9))
    assert.equal(line.length, 10)
    assert.equal(brushCells(10, 10, 0, 0, 3).length, 4, '角上 3×3 应被边界裁到 4 格')
  })

  it('只改 alpha 的编辑必须被记为 changed（历史缺陷回归防线）', () => {
    const r = applyOps(blankArt(4, 4, '#ffffff', false), [{ op: 'setCells', cells: [[1, 1]], erase: true }])
    assert.equal(r.applied, true)
    assert.equal(r.changes[0].changed, true)
    assert.equal(countTransparent(r.art.indices, r.art.alphaMask), 1)
  })

  it('重复挖同一个洞算「无改动」（applied=false，不产生撤销帧）', () => {
    const once = applyOps(blankArt(4, 4, '#ffffff', false), [{ op: 'setCells', cells: [[0, 0]], erase: true }])
    const twice = applyOps(once.art, [{ op: 'setCells', cells: [[0, 0]], erase: true }])
    assert.equal(twice.applied, false)
  })

  it('trim：无透明边时返回 changed=false 且不报错', () => {
    const art = blankArt(4, 4, '#ffffff', false)
    const r = applyOps(art, [{ op: 'trim' }])
    assert.equal(r.applied, false)
    assert.equal(r.art.width, 4)
  })

  it('trim：全透明画布不报错', () => {
    const r = applyOps(blankArt(4, 4, '#ffffff', true), [{ op: 'trim' }])
    assert.equal(r.applied, false)
  })

  it('transform：对称内容旋转 180° 无改动，不对称内容有改动且换宽高', () => {
    const sym = blankArt(4, 4, '#ffffff', false)
    assert.equal(applyOps(sym, [{ op: 'transform', kind: 'rotate180' }]).applied, false)
    const notch = applyOps(sym, [{ op: 'setCells', cells: [[0, 0]], color: '#000000' }]).art
    const rot = applyOps(notch, [{ op: 'transform', kind: 'rotate180' }])
    assert.equal(rot.applied, true)
    assert.notEqual(artHash(rot.art), artHash(notch))
    const tall = blankArt(3, 5, '#123456', false)
    const q = applyOps(tall, [{ op: 'transform', kind: 'rotate90' }]).art
    assert.equal(q.width, 5)
    assert.equal(q.height, 3)
  })

  it('eraseColor 只能作用于画布已有颜色（否则报错，避免"以为抠掉了"）', () => {
    const art = blankArt(4, 4, '#ffffff', false)
    assert.throws(() => applyOps(art, [{ op: 'eraseColor', color: '#123456' }]), /色板中没有/)
    const r = applyOps(art, [{ op: 'eraseColor', color: '#ffffff' }])
    assert.equal(countTransparent(r.art.indices, r.art.alphaMask), 16)
  })

  it('replaceAny：同色替换返回 changed=false，换色则整幅生效', () => {
    const art = blankArt(3, 3, '#ffffff', false)
    assert.equal(applyOps(art, [{ op: 'replaceAny', color: '#ffffff', to: '#ffffff' }]).applied, false)
    const r = applyOps(art, [{ op: 'replaceAny', color: '#ffffff', to: '#ff0000' }])
    assert.equal(r.changes[0].cells, 9)
    assert.equal(r.art.palette[r.art.indices[0]], '#ff0000')
  })

  /*
   * replaceAny 的边界。此前只有上面那一条"正常路径"断言，四条边界全裸——
   * 而 UI 的「替换为…」正是把这些错误**当作面向用户的提示**抛出去的
   * （见 src/app/index.ts 的 commitReplaced），措辞变了就说明契约变了，所以逐条钉住。
   */
  it('replaceAny 边界：源色不在色板要报错并指出原因（不静默空操作）', () => {
    const art = blankArt(2, 2, '#ffffff', false)
    assert.throws(() => applyOps(art, [{ op: 'replaceAny', color: '#123456', to: '#000000' }]), /色板中没有/)
  })

  it('replaceAny 边界：非法目标色要报错，不产出坏色板', () => {
    const art = blankArt(2, 2, '#ffffff', false)
    assert.throws(() => applyOps(art, [{ op: 'replaceAny', color: '#ffffff', to: 'not-a-color' }]), /目标色不合法/)
    assert.equal(art.palette.length, 1, '报错后不得留下被污染的色板')
  })

  it('replaceAny 边界：色板满且锁定色板时报错（拼豆不能悄悄换成买不到的颜色）', () => {
    // 造一个满色板：用 PALETTE_MAX 常量而不是抄 256，上限变了这条跟着变
    const full = Array.from({ length: PALETTE_MAX }, (_, i) => `#${(i * 257 + 1).toString(16).padStart(6, '0').slice(-6)}`)
    const art = { width: 1, height: 1, indices: new Uint8Array([0]), palette: [...full] }
    assert.throws(
      () => applyOps(art, [{ op: 'replaceAny', color: full[0], to: '#ff00ff' }], { allowApproxColor: false }),
      /色板已满/,
    )
    // 自由模式（默认 allowApproxColor: true）则退化为最近色并把这一点写进 note，而不是报错
    const r = applyOps(art, [{ op: 'replaceAny', color: full[0], to: '#ff00ff' }], { allowApproxColor: true })
    assert.equal(r.changes[0].note, '色板已满：退化为最近色')
  })

  it('replaceAny 边界：同色替换不污染色板（空操作不该改颜色表）', () => {
    // 与 spec.ts 对 outline 的既有约定一致：没有实际改动就不该往色板里塞东西
    const art = blankArt(2, 2, '#ffffff', false)
    const r = applyOps(art, [{ op: 'replaceAny', color: '#ffffff', to: '#ffffff' }])
    assert.equal(r.art.palette.length, 1)
    assert.equal(r.applied, false)
  })

  it('fill：透明格之间一律连通（洞下残留索引不同也只算一片）', () => {
    /*
     * 这条守的是"注释与实现不一致"那一类缺陷：注释写着"透明格之间也算同一连通区域"，
     * 而实现还额外要求**残留的颜色索引相同**——把两种不同颜色的像素先后挖掉之后，
     * 那片空白会被切成两块，与"把这块整片抠掉"的直觉不符（canvas 层的自制实现一直是按注释做的）。
     * 改回旧判据（比较 index）时这条会红。
     */
    const base = {
      width: 5,
      height: 1,
      indices: new Uint8Array([0, 0, 1, 1, 2]),
      palette: ['#ff0000', '#0000ff', '#00ff00'],
      // 中间两格透明，但残留索引不同（0 与 1）
      alphaMask: new Uint8Array([255, 0, 0, 255, 255]),
    }
    const r = applyOps(base, [{ op: 'fill', x: 1, y: 0, color: '#00ff00' }])
    const at = (x: number) => r.art.palette[r.art.indices[x]]
    assert.equal(at(1), '#00ff00', '起点应被填充')
    assert.equal(at(2), '#00ff00', '相邻透明格即使残留索引不同也必须算同一片（旧判据会漏掉它）')
    assert.equal(at(0), '#ff0000', '不透明格不该被串进来')
    assert.equal(at(3), '#0000ff', '不透明格不该被串进来')
    assert.equal(at(4), '#00ff00', '第四格本来就等于填充色，不应影响判定')
    // 填过的格必须变回不透明（否则"填色"结果在导出时仍是空的）。
    // 这里不能用 `alphaMask?.[1]` —— 两格填完之后整幅都变成不透明，mask 会被归一成 null
    // （等价但更省内存），拿它取下标只会得到 undefined（这条断言我第一版就写错了）。
    assert.equal(countTransparent(r.art.indices, r.art.alphaMask), 0, '被填充的透明格应变回不透明')
  })

  it('fill：不透明区域仍要求同色（否则整幅会串成一片）', () => {
    const base = {
      width: 4,
      height: 1,
      indices: new Uint8Array([0, 0, 1, 0]),
      palette: ['#ff0000', '#0000ff', '#00ff00'],
      alphaMask: null,
    }
    const r = applyOps(base, [{ op: 'fill', x: 0, y: 0, color: '#00ff00' }])
    const at = (x: number) => r.art.palette[r.art.indices[x]]
    assert.equal(at(0), '#00ff00')
    assert.equal(at(1), '#00ff00', '同色相邻应一起填')
    assert.equal(at(2), '#0000ff', '不同色的不透明格必须断开')
    assert.equal(at(3), '#ff0000', '被不同色隔开的同色格不该被连上')
  })

  it('未知算子报错（静默忽略会让 agent 误判）', () => {
    // 故意传一个不在 EditOp 联合类型里的算子：模拟 agent 拼错算子名
    const bogus = [{ op: 'nope' }] as unknown as EditOp[]
    assert.throws(() => applyOps(blankArt(2, 2, '#000000', false), bogus), /未知算子/)
  })

  it('outline：只往空格描完整一圈，已有内容不被覆盖', () => {
    // 8×8 透明画布中央一个 2×2 实心块
    const base = applyOps(blankArt(8, 8, '#ffffff', true), [
      { op: 'rect', x0: 3, y0: 3, x1: 4, y1: 4, color: '#e94560' },
    ]).art
    const outlined = applyOps(base, [{ op: 'outline', color: '#1a1a2e' }])
    assert.equal(outlined.changes[0].changed, true)
    // 默认 8 邻 = 完整外圈：4×4 外框 16 格减 4 格本体 = 12 格
    assert.equal(outlined.changes[0].cells, 12, `完整外圈应为 12 格，实际 ${outlined.changes[0].cells}`)
    // 本体颜色不被覆盖
    assert.equal(outlined.art.palette[outlined.art.indices[3 * 8 + 3]], '#e94560', '描边不得覆盖已有内容')
    // 再描一遍会把刚描的一圈当成内容继续往外扩——这是"扩张"语义的正确行为，不是缺陷；
    // 真正要防的是"同一次调用里叠出双圈"（下面那条断言）。
    const twice = applyOps(outlined.art, [{ op: 'outline', color: '#1a1a2e' }])
    assert.ok(twice.changes[0].cells > 12, '再描一遍应向外扩，而不是原地重复')
  })

  it('outline：同一次调用里连写两次也只描一圈（不会叠出双圈）', () => {
    const base = applyOps(blankArt(8, 8, '#ffffff', true), [
      { op: 'rect', x0: 3, y0: 3, x1: 4, y1: 4, color: '#e94560' },
    ]).art
    const r = applyOps(base, [
      { op: 'outline', color: '#1a1a2e' },
      { op: 'outline', color: '#1a1a2e' },
    ])
    assert.equal(r.changes[0].cells, 12, `第一遍应描 12 格，实际 ${r.changes[0].cells}`)
    assert.equal(r.changes[1].cells, 20, `第二遍会向外扩一圈（20 格），实际 ${r.changes[1].cells}`)
    assert.equal(r.changes[1].changed, true, '扩张是真改动，必须如实报告')
  })

  it('outline：connectivity 决定斜角留不留空，offset 决定向外几圈', () => {
    const base = applyOps(blankArt(9, 9, '#ffffff', true), [
      { op: 'rect', x0: 4, y0: 4, x1: 4, y1: 4, color: '#e94560' },
    ]).art
    // 单个像素：4 邻只有上下左右四格；8 邻是一整圈八格
    const c4 = applyOps(base, [{ op: 'outline', color: '#000000', connectivity: 4 }])
    const c8 = applyOps(base, [{ op: 'outline', color: '#000000', connectivity: 8 }])
    assert.equal(c4.changes[0].cells, 4, `4 邻应为 4 格，实际 ${c4.changes[0].cells}`)
    assert.equal(c8.changes[0].cells, 8, `8 邻应为 8 格（完整一圈），实际 ${c8.changes[0].cells}`)
    // 两圈 = 3×3 外框 8 格 + 5×5 外框 16 格 = 24（中心 1 格是本体，不算）
    const two = applyOps(base, [{ op: 'outline', color: '#000000', offset: 2 }])
    assert.equal(two.changes[0].cells, 24, `两圈应为 24 格，实际 ${two.changes[0].cells}`)
  })

  it('outline：画布已满时返回 changed=false（无处可描）', () => {
    const full = blankArt(4, 4, '#ffffff', false)
    const r = applyOps(full, [{ op: 'outline', color: '#000000' }])
    assert.equal(r.applied, false, '没有空格可描时应报告无改动')
  })

  it('sprite 预设必须关掉杂色清理（否则 1px 高光/眼神会被当噪点吃掉）', () => {
    const sprite = STYLE_PRESETS.find((s) => s.id === 'sprite')
    assert.ok(sprite, 'sprite 预设必须存在')
    assert.equal(sprite.params.cleanup, false, '像素资产预设不能开 cleanup：它会把 1px 细节并入邻色')
    assert.equal(sprite.params.downsample, 'nearest', '像素资产应用最近邻，区域平均会造出源图没有的混合色')
    assert.equal(sprite.params.transparent, 'alpha', '像素资产要保留原始透明')
  })

  it('mirror：原内容保留、副本贴边保持左右留白对称', () => {
    // 内容贴在左边缘 2 格：镜像副本应贴右边缘 2 格，两侧留白相等
    const base = applyOps(blankArt(10, 4, '#ffffff', true), [
      { op: 'rect', x0: 0, y0: 1, x1: 1, y1: 2, color: '#e94560' },
    ]).art
    const r = applyOps(base, [{ op: 'mirror', kind: 'h', color: '#e94560' }])
    assert.equal(r.changes[0].changed, true)
    assert.equal(r.changes[0].cells, 4, `副本应为 4 格，实际 ${r.changes[0].cells}`)
    const at = (x: number, y: number): number => r.art.indices[y * 10 + x]
    assert.equal(r.art.palette[at(0, 1)], '#e94560', '原内容必须保留在原位')
    assert.equal(r.art.palette[at(9, 1)], '#e94560', '副本应贴到右边缘（与左侧留白对称）')
    assert.equal(r.art.palette[at(8, 1)], '#e94560', '副本宽 2 格')
    assert.notEqual(r.art.palette[at(5, 1)], '#e94560', '中线附近不该被误填')
  })

  it('mirror：副本里的透明格不落笔（否则会把原内容抹掉一半）', () => {
    // 左半有内容、右半全透明，中间竖着一条"洞"
    const base = applyOps(blankArt(6, 2, '#ffffff', true), [
      { op: 'rect', x0: 0, y0: 0, x1: 0, y1: 1, color: '#e94560' },
      { op: 'rect', x0: 3, y0: 0, x1: 3, y1: 1, color: '#e94560' },
    ]).art
    const r = applyOps(base, [{ op: 'mirror', kind: 'h', color: '#e94560' }])
    // 两列已有内容（x=0 与 x=3），镜像后落在 x=5 与 x=2：四列实色 = 8 格，其余 4 格透明
    const transparent = countTransparent(r.art.indices, r.art.alphaMask)
    assert.equal(transparent, 4, `6×2 共 12 格、四列实色，应余 4 格透明，实际 ${transparent}`)
    const at = (x: number, y: number): number => r.art.indices[y * 6 + x]
    assert.equal(r.art.palette[at(0, 0)], '#e94560', '原内容必须留着')
    assert.equal(r.art.palette[at(5, 0)], '#e94560', '副本应落在 x=5')
    assert.equal(r.art.palette[at(2, 0)], '#e94560', '副本应落在 x=2')
  })

  it('spec.ts 列出的算子与实现完全一致（漂移会被这条抓住）', () => {
    // 每个 spec 里的算子都必须被实现接受（不抛「未知算子」）
    const art = blankArt(6, 6, '#ffffff', true)
    for (const spec of OP_SPECS) {
      const op = sampleOp(spec.op)
      try {
        applyOps(art, [op], { fallbackColor: '#000000' })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        assert.ok(!/未知算子/.test(message), `spec 里有实现未处理的算子：${spec.op}`)
        // 其它错误（如色板里没有该色）是合理的参数问题，不算漂移
      }
    }
    assert.equal(OP_SPECS.length, 13, '算子数量变化时必须同步文档与测试')
  })

  it('anchorOffset 给出内容相对画布中心的偏移', () => {
    const art = blankArt(8, 8, '#ffffff', true)
    const filled = applyOps(art, [{ op: 'rect', x0: 0, y0: 0, x1: 1, y1: 1, color: '#000000' }]).art
    const off = anchorOffset(filled, 'center')
    assert.ok(off.offsetX < 0 && off.offsetY < 0, '内容在左上时中心偏移应为负')
  })
})

function sampleOp(op: string): EditOp {
  switch (op) {
    case 'fill':
      return { op: 'fill', x: 0, y: 0, color: '#000000' }
    case 'setCells':
      return { op: 'setCells', cells: [[0, 0]], color: '#000000' }
    case 'setAll':
      return { op: 'setAll', color: '#000000' }
    case 'line':
      return { op: 'line', x0: 0, y0: 0, x1: 3, y1: 3, color: '#000000' }
    case 'rect':
      return { op: 'rect', x0: 0, y0: 0, x1: 2, y1: 2, color: '#000000' }
    case 'ellipse':
      return { op: 'ellipse', x0: 0, y0: 0, x1: 3, y1: 3, color: '#000000' }
    case 'transform':
      return { op: 'transform', kind: 'flipX' }
    case 'trim':
      return { op: 'trim' }
    case 'fit':
      return { op: 'fit', width: 4, height: 4 }
    case 'eraseColor':
      return { op: 'eraseColor', color: '#ffffff' }
    case 'replaceAny':
      return { op: 'replaceAny', color: '#ffffff', to: '#000000' }
    case 'outline':
      return { op: 'outline', color: '#000000' }
    case 'mirror':
      return { op: 'mirror', kind: 'h', color: '#000000' }
    default:
      // 只有 spec 与实现漂移时才会走到这里：返回一个必然报错的算子，让断言给出明确信息
      return { op } as unknown as EditOp
  }
}


/*
 * ============================================================
 *  质量度量（core/quality.ts）与自动调参（core/auto-tune.ts）
 * ============================================================
 */

describe('质量度量（core/quality.ts）', () => {
  /** 多色渐变图：色号数与保真度都会随参数明显变化，适合验证度量 */
  const grad = () => fixture(96, 96)
  const run = (patch: Record<string, unknown>) => {
    const params = sanitizeParams({
      paletteMode: 'preset',
      presetPaletteId: 'beads24',
      longEdge: 48,
      cleanup: false,
      ...patch,
    }).params
    return { params, art: runPipeline(grad(), params).art }
  }

  it('保真误差随色号数单调下降（k 越大越准——这是度量的基本自洽性）', () => {
    // 若这条不成立，说明度量测的不是"像不像"，后面的 auto-tune 也就没有意义
    let prev = Infinity
    for (const k of [4, 8, 16, 32]) {
      const { params, art } = run({ paletteMode: 'auto', paletteK: k, presetPaletteId: undefined })
      const q = qualityReport(grad(), art, { paletteMode: 'auto', presetPaletteId: '' })
      assert.ok(q.fidelity.mean <= prev, `k=${k} 的误差 ${q.fidelity.mean.toFixed(4)} 比更小的 k 还大（上一个 ${prev.toFixed(4)}）`)
      prev = q.fidelity.mean
      void params
    }
  })

  it('块平均误差与逐格误差是**两个不同的数**，且抖动下块平均明显更小（指标陷阱的防线）', () => {
    /*
     * 这条守住文件头记录的那个陷阱：抖动**故意**让单格偏离，却让观感更接近原图。
     * 实测：逐格误差 floyd 0.112 > none 0.086（看起来更差），
     *       块平均 floyd 0.038 < none 0.075（实际好一倍）。
     * 若哪天有人把 blockFidelity 实现成"逐格的别名"（例如忘了按块平均就比），
     * 这条会红——而那是会让人**关掉抖动**的错误结论。
     */
    const noneArt = run({ dither: 'none' }).art
    const floydArt = run({ dither: 'floyd' }).art
    const qn = qualityReport(grad(), noneArt, { paletteMode: 'preset', presetPaletteId: 'beads24' })
    const qf = qualityReport(grad(), floydArt, { paletteMode: 'preset', presetPaletteId: 'beads24' })
    assert.ok(qf.fidelity.mean > qn.fidelity.mean, '抖动应让逐格误差变大（它故意让单格偏离）')
    assert.ok(qf.blockFidelity.mean < qn.blockFidelity.mean, `抖动应让块平均误差变小（观感更好），实测 floyd ${qf.blockFidelity.mean.toFixed(4)} vs none ${qn.blockFidelity.mean.toFixed(4)}`)
  })

  it('透明格不计入保真统计（它们没有颜色可谈）', () => {
    const params = sanitizeParams({ paletteMode: 'auto', paletteK: 8, longEdge: 32, transparent: 'alpha' }).params
    const art = runPipeline(fixture(64, 48), params).art
    const q = qualityReport(fixture(64, 48), art, { paletteMode: 'auto', presetPaletteId: '' })
    assert.ok(q.transparentCells > 0, '测试图有味明块，应统计到透明格')
    assert.equal(q.fidelity.cells + q.transparentCells, art.width * art.height, '不透明格 + 透明格 = 总格数')
  })

  it('抖动代价如实上报：开抖动时 usedColors 增加、ditherExtraColors 为正', () => {
    const noDither = run({ dither: 'none' }).art
    const noUse = new Set([...noDither.indices]).size
    const { art } = run({ dither: 'bayer8' })
    const q = qualityReport(grad(), art, { paletteMode: 'preset', presetPaletteId: 'beads24' }, { noDitherBaseline: { usedColors: noUse } })
    assert.ok(q.ditherExtraColors > 0, `bayer8 应比关抖动用更多色号（实测 ${q.usedColors} vs ${noUse}）`)
  })

  it('珠子数与重量复用 bead.ts 的口径（不另算一套）', () => {
    // 两处口径若分叉，就会出现"报告说 1024 颗、清单印 1100 颗"这种矛盾
    const { art } = run({})
    const q = qualityReport(grad(), art, { paletteMode: 'preset', presetPaletteId: 'beads24' })
    const rep = beadReport(art, { codes: getPreset('beads24')?.codes })
    assert.equal(q.beads, rep.totalBeads)
    assert.equal(q.grams, Number(rep.totalGrams.toFixed(2)))
  })
})

describe('自动调参（core/auto-tune.ts）', () => {
  const base = () => sanitizeParams({ paletteMode: 'preset', presetPaletteId: 'beads24', longEdge: 32 }).params
  const src = () => fixture(96, 96)

  it('确定性：同图同参两次搜索得到**完全相同**的最优解（本项目核心承诺）', () => {
    /*
     * 搜索是最容易引入不确定性的地方（排序并列、遍历顺序）。这条守住它。
     * 实现里有四道防线：不用随机、固定遍历顺序、排序末级用参数签名裁决、只调纯函数。
     * 变异验证：把排序末级的签名裁决去掉，本图下可能仍偶然一致——所以下面还断言 evaluated 数一致。
     */
    const a = autoTune(src(), base(), { maxColors: 12 })
    const b = autoTune(src(), base(), { maxColors: 12 })
    assert.equal(tuneSummary(a), tuneSummary(b), '两次搜索的摘要必须完全一致')
    assert.equal(a.evaluated, b.evaluated)
  })

  it('硬约束：有可行解时，最优解一定不超过色号上限', () => {
    // 这是"自动调参"存在的意义——用户设了"我只有 12 种豆子"，返回的方案就必须能用
    for (const cap of [8, 12, 16]) {
      const r = autoTune(src(), base(), { maxColors: cap })
      if (r.feasible) {
        assert.ok(r.best.usedColors <= cap, `上限 ${cap} 却给出 ${r.best.usedColors} 色`)
      }
    }
  })

  it('无解时仍守住上限（把上限下沉成 ditherMaxColors），并如实标记 feasible=false', () => {
    /*
     * 无解的正确处理不是"挑个最好的凑数"——那会给用户一个超过上限的方案，等于没解决问题。
     * 实现是**把上限下沉成 ditherMaxColors**（两遍法硬保证 ≤N），观感变差但约束守住，
     * 并用 feasible:false 如实说明。变异验证：去掉下沉那段，本条的 usedColors 断言立刻红。
     */
    const r = autoTune(src(), base(), { maxColors: 2 })
    assert.equal(r.feasible, false, '上限 2 色应判定为无解')
    assert.ok(r.best.usedColors <= 2, `无解时仍必须守住上限 2，实测 ${r.best.usedColors} 色`)
  })

  it('放宽上限不会让观感变差（约束越松，块平均误差不增）', () => {
    // 否则说明搜索在"约束更松时反而选了更差的方案"，那是排序规则写反了
    const r12 = autoTune(src(), base(), { maxColors: 12 })
    const r24 = autoTune(src(), base(), { maxColors: 24 })
    assert.ok(r24.best.blockError <= r12.best.blockError + 1e-9, `上限 24 的块平均 ${r24.best.blockError.toFixed(4)} 比上限 12 的 ${r12.best.blockError.toFixed(4)} 还差`)
  })

  it('top 里没有"产物等价"的重复项（参数不同但结果相同的要去重）', () => {
    /*
     * 实测踩过：不去重时 top 3 会印出三行一模一样的最优，看着像 bug 也让人无法比较方案。
     * 判据是 (块误差, 色号数, 珠子数) 三元组。
     */
    const r = autoTune(src(), base(), { maxColors: 12 })
    const keys = r.top.map((c) => `${c.blockError.toFixed(6)}|${c.usedColors}|${c.beads}`)
    assert.equal(new Set(keys).size, keys.length, `top 里有等价重复项：${keys.join(' / ')}`)
  })

  it('preset 档下不搜 paletteK（它不影响任何结果，搜它只会产生重复候选）', () => {
    /*
     * paletteK 只在 paletteMode='auto' 时生效。preset 档下把它放进搜索空间，
     * 会让候选数凭空 ×5 而结果完全一样（且 top3 全是同一行）。
     */
    const preset = autoTune(src(), base(), { maxColors: 12 })
    const auto = autoTune(src(), sanitizeParams({ paletteMode: 'auto', paletteK: 16, longEdge: 32 }).params, { maxColors: 12 })
    // preset 档：1 长边（尺寸不入搜索）× 1 paletteK × 4 抖动 × 2 清理 = 8
    assert.equal(preset.evaluated, 8, `preset 档应只评估 8 组，实测 ${preset.evaluated}`)
    // auto 档：1 × 5 × 4 × 2 = 40
    assert.equal(auto.evaluated, 40, `auto 档应评估 40 组，实测 ${auto.evaluated}`)
  })

  it('尺寸不被搜索改写：`--long-edge N` 就是要 N 格，绝不能被候选档位盖掉', () => {
    /*
     * 这是本轮修的真实缺陷（外部 agent 报告 + 实测复现）：
     *   `--long-edge 58 --auto-tune 14` 的产物是 **24×18**，而 `--json` 里
     *   `params.longEdge` 还写着 58——参数被静默丢弃、报告回显**输入值**。
     *   拼豆用户按板数算好 58 格，拿到 24 格等于图白做；agent 还会照 58 写下游逻辑。
     *   正好撞在 AGENTS.md 那条"别把命令成功当成参数生效"上。
     *
     * 变异验证：让尺寸重新进搜索（把 `DEFAULT_TUNE_SPACE.longEdge` 填回档位数组），本段立刻红。
     */
    for (const le of [24, 58, 96]) {
      const p = sanitizeParams({ paletteMode: 'preset', presetPaletteId: 'beads24', longEdge: le }).params
      const r = autoTune(src(), p, { maxColors: 12 })
      assert.equal(r.best.params.longEdge, le, `请求 longEdge=${le}，搜索却改成了 ${r.best.params.longEdge}`)
    }
  })

  it('尺寸维度不进搜索：候选数只由 抖动×清理 决定（也顺带更快）', () => {
    // 尺寸已定，搜索空间就该只剩"抖动 4 档 × 清理 2 档 = 8 组"。
    // 这条同时守住"别哪天又把尺寸维度悄悄加回来"。
    const r = autoTune(src(), base(), { maxColors: 12 })
    assert.equal(r.evaluated, 8, `尺寸不入搜索时应评估 8 组，实测 ${r.evaluated}`)
  })

  it('searchLongEdge 是显式开关：打开才会搜尺寸（此时结果不可靠，仅供实验）', () => {
    /*
     * 保留出口但**默认关闭**，因为跨尺寸没有可靠判据：
     * `blockError` 与 `usedColors` 都随画布变小而变小（实测块平均 24→0.0356 对 96→0.0570；
     * 色号 24→87 色对 96→102 色），拿它们跨尺寸排序必然坍缩到最小档——
     * 用户要"像"，拿到"糊"，报告还写着"观感最好的组合"。
     * 这里只断言"开关有效"，不断言选出的尺寸（那个结果本身就不可信）。
     */
    const r = autoTune(src(), base(), { maxColors: 12, searchLongEdge: true })
    assert.equal(r.evaluated, 40, `打开 searchLongEdge 应评估 5 尺寸 × 4 抖动 × 2 清理 = 40 组，实测 ${r.evaluated}`)
  })
})

/*
 * ----------------------------------------------------------------
 *  视口数学（core/viewport.ts）
 * ----------------------------------------------------------------
 *
 * 这个模块的 docblock 自称"最容易算错又最难肉眼发现"（差半格、缩放漂移、
 * "以鼠标为中心"实际以左上角为中心），**但它此前一条单测都没有**——
 * 只有 e2e 间接覆盖（放大镜显示、绘制落点），而那些断言查的是"有没有画出来"，
 * 不是"坐标对不对"。落差半格在 8px 格子上看不出来，判定框选边界时就是错一格。
 *
 * 下面按"能因为什么真实缺陷而红"来写，不是复述实现。
 */
describe('视口数学（core/viewport.ts）', () => {
  it('clampCell：非法输入回退 1，越界夹到 [MIN_CELL, MAX_CELL]', () => {
    // NaN 的常见来源是"容器还没布局（尺寸 0）时算比例"——回退 1 而不是 NaN，
    // 否则 NaN 会顺着 ox/oy 污染成 NaN 坐标，整幅画消失（比崩溃更难查）
    assert.equal(clampCell(Number.NaN), 1)
    assert.equal(clampCell(Number.POSITIVE_INFINITY), 1)
    assert.equal(clampCell(0), MIN_CELL)
    assert.equal(clampCell(-5), MIN_CELL)
    assert.equal(clampCell(1e6), MAX_CELL)
    assert.equal(clampCell(8), 8)
  })

  it('fitViewState：整幅图放进容器且居中（四周留白相等、不溢出）', () => {
    const v = fitViewState(32, 32, 400, 300, 20)
    // 可用区 = 400-40 = 360 宽、300-40 = 260 高 → 取小的那个 → 260/32 = 8.125
    assert.ok(Math.abs(v.cell - 260 / 32) < 1e-9, "cell 应为 " + 260 / 32 + "，实际 " + v.cell)
    const leftGap = v.ox
    const rightGap = 400 - (v.ox + 32 * v.cell)
    assert.ok(Math.abs(leftGap - rightGap) <= 1, "左右留白应相等：" + leftGap + " vs " + rightGap)
    const topGap = v.oy
    const bottomGap = 300 - (v.oy + 32 * v.cell)
    assert.ok(Math.abs(topGap - bottomGap) <= 1, "上下留白应相等：" + topGap + " vs " + bottomGap)
    assert.ok(v.ox >= 0 && v.oy >= 0, "起点不应为负（会画到容器外）")
    assert.ok(v.ox + 32 * v.cell <= 400 && v.oy + 32 * v.cell <= 300, "不应超出容器")
  })

  it('fitViewState：非方形容器按**短边**受限（取错方向就会溢出）', () => {
    const wide = fitViewState(16, 16, 1000, 200, 10)
    assert.ok(Math.abs(wide.cell - (200 - 20) / 16) < 1e-9, "宽容器应受高度限制，实际 cell=" + wide.cell)
    const tall = fitViewState(16, 16, 200, 1000, 10)
    assert.ok(Math.abs(tall.cell - (200 - 20) / 16) < 1e-9, "高容器应受宽度限制，实际 cell=" + tall.cell)
  })

  it('fitViewState：容器极小或为 0 时不产出 NaN（未布局时的早期调用）', () => {
    // 真实场景：面板刚建、容器还没布局（clientWidth = 0）时就调了一次 fit
    for (const pair of [[0, 0], [1, 1], [10, 10]]) {
      const v = fitViewState(64, 64, pair[0], pair[1])
      assert.ok(Number.isFinite(v.cell) && v.cell > 0, "容器 " + pair[0] + "x" + pair[1] + " 时 cell 非法：" + v.cell)
      assert.ok(Number.isFinite(v.ox) && Number.isFinite(v.oy), "容器 " + pair[0] + "x" + pair[1] + " 时原点非法")
    }
  })

  it('zoomAtPoint：锚点处的画布位置**缩放前后不变**（以鼠标为中心的实质）', () => {
    /*
     * 这是整个模块最核心的一条不变量。写错的典型表现是"缩放时画面往左上角跑"——
     * 用户会说"滚轮缩放跳一下"，但没人能一眼看出是公式里少了减号。
     * 验法：取锚点对应的"画布格子坐标"，缩放前后应当相同。
     */
    const v0 = { cell: 8, ox: 100, oy: 50 }
    const mx = 260
    const my = 170
    const before = pointToCellClamped(v0, mx, my, 1000, 1000)
    const v1 = zoomAtPoint(v0, mx, my, 2)
    assert.ok(Math.abs(v1.cell - 16) < 1e-9, "cell 应翻倍，实际 " + v1.cell)
    const after = pointToCellClamped(v1, mx, my, 1000, 1000)
    assert.ok(before && after, "两次换算都应成功")
    assert.equal(after!.x, before!.x, "缩放后锚点处格子 x 应不变：" + before!.x + " → " + after!.x)
    assert.equal(after!.y, before!.y, "缩放后锚点处格子 y 应不变：" + before!.y + " → " + after!.y)
  })

  it('zoomAtPoint：到上下限时**原样返回**，不做半次缩放', () => {
    // 触顶时若仍改 ox/oy 而不改 cell，画面会平移——用户看到"滚轮还在动但没放大"
    const atMax = { cell: MAX_CELL, ox: 10, oy: 20 }
    assert.deepEqual(zoomAtPoint(atMax, 100, 100, 2), atMax, "已达上限应原样返回")
    const atMin = { cell: MIN_CELL, ox: 10, oy: 20 }
    assert.deepEqual(zoomAtPoint(atMin, 100, 100, 0.5), atMin, "已达下限应原样返回")
  })

  it('pointToCellClamped：越界**夹到边界**而不是返回 null（从画布外起手拖拽）', () => {
    /*
     * 守住 docblock 里写明的设计决定：用户从面板空白处按下去、一路拖进画布是常见操作，
     * 若在这里返 null，"从外面起手"就失效（旧项目为此返工过两次）。
     * 变异验证：把夹紧改成 return null，这条立刻红。
     */
    const v = { cell: 10, ox: 0, oy: 0 }
    assert.deepEqual(pointToCellClamped(v, -50, -50, 8, 8), { x: 0, y: 0 }, "左上越界夹到 (0,0)")
    assert.deepEqual(pointToCellClamped(v, 500, 500, 8, 8), { x: 7, y: 7 }, "右下越界夹到 (7,7)")
    assert.deepEqual(pointToCellClamped(v, 5, 5, 8, 8), { x: 0, y: 0 }, "格内取整")
    assert.deepEqual(pointToCellClamped(v, 15, 25, 8, 8), { x: 1, y: 2 }, "第二列第三行")
  })

  it('pointToCellClamped：非法尺寸返回 null（此时任何坐标都没有意义）', () => {
    const v = { cell: 10, ox: 0, oy: 0 }
    assert.equal(pointToCellClamped(v, 5, 5, 0, 8), null, "cols=0 应返 null")
    assert.equal(pointToCellClamped(v, 5, 5, 8, 0), null, "rows=0 应返 null")
    // cell=0 会让除法变 Infinity ——"还没 fit 过"的真实状态
    assert.equal(pointToCellClamped({ cell: 0, ox: 0, oy: 0 }, 5, 5, 8, 8), null, "cell=0 应返 null")
  })

  it('pointToCellClamped：格子边界归属**右下**那格（与绘制落点一致）', () => {
    // 用 floor 而不是 round：否则每格中心附近会偏差半格，画细线时表现为"描边偏一像素"
    const v = { cell: 10, ox: 0, oy: 0 }
    assert.deepEqual(pointToCellClamped(v, 0, 0, 8, 8), { x: 0, y: 0 }, "左上角属第 0 格")
    assert.deepEqual(pointToCellClamped(v, 9.99, 9.99, 8, 8), { x: 0, y: 0 }, "格内右下沿仍属第 0 格")
    assert.deepEqual(pointToCellClamped(v, 10, 10, 8, 8), { x: 1, y: 1 }, "恰好跨边界属第 1 格")
  })
})

describe('导出与序列化', () => {
  it('PNG 编解码往返：像素逐位一致、放大倍数是最近邻复制', () => {
    const art = blankArt(3, 2, '#3366cc', false)
    const decoded = decodePngNode(artToPngBytesNode(art, 4))
    assert.equal(decoded.width, 12)
    assert.equal(decoded.height, 8)
    assert.equal(decoded.data[0], 0x33)
    assert.equal(decoded.data[1], 0x66)
    assert.equal(decoded.data[2], 0xcc)
    assert.equal(decoded.data[3], 255)
  })

  it('PNG 编码器兼容 3 通道解码（自写解码器必须能读回自己写的 RGBA）', () => {
    const img = { width: 2, height: 2, data: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]) }
    const back = decodePngNode(encodePngNode(img))
    assert.deepEqual([...back.data], [...img.data])
  })

  it('hardenAlpha 把半透明压成 0/255（像素画不该有羽化边）', () => {
    const img = { width: 1, height: 1, data: new Uint8ClampedArray([10, 20, 30, 100]) }
    assert.equal(hardenAlpha(img).data[3], 0)
    assert.equal(hardenAlpha({ ...img, data: new Uint8ClampedArray([10, 20, 30, 200]) }).data[3], 255)
  })

  it('base64 往返（无 Buffer 依赖）', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 42])
    assert.deepEqual([...base64ToBytes(bytesToBase64(bytes))], [...bytes])
  })

  it('项目 JSON 往返：尺寸/色板/索引/alpha 全部保真', () => {
    const art = applyOps(blankArt(4, 4, '#112233', true), [
      { op: 'rect', x0: 1, y0: 1, x1: 3, y1: 3, color: '#ff0000' },
    ]).art
    const parsed = parseProjectFile(projectJSONString(art, DEFAULT_PARAMS))
    assert.equal(parsed.art.width, 4)
    assert.deepEqual(parsed.art.palette, art.palette)
    assert.deepEqual([...parsed.art.indices], [...art.indices])
    assert.deepEqual([...(parsed.art.alphaMask ?? [])], [...(art.alphaMask ?? [])])
  })

  it('项目 JSON 严格校验：越界索引/长度不符/色板非法都要报错', () => {
    const art = blankArt(2, 2, '#000000', false)
    const good = JSON.parse(projectJSONString(art, DEFAULT_PARAMS))
    assert.throws(() => parseProjectFile(JSON.stringify({ ...good, width: 3 })), /长度不符/)
    assert.throws(() => parseProjectFile(JSON.stringify({ ...good, palette: ['#zzzzzz'] })), /非法颜色/)
    assert.throws(() => parseProjectFile(JSON.stringify({ ...good, version: 99 })), /不支持的项目版本/)
    const bad = { ...good, indices: bytesToBase64(new Uint8Array([9, 0, 0, 0])) }
    assert.throws(() => parseProjectFile(JSON.stringify(bad)), /不存在的色板索引/)
  })

  it('pixbin 往返（大画布高速通道）', () => {
    const art = applyOps(blankArt(5, 3, '#abcdef', true), [{ op: 'rect', x0: 0, y0: 0, x1: 1, y1: 1, color: '#000000' }]).art
    const bytes = encodePixBin(art)
    // 结构断言：头里每个字段独立可读（只测"往返一致"抓不到字段互相覆盖这类 bug）
    assert.equal(String.fromCharCode(...bytes.slice(0, 5)), 'PIXB1')
    assert.equal(bytes.length, 12 + art.indices.length + art.indices.length)
    const back = decodePixBin(bytes, art.palette)
    assert.equal(back.width, 5, '头里的宽度应能被独立读出')
    assert.equal(back.height, 3, '头里的高度应能被独立读出')
    assert.deepEqual([...back.indices], [...art.indices])
    assert.deepEqual([...(back.alphaMask ?? [])], [...(art.alphaMask ?? [])])
  })

  it('pixbin：无 alpha 时不写 alpha 段，尺寸非法时报错', () => {
    const art = blankArt(4, 2, '#abcdef', false)
    const bytes = encodePixBin(art)
    assert.equal(bytes[5], 0, 'flags 应为 0')
    assert.equal(bytes.length, 12 + 8)
    assert.throws(() => decodePixBin(bytes.slice(0, 8), art.palette), /数据过短/)
    const broken = bytes.slice()
    broken[6] = 0
    broken[7] = 0
    assert.throws(() => decodePixBin(broken, art.palette), /尺寸非法/)
  })

  it('像素 JSON：透明格为 null，用量表不含透明格', () => {
    const art = applyOps(blankArt(2, 2, '#ff0000', true), [{ op: 'setCells', cells: [[0, 0]], color: '#ff0000' }]).art
    const json = JSON.parse(pixelJSONString(art))
    assert.equal(json.pixels[0], '#ff0000')
    assert.equal(json.pixels[1], null)
    assert.equal(json.transparentCells, 3)
    assert.deepEqual(json.usage, { '#ff0000': 1 })
  })

  it('图集布局：帧互不重叠、尺寸等于网格外框', () => {
    const sheet = layoutSheet(Array.from({ length: 7 }, (_, i) => ({ name: `f${i}`, width: 16, height: 16 })), 3, 2)
    assert.equal(sheet.columns, 3)
    assert.equal(sheet.rows, 3)
    assert.equal(sheet.width, 3 * 16 + 2 * 2)
    const seen = new Set()
    for (const f of sheet.frames) {
      assert.ok(!seen.has(`${f.x},${f.y}`), '帧重叠')
      seen.add(`${f.x},${f.y}`)
      assert.ok(f.x >= 0 && f.y >= 0 && f.x + f.width <= sheet.width && f.y + f.height <= sheet.height, '帧越界')
    }
  })

  it('图集：默认列数为 ceil(sqrt(n))（自动排布不退化）', () => {
    const sheet = layoutSheet(Array.from({ length: 9 }, (_, i) => ({ name: `f${i}`, width: 8, height: 8 })), 0, 0)
    assert.equal(sheet.columns, 3)
    assert.equal(sheet.rows, 3)
  })
})

describe('图集切片', () => {
  /** 2×2 的纯色块网格铺在一张图上（每块 3×3），块间留 1px 透明缝 */
  function atlasWithGaps() {
    const cw = 3, ch = 3, gap = 1, cols = 2, rows = 2
    const w = cols * cw + (cols - 1) * gap
    const h = rows * ch + (rows - 1) * gap
    const data = new Uint8ClampedArray(w * h * 4)
    const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]]
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const col = colors[r * cols + c]
        const ox = c * (cw + gap)
        const oy = r * (ch + gap)
        for (let y = 0; y < ch; y++)
          for (let x = 0; x < cw; x++) {
            const i = ((oy + y) * w + (ox + x)) * 4
            data[i] = col[0]; data[i + 1] = col[1]; data[i + 2] = col[2]; data[i + 3] = 255
          }
      }
    return { width: w, height: h, data }
  }

  it('按网格切片：块数、尺寸、命名都对，像素逐块搬对', () => {
    const src = { width: 8, height: 4, data: new Uint8ClampedArray(8 * 4 * 4) }
    // 左上角画一个红点，只有第 0 块该有
    src.data[0] = 255; src.data[3] = 255
    const pieces = sliceByGrid(src, 4, 2, { baseName: 'a' })
    assert.equal(pieces.length, 8)
    assert.equal(pieces[0].image.width, 2)
    assert.equal(pieces[0].image.height, 2)
    assert.equal(pieces[0].name, 'a_00')
    assert.equal(pieces[7].name, 'a_07')
    assert.equal(pieces[0].image.data[0], 255, '第 0 块应含那个红点')
    assert.equal(pieces[1].image.data[0], 0, '第 1 块不该有红')
  })

  it('不能整除时抛错并指名（不许静默丢掉余下像素）', () => {
    const src = { width: 7, height: 4, data: new Uint8ClampedArray(7 * 4 * 4) }
    assert.throws(() => sliceByGrid(src, 4, 2), /无法被 4×2 网格整除/)
    assert.throws(() => sliceByGrid(src, 0, 2), /正整数/)
  })

  it('auto 靠全透明缝自动推断网格', () => {
    const pieces = sliceAuto(atlasWithGaps(), { baseName: 't' })
    assert.equal(pieces.length, 4, '2×2 图集应切出 4 块')
    for (const p of pieces) {
      assert.equal(p.image.width, 3, '每块宽应等于内容块宽 3（不含缝）')
      assert.equal(p.image.height, 3, '每块高应等于内容块高 3')
    }
  })

  it('auto 对尺寸不等的稀疏内容报错（宁可不切也不切错）', () => {
    const w = 8, h = 8
    const data = new Uint8ClampedArray(w * h * 4)
    const fill = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) data[(y * w + x) * 4 + 3] = 255
    }
    fill(0, 0, 1, 1)   // 2×2 块
    fill(5, 5, 7, 7)   // 3×3 块（尺寸不等）
    assert.throws(() => sliceAuto({ width: w, height: h, data }), /规整图集|尺寸不等/)
  })
})

describe('fit 算子（裁到内容再适配固定尺寸）', () => {
  /** 造一张 32×32 画布，中央放一个 8×4 的红色长条（含大量透明边） */
  function artWithContent() {
    const w = 32
    const h = 32
    const indices = new Uint8Array(w * h)
    const alphaMask = new Uint8Array(w * h) // 默认全透明
    const palette = ['#ffffff', '#ff0000']
    for (let y = 14; y < 18; y++)
      for (let x = 12; x < 20; x++) {
        const p = y * w + x
        indices[p] = 1
        alphaMask[p] = 255
      }
    return { width: w, height: h, indices, palette, alphaMask }
  }

  it('把内容适配成精确的 WxH（这正是 --size + trim 做不到的事）', () => {
    const r = applyOps(artWithContent(), [{ op: 'fit', width: 16, height: 16 }])
    assert.equal(r.art.width, 16, '宽应为目标 16')
    assert.equal(r.art.height, 16, '高应为目标 16')
    assert.ok(r.changes[0].changed, '尺寸变了必须记 changed')
  })

  it('trim + fit 组合：先裁到内容再适配（原先 trim 单独用会得到内容原始尺寸）', () => {
    const trimmedOnly = applyOps(artWithContent(), [{ op: 'trim' }])
    assert.equal(trimmedOnly.art.width, 8, '前提：trim 只裁边，得到内容尺寸 8×4')
    assert.equal(trimmedOnly.art.height, 4)
    const both = applyOps(artWithContent(), [{ op: 'trim' }, { op: 'fit', width: 16, height: 16 }])
    assert.equal(both.art.width, 16, 'trim 后再 fit 才拿到目标尺寸')
    assert.equal(both.art.height, 16)
  })

  it('contain 等比缩放：内容 8×4 放进 16×16 应为 16×8，上下留透明边', () => {
    const r = applyOps(artWithContent(), [{ op: 'fit', width: 16, height: 16, mode: 'contain' }])
    assert.equal(r.art.width, 16)
    assert.equal(r.art.height, 16)
    // 内容 8×4 → 等比 ×2 → 16×8，居中后上下各留 4 行透明
    assert.equal(r.changes[0].note, '8×4 → 16×8（contain）放进 16×16')
    for (let x = 0; x < 16; x++) {
      assert.equal(r.art.alphaMask![0 * 16 + x], 0, '第 0 行应留透明边')
      assert.equal(r.art.alphaMask![7 * 16 + x], 255, '第 7 行应落在内容上（4..11 行是内容）')
    }
  })

  it('contain 不做非等比拉伸（长宽比必须守住）', () => {
    const r = applyOps(artWithContent(), [{ op: 'fit', width: 16, height: 16, mode: 'contain' }])
    // 内容宽高比 8:4 = 2:1，缩放后仍应是 2:1
    let x0 = 16, x1 = -1, y0 = 16, y1 = -1
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++)
        if (r.art.alphaMask![y * 16 + x] >= 128) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
    const cw = x1 - x0 + 1
    const chh = y1 - y0 + 1
    assert.equal(cw / chh, 2, `长宽比应为 2:1，实际 ${cw}×${chh}`)
  })

  it('stretch 允许变形（各轴独立缩放）', () => {
    const r = applyOps(artWithContent(), [{ op: 'fit', width: 16, height: 16, mode: 'stretch' }])
    assert.equal(r.changes[0].note, '8×4 → 16×16（stretch）放进 16×16')
  })

  it('全透明画布上 fit 不报错且如实报告未改动', () => {
    const empty = blankArt(8, 8, '#ffffff', true)
    const r = applyOps(empty, [{ op: 'fit', width: 16, height: 16 }])
    assert.equal(r.changes[0].changed, false, '全透明内容无可缩放，应记未改动')
    assert.match(r.changes[0].note ?? '', /全透明/)
  })

  it('fit 后画布无越界索引（新格的索引必须在色板范围内）', () => {
    const r = applyOps(artWithContent(), [{ op: 'fit', width: 20, height: 12 }])
    for (let i = 0; i < r.art.width * r.art.height; i++) {
      assert.ok(r.art.indices[i] < r.art.palette.length, '索引必须在色板范围内')
    }
    // 留白格索引为 0，必须配透明 mask；否则会显示成 palette[0] 的白底
    const tp = countTransparent(r.art.indices, r.art.alphaMask)
    assert.ok(tp > 0, 'contain 模式下画布必有透明留白（需要 mask 才能显示为透明）')
  })
})

describe('键控（透明底导出）', () => {
  /**
   * 造一张"白底 + 主体内部有一块**同色**白高光"的画布——这是 global 键控会翻车的经典场景：
   * 主体内部的眼白/高光与背景同色，全图同色键控会把它们一起挖穿成洞。
   */
  function bodyWithWhiteHighlight(): PixelArt {
    const w = 8
    const h = 8
    const indices = new Uint8Array(w * h)
    // 调色板：[0] 白（既是背景也是内部高光） [1] 深绿主体
    const palette = ['#ffffff', '#007800']
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const inBody = x >= 2 && x <= 5 && y >= 2 && y <= 5
        indices[y * w + x] = inBody ? 1 : 0
      }
    // 内部 2×2 的"白高光"：与背景完全同色
    for (const [x, y] of [[3, 3], [4, 3], [3, 4], [4, 4]]) indices[y * w + x] = 0
    return { width: w, height: h, indices, palette, alphaMask: null }
  }

  const countTransparentPx = (img: { data: Uint8ClampedArray }) => {
    let n = 0
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] === 0) n++
    return n
  }

  it('global 模式会把主体内部同色高光一起挖穿（这是它的已知语义）', () => {
    const art = bodyWithWhiteHighlight()
    const img = artToImageData(art, 1, { transparentBg: true, bgHex: '#ffffff', keyMode: 'global' })
    // 整张 8×8 共 64 格；背景 48 格 + 内部高光 4 格 = 52 格被键掉
    assert.equal(countTransparentPx(img), 52, 'global 应把内部 4 格高光也键掉')
    assert.equal(img.data[(3 * 8 + 3) * 4 + 3], 0, '(3,3) 是高光，global 下被挖穿')
  })

  it('border 模式只键与四边连通的底色，主体内部高光必须存活', () => {
    const art = bodyWithWhiteHighlight()
    const img = artToImageData(art, 1, { transparentBg: true, bgHex: '#ffffff', keyMode: 'border' })
    assert.equal(countTransparentPx(img), 48, 'border 只应键掉 48 格背景，内部高光保留')
    assert.equal(img.data[(3 * 8 + 3) * 4 + 3], 255, '(3,3) 是主体内部高光，必须不透明')
    assert.equal(img.data[(4 * 8 + 4) * 4 + 3], 255, '(4,4) 是主体内部高光，必须不透明')
    assert.equal(img.data[0 * 8 * 4 + 3], 0, '(0,0) 是背景，应被键掉')
  })

  it('border 不会误吃"与边界不连通的同色区"（主体把背景围起来时）', () => {
    // 4×4 全是白，中间 2×2 是深绿 → 白底全部与边界连通，应全被键掉
    const w = 4
    const indices = new Uint8Array(w * w)
    const palette = ['#ffffff', '#007800']
    for (let y = 1; y <= 2; y++) for (let x = 1; x <= 2; x++) indices[y * w + x] = 1
    const art: PixelArt = { width: w, height: w, indices, palette, alphaMask: null }
    const img = artToImageData(art, 1, { transparentBg: true, bgHex: '#ffffff', keyMode: 'border' })
    assert.equal(countTransparentPx(img), 12, '外围 12 格白底应全部键掉')
    assert.equal(img.data[(1 * w + 1) * 4 + 3], 255, '中间的绿主体不受影响')
  })

  it('零容差键不掉 254 白底；容差 ≥1 就能键掉（AI 生图的噪声白底）', () => {
    const w = 4
    // 整幅都是 254 白（索引 0 指向 #fefefe）——模拟扩散模型输出的"白底"
    const indices = new Uint8Array(w * w) // 全 0 = 全用 palette[0]
    const palette = ['#fefefe', '#007800']
    const art: PixelArt = { width: w, height: w, indices, palette, alphaMask: null }
    const strict = artToImageData(art, 1, { transparentBg: true, bgHex: '#ffffff', keyTolerance: 0 })
    assert.equal(countTransparentPx(strict), 0, '容差 0 时 254 白底一个都不该被键掉')
    const tolerant = artToImageData(art, 1, { transparentBg: true, bgHex: '#ffffff', keyTolerance: 1 })
    assert.equal(countTransparentPx(tolerant), w * w, '容差 1 时应全部键掉')
  })

  it('容差必须按"三通道最大差"判定，不能把邻近色一概吃掉', () => {
    const w = 2
    // #ffffff 与 #f8f8f8 的最大通道差 = 7
    const palette = ['#f8f8f8', '#ffffff']
    const art: PixelArt = { width: w, height: 1, indices: new Uint8Array([0, 1]), palette, alphaMask: null }
    const t3 = artToImageData(art, 1, { transparentBg: true, bgHex: '#ffffff', keyMode: 'border', keyTolerance: 3 })
    assert.equal(countTransparentPx(t3), 1, '差 7 > 容差 3，只该键掉精确那格')
    const t7 = artToImageData(art, 1, { transparentBg: true, bgHex: '#ffffff', keyMode: 'border', keyTolerance: 7 })
    assert.equal(countTransparentPx(t7), 2, '差 7 ≤ 容差 7，两格都该键掉')
  })

  it('不传 keyMode/keyTolerance 时行为与旧版完全一致（默认 global + 零容差）', () => {
    const art = bodyWithWhiteHighlight()
    const legacy = artToImageData(art, 1, { transparentBg: true, bgHex: '#ffffff' })
    const explicit = artToImageData(art, 1, { transparentBg: true, bgHex: '#ffffff', keyMode: 'global', keyTolerance: 0 })
    assert.deepEqual([...legacy.data], [...explicit.data], '默认值必须等于显式 global+0，否则是破坏性变更')
  })

  it('键控在放大导出时同样成立（scale 不影响键控范围）', () => {
    const art = bodyWithWhiteHighlight()
    const img = artToImageData(art, 2, { transparentBg: true, bgHex: '#ffffff', keyMode: 'border' })
    assert.equal(img.width, 16)
    assert.equal(countTransparentPx(img), 48 * 4, '16×16 下背景 48 格 × 4 像素')
    assert.equal(img.data[(6 * 16 + 6) * 4 + 3], 255, '(3,3) 高光在 2 倍下仍不透明')
  })
})

describe('色板条目编辑（core/palette-edit.ts）', () => {
  /*
   * 这一组的价值全在**合并时的下标重映射**上：删掉色板第 i 项之后，
   * 所有大于 i 的下标都要前移 1。写错不会抛错、不会让任何东西变红，
   * 只会让整张图的颜色**静默错位**——所以这里逐格断言映射结果，
   * 而不是只断言"色板长度少了一个"。
   */

  /** 造一幅"每个色板项各占一格"的图，便于逐格核对映射 */
  function artOf(palette: string[]): { palette: string[]; indices: Uint8Array } {
    return { palette: [...palette], indices: new Uint8Array(palette.map((_, i) => i)) }
  }

  it('普通改值：只换那一项，indices 为 null（不必重映射，也别白拷一次）', () => {
    const a = artOf(['#ff0000', '#00ff00', '#0000ff'])
    const r = replacePaletteEntry(a.palette, a.indices, 1, '#123456')
    assert.deepEqual(r.palette, ['#ff0000', '#123456', '#0000ff'])
    assert.equal(r.indices, null, '未合并时不该产出新的 indices')
    assert.equal(r.mergedInto, null)
  })

  it('改出的颜色与**后面**一项重复：合并到它，并把更后的下标整体前移 1', () => {
    // 源 = 下标1，目标 = 下标3。删掉 1 之后，原下标 3 → 2
    const a = artOf(['#ff0000', '#00ff00', '#0000ff', '#ffff00'])
    a.indices = new Uint8Array([0, 1, 2, 3, 1, 3])
    const r = replacePaletteEntry(a.palette, a.indices, 1, '#ffff00')
    assert.deepEqual(r.palette, ['#ff0000', '#0000ff', '#ffff00'], '被合并的那一项应当被移除')
    assert.equal(r.mergedInto, 2, '目标项删除后落在下标 2')
    assert.deepEqual([...r.indices!], [0, 2, 1, 2, 2, 2], '指向源色的改指目标项，>源下标的全部前移 1')
  })

  it('改出的颜色与**前面**一项重复：合并到它，前面的下标不受影响', () => {
    // 源 = 下标 2，目标 = 下标 0（在源之前，删除后下标不变）
    const a = artOf(['#ff0000', '#00ff00', '#0000ff', '#ffff00'])
    a.indices = new Uint8Array([0, 2, 3, 2])
    const r = replacePaletteEntry(a.palette, a.indices, 2, '#ff0000')
    assert.deepEqual(r.palette, ['#ff0000', '#00ff00', '#ffff00'])
    assert.equal(r.mergedInto, 0)
    assert.deepEqual([...r.indices!], [0, 0, 2, 0], '源色的格子改指 0；原下标 3 前移到 2')
  })

  it('合并后每一格的**颜色**必须与合并前指向的颜色一致（错位就红）', () => {
    // 上一条测的是下标数字，这一条按"颜色"再核一遍——下标对了但语义错了照样能被这里抓住
    const before = ['#111111', '#222222', '#333333', '#444444', '#555555']
    const indices = new Uint8Array([0, 1, 2, 3, 4, 1, 4, 2])
    const colorBefore = [...indices].map((i) => before[i])
    const r = replacePaletteEntry(before, indices, 1, '#444444')
    const colorAfter = [...r.indices!].map((i) => r.palette[i])
    // 源色 #222222 的格子应当变成 #444444，其余格子的颜色一个都不能变
    assert.deepEqual(colorAfter, colorBefore.map((c) => (c === '#222222' ? '#444444' : c)))
  })

  it('大小写不敏感：改成 #FF0000 也能认出已存在的 #ff0000 并合并', () => {
    const a = artOf(['#ff0000', '#00ff00'])
    const r = replacePaletteEntry(a.palette, a.indices, 1, '#FF0000')
    assert.deepEqual(r.palette, ['#ff0000'], '归一化后与已有项相同 → 合并')
    assert.equal(r.mergedInto, 0)
  })

  it('归一化：合法但带大写/缺 # 的输入会被规范成小写 6 位再写入', () => {
    const a = artOf(['#ff0000', '#00ff00'])
    const r = replacePaletteEntry(a.palette, a.indices, 1, 'AABBCC')
    assert.deepEqual(r.palette, ['#ff0000', '#aabbcc'])
  })

  it('非法输入一律原样返回、不抛错（UI 据此静默不动，不弹错给用户）', () => {
    const a = artOf(['#ff0000', '#00ff00'])
    for (const bad of ['', 'nope', '#12345', '#1234567', 'rgb(1,2,3)']) {
      const r = replacePaletteEntry(a.palette, a.indices, 0, bad)
      assert.equal(r.palette, a.palette, `非法色 ${bad} 不该改动画板`)
      assert.equal(r.indices, null)
      assert.equal(r.mergedInto, null)
    }
  })

  it('下标越界一律原样返回', () => {
    const a = artOf(['#ff0000'])
    for (const bad of [-1, 1, 99, 1.5, Number.NaN]) {
      const r = replacePaletteEntry(a.palette, a.indices, bad, '#00ff00')
      assert.equal(r.palette, a.palette, `越界下标 ${bad} 不该改动画板`)
      assert.equal(r.indices, null)
    }
  })

  it('不就地修改入参（history.undo 存引用，就地改会污染历史帧）', () => {
    const palette = ['#ff0000', '#00ff00', '#0000ff']
    const indices = new Uint8Array([0, 1, 2])
    const snapPalette = [...palette]
    const snapIndices = [...indices]
    replacePaletteEntry(palette, indices, 1, '#0000ff') // 走合并分支
    replacePaletteEntry(palette, indices, 1, '#123456') // 走普通分支
    assert.deepEqual(palette, snapPalette, '入参色板必须保持不变')
    assert.deepEqual([...indices], snapIndices, '入参 indices 必须保持不变')
  })
})

describe('色板与 .hex', () => {
  /*
   * 内建预置卡的自证。
   *
   * 为什么值得一条：`resolvePalette` 现在对超限的预置卡**直接抛错**（不再静默截断），
   * 所以"内建卡全都 ≤ PALETTE_MAX"从一个隐含假设变成了**运行前提**——
   * 将来谁加一张 300 色的品牌卡，线上会当场炸，而不是悄悄少几十色。
   * 这条断言把问题拦在测试阶段，并给出是人话的原因。
   */
  it('内建预置卡全都不超过色板上限（否则 resolvePalette 会当场抛错）', () => {
    for (const p of PRESETS) {
      assert.ok(
        p.colors.length <= PALETTE_MAX,
        `预置卡「${p.name}」有 ${p.colors.length} 色，超过 PALETTE_MAX=${PALETTE_MAX}；` +
          `索引是 Uint8Array，超限会回绕出错误颜色。要么删色，要么走索引位宽迁移（需单独一轮）`,
      )
      if (p.codes) {
        assert.equal(p.codes.length, p.colors.length, `预置卡「${p.name}」的号色必须与颜色等长（靠下标对齐）`)
      }
    }
    assert.ok(PRESETS.length > 0, '预置卡表不该为空')
  })

  /*
   * 下面四组守的是**加品牌色卡时最容易出的四类静默缺陷**（2026-09-17 接入 13 个品牌时补）。
   *
   * 共同点：它们全都"不报错、只出错结果"，而且现有代码原本
   * **一条检查都没有**——靠人眼看数据是挡不住的，必须机器守。
   */

  it('号色在每张卡内必须唯一（重复号色会让用户买错色）', () => {
    /*
     * 为什么这条值得单独一条：图纸与清单是按号色标注的，同一张卡里两个不同颜色共用
     * 一个号色时，用户照着"B03"买到的是哪个色完全取决于运气。而代码里**没有任何**唯一性检查
     * （`paletteCodes` 只补 C1/C2，`parseHexPalette` 只按颜色去重），所以只能靠断言拦。
     */
    for (const p of PRESETS) {
      if (!p.codes) continue
      const seen = new Set<string>()
      for (const c of p.codes) {
        assert.ok(!seen.has(c), `预置卡「${p.name}」的号色「${c}」重复出现——图纸上会印出两个同号不同色的标记`)
        seen.add(c)
      }
    }
  })

  it('号色不得为空（空号色会在 PDF 上被静默跳过）', () => {
    // bead-pdf.ts 对空 code 是 `if (!code) continue` —— 静默不画那一格的号色，用户只会看到一片空白
    for (const p of PRESETS) {
      if (!p.codes) continue
      for (const c of p.codes) {
        assert.ok(c.trim().length > 0, `预置卡「${p.name}」里有空号色——PDF 上那一格的编号会被静默跳过`)
      }
    }
  })

  it('每张卡内颜色必须唯一（同一颜色出现两次会让用量统计合并、图纸印重号）', () => {
    /*
     * 与生成脚本的"按颜色去重"策略对应：源数据里存在号色不同而 RGB 完全相同的行
     * （实测 mard 291 行 → 290 个唯一色），脚本会去重。这条守两件事：
     * ① 生成脚本的去重没被改坏；② 手写卡（beads16/24）没被引入重复色。
     * 颜色在卡内重复的后果是 `palette.indexOf` 返回多个下标、用量按 hex 合并且图纸上印两个号。
     */
    for (const p of PRESETS) {
      const seen = new Set<string>()
      for (const c of p.colors) {
        const norm = c.toLowerCase()
        assert.ok(!seen.has(norm), `预置卡「${p.name}」的颜色 ${norm} 出现两次——用量会合并、图纸会印重号`)
        seen.add(norm)
      }
    }
  })

  it('色卡来源声明必须与内容相符（三类各自双向锁住）', () => {
    /*
     * `source` 决定界面与文档怎么向用户交代色号可信度，所以它**不能被宽松推导**。
     * 这条按 `canDecodeInNode` 那套范式写：不只断言"该 true 的 true"，
     * 也断言"该 false 的 false"——防止将来有人把它写成 `hasCodes ? 'community' : 'approximate'`
     * 之类看着合理、实则与事实脱钩的推导。
     */
    const byId = (id: string) => PRESETS.find((p) => p.id === id)
    // 硬件色表是公开规范，必须是 official；写成其他两类就是把权威性说低了
    for (const id of ['pico8', 'gameboy', 'nes', 'cga']) {
      assert.equal(byId(id)?.source, 'official', `${id} 是公开硬件色表，必须标 official`)
    }
    // 自造近似色绝不是官方，也不是任何品牌
    for (const id of ['beads16', 'beads24']) {
      assert.equal(byId(id)?.source, 'approximate', `${id} 是自造的通用近似色，必须标 approximate`)
    }
    // 品牌卡来自社区整理仓库，**不是**厂商官方 —— 标成 official 就是在撒谎
    const brands = PRESETS.filter((p) => p.source === 'community')
    assert.ok(brands.length >= 13, `品牌色卡应有 13 张，实际 ${brands.length}`)
    for (const b of brands) {
      assert.ok(!b.codes || b.codes.length > 0, `品牌卡「${b.id}」应带号色（没有号色就无法印图纸）`)
    }
    // 三类必须都存在，否则说明分类逻辑被写坏了（例如全部退化成同一类）
    for (const s of ['official', 'community', 'approximate'] as const) {
      assert.ok(PRESETS.some((p) => p.source === s), `没有一张卡是 ${s} —— 来源分类被写坏了`)
    }
  })

  it('解析 Lospec 风格 .hex（忽略空行与注释、去重、截断到 256）', () => {
    const parsed = parseHexPalette(['#112233', '', '// 注释', '#445566', '#112233', 'not-a-color'].join('\n'))
    assert.deepEqual(parsed.colors, ['#112233', '#445566'])
    assert.equal(parsed.skipped, 1)
  })

  it('解析带号色两列格式（拼豆图纸需要）', () => {
    const parsed = parseHexPalette('S12 #ff0000\nH05 #00ff00')
    assert.deepEqual(parsed.colors, ['#ff0000', '#00ff00'])
    assert.deepEqual(parsed.codes, ['S12', 'H05'])
  })

  /*
   * codesForParams 是"这次导出该用哪套号色"的**唯一出处**
   * （图纸 SVG / 缺口清单 CSV / 用量报告 / 打印 PDF / .hex / 页内 API 三处导出都走它）。
   * 它存在的理由就是修掉"自定义色卡的号色被丢掉"——所以自定义那一档要重点钉住。
   */
  it('号色解析：按 paletteMode 分流，自定义色板用自己的号色（原先会被丢掉）', () => {
    // 预置档 → 用预置卡自带的号色
    assert.equal(codesForParams({ paletteMode: 'preset', presetPaletteId: 'beads16' })?.[0], 'B01')
    // 自定义档 → 用参数里存的号色（这条以前恒为 undefined，图纸上只印 C1/C2…）
    assert.deepEqual(
      codesForParams({ paletteMode: 'custom', presetPaletteId: 'pico8', customPaletteCodes: ['S12', 'S31'] }),
      ['S12', 'S31'],
    )
    // 自动取色 → 没有号色，交给 paletteCodes() 回退成 C1/C2…
    assert.equal(codesForParams({ paletteMode: 'auto', presetPaletteId: 'pico8' }), undefined)
  })

  it('号色解析：自定义档但没给号色时返回 undefined（不是空数组，下游才好回退）', () => {
    assert.equal(codesForParams({ paletteMode: 'custom', presetPaletteId: 'pico8' }), undefined)
  })

  it('序列化可往返（带号色时输出两列）', () => {
    const text = serializeHexPalette(['#ff0000', '#00ff00'], ['S12', 'H05'])
    const back = parseHexPalette(text)
    assert.deepEqual(back.colors, ['#ff0000', '#00ff00'])
    assert.deepEqual(back.codes, ['S12', 'H05'])
  })

  it('无号色时自动补 C1、C2…（图纸永远有编号可读）', () => {
    assert.deepEqual(paletteCodes(['#ff0000', '#00ff00']), ['C1', 'C2'])
    assert.deepEqual(paletteCodes(['#ff0000', '#00ff00'], ['', 'X9']), ['C1', 'X9'])
  })
})

describe('拼豆（Bead Mode）', () => {
  const build = (opts = {}) => {
    const { params } = sanitizeParams({ paletteMode: 'preset', presetPaletteId: 'beads16', longEdge: 40, lockPalette: true, transparent: 'alpha', ...opts })
    return runPipeline(fixture(), params).art
  }
  /** 取拼豆号色；预置缺失时直接失败（比让后续断言读到 undefined 更容易定位） */
  const beadCodes = (): string[] => {
    const codes = getPreset('beads16')?.codes
    assert.ok(codes && codes.length > 0, 'beads16 预置必须带号色，否则图纸无法标注')
    return codes
  }

  it('清单守恒：每色格数之和 + 透明格 = 总格数', () => {
    const art = build()
    const rep = beadReport(art, { codes: beadCodes() })
    const sum = rep.rows.reduce((n, r) => n + r.cells, 0)
    assert.equal(sum + rep.transparentCells, art.width * art.height)
    assert.equal(rep.totalBeads, sum, '1 格应记为 1 颗')
  })

  it('号色必须全部来自输入色卡（买不到的颜色不能出现在图纸上）', () => {
    const codes = beadCodes()
    const rep = beadReport(build(), { codes })
    for (const r of rep.rows) assert.ok(codes.includes(r.code), `${r.code} 不在色卡内`)
  })

  it('重量与袋数按口径计算（0.08g/颗、500 颗/袋）', () => {
    const art = build()
    const rep = beadReport(art, { beadGram: 0.08 })
    for (const r of rep.rows) {
      assert.equal(r.grams, Number((r.cells * 0.08).toFixed(2)))
      assert.equal(r.bags, Math.max(1, Math.ceil(r.cells / 500)))
    }
  })

  it('分板切分覆盖整幅且无重叠（板数 × 每板格数 ≥ 画布）', () => {
    const art = build()
    const rep = beadReport(art, { boardCells: 20 })
    assert.equal(rep.board.columns, Math.ceil(art.width / 20))
    assert.equal(rep.board.rows, Math.ceil(art.height / 20))
    assert.ok(rep.board.columns * 20 >= art.width)
  })

  it('图纸 SVG：闭合、含图例与板标注、矩形数覆盖整幅', () => {
    const svg = beadSvg(build(), { codes: beadCodes(), cellPx: 16 })
    assert.ok(svg.startsWith('<svg'))
    assert.ok(svg.trimEnd().endsWith('</svg>'))
    assert.ok(svg.includes('图例'))
    assert.ok(/板 1,1/.test(svg))
  })

  it('缺口清单 CSV：表头顺序符合采购习惯，含合计与透明格行', () => {
    const csv = beadListCsv(build())
    const lines = csv.trim().split('\n')
    assert.ok(lines[0].startsWith('编号,颜色,格数,珠数'))
    assert.ok(lines.some((l) => l.startsWith('合计,')))
    assert.ok(lines.some((l) => l.startsWith('透明格,')))
  })

  it('拼豆 PDF：结构合法，且 xref 偏移逐条指向真实对象', () => {
    const art = build()
    const bytes = beadPdf(art, { codes: beadCodes(), deflate: deflateRaw })
    const text = new TextDecoder('latin1').decode(bytes)

    assert.ok(text.startsWith('%PDF-1.4'), 'PDF 头缺失')
    assert.ok(text.trimEnd().endsWith('%%EOF'), 'PDF 尾缺失')
    assert.ok(/\/Type \/Catalog/.test(text) && /\/Type \/Pages/.test(text), '缺少 Catalog/Pages')

    /*
     * 这是本文件最要紧的一条断言：xref 的偏移必须逐字节精确。
     * 手写 PDF 最常见的错误就是偏移算错——而"用阅读器能打开"往往仍然成立
     * （阅读器会容错重建），所以只测"能解析"抓不到它。
     */
    const xrefAt = /^xref$/m.exec(text)
    assert.ok(xrefAt, '缺少 xref 表')
    const startxref = Number(/^startxref\r?\n(\d+)/m.exec(text)?.[1])
    assert.equal(startxref, xrefAt.index, 'startxref 没有指向 xref 表')

    const count = Number(/^xref\r?\n0 (\d+)/m.exec(text)?.[1])
    const trailerAt = /^trailer$/m.exec(text)
    assert.ok(trailerAt, '缺少 trailer')
    const region = text.slice(xrefAt.index, trailerAt.index)
    const entries = [...region.matchAll(/(\d{10}) (\d{5}) ([nf])/g)]
    assert.equal(entries.length, count, `xref 记录数应等于声明值：${entries.length} != ${count}`)

    for (let i = 1; i < entries.length; i++) {
      const off = Number(entries[i][1])
      assert.ok(
        text.startsWith(`${i} 0 obj`, off),
        `xref[${i}] 指向 ${off}，那里是 ${JSON.stringify(text.slice(off, off + 16))}`,
      )
    }
  })

  it('拼豆 PDF：格内号色与清单一致，且不含乱码（标准字体只能 ASCII）', () => {
    const art = build()
    const codes = beadCodes()
    const report = beadReport(art, { codes })
    const bytes = beadPdf(art, { codes, deflate: deflateRaw })
    const content = inflateSync(firstStream(bytes)).toString('latin1')

    // 每个不透明格都应有号色文字；透明格留空
    const opaque = art.indices.length - report.transparentCells
    const codeTexts = [...content.matchAll(/\(([A-Z]\d+)\) Tj/g)].map((m) => m[1])
    assert.equal(codeTexts.length, opaque, `格内号色数应等于不透明格数：${codeTexts.length} != ${opaque}`)

    // 号色必须来自色卡（图纸上不能出现买不到的编号）
    const allowed = new Set(report.rows.map((r) => r.code))
    for (const c of new Set(codeTexts)) {
      assert.ok(allowed.has(c), `图纸上出现了清单里没有的号色：${c}`)
    }
    // 非 ASCII 会被替换成 '?'，那种图纸等于废纸
    assert.ok(!/[^\x00-\x7f]/.test(content), 'PDF 内容流里出现了非 ASCII 字符（会显示成乱码）')
  })

  it('拼豆 PDF：号色字号跟格子走（比例为主，绝对上限只在超大格子上兜底）', () => {
    /*
     * 这条守住的是"格子里的字别挤满格子"这个用户可见的性质。
     *
     * 必须在**格子小于上限阈值**的画布上测比例：`fontSize = min(MAX_CODE_PT, cellW * RATIO)`，
     * 格子一大就被 6.5pt 顶住，比例随之下降——那时无论 RATIO 是 0.45 还是 0.62，
     * 输出都是 6.5pt，断言测不到任何东西（我第一版就栽在这，变异测试没能变红）。
     */
    const fontOf = (art: ReturnType<typeof build>): { code: number; cell: number } => {
      // 必须注入压缩器：不注入时流是明文，下面的 inflateSync 会直接抛错
      const bytes = beadPdf(art, { codes: getPreset('beads16')?.codes, deflate: deflateRaw })
      const content = inflateSync(Buffer.from(firstStream(bytes))).toString('latin1')
      const segs = [...content.matchAll(/([\d.]+) ([\d.]+) m\n([\d.]+) ([\d.]+) l\nS/g)]
      const vx = [...new Set(segs.filter((s) => Math.abs(Number(s[1]) - Number(s[3])) < 0.001).map((s) => Number(s[1])))].sort(
        (a, b) => a - b,
      )
      const cell = Math.min(...vx.slice(1).map((x, i) => x - vx[i]))
      const codeSizes = []
      for (const blk of content.matchAll(/BT\n([\s\S]*?)ET/g)) {
        if (!/\(([A-Z]\d+)\) Tj/.test(blk[1])) continue
        const tf = /\/Helvetica(?:-Bold)? ([\d.]+) Tf/.exec(blk[1])
        if (tf) codeSizes.push(Number(tf[1]))
      }
      assert.ok(codeSizes.length > 0, '没有印出号色：格内应当有 B01/G02 这样的编号')
      return { code: codeSizes[0], cell }
    }

    /*
     * 取值说明（别随手改，这几个尺寸是量出来的）：
     *  - 58×58 / 100×100：格子 9.30 / 5.39pt，字号未被上限顶住，比例应稳定在 45%。
     *  - 32×32：格子 16.85pt，已超上限阈值（6.5/0.45 ≈ 14.4pt），比例降到 39%。
     *  - 120×120：格子 4.49pt → 字号 2.02pt，低于 MIN_CODE_PT 而**不印号色**，
     *    所以不能拿它测比例。
     */
    for (const side of [58, 100]) {
      const art = build({ longEdge: side, exactWidth: side, exactHeight: side })
      const { code, cell } = fontOf(art)
      const ratio = code / cell
      assert.ok(
        ratio > 0.4 && ratio <= 0.46,
        `${side}×${side}：字号/格宽应为 45% 左右，实际 ${(ratio * 100).toFixed(0)}%（字号 ${code.toFixed(2)}pt / 格子 ${cell.toFixed(2)}pt）`,
      )
    }

    // 格子超上限阈值：比例被压低，但仍须"明显小于格子"（这正是设上限的目的）
    for (const side of [16, 32]) {
      const art = build({ longEdge: side, exactWidth: side, exactHeight: side })
      const { code, cell } = fontOf(art)
      assert.equal(code, 6.5, `${side}×${side} 的字号应被 MAX_CODE_PT 顶住，实际 ${code}`)
      assert.ok(code / cell < 0.42, `${side}×${side}：格子 ${cell.toFixed(1)}pt 很大，比例应有明显余量`)
    }
  })

  it('拼豆 PDF：超出可读尺寸时才分板跨页，页数 = 板数', () => {
    /*
     * 用 600×600：整幅塞一页需要 0.86pt/格，远低于可读下限（约 4.2pt），
     * 所以退回按板分页——这正是"不跨页是偏好、不是硬指标"的那条分界线。
     * （120×120 现在能塞进一页，不再适合做本用例。）
     */
    const art = build({ longEdge: 600, exactWidth: 600, exactHeight: 600 })
    const report = beadReport(art, { boardCells: 58 })
    const boards = report.board.columns * report.board.rows
    assert.ok(boards >= 4, `本用例需要多块板才能验证分页，实际 ${boards}`)
    const text = new TextDecoder('latin1').decode(beadPdf(art, { boardCells: 58, deflate: deflateRaw }))
    assert.equal(Number(/\/Type \/Pages \/Count (\d+)/.exec(text)?.[1]), boards, '页数应等于板数')
    assert.equal([...text.matchAll(/\/Type \/Page[^s]/g)].length, boards, 'Page 对象数应等于板数')
    // 分页后格子应回到可读尺寸（而不是继续缩小）
    assert.ok(boards === 121, `600/58 向上取整应为 11×11 块板，实际 ${boards}`)
  })

  it('拼豆 PDF：常规尺寸自适应成一页（不跨页）', () => {
    // 用户要求"导出的画最好自适应 A4 尺寸，尽可能不跨页"——
    // 58×58 与 120×120 都该落在一页；120×120 曾固定切成 9 页（按板分页的旧排版）。
    for (const side of [58, 120]) {
      const art = build({ longEdge: side, exactWidth: side, exactHeight: side })
      const text = new TextDecoder('latin1').decode(beadPdf(art, { deflate: deflateRaw }))
      const pages = Number(/\/Type \/Pages \/Count (\d+)/.exec(text)?.[1])
      assert.equal(pages, 1, `${side}×${side} 应自适应成一页，实际 ${pages} 页`)
    }
  })
})

describe('PDF 生成器（core/pdf.ts）', () => {
  const page = (text: string) => ({
    width: 200,
    height: 100,
    nodes: [{ kind: 'txt' as const, x: 10, y: 20, size: 10, text }],
  })

  it('不注入压缩器也能产出合法 PDF（未压缩流）', () => {
    // 这条守住"deflate 是可选的"：忘了传压缩器不该报错，只该文件更大
    const bytes = buildPdf([page('hello')])
    const text = new TextDecoder('latin1').decode(bytes)
    assert.ok(text.startsWith('%PDF-1.4'))
    assert.ok(text.trimEnd().endsWith('%%EOF'))
    assert.ok(text.includes('(hello) Tj'), '文字应写进内容流')
    assert.ok(!/\/Filter/.test(text), '未注入压缩器时不应声明 Filter')
  })

  it('多页时页数与 Kids 一致，且坐标按 PDF 取向翻转', () => {
    const bytes = buildPdf([page('A'), page('B'), page('C')], { deflate: deflateRaw })
    const text = new TextDecoder('latin1').decode(bytes)
    assert.equal(Number(/\/Type \/Pages \/Count (\d+)/.exec(text)?.[1]), 3)
    assert.equal([...text.matchAll(/\/Type \/Page[^s]/g)].length, 3)
    // 屏幕 y=20（页高 100）→ PDF y=80。算错方向的表现是整页上下颠倒
    const content = inflateSync(firstStream(bytes)).toString('latin1')
    assert.ok(/10 80 Td/.test(content), `y 应向 PDF 坐标翻转（期望 10 80 Td），实际内容：${content}`)
  })

  it('非 ASCII 字符降级为 ?（标准 14 字体只有 WinAnsi，塞中文会乱码）', () => {
    const bytes = buildPdf([page('拼豆 B01')])
    const content = new TextDecoder('latin1').decode(firstStream(bytes))
    assert.ok(content.includes('(?? B01) Tj'), `中文应显式降级为 ?，实际：${content}`)
  })

  it('空页列表报错而不是产出坏文件', () => {
    assert.throws(() => buildPdf([]), /至少需要一页/)
  })

  it('声明了 FlateDecode 的流必须真的能解压（防"声称压缩却写明文"）', () => {
    /*
     * 这条是一次真实事故的回归防线：异步路径曾用 `Map<Uint8Array, Uint8Array>` 做压缩缓存，
     * 而 `assemble` 每趟都新建 Uint8Array，Map 按**引用**比较必然未命中，
     * 于是压缩器原样返回明文，产出"字典写着 /Filter /FlateDecode、内容却是明文"的 PDF。
     *
     * 表现极具欺骗性：文件能生成、体积正常、xref 偏移全对、甚至"能解析"。
     * 只有**真去解压**才会发现。所以这里对每个声明了 Filter 的流都解一遍。
     */
    const bytes = buildPdf([page('BT (B01) Tj ET')], { deflate: deflateRaw })
    const text = new TextDecoder('latin1').decode(bytes)
    const declared = [...text.matchAll(/\/Filter \/FlateDecode/g)].length
    assert.ok(declared > 0, '本用例需要至少一个被声明为压缩的流')

    const streams = allStreams(bytes)
    assert.equal(streams.length, declared, `声明压缩的流数（${declared}）与实际流数（${streams.length}）不符`)
    for (const { start, end } of streams) {
      const data = bytes.subarray(start, end)
      assert.equal(data[0] === 0x78 || (data[0] & 0x0f) === 8, true, `流首字节 ${data[0]} 不像 zlib/deflate`)
      let out: Buffer
      try {
        out = inflateSync(Buffer.from(data))
      } catch (e) {
        throw new Error(`声明压缩却解不开：${(e as Error).message}`)
      }
      assert.ok(out.length > 0, '解压结果为空')
    }
  })

  it('异步压缩路径（buildPdfAsync）产出与同步路径一致的压缩流', async () => {
    // 浏览器只有 CompressionStream（异步），这条保证异步路径不会退化成"写明文"
    const pages = [page('BT (B01) Tj ET')]
    const bytes = await buildPdfAsync(pages, { deflate: async (d) => deflateRaw(d) })
    const text = new TextDecoder('latin1').decode(bytes)
    assert.ok(/\/Filter \/FlateDecode/.test(text), '应声明压缩')
    const streams = allStreams(bytes)
    for (const { start, end } of streams) {
      const out = inflateSync(Buffer.from(bytes.subarray(start, end)))
      assert.ok(out.toString('latin1').includes('B01'), `解压后应含原文，实际：${out.toString('latin1').slice(0, 60)}`)
    }
  })
})

/**
 * 取出 PDF 里所有 stream 的原始字节。
 *
 * 必须按**整行**匹配 `stream`：用 `lastIndexOf('stream\n')` 会命中文件末尾
 * `startxref\n` 里的子串（"start-xref" 不含 stream，但 "startxref" 之后的字节里
 * 仍可能撞上；更稳的做法是只认独立成行的 stream 标记）。我第一版就踩了这个坑。
 */
function allStreams(bytes: Uint8Array): { start: number; end: number }[] {
  const text = new TextDecoder('latin1').decode(bytes)
  const out: { start: number; end: number }[] = []
  const re = /^stream$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const start = m.index + 'stream'.length + 1 // 跳过随后的换行
    const end = text.indexOf('\nendstream', start)
    if (end < 0) continue
    out.push({ start, end })
    re.lastIndex = end
  }
  return out
}

/** 第一个 stream（首页内容流） */
function firstStream(bytes: Uint8Array): Uint8Array {
  const { start, end } = allStreams(bytes)[0]
  return bytes.subarray(start, end)
}

/**
 * 测试用的压缩器：与 `src/io/node-pdf.ts` 一样注入 zlib。
 * `node:zlib` 的 deflateSync 产出 **zlib 格式**（含 2 字节头 + adler32），
 * 正好对应 PDF 的 `/FlateDecode`，所以读回来要用 `inflateSync`（不是 inflateRawSync）。
 */
const deflateRaw = (data: Uint8Array): Uint8Array => new Uint8Array(deflateSync(data, { level: 9 }))
