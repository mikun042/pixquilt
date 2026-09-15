/**
 * 导出动作：把当前画布写成文件（PNG / 拼豆三件套 / 像素 JSON / 色板 .hex / 项目 JSON）。
 *
 * 从 `index.ts` 拆出：这些动作只做"取当前状态 → 调 core 生成内容 → 触发下载 → 提示"，
 * 不参与界面布局，却占了入口文件近百行。
 *
 * **依赖靠注入**（`ExportDeps`）而不是直接读模块级状态：这样这个文件不依赖 `index.ts`，
 * 方向是单向的（`index.ts` → 这里），也便于将来单测——只需给一份假的 deps。
 */
import { pixelJSONString, projectJSONString, safeFileBase } from '../core/export.ts'
import { beadListCsv, beadReport, beadSvg } from '../core/bead.ts'
import { codesForParams, serializeHexPalette } from '../core/palettes.ts'
import { artToPngBlob } from './canvas-png.ts'
import { beadPdfBrowser } from './pdf.ts'
import type { ConvertParams, PixelArt } from '../core/types.ts'

export interface ExportDeps {
  /** 当前画布与参数（null = 还没有画布） */
  getArt: () => PixelArt | null
  getParams: () => ConvertParams
  /** 源图名，用来生成文件名（可能为空） */
  getSourceName: () => string
  toast: (message: string, kind?: 'info' | 'warn' | 'error') => void
}

/** 触发浏览器下载。延迟 revoke：下载是异步开始的，立刻撤销会让文件名/内容拿不到 */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

export function createExportActions(deps: ExportDeps) {
  const requireArt = (): PixelArt | null => {
    const art = deps.getArt()
    if (!art) deps.toast('还没有画布', 'warn')
    return art
  }

  /** PNG：整数倍最近邻放大；倍率超限由 core 的 `clampScale` 自动降档 */
  async function exportPNG(scale: number): Promise<void> {
    const art = requireArt()
    if (!art) return
    const params = deps.getParams()
    try {
      const blob = await artToPngBlob(art, scale, {
        transparentBg: params.transparent === 'key',
        bgHex: params.matteColor,
        keyMode: params.keyMode,
        keyTolerance: params.keyTolerance,
      })
      const name = `${safeFileBase(deps.getSourceName())}_${art.width}x${art.height}_${scale}x.png`
      download(blob, name)
      deps.toast(`已导出 ${name}`)
    } catch (err) {
      deps.toast(`导出失败：${(err as Error).message}`, 'error')
    }
  }

  /** 拼豆图纸 SVG + 缺口清单 CSV（号色按当前参数解析，见 codesForParams） */
  function exportBeadFiles(): void {
    const art = requireArt()
    if (!art) return
    const codes = codesForParams(deps.getParams())
    const base = safeFileBase(deps.getSourceName() || 'beads')
    download(new Blob([beadSvg(art, { codes, title: `${base} 拼豆图纸` })], { type: 'image/svg+xml' }), `${base}_图纸.svg`)
    download(new Blob([`\ufeff${beadListCsv(art, { codes })}`], { type: 'text/csv' }), `${base}_缺口清单.csv`)
    const rep = beadReport(art, { codes })
    deps.toast(`图纸与清单已导出：${rep.colorCount} 色 / ${rep.totalBeads} 颗 / ${rep.totalGrams} g`)
  }

  /**
   * 可打印的拼豆图纸 PDF（A4 分页，每块板一页）。
   *
   * 浏览器侧用 `CompressionStream('deflate')` 提供压缩——与 Node 侧注入 `node:zlib`
   * 是同一个契约（见 `core/pdf.ts` 与 `io/node-pdf.ts`）。**没有它就不能静默降级成
   * "导出个空文件"**：`CompressionStream` 在 2023+ 的 Chrome/Edge 都有，
   * 缺失时明确告诉用户换浏览器，而不是给一份打不开的文件。
   */
  async function exportBeadPdf(): Promise<void> {
    const art = requireArt()
    if (!art) return
    if (typeof CompressionStream === 'undefined') {
      deps.toast('当前浏览器不支持 CompressionStream，无法生成 PDF。请用较新的 Chrome/Edge，或改用「图纸 SVG」。', 'error')
      return
    }
    const codes = codesForParams(deps.getParams())
    const base = safeFileBase(deps.getSourceName() || 'beads')
    try {
      const bytes = await beadPdfBrowser(art, { codes, title: `Bead Pattern ${art.width}x${art.height}` })
      // 用 bytes.buffer 而不是 bytes 本身：TS 5.7 起 Uint8Array 的底层可能是
      // SharedArrayBuffer，不能直接当 BlobPart（类型上会报，运行期也无意义）
      download(new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' }), `${base}_拼豆图纸.pdf`)
      const rep = beadReport(art, { codes })
      const boards = rep.board.columns * rep.board.rows
      deps.toast(`可打印图纸已导出：${boards} 块板 / ${rep.totalBeads} 颗`)
    } catch (err) {
      deps.toast(`PDF 导出失败：${(err as Error)?.message ?? err}`, 'error')
    }
  }

  function exportPixelJSON(): void {
    const art = deps.getArt()
    if (!art) return
    download(new Blob([pixelJSONString(art)], { type: 'application/json' }), `${safeFileBase(deps.getSourceName())}_像素数据.json`)
  }

  /** 色板 .hex：与 CLI 的 `<名字>.hex` 产物、页内 API 的 `exportPaletteHex()` 对齐 */
  function exportPaletteHex(): void {
    const art = deps.getArt()
    if (!art) return
    const text = serializeHexPalette(art.palette, codesForParams(deps.getParams()))
    download(new Blob([text], { type: 'text/plain' }), `${safeFileBase(deps.getSourceName())}_色板.hex`)
    deps.toast(`已导出 ${art.palette.length} 色调色板`)
  }

  /** 项目 JSON：参数 + 色板 + 像素（不含原图）。**带上参数**，对方才能接着微调 */
  function exportProject(): void {
    const art = deps.getArt()
    if (!art) return
    download(new Blob([projectJSONString(art, deps.getParams(), true)], { type: 'application/json' }), `${safeFileBase(deps.getSourceName())}_项目.json`)
  }

  return { exportPNG, exportBeadFiles, exportBeadPdf, exportPixelJSON, exportPaletteHex, exportProject }
}

export type ExportActions = ReturnType<typeof createExportActions>
