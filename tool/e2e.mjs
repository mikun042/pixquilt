#!/usr/bin/env node
/**
 * 端到端冒烟测试（无头 Edge/Chrome，零依赖 CDP 客户端）。
 *
 * 验证的是**真实交付物**：直接用 `file://` 打开根目录的单文件 HTML，
 * 检查 UI 是否装配、页内 API 是否可用、绘制链路与导出是否真的能跑。
 *
 * 与 `--selftest` 的分工：
 *   artc --selftest  → 引擎/算子/导出/拼豆的**算法链路**（不启浏览器）
 *   e2e.mjs          → 单文件产物的**装配与交互链路**（真浏览器、真事件）
 *
 * 用法：node tool/e2e.mjs [--app <html 路径>] [--keep-open]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const BROWSER_CANDIDATES = [
  process.env['PROGRAMFILES'] && join(process.env['PROGRAMFILES'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['PROGRAMFILES'] && join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['LOCALAPPDATA'] && join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean)

function pickBrowser(explicit) {
  if (explicit) return explicit
  const found = BROWSER_CANDIDATES.find((p) => existsSync(p))
  if (!found) throw new Error('找不到 Edge/Chrome，请用 --browser <路径> 指定')
  return found
}

/** 极简 CDP 客户端：只用 WebSocket + fetch（Node 内置），不引第三方依赖 */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    /** 定时器必须在收到响应时清掉：上一版忘记清，导致进程每次空转 120 秒 */
    this.pendingTimers = new Set()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        this.pendingTimers.delete(timer)
        clearTimeout(timer)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    })
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
    })
    return new Cdp(ws)
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.pendingTimers.delete(timer)
        reject(new Error(`CDP 超时：${method}`))
      }, timeoutMs)
      this.pendingTimers.add(timer)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** 在页面里求值；表达式必须是可序列化的返回值 */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) {
      throw new Error(`页面求值抛错：${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`)
    }
    return res.result.value
  }

  close() {
    for (const t of this.pendingTimers) clearTimeout(t)
    this.pendingTimers.clear()
    try {
      this.ws.close()
    } catch {
      /* 已关闭 */
    }
  }
}

async function launchHeadless(browserPath) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'pixel-e2e-'))
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--allow-file-access-from-files',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ]
  const child = spawn(browserPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('等待浏览器 DevTools 端口超时')), 25000)
    const onData = (chunk) => {
      buffer += String(chunk)
      const m = buffer.match(/ws:\/\/[^\s]+/)
      if (m) {
        clearTimeout(timer)
        resolve(m[0])
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`浏览器提前退出（code ${code}）`))
    })
  })
  return { child, wsUrl, userDataDir }
}

/** 确保页面有个可用的 tab（--headless=new 下初始为 about:blank） */
async function firstPageTarget(wsUrl) {
  const { host, port } = parseWs(wsUrl)
  const res = await fetch(`http://${host}:${port}/json/list`)
  const list = await res.json()
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('浏览器没有可用的页面目标')
  return page.webSocketDebuggerUrl
}

