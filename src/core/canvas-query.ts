/**
 * 画布**查询类**工具：不透明内容的外接框、锚点偏移、连通区域。
 *
 * 从 `ops.ts` 拆出的理由同 `rasterize.ts`：它们只读画布、不改画布状态，
 * 却被三处共用（编辑算子、界面画布层、单测与拼豆/资产导出）。
 * `ops.ts` 因此只留"算子语义 + 画布状态变更"。
 */
import { ALPHA_THRESHOLD } from './limits.ts'
import type { Anchor, PixelArt } from './types.ts'

/** 不透明内容的外接框（trim 用）；全透明返回 null */
export function opaqueBounds(art: PixelArt): { x0: number; y0: number; x1: number; y1: number } | null {
  const { width: w, height: h, alphaMask } = art
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const opaque = !alphaMask || alphaMask[p] >= ALPHA_THRESHOLD
      if (!opaque) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 }
}

/** 内容相对固定尺寸画布的偏移（游戏资产锚点用：不裁边，只给引擎一个 pivot） */
export function anchorOffset(art: PixelArt, anchor: Anchor): { offsetX: number; offsetY: number } {
  const b = opaqueBounds(art)
  if (!b) return { offsetX: 0, offsetY: 0 }
  const cx = (b.x0 + b.x1) / 2
  const cy = (b.y0 + b.y1) / 2
  const mx = (art.width - 1) / 2
  const my = (art.height - 1) / 2
  if (anchor === 'top-left') return { offsetX: -b.x0, offsetY: -b.y0 }
  if (anchor === 'bottom-center') return { offsetX: Math.round(mx - cx), offsetY: -(b.y1 - my) }
  return { offsetX: Math.round(cx - mx), offsetY: Math.round(cy - my) }
}

/**
 * 连通区域（油漆桶）的纯函数实现。4 邻接 BFS，返回**格索引**数组（含起点）。
 *
 * 连通规则（这里曾经自相矛盾，改动前先读）：
 *  - **透明格之间一律连通**，不再比较残留的颜色索引。挖过洞的格子里仍留着旧索引，
 *    若按"索引也相同"判连通，把两种不同颜色的像素先后挖掉之后，那片空白会被切成两块——
 *    与"把这块整片抠掉"的直觉不符（canvas 层的自制实现一直是按这条规则做的）。
 *  - **不透明侧仍要求同色**，否则透明之外的区域会整幅串成一片。
 *
 * 导出它是为了让画布层复用同一套规则（原先 `src/app/ui/canvas.ts` 自己写了一份 BFS，
 * 两边的连通判据已经分叉，且没有任何断言能发现）。
 */
export function floodFillRegion(indices: Uint8Array, w: number, h: number, x: number, y: number, alpha: Uint8Array | null): number[] {
  if (x < 0 || x >= w || y < 0 || y >= h) return []
  const start = y * w + x
  const startTransparent = alpha ? alpha[start] === 0 : false
  const target = indices[start]

  const visited = new Uint8Array(w * h)
  const queue = new Int32Array(w * h)
  let head = 0
  let tail = 0
  queue[tail++] = start
  visited[start] = 1
  const out: number[] = []

  while (head < tail) {
    const c = queue[head++]
    out.push(c)
    const cx = c % w
    const cy = (c / w) | 0
    const neighbors = [
      cx > 0 ? c - 1 : -1,
      cx < w - 1 ? c + 1 : -1,
      cy > 0 ? c - w : -1,
      cy < h - 1 ? c + w : -1,
    ]
    for (const n of neighbors) {
      if (n < 0 || visited[n]) continue
      const nTransparent = alpha ? alpha[n] === 0 : false
      if (nTransparent !== startTransparent) continue
      if (!startTransparent && indices[n] !== target) continue
      visited[n] = 1
      queue[tail++] = n
    }
  }
  return out
}

