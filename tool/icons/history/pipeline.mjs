// pipeline.mjs —— 跑通你提的那条链路：SVG 画形状 → 栅格化 → 像素化 → 审图
//
// 用法：node output/UI素材32/tools/pipeline.mjs
//
// 输出：output/UI素材32/svg-from-svg/<id>.svg（最终单色 path，可直接进 icons.ts）
//       output/UI素材32/preview/svg-<id>.png（栅格化结果，看形状）
//       output/UI素材32/preview/svg-<id>.mask.png（像素化后，看是否可读）
// 并在终端打印每个图标的 ASCII 掩码，便于直接核对形状。
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rasterizeSvgs, toMask, maskToAscii } from './rasterize.mjs'
import { SVG_SHAPES } from './shapes-svg.mjs'
import { Grid, checkGeometry, svgFor, GRID, VIEW_BOX, UNIT } from './grid.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..')
const PREVIEW = join(OUT, 'preview')
const SVG_OUT = join(OUT, 'svg-from-svg')
mkdirSync(PREVIEW, { recursive: true })
mkdirSync(SVG_OUT, { recursive: true })

const { encodePngNode } = await import('file:///F:/<项目目录>/src/io/node-png.ts')

/** 栅格化大小的选择：目标 32 格，取 8 倍 = 256px，给抗锯齿留足余量 */
const RASTER = GRID * 8

function renderMask(mask, cell, { bg = '#242424', fg = '#e0e0e0' } = {}) {
  const n = mask.length
  const W = n * cell
  const H = n * cell
  const data = new Uint8ClampedArray(W * H * 4)
  const h2r = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const b = h2r(bg)
  const f = h2r(fg)
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = b[0]; data[i * 4 + 1] = b[1]; data[i * 4 + 2] = b[2]; data[i * 4 + 3] = 255
  }
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (!mask[y][x]) continue
      for (let py = y * cell; py < (y + 1) * cell; py++)
        for (let px = x * cell; px < (x + 1) * cell; px++) {
          if (px < 0 || py < 0 || px >= W || py >= H) continue
          const d = (py * W + px) * 4
          data[d] = f[0]; data[d + 1] = f[1]; data[d + 2] = f[2]; data[d + 3] = 255
        }
    }
  return encodePngNode({ width: W, height: H, data })
}

function maskToGrid(mask) {
  const g = new Grid(GRID)
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) if (mask[y][x]) g.set(x, y, 1)
  return g
}

/** 连通块个数（检查形状是否被切碎；碎掉的形状在小尺寸下会散架） */
function components(mask) {
  const n = mask.length
  const seen = Array.from({ length: n }, () => Array(n).fill(false))
  let count = 0
  const nb = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (seen[y][x] || !mask[y][x]) continue
    count++
    const st = [[x, y]]
    seen[y][x] = true
    while (st.length) {
      const [cx, cy] = st.pop()
      for (const [dx, dy] of nb) {
        const nx = cx + dx, ny = cy + dy
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue
        if (seen[ny][nx] || !mask[ny][nx]) continue
        seen[ny][nx] = true
        st.push([nx, ny])
      }
    }
  }
  return count
}

console.log(`栅格化 ${Object.keys(SVG_SHAPES).length} 个 SVG 形状（${RASTER}px）…`)
const rasters = await rasterizeSvgs(SVG_SHAPES, { size: RASTER })

const rows = []
for (const [id, img] of Object.entries(rasters)) {
  // 阈值可调：0.45 表示"该格覆盖的像素里 45% 是图形"就算实心
  const mask = toMask(img, GRID, { threshold: 0.45 })
  const grid = maskToGrid(mask)
  const d = grid.toPathD()
  const geo = checkGeometry(grid)
  const comps = components(mask)

  writeFileSync(join(SVG_OUT, `${id}.svg`), svgFor(grid), 'utf8')
  writeFileSync(join(PREVIEW, `svg-${id}.raster.png`), renderMask(mask, 8))
  writeFileSync(join(PREVIEW, `svg-${id}.16px.png`), renderMask(mask, 0.5))

  rows.push({ id, geo, comps, cells: grid.count(), bytes: svgFor(grid).length })
  console.log('')
  console.log(`=== ${id}  主体厚 ${geo.strokePx.toFixed(2)}px  连通块 ${comps}  ${grid.count()} 格  ${geo.ok ? '✔ 校验通过' : '✘ ' + geo.problems.join('；')}`)
  console.log(maskToAscii(mask))
}

writeFileSync(join(OUT, '_pipeline-result.json'), JSON.stringify(rows, null, 2))
console.log('')
console.log(`产物：${SVG_OUT}`)
console.log(`预览：${PREVIEW}/svg-*.png`)
const bad = rows.filter((r) => !r.geo.ok || r.comps > 3)
console.log(bad.length ? `\n⚠ 需注意：${bad.map((b) => b.id).join(' ')}` : '\n✔ 全部通过校验且形状完整')
