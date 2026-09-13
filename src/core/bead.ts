/**
 * 拼豆图纸（Bead Mode）：把像素画变成"能照着摆的图纸 + 能照着买的清单"。
 *
 * 这是项目目标 ①，也是本引擎与普通像素化工具的分水岭：
 * 拼豆用户要的不是 PNG，而是**号色 + 数量 + 分板位置**。
 *
 * 全部是纯函数（只产出字符串/结构），因此 CLI 与 UI 都能用，且能被单测完整覆盖。
 * 拼豆模式的完整说明见 docs/USAGE.md「拼豆用户注意」。
 */
import { ALPHA_THRESHOLD, type PixelArt } from './types.ts'
import { hexToRgb, luminance } from './color.ts'
import { paletteCodes } from './palettes.ts'
import { countUsage } from './stats.ts'

/** 一格 = 一颗豆。默认按 5mm 豆、单颗约 0.08g 估算（可覆盖） */
export const DEFAULT_BEAD_MM = 5
export const DEFAULT_BEAD_GRAM = 0.08
/** 默认分板：10×10 格 = 29×29 孔的常见大方板（58×58 格一张） */
export const DEFAULT_BOARD_CELLS = 58
/** 一袋豆的常见包装规格（用于"建议袋数"） */
export const BEADS_PER_BAG = 500

export interface BeadRow {
  /** 图纸编号（色板带号色时用号色，否则 C1、C2…） */
  code: string
  color: string
  /** 该色在画布上的格数（不含透明格） */
  cells: number
  /** 珠子数 = 格数（1 格 1 颗） */
  beads: number
  /** 估算重量（克） */
  grams: number
  /** 建议购买袋数（按 BEADS_PER_BAG 向上取整，最少 1 袋） */
  bags: number
}

export interface BeadReport {
  rows: BeadRow[]
  /** 用到的颜色数 */
  colorCount: number
  totalBeads: number
  totalGrams: number
  totalBags: number
  /** 透明格（图纸上留空的位置） */
  transparentCells: number
  totalCells: number
  board: { columns: number; rows: number; cellsX: number; cellsY: number }
  /** 物理尺寸（毫米），按单颗直径估算 */
  physical: { widthMm: number; heightMm: number; beadMm: number }
}

export interface BeadOptions {
  /** 号色数组（与 art.palette 等长）；不传则用 C1、C2… */
  codes?: string[]
  beadMm?: number
  beadGram?: number
  /** 每板格数（长与宽），默认 58（≈29×29 孔的方板） */
  boardCells?: number
}

/**
 * 用量统计与清单。
 * 关键不变量（单测会断言）：`rows[].cells` 之和 + `transparentCells` == 画布总格数，
 * 且**每个色号都必须在给定色板内**（拼豆用户不可能买到图纸上没有的颜色）。
 */
export function beadReport(art: PixelArt, options: BeadOptions = {}): BeadReport {
  const beadMm = options.beadMm ?? DEFAULT_BEAD_MM
  const beadGram = options.beadGram ?? DEFAULT_BEAD_GRAM
  const boardCells = Math.max(1, Math.floor(options.boardCells ?? DEFAULT_BOARD_CELLS))

  const codes = paletteCodes(art.palette, options.codes)
  const usage = countUsage(art.indices, art.palette, art.alphaMask)
  const transparentCells = art.alphaMask ? art.alphaMask.reduce((n, v) => n + (v < ALPHA_THRESHOLD ? 1 : 0), 0) : 0

  // 按用量降序（采购清单的习惯顺序），同量按色号排
  const rows: BeadRow[] = Object.entries(usage)
    .map(([color, cells]) => {
      const idx = art.palette.findIndex((c) => c.toLowerCase() === color)
      return {
        code: codes[idx] ?? `C${idx + 1}`,
        color,
        cells,
        beads: cells,
        grams: Number((cells * beadGram).toFixed(2)),
        bags: Math.max(1, Math.ceil(cells / BEADS_PER_BAG)),
      }
    })
    .sort((a, b) => b.cells - a.cells || a.code.localeCompare(b.code))

  const totalBeads = rows.reduce((n, r) => n + r.beads, 0)
  const totalGrams = Number(rows.reduce((n, r) => n + r.grams, 0).toFixed(2))
  const totalBags = rows.reduce((n, r) => n + r.bags, 0)

  return {
    rows,
    colorCount: rows.length,
    totalBeads,
    totalGrams,
    totalBags,
    transparentCells,
    totalCells: art.width * art.height,
    board: {
      cellsX: boardCells,
      cellsY: boardCells,
      columns: Math.ceil(art.width / boardCells),
      rows: Math.ceil(art.height / boardCells),
    },
    physical: { widthMm: art.width * beadMm, heightMm: art.height * beadMm, beadMm },
  }
}

