/**
 * 多引擎图集元数据导出（`src/core/sheetmeta.ts`）。
 *
 * 为什么值得单测：这三种格式都是"**写错了也照样是个文件**"——引擎拿到会报错、
 * 或者更糟：不报错但内容错（帧位置偏移、动画重名、上下颠倒）。
 * 而手边没有 Godot/Unity/Tiled 可验证，所以把**格式的关键不变量**钉在断言里：
 *  - Godot：`load_steps` 与资源数一致、动画名用帧名（**不能都用资源名**，那是重名 bug）；
 *  - Unity：`rect.y` 必须换算成**左下原点**（不换算就整张图上下颠倒）；
 *  - Tiled：`tilecount` / `columns` 与实际帧数一致。
 *
 * 这些都是"不看引擎也能验的客观事实"，比截图对拍可靠得多。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { layoutSheet } from '../core/export.ts'
import {
  ENGINE_EXT,
  ENGINE_FORMATS,
  exportSheetMeta,
  isEngineFormat,
  toGodotTres,
  toTiledTsx,
  toUnityMetaSnippet,
} from '../core/sheetmeta.ts'

/** 4 帧、8×8、2 列的图集 → 16×16 */
const sheet = layoutSheet(
  [
    { name: 'hero_idle', width: 8, height: 8 },
    { name: 'hero_walk', width: 8, height: 8 },
    { name: 'slime_idle', width: 8, height: 8 },
    { name: 'slime_walk', width: 8, height: 8 },
  ],
  2,
)
/** 单帧图集（边界：不能因为只有一帧就崩或产出非法结构） */
const oneFrame = layoutSheet([{ name: 'solo', width: 16, height: 16 }], 1)

test('引擎格式 id：只有登记过的才算合法', () => {
  for (const f of ENGINE_FORMATS) assert.equal(isEngineFormat(f), true)
  assert.equal(isEngineFormat('godot4'), false)
  assert.equal(isEngineFormat(''), false)
  // 每种格式都要有扩展名，否则 CLI 拼不出文件名
  for (const f of ENGINE_FORMATS) assert.ok(ENGINE_EXT[f]?.startsWith('.'), `${f} 缺扩展名`)
})

test('Godot：load_steps 必须是"帧数 + 1"，且每条动画用**帧自己的名字**', () => {
  const tres = toGodotTres(sheet, { texturePath: 'res://art/sheet.png' })
  assert.match(tres, /\[gd_resource type="SpriteFrames" load_steps=5 format=3\]/, 'load_steps 应为 4 帧 + 1')
  assert.match(tres, /path="res:\/\/art\/sheet\.png"/, '应引用传入的贴图路径')
  // 每个帧一个 AtlasTexture，region 指向各自矩形
  const regions = [...tres.matchAll(/region = Rect2\(([^)]+)\)/g)].map((m) => m[1])
  assert.equal(regions.length, 4, `应有 4 个 region，实际 ${regions.length}`)
  assert.deepEqual(regions[0], '0, 0, 8, 8')
  assert.deepEqual(regions[1], '8, 0, 8, 8')
  assert.deepEqual(regions[2], '0, 8, 8, 8')
  /*
   * **动画名必须来自帧名**。这里踩过一次：早期写成资源名 → 4 帧的动画全叫同一个名字，
   * 在 Godot 里是重名冲突（编辑器只保留一条，用户拿到的动画数比帧数少）。
   */
  const animNames = [...tres.matchAll(/"name": &"([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(animNames, ['hero_idle', 'hero_walk', 'slime_idle', 'slime_walk'])
  assert.equal(new Set(animNames).size, 4, '动画名必须互不相同')
})

test('Godot：单帧图集也要产出合法结构（load_steps=2）', () => {
  const tres = toGodotTres(oneFrame, { texturePath: 'x.png' })
  assert.match(tres, /load_steps=2/)
  assert.equal([...tres.matchAll(/AtlasTexture/g)].length, 1)
})

test('Unity：rect.y 必须换算成左下原点（不换算则整张图上下颠倒）', () => {
  const meta = toUnityMetaSnippet(sheet, { textureGuid: 'deadbeef' })
  const rects = [...meta.matchAll(/x: (\d+)\n\s+y: (\d+)\n\s+width: (\d+)\n\s+height: (\d+)/g)].map((m) => ({
    x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]),
  }))
  assert.equal(rects.length, 4, `应有 4 个 rect，实际 ${rects.length}`)
  // 图集高 16、帧高 8：像素坐标 y=0（顶行）→ Unity y=8；像素 y=8（底行）→ Unity y=0
  assert.deepEqual(rects[0], { x: 0, y: 8, w: 8, h: 8 }, '顶行应为 Unity y=8')
  assert.deepEqual(rects[1], { x: 8, y: 8, w: 8, h: 8 })
  assert.deepEqual(rects[2], { x: 0, y: 0, w: 8, h: 8 }, '底行应为 Unity y=0')
  assert.deepEqual(rects[3], { x: 8, y: 0, w: 8, h: 8 })
  // 帧名要带上（Unity 靠 name 定位子精灵）
  for (const n of ['hero_idle', 'hero_walk', 'slime_idle', 'slime_walk']) assert.ok(meta.includes(n), `${n} 应出现在 .meta 里`)
  // 必须提醒"不要整个覆盖"——.meta 里有 Unity 生成的 guid
  assert.match(meta, /不要整个覆盖/, '应提醒用户别覆盖整个 .meta')
})

