/**
 * 拼豆图纸 PDF：**按分板出可打印的图纸**。
 *
 * 为什么用 PDF 而不是只给 SVG：SVG 适合屏幕上缩放查看，但拿去打印/交给别人拼时，
 * PDF 的分页、纸张尺寸与毫米级物理尺寸是确定的——这正是打印图纸需要的。
 *
 * 纸张：A4（595.28 × 841.89 pt = 210 × 297 mm）。每块板占一页中的一格，
 * 页脚是图例（号色 / 颜色 / 格数）。58×58 的板在 A4 上约 3mm/格，
 * 号色能印在格子里（实测 5pt 字号可读）。
 *
 * 与 `beadSvg` 的关系：共用 `beadReport` 的分板与号色逻辑，只是排版落点不同。
 * 两者都必须在"格子太小时"退化——PDF 里是缩小字号并在图例里保留全部信息。
 */
import type { PixelArt } from './types.ts'
import { ALPHA_THRESHOLD } from './limits.ts'
import { beadReport, type BeadOptions } from './bead.ts'
import { buildPdf, buildPdfAsync, type PdfNode, type PdfPage } from './pdf.ts'

/** A4 纵向，单位 pt */
export const A4 = { width: 595.28, height: 841.89 } as const

const MARGIN = 28
/** 内容区宽度 */
const CONTENT_W = A4.width - MARGIN * 2
/** 标题区高度 */
const HEADER_H = 44
/** 页脚（图例）预留高度 */
const FOOTER_H = 96

export interface BeadPdfOptions extends BeadOptions {
  /** 标题文字（**只能 ASCII**，见 pdf.ts 的 WinAnsi 限制） */
  title?: string
  beadMm?: number
  /** 每页放几块板：1 = 每页一块（默认，格子最大）；2 或 4 = 紧凑排列 */
  boardsPerPage?: 1 | 2 | 4
  /** zlib 压缩；不传则不压缩（文件更大但合法）。可返回 Promise（浏览器 CompressionStream） */
  deflate?: (data: Uint8Array) => Uint8Array | Promise<Uint8Array>
}

/** 取某格的颜色索引与是否透明 */
function cellAt(art: PixelArt, x: number, y: number): { index: number; opaque: boolean } {
  const p = y * art.width + x
  const opaque = art.alphaMask ? art.alphaMask[p] >= ALPHA_THRESHOLD : true
  return { index: art.indices[p], opaque }
}

/**
 * 排版：把画布切成"每页若干块板"的页列表。
 *
 * 与 `buildPdf` 分开是为了让异步压缩（浏览器）复用同一份落点计算——
 * 落点算两遍必然漂移，而 PDF 里"错 1pt"就是格子对不齐。
 */
