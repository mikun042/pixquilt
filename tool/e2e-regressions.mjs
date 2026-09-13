#!/usr/bin/env node
/**
 * 回归验证：把"隔壁 agent 测试报告"里确认修复的缺陷逐条锁住。
 *
 * 这些断言对应 2026-09-13 报告里的 P1-01 与 P2-01…P2-06，每条都是**真实缺陷**而不是设计选择，
 * 因此必须长期防回归（否则下次改 UI/历史栈时会被无声改回去）。
 *
 * 用 CDP 的 `Input.dispatchMouseEvent` / `dispatchKeyEvent` 走**真实输入**，
 * 因为其中几条（撤销、L 连线）只有在真实指针/键盘事件下才暴露。
 *
 * 用法：node tool/e2e-regressions.mjs [--app <html 路径>]
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
        const { resolve, reject, timer } = this.pending.get(m.id)
        this.pending.delete(m.id)
        clearTimeout(timer)
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

const results = []
/**
 * 断言收集器。
 * **必须 await 回调**：这些用例是 async（要发真实输入并等待），
 * 不 await 就会把 Promise 当结果、`String(promise)` 变成 "[object Promise]"，
 * 而且断言在后台抛错也不会被这里捕获——会变成"永久通过"的假测试。
 */
const check = async (name, fn) => {
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) })
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
const userDataDir = mkdtempSync(join(tmpdir(), 'regressions-'))
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await cdp.send('Runtime.enable')
await cdp.send('Page.enable')
// 桌面视口：窄屏规则会隐藏侧栏，导致取色器/参数面板无布局尺寸
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.navigate', { url: pathToFileURL(app).href })
for (let i = 0; i < 60; i++) {
  if (await cdp.eval('!!window.pixelArtStudio')) break
  await sleep(200)
}

const mouse = (type, x, y) =>
  cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })
const key = async (k, opts = {}) => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: opts.code ?? `Key${k.toUpperCase()}`, modifiers: opts.modifiers ?? 0 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: opts.code ?? `Key${k.toUpperCase()}`, modifiers: opts.modifiers ?? 0 })
}
const cellToScreen = async (cx, cy) => {
  const v = JSON.parse(await cdp.eval("document.getElementById('board').dataset.lastDraw"))
  const r = JSON.parse(await cdp.eval("JSON.stringify(document.getElementById('board').getBoundingClientRect())"))
  return { x: r.left + v.ox + (cx + 0.5) * v.cell, y: r.top + v.oy + (cy + 0.5) * v.cell }
}
const state = async () =>
  JSON.parse(await cdp.eval("JSON.stringify({ hash: window.pixelArtStudio.artHash(), palette: window.pixelArtStudio.getPalette() })"))

/* ---------------------------------------------- P1-01 自定义 / .hex 色板 UI */

await check('P1-01 自定义色板：选「自定义 / .hex」后出现输入区与导入按钮', async () => {
  await cdp.eval("window.pixelArtStudio.newCanvas({ width: 16, height: 16, color: '#ffffff' })")
  // 通过参数面板的下拉切到自定义模式（走真实 UI 路径）
  const switched = await cdp.eval(`(() => {
    const selects = [...document.querySelectorAll('#panel-params select')]
    const sel = selects.find((s) => [...s.options].some((o) => o.value === 'custom'))
    if (!sel) return 'no-select'
    sel.value = 'custom'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return 'ok'
  })()`)
  assert(switched === 'ok', `参数面板里找不到色板模式下拉：${switched}`)
  await sleep(250)
  const ui = JSON.parse(await cdp.eval(`JSON.stringify({
    textarea: !!document.querySelector('.hex-textarea'),
    importBtn: [...document.querySelectorAll('#panel-params button')].some((b) => b.textContent.includes('.hex')),
    fileAccept: [...document.querySelectorAll('#panel-params input[type=file]')].map((i) => i.accept).join(',')
  })`))
  assert(ui.textarea, '没有出现 .hex 输入框（textarea）')
  assert(ui.importBtn, '没有出现「导入 .hex 文件」按钮')
  assert(ui.fileAccept.includes('.hex'), `文件选择器未限定 .hex：${ui.fileAccept}`)
  return '输入框 + 导入按钮 + 文件类型齐全'
})

