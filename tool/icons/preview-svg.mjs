// 图标预览台：把**形状定义**（经 buildSvgPaths 缩放到 24 空间）按"和 iconEl 完全相同的
// 渲染方式"画出来，在 16 / 24 / 32 / 48px 四种尺寸下并排截图，判断"16px 下读不读得出来"。
//
// 为什么要它：改形状必须能立刻看到结果。走"改 icons.ts → npm run build → 截整页"
// 一轮要十几秒且只能看到 16px 一档；这里直接读形状定义，秒级出图，
// 且同时给出四种尺寸（16px 判断可读性，32/48px 判断形状本身对不对）。
//
// 用法：npm run icons:preview
//       （或 node tool/icons/preview-svg.mjs [输出png] [图标名,逗号分隔]）
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { startBrowser } from '../cdp.mjs'
import { buildSvgPaths } from './svg-data.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(dirname(HERE))
const OUT = process.argv[2] ?? join(ROOT, '.tmp-shots', 'icon-preview.png')
const ONLY = process.argv[3] ? process.argv[3].split(',') : null

const paths = await buildSvgPaths()

/**
 * 复刻 icons.ts 的 iconEl 渲染规则（**必须一致**，否则预览就失去意义）：
 * 外层 viewBox 0 0 24 24、fill none、stroke currentColor、stroke-width 1.7、
 * 圆角端点；每条 path 的 fill 覆盖为 currentColor（'none' 除外）、
 * 有 `fr` 时设 fill-rule、有 `sw` 时覆盖 stroke-width。
 *
 * ⚠️ 少复刻一项，预览就会撒谎：这里最初漏了 `fr`，于是调色盘在预览里是实心圆盘、
 * 让人以为数据有问题——其实数据是对的，是**预览工具**没画对。
 * 改 iconEl 时务必同步改这里（以及 preview-16.mjs，它有一份同样的逻辑）。
 */
function iconSvg(name) {
  const items = paths[name]
  if (!items) return `<span style="color:#f00">?${name}</span>`
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
const SIZES = [16, 24, 32, 48]

const rows = names
  .map((n) => {
    const cells = SIZES.map(
      (s) =>
        `<div class="cell"><div style="width:${s}px;height:${s}px" class="ic">${iconSvg(n)}</div><span class="lbl">${s}</span></div>`,
    ).join('')
    return `<div class="row"><div class="name">${n}</div>${cells}</div>`
  })
  .join('')

const html = `<!doctype html><meta charset="utf-8"><style>
  body{background:#232323;color:#c8c8c8;font:12px/1.4 "Segoe UI",sans-serif;margin:0;padding:18px}
  .row{display:flex;align-items:flex-end;gap:26px;padding:12px 10px;border-bottom:1px solid #333}
  .name{width:96px;color:#8fa8c8;font-weight:600}
  .cell{display:flex;flex-direction:column;align-items:center;gap:6px}
  .lbl{color:#666;font-size:10px}
  .ic{color:#e6e6e6;display:flex;align-items:center;justify-content:center}
  .ic svg{width:100%;height:100%;display:block}
</style>${rows}`

mkdirSync(dirname(OUT), { recursive: true })
// 预览用的临时 HTML 写到 gitignore 的目录（原来是脚本旁边，会进版本库）
const htmlPath = join(dirname(OUT), '_icon-preview.html')
writeFileSync(htmlPath, html)

const session = await startBrowser({ profilePrefix: 'iconprev-' })
const { cdp } = session
try {
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 120 + names.length * 78, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.navigate', { url: pathToFileURL(htmlPath).href })
  await new Promise((r) => setTimeout(r, 400))
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
  console.log(`✔ 图标预览 → ${OUT}`)
} finally {
  await session.close?.()
}
if (!existsSync(OUT)) throw new Error('截图失败')
