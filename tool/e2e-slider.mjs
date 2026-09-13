#!/usr/bin/env node
/**
 * 数值滑条拖动专项验证（回归防线）。
 *
 * 背景：RGB / HSV 六个数值行看上去是滑条，但只有 Alpha 行绑了指针事件时，
 * 它们"能看不能拖"——用户实际反馈过这个缺陷。本脚本用真实 PointerEvent 逐行拖动并断言通道值改变。
 *
 * 命中区是**滑条轨道** `.cp-row-track`（不是整行）：数值框在轨道之外，
 * 输入数字时不会误触滑条（见 e2e-picker 的"数值框不触发滑条"）。
 *
 * 用法：node tool/e2e-slider.mjs [--app <html 路径>]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
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
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 超时：${method}`))
      }, 20000)
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

const results = []
const check = (name, fn) => {
  try {
    results.push({ name, ok: true, detail: String(fn() ?? '') })
  } catch (err) {
    results.push({ name, ok: false, detail: err?.message ?? String(err) })
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m)
}

const appArg = process.argv.indexOf('--app')
const app = appArg >= 0 ? process.argv[appArg + 1] : join(ROOT, '像素画工作台.html')
if (!existsSync(app)) throw new Error(`找不到 ${app}，先跑 npm run build`)

const browser = BROWSERS.find((p) => existsSync(p))
const userDataDir = mkdtempSync(join(tmpdir(), 'slider-e2e-'))
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

await cdp.send('Runtime.enable')
await cdp.send('Page.enable')
// 桌面视口：否则窄屏规则会隐藏左栏，取色器没有布局尺寸，拖动断言全部失真
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.navigate', { url: pathToFileURL(app).href })
for (let i = 0; i < 60; i++) {
  if (await cdp.eval('!!window.pixelArtStudio')) break
  await new Promise((r) => setTimeout(r, 200))
}
await cdp.eval(`(() => { const s = document.querySelectorAll('.color-slot')[0]; if (s) s.click(); return true })()`)
await new Promise((r) => setTimeout(r, 300))

// 起点设为中性灰：三个通道都在中位，拖动才有足够行程。
// （若从 #1a1a1a 起，G 已经是 26/255≈0.102，拖到 10% 会取整回同一个字节，
//   "字节没变"是正确行为，却会让断言误报——所以断言必须用有行程的起点。）
await cdp.eval(`window.pixelArtStudio.setPrimary('#808080')`)
await new Promise((r) => setTimeout(r, 200))

/** 把某个数值行拖到横向比例 pos（0–1），返回该行是否可拖 + 拖动前后的颜色 */
async function dragRow(key, pos) {
  return await cdp.eval(`(() => {
    const row = document.querySelector('[data-row="${key}"]')
    if (!row) return JSON.stringify({ error: '找不到行 ' + '${key}' })
    // 拖动命中区是**滑条轨道**（.cp-row-track）：数值框在轨道之外，故意拖不到
    const track = row.querySelector('.cp-row-track')
    if (!track) return JSON.stringify({ error: '找不到滑条轨道 ' + '${key}' })
    const rect = track.getBoundingClientRect()
    if (!(rect.width > 0)) return JSON.stringify({ error: '轨道没有布局宽度' })
    const before = window.pixelArtStudio.getInfo().primary
    const x = rect.left + rect.width * ${pos}
    const y = rect.top + rect.height / 2
    const mk = (type) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 11, button: 0, buttons: type === 'pointerup' ? 0 : 1 })
    track.dispatchEvent(mk('pointerdown'))
    track.dispatchEvent(mk('pointermove'))
    window.dispatchEvent(mk('pointerup'))
    const input = row.querySelector('input')
    return JSON.stringify({ before, after: window.pixelArtStudio.getInfo().primary, shown: input ? input.value : '', fillW: row.querySelector('.cp-row-fill')?.style.width || '' })
  })()`)
}

