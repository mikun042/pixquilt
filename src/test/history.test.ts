/**
 * 撤销栈（`src/app/history.ts`）单元测试。
 *
 * 为什么单测能跑：这个模块是纯逻辑——不碰 DOM、不碰 `node:`，只依赖 `core/limits.ts` 与类型。
 * 抽它出来的直接原因就是"双上限"必须能被机器验证，而不是靠读代码相信。
 *
 * 每条断言都要能因真实缺陷而红（见 docs/DEVELOPMENT.md §3.1）：
 *  - 把 `trim()` 里任一条上限去掉 → 对应的"不超限"断言变红；
 *  - 把 `commit` 的 `cloneArt` 换成存引用 → "快照隔离"断言变红；
 *  - 把 `undo`/`redo` 的字节数加减写错 → "账目守恒"断言变红。
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { ArtHistory, cloneArt, frameBytes, normalizeAlphaMask } from '../app/history.ts'
import { ALPHA_THRESHOLD, HISTORY_MAX_BYTES, HISTORY_MAX_FRAMES } from '../core/limits.ts'
import type { PixelArt } from '../core/types.ts'

/**
 * 造一张 cells 格的画布；`withAlpha` 决定是否带 alphaMask。
 *
 * 注意 mask 里**必须真有一格透明**（首格置 0）：全不透明的 mask 会被
 * `normalizeAlphaMask` 归一成 null（这是有意的，省一半内存），
 * 用它测"带 alpha 的帧占两倍字节"会立刻失败——这不是缺陷，是断言前提没造对。
 */
function art(cells: number, withAlpha = false): PixelArt {
  const mask = withAlpha ? new Uint8Array(cells).fill(255) : null
  if (mask) mask[0] = 0
  return {
    width: cells,
    height: 1,
    indices: new Uint8Array(cells),
    palette: ['#000000', '#ffffff'],
    alphaMask: mask,
  }
}

describe('撤销栈：双上限', () => {
  it('帧数上限：超过 HISTORY_MAX_FRAMES 后只保留最近的若干帧', () => {
    const h = new ArtHistory()
    const base = art(4)
    for (let i = 0; i < HISTORY_MAX_FRAMES + 20; i++) {
      // 每帧给一个可辨认的内容（首格索引 = i），便于确认淘汰的是最旧的
      const cur = cloneArt(base)
      cur.indices[0] = i % 256
      h.commit(cur)
    }
    assert.equal(h.stats().past, HISTORY_MAX_FRAMES, '撤销栈应被帧数上限截住')
    // 最近一帧必然还在（内容 = 最后一次提交的前一帧）
    const last = h.undo(art(4))
    assert.ok(last, '撤销应能取到帧')
  })

  it('字节上限：小画布 + 小额度时，由字节数触顶（不是帧数）', () => {
    // 每帧 100 字节（indices 100 + 无 alpha），额度 350 → 最多 3 帧
    const h = new ArtHistory({ maxFrames: 999, maxBytes: 350 })
    for (let i = 0; i < 30; i++) h.commit(art(100))
    const s = h.stats()
    assert.ok(s.bytes <= 350, `累计字节应不超额度，实际 ${s.bytes}`)
    assert.ok(s.past <= 3, `帧数应由字节上限压到 3 以内，实际 ${s.past}`)
  })

  it('字节上限把带 alpha 的那一份也算进去（单帧 = indices + alphaMask）', () => {
    const h = new ArtHistory({ maxFrames: 999, maxBytes: 500 })
    for (let i = 0; i < 20; i++) h.commit(art(200, true)) // 每帧 400 字节
    const s = h.stats()
    assert.ok(s.bytes <= 500, `累计字节应不超额度，实际 ${s.bytes}`)
    assert.equal(s.past, 1, `200+200 字节的帧在 500 额度下只放得下 1 帧，实际 ${s.past}`)
  })

  it('redo 也受上限约束（旧实现只在这里 push 却不检查，能无界增长）', () => {
    const h = new ArtHistory({ maxFrames: 3, maxBytes: 1e9 })
    const base = art(4)
    for (let i = 0; i < 10; i++) h.commit(cloneArt(base))
    // 来回撤销/重做多轮，两栈都不该超过 3
    let cur = cloneArt(base)
    for (let round = 0; round < 12; round++) {
      const u = h.undo(cur)
      if (u) cur = u
      const r = h.redo(cur)
      if (r) cur = r
      const s = h.stats()
      assert.ok(s.past <= 3, `撤销栈不该超过 3，实际 ${s.past}`)
      assert.ok(s.future <= 3, `重做栈不该超过 3，实际 ${s.future}`)
    }
  })

  it('真实常量就是 limits.ts 里的那一对（别在别处另写一套）', () => {
    const h = new ArtHistory()
    // 用超小画布推满帧数，确认默认额度确实是 HISTORY_MAX_FRAMES
    for (let i = 0; i < HISTORY_MAX_FRAMES + 5; i++) h.commit(art(1))
    assert.equal(h.stats().past, HISTORY_MAX_FRAMES)
    assert.ok(HISTORY_MAX_BYTES >= 1024 * 1024, '字节上限应当是量级合理的常量')
  })
})

