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
/** '#RRGGBB' → {r,g,b}，用于按通道断言"哪个方位是什么色相" */
const rgbOf = (hex) => {
  const c = String(hex).replace('#', '')
  return { r: parseInt(c.slice(0, 2), 16), g: parseInt(c.slice(2, 4), 16), b: parseInt(c.slice(4, 6), 16) }
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
  rowLabels: [...document.querySelectorAll('.cp-row')].filter((f) => f.style.display !== 'none').map((f) => f.querySelector('.cp-row-label').textContent),
  hexRowValue: (() => { const i = document.querySelector('.cp-hexrow .cp-num'); return i ? i.value : '' })(),
  swatchRows: document.querySelectorAll('.cp-swatch-row').length,
  fit: (() => {
    const cp = document.querySelector('.cp')
    const cs = getComputedStyle(cp)
    const box = cp.getBoundingClientRect()
    const innerW = box.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2
    const innerLeft = box.left + parseFloat(cs.paddingLeft) + 1
    const wheel = document.querySelector('.cp-wheel-wrap').getBoundingClientRect()
    const bar = document.querySelector('.cp-bar-wrap').getBoundingClientRect()
    return { innerW: Math.round(innerW), wheelLeft: Math.round(wheel.left - innerLeft), wheelW: Math.round(wheel.width), barRight: Math.round(bar.right - innerLeft) }
  })()
})`)
const S = JSON.parse(structure)
check('取色器结构：色轮 + 明度竖条 + Alpha 行 + RGB/HSV 两段 + 常驻 Hex 行 + 色板', () => {
  assert(S.railVisible > 100, `左侧栏没有布局宽度（${S.railVisible}）——视口太小会命中窄屏规则，取色器无法交互`)
  assert(S.hasPanel, '取色器面板未出现')
  assert(S.hasWheel && S.wheelSize > 100, `色轮缺失或过小：${S.wheelSize}`)
  assert(S.wheelSize === 156, `色轮应为 156px（按参考图比例校准：156+间隙6+明度条14=内容宽176），实际 ${S.wheelSize}`)
  assert(S.hasValueBar, '明度竖条缺失')
  assert(S.hasAlpha, 'Alpha 行缺失')
  assert(S.tabs.join(',') === 'RGB,HSV', `标签应为 RGB/HSV 两段（参考图没有 Hex 段，Hex 是常驻行），实际 ${S.tabs.join(',')}`)
  assert(S.rowLabels.join(',') === '红,绿,蓝,Alpha', `RGB 模式下应显示 红/绿/蓝/Alpha，实际 ${S.rowLabels.join(',')}`)
  assert(/^#[0-9A-F]{6}$/i.test(S.hexRowValue), `Hex 行应常驻并带 #RRGGBB，实际 ${S.hexRowValue}`)
  assert(S.swatchRows >= 2, `色板行数过少：${S.swatchRows}`)
  return `色轮 ${S.wheelSize}px / 标签 ${S.tabs.join('/')} / 行 ${S.rowLabels.join('/')}`
})