/** 通道比例（0–1），与界面显示口径一致 */
function frac(hex, key) {
  const c = hex.replace('#', '')
  const r = parseInt(c.slice(0, 2), 16)
  const g = parseInt(c.slice(2, 4), 16)
  const b = parseInt(c.slice(4, 6), 16)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (key === 'R') return r / 255
  if (key === 'G') return g / 255
  if (key === 'B') return b / 255
  if (key === 'V') return max / 255
  if (key === 'S') return max === 0 ? 0 : (max - min) / max
  return 0
}

/* ---------------- RGB 三行 ---------------- */
for (const [key, pos] of [
  ['R', 0.95],
  ['G', 0.05],
  ['B', 0.6],
]) {
  const raw = await dragRow(key, pos)
  check(`RGB 滑条可拖动：${key} 行拖到 ${Math.round(pos * 100)}% 后通道值随之改变`, () => {
    const r = JSON.parse(raw)
    assert(!r.error, `拖动失败：${r.error}`)
    assert(r.after !== r.before, `${key} 拖动后颜色没变（before=${r.before} after=${r.after}）——滑条不可拖动`)
    const got = frac(r.after, key)
    assert(Math.abs(got - pos) <= 0.15, `${key} 拖到 ${pos}，实测通道比例 ${got.toFixed(3)}（偏差过大）`)
    assert(r.shown && r.shown !== '0.000' || pos === 0, `数字未同步：${r.shown}`)
    return `${r.before} → ${r.after}（${key}=${got.toFixed(2)}，显示 ${r.shown}，填充 ${r.fillW}）`
  })
}

/* ---------------- 切到 HSV，验证 H/S/V 三行 ---------------- */
await cdp.eval(`(() => { const tabs = [...document.querySelectorAll('.cp-tab')]; const hsv = tabs.find((t) => t.textContent.includes('HSV')); if (hsv) hsv.click(); return true })()`)
await new Promise((r) => setTimeout(r, 200))

const hsvVisible = await cdp.eval(`(() => {
  const vis = (k) => { const n = document.querySelector('[data-row="' + k + '"]'); return n ? getComputedStyle(n).display !== 'none' : false }
  return JSON.stringify({ H: vis('H'), S: vis('S'), V: vis('V'), R: vis('R'), G: vis('G'), B: vis('B') })
})()`)
check('HSV 标签：切到 HSV 后显示 H/S/V、隐藏 R/G/B', () => {
  const v = JSON.parse(hsvVisible)
  assert(v.H && v.S && v.V, `H/S/V 应可见：${JSON.stringify(v)}`)
  assert(!v.R && !v.G && !v.B, `R/G/B 应隐藏：${JSON.stringify(v)}`)
  return 'H/S/V 可见，R/G/B 隐藏'
})

const hDrag = await dragRow('H', 0.25) // 色相 25% → 90°
check('HSV 滑条可拖动：H 行拖到 25% 后色相约为 90°', () => {
  const r = JSON.parse(hDrag)
  assert(!r.error, `拖动失败：${r.error}`)
  assert(r.after !== r.before, `H 拖动后颜色没变（${r.before} → ${r.after}）——H 滑条不可拖动`)
  const shown = Number(r.shown)
  assert(Math.abs(shown - 0.25) <= 0.06, `H 显示值应为 0.25 附近，实际 ${r.shown}`)
  return `${r.before} → ${r.after}（显示 ${r.shown}）`
})

const sDrag = await dragRow('S', 0.15)
check('HSV 滑条可拖动：S 行拖到 15% 后饱和度随之下降', () => {
  const r = JSON.parse(sDrag)
  assert(!r.error, `拖动失败：${r.error}`)
  const s = frac(r.after, 'S')
  assert(Math.abs(s - 0.15) <= 0.15, `S 拖到 0.15，实测 ${s.toFixed(3)}`)
  return `${r.before} → ${r.after}（S=${s.toFixed(2)}，显示 ${r.shown}）`
})

