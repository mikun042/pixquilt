/**
 * 撤销 / 重做栈：**双上限**（帧数 + 字节）与账目守恒。
 *
 * 为什么单独成文件：这段逻辑原先内联在 `index.ts` 里，只有帧数硬编码的 50、**没有任何字节记账**，
 * 而 `core/limits.ts` 里的 `HISTORY_MAX_BYTES` 只写在文档与注释里、从未生效——
 * 2048² 带 alpha 的画布单帧就是 8MB，50 帧最坏约 400MB（弱机直接 OOM）。
 * 抽成纯模块后可以脱离浏览器单测：`src/test/history.test.ts`。
 *
 * 两条上限**先到先算**；淘汰顺序是"先丢最旧的撤销帧，撤销栈空了再丢最旧的重做帧"。
 */
import { ALPHA_THRESHOLD, HISTORY_MAX_BYTES, HISTORY_MAX_FRAMES } from '../core/limits.ts'
import type { PixelArt } from '../core/types.ts'

/** 一帧快照占的字节数：索引 + 可选 alpha（色板是几十个短字符串，量级可忽略） */
export function frameBytes(art: PixelArt): number {
  return art.indices.byteLength + (art.alphaMask?.byteLength ?? 0)
}

/**
 * 深拷贝快照。索引与 alpha 都必须复制：画布在提交时会就地改写工作副本，
 * 若历史里存的是同一个对象引用，撤销后的像素/色板会被后续编辑污染
 * （测试报告 P2-05：撤销后色板残留已撤销的颜色，artHash 也回不到原值）。
 */
export function cloneArt(art: PixelArt): PixelArt {
  return {
    width: art.width,
    height: art.height,
    indices: art.indices.slice(),
    palette: [...art.palette],
    alphaMask: art.alphaMask ? art.alphaMask.slice() : null,
  }
}

/**
 * 全不透明的 alphaMask 归一为 null。
 *
 * core 的 `fromCanvas`（`ops.ts`）一直这么做，但**画布提交路径没有**——
 * 于是随手画出来的画布也带着一整张全 255 的 mask，单帧快照白占一倍内存。
 */
export function normalizeAlphaMask(mask: Uint8Array | null | undefined): Uint8Array | null {
  if (!mask) return null
  for (let i = 0; i < mask.length; i++) if (mask[i] < ALPHA_THRESHOLD) return mask
  return null
}

export interface HistoryOptions {
  maxFrames?: number
  maxBytes?: number
}

export class ArtHistory {
  private past: PixelArt[] = []
  private future: PixelArt[] = []
  private pastBytes = 0
  private futureBytes = 0
  private readonly maxFrames: number
  private readonly maxBytes: number

  constructor(options: HistoryOptions = {}) {
    // 默认值来自 core/limits.ts（单一出处）；测试可传小值以便快速构造边界
    this.maxFrames = options.maxFrames ?? HISTORY_MAX_FRAMES
    this.maxBytes = options.maxBytes ?? HISTORY_MAX_BYTES
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  /**
   * 提交一次编辑：把**编辑前**的画面压入撤销栈，并丢弃重做栈。
   * `previous` 会被深拷贝，调用方可以继续就地改自己那份。
   */
  commit(previous: PixelArt): void {
    const snap = cloneArt(previous)
    // 快照也做一次"全不透明 → null"归一：进来的画面可能带着一整张全 255 的 mask
    // （例如刚 setAll 填满颜色的画布），不归一的话这一帧白占一倍内存。
    snap.alphaMask = normalizeAlphaMask(snap.alphaMask)
    this.past.push(snap)
    this.pastBytes += frameBytes(snap)
    this.clearFuture()
    this.trim()
  }

  /** 撤销：返回要恢复的画面；没有可撤销的返回 null。`current` 进重做栈。 */
  undo(current: PixelArt): PixelArt | null {
    const prev = this.past.pop()
    if (!prev) return null
    this.pastBytes -= frameBytes(prev)
    // 这里存引用即可：`app.art` 每次提交都是新对象，旧对象不会被就地修改
    this.future.push(current)
    this.futureBytes += frameBytes(current)
    this.trim()
    return prev
  }

  /** 重做：与 undo 对称。**这里也必须受上限约束**（旧实现只在这里 push 却不检查，能无界增长）。 */
  redo(current: PixelArt): PixelArt | null {
    const next = this.future.pop()
    if (!next) return null
    this.futureBytes -= frameBytes(next)
    const snap = cloneArt(current)
    snap.alphaMask = normalizeAlphaMask(snap.alphaMask)
    this.past.push(snap)
    this.pastBytes += frameBytes(snap)
    this.trim()
    return next
  }

  reset(): void {
    this.past = []
    this.future = []
    this.pastBytes = 0
    this.futureBytes = 0
  }

  /** 只读快照，供状态栏/断言使用（别拿它去改内部数组） */
  stats(): { past: number; future: number; bytes: number } {
    return { past: this.past.length, future: this.future.length, bytes: this.pastBytes + this.futureBytes }
  }

  private clearFuture(): void {
    this.future = []
    this.futureBytes = 0
  }

  private dropOldestPast(): void {
    const dropped = this.past.shift()
    if (dropped) this.pastBytes -= frameBytes(dropped)
  }

  private dropOldestFuture(): void {
    const dropped = this.future.shift()
    if (dropped) this.futureBytes -= frameBytes(dropped)
  }

  /**
   * 双上限：帧数**按栈分别**封顶，字节**按两栈合计**封顶；一律淘汰最旧。
   * 淘汰顺序：先丢最旧的撤销帧，撤销栈空了再丢最旧的重做帧
   * （撤销是用户更可能用到的方向，重做帧的价值更低）。
   */
  private trim(): void {
    while (this.past.length > this.maxFrames) this.dropOldestPast()
    while (this.future.length > this.maxFrames) this.dropOldestFuture()
    while (this.pastBytes + this.futureBytes > this.maxBytes) {
      if (this.past.length) this.dropOldestPast()
      else if (this.future.length) this.dropOldestFuture()
      else break
    }
  }
}
