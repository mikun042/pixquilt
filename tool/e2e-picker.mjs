#!/usr/bin/env node
/**
 * 取色器专项端到端验证（Blender 结构：色轮 + 明度竖条 + 透明度横条 + RGB/HSV/Hex 标签 + 色板）。
 * 用真实无头浏览器 + 合成 PointerEvent 拖动，断言颜色确实按几何位置变化。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
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
    await new Promise((r, j) => {
      ws.addEventListener('open', r, { once: true })
      ws.addEventListener('error', () => j(new Error('ws 连接失败')), { once: true })
    })
    return new Cdp(ws)
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`超时：${method}`))
        }
      }, 20000)
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

const userDataDir = mkdtempSync(join(tmpdir(), 'cp-e2e-'))
const browser = BROWSERS.find((p) => existsSync(p))
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] })
const wsUrl = await new Promise((resolve, reject) => {
  let buf = ''
  const t = setTimeout(() => reject(new Error('等端口超时')), 25000)
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
// 必须先设成桌面视口：headless 默认 800×600 会命中 ≤980px 的窄屏规则、把左侧栏 display:none，
// 取色器于是没有布局尺寸（rect 全 0），拖动断言会全部失真。
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.navigate', { url: pathToFileURL(join(ROOT, '像素画工作台.html')).href })
for (let i = 0; i < 50; i++) {
  if (await cdp.eval('!!window.pixelArtStudio')) break
  await new Promise((r) => setTimeout(r, 200))
}

// 打开取色器（点主色块 → 面板展开）
await cdp.eval(`(() => {
  const slot = [...document.querySelectorAll('.color-slot')][0]
  slot.click()
  return true
})()`)
await new Promise((r) => setTimeout(r, 250))

const structure = await cdp.eval(`JSON.stringify({
  railVisible: (() => { const r = document.querySelector('.rail'); return r ? Math.round(r.getBoundingClientRect().width) : 0 })(),
  hasPanel: !!document.querySelector('.cp'),
  hasWheel: !!document.querySelector('.cp-wheel'),
  wheelSize: document.querySelector('.cp-wheel') ? document.querySelector('.cp-wheel').width : 0,
  hasValueBar: !!document.querySelector('.cp-bar'),
  hasAlpha: !!document.querySelector('.cp-alpha'),
  tabs: [...document.querySelectorAll('.cp-tab')].map((t) => t.textContent),
  fields: [...document.querySelectorAll('.cp-field')].filter((f) => f.style.display !== 'none').map((f) => f.textContent.slice(0, 3)),
  swatchRows: document.querySelectorAll('.cp-swatch-row').length
})`)
const S = JSON.parse(structure)
check('取色器结构：色轮 + 明度竖条 + 透明度横条 + 三个模式标签 + 色板', () => {
  assert(S.railVisible > 100, `左侧栏没有布局宽度（${S.railVisible}）——视口太小会命中窄屏规则，取色器无法交互`)
  assert(S.hasPanel, '取色器面板未出现')
  assert(S.hasWheel && S.wheelSize > 100, `色轮缺失或过小：${S.wheelSize}`)
  assert(S.hasValueBar, '明度竖条缺失')
  assert(S.hasAlpha, '透明度横条缺失')
  assert(S.tabs.join(',') === 'RGB,HSV,Hex', `模式标签应为 RGB/HSV/Hex，实际 ${S.tabs.join(',')}`)
  assert(S.swatchRows >= 2, `色板行数过少：${S.swatchRows}`)
  return `色轮 ${S.wheelSize}px / 标签 ${S.tabs.join('/')} / 默认字段 ${S.fields.join('')}`
})

/** 在色轮上按住拖动（真实交互路径：down → move → up）；返回拖动后的颜色与面板是否仍在 */
async function dragWheel(offsetFromCenterX, offsetFromCenterY) {
  return await cdp.eval(`(() => {
    const wheel = document.querySelector('.cp-wheel')
    if (!wheel) return JSON.stringify({ error: '拖动前就找不到 .cp-wheel', pickerError: document.getElementById('canvas-host').dataset.pickerError || '' })
    const r = wheel.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const mk = (type, x, y) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1 })
    let err = ''
    try {
      wheel.dispatchEvent(mk('pointerdown', cx + ${offsetFromCenterX}, cy + ${offsetFromCenterY}))
      const afterDown = !!document.querySelector('.cp-wheel')
      wheel.dispatchEvent(mk('pointermove', cx + ${offsetFromCenterX}, cy + ${offsetFromCenterY}))
      const afterMove = !!document.querySelector('.cp-wheel')
      window.dispatchEvent(mk('pointerup', cx + ${offsetFromCenterX}, cy + ${offsetFromCenterY}))
      return JSON.stringify({ primary: window.pixelArtStudio.getInfo().primary, afterDown, afterMove, afterUp: !!document.querySelector('.cp-wheel'), pickerError: document.getElementById('canvas-host').dataset.pickerError || '' })
    } catch (e) {
      return JSON.stringify({ error: String(e.message), pickerError: document.getElementById('canvas-host').dataset.pickerError || '' })
    }
  })()`)
}

