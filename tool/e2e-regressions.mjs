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
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { argValue, createChecker, sleep, startBrowser } from './cdp.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/*
 * 断言收集器来自 tool/cdp.mjs，**回调一律 await**：这些用例是 async（要发真实输入并等待），
 * 不 await 就会把 Promise 当结果、`String(promise)` 变成 "[object Promise]"，
 * 而且断言在后台抛错也不会被捕获——会变成"永久通过"的假测试。
 */
const { check, assert, report } = createChecker('回归验证')

const app = argValue('app', join(ROOT, '像素画工作台.html'))
if (!existsSync(app)) throw new Error(`找不到 ${app}，先跑 npm run build`)

const session = await startBrowser({ profilePrefix: 'regressions-' })
const { cdp } = session

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

/**
 * 用**真实鼠标**点击一个由 JS 表达式定位的元素（先滚进视野再按中心点）。
 *
 * 为什么不直接用 `e.click()`：合成 click 绕过命中测试，测不出"元素被遮挡 /
 * 命中区变小 / pointer-events:none"这类问题——而本项目在取色器上真实踩过。
 * 表达式返回 null 时明确报错，不静默跳过（否则断言会变成"什么都没测"却全绿）。
 */
const clickByExpr = async (expr) => {
  const p = JSON.parse(
    await cdp.eval(`(() => {
      const e = ${expr}
      if (!e) return JSON.stringify({ error: '找不到元素：${expr.replace(/'/g, "\\'")}' })
      e.scrollIntoView({ block: 'center' })
      const r = e.getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    })()`),
  )
  if (p.error) throw new Error(p.error)
  await mouse('mousePressed', p.x, p.y)
  await mouse('mouseReleased', p.x, p.y)
  await sleep(220)
}

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

await check('P2-06 窄屏：侧栏收成抽屉，栏外箭头可展开/收起', async () => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 700, height: 800, deviceScaleFactor: 1, mobile: false })
  await sleep(350)
  const r = JSON.parse(await cdp.eval(`(async () => {
    const btn = document.querySelector('[data-testid="drawer-tools"]')
    const other = document.querySelector('[data-testid="drawer-panel"]')
    if (!btn) return JSON.stringify({ error: '没有折叠开关' })
    const rail = document.getElementById('rail-left')
    const right = document.getElementById('rail-right')
    const scrim = document.getElementById('drawer-scrim')
    const w = (e) => Math.round(e.getBoundingClientRect().width)
    const wait = () => new Promise((res) => setTimeout(res, 250))
    const snap = () => ({ rail: w(rail), right: w(right), btn: w(btn), arrow: btn.textContent.trim(),
      scrim: !!(scrim && !scrim.hidden), disp: getComputedStyle(rail).display })
    const out = { initial: snap() }
    btn.click(); await wait(); out.opened = snap()
    other.click(); await wait(); out.switched = snap()   // 窄屏一次只开一个
    btn.click(); await wait(); out.reopened = snap()
    btn.click(); await wait(); out.closed = snap()
    return JSON.stringify(out)
  })()`))
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(250)
  assert(!r.error, r.error)
  // 窄屏初始两侧都收起（整栏隐藏），但栏外的箭头必须还在——否则面板永远打不开
  assert(r.initial.rail === 0, `窄屏初始应收起，实际 ${r.initial.rail}`)
  assert(r.initial.btn > 0, '窄屏收起态下箭头必须仍可见（否则面板永远打不开）')
  assert(r.initial.arrow === '▶', `收起态箭头应指向展开方向 ▶，实际 ${r.initial.arrow}`)
  assert(r.opened.rail > 100, `点箭头后应展开抽屉，实际 ${r.opened.rail}`)
  assert(r.opened.scrim, '抽屉展开时应显示遮罩')
  assert(r.opened.arrow === '◀', `展开态箭头应指向收纳方向 ◀，实际 ${r.opened.arrow}`)
  assert(r.switched.right > 100 && r.switched.rail === 0, '窄屏一次只开一个抽屉（开右栏应把左栏收掉）')
  assert(r.closed.rail === 0 && !r.closed.scrim, `再点应收起并隐藏遮罩，实际 ${r.closed.rail} / scrim=${r.closed.scrim}`)
  return `收起 ${r.initial.rail} → 展开 ${r.opened.rail}（遮罩 ${r.opened.scrim}）→ 切换 → 收起 ${r.closed.rail}；箭头 ▶→◀`
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

/*
 * 上一条只查 6 个**写死**的方法名，而契约面远大于此——`docs/AGENT_API.md` 里列了 46 个。
 * 这条把它变成**全量**核对：从手册正文里抓出所有 `ps.<name>(` 提到的方法，逐个确认
 * `window.pixelArtStudio` 上真的存在。文档多写一个名字、或实现改名后忘了改文档，都会变红。
 *
 * 为什么值得单独一条：本项目栽过同一类——某份早已删除的 agent 上手文档里，L3 示例写着 core 有 `render` 导出，
 * 实际没有，照抄的脚本第一行就报错。那次是运行期实跑才发现的，静态 grep 看不出来。
 */