function parseWs(wsUrl) {
  const m = wsUrl.match(/ws:\/\/([^:/]+):(\d+)\//)
  if (!m) throw new Error(`无法解析 DevTools 地址：${wsUrl}`)
  return { host: m[1], port: m[2] }
}

/* ------------------------------------------------------------------ 断言 */

const results = []
function check(name, fn) {
  try {
    const detail = fn()
    results.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) })
  } catch (err) {
    results.push({ name, ok: false, detail: err?.message ?? String(err) })
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

async function main() {
  const args = process.argv.slice(2)
  const appArg = args.indexOf('--app')
  const browserArg = args.indexOf('--browser')
  const app = appArg >= 0 ? args[appArg + 1] : join(ROOT, '像素画工作台.html')
  const browser = pickBrowser(browserArg >= 0 ? args[browserArg + 1] : undefined)

  if (!existsSync(app)) throw new Error(`找不到工作台 HTML：${app}（先跑 npm run build）`)
  console.log(`浏览器：${browser}`)
  console.log(`产物：${app}\n`)

  const { child, wsUrl, userDataDir } = await launchHeadless(browser)
  let cdp
  const consoleErrors = []
  try {
    cdp = await Cdp.connect(await firstPageTarget(wsUrl))
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    cdp.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
      }
    })

    const url = pathToFileURL(app).href
    await cdp.send('Page.navigate', { url })
    // 等脚本装配：轮询直到 window.pixelArtStudio 出现（比固定 sleep 稳）
    let ready = false
    for (let i = 0; i < 60; i++) {
      try {
        ready = await cdp.eval('!!window.pixelArtStudio')
        if (ready) break
      } catch {
        /* 导航中求值会抛错，忽略 */
      }
      await new Promise((r) => setTimeout(r, 200))
    }

    check('页面装配：window.pixelArtStudio 已挂载', () => {
      assert(ready, '脚本未在 12 秒内完成装配')
      return 'ok'
    })

    const caps = await cdp.eval('JSON.stringify(window.pixelArtStudio.capabilities())')
    check('自描述：capabilities() 可用且含上限', () => {
      const c = JSON.parse(caps)
      assert(c.canvasSideMax === 2048, 'canvasSideMax 应为 2048')
      assert(c.animation === false, 'animation 应为 false（本期不实现）')
      return `apiLevel ${c.apiLevel}`
    })

    const opsCount = await cdp.eval('window.pixelArtStudio.describeOps().length')
    check('自描述：describeOps() 返回 10 个算子', () => {
      assert(opsCount === 10, `期望 10，实际 ${opsCount}`)
      return `${opsCount} 个算子`
    })

    const ui = await cdp.eval(`JSON.stringify({
      tools: document.querySelectorAll('.tool-btn').length,
      board: !!document.getElementById('board'),
      params: !!document.getElementById('panel-params'),
      palette: !!document.getElementById('panel-palette'),
      status: !!document.getElementById('statusbar'),
      rightActions: document.querySelectorAll('.header-right button').length,
      leftButtons: document.querySelectorAll('.header-left button').length,
      importBtn: document.getElementById('btn-import')?.textContent || '',
      exportBtn: document.getElementById('btn-export')?.textContent || '',
      modeOptions: document.querySelectorAll('#header-mode select option').length,
      modeInRight: !!document.querySelector('.header-right #header-mode'),
      modeInLeft: !!document.querySelector('.header-left #header-mode'),
      importInLeft: !!document.querySelector('.header-left #btn-import'),
      importInRight: !!document.querySelector('.header-right #btn-import'),
      exportInRight: !!document.querySelector('.header-right #btn-export'),
      leftText: document.querySelector('.header-left')?.textContent || ''
    })`)
    check('UI 装配：工具/画布/参数/色板/状态栏 + 顶栏分组', () => {
      const u = JSON.parse(ui)
      assert(u.board, 'canvas 缺失')
      assert(u.tools === 6, `工具按钮应为 6，实际 ${u.tools}`)
      assert(u.params && u.palette && u.status, '面板或状态栏缺失')
      // 右上角应包含：撤销 / 重做 / 重新转换 / 新建 / 导入 / 导出 / 快捷键 = 7 个
      assert(u.rightActions >= 7, `右上角动作按钮过少：${u.rightActions}（应为撤销/重做/重新转换/新建/导入/导出/快捷键）`)
      assert(u.importBtn.includes('导入'), `右上角缺「导入图片」按钮：${u.importBtn}`)
      assert(u.exportBtn.includes('导出'), `右上角缺「导出」按钮：${u.exportBtn}`)
      assert(u.modeOptions === 3, `模式切换应有 3 个选项，实际 ${u.modeOptions}`)
      return `${u.tools} 工具 / 右上角 ${u.rightActions} 个动作 + 导入 + 导出 / 模式 3 项`
    })

    check('顶栏布局：只有模式切换留在左侧，其余动作全在右上角', () => {
      const u = JSON.parse(ui)
      assert(u.modeInLeft, '模式切换必须留在左侧')
      assert(!u.modeInRight, '模式切换不应被移到右上角（用户要求保持原位）')
      assert(!u.importInLeft && u.importInRight, '「导入图片」应在右上角')
      assert(u.exportInRight, '「导出」应在右上角')
      assert(u.leftButtons === 0, `左侧不应再有按钮，实际 ${u.leftButtons} 个`)
      // 左侧只应出现品牌与模式文字（不应残留"撤销/新建"等动作文案）
      for (const word of ['撤销', '重做', '重新转换', '新建', '导入', '导出']) {
        assert(!u.leftText.includes(word), `左侧仍残留「${word}」`)
      }
      return '左侧仅品牌 + 模式切换'
    })

    const orderProbe = await cdp.eval(`(() => {
      const right = document.querySelector('.header-right')
      const kids = [...right.children]
      const last = kids[kids.length - 1]
      const help = document.getElementById('btn-help')
      // 用屏幕位置复核（DOM 顺序与视觉顺序不一致时以视觉为准）
      const rect = (elm) => { const r = elm.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right) } }
      const all = [...right.querySelectorAll('button')].map((b) => ({ id: b.id, ...rect(b) }))
      const exportBtn = document.getElementById('btn-export')
      return JSON.stringify({
        lastChildId: last ? last.id : '',
        helpExists: !!help,
        helpIsLast: help ? help === last : false,
        helpRight: help ? rect(help).right : 0,
        exportRight: rect(exportBtn).right,
        maxRightId: all.reduce((m, x) => (x.right > m.right ? x : m), all[0]).id
      })
    })()`)
    check('顶栏顺序：快捷键按钮在最右侧', () => {
      const o = JSON.parse(orderProbe)
      assert(o.helpExists, '找不到「? 快捷键」按钮')
      assert(o.helpIsLast, `快捷键应是右上角最后一个元素，实际最后一个是 ${o.lastChildId || '(无 id)'}`)
      assert(o.maxRightId === 'btn-help', `屏幕最右侧的按钮应是 btn-help，实际 ${o.maxRightId}`)
      assert(o.helpRight >= o.exportRight, '快捷键按钮不应排到导出按钮左侧')
      return `最后一个元素 = ${o.lastChildId}，屏幕最右 = ${o.maxRightId}`
    })

    // 导出菜单：点开应出现条目、再点收起（并且不能被一次重渲染冲掉）
    const menuFlow = await cdp.eval(`(() => {
      const btn = document.getElementById('btn-export')
      const menu = document.getElementById('export-menu')
      const before = menu.hidden
      btn.click()
      const openedHidden = menu.hidden
      const items = menu.querySelectorAll('.dropdown-item').length
      const groups = [...menu.querySelectorAll('.dropdown-group')].map((g) => g.textContent)
      const scales = menu.querySelectorAll('.dropdown-row .btn').length
      const aria = btn.getAttribute('aria-expanded')
      // 再点一次应收起
      btn.click()
      const closedHidden = menu.hidden
      return JSON.stringify({ before, openedHidden, items, groups, scales, aria, closedHidden })
    })()`)
    check('导出菜单：可展开、含分组与倍数、可收起', () => {
      const m = JSON.parse(menuFlow)
      assert(m.before === true, '菜单初始应为收起状态')
      assert(m.openedHidden === false, '点击后菜单应展开')
      assert(m.items >= 5, `菜单条目过少：${m.items}`)
      assert(m.scales === 9, `放大倍数应为 9 个，实际 ${m.scales}`)
      assert(m.aria === 'true', 'aria-expanded 应为 true')
      assert(m.closedHidden === true, '再次点击应收起')
      return `${m.items} 个条目 / ${m.groups.join('/')} / ${m.scales} 个倍数`
    })

    // 菜单在"有画布"时点某个条目不应报错（导出会真的触发下载，这里只验证菜单联动不抛错）
    // 注意：这条必须放在**创建画布之后**，否则菜单条目本就该是禁用状态


    // 环境探针：确认 headless 下 setTimeout 与 rAF 是否真的会回调（先排除环境因素）
    const envProbe = await cdp.eval(`(async () => {
      let timeoutFired = false
      let rafFired = false
      setTimeout(() => { timeoutFired = true }, 50)
      requestAnimationFrame(() => { rafFired = true })
      await new Promise((r) => setTimeout(r, 400))
      return JSON.stringify({ timeoutFired, rafFired, visibility: document.visibilityState })
    })()`)
    check('环境探针：定时器与动画帧可用（headless 下也能绘制）', () => {
      const p = JSON.parse(envProbe)
      assert(p.timeoutFired, 'setTimeout 未回调：环境不支持定时器')
      return `timeout=${p.timeoutFired} raf=${p.rafFired} visibility=${p.visibility}`
    })

    // 用 API 造一张画布，验证"渲染 + 状态栏 + 绘制提交"这条真实链路
    const drawn = await cdp.eval(`(() => {
      const ps = window.pixelArtStudio
      ps.newCanvas({ width: 32, height: 32, transparent: true })
      const r = ps.edit([
        { op: 'rect', x0: 4, y0: 4, x1: 27, y1: 27, color: '#223344' },
        { op: 'ellipse', x0: 8, y0: 8, x1: 23, y1: 23, color: '#ff6600', filled: false },
        { op: 'line', x0: 0, y0: 31, x1: 31, y1: 31, color: '#ffffff' }
      ])
      return JSON.stringify({ applied: r.applied, changes: r.changes.length, w: r.width, h: r.height, transparent: r.transparent, hash: ps.artHash() })
    })()`)
    check('绘制链路：newCanvas + edit(rect/ellipse/line) 生效', () => {
      const d = JSON.parse(drawn)
      assert(d.applied, '编辑应被标记为已应用')
      assert(d.changes === 3, `应有 3 条改动，实际 ${d.changes}`)
      assert(d.w === 32 && d.h === 32, '画布尺寸应为 32×32')
      assert(d.transparent > 0, '透明画布应保留透明格')
      return `${d.changes} 条改动 / hash ${d.hash}`
    })

    const statusText = await cdp.eval("document.getElementById('statusbar').textContent")
    check('状态栏：反映画布尺寸与色数', () => {
      assert(/32×32/.test(statusText), `状态栏未显示 32×32：${statusText}`)
      return statusText.slice(0, 60)
    })

    // 绘制是异步调度的（rAF / 定时器兜底），必须轮询就绪而不是假设"调用完就已经画好"
    let canvasDrawn = ''
    for (let i = 0; i < 40; i++) {
      canvasDrawn = await cdp.eval(`(() => {
        const c = document.getElementById('board')
        const ctx = c.getContext('2d')
        const d = ctx.getImageData(0, 0, c.width, c.height).data
        let nonEmpty = 0
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) nonEmpty++

        // 旁证：自建 canvas 自检（排除"headless 下 getImageData 一律读 0"这种环境因素）
        const probe = document.createElement('canvas')
        probe.width = 4; probe.height = 4
        const pctx = probe.getContext('2d')
        pctx.fillStyle = '#ff0000'
        pctx.fillRect(0, 0, 2, 2)
        const pdata = pctx.getImageData(0, 0, 4, 4).data
        let probeNonEmpty = 0
        for (let i = 3; i < pdata.length; i += 4) if (pdata[i] > 0) probeNonEmpty++

        const info = window.pixelArtStudio.getInfo()
        return JSON.stringify({
          w: c.width, h: c.height, nonEmpty, probeNonEmpty,
          draws: c.dataset.draws || '0', lastDraw: c.dataset.lastDraw || '', drawError: c.dataset.drawError || '',
          artW: info.width, artH: info.height, hasArt: info.hasArt
        })
      })()`)
      const parsed = JSON.parse(canvasDrawn)
      if (parsed.nonEmpty > 1000 || parsed.drawError) break
      await new Promise((r) => setTimeout(r, 100))
    }
    check('画布真的画出了内容（不是空白 <canvas>）', () => {
      const c = JSON.parse(canvasDrawn)
      assert(c.probeNonEmpty === 4, `环境自检失败：headless 下 getImageData 读不到自绘内容（probe=${c.probeNonEmpty}）`)
      assert(!c.drawError, `绘制过程抛错：${c.drawError}`)
      assert(Number(c.draws) > 0, `绘制函数从未执行（draws=${c.draws}）`)
      assert(c.nonEmpty > 1000, `画布几乎空白：${c.nonEmpty} 个不透明像素（lastDraw=${c.lastDraw}）`)
      return `${c.w}×${c.h} / ${c.nonEmpty} 个不透明像素 / 重绘 ${c.draws} 次`
    })

    // 导出菜单条目在有画布时必须可用（这条放在创建画布之后，才对得上真实时序）
    const menuClickSafe = await cdp.eval(`(() => {
      const btn = document.getElementById('btn-export')
      btn.click()
      const menu = document.getElementById('export-menu')
      const target = menu.querySelector('[data-testid="export-png"]')
      const exists = !!target
      const disabled = target ? target.disabled : null
      const bead = menu.querySelector('[data-testid="export-bead"]')
      const beadDisabled = bead ? bead.disabled : null
      // 不真的点条目（会触发下载），只验证状态后收起
      btn.click()
      return JSON.stringify({ exists, disabled, beadExists: !!bead, beadDisabled })
    })()`)
    check('导出菜单：有画布时 PNG 与拼豆条目均可用', () => {
      const r = JSON.parse(menuClickSafe)
      assert(r.exists, '找不到 PNG 导出条目')
      assert(r.disabled === false, '有画布时 PNG 导出条目不应禁用')
      assert(r.beadExists, '找不到拼豆导出条目')
      assert(r.beadDisabled === false, '有画布时拼豆导出条目不应禁用')
      return 'PNG 与拼豆条目可用'
    })

    const png = await cdp.eval("window.pixelArtStudio.exportPNG(2).slice(0, 22)")
    check('导出：exportPNG(2) 返回 PNG dataURL', () => {
      assert(png.startsWith('data:image/png;base64,'), `不是 PNG dataURL：${png}`)
      return png
    })

    const bead = await cdp.eval(`(() => {
      const ps = window.pixelArtStudio
      ps.setParams({ paletteMode: 'preset', presetPaletteId: 'beads16', lockPalette: true })
      const rep = ps.beadReport()
      const csv = ps.exportBeadCsv()
      const svg = ps.exportBeadSvg({ cellPx: 14 })
      return JSON.stringify({ rows: rep.rows.length, beads: rep.totalBeads, csvHead: csv.split('\\n')[0], svgOk: svg.startsWith('<svg') && svg.trimEnd().endsWith('</svg>') })
    })()`)
    check('拼豆：beadReport / 缺口清单 CSV / 图纸 SVG 均可用', () => {
      const b = JSON.parse(bead)
      assert(b.rows > 0, '没有色号行')
      assert(b.beads > 0, '珠数为 0')
      assert(b.csvHead.startsWith('编号,颜色,格数'), `CSV 表头不对：${b.csvHead}`)
      assert(b.svgOk, 'SVG 未正确闭合')
      return `${b.rows} 色 / ${b.beads} 颗`
    })

    const undoRedo = await cdp.eval(`(() => {
      const ps = window.pixelArtStudio
      const before = ps.artHash()
      ps.edit([{ op: 'setAll', color: '#00ff00' }])
      const afterEdit = ps.artHash()
      ps.undo()
      const afterUndo = ps.artHash()
      ps.redo()
      const afterRedo = ps.artHash()
      return JSON.stringify({ changed: before !== afterEdit, undone: before === afterUndo, redone: afterRedo === afterEdit })
    })()`)
    check('撤销 / 重做：edit → undo → redo 状态可逆', () => {
      const u = JSON.parse(undoRedo)
      assert(u.changed, 'edit 应改变画布')
      assert(u.undone, 'undo 应回到编辑前')
      assert(u.redone, 'redo 应回到编辑后')
      return '可逆'
    })

    const validate = await cdp.eval(`JSON.stringify(window.pixelArtStudio.validateParams({ longEdge: 99999, dither: 'nope' }))`)
    check('参数预演：validateParams 报告被修正的字段', () => {
      const v = JSON.parse(validate)
      assert(v.ok === false, '越界参数应报告不 ok')
      assert(v.fixed.length >= 2, `应报告至少 2 处修正：${v.fixed.length}`)
      return v.fixed.map((f) => f.key).join(', ')
    })

    // 真实用户路径：造一张 PNG 当作用户图片导入 → 必须真的转换并显示出来。
    // 这条断言是为了锁住一个真实缺陷：空状态提示常驻在模板里且自带不透明背景，
    // 导入成功后没被移除，于是它一直盖在画好的画布上，表现为"导入图片转换不出来"。
    const importFlow = await cdp.eval(`(async () => {
      const c = document.createElement('canvas')
      c.width = 64; c.height = 64
      const ctx = c.getContext('2d')
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        ctx.fillStyle = 'rgb(' + Math.round(x * 4) + ',' + Math.round(y * 4) + ',80)'
        ctx.fillRect(x, y, 1, 1)
      }
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'))
      const file = new File([blob], '用户图片.png', { type: 'image/png' })
      const info = await window.pixelArtStudio.importImage(file)
      return JSON.stringify({ info })
    })()`)
    check('导入图片：API 报告导入成功并完成转换', () => {
      const r = JSON.parse(importFlow)
      assert(r.info.width === 64 && r.info.height === 64, `原图尺寸不对：${JSON.stringify(r.info)}`)
      return `${r.info.name} ${r.info.width}×${r.info.height}`
    })

    let imported = ''
    for (let i = 0; i < 40; i++) {
      imported = await cdp.eval(`(() => {
        const c = document.getElementById('board')
        const ctx = c.getContext('2d')
        const d = ctx.getImageData(0, 0, c.width, c.height).data
        let nonEmpty = 0
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) nonEmpty++
        const info = window.pixelArtStudio.getInfo()
        const host = document.getElementById('canvas-host')
        const overlay = host.querySelector('.empty-state')
        return JSON.stringify({
          hasArt: info.hasArt, artW: info.width, artH: info.height, paletteSize: info.paletteSize,
          nonEmpty, overlayPresent: !!overlay,
          overlayDisplay: overlay ? getComputedStyle(overlay).display : 'none',
          drawError: c.dataset.drawError || '',
          status: document.getElementById('statusbar').textContent
        })
      })()`)
      const parsed = JSON.parse(imported)
      if (parsed.nonEmpty > 500 && !parsed.overlayPresent) break
      await new Promise((r) => setTimeout(r, 150))
    }
    check('导入图片：转换结果真的显示出来，且空状态已移除', () => {
      const r = JSON.parse(imported)
      assert(r.hasArt, '导入后没有画布')
      assert(r.paletteSize > 1, `转换后色板只有 ${r.paletteSize} 色，可能是 1×1 或失败`)
      assert(!r.drawError, `绘制抛错：${r.drawError}`)
      assert(!r.overlayPresent, '「拖入图片」空状态提示仍盖在画布上（有画布时必须移除）')
      assert(r.nonEmpty > 500, `画布内容为空：${r.nonEmpty} 个不透明像素（状态栏：${r.status}）`)
      return `${r.artW}×${r.artH} / ${r.paletteSize} 色 / ${r.nonEmpty} 像素`
    })

    check('运行期无控制台错误', () => {
      assert(consoleErrors.length === 0, `控制台报错 ${consoleErrors.length} 条：${consoleErrors.slice(0, 2).join(' | ')}`)
      return '0 条'
    })
  } finally {
    cdp?.close()
    child.kill()
    await new Promise((r) => setTimeout(r, 300))
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* 临时目录清理失败不影响结论 */
    }
  }

  const passed = results.filter((r) => r.ok).length
  for (const r of results) console.log(` ${r.ok ? '✔' : '✘'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
  console.log(`\n端到端：${passed}/${results.length} 通过`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((err) => {
  console.error(`端到端测试无法运行：${err?.message ?? err}`)
  process.exit(1)
})