describe('撤销栈：账目与快照隔离', () => {
  it('提交 → 撤销 → 重做之后，两栈字节数与手算一致（账目守恒）', () => {
    const h = new ArtHistory()
    const f = art(64, true) // 每帧 128 字节
    const bytes = frameBytes(f)
    assert.equal(bytes, 128, '单帧字节数 = indices + alphaMask')

    h.commit(f)
    assert.equal(h.stats().bytes, bytes, '提交一帧后 past 里有 128 字节')

    const cur = art(64, true)
    const prev = h.undo(cur)
    assert.ok(prev)
    // undo 只是把"当前帧"挪进重做栈、把"上一帧"取出来：**总量不变**（仍是一帧的字节）
    assert.equal(h.stats().bytes, bytes, `undo 后两栈合计仍应为 128，实际 ${h.stats().bytes}`)
    assert.equal(h.stats().past, 0)
    assert.equal(h.stats().future, 1)

    const next = h.redo(prev)
    assert.ok(next)
    assert.equal(h.stats().bytes, bytes, `redo 后合计仍应为 128，实际 ${h.stats().bytes}`)
    assert.equal(h.stats().past, 1)
    assert.equal(h.stats().future, 0)
  })

  it('新提交会清空重做栈，并把它占的字节一起释放', () => {
    const h = new ArtHistory()
    const f = art(64, true)
    h.commit(f)
    h.undo(art(64, true))
    assert.equal(h.stats().future, 1)
    h.commit(f)
    assert.equal(h.stats().future, 0, '新提交必须清空重做栈')
    assert.equal(h.stats().bytes, frameBytes(f), `重做栈的字节也要清掉，实际 ${h.stats().bytes}`)
  })

  it('入栈的是快照：之后就地改原对象不会污染历史', () => {
    const h = new ArtHistory()
    const live = art(4)
    live.indices[0] = 7
    h.commit(live)
    live.indices[0] = 9 // 模拟画布继续就地编辑
    const prev = h.undo(art(4))
    assert.ok(prev)
    assert.equal(prev.indices[0], 7, '历史里的快照不该被后续编辑改掉')
  })

  it('reset 之后两栈与字节都归零', () => {
    const h = new ArtHistory()
    h.commit(art(128, true))
    h.reset()
    assert.deepEqual(h.stats(), { past: 0, future: 0, bytes: 0 })
    assert.equal(h.canUndo, false)
    assert.equal(h.canRedo, false)
  })
})

describe('alphaMask 归一', () => {
  it('全不透明的 mask 归一成 null（省一半快照内存）', () => {
    const full = new Uint8Array(8).fill(255)
    assert.equal(normalizeAlphaMask(full), null)
  })

  it('只要有一格低于阈值就原样保留（含边界值）', () => {
    const mask = new Uint8Array(8).fill(255)
    mask[3] = ALPHA_THRESHOLD - 1
    assert.equal(normalizeAlphaMask(mask), mask, '含透明格时必须保留原 mask')
    const edge = new Uint8Array(8).fill(255)
    edge[0] = ALPHA_THRESHOLD // 等于阈值 = 不透明，不构成透明格
    assert.equal(normalizeAlphaMask(edge), null, '恰好等于阈值仍算不透明')
  })

  it('null 进 null 出', () => {
    assert.equal(normalizeAlphaMask(null), null)
  })
})