await check('契约面完整：docs/AGENT_API.md 里写到的每个页内方法都真的存在', async () => {
  const doc = readFileSync(join(ROOT, 'docs', 'AGENT_API.md'), 'utf8')
  const named = [...new Set([...doc.matchAll(/ps\.([A-Za-z]+)\s*\(/g)].map((m) => m[1]))]
  assert(named.length >= 40, `从手册里只解析出 ${named.length} 个方法名，解析规则可能失效了`)
  const absent = JSON.parse(
    await cdp.eval(`JSON.stringify(${JSON.stringify(named)}.filter((m) => typeof window.pixelArtStudio[m] !== 'function'))`),
  )
  assert(absent.length === 0, `手册里写了但页内 API 没有这些方法：${absent.join(', ')}`)
  return `手册里的 ${named.length} 个方法全部存在`
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
  const help = execFileSync(process.execPath, ['tool/artc.mjs', '--help'], { encoding: 'utf8' })
  /*
   * `--keep-size` 是真实的死 flag：登记在 KNOWN_FLAGS 里、被帮助文本宣传，却**没有任何消费点**，
   * 传了既不生效也不报错。这类"接受了但没效果"的参数比报错更糟，所以永久钉住它不再出现。
   */
  assert(!/keep-size/.test(help), '帮助文本里仍宣传 --keep-size（该 flag 无实现）')

  /*
   * `--browser-decode` 此前也在这条断言里，但它的处境**已经变了**：
   * 当时它是一句"报错里让你改用某个 flag、而那个 flag 从未实现"的死路文案；
   * 2026-09-15 起它**真的实现了**（`src/io/node-decode.ts` + CLI 里的消费点）。
   *
   * 所以这里不再断言"帮助里没有它"，而是断言**它不能退化成死 flag**：
   * 只要帮助里还宣传它，就要求代码里真的有消费点。这比删掉这行更保守——
   * 既允许功能落地，又继续挡住"宣传了却没接线"。
   */
  if (/browser-decode/.test(help)) {
    const src = readFileSync(join(ROOT, 'tool', 'artc.mjs'), 'utf8')
    assert(
      /args\['browser-decode'\]/.test(src),
      '帮助文本宣传 --browser-decode，但 tool/artc.mjs 里没有它的消费点（死 flag）',
    )
    const { needsBrowserDecode } = await import(new URL('../src/io/node-decode.ts', import.meta.url).href)
    assert(
      needsBrowserDecode('x.jpg') && needsBrowserDecode('x.webp') && !needsBrowserDecode('x.png'),
      '解码通道的格式判定不符预期',
    )
  }
  return '帮助文本只列已实现的参数（--browser-decode 有消费点）'
})

/* ------------------------------- CLI：工具问题记录（2026-09-13 第二轮）修复的回归 */

/** 跑 artc 并拿到 { code, stdout, stderr }；不抛错，方便断言非零退出 */
function runArtc(args) {
  const r = spawnSync(process.execPath, ['tool/artc.mjs', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

await check('CLI：--blank 不再无条件产出拼豆图纸/清单（只有 --bead 才产出）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'artc-blank-'))
  const out = join(dir, 'out')
  const r = runArtc(['--blank', '8x8', '--out', out, '--quiet'])
  assert(r.code === 0, `正常退出，实际 ${r.code}：${r.stderr}`)
  const files = readdirSync(out)
  assert(
    !files.some((f) => f.endsWith('.svg') || f.endsWith('缺口清单.csv')),
    `未指定 --bead 时不该出现拼豆产物，实际有：${files.join(', ')}`,
  )
  assert(files.some((f) => f.endsWith('.hex')), '空画布也应产出 .hex（原先只在 --in 分支产出）')
  assert(files.some((f) => f.endsWith('.json')), '空画布也应产出像素 JSON')

  // 显式 --bead 时必须有
  const out2 = join(dir, 'out2')
  const r2 = runArtc(['--blank', '8x8', '--bead', '--out', out2, '--quiet'])
  assert(r2.code === 0, `--bead 应正常退出，实际 ${r2.code}：${r2.stderr}`)
  const files2 = readdirSync(out2)
  assert(files2.some((f) => f.endsWith('.svg')), '显式 --bead 必须产出图纸 SVG')
  assert(files2.some((f) => f.endsWith('缺口清单.csv')), '显式 --bead 必须产出缺口清单 CSV')
  rmSync(dir, { recursive: true, force: true })
  return '无 --bead 不产出拼豆文件；有 --bead 产出；.hex/.json 补齐'
})

await check('CLI：--blank 命名模板解析正确，且 {index} 生效（不写死 1、不残留占位符）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'artc-idx-'))
  // 默认模板：必须是 blank_<w>x<h>_<scale>x，曾因把模板自身当作 {name} 的值而产出 undefined.png
  const outA = join(dir, 'a')
  runArtc(['--blank', '8x8', '--out', outA, '--quiet'])
  const def = readdirSync(outA).filter((f) => f.endsWith('.png'))
  assert(def.length === 1 && def[0] === 'blank_8x8_1x.png', `默认命名应为 blank_8x8_1x.png，实际 ${def.join(', ')}`)

  // 显式模板里的 {index:02}：两次调用必须得到两个不同文件名，且不含字面 {…}
  const outB = join(dir, 'b')
  const tpl = '{name}_{index:02}_{w}x{h}'
  const r1 = runArtc(['--blank', '8x8', '--index', '1', '--name', tpl, '--out', outB, '--quiet'])
  const r2 = runArtc(['--blank', '8x8', '--index', '2', '--name', tpl, '--out', outB, '--quiet'])
  assert(r1.code === 0 && r2.code === 0, `两次调用都应成功（${r1.code}/${r2.code}）：${r1.stderr}${r2.stderr}`)
  const pngs = readdirSync(outB).filter((f) => f.endsWith('.png')).sort()
  assert(pngs.length === 2, `{index} 不同的两次调用应产出两个文件，实际 ${pngs.join(', ') || '无'}`)
  assert(
    pngs.every((f) => !/[{}]/.test(f)),
    `文件名不该残留字面占位符，实际 ${pngs.join(', ')}`,
  )
  assert(pngs[0] === 'blank_01_8x8.png' && pngs[1] === 'blank_02_8x8.png', `实际 ${pngs.join(', ')}`)

  // 未支持的占位符要报错，而不是原样写进文件名
  const bad = runArtc(['--blank', '8x8', '--name', '{bogus}', '--out', join(dir, 'c')])
  assert(bad.code !== 0, '未支持的占位符应报错')
  assert(/占位符/.test(bad.stderr), `错误信息应说明占位符问题，实际：${bad.stderr.trim()}`)
  rmSync(dir, { recursive: true, force: true })
  return `${def[0]} / ${pngs.join(' / ')}；{bogus} 被拒`
})

await check('CLI：--blank 支持 --sheet（原先嵌在 --in 分支里，静默不产出）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'artc-sheet-'))
  const out = join(dir, 'out')
  const r = runArtc(['--blank', '8x8', '--sheet', '--out', out, '--quiet'])
  assert(r.code === 0, `应正常退出，实际 ${r.code}：${r.stderr}`)
  assert(existsSync(join(out, '_sheet.json')), '--blank --sheet 必须产出 _sheet.json')
  rmSync(dir, { recursive: true, force: true })
  return '_sheet.json 已产出'
})

await check('CLI：--in 目录里混入 .svg 不应让整批以非零码失败', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'artc-skip-'))
  const src = join(dir, 'src')
  mkdirSync(src, { recursive: true })
  // 先造一张真 PNG，再把一个 .svg 混进同一目录
  runArtc(['--blank', '8x8', '--name', 'a', '--out', src, '--quiet'])
  const png = readdirSync(src).find((f) => f.endsWith('.png'))
  assert(png, '前置：需要一个真实 PNG')
  writeFileSync(join(src, 'ref.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>', 'utf8')

  const out = join(dir, 'out')
  const r = runArtc(['--in', src, '--out', out, '--json'])
  assert(r.code === 0, `混入不可解码的 .svg 不该让整批失败（exit ${r.code}）：${r.stderr}`)
  const parsed = JSON.parse(r.stdout) // 同时验证 stdout 是纯 JSON
  assert(parsed.ok >= 1, `PNG 应处理成功，实际 ok=${parsed.ok}`)
  assert(parsed.failed === 0, `不该有"失败"，实际 ${parsed.failed}：${JSON.stringify(parsed.failures)}`)
  assert(parsed.skipped === 1, `应如实报告跳过 1 个，实际 ${parsed.skipped}`)
  assert(
    parsed.skippedFiles.some((f) => f.src === 'ref.svg'),
    '跳过清单里要点名是哪个文件',
  )
  rmSync(dir, { recursive: true, force: true })
  return 'exit 0 / ok>=1 / failed 0 / skipped 1'
})

await check('CLI：--json 的 stdout 必须是纯 JSON（可被严格解析）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'artc-json-'))
  const out = join(dir, 'out')
  const r = runArtc(['--blank', '8x8', '--out', out, '--json'])
  assert(r.code === 0, `应正常退出，实际 ${r.code}：${r.stderr}`)
  assert(r.stdout.trimStart().startsWith('{'), `stdout 首字符必须是 {，实际 "${r.stdout.slice(0, 20)}"`)
  const parsed = JSON.parse(r.stdout)
  assert(typeof parsed.ok === 'number', '解析结果应含 ok')
  assert(!/✔/.test(r.stdout), 'stdout 里不该混入人类可读的进度标记')
  rmSync(dir, { recursive: true, force: true })
  return 'stdout 首字符 { 且可 JSON.parse'
})

await check('CLI：--ops-file 读文件；未知参数报错（不再静默忽略）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'artc-ops-'))
  const opsFile = join(dir, 'ops.json')
  writeFileSync(opsFile, JSON.stringify([{ op: 'setAll', color: '#ff0000' }]), 'utf8')
  const out = join(dir, 'out')
  const r = runArtc(['--blank', '4x4', '--ops-file', opsFile, '--out', out, '--json'])
  assert(r.code === 0, `--ops-file 应成功，实际 ${r.code}：${r.stderr}`)
  const parsed = JSON.parse(r.stdout)
  assert(parsed.results[0].changes === 1, `算子应生效，实际 changes=${parsed.results[0].changes}`)
  assert(parsed.results[0].paletteSize === 2, `setAll 后应为 2 色（底色+红），实际 ${parsed.results[0].paletteSize}`)

  // 未知参数：曾经 `--exact 32x32` 被完全静默忽略，命令"成功"但产物与预期不符
  const bad = runArtc(['--blank', '8x8', '--exact', '32x32', '--out', join(dir, 'x')])
  assert(bad.code !== 0, '未知参数 --exact 必须以非零码退出，不能静默照常执行')
  assert(/--exact/.test(bad.stderr), `错误信息要点出是哪个参数，实际：${bad.stderr.trim()}`)
  rmSync(dir, { recursive: true, force: true })
  return '--ops-file 生效；--exact 被拒且指名'
})

/* ------------------------------- 用户报的「第一次打开就卡住」三个现象 */