check('布局：色轮 + 明度条不溢出取色器内容盒', () => {
  const f = S.fit
  assert(f.wheelLeft >= -1, `色轮左边越出内容盒 ${f.wheelLeft}px（旧版溢出 38px 的回归守卫）`)
  assert(f.barRight <= f.innerW + 1, `明度条右边越出内容盒 ${f.barRight - f.innerW}px（旧版溢出 38px 的回归守卫）`)
  return `内容宽 ${f.innerW}：轮左 ${f.wheelLeft} + 轮 ${f.wheelW} + 间隙/明度条 ${f.innerW - f.wheelLeft - f.wheelW}`
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

/*
 * 方位断言按**参考图实测**的映射：色相 0°(红) 在色轮正下方、顺时针递增
 * （下 0° / 左 90° / 上 180° / 右 270°）。旧版是"0° 在正右"，与参考图差 90°。
 */
const bottomRaw = await dragWheel(0, 60) // 圆下方 → 色相 0°（红）
const bottomInfo = JSON.parse(bottomRaw)
check('色轮方位：正下方取到红色（色相 0°，参考图起点）', () => {
  assert(!bottomInfo.error, `拖动抛错：${bottomInfo.error}（pickerError: ${bottomInfo.pickerError}）`)
  assert(bottomInfo.afterDown && bottomInfo.afterMove && bottomInfo.afterUp, `拖动过程中面板消失：down=${bottomInfo.afterDown} move=${bottomInfo.afterMove} up=${bottomInfo.afterUp}`)
  const c = rgbOf(bottomInfo.primary)
  assert(c.r > c.g && c.r > c.b, `正下方应为偏红，实际 ${bottomInfo.primary}`)
  assert(c.g < c.r * 0.5 && c.b < c.r * 0.5, `正下方应是"纯红"那一档（G/B 远低于 R），实际 ${bottomInfo.primary}`)
  return `${bottomInfo.primary}（R 最大，G/B 低）`
})
const bottom = bottomInfo.primary

const leftRaw = await dragWheel(-60, 0) // 圆左方 → 色相 90°（绿）
const leftInfo = JSON.parse(leftRaw)
check('色轮方位：正左方取到绿色（色相 90°，顺时针递增）', () => {
  assert(!leftInfo.error, `拖动抛错：${leftInfo.error}`)
  const c = rgbOf(leftInfo.primary)
  assert(c.g > c.r && c.g > c.b, `正左方应为偏绿（色相 90°），实际 ${leftInfo.primary}`)
  assert(leftInfo.primary !== bottom, '不同角度必须得到不同颜色（说明角度→色相生效）')
  return `${leftInfo.primary}（G 最大）`
})

const topRaw = JSON.parse(await dragWheel(0, -60)) // 圆上方 → 色相 180°（青）
check('色轮方位：正上方取到青色（色相 180°）', () => {
  assert(!topRaw.error, `拖动抛错：${topRaw.error}`)
  const c = rgbOf(topRaw.primary)
  assert(c.g > c.r && c.b > c.r, `正上方应为偏青（色相 180°：G/B 高、R 低），实际 ${topRaw.primary}`)
  assert(topRaw.primary !== bottom, '不同角度必须得到不同颜色')
  return `${topRaw.primary}（G≈B 最大）`
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

// 模式标签：两段（RGB/HSV），切换后数值行换单位；Hex 行常驻不参与切换
const tabSwitch = await cdp.eval(`(() => {
  const tabs = [...document.querySelectorAll('.cp-tab')]
  const rows = () => [...document.querySelectorAll('.cp-row')].filter((f) => f.style.display !== 'none').map((f) => f.querySelector('.cp-row-label').textContent)
  tabs[1].click() // HSV
  const hsvRows = rows()
  const hsvValue = document.querySelector('.cp-row[data-row="S"] .cp-num').value
  const hexDuringHsv = document.querySelector('.cp-hexrow .cp-num').value
  tabs[0].click() // RGB
  const rgbRows = rows()
  return JSON.stringify({ tabs: tabs.map((t) => t.textContent), hsvRows, rgbRows, hsvValue, hexDuringHsv })
})()`)
check('模式标签：RGB / HSV 两段切换数值行，Hex 行常驻', () => {
  const t = JSON.parse(tabSwitch)
  assert(t.tabs.join(',') === 'RGB,HSV', `应只有 RGB/HSV 两段，实际 ${t.tabs.join(',')}`)
  assert(t.hsvRows.join(',') === '色相,饱和度,明度,Alpha', `HSV 段应显示 色相/饱和度/明度/Alpha，实际 ${t.hsvRows.join(',')}`)
  assert(t.rgbRows.join(',') === '红,绿,蓝,Alpha', `RGB 段应显示 红/绿/蓝/Alpha，实际 ${t.rgbRows.join(',')}`)
  assert(/^\d\.\d{3}$/.test(t.hsvValue), `HSV 数值应为 0-1 三位小数（参考图 0.800 格式），实际 ${t.hsvValue}`)
  assert(/^#[0-9A-F]{6}$/i.test(t.hexDuringHsv), `Hex 行应在 HSV 段下依然常驻，实际 ${t.hexDuringHsv}`)
  return `RGB→${t.rgbRows.join('/')} / HSV→${t.hsvRows.join('/')} / Hex 常驻 ${t.hexDuringHsv}`
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

// 整行滑条：蓝色填充宽度 = 数值占满量的比例（参考图实测 0.800 → 填充 80.7%），
// 数值为归一化 3 位小数。#FF6600 → R 100% / G 102÷255 = 40% / B 0%
const rowFills = await cdp.eval(`(() => {
  const fill = (key) => {
    const f = document.querySelector('.cp-row[data-row="' + key + '"] .cp-row-fill')
    return f ? Math.round(parseFloat(f.style.width)) : -1
  }
  const val = (key) => document.querySelector('.cp-row[data-row="' + key + '"] .cp-num').value
  return JSON.stringify({ R: fill('R'), G: fill('G'), B: fill('B'), rv: val('R'), gv: val('G'), bv: val('B') })
})()`)
check('数值行滑条：填充宽度 = 数值比例，数值为归一化 3 位小数', () => {
  const r = JSON.parse(rowFills)
  assert(r.R === 100, `R=255 应填满 100%，实际 ${r.R}%`)
  assert(Math.abs(r.G - 40) <= 1, `G=102/255 应填充约 40%，实际 ${r.G}%`)
  assert(r.B === 0, `B=0 应完全不填充，实际 ${r.B}%`)
  assert(r.rv === '1.000' && r.gv === '0.400' && r.bv === '0.000', `数值应为 1.000/0.400/0.000，实际 ${r.rv}/${r.gv}/${r.bv}`)
  return `#FF6600 → 填充 R ${r.R}% / G ${r.G}% / B ${r.B}%（数值 ${r.rv}/${r.gv}/${r.bv}）`
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

// Alpha 行：最左 = 透明色（0.000 / 填充 0%），拖回右侧 = 恢复实色
const alpha = await cdp.eval(`(() => {
  const row = document.querySelector('.cp-alpha')
  const rect = row.getBoundingClientRect()
  const mk = (type, x) => new PointerEvent(type, { clientX: x, clientY: rect.top + rect.height / 2, bubbles: true, pointerId: 3, button: 0, buttons: type === 'pointerup' ? 0 : 1 })
  // 落在左端死区内即视为"拖到最左"（亚像素取整让"精确 1px"不可达）
  const at = (frac) => rect.left + Math.max(1, rect.width * frac)
  const snap = () => ({
    transparent: window.pixelArtStudio.getInfo().eraserToAlpha,
    val: document.querySelector('.cp-alpha .cp-num').value,
    fill: Math.round(parseFloat(document.querySelector('.cp-alpha .cp-row-fill').style.width)),
  })
  row.dispatchEvent(mk('pointerdown', at(0.02)))
  window.dispatchEvent(mk('pointerup', at(0.02)))
  const left = snap()
  row.dispatchEvent(mk('pointerdown', at(0.9)))
  window.dispatchEvent(mk('pointerup', at(0.9)))
  const right = snap()
  return JSON.stringify({ left, right })
})()`)
check('Alpha 行：最左 = 透明色（0.000 / 填充 0%），拖回右侧 = 恢复实色', () => {
  const a = JSON.parse(alpha)
  assert(a.left.transparent === true, '拖到最左应进入透明绘制态')
  assert(a.left.val === '0.000' && a.left.fill === 0, `透明态应显示 0.000 且填充 0%，实际 ${a.left.val} / ${a.left.fill}%`)
  assert(a.right.transparent === false, '拖回右侧应恢复实色绘制')
  assert(a.right.val === '1.000' && a.right.fill === 100, `实色应显示 1.000 且填充 100%，实际 ${a.right.val} / ${a.right.fill}%`)
  return `左 ${a.left.val}(${a.left.fill}%) → 右 ${a.right.val}(${a.right.fill}%)`
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
