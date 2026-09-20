#!/usr/bin/env node
// pixel-gen.mjs —— 像素产线：出整包 UI 图标素材（32×32 网格）
//
// 用法：npm run icons:gen   （或 node tool/icons/pixel-gen.mjs）
//
// 每个图标：① 画（32 格网格）→ ② 转单色 SVG → ③ 几何校验（含"笔画够粗"）
// 另出：放大 PNG（看形状）、**实机 16px PNG**（看清晰度，这是本方案的验收点）、总览、清单。
//
// 产物一律落在 `tool/icons/.out/`（已 gitignore）：这些都是**可再生的审图材料**，
// 不进仓库。进仓库的是"形状定义"（pixel-shapes.mjs / svg-shapes.mjs）与
// "接线结果"（src/app/ui/icons.ts）。
//
// ⚠️ 本文件**不写 icons.ts**。接线走 `npm run icons:sync`（pixel-sync + svg-sync）——
// 出图与接线分开，避免"审图跑过了、接线没跑"造成的两边不一致。
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ICONS } from './pixel-shapes.mjs'
import { svgFor, GRID, VIEW_BOX } from './pixel-grid.mjs'
import { buildPixelIcons } from './pixel-data.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 审图产物目录（可再生，不进仓库） */
const OUT = join(HERE, '.out')
const SVG_DIR = join(OUT, 'svg')
const PREVIEW = join(OUT, 'preview')

/*
 * 相对 import —— 按 import.meta.url 定位。
 * 原先这里写的是 `file:///F:/<项目目录>/src/io/node-png.ts`（**绝对路径**），
 * 换台机器/换个盘符就直接崩，属于"只在本机可用"的隐性缺陷。
 */
const { encodePngNode } = await import(new URL('../../src/io/node-png.ts', import.meta.url).href)

for (const d of [SVG_DIR, PREVIEW]) rmSync(d, { recursive: true, force: true })
mkdirSync(SVG_DIR, { recursive: true })
mkdirSync(PREVIEW, { recursive: true })

/** 把网格渲染成 PNG：`cell` = 每格多少像素（8 = 放大审图；0.5 = 实机 16px） */
function renderPng(grid, cell, { bg = '#242424', fg = '#e0e0e0' } = {}) {
  const W = Math.max(1, Math.round(grid.n * cell))
  const H = Math.max(1, Math.round(grid.n * cell))
  const data = new Uint8ClampedArray(W * H * 4)
  const h2r = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const b = h2r(bg)
  const f = h2r(fg)
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = b[0]; data[i * 4 + 1] = b[1]; data[i * 4 + 2] = b[2]; data[i * 4 + 3] = 255
  }
  for (let y = 0; y < grid.n; y++)
    for (let x = 0; x < grid.n; x++) {
      if (!grid.g[y][x]) continue
      for (let py = Math.round(y * cell); py < Math.round((y + 1) * cell); py++)
        for (let px = Math.round(x * cell); px < Math.round((x + 1) * cell); px++) {
          if (px < 0 || py < 0 || px >= W || py >= H) continue
          const d = (py * W + px) * 4
          data[d] = f[0]; data[d + 1] = f[1]; data[d + 2] = f[2]; data[d + 3] = 255
        }
    }
  return encodePngNode({ width: W, height: H, data })
}

/*
 * 构造与校验统一走 `pixel-data.mjs`：`pixel-sync.mjs` 用的是**同一个函数**，
 * 所以"这里审过的图"与"接进 icons.ts 的图"必然是同一份数据。
 */
const { made: built, failures } = buildPixelIcons()
const made = []

for (const m of built) {
  writeFileSync(join(SVG_DIR, `${m.id}.svg`), svgFor(m.grid), 'utf8')
  writeFileSync(join(PREVIEW, `${m.id}.big.png`), renderPng(m.grid, 8))
  writeFileSync(join(PREVIEW, `${m.id}.16px.png`), renderPng(m.grid, 0.5))
  made.push({ ...m, bytes: svgFor(m.grid).length, cells: m.grid.count() })
  console.log(
    `✔ ${m.id.padEnd(16)} 包围盒 ${m.geo.w.toFixed(0)}×${m.geo.h.toFixed(0)}  ` +
      `主体厚 ${m.geo.strokePx.toFixed(2)}px  ${(m.d.match(/M/g) ?? []).length} 段  ${svgFor(m.grid).length}B`,
  )
}
for (const f of failures) console.error(`✘ ${f.id}: ${f.reason}`)

/* ---------------------------------------------------------- 总览（放大 + 实机） */

/**
 * 拼总览。**同时出放大版与实机 16px 版**——本方案的验收点是"16px 下可读"，
 * 只看放大版会自欺（16 格那版就是放大很漂亮、实机糊成一团）。
 */