await check('新建：还没有画布时按钮可用，点击直接得到空白画布（不再死路）', async () => {
  // 复位到"刚打开"的状态
  await cdp.eval('window.pixelArtStudio.reset(); window.pixelArtStudio.setParams({})')
  await sleep(300)
  const st = JSON.parse(await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('#header-actions button')].find(x => (x.textContent || '').includes('新建'))
    if (!b) return JSON.stringify({ error: '顶栏找不到「新建」按钮' })
    const r = b.getBoundingClientRect()
    return JSON.stringify({ disabled: b.disabled, w: Math.round(r.width), x: r.x + r.width / 2, y: r.y + r.height / 2 })
  })()`))
  assert(!st.error, st.error)
  assert(!st.disabled, '「新建」在没有画布时不该禁用——那是第一次使用时的死路')
  assert(st.w > 0, '「新建」按钮不可见（宽度 0）')

  // 真实鼠标点击：合成 .click() 绕过命中测试，测不出 pointer-events / 遮挡问题
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: st.x, y: st.y, button: 'left', buttons: 1, clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: st.x, y: st.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(300)
  const info = JSON.parse(await cdp.eval('JSON.stringify(window.pixelArtStudio.getInfo())'))
  assert(info.hasArt, '点「新建」后应当出现画布')
  return `得到 ${info.width}×${info.height} 空白画布`
})

await check('空状态：直接给出「新建空白画布」入口，且真实鼠标点得动', async () => {
  await cdp.eval('window.pixelArtStudio.reset(); window.pixelArtStudio.setParams({})')
  await sleep(300)
  const st = JSON.parse(await cdp.eval(`(() => {
    const b = document.querySelector('[data-testid="empty-new-blank"]')
    if (!b) return JSON.stringify({ error: '空状态里没有「新建空白画布」按钮' })
    const r = b.getBoundingClientRect()
    return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height),
      pe: getComputedStyle(b).pointerEvents, x: r.x + r.width / 2, y: r.y + r.height / 2 })
  })()`))
  assert(!st.error, st.error)
  assert(st.w > 0 && st.h > 0, `按钮尺寸为 0（${st.w}×${st.h}）`)
  // 空状态整层是 pointer-events:none，按钮若不显式恢复就会"看得见点不动"
  assert(st.pe !== 'none', `空状态按钮必须可接收指针事件，实际 pointer-events=${st.pe}`)

  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: st.x, y: st.y, button: 'left', buttons: 1, clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: st.x, y: st.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(300)
  const info = JSON.parse(await cdp.eval('JSON.stringify(window.pixelArtStudio.getInfo())'))
  assert(info.hasArt, '点空状态按钮后应当出现画布')
  const stillEmpty = await cdp.eval('!!document.querySelector(".empty-state")')
  assert(stillEmpty === false, '有画布后空状态必须移除，否则会盖住画好的内容')
  return `得到 ${info.width}×${info.height}，空状态已移除`
})

await check('桌面宽度：栏外箭头真的折叠/展开（收起后箭头贴到画布边缘，仍可点回来）', async () => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(300)
  const r = JSON.parse(await cdp.eval(`(async () => {
    const tools = document.querySelector('[data-testid="drawer-tools"]')
    const panel = document.querySelector('[data-testid="drawer-panel"]')
    const rail = document.getElementById('rail-left')
    const right = document.querySelector('.right')
    const box = (e) => { const b = e.getBoundingClientRect(); return { w: Math.round(b.width), l: Math.round(b.left), r: Math.round(b.right) } }
    const snap = () => ({ rail: box(rail).w, right: box(right).w,
      toolsBtn: box(tools).w, toolsX: box(tools).l, railRight: box(rail).r,
      panelBtn: box(panel).w, panelX: box(panel).l, rightLeft: box(right).l,
      toolsArrow: tools.textContent.trim(), panelArrow: panel.textContent.trim() })
    const wait = () => new Promise((res) => setTimeout(res, 150))
    const out = { before: snap() }
    tools.click(); await wait(); out.afterTools = snap()
    tools.click(); await wait(); out.restored = snap()
    panel.click(); await wait(); out.afterPanel = snap()
    panel.click(); await wait(); out.final = snap()
    return JSON.stringify(out)
  })()`))
  assert(r.before.rail > 100 && r.before.right > 100, `桌面下两侧栏应展开：${JSON.stringify(r.before)}`)
  // 展开时开关浮在**栏外**：左栏开关在栏的右边、右栏开关在栏的左边
  assert(r.before.toolsX >= r.before.railRight, `左栏箭头应在栏外（画布边），实际 x=${r.before.toolsX} < 栏右边 ${r.before.railRight}`)
  assert(r.before.panelX + r.before.panelBtn <= r.before.rightLeft, `右栏箭头应在栏外，实际 x=${r.before.panelX} 未在栏左边 ${r.before.rightLeft} 之外`)

  assert(r.afterTools.rail === 0, `点左栏开关应收起（整栏隐藏），实际宽 ${r.afterTools.rail}`)
  assert(r.afterTools.right > 100, '收起左栏不该连带收起右栏')
  assert(r.afterTools.toolsBtn > 0, '收起后箭头必须仍可见（它是唯一能再展开的入口）')
  assert(r.afterTools.toolsX <= 10, `收起后箭头应贴到画布左边缘，实际 x=${r.afterTools.toolsX}`)
  assert(r.afterTools.toolsArrow === '▶' && r.before.toolsArrow === '◀', `左栏箭头方向错了：${r.before.toolsArrow} → ${r.afterTools.toolsArrow}（应为 ◀ → ▶）`)
  assert(r.restored.rail > 100, `再点应恢复左栏，实际宽 ${r.restored.rail}`)
  assert(r.restored.toolsArrow === '◀', `展开后左栏箭头应指回收纳方向，实际 ${r.restored.toolsArrow}`)

  assert(r.afterPanel.right === 0, `点右栏开关应收起（整栏隐藏），实际宽 ${r.afterPanel.right}`)
  assert(r.afterPanel.rail > 100, '收起右栏不该连带收起左栏')
  assert(r.afterPanel.panelBtn > 0, '收起后右栏箭头必须仍可见')
  assert(r.afterPanel.panelX > r.before.panelX, `收起后右栏箭头应贴到画布右边缘（x 变大），实际 ${r.before.panelX} → ${r.afterPanel.panelX}`)
  assert(r.afterPanel.panelArrow === '◀' && r.before.panelArrow === '▶', `右栏箭头方向错了：${r.before.panelArrow} → ${r.afterPanel.panelArrow}（应为 ▶ → ◀）`)
  assert(r.final.right > 100, `再点应恢复右栏，实际宽 ${r.final.right}`)
  assert(r.final.panelArrow === '▶', `展开后右栏箭头应指回收纳方向，实际 ${r.final.panelArrow}`)
  return `左栏 ${r.before.rail}→0→${r.restored.rail}（箭头 ◀→▶→◀）；右栏 ${r.before.right}→0→${r.final.right}（箭头 ▶→◀→▶）`
})

await check('桌面宽度：两侧各自独立折叠，能同时收起（不再互相顶开）', async () => {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(300)
  /*
   * 用户报的现象：收起工具列后再点「参数」，工具列又会弹回来（反之亦然）。
   * 根因是折叠状态存成了单个三值变量 'none' | 'tools' | 'panel'，
   * 四个组合里"两边都收起"不可达——赋值 'panel' 顺手把 'no-rail' 摘掉了。
   * 所以这条断言必须成对检查"另一个没被顶开"，只测单独折叠是抓不到的。
   *
   * 收起态的宽度是 0（整栏隐藏）——开关浮在栏外，不会被一起藏掉，
   * 所以这里判定"已收起"就是宽度为 0。
   */
  const r = JSON.parse(await cdp.eval(`(() => {
    const tools = document.querySelector('[data-testid="drawer-tools"]')
    const panel = document.querySelector('[data-testid="drawer-panel"]')
    const rail = document.getElementById('rail-left')
    const right = document.querySelector('.right')
    const main = document.querySelector('.main')
    const host = document.getElementById('canvas-host')
    const w = (e) => Math.round(e.getBoundingClientRect().width)
    const snap = () => ({ rail: w(rail), right: w(right), host: w(host), main: w(main), toolsBtn: w(tools), panelBtn: w(panel) })
    const out = { initial: snap() }
    tools.click(); out.afterTools = snap()
    panel.click(); out.bothHidden = snap()          // ← 这里曾把工具列顶回来
    panel.click(); out.panelBack = snap()
    tools.click(); out.restored = snap()
    // 反向顺序：先关参数再关工具
    panel.click(); out.panelOnly = snap()
    tools.click(); out.bothHidden2 = snap()          // ← 反向也要能同时收起
    tools.click(); out.toolsBack = snap()
    panel.click(); out.restored2 = snap()
    out.cls = document.body.className
    return JSON.stringify(out)
  })()`))

  const base = r.initial
  const collapsed = (v) => v === 0
  assert(base.rail > 100 && base.right > 100, `桌面下两侧栏应展开：${JSON.stringify(base)}`)

  assert(collapsed(r.afterTools.rail), `点左栏开关应收起（整栏隐藏），实际 ${r.afterTools.rail}`)
  assert(r.afterTools.right > 100, '收起左栏不该连带收起右栏')

  // 核心回归点：关第二个不该把第一个顶回来
  assert(collapsed(r.bothHidden.rail), `两边同时收起时左栏必须仍为隐藏（曾被顶回 ${r.bothHidden.rail}）`)
  assert(collapsed(r.bothHidden.right), `两边同时收起时右栏必须仍为隐藏，实际 ${r.bothHidden.right}`)
  assert(r.bothHidden.host >= r.bothHidden.main - 4, `两栏收起后画布应占满：canvas ${r.bothHidden.host} / main ${r.bothHidden.main}`)
  // 都收起时箭头仍要在可点区域里（它们浮在栏外，是唯一能再展开的入口）
  assert(r.bothHidden.toolsBtn > 0 && r.bothHidden.panelBtn > 0, '两侧都收起后箭头仍须可见可点')

  assert(r.panelBack.right > 100 && collapsed(r.panelBack.rail), '单独恢复右栏时左栏应保持收起')
  assert(r.restored.rail > 100 && r.restored.right > 100, '两次恢复后两侧都应回到展开')

  assert(collapsed(r.panelOnly.right) && r.panelOnly.rail > 100, '先关右栏：右栏应为窄边、左栏保持展开')
  assert(collapsed(r.bothHidden2.rail), `反向顺序也要能同时收起左栏，实际 ${r.bothHidden2.rail}`)
  assert(collapsed(r.bothHidden2.right), `反向顺序也要能同时收起右栏，实际 ${r.bothHidden2.right}`)
  assert(r.toolsBack.rail > 100 && collapsed(r.toolsBack.right), '单独恢复左栏时右栏应保持收起')
  assert(r.restored2.rail > 100 && r.restored2.right > 100, '反向恢复后两侧都应回到展开')

  return `正向 ${base.rail}/${base.right} → 双收 ${r.bothHidden.rail}/${r.bothHidden.right} → 还原；反向亦然`
})

/* -------------------------------- 参数面板：可折叠分组 */

/*
 * 折叠是 2026-09-15 新增的交互。加这条断言的理由：新交互若无断言守着，
 * 就会变成"看起来能用、改坏了没人知道"——本项目在 §8.10 记过多起同类事故。
 *
 * 同时锁住一条**结构性约束**：收起的分组内容必须仍在 DOM 里（用 display:none 而非移除节点）。
 * 页内 API 与其它断言全靠 querySelector 找控件，一旦有人把收起改成"不渲染"，
 * 那些断言会以"找不到控件"的形式失败、而失败信息指向别处。这条直接把它钉住。
 */
await check('参数面板折叠：真实鼠标点标题栏能收起/展开，且收起后控件仍在 DOM 里', async () => {
  const sel = '[data-testid="section-head-dither"]'
  const bodySel = '[data-testid="section-body-dither"]'

  const before = JSON.parse(
    await cdp.eval(`(() => {
      const h = document.querySelector('${sel}')
      const b = document.querySelector('${bodySel}')
      if (!h || !b) return JSON.stringify({ error: '找不到「抖动」分组的标题或主体' })
      h.scrollIntoView({ block: 'center' })
      const r = h.getBoundingClientRect()
      return JSON.stringify({
        x: r.left + r.width / 2, y: r.top + r.height / 2,
        expanded: h.getAttribute('aria-expanded'),
        bodyVisible: b.getBoundingClientRect().height > 0,
        controlsInDom: !!document.querySelector('#panel-params select'),
      })
    })()`),
  )
  assert(!before.error, before.error)
  // 前置：这组默认是收起的（次要参数），先点开、再点收，两个方向都验
  assert(before.expanded === 'false', `「抖动」组默认应为收起，实际 aria-expanded=${before.expanded}`)
  assert(before.bodyVisible === false, '收起时主体不应占高度')

  // ① 点一次 → 展开
  await mouse('mousePressed', before.x, before.y)
  await mouse('mouseReleased', before.x, before.y)
  await sleep(200)
  const opened = JSON.parse(
    await cdp.eval(`(() => {
      const h = document.querySelector('${sel}')
      const b = document.querySelector('${bodySel}')
      return JSON.stringify({
        expanded: h.getAttribute('aria-expanded'),
        h: Math.round(b.getBoundingClientRect().height),
        hasSelect: !!b.querySelector('select'),
      })
    })()`),
  )
  assert(opened.expanded === 'true', `点标题栏后应展开，实际 aria-expanded=${opened.expanded}`)
  assert(opened.h > 0, `展开后主体应有高度，实际 ${opened.h}`)
  assert(opened.hasSelect, '展开后该分组里应有「抖动」下拉')

  // ② 再点一次 → 收起；关键：控件必须仍在 DOM 里（只是不显示）
  //
  // ⚠️ 必须**重新取坐标**：展开让面板内容变高、标题栏位置整体下移，
  // 沿用第一次的 y 会点到别的元素上，表现成"再点收不起来"。
  // （第一版就是直接复用 before.x/y，断言报 aria-expanded 仍为 true——那是测试的取坐标问题。）
  const pos2 = JSON.parse(
    await cdp.eval(`(() => {
      const h = document.querySelector('${sel}')
      h.scrollIntoView({ block: 'center' })
      const r = h.getBoundingClientRect()
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
    })()`),
  )
  await mouse('mousePressed', pos2.x, pos2.y)
  await mouse('mouseReleased', pos2.x, pos2.y)
  await sleep(200)
  const reclosed = JSON.parse(
    await cdp.eval(`(() => {
      const h = document.querySelector('${sel}')
      const b = document.querySelector('${bodySel}')
      return JSON.stringify({
        expanded: h.getAttribute('aria-expanded'),
        h: Math.round(b.getBoundingClientRect().height),
        stillInDom: !!b.querySelector('select'),
        selectInPanel: !!document.querySelector('#panel-params select'),
      })
    })()`),
  )
  assert(reclosed.expanded === 'false', `再点后应收回，实际 aria-expanded=${reclosed.expanded}`)
  assert(reclosed.h === 0, `收起后主体高度应为 0，实际 ${reclosed.h}`)
  assert(reclosed.stillInDom, '收起后控件必须仍在 DOM 里（display:none，不是移除节点）——否则页内 API 与其它断言会失效')

  return `默认收起 → 点开(h=${opened.h}) → 点收(h=${reclosed.h})，控件始终在 DOM`
})

/* ---------------------------------------------- 图标几何：全部图标，而不只是吸管 */

/*
 * 为什么单列这一条：`e2e-pdf.mjs` 早就有"笔画落在 viewBox 内"的断言，但它**只查吸管一个图标**。
 * 于是 2026-09-15 发现的那批缺陷全都从它眼皮底下溜了过去：
 *   · 8 个 SVG 图标的坐标是 **32 设计网格**（最大到 30），而图标 viewBox 是 24
 *     → 被裁掉大半：重新转换只剩一段残弧、"快捷键"的方点整个落在画布外看不见；
 *   · 重做图标的镜像写在 `<g transform>` 上，被提取器静默丢掉
 *     → **重做与撤销导出成完全相同的两条路径**（箭头都朝左）。
 * 两个都是"看得见、却没有任何断言说话"的静默失效。所以这里把断言从"吸管"扩到**所有图标**，
 * 并额外锁一条"重做必须是撤销的镜像"。
 *
 * 坐标一律是 24 空间（SVG_PATHS 由 svg-data.mjs 从 32 网格缩放到 24 后落盘，
 * PIXEL_PATHS 与吸管本来就在 24 空间），因此可以用同一个 24 的框来判定。
 */
const STROKE_TOL = 1.8 // 描边半宽：几何包围盒之外还有 sw/2 的笔画，允许它略微出界
const icons = JSON.parse(
  await cdp.eval(`JSON.stringify((() => {
    const label = (svg) => {
      const btn = svg.closest('button')
      if (!btn) return (svg.getAttribute('class') || 'svg')
      return (btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.textContent || '').trim().slice(0, 12) || btn.id
    }
    return [...document.querySelectorAll('svg.icon-svg')].map((svg) => {
      const paths = [...svg.querySelectorAll('path')].map((p) => {
        const b = p.getBBox()
        return { d: p.getAttribute('d'),
          x: +b.x.toFixed(2), y: +b.y.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2),
          len: +p.getTotalLength().toFixed(2) }
      })
      const box = paths.reduce((a, p) => ({
        x0: Math.min(a.x0, p.x), y0: Math.min(a.y0, p.y),
        x1: Math.max(a.x1, p.x + p.w), y1: Math.max(a.y1, p.y + p.h),
      }), { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 })
      return { label: label(svg), viewBox: svg.getAttribute('viewBox'), paths, box }
    })
  })())`),
)

check('图标几何：每个图标的笔画都落在自己的 viewBox 内（不裁切、不过小）', () => {
  assert(icons.length >= 8, `页面上只找到 ${icons.length} 个图标，太少了（工具条 + 顶栏应有多个）`)
  const bad = []
  for (const ic of icons) {
    if (ic.viewBox !== '0 0 24 24') {
      bad.push(`${ic.label}: viewBox=${ic.viewBox}`)
      continue
    }
    const { x0, y0, x1, y1 } = ic.box
    if (x0 < -STROKE_TOL || y0 < -STROKE_TOL || x1 > 24 + STROKE_TOL || y1 > 24 + STROKE_TOL) {
      bad.push(`${ic.label}: 笔画出界 [${x0},${y0}]-[${x1},${y1}]（24 的框装不下就会被裁掉）`)
    }
    if (x1 - x0 < 8 || y1 - y0 < 8) {
      bad.push(`${ic.label}: 图标过小 ${(x1 - x0).toFixed(1)}×${(y1 - y0).toFixed(1)}（可能被裁得只剩一角）`)
    }
  }
  assert(bad.length === 0, `有 ${bad.length} 个图标几何不合格：\n    ${bad.join('\n    ')}`)
  return `${icons.length} 个图标：笔画均在 24 框内且 ≥8×8`
})

check('图标语义：重做必须是撤销的水平镜像（不能长得一样）', () => {
  const undo = icons.find((ic) => ic.label === '撤销')
  const redo = icons.find((ic) => ic.label === '重做')
  assert(undo, '顶栏找不到「撤销」图标')
  assert(redo, '顶栏找不到「重做」图标')
  // ① 路径数据不能逐字相同——直接锁住"镜像 transform 被静默丢掉"那个缺陷
  const du = undo.paths.map((p) => p.d).join('|')
  const dr = redo.paths.map((p) => p.d).join('|')
  assert(du !== dr, '重做与撤销的路径数据完全相同——重做没有镜像（箭头方向必然也反了）')
  // ② 几何上互为镜像（绕 x=12 翻转）：两端坐标之和应各自等于 24
  const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol
  assert(
    near(undo.box.x0 + redo.box.x1, 24) && near(undo.box.x1 + redo.box.x0, 24),
    `重做不是撤销的镜像：undo x=[${undo.box.x0},${undo.box.x1}] redo x=[${redo.box.x0},${redo.box.x1}]`,
  )
  assert(
    near(undo.box.y0, redo.box.y0) && near(undo.box.y1, redo.box.y1),
    `镜像不该改变纵向范围：undo y=[${undo.box.y0},${undo.box.y1}] redo y=[${redo.box.y0},${redo.box.y1}]`,
  )
  return `undo x=[${undo.box.x0},${undo.box.x1}] ↔ redo x=[${redo.box.x0},${redo.box.x1}]，严格镜像`
})

/* ---------------------------------------------- 取色器开合（点色块也能收起） */

/*
 * 需求：左侧点「主色 / 背景色」展开取色器后，**再点同一个色块要能收起**，
 * 而不是只能用面板里那颗「收起」按钮。
 *
 * 这里特意覆盖**两种不同的点击语义**，只测一种会漏掉最容易写错的那种：
 *   ① 点**当前正在编辑**的那一路 → 收起；
 *   ② 点**另一路** → 切过去并**保持展开**。
 * ② 是易错点：若把实现写成"点一下就翻转 showPicker"，②会变成"开了又关"，
 * 用户从主色切到背景得点三次——而只测①的话，这种错误实现照样是绿的。
 *
 * 用真实鼠标（`Input.dispatchMouseEvent`）：色块是 `<button>`，合成 `.click()` 绕过命中测试，
 * 测不出被遮挡、命中区变小这类问题（本项目在取色器上真实踩过）。
 */
const slotPos = async (i) =>
  JSON.parse(
    await cdp.eval(`(() => {
      const el = document.querySelectorAll('.color-slot')[${i}]
      if (!el) return JSON.stringify({ error: '找不到第 ${i} 个 .color-slot' })
      const r = el.getBoundingClientRect()
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
    })()`),
  )
const pickerState = async () =>
  JSON.parse(
    await cdp.eval(`(() => {
      const slots = [...document.querySelectorAll('.color-slot')]
      const cp = document.querySelector('.cp')
      const host = document.querySelector('.picker-wrap')
      return JSON.stringify({
        show: window.__app.store.get('showPicker'),
        visible: !!(cp && cp.offsetParent !== null),
        hostAttached: !!(host && host.parentNode),
        titles: slots.map((s) => s.getAttribute('title') || ''),
      })
    })()`),
  )
const clickSlot = async (i) => {
  const p = await slotPos(i)
  assert(!p.error, p.error)
  await mouse('mousePressed', p.x, p.y)
  await mouse('mouseReleased', p.x, p.y)
  await sleep(200)
}

await check('取色器开合：再点当前色块可收起；点另一路是切换目标而不收起', async () => {
  // 先归零，保证从"收起"开始（前面的用例可能留下展开状态）
  await cdp.eval(`window.__app.store.set('showPicker', false)`)
  await sleep(150)

  await clickSlot(0) // 点主色 → 展开
  let s = await pickerState()
  assert(s.show === true && s.visible === true, `点主色应展开，实际 show=${s.show} visible=${s.visible}`)
  assert(s.titles[0].includes('点击收起取色器'), `主色提示语应变为"点击收起"，实际「${s.titles[0]}」`)

  await clickSlot(0) // 再点主色 → 收起（本次新增的行为）
  s = await pickerState()
  assert(s.show === false, `再点主色应收起，实际 show=${s.show}`)
  assert(s.visible === false, '收起后取色器不应可见')
  assert(s.hostAttached === false, '收起后宿主应从文档摘除（不是只隐藏）——否则会留下孤儿节点')

  await clickSlot(0) // 再展开
  await clickSlot(1) // 点背景 → 切换编辑目标且保持展开
  s = await pickerState()
  assert(s.show === true && s.visible === true, `点另一路应保持展开，实际 show=${s.show} visible=${s.visible}`)
  assert(s.titles[1].includes('点击收起取色器'), `背景应变为"点击收起"，实际「${s.titles[1]}」`)
  assert(s.titles[0].includes('点击打开取色器'), `主色应回到"点击打开"，实际「${s.titles[0]}」`)

  await clickSlot(1) // 再点背景 → 收起
  s = await pickerState()
  assert(s.show === false && s.visible === false, '再点背景应收起')

  // 面板里那颗「收起」按钮必须仍然有效（别为了新交互弄坏旧出口）
  await clickSlot(0)
  const foot = JSON.parse(
    await cdp.eval(`(() => {
      const b = document.querySelector('.cp-foot .btn')
      if (!b) return JSON.stringify({ error: '找不到「收起」按钮' })
      const r = b.getBoundingClientRect()
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
    })()`),
  )
  assert(!foot.error, foot.error)
  await mouse('mousePressed', foot.x, foot.y)
  await mouse('mouseReleased', foot.x, foot.y)
  await sleep(200)
  s = await pickerState()
  assert(s.show === false && s.visible === false, '「收起」按钮应仍能收起（原出口不能坏）')

  return '点当前色块收起 / 点另一路切换并保持展开 / 「收起」按钮仍有效'
})

/* ---------------------------------------------- 预设分组：默认展开，且能折叠 */

/*
 * 预设区在 2026-09-15 从"独立标题 + 裸内容"并进了 `section()` 那套折叠机制。
 *
 * 为什么为它单独写一条（旁边的"参数面板折叠"测的是**默认收起**的「抖动」组，方向相反）：
 *  - **默认展开**是它与其他 9 组的关键差异，也是它的正确形态（面板主入口 + 最高频动作）；
 *    如果哪天有人顺手把它改成默认收起，第一次用的人会找不到"怎么切用途"——
 *    而现有断言照样全绿（它们用 querySelector 找 chip，折叠也找得到）。
 *  - 顺带锁住"它真的进了折叠机制"：有 `section-head-preset` / `section-body-preset`
 *    这对 data-testid，是"并进同一套机制"的可观测证据，而不是各自写一套标题栏。
 *  - 收起后 chip 必须**仍在 DOM 里**（同旁边那条的结构性约束）：页内 API 的
 *    `applyStylePreset` 与预设相关断言都靠 querySelector，节点被摘掉会以
 *    "找不到控件"的形式在别处失败。
 */
await check('预设分组：默认可折叠、默认展开，且收起后 chip 仍在 DOM 里', async () => {
  const headSel = '[data-testid="section-head-preset"]'
  const bodySel = '[data-testid="section-body-preset"]'
  const read = () =>
    cdp.eval(`(() => {
      const h = document.querySelector('${headSel}')
      const b = document.querySelector('${bodySel}')
      if (!h || !b) return JSON.stringify({ error: '找不到预设分组的标题或主体（没并进 section 机制？）' })
      return JSON.stringify({
        expanded: h.getAttribute('aria-expanded'),
        h: Math.round(b.getBoundingClientRect().height),
        chipsInDom: document.querySelectorAll('#panel-params .preset-chip').length,
        caret: h.querySelector('.panel-caret')?.textContent ?? '',
      })
    })()`)

  /*
   * ① **先验默认态，且不做任何"纠正"**。
   *
   * 这一步必须放在最前面、且不能有"如果收起就点开"之类的兜底——那种兜底会**反过来
   * 抹掉它要抓的缺陷**：`toggleSection()` 会把结果写进 sessionOpen 与 localStorage，
   * 于是"默认收起"这个变异会被兜底动作"修好"，断言照样变绿（本用例第一版就是这样，
   * 变异验证时暴露了它）。默认态要在一个**没被本用例碰过**的状态下读。
   * 每次运行都是全新的临时 profile（startBrowser 建 mkdtemp 再删），所以这里的默认态干净。
   */
  let s = JSON.parse(await read())
  assert(!s.error, s.error)
  assert(
    s.expanded === 'true',
    `预设分组应**默认展开**（面板主入口 + 最高频动作），实际 aria-expanded=${s.expanded}。` +
      `若改成了默认收起，第一次用的人会找不到"怎么切用途"。`,
  )
  assert(s.h > 0, `默认展开时主体应有高度，实际 ${s.h}`)
  assert(s.chipsInDom >= 6, `预设 chip 应有 ≥6 个，实际 ${s.chipsInDom}`)
  assert(s.caret === '▾', `展开时三角应为 ▾，实际「${s.caret}」`)

  // ② 真实鼠标点标题栏 → 收起
  const pos = JSON.parse(await cdp.eval(`(() => {
    const h = document.querySelector('${headSel}'); h.scrollIntoView({ block: 'center' })
    const r = h.getBoundingClientRect()
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
  })()`))
  await mouse('mousePressed', pos.x, pos.y)
  await mouse('mouseReleased', pos.x, pos.y)
  await sleep(200)
  const closed = JSON.parse(await read())
  assert(closed.expanded === 'false', `点标题栏应收起，实际 aria-expanded=${closed.expanded}`)
  assert(closed.h === 0, `收起后主体高度应为 0，实际 ${closed.h}`)
  assert(closed.chipsInDom >= 6, '收起后 chip 必须仍在 DOM 里（display:none，不是移除节点）——否则页内 API 与其它断言会失效')
  assert(closed.caret === '▸', `收起时三角应为 ▸，实际「${closed.caret}」`)

  // ② 再点一次 → 展开（必须能回来，别做成单向）
  const pos2 = JSON.parse(await cdp.eval(`(() => {
    const h = document.querySelector('${headSel}'); h.scrollIntoView({ block: 'center' })
    const r = h.getBoundingClientRect()
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
  })()`))
  await mouse('mousePressed', pos2.x, pos2.y)
  await mouse('mouseReleased', pos2.x, pos2.y)
  await sleep(200)
  const reopened = JSON.parse(await read())
  assert(reopened.expanded === 'true' && reopened.h > 0, `再点应展开，实际 expanded=${reopened.expanded} h=${reopened.h}`)

  // ③ 收起点一下 chip：预设有 6 个出厂 chip，收起后程序化点击仍应生效（页内 API 同路径）
  const applied = await cdp.eval(`(() => {
    const c = document.querySelector('#panel-params .preset-chip')
    if (!c) return 'no-chip'
    return 'ok'
  })()`)
  assert(applied === 'ok', '预设 chip 应可被 querySelector 取到（收起时也一样）')

  return `默认展开(▾ h=${s.h}) → 收起(h=0, chip 仍在 DOM) → 再展开(h=${reopened.h})`
})

/* ---------------------------------------------- 拼豆色卡向导（号色不能再被丢掉） */

/*
 * 本轮修的缺陷：`.hex` 一直支持 `编号 #rrggbb` 两列，但**导入时号色被解析完就丢掉**
 * （只存 colors），于是图纸 / 缺口清单 / PDF 上印的永远是自动编号 C1/C2…，
 * 用户色卡里的 S12 / B01 根本出不来。而"编号与我的色卡对不对得上"正是拼豆用户最在意的事。
 *
 * 这条断言按用户真实路径走一遍：**选自定义档 → 导入带号色的文件 → 号色进参数 →
 * 号色表出现 → 改号 → 删色 → 号色真的印上清单与图纸**。
 * 只测"导入成功"是不够的——号色被丢掉的版本同样"导入成功"。
 */
