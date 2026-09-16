#!/usr/bin/env node
/**
 * Agent 快速上手：一条命令跑通「自省 → 造素材 → 批量出图 → 拼豆图纸 → 页内 API」全链路。
 *
 * 设计意图：**让 agent 不看对话记录、只跑一条命令就能确认环境可用并看懂产出**。
 * 它自己生成测试素材（不依赖仓库里有没有素材），产出全部落在 `.quickstart/`（已被 .gitignore 忽略）。
 *
 * 用法：
 *   node tool/quickstart.mjs            # 跑全链路（默认包含浏览器那一步）
 *   node tool/quickstart.mjs --no-browser   # 跳过页内 API 验证（无浏览器环境用）
 *   node tool/quickstart.mjs --out 目录      # 换输出目录
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { startBrowser } from './cdp.mjs'

import { encodePngNode } from '../src/io/node-png.ts'
import { decodePngNode } from '../src/io/node-png.ts'
import { getPreset } from '../src/core/palettes.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const hasFlag = (f) => process.argv.includes(`--${f}`)
const argVal = (f, fb) => {
  const i = process.argv.indexOf(`--${f}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fb
}

const OUT = join(ROOT, argVal('out', '.quickstart'))
const SKIP_BROWSER = hasFlag('no-browser')

const step = (n, title) => console.log(`\n${'─'.repeat(64)}\n${n}. ${title}\n${'─'.repeat(64)}`)
const ok = (msg) => console.log(`  ✔ ${msg}`)
const info = (msg) => console.log(`    ${msg}`)

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/** 造一张带透明背景的合成素材（agent 常常需要"自己产生输入"） */
function makeFixture(path, { width = 96, height = 96, tint = 0 } = {}) {
  const data = new Uint8ClampedArray(width * height * 4)
  const cx = width / 2
  const cy = height / 2
  const r = Math.min(cx, cy) * 0.82
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const inside = (x - cx) ** 2 + (y - cy) ** 2 < r * r
      if (!inside) continue // 圆外留透明
      data[o] = (tint + x * 2) % 256
      data[o + 1] = (tint + y * 2) % 256
      data[o + 2] = 110
      data[o + 3] = 255
    }
  }
  writeFileSync(path, encodePngNode({ width, height, data }))
}

/* ============================================================ 1. 自省 */

step(1, 'agent 自省：一次拿全能力（不必猜文档）')
const describe = run(process.execPath, ['tool/artc.mjs', '--describe'])
if (describe.code !== 0) {
  console.error('  ✘ --describe 失败：\n' + describe.out)
  process.exit(1)
}
const caps = JSON.parse(describe.out)
ok(`apiLevel ${caps.apiLevel} · schema v${caps.schemaVersion} · 画布上限 ${caps.canvasSideMax} 格 / 色板 ${caps.paletteMax} 色`)
ok(`算子 ${caps.ops.length} 类：${caps.ops.map((o) => o.op).join(' ')}`)
ok(`参数 ${caps.params.length} 项 · 预置色卡：${caps.presets.map((p) => p.id + (p.hasCodes ? '(带号色)' : '')).join(' / ')}`)
ok(`解码：Node 端 ${caps.decodeFormatsInNode.join('/')} · 浏览器端 ${caps.decodeFormatsInBrowser.length} 种`)
info(`动画：${caps.animation === false ? '未实现（逐帧出图后用 --sheet 拼图集）' : '已实现'}`)

const selftest = run(process.execPath, ['tool/artc.mjs', '--selftest'])
const selLine = selftest.out.split('\n').filter((l) => l.includes('自检：')).pop() ?? '(未输出)'
if (!/自检：\d+\/\d+ 通过$/.test(selLine.trim())) {
  console.error(`  ✘ 自检未全绿：${selLine.trim()}\n${selftest.out}`)
  process.exit(1)
}
ok(selLine.trim())

/* ============================================================ 2. 造素材 */

step(2, '生成测试素材（agent 自己产生输入，不依赖仓库里的图）')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, 'in'), { recursive: true })
makeFixture(join(OUT, 'in', 'hero.png'), { tint: 0 })
makeFixture(join(OUT, 'in', 'slime.png'), { tint: 140 })
for (const f of ['hero.png', 'slime.png']) {
  const p = join(OUT, 'in', f)
  const img = decodePngNode(new Uint8Array(readFileSync(p)))
  ok(`生成 ${f}（${img.width}×${img.height}，带透明背景，${readFileSync(p).length} 字节）`)
}

/* ============================================================ 3. 批量出游戏资产 */

