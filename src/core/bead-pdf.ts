/**
 * 拼豆图纸 PDF：**按分板出可打印的图纸**。
 *
 * 为什么用 PDF 而不是只给 SVG：SVG 适合屏幕上缩放查看，但拿去打印/交给别人拼时，
 * PDF 的分页、纸张尺寸与毫米级物理尺寸是确定的——这正是打印图纸需要的。
 *
 * 纸张：A4（595.28 × 841.89 pt = 210 × 297 mm）。
 *
 * **排版策略（用户要"自适应 A4、尽可能不跨页"）**：
 *  1. 默认把**整幅画布缩放进一页**：单元格边长同时受可用宽与高约束，谁先到头听谁的。
 *  2. 只有当格子缩到 `DEFAULT_MIN_CELL_PT` 以下（印不清）时，才**退回按板分页**——
 *     每页一块板，格子取能放下的最大值。
 *  3. 两条路都不裁剪、不丢格子；区别只是"页码数"与"格子大小"的取舍。
 *
 * 「不跨页」是**偏好**，不是可以牺牲可读性的硬指标：硬塞成一页糊成一片的图纸没有用。
 *
 * 与 `beadSvg` 的关系：共用 `beadReport` 的分板与号色逻辑，只是排版落点不同。
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

/**
 * 单元格边长下限（pt）。低于这个值，格内的号色就印不清了。
 * 约 4.2pt ≈ 1.5mm；58×58 的板在整幅一页时约 8.2pt，远高于它。
 */
const DEFAULT_MIN_CELL_PT = 4.2

/**
 * 号色字号：**以"占格宽比例"为主，绝对上限只兜底**。
 *
 * 调这几个数之前先看实测（`tool/e2e-pdf.mjs` 会断言字号/格宽的比例）：
 *  - 旧版 `min(6.5, cellW * 0.62)`：58×58 单板实测 5.77pt = 2.03mm、占格宽 62%，
 *    字几乎贴着格子边框，用户反馈"格子里的文字小一点"。
 *  - **别被那个 6.5 的上限误导**：它从未生效（实测只有 5.77），
 *    照着"把 6.5 改小"反而会把字放大——必须按实测值调。
 *  - 中途试过 `min(3.8, cellW * 0.40)`：58×58 上确实降到 1.31mm（40%），
 *    但**大格子上就荒了**——16×16 画布格子 11.9mm，字号仍被 3.8pt 压住，只占格宽 17%，
 *    字小得像掉在格子里。绝对上限不能当主约束。
 *
 * 所以：比例定字号，`MAX_CODE_PT` 只防止超大格子上的字失控变大。
 */
const CODE_SIZE_RATIO = 0.45
const MAX_CODE_PT = 6.5
/** 号色字号下限：比这更小就干脆不印（印上去是糊的，反而干扰看图） */
const MIN_CODE_PT = 2.2

export interface BeadPdfOptions extends BeadOptions {
  /** 标题文字（**只能 ASCII**，见 pdf.ts 的 WinAnsi 限制） */
  title?: string
  beadMm?: number
  /** 单元格边长下限（pt）。低于它就退回分页；默认 `DEFAULT_MIN_CELL_PT` */
  minCellPt?: number
  /** zlib 压缩；不传则不压缩（文件更大但合法）。可返回 Promise（浏览器 CompressionStream） */
  deflate?: (data: Uint8Array) => Uint8Array | Promise<Uint8Array>
}

/** 取某格的颜色索引与是否透明 */
function cellAt(art: PixelArt, x: number, y: number): { index: number; opaque: boolean } {
  const p = y * art.width + x
  const opaque = art.alphaMask ? art.alphaMask[p] >= ALPHA_THRESHOLD : true
  return { index: art.indices[p], opaque }
}

/** 每页要画的一个矩形区域（整幅一页，或一块板） */
interface Tile {
  /** 格坐标原点 */
  x0: number
  y0: number
  wCells: number
  hCells: number
  /** 分页时标出板号；整幅一页时为 undefined */
  label?: string
}

/**
 * 排版：算出单元格边长与页列表。
 *
 * 与 `buildPdf` 分开，是为了让异步压缩（浏览器）复用同一份落点计算——
 * 落点算两遍必然漂移，而 PDF 里"错 1pt"就是格子对不齐。
 */
