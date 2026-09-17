/**
 * 图纸质量度量（纯函数）。
 *
 * ## 为什么需要它
 *
 * "转换结果好不好"此前**只能肉眼看**——本项目如此，所有竞品也如此。
 * 于是用户面对"长边该设 48 还是 64""色号数该给 16 还是 24"只能反复试，
 * 而拼豆用户真正的约束是**色号数 = 买豆成本**。
 *
 * 把"好不好"变成可比较的数字之后，两件事才有基础：
 *   · 用户能看清"多给 8 个色号换回了多少保真度"；
 *   · `--auto-tune` 能在参数空间里搜索（见 `tool/artc.mjs`），而不是靠猜。
 *
 * ## 度量口径（四条，都刻意选"离产物最近"的算法）
 *
 * 1. **逐格保真**：每个**不透明**格的原图颜色与它被量化成的色板颜色，在 OKLab 里的距离。
 *    报均值 / P95 / 最大值三个数，而不是只报均值——像素画的痛点在局部
 *    （一块该有细节的暗部被糊平），均值会把这种局部损失平摊掉。
 * 2. **块平均保真**（`blockFidelity`）：把产物与参考各按 B×B 块取平均色再比，近似"眯眼看"。
 *    **这一条是必须的**，原因见下面那个陷阱。
 * 3. **成本**：实际用到的色号数、珠子总数、估算重量、分板数。直接复用 `bead.ts` 的口径，
 *    不另算一套（否则"报告说 12 色、清单印 13 色"这种矛盾迟早出现）。
 * 4. **抖动代价**：抖动会逼出色板外的中间色 → 色号增多。所以额外报"抖动带来的新增色号数"，
 *    让"开了抖动要多买几种豆子"这件事**可见**。
 *
 * ## ⚠️ 一个真实的指标陷阱：只看逐格误差会得出与事实相反的结论
 *
 * 抖动的工作原理就是**故意让每一格偏离目标**，靠空间混合让眼睛看到更接近的整体。
 * 所以"开了抖动 → 逐格误差变大"是定义决定的，**不代表画质变差**。
 * 实测（96² 渐变 + beads24 卡，本项目真实代码）：
 *
 * | 模式 | 逐格误差 | 块平均(B=3) |
 * |---|---|---|
 * | 关闭 | 0.0861 | 0.0749 |
 * | floyd | 0.1123 | **0.0381** |
 * | atkinson | 0.1017 | **0.0336** |
 *
 * 只看左边那列会得出"抖动让画质变差 30%"；看右边那列才知道**抖动让观感好了约 50%**。
 * 这正是本项目反复记录的那类问题——**指标算错会把使用者带向错误决策**（§8.10 ⑦）。
 * 所以两个数都要报，且文档写明"判断抖动该看块平均"。
 *
 * ## 与 `stats.ts` / `bead.ts` 的分工
 *
 * - `stats.ts`：单幅画的客观计数（用量、透明格数）——纯统计，不涉及"好坏"。
 * - `bead.ts`：拼豆的经济账（珠子数、重量、分板）——已是权威口径，这里复用。
 * - 本模块：把"原图 ↔ 产物"的**差距**量化，是唯一需要同时看两边的模块。
 */
import { hexToRgb, rgbToOklab } from './color.ts'
import { ALPHA_THRESHOLD, type PixelArt } from './types.ts'
import { beadReport } from './bead.ts'
import { codesForParams } from './palettes.ts'

/** 每格色差的分布（OKLab 欧氏距离；0 = 完全一致） */
export interface ColorErrorStats {
  /** 均值——整体像不像 */
  mean: number
  /** P95——"较差的那些格子"有多差（像素画更该看这个） */
  p95: number
  /** 最大值——最坏的一格在哪里差多少 */
  max: number
  /** 参与统计的格数（**不含透明格**：它们没有颜色可谈） */
  cells: number
}