step(3, '批量出游戏资产：精确尺寸 + 真 alpha + 统一色板 + 图集坐标表')
const batch = run(process.execPath, [
  'tool/artc.mjs', '--in', join(OUT, 'in'), '--out', join(OUT, 'assets'),
  '--palette', 'pico8', '--size', '32x32', '--alpha', '--scale', '4', '--sheet', '2', '--json', '--quiet',
])
if (batch.code !== 0) {
  console.error('  ✘ 批量失败：\n' + batch.out)
  process.exit(1)
}
const batchJson = JSON.parse(batch.out.slice(batch.out.indexOf('{')))
ok(`成功 ${batchJson.ok} 张 / 失败 ${batchJson.failed} 张`)
for (const r of batchJson.results) {
  const swatch = new Set()
  info(`${r.file}  ${r.width}×${r.height}  ${r.paletteSize} 色  透明 ${r.transparent} 格  hash ${r.hash}`)
  void swatch
}
const sheetPath = join(OUT, 'assets', '_sheet.json')
const sheet = JSON.parse(readFileSync(sheetPath, 'utf8'))
ok(`图集坐标表 _sheet.json：${sheet.columns}×${sheet.rows}，${sheet.frames.length} 帧`)
for (const f of sheet.frames) {
  info(`帧 ${f.name}: x=${f.x} y=${f.y} ${f.width}×${f.height} offset(${f.offsetX},${f.offsetY})`)
}
// 断言帧矩形互不相交（引擎侧最怕重叠）
const rects = sheet.frames
let overlap = false
for (let i = 0; i < rects.length; i++) {
  for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i]
    const b = rects[j]
    if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) overlap = true
  }
}
if (overlap) {
  console.error('  ✘ 图集帧矩形存在重叠')
  process.exit(1)
}
ok('帧矩形互不相交')

/* ============================================================ 4. 拼豆图纸 */

step(4, '拼豆图纸：固定号色板 + 图纸 SVG + 缺口清单 CSV')
const beadPreset = getPreset('beads16')
const bead = run(process.execPath, [
  'tool/artc.mjs', '--in', join(OUT, 'in', 'hero.png'), '--out', join(OUT, 'beads'),
  '--preset', 'beads16', '--long-edge', '58', '--bead', '--quiet',
])
if (bead.code !== 0) {
  console.error('  ✘ 拼豆失败：\n' + bead.out)
  process.exit(1)
}
const beadCsvPath = join(OUT, 'beads', 'hero_58x58_1x_缺口清单.csv')
const beadSvgPath = join(OUT, 'beads', 'hero_58x58_1x_图纸.svg')
if (!existsSync(beadCsvPath) || !existsSync(beadSvgPath)) {
  console.error('  ✘ 未产出图纸 SVG 或缺口清单 CSV')
  process.exit(1)
}
const csvLines = readFileSync(beadCsvPath, 'utf8').trim().split('\n')
ok(`缺口清单 ${csvLines.length} 行 / 图纸 SVG ${(readFileSync(beadSvgPath).length / 1024).toFixed(0)} KB`)
for (const line of csvLines.slice(0, 4)) info(line)
// 号色必须来自色卡（回归防线：曾经印成自动编号 C1/C2）
const bodyRows = csvLines.slice(1).filter((l) => /^[A-Z]+\d+,/.test(l))
if (bodyRows.length === 0) {
  console.error('  ✘ 清单里的编号不是色卡号色（可能是自动编号）')
  process.exit(1)
}
for (const row of bodyRows) {
  const code = row.split(',')[0]
  if (!beadPreset.codes.includes(code)) {
    console.error(`  ✘ 号色 ${code} 不在 beads16 色卡内`)
    process.exit(1)
  }
}
ok(`号色全部来自色卡（${bodyRows.map((r) => r.split(',')[0]).join(' ')}）`)
// 守恒：每色格数之和 + 透明格 = 总格数
const total = csvLines.find((l) => l.startsWith('合计,'))?.split(',')[2]
const transparent = csvLines.find((l) => l.startsWith('透明格,'))?.split(',')[2]
const canvasRow = csvLines.find((l) => l.startsWith('画布,'))?.split(',')[2]
info(`守恒校验：合计 ${total} + 透明 ${transparent} = ${Number(total) + Number(transparent)}，画布 ${canvasRow}`)
if (Number(total) + Number(transparent) !== Number(canvasRow)) {
  console.error('  ✘ 用量守恒失败')
  process.exit(1)
}
ok('用量守恒')

/* ============================================================ 5. 页内 API（浏览器） */

step(5, SKIP_BROWSER ? '页内 API：已跳过（--no-browser）' : '页内 API：用无头浏览器驱动界面出图')

