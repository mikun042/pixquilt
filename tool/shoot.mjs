#!/usr/bin/env node
/**
 * 截图工具：把当前取色器的渲染结果写成 PNG，供"看图改 UI"的流程使用。
 *
 * 为什么要有它：改取色器外观时必须能**看到现状**并与参考图并排比较。
 * 本工具零依赖——用 CDP 的 `Page.captureScreenshot` 拿到 base64，再用项目自己的 PNG 解码器
 * 裁剪出取色器区域（`node:zlib` 解压 → 重编码）。
 *
 * 用法：
 *   node tool/shoot.mjs                 # 产出 .tmp-shots/picker-full.png 与 picker-crop.png
 *   node tool/shoot.mjs --out 目录      # 换输出目录
 *   node tool/shoot.mjs --width 1400 --height 900
 *   node tool/shoot.mjs --color E7E7E7  # 先把主色设成指定 hex 再截图（用于和参考图同色对比）
 *   node tool/shoot.mjs --model hsv     # 先切到 HSV 段（参考图两张分别是 RGB / HSV）
 *
 * 注意：**必须先设桌面视口**。headless 默认 800×600 会命中 CSS 的 ≤980px 窄屏规则，
 * 把左栏 `display:none`，取色器就没有布局尺寸（截图会是空白）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { decodePngNode } from '../src/io/node-png.ts'
import { encodePngNode } from '../src/io/node-png.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const OUT_DIR = join(ROOT, arg('out', '.tmp-shots'))
const WIDTH = Number(arg('width', '1400'))
const HEIGHT = Number(arg('height', '900'))

const BROWSERS = [
  process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['PROGRAMFILES'] && join(process.env['PROGRAMFILES'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['PROGRAMFILES'] && join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean)

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? reject(new Error(m.error.message)) : resolve(m.result)
      }
    })
  }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
    })
    return new Cdp(ws)
  }
  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 超时：${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
}

/** 从整图里裁出一块（用于只截取色器区域） */
function crop(img, x, y, w, h) {
  const cx = Math.max(0, Math.min(img.width - 1, Math.floor(x)))
  const cy = Math.max(0, Math.min(img.height - 1, Math.floor(y)))
  const cw = Math.max(1, Math.min(img.width - cx, Math.floor(w)))
  const ch = Math.max(1, Math.min(img.height - cy, Math.floor(h)))
  const out = new Uint8ClampedArray(cw * ch * 4)
  for (let row = 0; row < ch; row++) {
    const src = ((cy + row) * img.width + cx) * 4
    out.set(img.data.subarray(src, src + cw * 4), row * cw * 4)
  }
  return { width: cw, height: ch, data: out }
}

async function main() {
  const browser = BROWSERS.find((p) => existsSync(p))
  if (!browser) throw new Error('找不到 Edge/Chrome')
  const app = join(ROOT, '像素画工作台.html')
  if (!existsSync(app)) throw new Error(`找不到 ${app}，先跑 npm run build`)

  mkdirSync(OUT_DIR, { recursive: true })
  const userDataDir = mkdtempSync(join(tmpdir(), 'shoot-'))
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] })

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = ''
    const t = setTimeout(() => reject(new Error('等待 DevTools 端口超时')), 25000)
    const onData = (c) => {
      buf += String(c)
      const m = buf.match(/ws:\/\/[^\s]+/)
      if (m) {
        clearTimeout(t)
        resolve(m[0])
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
  })

  const port = wsUrl.match(/:(\d+)\//)[1]
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const cdp = await Cdp.connect(list.find((t) => t.type === 'page').webSocketDebuggerUrl)

  try {
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    // 关键：桌面视口（否则窄屏规则会隐藏左栏，取色器没有布局尺寸）
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
    await cdp.send('Page.navigate', { url: pathToFileURL(app).href })
    for (let i = 0; i < 60; i++) {
      if (await cdp.eval('!!window.pixelArtStudio')) break
      await new Promise((r) => setTimeout(r, 200))
    }

    // 打开取色器：点主色块
    await cdp.eval(`(() => { const s = document.querySelectorAll('.color-slot')[0]; if (s) s.click(); return true })()`)
    await new Promise((r) => setTimeout(r, 400))

    // 可选：先把主色设成指定 hex（参考图同色对比用；不改算法，只走页内自动化接口）
    const color = arg('color', '')
    if (color) {
      await cdp.eval(`(() => { window.pixelArtStudio.setPrimary('#${color.replace(/^#/, '')}'); return true })()`)
      await new Promise((r) => setTimeout(r, 300))
    }
    // 可选：切到 HSV 段（参考图第二张就是 HSV 段）
    const model = arg('model', '')
    if (model) {
      await cdp.eval(`(() => { const t = [...document.querySelectorAll('.cp-tab')].find((b) => b.textContent.toLowerCase() === ${JSON.stringify(model.toLowerCase())}); if (t) t.click(); return !!t })()`)
      await new Promise((r) => setTimeout(r, 300))
    }

    const rect = await cdp.eval(`(() => {
      const cp = document.querySelector('.cp')
      if (!cp) return null
      const r = cp.getBoundingClientRect()
      return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height })
    })()`)
    if (!rect) throw new Error('取色器没有渲染出来（面板未打开或构建失败）')
    const box = JSON.parse(rect)

    const full = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const fullPath = join(OUT_DIR, 'picker-full.png')
    writeFileSync(fullPath, Buffer.from(full.data, 'base64'))

    // 裁出取色器区域（留 10px 边距，方便看清描边与圆角）
    const decoded = decodePngNode(new Uint8Array(Buffer.from(full.data, 'base64')))
    const pad = 10
    const cropped = crop(decoded, box.x - pad, box.y - pad, box.w + pad * 2, box.h + pad * 2)
    const cropPath = join(OUT_DIR, 'picker-crop.png')
    writeFileSync(cropPath, Buffer.from(encodePngNode(cropped)))

    console.log(`✔ 整页截图：${fullPath}（${decoded.width}×${decoded.height}）`)
    console.log(`✔ 取色器区域：${cropPath}（${cropped.width}×${cropped.height}）`)
    console.log('  取色器位置：' + JSON.stringify({ x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) }))
    console.log('  提示：与参考图并排比较；定量分析可用 node tool/ref-analysis.mjs <png>')
  } finally {
    cdp.ws.close()
    child.kill()
    await new Promise((r) => setTimeout(r, 300))
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

/*
 * 只在**直接被当命令行跑**时执行：被 import 时不该顺带跑一遍 main，
 * 更不该 process.exit 把导入方一起带走（tool/artc.mjs 末尾记录过这条教训）。
 */
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`截取失败：${err?.message ?? err}`)
    process.exit(1)
  })
}
