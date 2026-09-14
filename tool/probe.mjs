#!/usr/bin/env node
/**
 * 页面内跑 JS（可发真实鼠标/滚轮/移动）：改 UI / 排查交互时用。
 *   node .tmp/dom-probe.mjs "<js 表达式>"
 * 表达式里可用 document/window/getComputedStyle 等。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { argValue, hasFlag, startBrowser } from './cdp.mjs'
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const EXPR = process.argv[2] ?? '1'
/** 可选：先用**真实鼠标事件**（Input.dispatchMouseEvent）点某个选择器——合成 .click() 不经过命中测试，测不出"点不动" */
const CLICK = process.argv.includes('--click') ? process.argv[process.argv.indexOf('--click') + 1] : ''
const argOf = (k, d) => (process.argv.includes(`--${k}`) ? Number(process.argv[process.argv.indexOf(`--${k}`) + 1]) : d)
const VW = argOf('width', 1400)
const VH = argOf('height', 1200)
/** 可选：在某个选择器上发一次真实滚轮事件（deltaY 默认 200） */
const WHEEL = process.argv.includes('--wheel') ? process.argv[process.argv.indexOf('--wheel') + 1] : ''
const WHEEL_DY = argOf('dy', 200)
/** 可选：在某个选择器上发一次真实鼠标移动（悬停相关功能用） */
const MOVE = process.argv.includes('--move') ? process.argv[process.argv.indexOf('--move') + 1] : ''

async function main() {
  const app = join(ROOT, '像素画工作台.html')
  if (!existsSync(app)) throw new Error(`找不到 ${app}，先跑 npm run build`)
  // 共用 cdp.mjs：浏览器定位、启动参数、超时与临时 profile 清理都收在那里
  const session = await startBrowser({ profilePrefix: 'probe-' })
  const { cdp } = session
  try {
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false })
    await cdp.send('Page.navigate', { url: pathToFileURL(app).href })
    for (let i = 0; i < 60; i++) { if (await cdp.eval('!!window.pixelArtStudio')) break; await new Promise((r) => setTimeout(r, 200)) }
    await new Promise((r) => setTimeout(r, 300))

    // 预置动作（例如导入一张图）——**必须在 click/wheel/move 之前**，且不受 --click 约束
    // （早先误把它放进 if (CLICK) 里，于是"只给 --pre 不给 --click"时整块不跑）
    const preSrc = process.argv.includes('--pre') ? process.argv[process.argv.indexOf('--pre') + 1] : ''
    if (preSrc) {
      // 兼容两种写法：给一段表达式（如 `(async () => {...})()`），或给一个函数（如 `() => ...`）
      const preOut = await cdp.eval(
        `(async () => { const f = (${preSrc}); const v = await (typeof f === 'function' ? f() : f); return typeof v === 'string' ? v : JSON.stringify(v) })()`,
      )
      console.log(`  --pre 返回：${preOut}`)
      await new Promise((r) => setTimeout(r, 300))
    }

    if (CLICK) {
      // 真实用户会先把目标滚进视野——不滚的话坐标会落在视口外，点击必然落空（探针自己踩过）
      const box = await cdp.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(CLICK)})
        if (!el) return null
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        const x = r.left + r.width / 2, y = r.top + r.height / 2
        const top = document.elementFromPoint(x, y)
        return JSON.stringify({ x, y, w: Math.round(r.width), h: Math.round(r.height),
          inViewport: y >= 0 && y <= window.innerHeight && x >= 0 && x <= window.innerWidth,
          topTag: top ? top.tagName : '', topId: top ? top.id : '', topClass: top ? String(top.className) : '',
          hitSelf: top ? el.contains(top) || top === el : false })
      })()`)
      if (!box) throw new Error(`找不到 ${CLICK}`)
      const b = JSON.parse(box)
      console.log(`落点 (${Math.round(b.x)},${Math.round(b.y)}) 在视口内=${b.inViewport}；命中 <${b.topTag} id=${b.topId} class="${b.topClass}">，是目标自身=${b.hitSelf}`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 })
      await new Promise((r) => setTimeout(r, 400))
    }

    if (WHEEL) {
      const wb = JSON.parse(await cdp.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(WHEEL)})
        if (!el) return JSON.stringify({ error: '找不到 ' + ${JSON.stringify(WHEEL)} })
        const r = el.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(80, r.height / 2)) })
      })()`))
      if (wb.error) throw new Error(wb.error)
      console.log(`滚轮落点 (${wb.x},${wb.y}) deltaY=${WHEEL_DY}`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wb.x, y: wb.y, deltaX: 0, deltaY: WHEEL_DY })
      await new Promise((r) => setTimeout(r, 300))
    }

    if (MOVE) {
      const mb = JSON.parse(await cdp.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(MOVE)})
        if (!el) return JSON.stringify({ error: '找不到 ' + ${JSON.stringify(MOVE)} })
        const r = el.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
      })()`))
      if (mb.error) throw new Error(mb.error)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mb.x, y: mb.y })
      await new Promise((r) => setTimeout(r, 120))
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mb.x + 8, y: mb.y + 8 })
      await new Promise((r) => setTimeout(r, 300))
      console.log(`鼠标移动到 (${mb.x + 8},${mb.y + 8})`)
    }

    // 表达式同样兼容"表达式 / 函数"两种写法，并统一 await 后再序列化
    // （早期直接 JSON.stringify(表达式) 会把 Promise 序列化成 {}，踩过一次）
    const out = await cdp.eval(
      `(async () => { const f = (${EXPR}); const v = await (typeof f === 'function' ? f() : f); return typeof v === 'string' ? v : JSON.stringify(v) })()`,
    )
    console.log(out === undefined ? '(undefined)' : out)
  } finally {
    await session.close()
  }
}
main().catch((e) => { console.error(`失败：${e?.message ?? e}`); process.exit(1) })