await check('P1-01 自定义色板：输入文字后参数被写入（不再静默忽略）', async () => {
  const r = JSON.parse(await cdp.eval(`(() => {
    const ta = document.querySelector('.hex-textarea')
    ta.value = '#ff0000\\n#00ff00\\n#0000ff'
    ta.dispatchEvent(new Event('change', { bubbles: true }))
    const p = window.pixelArtStudio.getParams()
    return JSON.stringify({ mode: p.paletteMode, custom: p.customPalette })
  })()`))
  assert(r.mode === 'custom', `模式应为 custom，实际 ${r.mode}`)
  assert(
    JSON.stringify(r.custom) === JSON.stringify(['#ff0000', '#00ff00', '#0000ff']),
    `params.customPalette 应被写入，实际 ${JSON.stringify(r.custom)}`,
  )
  // 这里不断言 getPalette()：没有原图时管线不会重转，画布仍是上一张的色板。
  // 色板是否真的按自定义生效，由下一条（有原图的路径）验证。
  return `params.customPalette = ${JSON.stringify(r.custom)}`
})

await check('P1-01 自定义色板：有原图时转换只使用自定义色板里的颜色', async () => {
  const r = JSON.parse(await cdp.eval(`(async () => {
    const ps = window.pixelArtStudio
    const c = document.createElement('canvas')
    c.width = 48; c.height = 32
    const ctx = c.getContext('2d')
    for (let y = 0; y < 32; y++) for (let x = 0; x < 48; x++) {
      ctx.fillStyle = 'rgb(' + Math.round(x * 5) + ',' + Math.round(y * 8) + ',128)'
      ctx.fillRect(x, y, 1, 1)
    }
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'))
    await ps.importImage(new File([blob], 'grad.png', { type: 'image/png' }))
    ps.setParams({ paletteMode: 'custom', customPalette: ['#ff0000', '#00ff00', '#0000ff'], longEdge: 24, lockPalette: true })
    await new Promise((res) => setTimeout(res, 250))
    return JSON.stringify({ palette: ps.getPalette(), mode: ps.getInfo().params.paletteMode })
  })()`))
  const allowed = new Set(['#ff0000', '#00ff00', '#0000ff'])
  assert(r.mode === 'custom', `模式应为 custom，实际 ${r.mode}`)
  assert(r.palette.length > 0, '转换后色板不应为空')
  assert(r.palette.every((c) => allowed.has(c)), `画布色板必须只包含自定义色板的颜色，实际 ${JSON.stringify(r.palette)}`)
  return `色板 = ${JSON.stringify(r.palette)}（全部来自自定义色板）`
})

await check('P1-01 导出菜单含「色板 .hex」（与 CLI/API 对齐）', async () => {
  await cdp.eval("document.getElementById('btn-export').click()")
  await sleep(200)
  const has = await cdp.eval("[...document.querySelectorAll('#export-menu .dropdown-item')].some((b) => b.textContent.includes('.hex'))")
  await cdp.eval("document.getElementById('btn-export').click()")
  assert(has, '导出菜单里没有色板 .hex 条目')
  return '导出菜单含 .hex'
})

/* ---------------------------------------------- P2-01 页内 API 键控透明 */

await check('P2-01 页内 API exportPNG({transparentBg}) 能产出透明像素', async () => {
  const r = JSON.parse(await cdp.eval(`(async () => {
    const ps = window.pixelArtStudio
    ps.newCanvas({ width: 16, height: 16, color: '#ffffff' })
    ps.setParams({ transparent: 'key', matteColor: '#ffffff' })
    const url = ps.exportPNG(1, { transparentBg: true })
    const img = new Image()
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url })
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let t = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] === 0) t++
    return JSON.stringify({ total: c.width * c.height, transparent: t })
  })()`))
  assert(r.transparent > 0, `API 键控导出应有透明像素，实际 ${r.transparent}/${r.total}（matteColor 兜底未生效？）`)
  return `${r.transparent}/${r.total} 透明像素`
})

/* ---------------------------------------------- P2-02 色板来源如实上报 */