const rightRaw = await dragWheel(60, 0) // 圆右侧 → 色相 ≈ 0°（红）
const rightInfo = JSON.parse(rightRaw)
check('色轮拖动：右侧取到红色（色相 0° 方向）', () => {
  assert(!rightInfo.error, `拖动抛错：${rightInfo.error}（pickerError: ${rightInfo.pickerError}）`)
  assert(rightInfo.afterDown && rightInfo.afterMove && rightInfo.afterUp, `拖动过程中面板消失：down=${rightInfo.afterDown} move=${rightInfo.afterMove} up=${rightInfo.afterUp}`)
  const right = rightInfo.primary
  const c = right.replace('#', '')
  const r = parseInt(c.slice(0, 2), 16)
  const g = parseInt(c.slice(2, 4), 16)
  const b = parseInt(c.slice(4, 6), 16)
  assert(r > g && r > b, `右侧应为偏红，实际 ${right}`)
  return `${right}（R 最大）`
})
const right = rightInfo.primary
const top = (await dragWheel(0, -60))
const topInfo = JSON.parse(top)
check('色轮拖动：上方取到偏蓝紫（色相随角度变化）', () => {
  assert(!topInfo.error, `拖动抛错：${topInfo.error}`)
  const t = topInfo.primary
  const c = t.replace('#', '')
  const r = parseInt(c.slice(0, 2), 16)
  const g = parseInt(c.slice(2, 4), 16)
  const b = parseInt(c.slice(4, 6), 16)
  assert(b > r && b > g, `上方应为偏蓝，实际 ${t}`)
  assert(t !== right, '不同角度必须得到不同颜色（说明角度→色相生效）')
  return `${t}（B 最大）`
})

const centerRaw = JSON.parse(await dragWheel(0, 0)) // 圆心 → 饱和度 0（灰白）
check('色轮圆心：饱和度 0 → 灰阶（半径→饱和度生效）', () => {
  assert(!centerRaw.error, `拖动抛错：${centerRaw.error}`)
  const center = centerRaw.primary
  const c = center.replace('#', '')
  const r = parseInt(c.slice(0, 2), 16)
  const g = parseInt(c.slice(2, 4), 16)
  const b = parseInt(c.slice(4, 6), 16)
  assert(Math.abs(r - g) <= 3 && Math.abs(g - b) <= 3, `圆心应接近灰阶，实际 ${center}`)
  return `${center}（R≈G≈B）`
})

const edgeInfo = JSON.parse(await dragWheel(90, 0))
check('色轮边缘：拖到圆外时饱和度夹到 1（游标不甩出圆外）', () => {
  assert(!edgeInfo.error, `拖动抛错：${edgeInfo.error}`)
  const p = edgeInfo.primary
  const c = p.replace('#', '')
  const r = parseInt(c.slice(0, 2), 16)
  const g = parseInt(c.slice(2, 4), 16)
  const b = parseInt(c.slice(4, 6), 16)
  // 边缘 = 饱和度满：三通道的极差应接近当前明度（而不是要求颜色亮，亮度由竖条决定）
  const spread = Math.max(r, g, b) - Math.min(r, g, b)
  assert(spread >= 8, `边缘应为满饱和（通道极差应明显），实际 ${p} 极差 ${spread}`)
  return `${p}（通道极差 ${spread}）`
})

// 明度竖条：拖到顶部应接近白色系（高 V）
const brightTop = await cdp.eval(`(() => {
  const bar = document.querySelector('.cp-bar-wrap')
  const r = bar.getBoundingClientRect()
  const mk = (type, y) => new PointerEvent(type, { clientX: r.left + r.width / 2, clientY: y, bubbles: true, pointerId: 2, button: 0, buttons: type === 'pointerup' ? 0 : 1 })
  bar.dispatchEvent(mk('pointerdown', r.top + 1))
  window.dispatchEvent(mk('pointerup', r.top + 1))
  const top = window.pixelArtStudio.getInfo().primary
  bar.dispatchEvent(mk('pointerdown', r.bottom - 1))
  window.dispatchEvent(mk('pointerup', r.bottom - 1))
  const bottom = window.pixelArtStudio.getInfo().primary
  return JSON.stringify({ top, bottom })
})()`)
check('明度竖条：顶部亮、底部暗（V 轴方向正确）', () => {
  const { top: hi, bottom: lo } = JSON.parse(brightTop)
  const lum = (hex) => {
    const c = hex.replace('#', '')
    return 0.2126 * parseInt(c.slice(0, 2), 16) + 0.7152 * parseInt(c.slice(2, 4), 16) + 0.0722 * parseInt(c.slice(4, 6), 16)
  }
  assert(lum(hi) > lum(lo) + 40, `顶部应明显更亮：顶 ${hi} (${Math.round(lum(hi))}) vs 底 ${lo} (${Math.round(lum(lo))})`)
  return `顶 ${hi} → 底 ${lo}`
})