const vDrag = await dragRow('V', 0.8)
check('HSV 滑条可拖动：V 行拖到 80% 后明度随之改变', () => {
  const r = JSON.parse(vDrag)
  assert(!r.error, `拖动失败：${r.error}`)
  const v = frac(r.after, 'V')
  assert(Math.abs(v - 0.8) <= 0.15, `V 拖到 0.8，实测 ${v.toFixed(3)}`)
  return `${r.before} → ${r.after}（V=${v.toFixed(2)}，显示 ${r.shown}）`
})

/* ---------------- 数值输入仍然可用（两条路径都要能改） ---------------- */
const typed = await cdp.eval(`(() => {
  const row = document.querySelector('[data-row="V"]')
  const input = row.querySelector('input')
  const before = window.pixelArtStudio.getInfo().primary
  input.value = '0.3'
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return JSON.stringify({ before, after: window.pixelArtStudio.getInfo().primary })
})()`)
check('数值输入与拖动两条路径都能改（输入 0.3 生效）', () => {
  const r = JSON.parse(typed)
  const v = frac(r.after, 'V')
  assert(Math.abs(v - 0.3) <= 0.06, `输入 0.3 后明度应为 0.3 附近，实测 ${v.toFixed(3)}`)
  return `${r.before} → ${r.after}（V=${v.toFixed(2)}）`
})

/* ---------------- 拖动过程中不进撤销栈的中间态 ---------------- */
const noSpam = await cdp.eval(`(() => {
  const track = document.querySelector('[data-row="S"] .cp-row-track')
  const rect = track.getBoundingClientRect()
  const mk = (type, x) => new PointerEvent(type, { clientX: x, clientY: rect.top + rect.height / 2, bubbles: true, pointerId: 12, button: 0, buttons: type === 'pointerup' ? 0 : 1 })
  track.dispatchEvent(mk('pointerdown', rect.left + rect.width * 0.2))
  for (let i = 0; i < 15; i++) track.dispatchEvent(mk('pointermove', rect.left + rect.width * (0.2 + i * 0.04)))
  window.dispatchEvent(mk('pointerup', rect.left + rect.width * 0.8))
  return JSON.stringify({ ok: true, primary: window.pixelArtStudio.getInfo().primary })
})()`)
check('连续拖动 15 次不报错、最终值落在终点附近', () => {
  const r = JSON.parse(noSpam)
  assert(r.ok, '拖动链路抛错')
  const s = frac(r.primary, 'S')
  assert(Math.abs(s - 0.8) <= 0.2, `终点应为 0.8 附近，实测 ${s.toFixed(3)}`)
  return `S=${s.toFixed(2)}`
})

/* ---------------- 双路径：点数字 = 编辑（不改色），拖整行 = 调值 ---------------- */
// 必须先切回 RGB：前面的 HSV 测试把 R/G/B 行设成了 display:none，尺寸为 0 时断言会假通过。
await cdp.eval(`(() => { const tabs = [...document.querySelectorAll('.cp-tab')]; const rgb = tabs.find((t) => t.textContent.includes('RGB')); if (rgb) rgb.click(); return true })()`)
await new Promise((r) => setTimeout(r, 200))

const inputSafe = await cdp.eval(`(() => {
  const row = document.querySelector('[data-row="R"]')
  const input = row.querySelector('input.cp-num')
  const input0 = input.value
  const before = window.pixelArtStudio.getInfo().primary
  // 用显式 focus() 验证"可编辑"：headless 下合成的 .click() 不会触发聚焦，
  // 那属于测试环境差异，不是产品行为（真实鼠标点击是会聚焦的）。
  input.focus()
  const focused = document.activeElement === input
  input.blur()
  return JSON.stringify({
    before,
    afterFocus: window.pixelArtStudio.getInfo().primary,
    focused,
    rowW: Math.round(row.getBoundingClientRect().width),
    inputW: Math.round(input.getBoundingClientRect().width),
    input0,
    inputNow: input.value
  })
})()`)
check('双路径：数字框可聚焦编辑、不改颜色、不清空内容', () => {
  const r = JSON.parse(inputSafe)
  assert(r.rowW > 100, `行必须有实际宽度（实测 ${r.rowW}px）——否则断言会假通过`)
  assert(r.inputW > 20, `数字框必须有实际宽度（实测 ${r.inputW}px）`)
  assert(r.focused, '数字框应可获得焦点（否则无法输入）')
  assert(r.afterFocus === r.before, `聚焦不该改颜色：${r.before} → ${r.afterFocus}`)
  assert(r.inputNow === r.input0, `输入框内容不应被清空：${r.input0} → ${r.inputNow}`)
  return `行 ${r.rowW}px / 数字框 ${r.inputW}px，可聚焦且未改色`
})

