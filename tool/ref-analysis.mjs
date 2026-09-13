#!/usr/bin/env node
/**
 * 参考图分析：把一张 PNG 解成像素后输出结构报告，供"看不了图"的模型也能客观判断布局。
 *
 * 输出三部分：
 *   ① 主色直方图（4bit 量化，抗抖动噪声）——用于提取底色/控件色/强调色/文字色
 *   ② 字符画——一眼看出色轮形状、标签栏、色块行列
 *   ③ 横向条带——每行平均色变化 ≥6px 的连续区域，用于判断卡片边界、行高、分隔线
 *
 * 用法：
 *   node tool/ref-analysis.mjs <png 路径> [更多 png...]
 */
import { readFileSync } from 'node:fs'
import { decodePngNode } from '../src/io/node-png.ts'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('用法：node tool/ref-analysis.mjs <png 路径> [更多 png...]')
  process.exit(1)
}

const hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')

function analyze(file) {
  const img = decodePngNode(new Uint8Array(readFileSync(file)))
  const { width: W, height: H, data } = img

  console.log('\n' + '='.repeat(78))
  console.log(`文件：${file.split(/[\\/]/).pop()}   尺寸：${W}×${H}`)
  console.log('='.repeat(78))

  /* ① 主色直方图 */
  const hist = new Map()
  for (let i = 0; i < data.length; i += 4) {
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4)
    const e = hist.get(key) ?? { n: 0, r: 0, g: 0, b: 0, a: 0 }
    e.n++
    e.r += data[i]
    e.g += data[i + 1]
    e.b += data[i + 2]
    e.a += data[i + 3]
    hist.set(key, e)
  }
  const total = W * H
  const top = [...hist.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 12)
    .map(([, e]) => ({ hex: hex(e.r / e.n, e.g / e.n, e.b / e.n), pct: (e.n / total) * 100, alpha: Math.round(e.a / e.n) }))
  console.log('\n【主色】（占比 / 平均 alpha）')
  for (const c of top) console.log(`  ${c.hex}  ${c.pct.toFixed(1).padStart(5)}%   alpha ${c.alpha}`)

  /* ② 字符画 */
  const cols = 72
  const cellW = Math.max(1, Math.floor(W / cols))
  const rows = Math.max(1, Math.floor(H / (cellW * 2)))
  const cellH = Math.max(1, Math.floor(H / rows))
  const RAMP = ' .:-=+*#%@'
  let art = ''
  for (let ry = 0; ry < rows; ry++) {
    let line = ''
    for (let rx = 0; rx < cols; rx++) {
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let y = ry * cellH; y < Math.min(H, (ry + 1) * cellH); y++) {
        for (let x = rx * cellW; x < Math.min(W, (rx + 1) * cellW); x++) {
          const o = (y * W + x) * 4
          const al = data[o + 3] / 255
          // 透明按白底合成，否则透明区会被误判为纯黑
          r += data[o] * al + 255 * (1 - al)
          g += data[o + 1] * al + 255 * (1 - al)
          b += data[o + 2] * al + 255 * (1 - al)
          n++
        }
      }
      const rr = r / n
      const gg = g / n
      const bb = b / n
      const lum = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb
      const mx = Math.max(rr, gg, bb)
      const mn = Math.min(rr, gg, bb)
      const sat = mx === 0 ? 0 : (mx - mn) / mx
      // 饱和区域标 'o'：色轮/彩色滑块会立刻显形
      line += sat > 0.35 && mx > 40 ? 'o' : RAMP[Math.min(RAMP.length - 1, Math.floor(((255 - lum) / 256) * RAMP.length))]
    }
    art += line + '\n'
  }
  console.log(`\n【字符画】（暗→亮 = ${RAMP.trim()}；o = 彩色区域；每格约 ${cellW}×${cellH}px）`)
  console.log(art)

  /* ③ 横向条带 */
  const rowAvg = []
  for (let y = 0; y < H; y++) {
    let r = 0
    let g = 0
    let b = 0
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4
      r += data[o]
      g += data[o + 1]
      b += data[o + 2]
    }
    rowAvg.push(hex(r / W, g / W, b / W))
  }
  const bands = []
  let cur = { from: 0, hex: rowAvg[0] }
  for (let y = 1; y < H; y++) {
    if (rowAvg[y] !== cur.hex) {
      bands.push({ ...cur, to: y - 1 })
      cur = { from: y, hex: rowAvg[y] }
    }
  }
  bands.push({ ...cur, to: H - 1 })
  const big = bands.filter((b) => b.to - b.from + 1 >= 6)
  console.log('【横向条带】（每行平均色变化 ≥6px 的连续区域，可判断卡片/标题栏/行高）')
  for (const b of big.slice(0, 28)) {
    console.log(`  y ${String(b.from).padStart(3)}–${String(b.to).padStart(3)} (${String(b.to - b.from + 1).padStart(2)}px)  ${b.hex}`)
  }
  if (big.length > 28) console.log(`  … 另有 ${big.length - 28} 条`)
}

for (const f of files) analyze(f)
