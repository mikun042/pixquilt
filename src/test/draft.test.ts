/**
 * 自动草稿的**纯逻辑**边界（`src/app/storage.ts`）。
 *
 * 为什么只测这几个函数：真正的 IndexedDB 读写在浏览器里（由 `e2e-regressions.mjs` 的四条
 * 草稿断言覆盖，含真实刷新）。但下面这三个判定是"要不要相信一段外部数据"的关键闸门，
 * 它们**不依赖浏览器**、且错了会静默出问题（例如版本不符还硬读 → 画布错位），
 * 所以按项目惯例在 Node 里单测。
 *
 * `createDraftWriter` 也能在 Node 里测：`snapshot` / 防抖 / cancel 都是纯时序逻辑，
 * 而"清空后不许复活"正是靠 cancel 与 snapshot 判空配合——那条最容易回归，值得钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDraftWriter, isUsableDraft, isUsableSource } from '../app/storage.ts'

/*
 * 这几个判定函数的入参在运行期是**外部数据**（IndexedDB 里读回来的任何东西），
 * 类型上却是精确的 `DraftRecord`。所以测"坏数据"时必须绕过类型——
 * 用 `as unknown as X` 明示"这是故意塞进去的畸形值"，而不是把签名放宽成 any
 * （放宽会让产品代码失去类型保护，那才是本末倒置）。
 */
const bad = (v: unknown) => v as never

test('草稿版本闸门：版本不符一律判为不可用（丢弃重来，不做猜测式迁移）', () => {
  const ok = { version: 1, savedAt: 'x', project: '{}' }
  assert.equal(isUsableDraft(ok, 1), true)
  // 版本不符：宁可丢弃，也不能按旧结构去解析新数据（会得到"看起来正常但内容错"的画布）
  assert.equal(isUsableDraft({ ...ok, version: 2 }, 1), false)
  assert.equal(isUsableDraft({ ...ok, version: 0 }, 1), false)
  // 结构不符
  assert.equal(isUsableDraft(null, 1), false)
  assert.equal(isUsableDraft(bad({ version: 1, savedAt: 'x' }), 1), false)
  assert.equal(isUsableDraft(bad({ version: 1, savedAt: 'x', project: 123 }), 1), false)
})

test('原图草稿闸门：必须有尺寸与 ArrayBuffer（缺一就别拿去构造 ImageData）', () => {
  const base = { version: 1, savedAt: 'x', name: 'a.png', width: 4, height: 4, data: new ArrayBuffer(64) }
  assert.equal(isUsableSource(base, 1), true)
  assert.equal(isUsableSource(null, 1), false)
  assert.equal(isUsableSource({ ...base, version: 9 }, 1), false)
  assert.equal(isUsableSource({ ...base, width: 0 }, 1), false)
  assert.equal(isUsableSource({ ...base, height: -1 }, 1), false)
  // data 不是 ArrayBuffer（例如被 JSON 往返成普通对象）→ 不可用
  assert.equal(isUsableSource(bad({ ...base, data: {} }), 1), false)
})

test('草稿写入器：cancel 之后待写被清掉，且 art 为 null 时写不出内容', async () => {
  let art: string | null = 'A'
  const w = createDraftWriter({
    debounceMs: 20,
    version: 1,
    // snapshot 现读 art：art 为 null 时返回 null —— "清空后不许复活"的第二道闸门
    snapshot: () => (art ? { project: art, source: null } : null),
  })

  // 排期后 cancel：不该还留着待写定时器（这是"清空草稿后旧画布不许复活"的底层保证）
  art = 'B'
  w.schedule()
  assert.equal(w.pending, true, '排期后应有待写定时器')
  w.cancel()
  assert.equal(w.pending, false, 'cancel 之后不应还留着待写定时器')

  // art 为 null 时 flush 是空操作（snapshot 返回 null），不该抛错
  art = null
  await w.flush()
  assert.equal(w.pending, false)

  w.dispose()
  assert.equal(w.pending, false)
})

test('草稿写入器：dispose 之后排期无效（避免页面卸载后还在写）', async () => {
  let art: string | null = 'A'
  const w = createDraftWriter({ debounceMs: 10, version: 1, snapshot: () => (art ? { project: art, source: null } : null) })
  w.dispose()
  w.schedule()
  assert.equal(w.pending, false, 'dispose 后 schedule 不该排上定时器')
  await new Promise((r) => setTimeout(r, 40))
  art = 'B'
  await w.flush() // 不应抛错，也不应有副作用
  assert.ok(true)
})
