#!/usr/bin/env node
/**
 * 元素放大截图：改 UI / 排查交互时用。
 *   node .tmp/el-shot.mjs <css选择器> [输出名] [放大倍数]
 * 例：node .tmp/el-shot.mjs .tool-grid tool-grid 6
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT = join(ROOT, '.tmp-shots')
const SELECTOR = process.argv[2] ?? '.tool-grid'
const NAME = process.argv[3] ?? 'element'
const SCALE = Number(process.argv[4] ?? 6)
/** 可选：截图前先点一下某个元素（例如展开「管理预设」） */
const CLICK = process.argv.includes('--click') ? process.argv[process.argv.indexOf('--click') + 1] : ''
/** 可选：视口高度。元素高于视口时，视口外的部分截不到（会是一片空白），所以要调高 */
const VH = Number(process.argv.includes('--height') ? process.argv[process.argv.indexOf('--height') + 1] : 900)
/** 可选：截图前先跑一段 JS（例如先把两侧栏都收起） */
const PRE = process.argv.includes('--pre') ? process.argv[process.argv.indexOf('--pre') + 1] : ''

const BROWSERS = [
  process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
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
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true })
    })
    return new Cdp(ws)
  }
  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP 超时：${method}`)) }, timeoutMs)
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, reject: (e) => { clearTimeout(timer); reject(e) } })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
}

async function main() {
  const browser = BROWSERS.find((p) => existsSync(p))
  if (!browser) throw new Error('找不到 Edge/Chrome')
  const app = join(ROOT, '像素画工作台.html')
  mkdirSync(OUT, { recursive: true })
  const userDataDir = mkdtempSync(join(tmpdir(), 'elshot-'))
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] })

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = ''
    const t = setTimeout(() => reject(new Error('等待 DevTools 端口超时')), 25000)
    const onData = (c) => { buf += String(c); const m = buf.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(t); resolve(m[0]) } }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
  })
  const port = wsUrl.match(/:(\d+)\//)[1]
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const cdp = await Cdp.connect(list.find((t) => t.type === 'page').webSocketDebuggerUrl)

  try {
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    // 桌面视口：窄屏规则会把左栏 display:none，元素 rect 全 0
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: VH, deviceScaleFactor: 1, mobile: false })
    await cdp.send('Page.navigate', { url: pathToFileURL(app).href })
    for (let i = 0; i < 60; i++) { if (await cdp.eval('!!window.pixelArtStudio')) break; await new Promise((r) => setTimeout(r, 200)) }
    await new Promise((r) => setTimeout(r, 300))

    if (PRE) {
      await cdp.eval(`(${PRE})()`)
      await new Promise((r) => setTimeout(r, 250))
    }

    if (CLICK) {
      const ok = await cdp.eval(`(() => {
        const q = ${JSON.stringify(CLICK)}
        const el = document.querySelector('[data-testid="' + q + '"]') ||
          [...document.querySelectorAll('button, select')].find((b) => (b.textContent || '').includes(q) || b.id === q)
        if (!el) return false
        el.click()
        return true
      })()`)
      console.log(ok ? `  （已点击「${CLICK}」）` : `  ⚠ 找不到可点的「${CLICK}」`)
      await new Promise((r) => setTimeout(r, 300))
    }

    const raw = await cdp.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(SELECTOR)})
      if (!el) return JSON.stringify({ error: '找不到元素' })
      const r = el.getBoundingClientRect()
      return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height })
    })()`)
    const it = JSON.parse(raw)
    if (it.error) throw new Error(`${SELECTOR}: ${it.error}`)

    const pad = 6
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: Math.max(0, it.x - pad), y: Math.max(0, it.y - pad), width: it.w + pad * 2, height: it.h + pad * 2, scale: SCALE },
    })
    const p = join(OUT, `${NAME}.png`)
    writeFileSync(p, Buffer.from(shot.data, 'base64'))
    console.log(`✔ ${SELECTOR} → ${p}（元素 ${it.w.toFixed(0)}×${it.h.toFixed(0)}px @${SCALE}x）`)
  } finally {
    cdp.ws.close()
    child.kill()
    await new Promise((r) => setTimeout(r, 300))
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

main().catch((e) => { console.error(`失败：${e?.message ?? e}`); process.exit(1) })