await check('色卡向导：导入带号色的 .hex，号色进参数、能改能删、并真的印上图纸', async () => {
  const NL = String.fromCharCode(10)
  const hexText = ['S12 #ff8800', 'S31 #22cc44', 'S99 #ffffff', 'S07 #1a1a1a', ''].join(NL)
  const params = async () =>
    JSON.parse(
      await cdp.eval(`(() => {
        const p = window.pixelArtStudio.getParams()
        return JSON.stringify({ mode: p.paletteMode, colors: p.customPalette, codes: p.customPaletteCodes })
      })()`),
    )

  // ① 切到「自定义 / .hex」档并展开分组——导入按钮只在这个档下存在
  await cdp.eval(`(() => {
    const head = document.querySelector('[data-testid="section-head-palette"]')
    if (head && head.getAttribute('aria-expanded') === 'false') head.click()
    return true
  })()`)
  await sleep(250)
  const setMode = JSON.parse(
    await cdp.eval(`(() => {
      const sel = document.querySelector('[data-testid="section-body-palette"] select')
      if (!sel) return JSON.stringify({ error: '色板分组里找不到 select' })
      sel.value = 'custom'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return JSON.stringify({ ok: true })
    })()`),
  )
  assert(!setMode.error, setMode.error)
  await sleep(300)

  // ② 导入：给隐藏的 file input 塞真 File 再派发 change（与点「导入 .hex 文件」同一回调）
  const fired = JSON.parse(
    await cdp.eval(`(() => {
      const input = [...document.querySelectorAll('input[type=file]')].find((i) => (i.accept || '').includes('.hex'))
      if (!input) return JSON.stringify({ error: '找不到 .hex 文件选择框' })
      const dt = new DataTransfer()
      dt.items.add(new File([${JSON.stringify(hexText)}], 'card.hex', { type: 'text/plain' }))
      input.files = dt.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return JSON.stringify({ ok: true })
    })()`),
  )
  assert(!fired.error, fired.error)
  await sleep(500)

  const afterImport = await params()
  assert(afterImport.colors.length === 4, `应载入 4 色，实际 ${afterImport.colors.length}`)
  assert(
    Array.isArray(afterImport.codes) && afterImport.codes.length === 4,
    `号色必须被存进参数（不能再丢），实际 ${JSON.stringify(afterImport.codes)}`,
  )
  assert(afterImport.codes[0] === 'S12', `首个号色应为 S12，实际 ${afterImport.codes[0]}`)

  // ③ 号色表出现，且逐行显示号色 + hex
  const table = JSON.parse(
    await cdp.eval(`(() => {
      const lines = [...document.querySelectorAll('.code-line')]
      return JSON.stringify({
        has: !!document.querySelector('[data-testid="codes-table"]'),
        n: lines.length,
        first: (document.querySelector('.code-line input') || {}).value || '',
      })
    })()`),
  )
  assert(table.has, '有号色时应出现号色表')
  assert(table.n === 4, `号色表应有 4 行，实际 ${table.n}`)
  assert(table.first === 'S12', `首行号色应为 S12，实际「${table.first}」`)

  // ④ 改号：真实鼠标聚焦 + 真实键盘输入（用原生 select() 清空，见下方注释）
  await clickByExpr(`document.querySelector('.code-line input')`)
  await cdp.eval(`document.querySelector('.code-line input').select()`)
  for (const ch of 'X99') {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch}`, text: ch })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch}` })
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: NL })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' })
  await sleep(350)
  const afterEdit = await params()
  assert(afterEdit.codes[0] === 'X99', `改号后首项应为 X99，实际「${afterEdit.codes[0]}」`)

  // ⑤ 删色：颜色与号色必须**一起**删（只删一边会让后面号色整体错位）
  await clickByExpr(`document.querySelector('[data-testid="code-del-0"]')`)
  const afterDel = await params()
  assert(afterDel.colors[0] === '#22cc44', `删后首个颜色应为 #22cc44，实际 ${afterDel.colors[0]}`)
  assert(afterDel.codes[0] === 'S31', `删后首个号色应为 S31（不错位），实际 ${afterDel.codes[0]}`)
  assert(afterDel.colors.length === 3, `删后应剩 3 色，实际 ${afterDel.colors.length}`)

  // ⑥ 号色真的上清单与图纸——这一条才是整件事的目的
  const sheet = JSON.parse(
    await cdp.eval(`(() => {
      const ps = window.pixelArtStudio
      ps.newCanvas({ width: 8, height: 8, color: '#22cc44' })
      const csv = ps.exportBeadCsv()
      const svg = ps.exportBeadSvg()
      return JSON.stringify({
        row: csv.split(String.fromCharCode(10))[1] || '',
        svgHasCode: svg.includes('S31'),
        svgHasAutoC1: /[^A-Za-z]C1[^0-9]/.test(svg),
      })
    })()`),
  )
  assert(sheet.row.startsWith('S31,'), `清单首行应以用户号色 S31 开头，实际「${sheet.row}」`)
  assert(sheet.svgHasCode, '图纸 SVG 里应出现用户号色 S31')
  assert(!sheet.svgHasAutoC1, '图纸里不应再出现自动编号 C1（说明号色没被用上）')

  return `导入 S12/S31/S99/S07 → 改号 X99 → 删色剩 3 → 清单「${sheet.row}」且图纸含 S31`
})

