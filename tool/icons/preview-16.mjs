// "实机 16px" 真值图：把图标按**真实显示尺寸 16px** 渲染、以 deviceScaleFactor=1 截图，
// 再用**最近邻**放大 8 倍输出。
//
// 为什么不能直接看放大的截图：预览台是按 48px 渲染的，那只反映"形状对不对"；
// 16px 能不能读出来取决于**抗锯齿后的像素**，必须按 1:1 栅格化再放大看。
// 放大用最近邻（不插值），否则平滑会把糊掉的地方抹平，看不出真实观感。
//
// 用法：npm run icons:16
//       （或 node tool/icons/preview-16.mjs [输出png] [图标名,逗号分隔]）
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { startBrowser } from '../cdp.mjs'
import { decodePngNode } from '../../src/io/node-png.ts'
import { encodePngNode } from '../../src/io/node-png.ts'
import { buildSvgPaths } from './svg-data.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(dirname(HERE))
const OUT = process.argv[2] ?? join(ROOT, '.tmp-shots', 'icon-16px.png')
const ONLY = process.argv[3] ? process.argv[3].split(',') : null
const ZOOM = 8

const paths = await buildSvgPaths()

/** 与 icons.ts 的 iconEl 完全相同的渲染方式（含 fill-rule —— 少一项预览就会撒谎） */
function iconSvg(name) {
  const items = paths[name]
  const body = items
    .map((it) => {
      const fill = it.fill === 'none' ? 'none' : 'currentColor'
      const fr = it.fr ? ` fill-rule="${it.fr}"` : ''
      const sw = it.sw ? ` stroke-width="${it.sw}"` : ''
      return `<path d="${it.d}" fill="${fill}"${fr}${sw}/>`
    })
    .join('')
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
}

const names = ONLY ?? Object.keys(paths)
// 每个图标横向排开，左侧留白方便裁剪；上下各留一行间距
const CELL = 40
const cells = names.map((n, i) => `<div class="cell" style="left:${20 + i * CELL}px">${iconSvg(n)}</div>`).join('')
const labels = names.map((n, i) => `<div class="lbl" style="left:${14 + i * CELL}px">${n}</div>`).join('')

const html = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#232323}
  .cell{position:absolute;top:22px;width:16px;height:16px;color:#e6e6e6}
  .cell svg{width:16px;height:16px;display:block}
  .lbl{position:absolute;top:52px;color:#8899aa;font:11px monospace;width:36px;text-align:center}
</style>${cells}${labels}`

mkdirSync(dirname(OUT), { recursive: true })
// 临时 HTML 写到 gitignore 的目录（原来是脚本旁边，会进版本库）
const htmlPath = join(dirname(OUT), '_icon-preview16.html')
writeFileSync(htmlPath, html)

const session = await startBrowser({ profilePrefix: 'icon16-' })
const { cdp } = session
let raw
try {
  await cdp.send('Page.enable')
  const W = 20 + names.length * CELL + 20
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: 80, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.navigate', { url: pathToFileURL(htmlPath).href })
  await new Promise((r) => setTimeout(r, 400))
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  raw = Buffer.from(shot.data, 'base64')
} finally {
  await session.close?.()
}

// 最近邻放大（不插值：插值会把"糊"这件事抹平）
const img = decodePngNode(new Uint8Array(raw))
const out = { width: img.width * ZOOM, height: img.height * ZOOM, data: new Uint8ClampedArray(img.width * ZOOM * img.height * ZOOM * 4) }
for (let y = 0; y < out.height; y++) {
  const sy = Math.floor(y / ZOOM)
  for (let x = 0; x < out.width; x++) {
    const sx = Math.floor(x / ZOOM)
    const s = (sy * img.width + sx) * 4
    const d = (y * out.width + x) * 4
    out.data[d] = img.data[s]
    out.data[d + 1] = img.data[s + 1]
    out.data[d + 2] = img.data[s + 2]
    out.data[d + 3] = img.data[s + 3]
  }
}
writeFileSync(OUT, encodePngNode(out))
console.log(`✔ 实机 16px 真值图（最近邻 ×${ZOOM}）→ ${OUT}`)
