/**
 * core 层单元测试（node:test，经 Node 的类型剥离直接跑 .ts，不需要先构建）。
 *
 * 覆盖原则：**每条断言都要能因为一个真实缺陷而失败**（见 docs/DEVELOPMENT.md §3.1）。
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
import { getPreset, parseHexPalette, serializeHexPalette, paletteCodes } from '../core/palettes.ts'
import { artHash, decodePixBin, encodePixBin, layoutSheet, parseProjectFile, pixelJSONString, projectJSONString } from '../core/export.ts'
import { base64ToBytes, bytesToBase64 } from '../core/binary.ts'
import { countTransparent, countUsage, hasRealAlpha } from '../core/stats.ts'
import { hardenAlpha } from '../core/png.ts'
import { decodePngNode, encodePngNode } from '../io/node-png.ts'
import { artToPngBytesNode } from '../io/node-export.ts'
import { beadListCsv, beadReport, beadSvg } from '../core/bead.ts'
import { beadPdf } from '../core/bead-pdf.ts'
import { buildPdf, buildPdfAsync } from '../core/pdf.ts'
import { OP_SPECS } from '../core/spec.ts'
import { hexToRgb, rgbToHex, rgbToOklab, oklabToRgb, gradientPalette } from '../core/color.ts'

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
    assert.equal(OP_SPECS.length, 12, '算子数量变化时必须同步文档与测试')
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

describe('色板与 .hex', () => {
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

  it('拼豆 PDF：分板跨页时每块板各占一页，页数 = 板数', () => {
    const art = build({ longEdge: 120 })
    const report = beadReport(art, { boardCells: 58 })
    const boards = report.board.columns * report.board.rows
    assert.ok(boards >= 4, `本用例需要多块板才能验证分页，实际 ${boards}`)
    const text = new TextDecoder('latin1').decode(beadPdf(art, { boardCells: 58, deflate: deflateRaw }))
    assert.equal(Number(/\/Type \/Pages \/Count (\d+)/.exec(text)?.[1]), boards, '页数应等于板数')
    assert.equal([...text.matchAll(/\/Type \/Page[^s]/g)].length, boards, 'Page 对象数应等于板数')
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
