/**
 * 最小 PDF 生成器（零依赖，纯函数，Node 与浏览器共用）。
 *
 * 为什么自己写而不引库：本项目运行期零依赖是硬约束，而 PDF 的基础结构（对象 + xref + 流）
 * 足够简单，手写反而更好控体积、更可预测——与 `src/core/png.ts` 同一思路。
 *
 * 压缩必须**注入**（同 PNG 编码器）：`src/core` 不许 import `node:*`，
 * 所以 Node 传 `node:zlib` 的 deflate，浏览器传 `CompressionStream('deflate')`。
 * 不传则输出未压缩流，PDF 依然合法（只是文件大），便于单测与调试。
 *
 * 坐标：PDF 原点在**左下角**、y 向上；调用方（拼豆图纸）按屏幕习惯用 y 向下。
 * 布局全按屏幕坐标算，只在写进 PDF 前用 `flipY()` 换算一次——
 * 算错方向的表现是"整页上下颠倒"，很容易被误判成字体问题。
 */

export type PdfFont = 'Helvetica' | 'Helvetica-Bold'

export interface PdfImg {
  kind: 'img'
  width: number
  height: number
  /** 原始像素（行优先 RGB，无行首滤波字节） */
  raw: Uint8Array
  /** 已 zlib 压缩的数据；配合 options.deflate 生效 */
  deflated?: Uint8Array
  /** 绘制位置（屏幕坐标，左上角）与目标尺寸（点） */
  x: number
  y: number
  w: number
  h: number
}

export interface PdfTxt {
  kind: 'txt'
  x: number
  /** 屏幕坐标（y 向下，从页顶算） */
  y: number
  size: number
  font?: PdfFont
  /** 灰度 0–1，默认 0（黑） */
  gray?: number
  align?: 'left' | 'center' | 'right'
  text: string
}

export interface PdfRect {
  kind: 'rect'
  x: number
  /** 屏幕坐标（左上角） */
  y: number
  w: number
  h: number
  /** `#rrggbb`；不传则只描边不填充 */
  fill?: string
  stroke?: string
  strokeWidth?: number
}

export interface PdfPath {
  kind: 'path'
  stroke: string
  width: number
  /** 折线点集（屏幕坐标） */
  points: [number, number][]
}

export type PdfNode = PdfImg | PdfTxt | PdfRect | PdfPath

export interface PdfPage {
  width: number
  height: number
  nodes: PdfNode[]
}

export interface BuildPdfOptions {
  /**
   * zlib 压缩函数；不传则不压缩（文件更大但仍是合法 PDF）。
   * 允许返回 Promise（浏览器的 `CompressionStream` 只有异步 API）。
   */
  deflate?: (data: Uint8Array) => Uint8Array | Promise<Uint8Array>
}

/* ------------------------------------------------------------------ 基础工具 */

const PDF_ESC: Record<string, string> = { '\\': '\\\\', '(': '\\(', ')': '\\)', '\r': '\\r', '\n': '\\n' }

/**
 * PDF 字符串转义。**非 ASCII 一律变成 `?`**：标准 14 字体用 WinAnsi 编码，
 * 直接塞中文会得到乱码而不是报错——宁可显式降级，也不要静默产出乱码文档。
 * 本项目的图纸文字（号色 B01、Hex、格数）全是 ASCII。
 */
function pdfText(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (code > 126) out += '?'
    else out += PDF_ESC[ch] ?? ch
  }
  return out
}

function hexTo01(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0, 0, 0]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function grayHex(g: number): string {
  const b = Math.round(Math.max(0, Math.min(1, g)) * 255)
  const h = b.toString(16).padStart(2, '0')
  return `#${h}${h}${h}`
}

/** 数字格式化：PDF 不接受科学计数法，也不喜欢过长小数 */
const num = (v: number): string => {
  const r = Math.round(v * 1000) / 1000
  return Object.is(r, -0) ? '0' : String(r)
}

/** 屏幕坐标（y 向下）→ PDF 坐标（y 向上） */
export const flipY = (y: number, pageHeight: number): number => pageHeight - y

/** 估宽：Helvetica 平均字宽 ≈ 0.5em，仅用于居中/右对齐（不作为排版依据） */
export function estimateTextWidth(text: string, size: number, bold = false): number {
  return text.length * size * (bold ? 0.56 : 0.5)
}

/* ------------------------------------------------------------------ 内容流 */