test('Unity：pixelsPerUnit 缺省取帧高（不写死 100——像素画要的是"1 格 = 1 单位"）', () => {
  const meta = toUnityMetaSnippet(sheet, { textureGuid: 'g' })
  assert.match(meta, /pixelsPerUnit: 8/, '应默认取帧高 8，而不是 Unity 默认的 100')
  const custom = toUnityMetaSnippet(sheet, { textureGuid: 'g', pixelsPerUnit: 32 })
  assert.match(custom, /pixelsPerUnit: 32/)
})

test('Tiled：tilecount / columns 与帧数一致，单帧也不例外', () => {
  const tsx = toTiledTsx(sheet, { textureSource: 'sheet.png' })
  assert.match(tsx, /tilecount="4"/)
  assert.match(tsx, /columns="2"/)
  assert.match(tsx, /tilewidth="8"/)
  assert.match(tsx, /width="16" height="16"/, 'image 尺寸应是整张图集')
  const solo = toTiledTsx(oneFrame, { textureSource: 'x.png' })
  assert.match(solo, /tilecount="1"/)
  assert.match(solo, /columns="1"/)
})

test('Tiled 的 XML 不会出现未转义的 & / <（靠 safeId 先清洗 + 再转义两道）', () => {
  /*
   * 这条断言最初写错了：我期望看到 `name="a&amp;b"`（转义后的原字符），
   * 但实际产出是 `name="a_b"`——因为 `safeId()` **先把非法字符换成下划线**，
   * 转义那一步根本没机会遇到 `&`。
   *
   * 所以真正该断言的不是"转义结果长什么样"，而是**产出里不含未转义的裸字符**：
   * 那才是"XML 合法"这件事本身。两道防线（清洗 + 转义）谁先生效都行，
   * 断言只关心结果合法——这样将来调整 safeId 的白名单也不会误报。
   */
  const evil = layoutSheet([{ name: 'a&b<c', width: 4, height: 4 }], 1)
  const tsx = toTiledTsx(evil, { textureSource: 'x&y.png', name: 'a&b' })
  // 裸 & 只能出现在合法的实体引用里（&amp; &lt; &gt; &quot; &apos;）
  const bareAmp = tsx.replace(/&(amp|lt|gt|quot|apos);/g, '')
  assert.ok(!bareAmp.includes('&'), '出现未转义的 & 会产生非法 XML')
  assert.ok(!tsx.includes('<c'), '出现未转义的 < 会产生非法 XML')
  // 贴图源路径同样要安全
  assert.ok(!tsx.includes('"x&y.png"'), 'image source 里的 & 必须被处理')
})

test('分发入口：unity 缺 textureGuid 必须**报错**而不是产出无效文件', () => {
  assert.throws(
    () => exportSheetMeta('unity', sheet, { texturePath: 'x.png' }),
    /textureGuid/,
    '没有 guid 的 .meta 是无效的，静默产出会让用户以为可用',
  )
  // 给了 guid 就能产出
  assert.match(exportSheetMeta('unity', sheet, { texturePath: 'x.png', textureGuid: 'g' }), /spriteSheet:/)
  assert.match(exportSheetMeta('godot', sheet, { texturePath: 'x.png' }), /godot_resource|gd_resource/)
  assert.match(exportSheetMeta('tiled', sheet, { texturePath: 'x.png' }), /<tileset/)
})