if (!SKIP_BROWSER) {
  // 共用 cdp.mjs：浏览器定位 / 启动 / 取端口 / 清理都收在那里（原先这里内联了第七份 CDP 客户端）
  let session = null
  try {
    session = await startBrowser({ profilePrefix: 'quickstart-' })
  } catch {
    // 找不到浏览器不是失败：其余链路已经验证过了
    console.log('  ⚠ 找不到 Edge/Chrome，跳过这一步（其余链路已验证）')
  }
  if (session) {
    const { cdp: send } = session
    const evl = (expr) => session.cdp.eval(expr)
    try {
      await send.send('Runtime.enable')
      await send.send('Page.enable')
      await send.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
      await send.send('Page.navigate', { url: pathToFileURL(join(ROOT, '像素画工作台.html')).href })
      for (let i = 0; i < 60; i++) {
        if (await evl('!!window.pixelArtStudio')) break
        await new Promise((r) => setTimeout(r, 150))
      }
      const methodCount = JSON.parse(await evl('JSON.stringify(Object.keys(window.pixelArtStudio).filter((k) => typeof window.pixelArtStudio[k] === "function"))')).length
      ok(`页内 API 已挂载，公开方法 ${methodCount} 个`)

      const r = JSON.parse(
        await evl(`(async () => {
          const ps = window.pixelArtStudio
          const blank = await ps.renderBlank(
            { width: 24, height: 24, transparent: true, ops: [
              { op: 'rect', x0: 3, y0: 3, x1: 20, y1: 20, color: '#223344' },
              { op: 'ellipse', x0: 7, y0: 7, x1: 16, y1: 16, color: '#ff6600', filled: false },
              { op: 'trim' },
            ] },
            { longEdge: 24 }, 4)
          return JSON.stringify({
            w: blank.width, h: blank.height, changes: blank.changes.length,
            png: String(blank.png).startsWith('data:image/png'),
            hash: blank.hash, usageKeys: Object.keys(blank.usage).length,
          })
        })()`),
      )
      if (!r.png) throw new Error('renderBlank 未返回 PNG dataURL')
      ok(`renderBlank（无副作用一站式）：${r.w}×${r.h}，${r.changes} 条算子改动，hash ${r.hash}`)
      // 注意别写成"不碰自动草稿"：**自动草稿根本没实现**（刷新页面会丢未导出的编辑，
      // 见 src/core/limits.ts 里 DRAFT_* 那段的说明与路线图 A2）。
      info('它不碰工作区状态、当前画布与撤销栈，所以适合批量并行调用')

      // 把页内产出的 PNG 落到磁盘，证明"agent 能拿到可用的图"
      const dataUrl = await evl(`(async () => {
        const ps = window.pixelArtStudio
        const b = await ps.renderBlank({ width: 16, height: 16, color: '#101820', ops: [{ op: 'ellipse', x0: 2, y0: 2, x1: 13, y1: 13, color: '#ffd166' }] }, { longEdge: 16 }, 4)
        return b.png
      })()`)
      const b64 = String(dataUrl).split(',')[1] ?? ''
      const bytes = Buffer.from(b64, 'base64')
      const outPng = join(OUT, 'from-page-api.png')
      writeFileSync(outPng, bytes)
      const back = decodePngNode(new Uint8Array(bytes))
      ok(`页内 API 产出的 PNG 已落盘：from-page-api.png（${back.width}×${back.height}，${bytes.length} 字节）`)
    } finally {
      await session.close()
    }
  }
}

/* ============================================================ 汇总 */

step(6, '产出清单')
const { readdirSync, statSync } = await import('node:fs')
const listFiles = (dir) => {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...listFiles(p))
    else out.push({ path: p.replace(ROOT + '\\', '').replace(ROOT + '/', ''), size: statSync(p).size })
  }
  return out
}
for (const f of listFiles(OUT).sort((a, b) => a.path.localeCompare(b.path))) {
  info(`${f.path}  ${(f.size / 1024).toFixed(1)} KB`)
}

console.log(`
${'═'.repeat(64)}
全链路通过。给 agent 的三条常用命令：

  # 1) 批量出游戏资产（精确尺寸 + 真 alpha + 图集坐标表）
  node tool/artc.mjs --in 素材目录 --out 输出 --palette pico8 --size 32x32 --alpha --sheet 4

  # 2) 拼豆图纸（号色 + 图纸 SVG + 缺口清单 CSV）
  node tool/artc.mjs --in 图片.png --out 输出 --preset beads16 --long-edge 58 --bead

  # 3) 纯程序化出素材（不需要输入图）
  node tool/artc.mjs --blank 32x32 --blank-transparent --out 输出 \\
    --ops '[{"op":"rect","x0":2,"y0":2,"x1":29,"y1":29,"color":"#1d2b53"},{"op":"trim"}]'

完整契约：docs/AGENT_API.md（由 src/core/spec.ts 生成）
测试方法：见 docs/开发.md 的「验证链」与「测试容易踩的五个坑」
本次产物：${OUT.replace(ROOT + '\\', '')}${'  '}（已被 .gitignore 忽略）
${'═'.repeat(64)}`)