/** 缺口清单 CSV。列顺序按"照着买"的顺序：编号 → 颜色 → 格数 → 珠数 → 重量 → 袋数 */
export function beadListCsv(art: PixelArt, options: BeadOptions = {}): string {
  const report = beadReport(art, options)
  const head = '编号,颜色,格数,珠数,估算重量(g),建议袋数'
  const lines = report.rows.map((r) => [r.code, r.color.toUpperCase(), r.cells, r.beads, r.grams, r.bags].join(','))
  const tail = [
    `合计,${report.colorCount} 色,${report.totalBeads},${report.totalBeads},${report.totalGrams},${report.totalBags}`,
    `透明格,留空,${report.transparentCells},, ,`,
    `画布,${art.width}x${art.height},${report.totalCells},, ,`,
  ]
  return [head, ...lines, ...tail].join('\n') + '\n'
}

export interface BeadSvgOptions extends BeadOptions {
  /** 每格边长（像素）。格子太小时不写编号，只保留网格与图例 */
  cellPx?: number
  /** 每板之间留白（像素） */
  gapPx?: number
  /** 是否绘制每 10 格的加强线 */
  majorEvery?: number
  /** 是否在格子里写编号（格子小于 14px 时自动关闭） */
  label?: boolean
  title?: string
}

/** XML 文本转义（号色与标题可能含 & < >） */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * 生成可打印/可缩放的图纸 SVG。
 *
 * 设计取舍：
 *  - **格子写编号而不是只填色**：打印成黑白也能照着摆；黑底格用白字（按感知亮度选色）。
 *  - **每 10 格加强线 + 板间留白**：与实体方板的孔位对应，避免摆到一半数错行列。
 *  - **含图例表**：编号 → 颜色 → 数量，直接对应缺口清单。
 */