function layout(art: PixelArt, options: BeadPdfOptions): PdfPage[] {
  const report = beadReport(art, options)

  // 每个调色板索引 → 号色。beadReport 的 rows 只包含"用到的颜色"，
  // 所以这里按同样的排序口径（用量降序、同量按索引）重建索引→号色的映射，
  // 保证 PDF 格内的号色与 CSV / SVG 完全一致。
  const codeByIndex: string[] = []
  {
    const used = new Map<number, number>()
    for (let p = 0; p < art.indices.length; p++) {
      const opaque = art.alphaMask ? art.alphaMask[p] >= ALPHA_THRESHOLD : true
      if (!opaque) continue
      used.set(art.indices[p], (used.get(art.indices[p]) ?? 0) + 1)
    }
    const order = [...used.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])
    order.forEach(([idx], n) => {
      codeByIndex[idx] = report.rows[n]?.code ?? `C${n + 1}`
    })
  }

  const boardCells = Math.max(1, Math.floor(options.boardCells ?? report.board.cellsX))
  const cols = report.board.columns
  const rows = report.board.rows
  const perPage = options.boardsPerPage ?? 1
  const gridCols = perPage === 4 ? 2 : 1

  const cellW = CONTENT_W / gridCols / boardCells
  const cellH = cellW // 方格
  const boardW = cellW * boardCells
  const boardH = cellH * boardCells

  const gridAreaH = A4.height - MARGIN - HEADER_H - FOOTER_H
  const areaRows = Math.max(1, Math.floor(gridAreaH / boardH))
  const perPageActual = Math.min(perPage, gridCols * areaRows)

  const boards: { bx: number; by: number; col: number; row: number }[] = []
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) boards.push({ bx: c, by: r, col: c, row: r })

  const pages: PdfPage[] = []
  const title = options.title ?? 'Bead Pattern'

  for (let start = 0; start < boards.length; start += perPageActual) {
    const slice = boards.slice(start, start + perPageActual)
    const nodes: PdfNode[] = []

    nodes.push({
      kind: 'txt',
      x: MARGIN,
      y: MARGIN + 14,
      size: 14,
      font: 'Helvetica-Bold',
      text: title,
    })
    const pageIdx = pages.length + 1
    const pageCount = Math.ceil(boards.length / perPageActual)
    nodes.push({
      kind: 'txt',
      x: A4.width - MARGIN,
      y: MARGIN + 14,
      size: 9,
      gray: 0.35,
      align: 'right',
      text: `p.${pageIdx}/${pageCount}  board cells ${boardCells}  canvas ${art.width}x${art.height}`,
    })
    nodes.push({
      kind: 'txt',
      x: MARGIN,
      y: MARGIN + 30,
      size: 8,
      gray: 0.45,
      text: `${report.colorCount} colors / ${report.totalBeads} beads / ${report.totalGrams} g / ${report.physical.widthMm}x${report.physical.heightMm} mm`,
    })

    slice.forEach((board, i) => {
      const gx = i % gridCols
      const gy = Math.floor(i / gridCols)
      const originX = MARGIN + gx * (CONTENT_W / gridCols) + (CONTENT_W / gridCols - boardW) / 2
      const originY = MARGIN + HEADER_H + gy * (boardH + 18)

      nodes.push({
        kind: 'txt',
        x: originX,
        y: originY - 4,
        size: 8,
        gray: 0.3,
        text: `Board ${board.col + 1},${board.row + 1}`,
      })

      const x0 = board.col * boardCells
      const y0 = board.row * boardCells

      // 格子
      for (let cy = 0; cy < boardCells; cy++) {
        for (let cx = 0; cx < boardCells; cx++) {
          const ax = x0 + cx
          const ay = y0 + cy
          if (ax >= art.width || ay >= art.height) continue
          const { index, opaque } = cellAt(art, ax, ay)
          if (!opaque) continue
          const px = originX + cx * cellW
          const py = originY + cy * cellH
          nodes.push({ kind: 'rect', x: px, y: py, w: cellW, h: cellH, fill: art.palette[index] ?? '#000000' })
        }
      }

      // 网格线：每格细线、每 10 格重线、板边框最重
      const drawGrid = (step: number, color: string, width: number): void => {
        for (let c = 0; c <= boardCells; c += step) {
          const px = originX + c * cellW
          const py = originY + c * cellH
          nodes.push({
            kind: 'path',
            stroke: color,
            width,
            points: [
              [px, originY],
              [px, originY + boardH],
            ],
          })
          nodes.push({
            kind: 'path',
            stroke: color,
            width,
            points: [
              [originX, py],
              [originX + boardW, py],
            ],
          })
        }
      }
      drawGrid(1, '#c9c9c9', 0.2)
      drawGrid(10, '#6b6b6b', 0.7)
      nodes.push({ kind: 'rect', x: originX, y: originY, w: boardW, h: boardH, stroke: '#111111', strokeWidth: 1.1 })

      // 号色文字：字号随格子缩放；小于 3.4pt 就整体不印（印上去只会糊成一团）
      const fontSize = Math.min(6.5, cellW * 0.62)
      if (fontSize >= 3.4) {
        for (let cy = 0; cy < boardCells; cy++) {
          for (let cx = 0; cx < boardCells; cx++) {
            const ax = x0 + cx
            const ay = y0 + cy
            if (ax >= art.width || ay >= art.height) continue
            const { index, opaque } = cellAt(art, ax, ay)
            if (!opaque) continue
            const code = codeByIndex[index]
            if (!code) continue
            const px = originX + cx * cellW + cellW / 2
            // 文字基线取格中心偏下（视觉居中；用格子中线会让字看起来偏低）
            const py = originY + cy * cellH + cellH / 2 + fontSize * 0.34
            nodes.push({
              kind: 'txt',
              x: px,
              y: py,
              size: fontSize,
              align: 'center',
              // 深色底用白字：否则深色格上的黑字完全看不见
              gray: needsLightText(art.palette[index] ?? '#000000') ? 1 : 0,
              text: code,
            })
          }
        }
      }
    })

    // 页脚图例：号色 / 颜色 / 格数（每色一个色块 + 文字）
    const footTop = A4.height - MARGIN - FOOTER_H + 16
    nodes.push({ kind: 'txt', x: MARGIN, y: footTop, size: 9, font: 'Helvetica-Bold', text: 'Legend' })
    const perRow = 4
    const rowH = 16
    report.rows.forEach((row, i) => {
      const col = i % perRow
      const line = Math.floor(i / perRow)
      const lx = MARGIN + col * (CONTENT_W / perRow)
      const ly = footTop + 12 + line * rowH
      nodes.push({ kind: 'rect', x: lx, y: ly, w: 10, h: 10, fill: row.color, stroke: '#555555', strokeWidth: 0.4 })
      nodes.push({ kind: 'txt', x: lx + 14, y: ly + 8.5, size: 8, text: `${row.code}  ${row.color.toUpperCase()}  ${row.cells}` })
    })

    pages.push({ width: A4.width, height: A4.height, nodes })
  }

  return pages
}

/**
 * 生成拼豆图纸 PDF（同步压缩器，Node 用）。
 *
 * 图纸约定（与 SVG 版一致，用户按此拼）：
 *  - 实色格：填色 + **格内印号色**（号色来自预置卡，没有则 C1、C2…）
 *  - 透明格：留白（不填色、不印字）
 *  - 每 10 格一条重线（数格子用的"十字尺"），板边框更重
 */
export function beadPdf(art: PixelArt, options: BeadPdfOptions = {}): Uint8Array {
  return buildPdf(layout(art, options), { deflate: options.deflate })
}

/**
 * 同 `beadPdf`，但允许异步压缩器（浏览器只有 `CompressionStream`）。
 * 排版逻辑与同步版共用同一个 `layout`，不存在两份落点计算。
 */
export async function beadPdfAsync(art: PixelArt, options: BeadPdfOptions = {}): Promise<Uint8Array> {
  const pages = layout(art, options)
  if (!options.deflate) return buildPdf(pages)
  return buildPdfAsync(pages, { deflate: options.deflate })
}

/** 该颜色上的文字该用白还是黑：按感知亮度阈值（与 core/color.ts 的 colorTextOn 同一判据思路） */
function needsLightText(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return true
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  // ITU-R BT.601 亮度
  return (r * 299 + g * 587 + b * 114) / 1000 < 140
}