function sheet(items, { columns = 5, cell = 8, pad = 3, bg = '#242424', fg = '#e0e0e0', label = '' }) {
  const cw = Math.max(...items.map((i) => i.grid.n))
  const cols = Math.min(columns, items.length)
  const rows = Math.ceil(items.length / cols)
  const cellPx = Math.round(cw * cell)
  const padPx = Math.round(pad * cell)
  const W = cols * (cellPx + padPx) + padPx
  const H = rows * (cellPx + padPx) + padPx
  const data = new Uint8ClampedArray(W * H * 4)
  const h2r = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const b = h2r(bg)
  const f = h2r(fg)
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = b[0]; data[i * 4 + 1] = b[1]; data[i * 4 + 2] = b[2]; data[i * 4 + 3] = 255
  }
  items.forEach((it, idx) => {
    const c = idx % cols
    const r = Math.floor(idx / cols)
    const ox = padPx + c * (cellPx + padPx)
    const oy = padPx + r * (cellPx + padPx)
    for (let y = 0; y < it.grid.n; y++)
      for (let x = 0; x < it.grid.n; x++) {
        if (!it.grid.g[y][x]) continue
        for (let py = Math.round(oy + y * cell); py < Math.round(oy + (y + 1) * cell); py++)
          for (let px = Math.round(ox + x * cell); px < Math.round(ox + (x + 1) * cell); px++) {
            if (px < 0 || py < 0 || px >= W || py >= H) continue
            const dd = (py * W + px) * 4
            data[dd] = f[0]; data[dd + 1] = f[1]; data[dd + 2] = f[2]; data[dd + 3] = 255
          }
      }
  })
  return { png: encodePngNode({ width: W, height: H, data }), w: W, h: H, label }
}

const bgList = [['dark', '#242424', '#e0e0e0'], ['light', '#d8d8d8', '#242424']]
for (const [bgName, bg, fg] of bgList) {
  const big = sheet(made, { columns: 5, cell: 8, bg, fg })
  writeFileSync(join(PREVIEW, `总览-放大-${bgName}.png`), big.png)
  // 实机 16px：cell = 0.5（32格×0.5 = 16px），再整体放大 4 倍便于在图里看清
  const tiny = sheet(made, { columns: 5, cell: 0.5, bg, fg })
  writeFileSync(join(PREVIEW, `总览-实机16px-${bgName}.png`), tiny.png)
}
// 单独再出一张"实机16px 放大 4 倍"的（便于肉眼检查，不放大根本看不见）
{
  const cells = made.map((m) => ({ grid: m.grid }))
  const cw = 32, cols = 5, rows = Math.ceil(made.length / cols)
  const SCALE = 4, PAD = 10
  const W = cols * (cw * SCALE + PAD) + PAD
  const H = rows * (cw * SCALE + PAD) + PAD
  const data = new Uint8ClampedArray(W * H * 4)
  const bg = [36, 36, 36], fg = [224, 224, 224]
  for (let i = 0; i < W * H; i++) { data[i*4]=bg[0]; data[i*4+1]=bg[1]; data[i*4+2]=bg[2]; data[i*4+3]=255 }
  // 先用 0.5 格/px 得到 16px 位图，再最近邻放大 4 倍 —— 忠实地模拟"16px 显示"的像素
  cells.forEach((it, idx) => {
    const c = idx % cols, r = Math.floor(idx / cols)
    const ox = PAD + c * (cw * SCALE + PAD), oy = PAD + r * (cw * SCALE + PAD)
    const S = 0.5 // 32 格 → 16px
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      // 该 16px 像素覆盖 2×2 格：任一格实心就算实心（最近邻抽样）
      const solid = it.grid.g[y * 2]?.[x * 2]
      if (!solid) continue
      for (let sy = 0; sy < SCALE; sy++) for (let sx = 0; sx < SCALE; sx++) {
        const dx = ox + x * SCALE + sx, dy = oy + y * SCALE + sy
        if (dx < 0 || dy < 0 || dx >= W || dy >= H) continue
        const dd = (dy * W + dx) * 4
        data[dd]=fg[0]; data[dd+1]=fg[1]; data[dd+2]=fg[2]; data[dd+3]=255
      }
    }
  })
  writeFileSync(join(PREVIEW, '总览-实机16px-放大4倍.png'), encodePngNode({ width: W, height: H, data }))
}

/* ---------------------------------------------------------- 清单 */