export interface QualityReport {
  /** 逐格误差：**看"这一格准不准"**。判断抖动时不要用它（见文件头陷阱） */
  fidelity: ColorErrorStats
  /**
   * 块平均误差：把产物与参考各按 B×B 块取平均色再比，近似"眯眼看"。
   * **判断抖动/整体观感要看这个**——它才是人眼真正看到的东西。
   */
  blockFidelity: ColorErrorStats
  /** 实际用到的色号数（不是色板长度——色板可能有零用量项） */
  usedColors: number
  /** 色板总长度（= art.palette.length，含可能没被用到的） */
  paletteSize: number
  /** 珠子总数 */
  beads: number
  /** 估算重量（克），按 bead.ts 的口径 */
  grams: number
  /** 分板数（按给定的板规格；未给规格时为 1） */
  boards: number
  /**
   * 抖动带来的新增色号数：与"同参数但关抖动"相比多用了几种色。
   * 关抖动时为 0（没有可比对象）。
   *
   * 为什么单独报：抖动**总是**增加色号数与珠子数，对拼豆是直接的买豆成本，
   * 而用户很难自己发现这件事（画面看起来更细腻，账单却在涨）。
   */
  ditherExtraColors: number
  /** 透明格数（不计入 fidelity，但影响拼豆的板面计算） */
  transparentCells: number
}

export interface QualityOptions {
  /** 板规格，交给 bead.ts 算分板数；缺省时 boards = 1 */
  board?: { cols: number; rows: number }
  /**
   * 块平均的块边长（默认 3）。3 是折中：2 太小（接近逐格，看不出抖动的整体效果）、
   * 4 以上会把真有细节的区域也抹平。改它请连同文件头那张实测表一起改。
   */
  blockSize?: number
  /**
   * "同参数但关抖动"的对照结果。
   *
   * 由调用方传入而不是这里自己跑一遍：本模块是纯函数、不负责重跑管线
   * （那需要原图 + 参数，是 `runPipeline` 的活）。调用方手上有对照时传进来，
   * 没有就留空——`ditherExtraColors` 会如实报 0 而不是编一个数。
   */
  noDitherBaseline?: { usedColors: number }
}

/**
 * 计算质量报告。
 *
 * `source` 是**原始像素缓冲**（RGBA，与 `runPipeline` 的输入同形），
 * `art` 是转换产物。两者尺寸通常不同（原图大、画布格数小），
 * 所以按"格"取样：每格的参考色取原图**对应区域的中心像素**。
 *
 * 为什么取中心而不是区域平均：区域平均是降采样模式之一（`average`），
 * 用它当参考会让"区域平均"模式下误差恒为 0、而"最近邻"模式下虚高——
 * 那测的是"模式是否一致"，不是"像不像"。中心像素是模式无关的共同基准，
 * 对两种模式都公平。（这也是它作为**近似**参考的已知局限：像素画本身
 * 就是有损降采样，任何单一参考都只能反映趋势。）
 */