await check('P2-02 空自定义色板时退回自动取色（不静默产出单色画布）', async () => {
  const r = JSON.parse(await cdp.eval(`(async () => {
    const ps = window.pixelArtStudio
    const c = document.createElement('canvas')
    c.width = 48; c.height = 32
    const ctx = c.getContext('2d')
    for (let y = 0; y < 32; y++) for (let x = 0; x < 48; x++) {
      ctx.fillStyle = 'rgb(' + Math.round(x * 5) + ',' + Math.round(y * 8) + ',128)'
      ctx.fillRect(x, y, 1, 1)
    }
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'))
    await ps.importImage(new File([blob], 'grad2.png', { type: 'image/png' }))
    ps.setParams({ paletteMode: 'custom', customPalette: [], longEdge: 24 })
    await new Promise((res) => setTimeout(res, 250))
    return JSON.stringify({ paletteSize: ps.getPalette().length, mode: ps.getInfo().params.paletteMode })
  })()`))
  // 空色板必须退回 Median Cut（否则整幅图会退化成单色）——core 的 paletteSource 也应如实报 auto
  assert(r.mode === 'custom', `参数模式仍是 custom，实际 ${r.mode}`)
  assert(r.paletteSize > 1, `空自定义色板应退回自动取色（多色），实际只得到 ${r.paletteSize} 色`)
  return `空色板 → 自动取色得到 ${r.paletteSize} 色`
})

/* ---------------------------------------------- P2-03 L 连线链式 */

await check('P2-03 按住 L 连点：第二次从上一线终点出发（链式，不是扇形）', async () => {
  await cdp.eval("window.pixelArtStudio.newCanvas({ width: 32, height: 32, color: '#000000' }); window.pixelArtStudio.setPrimary('#ff0000')")
  await sleep(300)
  // 起手一笔：(4,4) → (4,12)
  const a = await cellToScreen(4, 4)
  const b = await cellToScreen(4, 12)
  await mouse('mousePressed', a.x, a.y)
  await mouse('mouseMoved', b.x, b.y)
  await mouse('mouseReleased', b.x, b.y)
  await sleep(250)

  // 按住 L 点 (20,12)：期望横线 y=12
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'l', code: 'KeyL' })
  const c1 = await cellToScreen(20, 12)
  await mouse('mousePressed', c1.x, c1.y)
  await mouse('mouseReleased', c1.x, c1.y)
  await sleep(250)
  // 再按住 L 点 (20,20)：期望竖线 x=20（链式）；若从 (4,12) 出发则是斜线
  const c2 = await cellToScreen(20, 20)
  await mouse('mousePressed', c2.x, c2.y)
  await mouse('mouseReleased', c2.x, c2.y)
  await sleep(250)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'l', code: 'KeyL' })

  // 读像素判断短线形状：竖线在 x=20 上应有多格；斜线则每个 x 只落一格
  const probe = JSON.parse(await cdp.eval(`(() => {
    const p = window.pixelArtStudio.exportPixelJSON()
    const j = JSON.parse(p)
    const at = (x, y) => j.pixels[y * j.width + x]
    let colAt20 = 0
    for (let y = 0; y < j.height; y++) if (at(20, y)) colAt20++
    let rowAt12 = 0
    for (let x = 0; x < j.width; x++) if (at(x, 12)) rowAt12++
    return JSON.stringify({ colAt20, rowAt12, at_12_20: !!at(12, 20), at_4_20: !!at(4, 20) })
  })()`))
  assert(probe.rowAt12 >= 15, `第一条 L 线应是横线 y=12（实测该行 ${probe.rowAt12} 格）`)
  assert(probe.colAt20 >= 6, `第二条 L 线应是从 (20,12) 到 (20,20) 的竖线（实测 x=20 列只有 ${probe.colAt20} 格）`)
  return `横线 y=12 有 ${probe.rowAt12} 格；竖线 x=20 有 ${probe.colAt20} 格（链式正确）`
})

/* ---------------------------------------------- P2-04 状态栏实时化 */