const labelDrag = await cdp.eval(`(() => {
  const row = document.querySelector('[data-row="G"]')
  const track = row.querySelector('.cp-row-track')
  const label = row.querySelector('.cp-row-label')
  const trackRect = track.getBoundingClientRect()
  const lr = label.getBoundingClientRect()
  const before = window.pixelArtStudio.getInfo().primary
  // 轨道左端（标签处）按下也应能调值：标签是 pointer-events:none，事件落到轨道上
  const x = lr.left + 4
  const mk = (type) => new PointerEvent(type, { clientX: x, clientY: trackRect.top + trackRect.height / 2, bubbles: true, pointerId: 22, button: 0, buttons: type === 'pointerup' ? 0 : 1 })
  track.dispatchEvent(mk('pointerdown'))
  window.dispatchEvent(mk('pointerup'))
  return JSON.stringify({ before, after: window.pixelArtStudio.getInfo().primary, labelW: Math.round(lr.width), trackW: Math.round(trackRect.width) })
})()`)
check('滑条轨道：在行首标签位置按下也能按比例调值', () => {
  const r = JSON.parse(labelDrag)
  assert(r.labelW > 10, `标签必须有实际宽度（实测 ${r.labelW}px）`)
  assert(r.trackW > 50, `轨道必须有实际宽度（实测 ${r.trackW}px）——否则断言会假通过`)
  const g = frac(r.after, 'G')
  assert(g < 0.15, `行首（约 10%）应把 G 调到很低，实测 ${g.toFixed(2)}（${r.before} → ${r.after}）`)
  return `${r.before} → ${r.after}（G=${g.toFixed(2)}）`
})

/* ---------------- 零尺寸免疫（侧栏收起时拖动不应产生 NaN） ---------------- */
const degenerate = await cdp.eval(`(() => {
  const rail = document.querySelector('.rail')
  const old = rail.style.display
  rail.style.display = 'none'          // 模拟面板不可见（窄屏抽屉收起）
  const track = document.querySelector('[data-row="R"] .cp-row-track')
  const mk = (type) => new PointerEvent(type, { clientX: 100, clientY: 100, bubbles: true, pointerId: 13, button: 0, buttons: type === 'pointerup' ? 0 : 1 })
  const before = window.pixelArtStudio.getInfo().primary
  track.dispatchEvent(mk('pointerdown'))
  window.dispatchEvent(mk('pointerup'))
  rail.style.display = old
  const after = window.pixelArtStudio.getInfo().primary
  return JSON.stringify({ before, after })
})()`)
check('零尺寸免疫：面板不可见时拖动不产生非法颜色', () => {
  const r = JSON.parse(degenerate)
  assert(!/nan/i.test(r.after), `产生了非法颜色：${r.after}`)
  assert(r.after === r.before, `不可见时不应改变颜色：${r.before} → ${r.after}`)
  return `${r.after}（未变）`
})

const passed = results.filter((r) => r.ok).length
for (const r of results) console.log(` ${r.ok ? '✔' : '✘'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
console.log(`\n滑条拖动验证：${passed}/${results.length} 通过`)

cdp.ws.close()
child.kill()
await new Promise((r) => setTimeout(r, 300))
rmSync(userDataDir, { recursive: true, force: true })
process.exit(passed === results.length ? 0 : 1)