const catTitle = { tool: '工具图标', action: '顶栏动作', category: '面板分类', chrome: '折叠与控件' }
const lines = []
lines.push('# pixquilt · UI 图标素材（32×32 版）')
lines.push('')
lines.push('> 由本仓库的 pixquilt（像素画工作台）生成：像素网格画形状 → 转**单色 SVG** → 几何校验。')
lines.push('')
lines.push('## 为什么改用 32×32 画布')
lines.push('')
lines.push('上一版用 16×16，在 16px 显示尺寸下**读不出来**（填充桶糊成实心疙瘩、选区只剩两个方括号）。')
lines.push('根因是换算：图标显示 16px、viewBox 恒 24，于是')
lines.push('')
lines.push('| 画布 | 1 格 = 多少屏幕像素 | 结论 |')
lines.push('|---|---|---|')
lines.push('| 16×16 | **1.000 px** | 任何 1 格宽的线都只有 1px → 抗锯齿发灰发糊 |')
lines.push('| 32×32 | 0.500 px | 笔画画到 3~4 格（1.5~2px）就是实心；且斜线/弧度能画得更准 |')
lines.push('')
lines.push('**注意**：清晰度来自"最终笔画 ≥1.5px"，不是画布大本身。所以校验里锁了"主体厚 ≥1.4px"，')
lines.push('画得细一样会糊——这条由工具保证，不靠画的人自觉。')
lines.push('')
lines.push(`- 图标：**${Object.keys(ICONS).length}** 个（已生成 ${made.length} 个 SVG）`)
lines.push(`- 画布：${GRID}×${GRID} 格 → \`viewBox="0 0 ${VIEW_BOX} ${VIEW_BOX}"\``)
lines.push('- 形态：**单色**（`fill="currentColor"`），一套适配正常/悬停/激活/禁用全部状态')
lines.push('')
lines.push('## 校验口径（沿用 e2e-pdf.mjs 的图标断言 + 一条新增）')
lines.push('')
lines.push('| 断言 | 要求 |')
lines.push('|---|---|')
lines.push('| viewBox | 恰好 `0 0 24 24` |')
lines.push('| 笔画范围 | 所有坐标落在 `[0,24]²` |')
lines.push('| 图标尺寸 | 包围盒 ≥12×12（折叠三角除外，它天生是扁的） |')
lines.push('| **主体厚** | **≥1.4px @16px 显示**（本方案能否清晰的关键） |')
lines.push('')

for (const [cat, title] of Object.entries(catTitle)) {
  const list = made.filter((m) => m.cat === cat)
  if (!list.length) continue
  lines.push(`## ${title}`)
  lines.push('')
  lines.push('| 图标 | 名称 | 包围盒 | 主体厚 | path 段数 | 实心格数 |')
  lines.push('|---|---|---|---|---|---|')
  for (const m of list) {
    lines.push(
      `| \`${m.id}\` | ${m.name} | ${m.geo.w.toFixed(0)}×${m.geo.h.toFixed(0)} | ${m.geo.strokePx.toFixed(2)}px | ${(m.d.match(/M/g) ?? []).length} | ${m.cells} |`,
    )
  }
  lines.push('')
}

lines.push('## 预览图')
lines.push('')
lines.push('- `总览-放大-dark.png` / `-light.png`：32×32 放大，看**形状**')
lines.push('- `总览-实机16px-*.png`：按 16px 真实尺寸渲染，看**清晰度**（这才是验收点）')
lines.push('- `总览-实机16px-放大4倍.png`：同上但放大 4 倍，便于肉眼检查')
lines.push('- `preview/<id>.big.png` 与 `preview/<id>.16px.png`：单张的两种尺寸')
lines.push('')
if (failures.length) {
  lines.push('## ⚠ 失败项')
  lines.push('')
  for (const f of failures) lines.push(`- \`${f.id}\`：${f.reason}`)
  lines.push('')
}
writeFileSync(join(OUT, '素材清单.md'), lines.join('\n'))

/*
 * 曾经这里还会再吐一份 `icons-data-32.ts`（path 数据草稿），由另一个脚本抄进 icons.ts。
 * 那是一条**冗余的第二副本**：同一份数据存在两处，早晚不一致——实测它的 `undo` /
 * `regenerate` 就与形状定义漂移了（因为那份数据被 SVG_PATHS 遮蔽、没人看得出来）。
 * 现在接线由 `npm run icons:sync` 直接从形状定义算到 icons.ts，不再落第二份副本。
 */

console.log('')
console.log(`产物：${OUT}`)
console.log(`SVG ${made.length} 个 / 预览图若干 / 清单 1 份`)
console.log(`接线请跑：npm run icons:sync`)
if (failures.length) {
  console.error(`✘ 失败 ${failures.length} 项：`)
  for (const f of failures) console.error(`  - ${f.id}: ${f.reason}`)
  process.exit(1)
}
console.log('✔ 全部图标几何校验通过（含"主体厚 ≥1.4px"）')
