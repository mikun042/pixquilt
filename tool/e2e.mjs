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

    // 光比对 describeOps() 与核心 spec 是同义反复——两边读同一份 OP_SPECS，永远相等。
    // 真正会漂移的是"spec 加了算子但 applyOps 的 switch 没接"，所以逐个真调一次：
    // 未实现的算子会走进 default 分支报「未知算子」。
    const opNames = JSON.parse(await cdp.eval('JSON.stringify(window.pixelArtStudio.describeOps().map(o => o.op))'))
    const opSamples = {
      fill: { op: 'fill', x: 1, y: 1, color: '#ff0000' },
      setCells: { op: 'setCells', cells: [[1, 1]], color: '#ff0000' },
      setAll: { op: 'setAll', color: '#ff0000' },
      line: { op: 'line', x0: 1, y0: 1, x1: 5, y1: 5, color: '#ff0000' },
      rect: { op: 'rect', x0: 1, y0: 1, x1: 5, y1: 5, color: '#ff0000' },
      ellipse: { op: 'ellipse', x0: 1, y0: 1, x1: 5, y1: 5, color: '#ff0000' },
      transform: { op: 'transform', kind: 'flipX' },
      trim: { op: 'trim' },
      eraseColor: { op: 'eraseColor', color: '#ff0000' },
      replaceAny: { op: 'replaceAny', color: '#ff0000', to: '#00ff00' },
      outline: { op: 'outline', color: '#000000' },
      mirror: { op: 'mirror', kind: 'h', color: '#0000ff' },
    }
    const opMissing = opNames.filter((n) => !opSamples[n])
    const opUnknown = []
    for (const name of opNames) {
      if (!opSamples[name]) continue
      // eraseColor / replaceAny 只能作用于画布**已有**颜色，空画布上没有它们要的色。
      // 先 setAll 铺一层 #ff0000 让这两个算子有作用对象——这不是为了迁就实现，
      // 而是它们本来就定义在"已有颜色"上（报错信息也写明了）。
      const pre = name === 'eraseColor' || name === 'replaceAny' ? [{ op: 'setAll', color: '#ff0000' }] : []
      const ops = [...pre, opSamples[name]]
      // ops 放第 1 个参数里（renderBlank 与 render 的 ops 位置不同，详见 automation.ts 的守卫）。
      // renderBlank 是 async：不 await 就取不到 changes（会报 reading 'length'）。
      const res = await cdp.eval(`(async () => {
        try {
          const r = await window.pixelArtStudio.renderBlank({ width: 12, height: 12, transparent: true, ops: ${JSON.stringify(ops)} },
            { longEdge: 12, lockPalette: false })
          return JSON.stringify({ ok: true, changes: (r.changes || []).length })
        } catch (e) { return JSON.stringify({ ok: false, msg: e.message }) }
      })()`)
      const parsed = JSON.parse(res)
      if (!parsed.ok) opUnknown.push(`${name} → ${parsed.msg}`)
    }
    check('自描述：页面宣称的每个算子都真的能执行（防"清单里有、实现没有"）', () => {
      assert(opMissing.length === 0, `e2e 缺少这些算子的样例，请补：${opMissing.join(', ')}`)
      assert(opUnknown.length === 0, `页面宣称但无法执行：${opUnknown.join('；')}`)
      return `${opNames.length} 个算子全部可执行`
    })

    const opWrongSlot = await cdp.eval(`(async () => {
      try {
        await window.pixelArtStudio.renderBlank({ width: 8, height: 8 }, { longEdge: 8 }, 1, { ops: [{ op: 'setAll', color: '#ff0000' }] })
        return 'no-throw'
      } catch (e) { return e.message }
    })()`)
    check('renderBlank：ops 放错位置（第 4 参）必须报错，不能静默丢掉算子', () => {
      // render 的 ops 在第 4 参、renderBlank 的 ops 在第 1 参，两者返回值形状却一样。
      // 照 render 的样子调用 renderBlank 会拿到一张"算子完全没生效"的干净画布，
      // 且没有任何信号——这与本项目反复出现的"静默失效"是同一类问题。
      assert(opWrongSlot !== 'no-throw', 'ops 放第 4 参时应当报错，而不是静默忽略')
      assert(/第 1 个参数/.test(opWrongSlot), `错误信息要说清正确位置，实际：${opWrongSlot}`)
      return '明确报错并指出正确写法'
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
      hasModeSelect: !!document.querySelector('#header-mode, .mode-select'),
      presetChips: document.querySelectorAll('#panel-params .preset-chip').length,
      hasSavePreset: [...document.querySelectorAll('#panel-params button')].some((b) => b.textContent.includes('存为预设')),
      panelHasSizeMode: [...document.querySelectorAll('#panel-params .field > label')].some((e) => e.textContent.includes('尺寸方式')),
      panelHasLock: [...document.querySelectorAll('#panel-params .field > label')].some((e) => e.textContent.includes('锁定色板')),
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
      // 工作模式选择器已移除：图片→像素 / 拼豆图纸 / 游戏资产 三个用途并入右侧预设
      assert(!u.hasModeSelect, '工作模式选择器应已移除（用途并入预设，见 docs/USAGE.md）')
      assert(u.presetChips >= 6, `预设 chip 至少应有 6 个出厂预设，实际 ${u.presetChips}`)
      assert(u.hasSavePreset, '预设区应提供「＋ 存为预设」入口')
      // 「尺寸方式」与「锁定色板」对三种用途都成立，必须常显（旧版按模式把锁定色板藏起来过）
      assert(u.panelHasSizeMode, '参数面板应有「尺寸方式」控件')
      assert(u.panelHasLock, '参数面板应始终显示「锁定色板」')
      return `${u.tools} 工具 / 右上角 ${u.rightActions} 个动作 + 导入 + 导出 / 预设 ${u.presetChips} 个`
    })

    check('顶栏布局：左侧只有品牌，其余动作全在右上角', () => {
      const u = JSON.parse(ui)
      assert(u.leftText.includes('像素画工作台'), `左侧应保留品牌，实际「${u.leftText}」`)
      assert(!u.hasModeSelect, '左侧不应再有工作模式选择器')
      assert(!u.importInLeft && u.importInRight, '「导入图片」应在右上角')
      assert(u.exportInRight, '「导出」应在右上角')
      assert(u.leftButtons === 0, `左侧不应再有按钮，实际 ${u.leftButtons} 个`)
      // 左侧只应出现品牌（不应残留"撤销/新建"等动作文案）
      for (const word of ['撤销', '重做', '重新转换', '新建', '导入', '导出']) {
        assert(!u.leftText.includes(word), `左侧仍残留「${word}」`)
      }
      return '左侧仅品牌'
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

    /*
     * 「尺寸方式」切回长边时必须把 exactWidth/Height **删掉**。
     * 这是旧版的实际缺陷：残留的精确尺寸会让"长边"控件看起来调了却没效果
     * （computeGridSize 里 exact 优先于 longEdge），而界面上没有任何提示。
     */
    const sizeMode = await cdp.eval(`(async () => {
      const ps = window.pixelArtStudio
      ps.setParams({ exactWidth: 32, exactHeight: 32 })
      await new Promise((r) => setTimeout(r, 60))
      const before = ps.getParams()
      const sel = document.querySelector('#panel-params select')   // 预设区没有 select，第一个就是「尺寸方式」
      const label = (document.querySelector('#panel-params .field > label') || {}).textContent || ''
      sel.value = 'long'
      sel.dispatchEvent(new Event('change'))
      await new Promise((r) => setTimeout(r, 80))
      const after = ps.getParams()
      return JSON.stringify({
        label, beforeExact: before.exactWidth,
        afterExact: after.exactWidth === undefined ? null : after.exactWidth,
        afterLong: after.longEdge,
      })
    })()`)
    check('尺寸方式：切回「长边」会清掉精确尺寸（否则长边控件静默失效）', () => {
      const s = JSON.parse(sizeMode)
      assert(s.label === '尺寸方式', `面板第一个控件应是「尺寸方式」，实际「${s.label}」`)
      assert(s.beforeExact === 32, `前置条件不成立：exactWidth 应为 32，实际 ${s.beforeExact}`)
      assert(s.afterExact === null, `切回长边后 exactWidth 必须被删除，实际 ${s.afterExact}`)
      return `exact 32 → 已清除；长边 ${s.afterLong}`
    })

    /*
     * 预设：可更新（写回内置）、可恢复出厂、可存为自定义预设。
     * 同时守住"用户改动不写回 core"——页内 API 报的必须始终是出厂参数。
     */
    const presetEdit = await cdp.eval(`(async () => {
      const ps = window.pixelArtStudio
      ;[...document.querySelectorAll('#panel-params button')].find((b) => b.textContent.includes('管理预设')).click()
      await new Promise((r) => setTimeout(r, 80))
      const name = (document.querySelector('#panel-params .preset-line .preset-line-name') || {}).textContent || ''
      ps.setParams({ longEdge: 123 })
      await new Promise((r) => setTimeout(r, 60))
      ;[...document.querySelectorAll('#panel-params .preset-line button')].find((b) => b.textContent.includes('用当前参数更新')).click()
      await new Promise((r) => setTimeout(r, 80))
      const modified = [...document.querySelectorAll('#panel-params .preset-chip.modified')].length
      const factoryPhoto = JSON.parse(JSON.stringify(ps.stylePreset('photo')))
      ;[...document.querySelectorAll('#panel-params .preset-line button')].find((b) => b.textContent.includes('恢复出厂') && !b.disabled).click()
      await new Promise((r) => setTimeout(r, 80))
      const modifiedAfter = [...document.querySelectorAll('#panel-params .preset-chip.modified')].length
      window.prompt = () => '测试预设'
      ;[...document.querySelectorAll('#panel-params button')].find((b) => b.textContent.includes('存为预设')).click()
      await new Promise((r) => setTimeout(r, 80))
      const customCount = document.querySelectorAll('#panel-params .preset-chip.custom').length
      const hasTest = [...document.querySelectorAll('#panel-params .preset-chip')].some((c) => c.textContent.includes('测试预设'))
      return JSON.stringify({ name, modified, modifiedAfter, factoryPhotoLong: factoryPhoto.longEdge, customCount, hasTest })
    })()`)
    check('预设：可更新 / 可恢复出厂 / 可存为自定义预设，且出厂值不被写脏', () => {
      const s = JSON.parse(presetEdit)
      assert(s.modified === 1, `「用当前参数更新」后应有 1 个预设标记为已改，实际 ${s.modified}`)
      assert(s.modifiedAfter === 0, `「恢复出厂」后不应再有已改标记，实际 ${s.modifiedAfter}`)
      assert(s.factoryPhotoLong === 128, `页内 API 报的出厂预设必须不变（photo.longEdge 应为 128），实际 ${s.factoryPhotoLong}`)
      assert(s.hasTest && s.customCount >= 1, `「存为预设」应新增自定义预设，实际 custom=${s.customCount}`)
      return `${s.name}：更新→已改→恢复出厂；新增自定义预设 ${s.customCount} 个`
    })

    /*
     * 合成底色必须用**自家取色盘**，不能用原生 `<input type="color">`
     * （原生控件会弹操作系统的调色板，外观与交互都跟主色/背景色不是一套）；
     * 而且取色盘要**就地展开在参数面板里**——第一版复用左侧那个取色器，
     * 用户反馈"点击没反应"：视线在右侧面板，左边冒出来的东西根本注意不到。
     *
     * 这条用**真实鼠标事件**（合成 `.click()` 不经过命中测试，本项目踩过），
     * 并断言取色器落在 `#panel-params` 内、顶边在视口里 —— 也就是"点下去看得见结果"。
     *
     * ⚠️ 必须先摆成桌面视口：无头默认是 800×600，而 ≤980px 时右侧栏被 CSS 隐藏，
     * 参数面板拿到的矩形是 0×0、命中测试会落到页头（docs/DEVELOPMENT.md §3.2 第 1 条）。
     */
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
    await new Promise((r) => setTimeout(r, 200))
    const matteBox = JSON.parse(await cdp.eval(`(() => {
      const el = document.querySelector('[data-testid="matte-swatch"]')
      if (!el) return JSON.stringify({ error: '参数面板里找不到合成底色色块' })
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      const top = document.elementFromPoint(x, y)
      return JSON.stringify({ x, y,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        topTag: top ? top.tagName : '(null)', topClass: top ? String(top.className) : '',
        hitSelf: top ? el.contains(top) || top === el : false })
    })()`))
    assert(!matteBox.error, matteBox.error)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: matteBox.x, y: matteBox.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: matteBox.x, y: matteBox.y, button: 'left', clickCount: 1 })
    await new Promise((r) => setTimeout(r, 300))
    const mattePicker = JSON.parse(await cdp.eval(`(() => {
      const cp = document.querySelector('#panel-params .cp')
      const alpha = cp ? cp.querySelector('.cp-alpha') : null
      const r = cp ? cp.getBoundingClientRect() : null
      return JSON.stringify({
        native: document.querySelectorAll('#panel-params input[type=color]').length,
        inParamsPanel: !!cp,
        topVisible: r ? r.width > 0 && r.top >= 0 && r.top <= window.innerHeight : false,
        alphaVisible: alpha ? getComputedStyle(alpha).display !== 'none' : false,
        transparentSwatch: cp ? !!cp.querySelector('.cp-swatch.transparent') : false,
        hex: cp ? (cp.querySelector('.cp-hexrow input') || {}).value : '',
      })
    })()`))
    check('合成底色：点色块就地展开自家取色盘（非系统调色板），且不显示透明度行', () => {
      assert(matteBox.hitSelf, `合成底色色块被盖住/点不到：落点 ${Math.round(matteBox.x)},${Math.round(matteBox.y)}，色块矩形 ${matteBox.rect}，命中 <${matteBox.topTag} class="${matteBox.topClass}">`)
      const s = mattePicker
      assert(s.native === 0, `参数面板里不应再有原生 input[type=color]，实际 ${s.native} 个`)
      assert(s.inParamsPanel, '取色盘必须展开在参数面板里（就地）——出现在左侧列会让人以为"点了没反应"')
      assert(s.topVisible, '取色盘展开后应能直接在视口里看到（顶边在视口内）')
      assert(!s.alphaVisible, '编辑合成底色时不应显示「透明度」行')
      assert(!s.transparentSwatch, '编辑合成底色时不应显示「透明」色块')
      return `原生 0 个 / 就地展开在参数面板 / 透明度行已隐藏 / Hex ${s.hex}`
    })
    // 再点一次收起（同时验证是个开关）。展开时面板滚过，必须**重新取一次坐标**再点，
    // 否则会点在旧位置上（这次就因此误判成"收不起来"）。
    const matteBox2 = JSON.parse(await cdp.eval(`(() => {
      const el = document.querySelector('[data-testid="matte-swatch"]')
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
    })()`))
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: matteBox2.x, y: matteBox2.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: matteBox2.x, y: matteBox2.y, button: 'left', clickCount: 1 })
    await new Promise((r) => setTimeout(r, 250))
    const matteClosed = await cdp.eval(`!document.querySelector('#panel-params .cp')`)
    check('合成底色：再点一次收起取色盘', () => {
      assert(matteClosed, '再点一次应把取色盘收起来（它是个开关）')
      return '已收起'
    })

    // 用户很可能点的是「合成底色」那几个字而不是色块：`<label for>` 对 `<button>` 同样生效，
    // 所以标签也必须能点开——这条断了就又是一次"点了没反应"。
    const labelBox = JSON.parse(await cdp.eval(`(() => {
      const el = document.querySelector('#panel-params label[for="matte-swatch-btn"]')
      if (!el) return JSON.stringify({ error: '「合成底色」的标签没有关联到色块按钮（label[for] 丢了）' })
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      const top = document.elementFromPoint(x, y)
      return JSON.stringify({ x, y, hitSelf: top ? el.contains(top) || top === el : false })
    })()`))
    if (!labelBox.error) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: labelBox.x, y: labelBox.y, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: labelBox.x, y: labelBox.y, button: 'left', clickCount: 1 })
      await new Promise((r) => setTimeout(r, 250))
    }
    const labelOpened = labelBox.error ? false : await cdp.eval(`!!document.querySelector('#panel-params .cp')`)
    check('合成底色：点标签（不是色块）也能展开取色盘', () => {
      assert(!labelBox.error, labelBox.error)
      assert(labelBox.hitSelf, `标签被盖住了：落点 ${Math.round(labelBox.x)},${Math.round(labelBox.y)}`)
      assert(labelOpened, '点「合成底色」标签应同样展开取色盘（label[for] 关联断了吗？）')
      return '标签可点'
    })
    await cdp.send('Emulation.clearDeviceMetricsOverride')

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