function layout(art: PixelArt, options: BeadPdfOptions): PdfPage[] {
  const report = beadReport(art, options)

  // 每个调色板索引 → 号色。beadReport 的 rows 只包含"用到的颜色"，
  // 所以这里按同样的排序口径（用量降序、同量按索引）重建映射，
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
  const gridAreaW = CONTENT_W
  const gridAreaH = A4.height - MARGIN - HEADER_H - FOOTER_H

  // 整幅塞进一页所需的格边长（宽高同时约束，取小者）
  const fitCell = Math.min(gridAreaW / art.width, gridAreaH / art.height)
  const minCell = options.minCellPt ?? DEFAULT_MIN_CELL_PT
  const mustSplit = fitCell < minCell

  // 分页时格子取"单块板能放下的最大值"
  const cellW = mustSplit ? Math.min(gridAreaW / boardCells, gridAreaH / boardCells) : fitCell
  const cellH = cellW

  const tiles: Tile[] = []
  if (mustSplit) {
    const cols = report.board.columns
    const rows = report.board.rows
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = c * boardCells
        const y0 = r * boardCells
        tiles.push({
          x0,
          y0,
          wCells: Math.min(boardCells, art.width - x0),
          hCells: Math.min(boardCells, art.height - y0),
          label: `Board ${c + 1},${r + 1}`,
        })
      }
    }
  } else {
    tiles.push({ x0: 0, y0: 0, wCells: art.width, hCells: art.height })
  }

  const title = options.title ?? 'Bead Pattern'
  const pages: PdfPage[] = []

  tiles.forEach((tile, index) => {
    const tw = tile.wCells * cellW
    const th = tile.hCells * cellH
    // 居中：整幅一页时按内容区居中；分页时每块板各自居中
    const originX = MARGIN + (gridAreaW - tw) / 2
    const originY = MARGIN + HEADER_H + (gridAreaH - th) / 2

    const nodes: PdfNode[] = []

    nodes.push({ kind: 'txt', x: MARGIN, y: MARGIN + 14, size: 14, font: 'Helvetica-Bold', text: title })
    nodes.push({
      kind: 'txt',
      x: A4.width - MARGIN,
      y: MARGIN + 14,
      size: 9,
      gray: 0.35,
      align: 'right',
      text: `p.${index + 1}/${tiles.length}  canvas ${art.width}x${art.height}${mustSplit ? `  board cells ${boardCells}` : ''}`,
    })
    nodes.push({
      kind: 'txt',
      x: MARGIN,
      y: MARGIN + 30,
      size: 8,
      gray: 0.45,
      text:
        `${report.colorCount} colors / ${report.totalBeads} beads / ${report.totalGrams} g / ` +
        `${report.physical.widthMm}x${report.physical.heightMm} mm` +
        // 缩放过就必须说出来：用户拿尺子量格子会对不上"每颗 5mm"的预期
        (mustSplit ? '' : `  cell ${(cellW / 72 * 25.4).toFixed(2)} mm`),
    })

    if (tile.label) {
      nodes.push({ kind: 'txt', x: originX, y: originY - 4, size: 8, gray: 0.3, text: tile.label })
    }

    // 格子
    for (let cy = 0; cy < tile.hCells; cy++) {
      for (let cx = 0; cx < tile.wCells; cx++) {
        const { index: paletteIdx, opaque } = cellAt(art, tile.x0 + cx, tile.y0 + cy)
        if (!opaque) continue
        nodes.push({
          kind: 'rect',
          x: originX + cx * cellW,
          y: originY + cy * cellH,
          w: cellW,
          h: cellH,
          fill: art.palette[paletteIdx] ?? '#000000',
        })
      }
    }

    // 网格线：每格细线 → 每 10 格重线 → 区域边框最重
    const drawGrid = (step: number, color: string, width: number): void => {
      for (let c = 0; c <= tile.wCells; c += step) {
        const px = originX + c * cellW
        nodes.push({ kind: 'path', stroke: color, width, points: [[px, originY], [px, originY + th]] })
      }
      for (let c = 0; c <= tile.hCells; c += step) {
        const py = originY + c * cellH
        nodes.push({ kind: 'path', stroke: color, width, points: [[originX, py], [originX + tw, py]] })
      }
    }
    drawGrid(1, '#c9c9c9', 0.2)
    drawGrid(10, '#6b6b6b', 0.7)
    nodes.push({ kind: 'rect', x: originX, y: originY, w: tw, h: th, stroke: '#111111', strokeWidth: 1.1 })

    // 号色文字：字号随格子缩放；小于下限就整体不印（印上去只会糊成一团）
    const fontSize = Math.min(MAX_CODE_PT, cellW * CODE_SIZE_RATIO)
    if (fontSize >= MIN_CODE_PT) {
      for (let cy = 0; cy < tile.hCells; cy++) {
        for (let cx = 0; cx < tile.wCells; cx++) {
          const { index: paletteIdx, opaque } = cellAt(art, tile.x0 + cx, tile.y0 + cy)
          if (!opaque) continue
          const code = codeByIndex[paletteIdx]
          if (!code) continue
          nodes.push({
            kind: 'txt',
            x: originX + cx * cellW + cellW / 2,
            // 基线取格中心偏下（用格子中线会让字看着偏低）
            y: originY + cy * cellH + cellH / 2 + fontSize * 0.34,
            size: fontSize,
            align: 'center',
            // 深色底用白字：否则深色格上的黑字完全看不见
            gray: needsLightText(art.palette[paletteIdx] ?? '#000000') ? 1 : 0,
            text: code,
          })
        }
      }
    }

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
  })

  return pages
}

/**
 * 生成拼豆图纸 PDF（同步压缩器，Node 用）。
 *
 * 图纸约定（与 SVG 版一致，用户按此拼）：
 *  - 实色格：填色 + **格内印号色**（号色来自预置卡，没有则 C1、C2…）
 *  - 透明格：留白（不填色、不印字）
 *  - 每 10 格一条重线（数格子用的"十字尺"），区域边框更重
 */
export function beadPdf(art: PixelArt, options: BeadPdfOptions = {}): Uint8Array {
  return buildPdf(layout(art, options), { deflate: options.deflate })
}

/** 同 `beadPdf`，但允许异步压缩器（浏览器只有 `CompressionStream`） */
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