function nodeToOps(n: PdfNode, pageHeight: number): string {
  switch (n.kind) {
    case 'rect': {
      const ops: string[] = []
      if (n.fill) {
        const [r, g, b] = hexTo01(n.fill)
        ops.push(`${num(r)} ${num(g)} ${num(b)} rg`)
      }
      if (n.stroke) {
        const [r, g, b] = hexTo01(n.stroke)
        ops.push(`${num(r)} ${num(g)} ${num(b)} RG`, `${num(n.strokeWidth ?? 1)} w`)
      }
      // 矩形的 y 要给左下角，而屏幕坐标给的是左上角
      ops.push(`${num(n.x)} ${num(flipY(n.y, pageHeight) - n.h)} ${num(n.w)} ${num(n.h)} re`)
      ops.push(n.fill && n.stroke ? 'B' : n.fill ? 'f' : 'S')
      return ops.join('\n')
    }
    case 'path': {
      const [r, g, b] = hexTo01(n.stroke)
      const ops = [`${num(r)} ${num(g)} ${num(b)} RG`, `${num(n.width)} w`]
      n.points.forEach(([x, y], i) => ops.push(`${num(x)} ${num(flipY(y, pageHeight))} ${i === 0 ? 'm' : 'l'}`))
      ops.push('S')
      return ops.join('\n')
    }
    case 'txt': {
      const font: PdfFont = n.font ?? 'Helvetica'
      const [r, g, b] = hexTo01(grayHex(n.gray ?? 0))
      const w = estimateTextWidth(n.text, n.size, font.endsWith('Bold'))
      const x = n.align === 'center' ? n.x - w / 2 : n.align === 'right' ? n.x - w : n.x
      return [
        'BT',
        `${num(r)} ${num(g)} ${num(b)} rg`,
        `/${font} ${num(n.size)} Tf`,
        `${num(x)} ${num(flipY(n.y, pageHeight))} Td`,
        `(${pdfText(n.text)}) Tj`,
        'ET',
      ].join('\n')
    }
    case 'img':
      // 图像 1 单位 = 1 像素，所以 CTM 直接按目标尺寸缩放
      return `q\n${num(n.w)} 0 0 ${num(n.h)} ${num(n.x)} ${num(flipY(n.y, pageHeight) - n.h)} cm\n/Im0 Do\nQ`
  }
}

/* ------------------------------------------------------------------ 组装 */

/** 一个对象计划：按顺序写，编号与偏移一一对应 */
interface Plan {
  /** 每页的：页对象号、内容流对象号、图像对象号（无图则 0） */
  pages: { page: number; content: number; image: number }[]
  fontA: number
  fontB: number
  total: number
}

function plan(pages: PdfPage[]): Plan {
  if (!pages.length) throw new Error('PDF 至少需要一页（buildPdf 收到空页列表）')
  const out: Plan['pages'] = []
  let next = 3 // 1 = Catalog，2 = Pages
  for (const p of pages) {
    const hasImage = p.nodes.some((n) => n.kind === 'img')
    const page = next++
    const content = next++
    const image = hasImage ? next++ : 0
    out.push({ page, content, image })
  }
  const fontA = next++
  const fontB = next++
  return { pages: out, fontA, fontB, total: next }
}

/**
 * 组装 PDF 并返回字节（压缩器必须是同步的）。
 *
 * xref 里的偏移必须**逐字节精确**，这是手写 PDF 最容易错的地方。
 * 因此全程只用一个 `push()` 累加长度，需要偏移时立刻取 `length`，不在别处另算。
 * （单测会断言每个 xref 指向的位置确实是 `N 0 obj`；只测"能被解析"抓不到这类错。）
 */
export function buildPdf(pages: PdfPage[], options: BuildPdfOptions = {}): Uint8Array {
  const { deflate } = options
  const run = (data: Uint8Array): Uint8Array => {
    if (!deflate) return data
    const out = deflate(data)
    if (out instanceof Promise) {
      throw new Error('压缩器返回了 Promise：请用 buildPdfAsync（浏览器的 CompressionStream 是异步的）')
    }
    return out
  }
  return assemble(pages, deflate !== undefined, run)
}

/**
 * 同 `buildPdf`，但允许异步压缩器。
 *
 * 存在的意义：浏览器只有 `CompressionStream`（异步），而 PDF 的流必须**先把压缩结果的
 * 长度写进字典**才能接着写下去，无法"先写占位再回填"。所以先跑一趟收集"要压哪些内容"，
 * 全部压好后再跑第二趟真正组装——组装与偏移计算仍然只有一份 `assemble`。
 */