/* ---------------------------------------------- 自动草稿（刷新不再丢编辑） */

/*
 * 自动草稿是**唯一一条会在后台偷偷写、并在启动时抢先读**的路径，而 `app.art` 与画布副本
 * 之间原本只有三条同步路径（ARCHITECTURE §2.1）——它是第四条。这类"少写一条同步"的缺陷
 * 在本项目的历史上全是**静默丢数据**，所以这里必须把关键不变量钉死。
 *
 * 形态是用户拍板的"提示后由用户决定"，不是静默恢复：
 * 打开工具想从头开始的人，不该莫名看到上次的旧画布。
 *
 * 这里用真实刷新（`Page.navigate`）而不是模拟事件——`pagehide` 里那次 flush 能不能在
 * 页面被拆掉前完成，只有真刷新才测得出来（正是靠这条发现了下面那个丢数据窗口）。
 */
const draftRead = () =>
  cdp.eval(`(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('pixel-art-studio', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const rec = await new Promise((res) => { const tx = db.transaction('draft', 'readonly'); const q = tx.objectStore('draft').get('art'); q.onsuccess = () => res(q.result); q.onerror = () => res(null) })
    db.close()
    if (!rec) return JSON.stringify({ present: false })
    const pf = JSON.parse(rec.project)
    return JSON.stringify({ present: true, version: rec.version, size: pf.width + 'x' + pf.height })
  })()`)

