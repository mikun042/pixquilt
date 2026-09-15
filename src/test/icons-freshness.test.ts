/**
 * 接线新鲜度：`src/app/ui/icons.ts` 里那两张图标表，必须与 `tool/icons/` 的形状定义一致。
 *
 * 为什么需要这条断言（不是"多此一举的重复"）：图标数据是**生成物**，而生成物最容易
 * "改了源、忘了重跑"——那两张表此前就真的漂移过：
 *
 *  · `PIXEL_PATHS.undo` / `.regenerate` 与形状定义不一致，**没有任何人发现**，
 *    因为渲染时它们被 `SVG_PATHS` 遮蔽（同名时优先读 SVG 版），漂移不产生任何可见症状。
 *  · `SVG_PATHS` 更严重：形状画在 **32 设计网格**、而 viewBox 是 24，缺了缩放这一步，
 *    8 个描边图标全被裁掉大半（"重新转换"只剩一段残弧、"快捷键"的方点整个消失），
 *    同样静默了很久。
 *
 * 这两类都是"没有报错、只有错误结果"，正是本项目最忌讳的一类。所以这里用
 * `docs/AGENT_API.md` 的 `describe-freshness` 同一套办法把它钉死：
 * **生成物与形状定义逐字节比对，不一致就红。**
 *
 * 判断复用接线脚本自己的纯函数（`replaceXxxBlock`），不 spawn 子进程、
 * 也不重新实现一遍比对逻辑——两边各写一份的话，比对的"正确答案"本身也会分叉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isSvgPathsFresh } from '../../tool/icons/svg-sync.mjs'
import { isPixelPathsFresh } from '../../tool/icons/pixel-sync.mjs'

test('图标接线新鲜度：SVG_PATHS 与 svg-shapes.mjs 一致', async () => {
  const { fresh, count } = await isSvgPathsFresh()
  assert.ok(
    fresh,
    'icons.ts 的 SVG_PATHS 与 tool/icons/svg-shapes.mjs 不一致。\n' +
      '  改了形状后请跑：npm run icons:sync',
  )
  assert.ok(count > 0, '没有任何 SVG 图标数据——形状定义可能被清空了')
})

test('图标接线新鲜度：PIXEL_PATHS 与 pixel-shapes.mjs 一致', () => {
  const { fresh, count } = isPixelPathsFresh()
  assert.ok(
    fresh,
    'icons.ts 的 PIXEL_PATHS 与 tool/icons/pixel-shapes.mjs 不一致。\n' +
      '  改了形状后请跑：npm run icons:sync',
  )
  assert.ok(count > 0, '没有任何像素图标数据——形状定义可能被清空了')
})

test('图标数据自检：所有坐标都落在 24 的 viewBox 内（不裁切）', async () => {
  // buildSvgPaths 内部已带"最大坐标 ≤ 24"的硬校验，越界会直接 throw；
  // 这里额外断言它在**正常数据**上确实跑通（否则那条自检可能被绕过或失效）。
  const { buildSvgPaths } = await import('../../tool/icons/svg-data.mjs')
  const paths = await buildSvgPaths()
  const names = Object.keys(paths)
  assert.ok(names.length >= 8, `SVG 图标只有 ${names.length} 个，预期至少 8 个`)
  for (const [name, items] of Object.entries(paths)) {
    assert.ok(items.length > 0, `${name} 没有任何 path`)
    for (const it of items) {
      const nums = (it.d.match(/-?\d*\.?\d+/g) ?? []).map(Number)
      const max = Math.max(...nums)
      assert.ok(max <= 24.51, `${name} 的坐标最大到 ${max}，超出 24 的 viewBox 会被裁切`)
    }
  }
})