export function beadSvg(art: PixelArt, options: BeadSvgOptions = {}): string {
  const cellPx = options.cellPx ?? 22
  const gap = options.gapPx ?? 8
  const majorEvery = options.majorEvery ?? 10
  const showLabel = (options.label ?? true) && cellPx >= 14
  const boardCells = Math.max(1, Math.floor(options.boardCells ?? DEFAULT_BOARD_CELLS))

  const codes = paletteCodes(art.palette, options.codes)
  const report = beadReport(art, options)

  const boardCols = Math.ceil(art.width / boardCells)
  const boardRows = Math.ceil(art.height / boardCells)
  const boardW = boardCells * cellPx
  const sheetW = boardCols * boardW + (boardCols - 1) * gap
  const sheetH = boardRows * boardW + (boardRows - 1) * gap

  const legendRowH = 22
  const legendW = 320
  const legendH = 40 + report.rows.length * legendRowH
  const margin = 24
  const totalW = Math.max(sheetW, legendW) + margin * 2
  const totalH = sheetH + legendH + margin * 3

  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}" font-family="monospace">`)
  parts.push(`<rect width="${totalW}" height="${totalH}" fill="#ffffff"/>`)
  parts.push(`<text x="${margin}" y="${margin - 6}" font-size="14" fill="#111">${esc(options.title ?? `像素画图纸 ${art.width}×${art.height}（${report.colorCount} 色 / ${report.totalBeads} 颗）`)}</text>`)

  // 逐板绘制：板内只画落在本板的格子，板间留白方便分板摆
  for (let by = 0; by < boardRows; by++) {
    for (let bx = 0; bx < boardCols; bx++) {
      const ox = margin + bx * (boardW + gap)
      const oy = margin + by * (boardW + gap)
      const x0 = bx * boardCells
      const y0 = by * boardCells
      const w = Math.min(boardCells, art.width - x0)
      const h = Math.min(boardCells, art.height - y0)

      parts.push(`<rect x="${ox}" y="${oy}" width="${w * cellPx}" height="${h * cellPx}" fill="none" stroke="#999" stroke-width="1"/>`)
      parts.push(`<text x="${ox}" y="${oy - 4}" font-size="10" fill="#666">板 ${bx + 1},${by + 1}</text>`)

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = (y0 + y) * art.width + (x0 + x)
          const transparent = art.alphaMask ? art.alphaMask[p] < ALPHA_THRESHOLD : false
          const px = ox + x * cellPx
          const py = oy + y * cellPx
          if (transparent) {
            // 透明格：只留一个淡叉，表示这里不放豆
            parts.push(`<rect x="${px}" y="${py}" width="${cellPx}" height="${cellPx}" fill="none" stroke="#e3e3e3" stroke-width="1"/>`)
            continue
          }
          const color = art.palette[art.indices[p]] ?? '#000000'
          const code = codes[art.indices[p]] ?? ''
          parts.push(`<rect x="${px}" y="${py}" width="${cellPx}" height="${cellPx}" fill="${color}" stroke="#00000022" stroke-width="0.5"/>`)
          if (showLabel) {
            // 编号写在格子里：打印成黑白也能照着摆；深色格自动换白字
            const c = hexToRgb(color)
            const textColor = luminance(c.r, c.g, c.b) < 140 ? '#fff' : '#111'
            parts.push(`<text x="${px + cellPx / 2}" y="${py + cellPx / 2 + 3}" font-size="${Math.max(6, cellPx * 0.34)}" fill="${textColor}" text-anchor="middle">${esc(code)}</text>`)
          }
        }
      }

      // 每 10 格加强线：对应实体方板的孔位分区
      for (let x = majorEvery; x < w; x += majorEvery) {
        parts.push(`<line x1="${ox + x * cellPx}" y1="${oy}" x2="${ox + x * cellPx}" y2="${oy + h * cellPx}" stroke="#555" stroke-width="1.2"/>`)
      }
      for (let y = majorEvery; y < h; y += majorEvery) {
        parts.push(`<line x1="${ox}" y1="${oy + y * cellPx}" x2="${ox + w * cellPx}" y2="${oy + y * cellPx}" stroke="#555" stroke-width="1.2"/>`)
      }
    }
  }

  // 图例：编号 → 色块 → 数量（与缺口清单一一对应）
  const lx = margin
  const ly = margin * 2 + sheetH
  parts.push(`<text x="${lx}" y="${ly - 8}" font-size="13" fill="#111">图例（编号 / 颜色 / 用量）</text>`)
  report.rows.forEach((r, i) => {
    const y = ly + i * legendRowH
    parts.push(`<rect x="${lx}" y="${y}" width="16" height="16" fill="${r.color}" stroke="#00000033"/>`)
    parts.push(`<text x="${lx + 24}" y="${y + 13}" font-size="12" fill="#111">${esc(r.code)} · ${r.color.toUpperCase()} · ${r.cells} 颗</text>`)
  })
  const footY = ly + report.rows.length * legendRowH + 16
  parts.push(`<text x="${lx}" y="${footY}" font-size="12" fill="#444">合计 ${report.totalBeads} 颗 / ${report.totalGrams} g / 透明格 ${report.transparentCells} / 分板 ${report.board.columns}×${report.board.rows}（每板 ${boardCells} 格）</text>`)

  parts.push('</svg>')
  return parts.join('\n')
}
