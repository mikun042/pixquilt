// 把实机 16px 真值图里的某一个图标区域打成 ASCII，直接看像素。
// 用途：判断"孔有没有被糊死""笔画实际几 px 厚"这类只有看像素才能确定的事。
// 用法：node ascii16.mjs <真值图png> <图标序号(0起)> [亮度阈值]
import { readFileSync } from 'node:fs'
import { decodePngNode } from '../../src/io/node-png.ts'

const file = process.argv[2]
const idx = Number(process.argv[3] ?? 0)
const ZOOM = 8
const CELL = 40
const img = decodePngNode(new Uint8Array(readFileSync(file)))

// 与 preview-16.mjs 相同的布局：第 i 个格子的 svg 左上角在 (20+i*40, 22)
const x0 = 20 + idx * CELL
const y0 = 22
const W = 18
const H = 18
let out = ''
for (let y = 0; y < H; y++) {
  let row = ''
  for (let x = 0; x < W; x++) {
    // 每个逻辑像素取 ZOOM 块的中心点
    const sx = (x0 + x) * ZOOM + ZOOM / 2
    const sy = (y0 + y) * ZOOM + ZOOM / 2
    const o = (sy * img.width + sx) * 4
    const lum = img.data[o] // 前景是浅色 #e6e6e6，背景 #232323，取红通道即可
    row += lum > 200 ? '#' : lum > 120 ? '+' : lum > 60 ? '.' : ' '
  }
  out += row + '\n'
}
console.log(out)
console.log(`（230=前景 #e6e6e6，35=背景 #232323；# 实心 / + 半透明 / . 很淡 / 空 背景）`)
