/**
 * 图集**切片**：把一张大图按网格切成多张子图（与 `export.ts` 的 `layoutSheet` 方向相反）。
 *
 * 为什么单独放一个文件：`layoutSheet` 只管"算坐标不渲染"，而切片要真的把像素搬出来。
 * 放在 core 是因为它不碰 fs / 不碰 DOM——CLI 拿到子图后照常走 runPipeline 那条链路。
 *
 * 典型用途：AI 生图给的 tileset / 精灵图集是一整张，需要拆成单帧再逐张像素化。
 * 注意与 `--sheet` 的分工：`--sheet` 是**输出**坐标表（拼图集），`--slice` 是**输入**拆分（拆图集）。
 */
import type { RgbaImage } from './png.ts'

export interface SliceGrid {
  columns: number
  rows: number
  cellWidth: number
  cellHeight: number
}

export interface SlicePiece {
  /** 在网格里的位置（从 0 开始，行优先） */
  index: number
  col: number
  row: number
  name: string
  image: RgbaImage
}

/**
 * 按显式网格切片。`columns`/`rows` 必须能整除图宽高，否则报错——
 * 静默丢弃余下像素会让 agent 以为"切完了"，而实际上最后一列/行整块丢了。
 */
export function sliceByGrid(img: RgbaImage, columns: number, rows: number, opts: { baseName?: string; prefix?: string } = {}): SlicePiece[] {
  if (!Number.isInteger(columns) || columns < 1) throw new Error(`切片列数必须是正整数，收到 ${columns}`)
  if (!Number.isInteger(rows) || rows < 1) throw new Error(`切片行数必须是正整数，收到 ${rows}`)
  if (img.width % columns !== 0 || img.height % rows !== 0) {
    throw new Error(
      `图宽高 ${img.width}×${img.height} 无法被 ${columns}×${rows} 网格整除（每格会得到非整数尺寸）；` +
        `请给出能整除的列数/行数，或用 --slice auto 自动推断`,
    )
  }
  const cw = img.width / columns
  const ch = img.height / rows
  const base = opts.baseName ?? 'slice'
  const out: SlicePiece[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const image: RgbaImage = { width: cw, height: ch, data: new Uint8ClampedArray(cw * ch * 4) }
      for (let y = 0; y < ch; y++) {
        const srcRow = (r * ch + y) * img.width * 4
        const dstRow = y * cw * 4
        for (let x = 0; x < cw; x++) {
          const s = srcRow + (c * cw + x) * 4
          const d = dstRow + x * 4
          image.data[d] = img.data[s]
          image.data[d + 1] = img.data[s + 1]
          image.data[d + 2] = img.data[s + 2]
          image.data[d + 3] = img.data[s + 3]
        }
      }
      const index = r * columns + c
      const idxStr = String(index).padStart(2, '0')
      out.push({ index, col: c, row: r, name: `${base}_${idxStr}`, image })
    }
  }
  return out
}

/**
 * `auto`：自动推断网格——把**整行/整列全透明**当作分隔线。
 *
 * 这是图集最常见的排版（每帧之间有透明缝），所以无需人工数格子。
 * 找不到任何分隔线时退回"按单元格边长推断"：取最大透明间距作为格宽/格高，
 * 仍推不出就报错（宁可不切，也不猜错把帧切坏）。
 */
export function sliceAuto(img: RgbaImage, opts: { baseName?: string; tolerate?: number } = {}): SlicePiece[] {
  const { width: w, height: h, data } = img
  const rowOpaque = new Uint8Array(h)
  const colOpaque = new Uint8Array(w)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] === 0) continue
      rowOpaque[y] = 1
      colOpaque[x] = 1
    }
  const ranges = (flags: Uint8Array): [number, number][] => {
    const out: [number, number][] = []
    let start = -1
    for (let i = 0; i < flags.length; i++) {
      if (flags[i]) {
        if (start < 0) start = i
      } else if (start >= 0) {
        out.push([start, i - 1])
        start = -1
      }
    }
    if (start >= 0) out.push([start, flags.length - 1])
    return out
  }
  const colRanges = ranges(colOpaque)
  const rowRanges = ranges(rowOpaque)
  if (!colRanges.length || !rowRanges.length) throw new Error('整张图全透明，无法自动推断切片网格')
  // 每段内容尺寸应当一致；不一致说明这不是规整图集（可能只是稀疏内容），不该自动切
  const cw = colRanges[0][1] - colRanges[0][0] + 1
  const ch = rowRanges[0][1] - rowRanges[0][0] + 1
  const uniform = (rs: [number, number][], size: number) => rs.every(([a, b]) => b - a + 1 === size)
  if (!uniform(colRanges, cw) || !uniform(rowRanges, ch)) {
    throw new Error(
      `自动切片需要规整图集（每帧尺寸一致），实测内容块尺寸不等：` +
        `列 ${colRanges.map(([a, b]) => b - a + 1).join('/')}，行 ${rowRanges.map(([a, b]) => b - a + 1).join('/')}；` +
        `请显式给出 --slice WxH 或 --slice 列数x行数`,
    )
  }
  const base = opts.baseName ?? 'slice'
  const out: SlicePiece[] = []
  let index = 0
  for (let r = 0; r < rowRanges.length; r++) {
    for (let c = 0; c < colRanges.length; c++) {
      const [cx0, cx1] = colRanges[c]
      const [ry0, ry1] = rowRanges[r]
      const pw = cx1 - cx0 + 1
      const ph = ry1 - ry0 + 1
      const image: RgbaImage = { width: pw, height: ph, data: new Uint8ClampedArray(pw * ph * 4) }
      for (let y = 0; y < ph; y++) {
        for (let x = 0; x < pw; x++) {
          const s = ((ry0 + y) * w + (cx0 + x)) * 4
          const d = (y * pw + x) * 4
          image.data[d] = data[s]
          image.data[d + 1] = data[s + 1]
          image.data[d + 2] = data[s + 2]
          image.data[d + 3] = data[s + 3]
        }
      }
      out.push({ index, col: c, row: r, name: `${base}_${String(index).padStart(2, '0')}`, image })
      index++
    }
  }
  return out
}
