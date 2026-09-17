/**
 * 自动调参（确定性搜索）。
 *
 * ## 它解决的现实问题
 *
 * "长边该设 48 还是 64""色号数给 16 还是 24""开不开抖动"——此前只能反复试。
 * 而拼豆用户真正的约束是**色号数 = 买豆成本**，所以目标不是"最像"，
 * 而是**在约束内最像**：
 *
 *   > 在色号数 ≤ N 的前提下，把块平均误差压到最小。
 *
 * 这正是竞品没有的能力——它们只能让用户手调，且没有"色号数"这个成本维度。
 *
 * ## ⚠️ 硬约束：必须确定性（本项目核心承诺是"同图同参 → 同结果"）
 *
 * 搜索天然容易引入不确定性，所以这里有四条纪律：
 *   1. **不用随机**：候选集是显式枚举的笛卡尔积，不是随机采样；
 *   2. **固定遍历顺序**：候选按固定次序生成；
 *   3. **排序有最终裁决键**：并列时用参数签名做字典序裁决，
 *      绝不依赖 `Array.sort` 的偶然顺序；
 *   4. **只跑 `runPipeline`**：它是纯函数，无时间/随机/环境依赖。
 *
 * 有单测专门守"同图同参两次跑出同一个最优解"。
 *
 * ## 搜索空间：只搜**真正影响结果**的维度
 *
 * `paletteK`（自动取色的目标色数）**只在 `paletteMode: 'auto'` 时才有意义**——
 * 用预置卡或自定义色板时它被完全忽略（`resolvePalette` 直接返回卡里的颜色）。
 * 把它放进搜索空间会让候选表里出现大量"看起来不同、实际同一份结果"的重复项，
 * 既浪费时间又让报告里 top N 全是同一行（实测踩到过）。
 * 所以按当前 `paletteMode` 动态决定搜不搜这一维。
 */
import { runPipeline } from './pipeline.ts'
import { qualityReport } from './quality.ts'
import type { ConvertParams, DitherMode } from './types.ts'

/** 搜索用的候选值（显式枚举，不是随机采样） */
export interface TuneSpace {
  longEdge: number[]
  /** 只在 `paletteMode: 'auto'` 时参与搜索；其他档位下它不影响任何结果 */
  paletteK: number[]
  dither: DitherMode[]
  cleanup: boolean[]
}

/**
 * 默认搜索空间。
 *
 * ⚠️ **`longEdge` 这一维默认是空数组**，即"不搜尺寸"。
 *
 * 为什么默认不搜（这是实测教训，不是保守）：**"块平均误差"与"色号数"都随画布变小而变小**——
 * `blockSize` 是画布格数，画布越小每块覆盖的原图面积越大、两边被平均得越狠，误差自然趋小
 * （实测 24:0.0356 < 32:0.0376 < 48:0.0410 < 64:0.0560 < 96:0.0570）；同理小画布量化出的
 * 不同颜色也更少（24→87 色、96→102 色）。两个指标**都在奖励"更糊"**，
 * 所以只要拿它们跨尺寸排序，结果必然坍缩到最小档——用户要"像"，拿到 24×18 的糊图，
 * 而报告还写着"观感最好的组合"。
 *
 * 结论：**跨尺寸没有可靠的自动判据，就不假装有**。尺寸由用户定（`--long-edge`，见 `searchLongEdge`），
 * 或用 `--long-edge` 之外的方式自行决定；本函数只在**给定尺寸内**搜抖动/清理，
 * 那正是 `quality.ts` 那个指标的可靠用法（同尺寸下比较抖动）。
 *
 * 要真的把尺寸纳入搜索，必须先把度量改成尺寸可比的——那是独立一轮的事，
 * 且得先有跨尺寸的判据，不能靠现有这两个数。
 */
export const DEFAULT_TUNE_SPACE: TuneSpace = {
  longEdge: [],
  paletteK: [8, 12, 16, 24, 32],
  dither: ['none', 'floyd', 'atkinson', 'bayer8'],
  cleanup: [true, false],
}

