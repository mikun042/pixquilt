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

/** 默认搜索空间：覆盖拼豆与游戏资产的常见档位 */
export const DEFAULT_TUNE_SPACE: TuneSpace = {
  longEdge: [24, 32, 48, 64, 96],
  paletteK: [8, 12, 16, 24, 32],
  dither: ['none', 'floyd', 'atkinson', 'bayer8'],
  cleanup: [true, false],
}

export interface TuneOptions {
  /** 色号数上限（`maxColors`）。**这是硬约束**，超限的候选直接淘汰 */
  maxColors?: number
  /** 目标块平均误差；达到即停止改进（不给就只按"约束内最优"选） */
  targetError?: number
  /** 自定义搜索空间 */
  space?: Partial<TuneSpace>
  /** 每张图最多评估多少组（防止大图 + 大空间跑太久；超出时取前 N 组，顺序固定所以仍确定） */
  maxCandidates?: number
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
 *   2. 其次块平均误差小（观感更接近原图）；
 *   3. 再次色号数少（同样像就用更少的色 = 更省豆子）；
 *   4. 最后参数签名按字典序——**只为确定，不为优劣**。
 *
 * 注意第 2 级排在"色号少"前面：色号数是**成本**，不是**质量**。
 * 成本由 `maxColors` 硬约束表达，不该在排序里二次惩罚——否则会选出
 * "24 格 10 色"这类明显比"96 格 16 色"更糊的方案（实测踩到过）。
 */
export function autoTune(
  source: { width: number; height: number; data: Uint8ClampedArray },
  base: ConvertParams,
  options: TuneOptions = {},
): TuneResult {
  const space: TuneSpace = {
    longEdge: options.space?.longEdge ?? DEFAULT_TUNE_SPACE.longEdge,
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
    const bestCapped = [...capped].sort(
      (a, b) => a.blockError - b.blockError || a.usedColors - b.usedColors || signature(a.params).localeCompare(signature(b.params)),
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
    return { best: bestCapped[0], feasible: false, evaluated: evaluated.length, top: topCapped }
  }

  const pool = feasible.length > 0 ? feasible : evaluated

  /*
   * 排序：确定性来自**最后那一级参数签名**。
   * 前三级都是数值比较，并列极常见（同 longEdge 下多组抖动可能给出同一个块误差），
   * 没有第四级时结果会依赖 sort 的实现细节——而"同图同参同结果"是本项目的核心承诺。
   */
  const sorted = [...pool].sort((a, b) => {
    const ca = a.usedColors <= maxColors || maxColors === 0 ? 0 : 1
    const cb = b.usedColors <= maxColors || maxColors === 0 ? 0 : 1
    return (
      ca - cb ||
      a.blockError - b.blockError ||
      a.usedColors - b.usedColors ||
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