await check('P2-04 状态栏实时反映选区格数/悬停坐标/缩放（不需额外重绘）', async () => {
  await cdp.eval("window.pixelArtStudio.newCanvas({ width: 32, height: 32, color: '#ffffff' }); window.pixelArtStudio.setTool('selection')")
  await sleep(300)
  const p1 = await cellToScreen(4, 4)
  const p2 = await cellToScreen(13, 9)
  await mouse('mousePressed', p1.x, p1.y)
  await mouse('mouseMoved', p2.x, p2.y)
  await mouse('mouseReleased', p2.x, p2.y)
  await sleep(300)
  const afterSelect = await cdp.eval("document.getElementById('statusbar').textContent")
  assert(/已选\s*60\s*格/.test(afterSelect), `框选 10×6 后状态栏应立即显示「已选 60 格」，实际：${afterSelect}`)

  // 悬停坐标
  const p3 = await cellToScreen(7, 7)
  await mouse('mouseMoved', p3.x, p3.y)
  await sleep(250)
  const afterHover = await cdp.eval("document.getElementById('statusbar').textContent")
  assert(/7,\s*7/.test(afterHover), `悬停后状态栏应显示坐标「7, 7」，实际：${afterHover}`)

  // 缩放
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p3.x, y: p3.y, deltaX: 0, deltaY: -120 })
  await sleep(300)
  const afterZoom = await cdp.eval("document.getElementById('statusbar').textContent")
  assert(/%/.test(afterZoom), `缩放后状态栏应有百分比，实际：${afterZoom}`)
  return `已选/坐标/缩放均即时更新`
})

/* ---------------------------------------------- P2-05 撤销完整还原色板 */

await check('P2-05 画笔后撤销：像素与色板、artHash 全部回到起点', async () => {
  await cdp.eval("window.pixelArtStudio.newCanvas({ width: 32, height: 32, color: '#000000' }); window.pixelArtStudio.setPrimary('#ff0000'); window.pixelArtStudio.setTool('pencil')")
  await sleep(300)
  const s0 = await state()
  const a = await cellToScreen(4, 4)
  const b = await cellToScreen(12, 4)
  await mouse('mousePressed', a.x, a.y)
  await mouse('mouseMoved', b.x, b.y)
  await mouse('mouseReleased', b.x, b.y)
  await sleep(300)
  const s1 = await state()
  assert(s1.palette.length > s0.palette.length, `落笔后色板应新增颜色：${JSON.stringify(s1.palette)}`)

  await key('z', { modifiers: 2, code: 'KeyZ' })
  await sleep(350)
  const u1 = await state()
  assert(u1.hash === s0.hash, `撤销后 artHash 应回到起点：${u1.hash} ≠ ${s0.hash}（色板 ${JSON.stringify(u1.palette)}）`)
  assert(JSON.stringify(u1.palette) === JSON.stringify(s0.palette), `撤销后色板应完全还原：${JSON.stringify(u1.palette)} ≠ ${JSON.stringify(s0.palette)}`)
  return `hash 与色板均还原（${u1.palette.length} 色）`
})

/* ---------------------------------------------- P2-06 窄屏抽屉 */

await check('P2-06 窄屏：侧栏收成抽屉且有开关可展开/收起', async () => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 700, height: 800, deviceScaleFactor: 1, mobile: false })
  await sleep(350)
  const r = JSON.parse(await cdp.eval(`(async () => {
    const btn = document.querySelector('[data-testid="drawer-tools"]')
    if (!btn) return JSON.stringify({ error: '没有抽屉开关' })
    const vis = btn.getBoundingClientRect().width > 0
    const rail = document.getElementById('rail-left')
    const before = getComputedStyle(rail).display
    btn.click()
    await new Promise((res) => setTimeout(res, 250))
    const opened = getComputedStyle(rail).display
    btn.click()
    await new Promise((res) => setTimeout(res, 250))
    return JSON.stringify({ vis, before, opened, closed: getComputedStyle(rail).display })
  })()`))
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(250)
  assert(!r.error, r.error)
  assert(r.vis, '窄屏下抽屉开关不可见')
  assert(r.before === 'none', `侧栏初始应收起，实际 ${r.before}`)
  assert(r.opened !== 'none', `点开关后应展开，实际 ${r.opened}`)
  assert(r.closed === 'none', `再点应收起，实际 ${r.closed}`)
  return `开关可点；收起 → ${r.opened} → ${r.closed}`
})