export interface TuneOptions {
  /** 色号数上限（`maxColors`）。**这是硬约束**，超限的候选直接淘汰 */
  maxColors?: number
  /** 自定义搜索空间 */
  space?: Partial<TuneSpace>
  /** 每张图最多评估多少组（防止大图 + 大空间跑太久；超出时取前 N 组，顺序固定所以仍确定） */
  maxCandidates?: number
  /**
   * 是否把尺寸纳入搜索（默认 `false`：只用 `base.longEdge`）。
   *
   * **默认关闭的理由见 `DEFAULT_TUNE_SPACE` 上方那段**：跨尺寸没有可靠判据，
   * 现有两个指标都会奖励"更糊"的方案。用户显式写了 `--long-edge 58` 就是要 58 格，
   * 更不该被搜索空间里的档位盖掉（实测过：`--long-edge 58 --auto-tune 14` 出 24×18，
   * 而 `--json` 还回显 58——参数被静默丢弃，正是本项目最忌讳的一类失败）。
   *
   * 置为 `true` 时才回到"连尺寸一起搜"的旧行为；此时结果不可靠，仅供实验。
   */
  searchLongEdge?: boolean
}

export interface TuneCandidate {
  params: ConvertParams
  /** 块平均误差（判断观感用这个；逐格误差受抖动影响会误导，见 quality.ts 的陷阱） */
  blockError: number
  meanError: number
  usedColors: number
  beads: number
}

export interface TuneResult {
  /** 约束内最优的那组参数（一定满足 `maxColors`；无解时取色号最少的一组并置 `feasible:false`） */
  best: TuneCandidate
  /** 最优解是否真的满足色号上限 */
  feasible: boolean
  /** 评估过的候选数（供 agent 判断"搜索够不够"） */
  evaluated: number
  /** 所有满足约束的候选里，保真最好的前三名（供人工比对；不足 3 个就全部返回） */
  top: TuneCandidate[]
}

/** 参数签名：用于并列时的确定裁决，也用于报告里标识一组参数 */
function signature(p: ConvertParams): string {
  return `longEdge=${p.longEdge},paletteK=${p.paletteK},dither=${p.dither},cleanup=${p.cleanup}`
}

/**
 * 在约束下搜索最优参数。
 *
 * 排序规则（**这就是"最优"的定义，写在代码里而不是文档里**）：
 *   1. 满足色号上限的优先；
 *   2. 其次色号数少（同样的约束下用更少的色 = 更省豆子，成本是用户真金白银买的）；
 *   3. 再次块平均误差小（观感更接近原图）；
 *   4. 最后参数签名按字典序——**只为确定，不为优劣**。
 *
 * ⚠️ **这个排序只在"尺寸已定"时成立**（默认就是——见 `DEFAULT_TUNE_SPACE`）。
 * 第 2、3 级用的 `usedColors` 与 `blockError` **都会随画布变小而变小**，所以一旦跨尺寸比较，
 * 它们会一致地奖励最小档（实测：24 格 87 色 / 96 格 102 色；块平均 24→0.0356 对 96→0.0570）。
 * 用户要"像"却拿到"糊"，而报告写着"观感最好的组合"——那是会让人做错决定的错误结论。
 * 真正的正确用法就是 `quality.ts` 文件头那个：**固定尺寸下比较抖动**
 * （抖动让逐格误差变大、块平均变小，那才是它要捕捉的现象）。
 *
 * "最优"在这个前提下指：**在你指定的尺寸下**，色号够省、观感够像的那组参数。
 */