// 模式标签：切到 HSV 后字段应换成 H/S/V
const tabSwitch = await cdp.eval(`(() => {
  const tabs = [...document.querySelectorAll('.cp-tab')]
  tabs[1].click() // HSV
  const hsvFields = [...document.querySelectorAll('.cp-field')].filter((f) => f.style.display !== 'none').map((f) => f.textContent.slice(0, 1))
  tabs[2].click() // Hex
  const hexFields = [...document.querySelectorAll('.cp-field')].filter((f) => f.style.display !== 'none').map((f) => f.textContent.slice(0, 3))
  const hexField = [...document.querySelectorAll('.cp-field')].find((f) => f.textContent.startsWith('Hex'))
  const hexValue = hexField ? hexField.querySelector('input').value : ''
  return JSON.stringify({ hsvFields, hexFields, hexValue })
})()`)
check('模式标签：RGB / HSV / Hex 切换改变数值行单位', () => {
  const t = JSON.parse(tabSwitch)
  assert(t.hsvFields.join('') === 'HSV', `HSV 标签应显示 H/S/V，实际 ${t.hsvFields.join('')}`)
  assert(t.hexFields[0].startsWith('Hex'), `Hex 标签应显示 Hex，实际 ${t.hexFields[0]}`)
  assert(/^#[0-9A-F]{6}$/i.test(t.hexValue), `Hex 值应为 #RRGGBB，实际 ${t.hexValue}`)
  return `HSV→${t.hsvFields.join('')} / Hex→${t.hexValue}`
})

// 数值输入：改成具体颜色应生效
const typed = await cdp.eval(`(() => {
  const ps = window.pixelArtStudio
  const input = [...document.querySelectorAll('.cp-num')].find((i) => /^#[0-9A-F]{6}$/i.test(i.value))
  input.value = '#FF6600'
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return ps.getInfo().primary
})()`)
check('数值输入：Hex 直接输入生效', () => {
  assert(typed === '#ff6600', `应变成 #ff6600，实际 ${typed}`)
  return typed
})

// 色板点选
const swatchPick = await cdp.eval(`(() => {
  const sw = [...document.querySelectorAll('.cp-swatch')].find((s) => !s.classList.contains('transparent'))
  const want = sw.title
  sw.click()
  return JSON.stringify({ want, got: window.pixelArtStudio.getInfo().primary })
})()`)
check('色板点选：点击色块即设为主色', () => {
  const r = JSON.parse(swatchPick)
  assert(r.got.toLowerCase() === r.want.toLowerCase(), `应为 ${r.want}，实际 ${r.got}`)
  return r.got
})

// 透明度最左 = 透明色
const alpha = await cdp.eval(`(() => {
  const track = document.querySelector('.cp-alpha')
  const rect = track.getBoundingClientRect()
  const mk = (type, x) => new PointerEvent(type, { clientX: x, clientY: rect.top + rect.height / 2, bubbles: true, pointerId: 3, button: 0, buttons: type === 'pointerup' ? 0 : 1 })
  // 落在左端死区内即视为"拖到最左"（亚像素取整让"精确 1px"不可达）
  track.dispatchEvent(mk('pointerdown', rect.left + Math.max(1, rect.width * 0.02)))
  window.dispatchEvent(mk('pointerup', rect.left + Math.max(1, rect.width * 0.02)))
  return JSON.stringify({ transparent: window.pixelArtStudio.getInfo().eraserToAlpha })
})()`)
check('透明度横条：拖到最左 = 选中「透明色」', () => {
  const a = JSON.parse(alpha)
  assert(a.transparent === true, '拖到最左应进入透明绘制态')
  return '透明态已开启'
})

// 拖动中不进撤销栈：拖动系列后 undo 应该能撤销"一次落笔"而不是十几个中间态
const dragEdits = await cdp.eval(`(() => {
  const ps = window.pixelArtStudio
  ps.newCanvas({ width: 8, height: 8, color: '#ffffff' })
  const before = ps.artHash()
  const wheel = document.querySelector('.cp-wheel')
  const r = wheel.getBoundingClientRect()
  const cx = r.left + r.width / 2
  const cy = r.top + r.height / 2
  const mk = (type, x, y) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 4, button: 0, buttons: type === 'pointerup' ? 0 : 1 })
  wheel.dispatchEvent(mk('pointerdown', cx + 40, cy))
  for (let i = 0; i < 12; i++) wheel.dispatchEvent(mk('pointermove', cx + 40, cy + i))
  window.dispatchEvent(mk('pointerup', cx + 40, cy + 12))
  return JSON.stringify({ before, after: ps.artHash() })
})()`)
check('色板/取色不影响画布内容（取色只改主色）', () => {
  const r = JSON.parse(dragEdits)
  assert(r.before === r.after, `取色不应改动画布：${r.before} → ${r.after}`)
  return '画布未变'
})

const passed = results.filter((r) => r.ok).length
for (const r of results) console.log(` ${r.ok ? '✔' : '✘'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
console.log(`\n取色器验证：${passed}/${results.length} 通过`)

cdp.ws.close()
child.kill()
await new Promise((r) => setTimeout(r, 300))
rmSync(userDataDir, { recursive: true, force: true })
process.exit(passed === results.length ? 0 : 1)
