/**
 * 浏览器侧 PDF 适配：给纯 PDF 生成器提供 zlib 压缩。
 *
 * **实测结论（别照文档猜，也别照"常识"猜）**：Chromium 的 `CompressionStream('deflate')`
 * 产出的**就是 zlib 容器**（首字节 `0x78`），正是 PDF 的 `/FlateDecode` 要的格式。
 * 裸 deflate 对应的是 `'deflate-raw'`。
 *
 * 我一度按"实现细节可能与规范不符"的直觉给它又包了一层 zlib 头 + adler32，
 * 结果产出**双重压缩**的数据——文件从 59KB 缩到 5KB 看着"压得更好了"，
 * 但阅读器解压时报 `invalid stored block lengths`。
 * 这类错误的特征就是"体积与结构都正常、内容打不开"，所以 `tool/e2e-pdf.mjs`
 * 会把生成的 PDF 用 Node 的 zlib 真解一遍并断言能读回号色文字。
 */
import { beadPdfAsync, type BeadPdfOptions } from '../core/bead-pdf.ts'
import type { PixelArt } from '../core/types.ts'

/** 浏览器侧的 zlib 压缩（CompressionStream 只有流式/异步 API） */
export async function deflateBrowser(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate')
  const writer = cs.writable.getWriter()
  // `Uint8Array<ArrayBufferLike>` 不能直接传给 writer.write（TS 5.7 起它的 buffer
  // 可能是 SharedArrayBuffer）。拷进一个明确以 ArrayBuffer 为底的视图即可。
  const copy = new Uint8Array(new ArrayBuffer(data.length))
  copy.set(data)
  void writer.write(copy)
  void writer.close()
  return new Uint8Array(await new Response(cs.readable).arrayBuffer())
}

/** 浏览器侧生成拼豆图纸 PDF（异步：压缩只能异步） */
export function beadPdfBrowser(art: PixelArt, options: BeadPdfOptions = {}): Promise<Uint8Array> {
  return beadPdfAsync(art, { ...options, deflate: deflateBrowser })
}