export function autoTune(
  source: { width: number; height: number; data: Uint8ClampedArray },
  base: ConvertParams,
  options: TuneOptions = {},
): TuneResult {
  const space: TuneSpace = {
    /*
     * 尺寸维度：默认**不搜**（`DEFAULT_TUNE_SPACE.longEdge` 是空数组），用 `base.longEdge`。
     * 只有显式 `searchLongEdge: true` 或自带 `space.longEdge` 时才纳入——理由见
     * `DEFAULT_TUNE_SPACE` 上方那段（跨尺寸的两个候选指标都在奖励"更糊"）。
     */
    longEdge: options.searchLongEdge
      ? (options.space?.longEdge?.length ? options.space.longEdge : [24, 32, 48, 64, 96])
      : (options.space?.longEdge?.length ? options.space.longEdge : [base.longEdge]),
    paletteK: options.space?.paletteK ?? DEFAULT_TUNE_SPACE.paletteK,
    dither: options.space?.dither ?? DEFAULT_TUNE_SPACE.dither,
    cleanup: options.space?.cleanup ?? DEFAULT_TUNE_SPACE.cleanup,
  }
  const maxColors = options.maxColors ?? 0
  /*
   * `paletteK` 只在 auto 档影响结果（见文件头）。其他档位下把它固定成当前值，
   * 避免生成一堆"参数看着不同、产物完全一样"的重复候选。
   */
  const paletteKValues = base.paletteMode === 'auto' ? space.paletteK : [base.paletteK]

  // 固定顺序生成候选：嵌套顺序就是遍历顺序，不依赖任何排序
  const candidates: ConvertParams[] = []
  for (const longEdge of space.longEdge) {
    for (const paletteK of paletteKValues) {
      for (const dither of space.dither) {
        for (const cleanup of space.cleanup) {
          candidates.push({
            ...base,
            longEdge,
            paletteK,
            // 抖动的两个配套字段：强度用满（100），上限不设（0）——搜索的是"要不要抖动"，
            // 不是"抖动多强"；强度交给用户后续微调
            dither,
            ditherStrength: 100,
            ditherMaxColors: 0,
            cleanup,
            // 长边档位与精确尺寸互斥：带 exact 时 longEdge 会被忽略，搜索就白跑了
            exactWidth: undefined,
            exactHeight: undefined,
          })
        }
      }
    }
  }

  const limited = options.maxCandidates && options.maxCandidates < candidates.length
    ? candidates.slice(0, options.maxCandidates)
    : candidates

  const evaluated: TuneCandidate[] = []
  for (const params of limited) {
    const { art } = runPipeline(source, params)
    const q = qualityReport(source, art, {
      paletteMode: params.paletteMode,
      presetPaletteId: params.presetPaletteId,
      customPaletteCodes: params.customPaletteCodes,
    })
    evaluated.push({
      params,
      // 用块平均而不是逐格：判断观感要看它（见 quality.ts 文件头那个指标陷阱）
      blockError: q.blockFidelity.mean,
      meanError: q.fidelity.mean,
      usedColors: q.usedColors,
      beads: q.beads,
    })
  }

  const feasible = maxColors > 0 ? evaluated.filter((c) => c.usedColors <= maxColors) : evaluated
  /*
   * 无解时（没有任何候选满足色号上限）**把上限下沉成 `ditherMaxColors`**：
   * 我们刚做的两遍法能硬保证"色号数 ≤ N"，所以用户的硬约束仍然守得住，
   * 只是观感会因此变差——这一点由 `feasible: false` 如实告知。
   *
   * 反例（第一版的错误做法）：无解时直接返回"观感最好的那组"，而它有 16 色 > 上限 8。
   * 用户要的是"我不超过 8 种豆子"，给他一个 16 色的方案等于没解决问题。
   */
  if (maxColors > 0 && feasible.length === 0) {
    const capped: TuneCandidate[] = []
    for (const p of limited) {
      /*
       * 关键细节：`ditherMaxColors` **只在开了抖动时才生效**（见 pipeline.ts 的 capEnabled）——
       * 因为它的语义是"约束抖动带来的色号膨胀"。所以无解分支里必须**同时打开抖动**，
       * 否则上限形同虚设（实测踩到过：无解时给一个 dither:none 的方案，上限 8 却出 15 色）。
       * 抖动方式选 atkinson：它主动丢弃 1/4 误差，是三种里最"干净"的（色点少）。
       */
      const params = {
        ...p,
        dither: p.dither === 'none' ? ('atkinson' as const) : p.dither,
        ditherMaxColors: maxColors,
      }
      const { art } = runPipeline(source, params)
      const q = qualityReport(source, art, {
        paletteMode: params.paletteMode,
        presetPaletteId: params.presetPaletteId,
        customPaletteCodes: params.customPaletteCodes,
      })
      capped.push({
        params,
        blockError: q.blockFidelity.mean,
        meanError: q.fidelity.mean,
        usedColors: q.usedColors,
        beads: q.beads,
      })
    }
    /*
     * 无解分支的排序链与主路径**保持一致**（色号数优先于块误差）。
     * 这里全部候选都走了 `ditherMaxColors`，色号数普遍贴着上限，所以两者差异通常不大；
     * 但口径不一致本身就是隐患——同一份"最优"的定义不该有两套。
     */
    const bestCapped = [...capped].sort(
      (a, b) => a.usedColors - b.usedColors || a.blockError - b.blockError || signature(a.params).localeCompare(signature(b.params)),
    )
    const topCapped: TuneCandidate[] = []
    const seenCap = new Set<string>()
    for (const c of bestCapped) {
      const k = `${c.blockError.toFixed(6)}|${c.usedColors}|${c.beads}`
      if (seenCap.has(k)) continue
      seenCap.add(k)
      topCapped.push(c)
      if (topCapped.length >= 3) break
    }
    /*
     * `capped` 可能为空（`maxCandidates: 0` 会让 `limited` 是空数组）。
     * 没有这条兜底时会返回 `best: undefined`，调用方读 `tune.best.params` 直接抛
     * "Cannot read properties of undefined"——一个远在故障现场的报错。这里给出明确错误。
     */
    if (!bestCapped.length) {
      throw new Error('自动调参：没有可评估的候选（检查 maxCandidates / 搜索空间是否被置空）')
    }
    return { best: bestCapped[0], feasible: false, evaluated: evaluated.length, top: topCapped }
  }

  const pool = feasible.length > 0 ? feasible : evaluated

  /*
   * 排序：确定性来自**最后那一级参数签名**。
   * 前面都是数值比较，并列极常见（同 longEdge 下多组抖动可能给出同一个块误差），
   * 没有最后一级时结果会依赖 sort 的实现细节——而"同图同参同结果"是本项目的核心承诺。
   *
   * **色号数排在块误差之前**：理由见函数头那段（blockError 是画布格数的函数，
   * 越小反而越糊，不能当跨尺寸的主排序键）。
   */
  const sorted = [...pool].sort((a, b) => {
    const ca = a.usedColors <= maxColors || maxColors === 0 ? 0 : 1
    const cb = b.usedColors <= maxColors || maxColors === 0 ? 0 : 1
    return (
      ca - cb ||
      a.usedColors - b.usedColors ||
      a.blockError - b.blockError ||
      signature(a.params).localeCompare(signature(b.params))
    )
  })

  /*
   * top 只留**产物不同**的候选。
   *
   * 为什么必须去重：不同参数可能产出完全一样的画（例如 cleanup 对没有小碎块的图毫无影响、
   * 或两档 longEdge 在同一张图上向下取整到同一格数）。不去重时 top 3 会是三行一模一样的
   * "最优"，看着像 bug，也让人无法据此比较方案（实测踩到过）。
   * 判据用 `(块误差, 色号数, 珠子数)` 三元组——它们相同就意味着产物在观感与成本上都等价。
   */
  const seen = new Set<string>()
  const top: TuneCandidate[] = []
  for (const c of sorted) {
    const key = `${c.blockError.toFixed(6)}|${c.usedColors}|${c.beads}`
    if (seen.has(key)) continue
    seen.add(key)
    top.push(c)
    if (top.length >= 3) break
  }

  return {
    best: sorted[0] ?? evaluated[0],
    feasible: feasible.length > 0,
    evaluated: evaluated.length,
    top,
  }
}

/** 一行摘要（CLI 与页内 API 共用，避免两处措辞漂移） */
export function tuneSummary(r: TuneResult): string {
  const b = r.best
  return (
    `最优：${signature(b.params)}` +
    ` → 块平均 ${b.blockError.toFixed(4)} / 用到 ${b.usedColors} 色 / ${b.beads} 颗` +
    (r.feasible ? '' : '（⚠️ 无解：没有任何候选满足色号上限，已退化为色号最少的一组）') +
    ` · 评估 ${r.evaluated} 组`
  )
}
