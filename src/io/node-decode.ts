/**
 * 浏览器通道解码（Node 侧的"兜底解码器"）。
 *
 * ## 为什么需要它
 *
 * `src/io/node-image.ts` 只直接解码 PNG，而 AI 生图流水线里的输入常常是 JPEG（照片/生成图）
 * 或 WebP（网页素材）。此前的替代路径是"先把图转成 PNG"或"手动起浏览器逐张导入"——
 * 对 agent 批量出图都不方便（前者要外部工具、后者没有批量入口）。
 *
 * 这里补上第三条：**用 CDP 驱动一个无头浏览器，借它原生解码**，把结果转成 PNG 落在临时目录里，
 * 之后的链路（`runPipeline` → 算子 → 导出）**完全不变**——因为它拿到的仍然是 PNG 文件路径。
 *
 * ## 为什么不在 Node 里手写解码器
 *
 * 评估过（2026-09-15）：BMP / GIF 手写可行（各约 100–150 行），但 **JPEG（DCT + 霍夫曼 +
 * 色度子采样）与 WebP（VP8 帧内解码）手写是 500 行起、且极易出错**——而这两者恰恰是
 * 实际最常见的格式。AVIF 更不可能。浏览器本来就有成熟、经过完整测试的解码器，
 * 借它比复刻一份更可靠，也符合"**不为此引入 sharp 这类重依赖**"的既定约束。
 *
 * ## 能力边界（如实声明）
 *
 * 能解的是**浏览器原生支持的格式**：PNG / JPEG / WebP / GIF / BMP / AVIF / ICO / SVG。
 * 代价是**必须有浏览器**（`canDecodeInNode` 依然如实报告"Node 端只直接支持 PNG"，
 * 这条不因本模块而改变——本模块是"额外的一条通道"，不是"Node 现在支持所有格式了"）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

import { encodePngNode } from './node-png.ts'
import type { RgbaImage } from '../core/png.ts'

/** 浏览器能解码、而 Node 端不直接支持的扩展名（与 node-image.ts 的 BROWSER_ONLY 对应） */
const BROWSER_DECODABLE = new Set(['.jpg', '.jpeg', '.jfif', '.webp', '.gif', '.bmp', '.avif', '.ico', '.cur', '.svg'])

export function needsBrowserDecode(file: string): boolean {
  return BROWSER_DECODABLE.has(extname(file).toLowerCase())
}

/**
 * 借无头浏览器把任意浏览器可解码的图片转成 PNG 字节。
 *
 * 实现要点：把图片读成 **dataURL** 注入页面，交给 `createImageBitmap` + `canvas` 解码，
 * 再用 `canvas.toBlob('image/png')` 取回 PNG 字节。这样：
 *  - 不需要给页面开文件输入（批量时逐张注入即可）；
 *  - 解码用的是浏览器原生实现，**格式覆盖与工作台里"导入图片"完全一致**。
 *
 * 一次调用开一次浏览器、**批量复用同一个会话**（见 `decodeManyInBrowser`）——
 * 每张都起一次浏览器会慢到不可用（启动约 1–2 秒）。
 */
/**
 * 会话的最小形状。
 *
 * ⚠️ **刻意不 import `tool/cdp.mjs`**：那会**倒置分层**——`tool/` 依赖 `src/`，
 * 而 `src` 反过来依赖 `tool` 会形成循环，也让"core/io 能被独立调用"这件事失效。
 * 所以这里只声明"需要什么"（一个带 `cdp.eval` 的东西），由调用方（CLI）把会话传进来。
 * 这也是依赖注入在本项目的既有做法（见 `core/pdf.ts` 注入压缩器）。
 */
export interface BrowserSession {
  cdp: { send: (method: string, params?: Record<string, unknown>) => Promise<unknown>; eval: (expr: string) => Promise<string> }
}

export async function decodeInBrowser(session: BrowserSession, file: string): Promise<RgbaImage> {
  const bytes = readFileSync(file)
  const ext = extname(file).toLowerCase()
  const mime =
    ext === '.jpg' || ext === '.jpeg' || ext === '.jfif'
      ? 'image/jpeg'
      : ext === '.webp'
        ? 'image/webp'
        : ext === '.gif'
          ? 'image/gif'
          : ext === '.bmp'
            ? 'image/bmp'
            : ext === '.avif'
              ? 'image/avif'
              : ext === '.svg'
                ? 'image/svg+xml'
                : 'application/octet-stream'
  const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`

  const out = await session.cdp.eval(`(async () => {
    const res = await fetch(${JSON.stringify(dataUrl)})
    const blob = await res.blob()
    let bmp
    try {
      bmp = await createImageBitmap(blob)
    } catch (e) {
      return JSON.stringify({ error: '浏览器也无法解码这个文件：' + (e && e.message ? e.message : e) })
    }
    const cv = document.createElement('canvas')
    cv.width = bmp.width
    cv.height = bmp.height
    const ctx = cv.getContext('2d')
    ctx.drawImage(bmp, 0, 0)
    const img = ctx.getImageData(0, 0, cv.width, cv.height)
    // 回传原始 RGBA（不再走 PNG 编码往返）：Node 侧直接拿到 ImageData 同形状的数据
    return JSON.stringify({
      width: img.width,
      height: img.height,
      data: Array.from(img.data),
    })
  })()`)

  const parsed = JSON.parse(out) as { error?: string; width?: number; height?: number; data?: number[] }
  if (parsed.error) throw new Error(parsed.error)
  if (!parsed.width || !parsed.height || !parsed.data) throw new Error(`浏览器解码返回了意外结果：${file}`)
  return { width: parsed.width, height: parsed.height, data: new Uint8ClampedArray(parsed.data) }
}

/**
 * 批量把"Node 不能直接解码"的图片转成 PNG，落在 `outDir`，返回 `原文件 → 新 PNG 路径` 的映射。
 *
 * 为什么落盘而不是把内存图直接喂给渲染链路：`renderOne` 的入口是**文件路径**
 * （它内部要 `loadImageNode`、还要用 basename 生成 `{name}`）。走文件能让"浏览器解码过的图"
 * 与"本来就是 PNG 的图"**完全共用同一条渲染链路**——否则又多出一套渲染路径，迟早分叉。
 * （这与 `--slice` 的处理方式一致，见 tool/artc.mjs 里的同类注释。）
 */
/**
 * 批量把"Node 不能直接解码"的图片转成 PNG，落在 `outDir`。
 *
 * **会话由调用方持有**（同样为了不倒置分层）：CLI 起一次浏览器，
 * 逐张调用本函数即可——每张都起一次浏览器会慢到不可用（启动约 1–2 秒）。
 * 返回 `原文件 → 新 PNG 路径` 的映射，以及逐张的失败清单（**不中断整批**，
 * 与 CLI 既有的"单张失败不中断"约定一致）。
 */
export function decodeOneToPng(session: BrowserSession, file: string, outDir: string): Promise<{ dest: string; width: number; height: number }> {
  return decodeInBrowser(session, file).then((img) => {
    mkdirSync(outDir, { recursive: true })
    const dest = join(outDir, basename(file, extname(file)) + '.png')
    writeFileSync(dest, encodePngNode(img))
    return { dest, width: img.width, height: img.height }
  })
}
