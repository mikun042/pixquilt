#!/usr/bin/env node
/**
 * 取色器专项端到端验证（Blender 结构：色轮 + 明度竖条 + 透明度横条 + RGB/HSV/Hex 标签 + 色板）。
 * 用真实无头浏览器 + 合成 PointerEvent 拖动，断言颜色确实按几何位置变化。
 */
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { createChecker, startBrowser } from './cdp.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const { check, assert, report } = createChecker('取色器验证')
/** '#RRGGBB' → {r,g,b}，用于按通道断言"哪个方位是什么色相" */
const rgbOf = (hex) => {
  const c = String(hex).replace('#', '')
  return { r: parseInt(c.slice(0, 2), 16), g: parseInt(c.slice(2, 4), 16), b: parseInt(c.slice(4, 6), 16) }
}

const session = await startBrowser({ profilePrefix: 'cp-e2e-' })
const { cdp } = session
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
  hasOpacityRow: !!document.querySelector('.cp-alpha'),
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
check('取色器结构：色轮 + 明度竖条 + 透明度行 + RGB/HSV 两段 + 常驻 Hex 行 + 色板', () => {
  assert(S.railVisible > 100, `左侧栏没有布局宽度（${S.railVisible}）——视口太小会命中窄屏规则，取色器无法交互`)
  assert(S.hasPanel, '取色器面板未出现')
  assert(S.hasWheel && S.wheelSize > 100, `色轮缺失或过小：${S.wheelSize}`)
  assert(S.wheelSize === 156, `色轮应为 156px（按参考图比例校准：156+间隙6+明度条14=内容宽176），实际 ${S.wheelSize}`)
  assert(S.hasValueBar, '明度竖条缺失')
  assert(S.hasOpacityRow, '透明度行缺失')
  assert(S.tabs.join(',') === 'RGB,HSV', `标签应为 RGB/HSV 两段（参考图没有 Hex 段，Hex 是常驻行），实际 ${S.tabs.join(',')}`)
  assert(S.rowLabels.join(',') === '红,绿,蓝,透明度', `RGB 模式下应显示 红/绿/蓝/透明度，实际 ${S.rowLabels.join(',')}`)
  assert(/^#[0-9A-F]{6}$/i.test(S.hexRowValue), `Hex 行应常驻并带 #RRGGBB，实际 ${S.hexRowValue}`)
  assert(S.swatchRows >= 2, `色板行数过少：${S.swatchRows}`)
  return `色轮 ${S.wheelSize}px / 标签 ${S.tabs.join('/')} / 行 ${S.rowLabels.join('/')}`
})

check('布局：色轮 + 明度条不溢出取色器内容盒', () => {
  const f = S.fit
  assert(f.wheelLeft >= -1, `色轮左边越出内容盒 ${f.wheelLeft}px（早期版本溢出 38px 的回归守卫）`)
  assert(f.barRight <= f.innerW + 1, `明度条右边越出内容盒 ${f.barRight - f.innerW}px（早期版本溢出 38px 的回归守卫）`)
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
 * （下 0° / 左 90° / 上 180° / 右 270°）。早期版本是"0° 在正右"，与参考图差 90°。
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
  assert(t.hsvRows.join(',') === '色相,饱和度,明度,透明度', `HSV 段应显示 色相/饱和度/明度/透明度，实际 ${t.hsvRows.join(',')}`)
  assert(t.rgbRows.join(',') === '红,绿,蓝,透明度', `RGB 段应显示 红/绿/蓝/透明度，实际 ${t.rgbRows.join(',')}`)
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

// 透明度行：整条滑条都要有响应——左半边 = 全透明（1.000 / 填充 0%），右半边 = 实色（0.000 / 填充 100%）。
// 拖动命中区是**滑条轨道**（.cp-row-track），不是整行——数值框在轨道之外，故意拖不到。
// 中段（0.35 / 0.65）是重点：旧实现只有最左 6% 算透明，拖中段毫无反应，被反馈成"这条滑条拖不动"。
const alpha = await cdp.eval(`(() => {
  const track = document.querySelector('.cp-alpha .cp-row-track')
  const rect = track.getBoundingClientRect()
  const mk = (type, x) => new PointerEvent(type, { clientX: x, clientY: rect.top + rect.height / 2, bubbles: true, pointerId: 3, button: 0, buttons: type === 'pointerup' ? 0 : 1 })
  const at = (frac) => rect.left + Math.max(1, rect.width * frac)
  const snap = () => ({
    transparent: window.pixelArtStudio.getInfo().eraserToAlpha,
    val: document.querySelector('.cp-alpha .cp-num').value,
    fill: Math.round(parseFloat(document.querySelector('.cp-alpha .cp-row-fill').style.width)),
  })
  const drag = (from, to) => {
    track.dispatchEvent(mk('pointerdown', at(from)))
    track.dispatchEvent(mk('pointermove', at(to)))
    const during = snap() // 松手**之前**的快照：验证拖动中就有实时反馈
    window.dispatchEvent(mk('pointerup', at(to)))
    return { during, after: snap() }
  }
  return JSON.stringify({ farLeft: drag(0.9, 0.02), farRight: drag(0.05, 0.9), midLeft: drag(0.9, 0.35), midRight: drag(0.05, 0.65) })
})()`)
check('透明度行：整条滑条都有响应——左半边 = 全透明 1.000，右半边 = 实色 0.000', () => {
  const a = JSON.parse(alpha)
  // 两端（数值口径是**透明度**：1.000 = 全透明，0.000 = 不透明）
  assert(a.farLeft.after.transparent === true, '拖到最左应进入透明绘制态')
  assert(a.farLeft.after.val === '1.000' && a.farLeft.after.fill === 0, `全透明应显示 1.000 且填充 0%，实际 ${a.farLeft.after.val} / ${a.farLeft.after.fill}%`)
  assert(a.farRight.after.transparent === false, '拖到最右应恢复实色绘制')
  assert(a.farRight.after.val === '0.000' && a.farRight.after.fill === 100, `实色应显示 0.000 且填充 100%，实际 ${a.farRight.after.val} / ${a.farRight.after.fill}%`)
  // 中段（旧实现的失效区）
  assert(a.midLeft.after.transparent === true, `拖到 0.35（中线左侧）应进入透明态，实际 transparent=${a.midLeft.after.transparent}`)
  assert(a.midRight.after.transparent === false, `拖到 0.65（中线右侧）应恢复实色，实际 transparent=${a.midRight.after.transparent}`)
  // 实时反馈：松手前填充就该翻，否则拖起来"没反应、松手才跳"
  assert(a.midLeft.during.transparent === true && a.midLeft.during.fill === 0, `向左拖的过程中就该全透明，实际 ${a.midLeft.during.val} / ${a.midLeft.during.fill}%`)
  assert(a.midRight.during.transparent === false && a.midRight.during.fill === 100, `向右拖的过程中就该恢复实色，实际 ${a.midRight.during.val} / ${a.midRight.during.fill}%`)
  return `两端 1.000↔0.000 正常；中段 0.35→${a.midLeft.after.val}、0.65→${a.midRight.after.val}，且拖动中即时翻转`
})

// 数值框必须完全落在滑条右侧：这是"输入数字时不会误触滑条"的结构保证
// 只量**可见行**（RGB 段下 H/S/V 是 display:none，rect 全 0，量不出东西）
const numOutside = await cdp.eval(`JSON.stringify(
  [...document.querySelectorAll('.cp-row')].map((row) => {
    const t = row.querySelector('.cp-row-track').getBoundingClientRect()
    if (!(t.width > 0)) return null
    const i = row.querySelector('.cp-num').getBoundingClientRect()
    return { row: row.dataset.row || row.querySelector('.cp-row-label').textContent, gap: Math.round(i.left - t.right) }
  }).filter(Boolean)
)`)
check('数值框在滑条右侧（与滑条轨道不重叠）', () => {
  const rows = JSON.parse(numOutside)
  assert(rows.length >= 4, `应至少有 红/绿/蓝/透明度 四个可见行，实际 ${rows.length}`)
  for (const r of rows) assert(r.gap >= 0, `行「${r.row}」的数值框与滑条重叠了 ${-r.gap}px`)
  return rows.map((r) => `${r.row} 间距 ${r.gap}px`).join(' / ')
})

// 在数值框上按下并拖动，滑条数值必须纹丝不动（点进数字框要进编辑态，不能改值）
const misTouch = await cdp.eval(`(() => {
  const ps = window.pixelArtStudio
  ps.setPrimary('#FF6600')
  const track = document.querySelector('.cp-alpha .cp-row-track')
  const tr = track.getBoundingClientRect()
  const mkA = (type, x) => new PointerEvent(type, { clientX: x, clientY: tr.top + tr.height / 2, bubbles: true, pointerId: 3, button: 0, buttons: type === 'pointerup' ? 0 : 1 })
  // 先拖到最左，进入透明态（若"点数字框"被滑条接走，点右侧会把它翻回实色，立刻看得出来）
  track.dispatchEvent(mkA('pointerdown', tr.left + 1))
  window.dispatchEvent(mkA('pointerup', tr.left + 1))
  const snapshot = () => ({
    fills: ['R', 'G', 'B'].map((k) => Math.round(parseFloat(document.querySelector('.cp-row[data-row="' + k + '"] .cp-row-fill').style.width))),
    alpha: ps.getInfo().eraserToAlpha,
    alphaVal: document.querySelector('.cp-alpha .cp-num').value,
  })
  const before = snapshot()
  // 在「绿」的数值框与透明度行的数值框上各按一次并拖动
  for (const sel of ['.cp-row[data-row="G"] .cp-num', '.cp-alpha .cp-num']) {
    const box = document.querySelector(sel)
    const r = box.getBoundingClientRect()
    const mk = (type, x) => new PointerEvent(type, { clientX: x, clientY: r.top + r.height / 2, bubbles: true, pointerId: 11, button: 0, buttons: type === 'pointerup' ? 0 : 1 })
    box.dispatchEvent(mk('pointerdown', r.left + 1))
    box.dispatchEvent(mk('pointermove', r.left + 1))
    box.dispatchEvent(mk('pointermove', r.right - 1))
    window.dispatchEvent(mk('pointerup', r.right - 1))
  }
  const after = snapshot()
  return JSON.stringify({ before, after })
})()`)
check('数值框不触发滑条：在数值框上按下/拖动，滑条值与状态都不变', () => {
  const m = JSON.parse(misTouch)
  assert(m.before.alpha === true, `前置条件：应先处于透明态，实际 ${m.before.alpha}`)
  assert(JSON.stringify(m.before) === JSON.stringify(m.after), `数值框上的操作改动了滑条：${JSON.stringify(m.before)} → ${JSON.stringify(m.after)}`)
  return `填充 ${m.before.fills.join('/')}%、透明度 ${m.before.alphaVal} 均未变`
})

// 拖动滑条不能选中沿途文字：用**真实鼠标事件**（CDP Input）按住扫过标签与数值框，
// 再看 window.getSelection()。合成 PointerEvent 测不出这个——文字选区只有真实输入才产生。
await cdp.eval(`window.pixelArtStudio.setPrimary('#336600')`) // R=0.200，拖到右端能看到变化
const sweep = JSON.parse(
  await cdp.eval(`(() => {
    const t = document.querySelector('.cp-row[data-row="R"] .cp-row-track').getBoundingClientRect()
    return JSON.stringify({ left: t.left, right: t.right, y: t.top + t.height / 2, before: document.querySelector('.cp-row[data-row="R"] .cp-num').value })
  })()`),
)
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sweep.left + 2, y: sweep.y, button: 'left', clickCount: 1, buttons: 1 })
for (const f of [0.2, 0.5, 0.8, 1.0]) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sweep.left + (sweep.right - sweep.left) * f, y: sweep.y, button: 'left', buttons: 1 })
}
// 再扫过右侧的数值框（选区最容易在这一带产生），然后松手
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sweep.right + 30, y: sweep.y, button: 'left', buttons: 1 })
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sweep.right + 30, y: sweep.y, button: 'left', buttons: 0 })
await new Promise((r) => setTimeout(r, 150))
const swept = JSON.parse(
  await cdp.eval(`(() => { const s = window.getSelection(); return JSON.stringify({ text: s ? s.toString() : '', after: document.querySelector('.cp-row[data-row="R"] .cp-num').value }) })()`),
)
check('拖动滑条不会选中沿途文字（user-select: none）', () => {
  assert(swept.text === '', `按住扫过时选中了文字：「${swept.text}」`)
  assert(swept.after !== sweep.before, `拖动本身应该生效：R ${sweep.before} → ${swept.after}`)
  return `真实鼠标扫过标签与数值框：选区为空，R ${sweep.before} → ${swept.after}`
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

/* -------------------------------- 收起 → 重新打开 */

/*
 * 用户报的 bug 的回归防线：「收起」之后必须还能把取色器打开。
 *
 * 根因回顾：`renderPickerPanel()` 收起时只写 `pickerHost?.remove()`，**没把变量置空**，
 * 于是重开时 `if (!pickerHost)` 判为假、走 else 分支，把取色器渲染进一个
 * **已脱离文档的容器**——`showPicker` 为 true、`querySelector('.cp')` 也查得到，
 * 但屏幕上什么都没有。所以这条断言**不看状态、不看 DOM，只看真实可见性**。
 */
{
  const clickSel = async (jsExpr) => {
    const pos = JSON.parse(
      await cdp.eval(`(() => {
        const e = ${jsExpr}
        if (!e) return JSON.stringify({ error: '找不到目标元素' })
        e.scrollIntoView({ block: 'center' })
        const r = e.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
      })()`),
    )
    if (pos.error) throw new Error(pos.error)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await new Promise((r) => setTimeout(r, 450))
  }

  /** 真实可见性：既有尺寸、又确实挂在色板列里 */
  const pickerState = () =>
    cdp.eval(`(() => {
      const cp = document.querySelector('#panel-palette .cp')
      const r = cp ? cp.getBoundingClientRect() : null
      return JSON.stringify({
        inDom: !!cp,
        visible: r ? r.width > 0 && r.height > 0 : false,
        inPalettePanel: cp ? !!cp.closest('#panel-palette') : false,
      })
    })()`)

  /*
   * ① 打开（点主色块）。
   *
   * ⚠️ 先把状态归零再点。色块自 2026-09-15 起是**开合开关**（点当前色块会收起取色器），
   * 而文件开头已经点过一次主色块把面板打开了——直接再点一下会把它**关掉**，
   * 于是第②步找不到「收起」按钮、抛"找不到目标元素"。
   * 不依赖"点一下就一定是打开"，而是显式把状态摆成"想看的样子"，断言才不会随交互
   * 语义的演进而误报（这里踩过一次：新交互本身是对的，错的是用例的前置假设）。
   */
  await cdp.eval("window.__app.store.set('showPicker', false)")
  await new Promise((r) => setTimeout(r, 150))
  await clickSel("document.querySelectorAll('.color-slot')[0]")
  const opened = JSON.parse(await pickerState())
  // ② 收起
  await clickSel("[...document.querySelectorAll('#panel-palette .btn')].find((b) => b.textContent.includes('收起'))")
  const closed = JSON.parse(await pickerState())
  // ③ 再打开 —— 这一步在 bug 存在时会「状态对但看不见」
  await clickSel("document.querySelectorAll('.color-slot')[0]")
  const reopened = JSON.parse(await pickerState())

  check('「收起」之后必须还能重新打开取色器（收起→重开循环）', () => {
    assert(opened.visible, `前置：点主色块应能打开取色器，实际 ${JSON.stringify(opened)}`)
    assert(!closed.inDom, `收起后取色器应从 DOM 移除，实际 ${JSON.stringify(closed)}`)
    assert(
      reopened.visible && reopened.inPalettePanel,
      `收起后再点主色块，取色器必须重新可见（曾是"状态置上了、DOM 里也有，但渲染进了已脱离文档的容器"→ 看不到）` +
        `；实际 ${JSON.stringify(reopened)}`,
    )
    return `打开(可见) → 收起(移除) → 重开(可见且挂回色板列)`
  })
}

await session.close()
report()