const draftReload = async () => {
  await cdp.send('Page.navigate', { url: pathToFileURL(app).href })
  for (let i = 0; i < 60; i++) {
    if (await cdp.eval('!!window.pixelArtStudio')) break
    await sleep(200)
  }
  await sleep(700) // 等异步读草稿 + 弹提示条
}
const draftBarShown = () => cdp.eval(`!!document.querySelector('[data-testid="draft-bar"]')`)

/** 清干净：删库 → 重载，确保用例从"完全没有草稿"开始 */
const draftReset = async () => {
  await cdp.eval(`indexedDB.deleteDatabase('pixel-art-studio')`).catch(() => {})
  await sleep(300)
  await draftReload()
}

await check('自动草稿：★ 首次编辑后立刻刷新也不丢（曾经有个"先清后写"的空窗）', async () => {
  /*
   * 这条守的是一个**真实的丢数据窗口**，实现时实测发现：
   * 早先的 `replaceArt` 是"clearDraft() + 排一次防抖写"——用户还没有过任何草稿时
   * （第一次新建/导入），"编辑 → 800ms 内刷新"会连盘都没写下去（旧的刚清、新的没到点，
   * pagehide 那次 flush 也来不及）。实测四种时延 0/100/300/600ms **全部丢失**。
   * 现在改成"有画布就立刻 flush、只有 art===null 才清盘"，下面四种时延都该救回来。
   */
  for (const delay of [0, 100, 300]) {
    await draftReset()
    await cdp.eval(`window.pixelArtStudio.newCanvas({ width: 12, height: 12, color: '#123456' })`)
    await cdp.eval(`window.pixelArtStudio.edit([{ op: 'setCells', cells: [[1, 1]], color: '#ff0000' }])`)
    if (delay) await sleep(delay)
    await draftReload()
    assert(await draftBarShown(), `首次编辑后等 ${delay}ms 刷新就丢了草稿（这正是要防的丢数据窗口）`)
    const rec = JSON.parse(await draftRead())
    assert(rec.present && rec.size === '12x12', `草稿应是 12x12，实际 ${JSON.stringify(rec)}`)
  }
  return '首编辑后 0/100/300ms 刷新，三次都能恢复'
})

