/**
 * 色板条目编辑（纯逻辑）。
 *
 * 像素存的是**色板下标**（`indices`），颜色本身只在 `palette` 数组里——所以"把画面上某个颜色
 * 调一下"这件事，本质上就是改 `palette[i]` 这一个字符串，一个 `indices` 都不用动。
 * 这也让它比 `replaceAny`（逐格改下标、还要追加拿入目标色）便宜得多。
 *
 * 为什么单独一个模块：这里的两个判断——**与已有色重复时合并**、**合并时的下标重映射**——
 * 都是容易写错且错了不会报错的地方（错了只是整张图颜色错位），所以按 R3「纯函数优先」
 * 放到 core 里、由单测钉住，而不是埋在 UI 的事件回调里。
 *
 * 与 `src/core/ops.ts` 的分工：那边是**算子**（声明式、可 CLI 批量、进 `OP_SPECS`）；
 * 这里是 UI 编辑动作的底层原语，**不是算子**，所以不参与算子计数与自描述生成。
 */
import { normalizeHex } from './types.ts'

export interface PaletteEntryEdit {
  /** 改完之后的新色板 */
  palette: string[]
  /**
   * 需要重映射的 `indices`；**未发生合并时为 `null`**。
   *
   * 用 null 而不是"原样返回同一个数组"来表达"不用改"，是为了让调用方省掉一次全量拷贝
   * （2048² 的画布是 4MB），也让"这次动没动像素"一眼可读。
   */
  indices: Uint8Array | null
  /** 合并到了哪个下标；未合并为 `null` */
  mergedInto: number | null
}

/**
 * 把色板第 `index` 项改成 `hex`。
 *
 * **若 `hex` 与色板里另一项重复 → 合并**：把指向 `index` 的格子改指那一项，并删掉 `index`。
 * 为什么合并而不是留两个同色项：拼豆图纸按号色标注，同一颜色出现两个号色会让人以为要买两包；
 * 而且用量统计本来就按 hex 合并，留着两项只是账面上多一项零用量孤儿。
 *
 * 两条边界一律**原样返回、不抛错**（UI 层据此静默不动，不弹错给用户）：
 *  - `hex` 非法（`normalizeHex` 失败）
 *  - `index` 越界
 *
 * ⚠️ 合并**只能在提交时做，不能在拖动预览中做**：拖动过程中颜色会**途经**与其它项相同的值，
 * 若在预览里合并，源下标会中途消失、继续拖就全乱了。预览允许临时重复，提交时才合并。
 */
export function replacePaletteEntry(
  palette: string[],
  indices: Uint8Array,
  index: number,
  hex: string,
): PaletteEntryEdit {
  const unchanged: PaletteEntryEdit = { palette, indices: null, mergedInto: null }
  const norm = normalizeHex(hex)
  if (!norm) return unchanged
  if (!Number.isInteger(index) || index < 0 || index >= palette.length) return unchanged

  // 已经在色板里？那就是"合并两色"，不是"改值"。同一 hex 可能有多项，取**下标最小的那个**做归属，
  // 保证同一输入产出同一结果（不依赖遍历顺序的偶然性）。
  let target = -1
  for (let i = 0; i < palette.length; i++) {
    if (i === index) continue
    if (palette[i].toLowerCase() === norm) {
      target = i
      break
    }
  }

  if (target < 0) {
    // 普通改值：换掉一项，indices 完全不动
    const next = [...palette]
    next[index] = norm
    return { palette: next, indices: null, mergedInto: null }
  }

  /*
   * 合并。这里是整个模块**唯一容易写错**的地方：删掉第 index 项之后，
   * 所有**大于** index 的下标都会整体前移 1 位。
   *   · 指向被删项（=== index）的格子 → 改指目标项
   *   · 指向被删项之后（> index）的格子 → 前移 1
   *   · 目标项自己（< index 时下标不变，> index 时同样前移 1）由上面两条规则自然覆盖
   * 少写任何一条，整张图的颜色都会静默错位——所以单测盯的就是这张映射表。
   */
  const merged = [...palette]
  merged.splice(index, 1)
  const remapped = new Uint8Array(indices.length)
  // 目标项在删除之后的新下标：在它后面的项都前移了 1
  const targetAfterRemoval = target > index ? target - 1 : target
  for (let p = 0; p < indices.length; p++) {
    const i = indices[p]
    if (i === index) remapped[p] = targetAfterRemoval
    else if (i > index) remapped[p] = i - 1
    else remapped[p] = i
  }
  return { palette: merged, indices: remapped, mergedInto: targetAfterRemoval }
}
