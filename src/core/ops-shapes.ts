/**
 * 两个"扩张/叠加"类算子的几何辅助：描边（向外补一圈）与镜像加笔（把内容镜像到另一侧）。
 *
 * 从 `ops.ts` 拆出：这两个函数纯粹按几何产出格索引，不涉及色板解析与状态提交，
 * 却是 `ops.ts` 里最长的两段（各带一段"为什么分两步而不是边搜边写"的推导注释，
 * 见 `docs/架构.md` 的缺陷复盘）。
 */
import { ALPHA_THRESHOLD } from './limits.ts'

/**
 * 描边：找出所有"需要补色"的空白格（返回格子索引）。
 *
 * 语义分两层，都能一格格验证：
 *  - **第一圈**：与实心区切比雪夫距离 1 的空白格，即紧贴内容的完整外圈
 *    （2×2 方块外侧是 12 格；`connectivity:4` 时只保留正交相邻的那些）。
 *  - **第 n 圈**（`offset ≥ 2`）：从上一圈再向外扩一圈，仍是切比雪夫 1 环。
 *
 * 为什么先算出整圈再扩张，而不是逐格边搜边写：早期实现把"已描上的格"混进实心集合里同步扩张，
 * 9×9 上单像素 `offset:2` 只得到 12 格（正确是 33 = 3×3 + 5×5 两个外框减中心）。
 * 分两步写虽多一遍扫描，但每一步都能对上几何直觉。
 *
 * 只看 alpha 不看颜色索引：挖过洞的格子里仍留着旧索引值，只看索引会把透明格当成实心，
 * 描边就会贴着看不见的东西走。
 *
 * 只返回空白格，所以已有内容不会被覆盖，重复执行也不会越描越粗。
 */
export function outlineCells(
  w: number,
  h: number,
  alpha: Uint8Array | null,
  connectivity: 4 | 8,
  offset: number,
): number[] {
  const layers = Math.max(1, Math.floor(offset))
  const isSolid = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false
    if (!alpha) return true
    return alpha[y * w + x] >= ALPHA_THRESHOLD
  }
  const chebyshev1 = (x: number, y: number, test: (x: number, y: number) => boolean): boolean => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        if (test(x + dx, y + dy)) return true
      }
    }
    return false
  }

  // 第一圈：紧贴内容的空白格。connectivity=4 时只保留正交相邻的那些，
  // 只在对角相接的角落格留到第二圈（otherwise 描边会在凹角处出现孤立补丁）。
  const outlined = new Set<number>()
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isSolid(x, y)) continue
      if (!chebyshev1(x, y, isSolid)) continue
      if (connectivity === 4) {
        const orth =
          isSolid(x - 1, y) || isSolid(x + 1, y) || isSolid(x, y - 1) || isSolid(x, y + 1)
        if (!orth) continue
      }
      outlined.add(y * w + x)
    }
  }

  // 第 2..offset 圈：从上一圈的成果继续向外扩，仍然是切比雪夫 1 环。
  // 分趟计算而不是边搜边写：中间状态混进判定里会漏格（9×9 单像素 offset:2 曾只得 12 格，应为 33）。
  for (let layer = 2; layer <= layers; layer++) {
    const found: number[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x
        if (isSolid(x, y) || outlined.has(p)) continue
        if (found.includes(p)) continue
        if (chebyshev1(x, y, (nx, ny) => {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) return false
          return outlined.has(ny * w + nx)
        })) {
          found.push(p)
        }
      }
    }
    if (!found.length) break
    for (const p of found) outlined.add(p)
  }

  // 按坐标顺序输出：同一输入必须产出同一顺序（确定性）
  return [...outlined].sort((a, b) => a - b)
}

/**
 * 镜像加笔：以画布中线为轴，把内容镜像叠到另一侧。原内容保留。
 *
 * 用 `(w-1-x)` 而不是 `((w-x) % w)`：后者在 x=0 时会折到 x=w-1，
 * 内容是"贴着左边缘 8 格"时镜像副本会贴到右上角，而不是左侧留白 8 格——
 * 中线对称的意义就是让左右留白量相等。
 *
 * 副本里的透明格**不落笔**：否则镜像一次会顺手把原内容抹掉一半（对称图形看不出来，
 * 非对称图形必错）。
 */
export function mirrorCells(
  w: number,
  h: number,
  alpha: Uint8Array | null,
  kind: 'h' | 'v' | 'both',
): number[] {
  const solid = (x: number, y: number): boolean => {
    const p = y * w + x
    return alpha ? alpha[p] >= ALPHA_THRESHOLD : true
  }
  const result: number[] = []
  const seen = new Set<number>()
  const put = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const p = y * w + x
    if (seen.has(p)) return
    if (solid(x, y)) return // 已有内容不动
    seen.add(p)
    result.push(p)
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!solid(x, y)) continue
      if (kind === 'h' || kind === 'both') put(w - 1 - x, y)
      if (kind === 'v' || kind === 'both') put(x, h - 1 - y)
      if (kind === 'both') put(w - 1 - x, h - 1 - y)
    }
  }
  return result
}