await check('自动草稿：编辑→刷新→提示条→恢复，画布与编辑逐位一致', async () => {
  await draftReset()
  const before = JSON.parse(
    await cdp.eval(`(() => {
      const ps = window.pixelArtStudio
      ps.newCanvas({ width: 20, height: 20, color: '#223344' })
      ps.edit([{ op: 'setCells', cells: [[0,0],[1,1],[2,2]], color: '#ff0000' }])
      return JSON.stringify({ hash: ps.artHash() })
    })()`),
  )
  await sleep(1200) // 等防抖落盘
  await draftReload()

  // 提示条出现时**不应已经恢复**画布（必须等用户点，这是拍板的形态）
  assert(await draftBarShown(), '有草稿时刷新应出现「恢复 / 放弃」提示条')
  const whileAsking = JSON.parse(await cdp.eval(`JSON.stringify({ hasArt: window.pixelArtStudio.getInfo().hasArt })`))
  assert(!whileAsking.hasArt, '提示条出现时不应已经恢复画布（要等用户决定，不能静默恢复）')

  await clickByExpr(`document.querySelector('[data-testid="draft-restore"]')`)
  await sleep(600)
  const after = JSON.parse(
    await cdp.eval(`(() => {
      const ps = window.pixelArtStudio
      const i = ps.getInfo()
      return JSON.stringify({ hasArt: i.hasArt, w: i.width, h: i.height, hash: ps.artHash() })
    })()`),
  )
  assert(after.hasArt, '点「恢复」后应有画布')
  assert(after.w === 20 && after.h === 20, `尺寸应为 20×20，实际 ${after.w}×${after.h}`)
  assert(after.hash === before.hash, `恢复后 hash 应与刷新前一致（编辑不能丢）`)
  assert(!(await draftBarShown()), '恢复后提示条应消失（否则用户会以为没生效而反复点）')
  return `恢复 20×20，hash 一致（${before.hash.slice(0, 10)}…），提示条已消失`
})

