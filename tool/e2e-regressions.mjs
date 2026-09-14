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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

/* ---------------------------------------------- 结果 */

await session.close()
report()