export function qualityReport(
  source: { width: number; height: number; data: Uint8ClampedArray },
  art: PixelArt,
  /**
   * 只用到"号色从哪来"这两项（为了与 `bead.ts` 的口径对齐）。
   * 其余参数（长边、抖动、透明处理…）本模块不关心——它测的是**产物**，不是**怎么产出的**。
   */
  params: { paletteMode: string; presetPaletteId: string; customPaletteCodes?: string[] },
  options: QualityOptions = {},
): QualityReport {
  // ---- 保真度：逐格取中心像素做参考 ----
  const errors: number[] = []
  const paletteLabs = art.palette.map((h) => {
    const c = hexToRgb(h)
    return rgbToOklab(c.r, c.g, c.b)
  })
  const sx = source.width / art.width
  const sy = source.height / art.height
  let transparentCells = 0

  for (let y = 0; y < art.height; y++) {
    for (let x = 0; x < art.width; x++) {
      const p = y * art.width + x
      const isTransparent = art.alphaMask ? art.alphaMask[p] < ALPHA_THRESHOLD : false
      if (isTransparent) {
        transparentCells++
        continue
      }
      // 原图对应区域的中心像素
      const cx = Math.min(source.width - 1, Math.floor((x + 0.5) * sx))
      const cy = Math.min(source.height - 1, Math.floor((y + 0.5) * sy))
      const o = (cy * source.width + cx) * 4
      const ref = rgbToOklab(source.data[o], source.data[o + 1], source.data[o + 2])

      const got = paletteLabs[art.indices[p]]
      if (!got) continue
      const dl = ref.L - got.L
      const da = ref.a - got.a
      const db = ref.b - got.b
      errors.push(Math.sqrt(dl * dl + da * da + db * db))
    }
  }

  errors.sort((a, b) => a - b)
  const dist = (arr: number[]): ColorErrorStats => ({
    mean: arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0,
    p95: arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.95))] : 0,
    max: arr.length ? arr[arr.length - 1] : 0,
    cells: arr.length,
  })
  const fidelity = dist(errors)

  /*
   * 块平均误差：把产物与参考都按 B×B 取平均色再比。
   * 这是**唯一能看出抖动价值**的指标（见文件头那张实测表）：
   * 抖动故意让单格偏离，却让块平均更接近原图——因为人眼就是这么看的。
   * 按块平均时逐块用 **sRGB 平均再转 OKLab**（而不是先把每格转 OKLab 再平均）：
   * 前者对应"像素混色后眼睛接收到的光"，后者是数学上更"均匀"但与人眼不符的口径。
   */
  const B = Math.max(2, Math.floor(options.blockSize ?? 3))
  const blockErrors: number[] = []
  for (let by = 0; by < art.height; by += B) {
    for (let bx = 0; bx < art.width; bx += B) {
      let ar = 0
      let ag = 0
      let ab = 0
      let an = 0
      let rr = 0
      let rg = 0
      let rb = 0
      let rn = 0
      let anyOpaque = false
      for (let y = by; y < Math.min(by + B, art.height); y++) {
        for (let x = bx; x < Math.min(bx + B, art.width); x++) {
          const p = y * art.width + x
          if (art.alphaMask && art.alphaMask[p] < ALPHA_THRESHOLD) continue
          anyOpaque = true
          const c = hexToRgb(art.palette[art.indices[p]])
          ar += c.r
          ag += c.g
          ab += c.b
          an++
          const cx = Math.min(source.width - 1, Math.floor((x + 0.5) * sx))
          const cy = Math.min(source.height - 1, Math.floor((y + 0.5) * sy))
          const o = (cy * source.width + cx) * 4
          rr += source.data[o]
          rg += source.data[o + 1]
          rb += source.data[o + 2]
          rn++
        }
      }
      if (!anyOpaque || an === 0 || rn === 0) continue
      const a = rgbToOklab(Math.round(ar / an), Math.round(ag / an), Math.round(ab / an))
      const r = rgbToOklab(Math.round(rr / rn), Math.round(rg / rn), Math.round(rb / rn))
      const dl = a.L - r.L
      const da = a.a - r.a
      const db = a.b - r.b
      blockErrors.push(Math.sqrt(dl * dl + da * da + db * db))
    }
  }
  blockErrors.sort((a, b) => a - b)
  const blockFidelity = dist(blockErrors)

  // ---- 成本：直接复用 bead.ts 的权威口径 ----
  const codes = codesForParams({
    paletteMode: params.paletteMode,
    presetPaletteId: params.presetPaletteId,
    customPaletteCodes: params.customPaletteCodes,
  })
  const report = beadReport(art, { codes })

  const usedColors = new Set<number>()
  for (let i = 0; i < art.indices.length; i++) {
    if (art.alphaMask && art.alphaMask[i] < ALPHA_THRESHOLD) continue
    usedColors.add(art.indices[i])
  }

  const base = options.noDitherBaseline?.usedColors
  return {
    fidelity,
    blockFidelity,
    usedColors: usedColors.size,
    paletteSize: art.palette.length,
    beads: report.totalBeads,
    grams: Number(report.totalGrams.toFixed(2)),
    boards: options.board
      ? Math.max(
          1,
          Math.ceil(art.width / options.board.cols) * Math.ceil(art.height / options.board.rows),
        )
      : 1,
    ditherExtraColors: base === undefined ? 0 : Math.max(0, usedColors.size - base),
    transparentCells,
  }
}

/** 给 CLI / 页内 API 用的一行摘要（避免两处各写一套措辞） */
export function qualitySummary(q: QualityReport): string {
  const f = q.fidelity
  return (
    `逐格误差 均 ${f.mean.toFixed(4)} / P95 ${f.p95.toFixed(4)} / 最大 ${f.max.toFixed(4)}` +
    ` · 块平均 ${q.blockFidelity.mean.toFixed(4)}` +
    ` · 用到 ${q.usedColors}/${q.paletteSize} 色` +
    ` · ${q.beads} 颗 / ${q.grams} g` +
    (q.ditherExtraColors > 0 ? ` · 抖动多用了 ${q.ditherExtraColors} 色` : '')
  )
}