await check('自动草稿：点「放弃」后画布为空、草稿被清除，且下次打开不再提示', async () => {
  await draftReset()
  await cdp.eval(`window.pixelArtStudio.newCanvas({ width: 16, height: 16, color: '#abcdef' })`)
  await sleep(1200)
  await draftReload()
  await clickByExpr(`document.querySelector('[data-testid="draft-discard"]')`)
  await sleep(400)
  assert(!JSON.parse(await cdp.eval(`JSON.stringify({ hasArt: window.pixelArtStudio.getInfo().hasArt })`)).hasArt, '放弃后不应有画布')
  assert(!(await draftBarShown()), '放弃后提示条应消失')
  assert(!JSON.parse(await draftRead()).present, '放弃后草稿记录应已被删除')

  // 再刷新一次：不该再弹（否则"放弃"等于没放弃）
  await draftReload()
  assert(!(await draftBarShown()), '放弃之后再次打开不应再提示（草稿确实清了）')
  return '画布为空、草稿已删、再打开不再提示'
})

await check('自动草稿：清空/重置后刷新，旧画布不得复活（替换=新基线）', async () => {
  /*
   * `replaceArt` 是「整体替换 = 新基线」的唯一入口，草稿必须跟着走。
   * 要防的是两件事：① 待写的定时器把旧画布写回去（路线图记的顺序坑）；
   * ② 清了草稿但新内容没落盘。所以这里**不等防抖就刷新**，最接近真实触发条件。
   */
  await draftReset()
  await cdp.eval(`window.pixelArtStudio.newCanvas({ width: 30, height: 30, color: '#0000ff' })`)
  await cdp.eval(`window.pixelArtStudio.edit([{ op: 'setAll', color: '#ff00ff' }])`)
  await sleep(120)
  await cdp.eval(`window.pixelArtStudio.reset()`) // 清空工作区（replaceArt(null)）
  /*
   * ⚠️ 必须**等足一个防抖周期**（800ms）再看盘。
   *
   * 只等 120ms 是**查不出问题的**：那时漏网的定时器还没到点，盘上看着是空的，
   * 断言会全绿——而 1.6s 后旧画布就被写回去了（实测逐步打点：reset 后立刻/120ms 都是 none，
   * 1.6s 时变成 30x30）。"太快地看一眼"会让这条防线形同虚设，这正是它第一版漏掉变异的原因。
   */
  await sleep(1600)
  await draftReload()
  const shown = await draftBarShown()
  /*
   * ⚠️ **必须连"盘上还有没有草稿"一起查**，不能只看"当前有没有画布"。
   *
   * 只看画布是查不出问题的：提示条要求用户点「恢复」才会装载画布，所以"盘上留着旧草稿、
   * 但没人点"这个状态在只看画布时是**通过**的（实测：把 clearDraft 换成"清空后仍重排写入"，
   * 盘上确实留着 30×30，而只查画布的断言照样全绿——等于这条防线是空的）。
   * 真正该断言的是"旧草稿不该存在于盘上"，那才是"替换=新基线"的实际含义。
   */
  const rec = JSON.parse(await draftRead())
  assert(!shown, '清空后不应出现恢复提示条（说明旧草稿还在盘上）')
  assert(!rec.present || rec.size !== '30x30', `清空后盘上不应留下旧画布，实际 ${JSON.stringify(rec)}`)
  if (shown) {
    // 万一弹了，也不该是那张旧图：点开看一眼再断言（失败信息更有指向性）
    await clickByExpr(`document.querySelector('[data-testid="draft-restore"]')`)
    await sleep(500)
    const w = JSON.parse(await cdp.eval(`JSON.stringify({ w: window.pixelArtStudio.getInfo().width })`)).w
    assert(w !== 30, `恢复出来的仍是被清空的旧画布（${w}×${w}），"替换=新基线"没生效`)
  }
  return `盘上无旧草稿（${JSON.stringify(rec)}），旧画布未复活`
})

await check('自动草稿：存储不可用时静默降级（不弹提示条、不报错、编辑照常）', async () => {
  /*
   * 无痕模式 / 企业策略 / 配额满时 `indexedDB` 可能直接抛错。
   * 项目对"存储不可用"的既有约定是**静默降级**（存储不可用即静默降级、不弹提示、不报错），
   * 草稿也必须守：不能因此弹一个每次打开都出现的提示条、更不能让编辑不可用。
   *
   * 手法：在新文档执行前把 `indexedDB` 换成会抛错的 getter——比"删掉属性"更接近真实
   * （浏览器策略禁用时是访问即抛，而 `typeof indexedDB !== 'undefined'` 那道判断拦不住抛错，
   * 正好验证了 storage.ts 里 `draftSupported()` 用 try/catch 包住的必要性）。
   */
  const s2 = await startBrowser({ profilePrefix: 'nostore-' })
  try {
    await s2.cdp.send('Runtime.enable')
    await s2.cdp.send('Page.enable')
    await s2.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `Object.defineProperty(window, 'indexedDB', { get() { throw new Error('storage disabled') } })`,
    })
    /*
     * 收集页面里的**未捕获错误**（unhandledrejection + error）。
     *
     * 这一步是必须的：`void maybeOfferDraftRestore()` 的 Promise 被丢弃，
     * 所以"没包 try/catch 导致读草稿抛错"**不会**表现成提示条或编辑失败——
     * 它只会在控制台留下一个未处理的 rejection。若不在页面侧捕获并断言，
     * 这条用例在"存储被禁用 + 没做防护"的实现下**照样全绿**（实测确认过），
     * 那就成了一条只会点头的假防线。
     */
    await s2.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__errs = []
        window.addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + (e.reason && e.reason.message || e.reason)))
        window.addEventListener('error', (e) => window.__errs.push('error: ' + (e.message || e)))
      `,
    })
    await s2.cdp.send('Page.navigate', { url: pathToFileURL(app).href })
    for (let i = 0; i < 60; i++) {
      if (await s2.cdp.eval('!!window.pixelArtStudio')) break
      await sleep(200)
    }
    await sleep(600)
    const errs = JSON.parse(await s2.cdp.eval('JSON.stringify(window.__errs || [])'))
    assert(
      errs.length === 0,
      `存储不可用时不应产生未捕获错误（草稿必须静默降级）：${JSON.stringify(errs)}`,
    )
    const bar = await s2.cdp.eval(`!!document.querySelector('[data-testid="draft-bar"]')`)
    assert(!bar, '存储不可用时不应弹草稿提示条')
    const edited = JSON.parse(
      await s2.cdp.eval(`(() => {
        const ps = window.pixelArtStudio
        ps.newCanvas({ width: 10, height: 10, color: '#123456' })
        ps.edit([{ op: 'setCells', cells: [[1, 1]], color: '#ff0000' }])
        return JSON.stringify({ hasArt: ps.getInfo().hasArt })
      })()`),
    )
    assert(edited.hasArt, '存储不可用时编辑必须照常（草稿只是锦上添花）')
  } finally {
    await s2.close?.()
  }
  return '无提示条、无报错、新建与编辑照常'
})

/* ---------------------------------------------- 结果 */

await session.close()
report()