export async function buildPdfAsync(pages: PdfPage[], options: BuildPdfOptions = {}): Promise<Uint8Array> {
  const { deflate } = options
  if (!deflate) return assemble(pages, false, (d) => d)

  /*
   * 缓存键必须是**内容本身（字符串）**，不能用 Uint8Array 当键。
   *
   * 第一版就是这么错的：用 `Map<Uint8Array, Uint8Array>` 收集待压数据，而 `assemble`
   * 每趟都会 `new TextEncoder().encode(...)` 生成**新实例**——Map 比的是引用，
   * 第二趟全部未命中，压缩器原样返回明文，于是产出"字典写着 /FlateDecode、
   * 内容却是明文"的 PDF。阅读器直接报错，而文件大小与结构都正常，极难定位。
   * 换字符串键就没有这个陷阱。
   */
  const toDeflate = new Set<string>()
  const images: PdfImg[] = []
  for (const page of pages) {
    toDeflate.add(page.nodes.map((n) => nodeToOps(n, page.height)).join('\n'))
    const img = page.nodes.find((n): n is PdfImg => n.kind === 'img')
    if (img && !img.deflated) images.push(img)
  }

  const byText = new Map<string, Uint8Array>()
  for (const text of toDeflate) byText.set(text, await deflate(new TextEncoder().encode(text)))
  const byImage = new Map<PdfImg, Uint8Array>()
  for (const img of images) byImage.set(img, await deflate(img.raw))

  return assemble(
    pages,
    true,
    (d) => d,
    (text) => byText.get(text) ?? new TextEncoder().encode(text),
    byImage,
  )
}

/**
 * 组装主体。`compressed` 决定要不要写 /Filter；`contentFor` 给内容流、`imageFor` 给图像流。
 *
 * **不变量**：`compressed === true` 时，拿到的数据必须真的是压缩过的。
 * 曾经因为缓存键用错类型导致"声明 FlateDecode 却写明文"，阅读器直接报错而文件结构看着正常。
 * 单测与 `tool/e2e-pdf.mjs` 都会真的解压一遍来守住这条。
 */
function assemble(
  pages: PdfPage[],
  compressed: boolean,
  run: (d: Uint8Array) => Uint8Array,
  contentFor?: (text: string) => Uint8Array,
  imageFor?: Map<PdfImg, Uint8Array>,
): Uint8Array {
  const pl = plan(pages)

  const chunks: Uint8Array[] = []
  let length = 0
  const push = (s: string | Uint8Array): void => {
    const bytes = typeof s === 'string' ? new TextEncoder().encode(s) : s
    chunks.push(bytes)
    length += bytes.length
  }
  const offsets = new Map<number, number>()
  const beginObj = (n: number): void => {
    offsets.set(n, length)
    push(`${n} 0 obj\n`)
  }
  const endObj = (): void => push('endobj\n')

  push('%PDF-1.4\n')
  // 二进制标记：告诉传输工具这是二进制文件（否则某些老工具会按文本处理而损坏）
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]))

  beginObj(1)
  push('<< /Type /Catalog /Pages 2 0 R >>\n')
  endObj()

  beginObj(2)
  push(`<< /Type /Pages /Count ${pages.length} /Kids [${pl.pages.map((p) => `${p.page} 0 R`).join(' ')}] >>\n`)
  endObj()

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    const ids = pl.pages[i]

    // 节点顺序即绘制顺序：网格 → 号色文字 → 网格线……由调用方决定
    const content = page.nodes.map((n) => nodeToOps(n, page.height)).join('\n')
    const img = page.nodes.find((n): n is PdfImg => n.kind === 'img')

    const fonts = `/Font << /Helvetica ${pl.fontA} 0 R /Helvetica-Bold ${pl.fontB} 0 R >>`
    const xobj = img ? ` /XObject << /Im0 ${ids.image} 0 R >>` : ''

    beginObj(ids.page)
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
        `/Resources << ${fonts}${xobj} >> /Contents ${ids.content} 0 R >>\n`,
    )
    endObj()

    const contentData = contentFor ? contentFor(content) : run(new TextEncoder().encode(content))
    beginObj(ids.content)
    push(`<< /Length ${contentData.length}${compressed ? ' /Filter /FlateDecode' : ''} >>\nstream\n`)
    push(contentData)
    push('\nendstream\n')
    endObj()

    if (img) {
      // 优先用调用方给的已压好数据（异步路径），否则按 img.deflated / 现压
      const preset = imageFor?.get(img) ?? (compressed ? img.deflated : undefined)
      const data = preset ?? run(img.raw)
      beginObj(ids.image)
      push(
        `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${data.length}` +
          `${compressed ? ' /Filter /FlateDecode' : ''} >>\nstream\n`,
      )
      push(data)
      push('\nendstream\n')
      endObj()
    }
  }

  // 标准 14 字体：不需要嵌入，任何阅读器都有
  beginObj(pl.fontA)
  push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n')
  endObj()
  beginObj(pl.fontB)
  push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\n')
  endObj()

  const xrefOffset = length
  push(`xref\n0 ${pl.total}\n`)
  push('0000000000 65535 f \n')
  for (let n = 1; n < pl.total; n++) {
    const off = offsets.get(n)
    if (off === undefined) throw new Error(`PDF 内部错误：对象 ${n} 从未写出`)
    push(`${off.toString().padStart(10, '0')} 00000 n \n`)
  }
  push(`trailer\n<< /Size ${pl.total} /Root 1 0 R >>\n`)
  push(`startxref\n${xrefOffset}\n%%EOF\n`)

  const out = new Uint8Array(length)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}