/* ---------------------------------------------- 审阅发现的幽灵引用 / 死代码 */

await check('幽灵引用：文档提到的页内 API 方法必须真的存在且可调用', async () => {
  const r = JSON.parse(await cdp.eval(`(async () => {
    const ps = window.pixelArtStudio
    const missing = ['render', 'renderBlank', 'newCanvas', 'edit', 'undo', 'redo'].filter((m) => typeof ps[m] !== 'function')
    if (missing.length) return JSON.stringify({ missing })
    // renderBlank 是无副作用一站式：建空白画布 → 跑算子 → 导出
    const out = await ps.renderBlank({ width: 24, height: 16, color: '#101820', ops: [{ op: 'rect', x0: 2, y0: 2, x1: 10, y1: 10, color: '#ff0000' }] }, { longEdge: 24 }, 2)
    const before = ps.getInfo().hasArt
    return JSON.stringify({
      missing,
      missingFields: ['width', 'height', 'palette', 'png', 'pixelJSON', 'changes', 'hash'].filter((k) => out[k] === undefined),
      w: out.width, h: out.height, changes: out.changes.length, pngOk: String(out.png).startsWith('data:image/png'),
      hasArtUnchanged: before,
    })
  })()`))
  assert(r.missing.length === 0, `文档承诺的方法缺失：${r.missing.join(', ')}`)
  assert(r.missingFields.length === 0, `renderBlank 返回缺字段：${r.missingFields.join(', ')}`)
  assert(r.w === 24 && r.h === 16, `renderBlank 尺寸应为 24×16，实际 ${r.w}×${r.h}`)
  assert(r.changes === 1, `应报告 1 条算子改动，实际 ${r.changes}`)
  assert(r.pngOk, 'renderBlank 未返回 PNG dataURL')
  return `renderBlank 可用（${r.w}×${r.h} / ${r.changes} 条改动）`
})

await check('getInfo().hasEdits 反映真实编辑状态（不再恒为 false）', async () => {
  const r = JSON.parse(await cdp.eval(`(async () => {
    const ps = window.pixelArtStudio
    await ps.renderBlank({ width: 16, height: 16, color: '#ffffff' })
    ps.newCanvas({ width: 16, height: 16, color: '#ffffff' })
    await new Promise((res) => setTimeout(res, 150))
    const fresh = ps.getInfo().hasEdits
    ps.edit([{ op: 'rect', x0: 1, y0: 1, x1: 5, y1: 5, color: '#ff0000' }])
    await new Promise((res) => setTimeout(res, 150))
    const edited = ps.getInfo().hasEdits
    ps.undo()
    await new Promise((res) => setTimeout(res, 150))
    return JSON.stringify({ fresh, edited, afterUndo: ps.getInfo().hasEdits })
  })()`))
  assert(r.fresh === false, `刚新建的画布 hasEdits 应为 false，实际 ${r.fresh}`)
  assert(r.edited === true, `编辑之后 hasEdits 必须为 true（曾恒为 false），实际 ${r.edited}`)
  return `新建 false → 编辑 true → 撤销 ${r.afterUndo}`
})

await check('CLI：不存在"接受了但没有任何效果"的 flag（--keep-size 已移除）', async () => {
  const { execFileSync } = await import('node:child_process')
  const out = execFileSync(process.execPath, ['tool/artc.mjs', '--help'], { encoding: 'utf8' })
  assert(!/keep-size/.test(out), '帮助文本里仍宣传 --keep-size（该 flag 无实现）')
  assert(!/browser-decode/.test(out), '帮助文本里仍宣传 --browser-decode（该 flag 无实现）')
  return '帮助文本只列已实现的参数'
})

/* ---------------------------------------------- 结果 */

const passed = results.filter((r) => r.ok).length
for (const r of results) console.log(` ${r.ok ? '✔' : '✘'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
console.log(`\n回归验证：${passed}/${results.length} 通过`)

cdp.ws.close()
child.kill()
await sleep(300)
rmSync(userDataDir, { recursive: true, force: true })
process.exit(passed === results.length ? 0 : 1)
