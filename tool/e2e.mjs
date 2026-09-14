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
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { argValue, createChecker, sleep, startBrowser } from './cdp.mjs'
// 断言里要用到撤销栈的真实上限：**直接 import 源码里的常量**，免得在测试里另抄一份数字
// （抄一份的话，常量改了测试不会红，就失去意义了）
import { HISTORY_MAX_BYTES, HISTORY_MAX_FRAMES } from '../src/core/limits.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/* ------------------------------------------------------------------ 断言 */

const { results, check, assert, report } = createChecker('端到端')

async function main() {
  const app = argValue('app', join(ROOT, '像素画工作台.html'))
  if (!existsSync(app)) throw new Error(`找不到工作台 HTML：${app}（先跑 npm run build）`)

  const session = await startBrowser({ browserPath: argValue('browser') || undefined, profilePrefix: 'pixel-e2e-' })
  const { cdp } = session
  console.log(`浏览器：${session.browser}`)
  console.log(`产物：${app}
`)

  const url = pathToFileURL(app).href
  const consoleErrors = []
  try {
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    cdp.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
      }
    })

    /*
     * **整条 suite 都用桌面视口**。无头默认是 800×600，而 ≤980px 时 CSS 会把两侧栏隐藏、
     * 参数面板拿到 0×0 的矩形——那时任何侧栏的几何/命中断言都会失真（docs/DEVELOPMENT.md §3.2 第 1 条）。
     * 原先只有"合成底色"那一条自己临时设过视口，等于把坑留给下一条新断言；
     * 这里统一设一次，后面谁加断言都不用再想这件事。
     */
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
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
      // 右下角曾有一组"适配/100%/正负号"按钮，样式齐全但没有任何事件绑定（点了没反应）。
      // 能力由快捷键 0 / + / - 与滚轮覆盖，所以整条工具栏已删除——这条防它被误加回来。
      hasDeadViewToolbar: !!document.querySelector('.view-toolbar, #view-fit, #view-100, #view-out, #view-in'),
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
      assert(!u.hasDeadViewToolbar, '画布右下角的视图工具栏已删除（曾是无绑定的死按钮）；缩放请走快捷键')
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

    /*
     * 油漆桶**真实鼠标**路径：这条守的是"画布层的连通判定"。
     * 它原先自己写了一份 BFS，与 core 的 `floodFillRegion` 规则已经分叉（透明格是否连通），
     * 现在统一走 core——算子路径（`edit([{op:'fill'}])`）另有断言，但那条不经过画布适配，
     * 覆盖不到"线性索引 → 格子坐标"这一步。
     */
    await cdp.eval(`(() => {
      const ps = window.pixelArtStudio
      ps.newCanvas({ width: 16, height: 16, color: '#ffffff' })
      ps.setTool('bucket')
      ps.setPrimary('#ff0000')
      return true
    })()`)
    await new Promise((r) => setTimeout(r, 200))
    const bucketCell = JSON.parse(await cdp.eval(`(() => {
      const v = JSON.parse(document.getElementById('board').dataset.lastDraw)
      const r = document.getElementById('board').getBoundingClientRect()
      return JSON.stringify({ x: r.left + v.ox + (8 + 0.5) * v.cell, y: r.top + v.oy + (8 + 0.5) * v.cell })
    })()`))
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bucketCell.x, y: bucketCell.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bucketCell.x, y: bucketCell.y, button: 'left', clickCount: 1 })
    await new Promise((r) => setTimeout(r, 250))
    const bucket = JSON.parse(await cdp.eval(`JSON.stringify(window.pixelArtStudio.getUsage())`))
    check('油漆桶（真实鼠标）：整片同色区域被一次填满（画布层复用 core 的连通判定）', () => {
      assert(bucket['#ff0000'] === 256, `16×16 全同色画布应被整片填成红色，实际 ${JSON.stringify(bucket)}`)
      return `#ff0000 覆盖 ${bucket['#ff0000']} 格`
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
      // 撤销栈的**字节记账**：旧实现只有硬编码的 50 帧、没有字节数，
      // 于是 limits.ts 里的 HISTORY_MAX_BYTES 从来没生效（2048² 带 alpha 单帧 8MB × 50 ≈ 400MB）。
      const info = ps.getInfo()
      const per = info.width * info.height * (info.hasAlpha ? 2 : 1)
      const s = window.__app.history.stats()
      return JSON.stringify({ changed: before !== afterEdit, undone: before === afterUndo, redone: afterRedo === afterEdit,
        stats: s, perFrame: per })
    })()`)
    check('撤销 / 重做：edit → undo → redo 状态可逆，且撤销栈按上限记账', () => {
      const u = JSON.parse(undoRedo)
      assert(u.changed, 'edit 应改变画布')
      assert(u.undone, 'undo 应回到编辑前')
      assert(u.redone, 'redo 应回到编辑后')
      assert(u.stats.past >= 1 && u.stats.future === 0, `栈状态不对：${JSON.stringify(u.stats)}`)
      // 旧实现只有硬编码的 50 帧、**一个字节都不记**（limits 里的 HISTORY_MAX_BYTES 从未生效）
      assert(u.stats.bytes > 0, `撤销栈应当有字节记账，实际 ${u.stats.bytes}`)
      assert(u.stats.bytes <= HISTORY_MAX_BYTES, `撤销栈字节超上限：${u.stats.bytes} > ${HISTORY_MAX_BYTES}`)
      assert(
        u.stats.past <= HISTORY_MAX_FRAMES && u.stats.future <= HISTORY_MAX_FRAMES,
        `帧数超上限：${JSON.stringify(u.stats)} > ${HISTORY_MAX_FRAMES}`,
      )
      return `可逆；${u.stats.past} 帧 / ${u.stats.bytes} 字节（上限 ${HISTORY_MAX_FRAMES} 帧 / ${HISTORY_MAX_BYTES} 字节）`
    })

    /*
     * 算子编辑（`ps.edit`）与画布副本的同步 —— 跨路径断言，本轮新增。
     *
     * 守的是一个**数据丢失级**缺陷：`ps.edit` 走画布自身的提交回调，只换了模型 `app.art`，
     * 而画布闭包里的 `indices`/`palette`/`alpha` 是另一份副本（ui/canvas.ts）。后果连锁三环：
     *   ① 屏幕不显示这次编辑（draw() 画的是画布旧副本）；
     *   ② 画布侧取色 `pickAt` 读到旧像素（表现为 Alt+点击/吸管取到"编辑前"的颜色）；
     *   ③ **下一次画笔把旧副本提交上去，把整幅算子编辑静默覆盖掉**（实测：编辑后 usage 有 #cc0000，
     *      再画一笔后变成 {#ffffff:255,#0000ff:1}，红格消失）。
     *
     * 为什么原有断言全都没抓到：模型侧（artHash/getUsage）与画布侧（真实鼠标）**各自都被测过，
     * 但从未交叉**。所以这里刻意两条腿都用上——先用**像素采样**看屏幕（不看模型），
     * 再叠一次真实鼠标笔触看算子编辑是否还在。
     * 见 docs/ARCHITECTURE.md §8.10 ⑥。
     */
    const syncPixel = async (cx, cy) =>
      await cdp.eval(`(() => {
        const b = document.getElementById('board')
        const v = JSON.parse(b.dataset.lastDraw)
        const dpr = b.width / b.getBoundingClientRect().width
        const x = (v.ox + (${cx} + 0.5) * v.cell) * dpr, y = (v.oy + (${cy} + 0.5) * v.cell) * dpr
        const d = b.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data
        return [d[0], d[1], d[2], d[3]].join(',')
      })()`)
    await cdp.eval(`(() => {
      const ps = window.pixelArtStudio
      ps.newCanvas({ width: 16, height: 16, color: '#ffffff' })
      ps.setPrimary('#0000ff')
      ps.setTool('pencil')
      ps.setBrushSize(1)
    })()`)
    await sleep(400)
    await cdp.eval(`window.pixelArtStudio.edit([{ op: 'setCells', cells: [[8, 8]], color: '#cc0000' }])`)
    await sleep(500)
    const opPixel = await syncPixel(8, 8)
    const stroke = JSON.parse(await cdp.eval(`(() => {
      const b = document.getElementById('board')
      const v = JSON.parse(b.dataset.lastDraw)
      const r = b.getBoundingClientRect()
      return JSON.stringify({ x: r.left + v.ox + 2.5 * v.cell, y: r.top + v.oy + 2.5 * v.cell })
    })()`))
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: stroke.x, y: stroke.y })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: stroke.x, y: stroke.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: stroke.x, y: stroke.y, button: 'left', clickCount: 1 })
    await sleep(600)
    const afterStroke = JSON.parse(await cdp.eval(`JSON.stringify(window.pixelArtStudio.getUsage())`))
    check('算子编辑（ps.edit）：屏幕当场显示，且随后的画笔不会把它盖掉（跨路径）', () => {
      assert(opPixel === '204,0,0,255', `渲染出来的画布上格(8,8)应是 #cc0000，实际 rgba(${opPixel})——画布没被回灌？`)
      assert('#cc0000' in afterStroke, `画一笔后算子编辑的颜色应仍在，实际 ${JSON.stringify(afterStroke)}——画布拿旧副本覆盖了模型`)
      assert('#0000ff' in afterStroke, `画笔本身也要生效，实际 ${JSON.stringify(afterStroke)}`)
      return `屏幕像素 rgba(${opPixel})；画笔后 usage ${JSON.stringify(afterStroke)}`
    })

    /*
     * 同一条路径的**尺寸变化**分支：算子里含 `transform`/`trim` 时画布必须重算视图，
     * 且模型宽高不能丢（旧实现只把 indices/palette/alphaMask 交给提交，`{...app.art}` 保留了旧宽高，
     * 于是 getInfo().width 与 indices 长度不一致）。
     */
    await cdp.eval(`(() => {
      const ps = window.pixelArtStudio
      ps.newCanvas({ width: 24, height: 24, transparent: true })
      ps.edit([{ op: 'setCells', cells: [[5, 7]], color: '#ff0000' }])
    })()`)
    await sleep(400)
    await cdp.eval(`window.pixelArtStudio.edit([{ op: 'trim' }])`)
    await sleep(600)
    const trimState = JSON.parse(await cdp.eval(`JSON.stringify({
      info: window.pixelArtStudio.getInfo(),
      drawn: JSON.parse(document.getElementById('board').dataset.lastDraw),
    })`))
    const trimPixel = await syncPixel(0, 0)
    check('算子编辑改尺寸（trim）：模型宽高、画布绘制尺寸、屏幕内容三者一致', () => {
      const { info, drawn } = trimState
      assert(info.width === 1 && info.height === 1, `24×24 里只有一格内容，trim 后应为 1×1，实际 ${info.width}×${info.height}`)
      assert(drawn.w === info.width && drawn.h === info.height, `画布绘制尺寸 ${drawn.w}×${drawn.h} 应与模型 ${info.width}×${info.height} 一致（尺寸变化没同步？）`)
      assert(trimPixel === '255,0,0,255', `裁切后唯一那格应是 #ff0000，实际 rgba(${trimPixel})`)
      return `1×1，屏幕 rgba(${trimPixel})`
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
     * （视口已在 suite 开始时统一设成 1400×900，见上面那句 setDeviceMetricsOverride。）
     */
    await new Promise((r) => setTimeout(r, 200))
    const matteBox = JSON.parse(await cdp.eval(`(() => {
      const el = document.querySelector('[data-testid="matte-swatch"]')
      if (!el) return JSON.stringify({ error: '参数面板里找不到合成底色色块' })
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      const top = document.elementFromPoint(x, y)
      // 色块按钮里的圆形色片必须显示**当前**合成底色：外观同步逻辑搬进工厂后
      // （改用 setAttribute('style') 而非建节点时的 style 对象），这里顺手锁一下。
      // 期望值从页内 API 现读，不写死——默认底色是 #ffffff，写死一个值只会测出我自己的假设。
      const cur = window.pixelArtStudio.getInfo().params.matteColor
      const n = parseInt(cur.slice(1), 16)
      const chip = el.querySelector('.chip')
      const hexSpan = el.querySelector('.color-pick-hex')
      return JSON.stringify({ x, y,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        chipBg: chip ? getComputedStyle(chip).backgroundColor : '',
        chipWant: 'rgb(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ')',
        hexText: hexSpan ? hexSpan.textContent : '',
        hexWant: cur.toUpperCase(),
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
      assert(matteBox.chipBg === matteBox.chipWant, `色块里的色片应显示当前合成底色（期望 ${matteBox.chipWant}），实际 ${matteBox.chipBg}`)
      assert(matteBox.hexText === matteBox.hexWant, `色块右侧的 hex 文案应同步当前底色（期望 ${matteBox.hexWant}），实际 ${matteBox.hexText}`)
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

    /*
     * 放大镜（"原图对照"）：导入后悬停画布应当出现。
     *
     * 这条守的是**死功能**这一类：`setReference` 曾经全仓没有调用点，canvas 内部的 refImage
     * 恒为 null，而 `updateMagnifier()` 的第一个守卫就是它——于是放大镜永远不出现，
     * 界面上也没有任何错误信号（只有参数面板里那个"笔刷预览 / 放大镜"勾选框在承诺它）。
     * 所以这里用**真实鼠标移动**触发悬停，并且同时断言"它真的画了内容"：
     * 只看 display:block 的话，画布空白同样会漏过去。
     */
    const magProbe = JSON.parse(await cdp.eval(`(() => {
      const b = document.getElementById('board')
      const r = b.getBoundingClientRect()
      if (r.width < 10 || r.height < 10) return JSON.stringify({ error: '画布没有布局尺寸' })
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
    })()`))
    if (!magProbe.error) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: magProbe.x, y: magProbe.y })
      await new Promise((r) => setTimeout(r, 120))
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: magProbe.x + 6, y: magProbe.y + 6 })
      await new Promise((r) => setTimeout(r, 300))
    }
    const mag = magProbe.error
      ? { error: magProbe.error }
      : JSON.parse(await cdp.eval(`(() => {
        const box = document.getElementById('magnifier')
        const cv = document.getElementById('magnifier-canvas')
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
        let painted = 0
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++
        return JSON.stringify({ display: getComputedStyle(box).display, painted, hover: window.__app.store.get('hoverText') })
      })()`))
    check('放大镜：导入后悬停画布会显示"原图对照"，且里面真的画了内容', () => {
      assert(!mag.error, mag.error)
      assert(mag.hover, '鼠标移动到画布上应产生悬停坐标（否则是悬停事件没派发，不是放大镜的问题）')
      assert(mag.display === 'block', `放大镜应当显示（display=${mag.display}）——检查是否又没人调 setReference 了`)
      assert(mag.painted > 100, `放大镜画布应当是空的（非空像素 ${mag.painted}）`)
      return `display=block / 非空像素 ${mag.painted} / 悬停 ${mag.hover}`
    })

    /*
     * 合成底色吸管的**去向**：这守的是"静默失效"的另一种形态——状态被设置了、提示语也说了，
     * 但全仓没有读取者。
     *
     * `pickIntoMatte` 原先只在 4 处被赋值，唯一一次"读取"是在 toast 文案里；画布的
     * `onPickColor` 从不看它。于是用户按提示点一格，颜色**悄悄写进了主色**，而合成底色纹丝不动——
     * 界面没有任何错误信号，这比直接报错更难发现。
     *
     * 这条用真实鼠标走完整链路（取色盘吸管 → 画布点一格），断言的是"颜色去了哪一路"，而不是
     * "点击有没有反应"——后者在错误实现下同样是绿的。
     */
    await cdp.eval(`(() => {
      const ps = window.pixelArtStudio
      ps.newCanvas({ width: 16, height: 16, color: '#3a7bd5' })
      ps.setParams({ matteColor: '#101010' })
      ps.setPrimary('#00ff00')
      return true
    })()`)
    await sleep(250)
    // 前面的"收起 / 点标签"断言会改变取色盘开合状态，这里先确保它是打开的
    if (!(await cdp.eval(`!!document.querySelector('#panel-params .cp')`))) {
      const sw = JSON.parse(await cdp.eval(`(() => {
        const el = document.querySelector('[data-testid="matte-swatch"]')
        el.scrollIntoView({ block: 'center' })
        const r = el.getBoundingClientRect()
        return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
      })()`))
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sw.x, y: sw.y, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sw.x, y: sw.y, button: 'left', clickCount: 1 })
      await sleep(250)
    }
    const straw = JSON.parse(await cdp.eval(`(() => {
      const el = document.querySelector('#panel-params .cp .cp-icon-btn')
      if (!el) return JSON.stringify({ error: '取色盘里找不到吸管按钮' })
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      const top = document.elementFromPoint(x, y)
      return JSON.stringify({ x, y, hitSelf: top ? el.contains(top) || top === el : false })
    })()`))
    if (!straw.error) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: straw.x, y: straw.y, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: straw.x, y: straw.y, button: 'left', clickCount: 1 })
      await sleep(200)
    }
    const strawCell = JSON.parse(await cdp.eval(`(() => {
      const v = JSON.parse(document.getElementById('board').dataset.lastDraw)
      const r = document.getElementById('board').getBoundingClientRect()
      return JSON.stringify({ x: r.left + v.ox + (8 + 0.5) * v.cell, y: r.top + v.oy + (8 + 0.5) * v.cell })
    })()`))
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: strawCell.x, y: strawCell.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: strawCell.x, y: strawCell.y, button: 'left', clickCount: 1 })
    await sleep(250)
    const strawPick = JSON.parse(await cdp.eval(`(() => {
      const i = window.pixelArtStudio.getInfo()
      return JSON.stringify({ matte: i.params.matteColor, primary: i.primary, tool: i.tool })
    })()`))
    check('合成底色吸管（真实鼠标）：取到的颜色写进合成底色，不改写主色', () => {
      assert(!straw.error, straw.error)
      assert(straw.hitSelf, `吸管按钮被盖住/点不到：落点 ${Math.round(straw.x)},${Math.round(straw.y)}`)
      assert(
        String(strawPick.primary).toLowerCase() === '#00ff00',
        `吸管取色不应改写主色，实际 ${strawPick.primary}（颜色被路由到主色 = pickIntoMatte 没被消费）`,
      )
      assert(
        String(strawPick.matte).toLowerCase() === '#3a7bd5',
        `吸管取色应写进合成底色，实际 ${strawPick.matte}（提示语承诺了却没兑现）`,
      )
      return `合成底色 → ${strawPick.matte}；主色保持 ${strawPick.primary}；工具 ${strawPick.tool}`
    })

    /*
     * 提示语里的「（Esc 取消）」也要能兑现：吸管的提示写了这句，而 Esc 原先只是清选区，
     * 工具会一直停在 picker 上。这里用真实按键验证它真的退出取色。
     */
    await cdp.eval(`window.pixelArtStudio.setTool('picker')`)
    await sleep(120)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(200)
    const escTool = await cdp.eval(`window.pixelArtStudio.getInfo().tool`)
    check('吸管：提示语承诺的「Esc 取消」真的能退出取色（回到画笔）', () => {
      assert(escTool === 'pencil', `Esc 应退出吸管工具，实际停在 ${escTool}`)
      return 'Esc → pencil'
    })

    /*
     * 「显示」区的勾选框：状态改了，但**没人通知画布重绘**。
     *
     * 这是"假功能"的又一变体（§8.10 的三种都不完全一样）：消费者存在——`draw()` 里确实读
     * `store.get('showGrid')` 决定画不画网格——缺的是**通知**。`store.set('showGrid', …)`
     * 只通知了「写偏好」那个订阅者，画布要等下一次无关的 `renderAll` 才跟着变。
     * 实测（probe）：点勾选框前后 `board.dataset.draws` 都是 1，网格线仍留在画面上。
     *
     * 断言用**真实鼠标**点勾选框，并用"画布墨量"（不透明像素的红通道之和）判断画布是否真的
     * 重绘过——只看 `store` 里的布尔值会漏掉这个 bug，因为标志位本来就是对的。
     * 画布用**黑色**：网格线是 `rgba(255,255,255,0.10)`，画在白色画布上肉眼与像素都分辨不出
     * （第一版探针就因此在白底上得出了"网格没画"的错误结论）。
     */
    await cdp.eval(`window.pixelArtStudio.newCanvas({ width: 16, height: 16, color: '#000000' })`)
    // 前面的断言会弹 toast（右下角浮层，活 4s），它正好压在参数面板底部这几个勾选框上，
    // 真实鼠标会点在 toast 上。这里直接清掉——等价于"等它自己消失"，只是确定且不用干等 4 秒。
    await cdp.eval(`document.querySelectorAll('#toasts > *').forEach((n) => n.remove())`)
    await sleep(300)
    const inkSum = async () =>
      Number(await cdp.eval(`(() => {
        const b = document.getElementById('board')
        const c = document.createElement('canvas')
        c.width = b.width; c.height = b.height
        const g = c.getContext('2d')
        g.drawImage(b, 0, 0)
        const d = g.getImageData(0, 0, c.width, c.height).data
        let s = 0
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) s += d[i]
        return s
      })()`))
    const gridBox = JSON.parse(await cdp.eval(`(() => {
      const i = [...document.querySelectorAll('#panel-params input[type=checkbox]')].find((x) => (x.nextElementSibling?.textContent || '').includes('网格线'))
      if (!i) return JSON.stringify({ error: '找不到「网格线」勾选框' })
      i.scrollIntoView({ block: 'center' })
      const r = i.getBoundingClientRect()
      const x = r.left + r.width / 2, y = r.top + r.height / 2
      const top = document.elementFromPoint(x, y)
      return JSON.stringify({ x, y, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        topTag: top ? top.tagName : '(null)', topClass: top ? String(top.className) : '',
        hitSelf: top ? i === top || i.contains(top) : false })
    })()`))
    const clickGrid = async () => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: gridBox.x, y: gridBox.y, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: gridBox.x, y: gridBox.y, button: 'left', clickCount: 1 })
      await sleep(300)
    }
    const gridInkOn = gridBox.error ? -1 : await inkSum()
    if (!gridBox.error) await clickGrid()
    const gridInkOff = gridBox.error ? -1 : await inkSum()
    const gridFlag = await cdp.eval(`window.__app.store.get('showGrid')`)
    check('显示勾选框：点「网格线」后画布立刻重绘（网格当场消失），而不是等下一次无关重绘', () => {
      assert(!gridBox.error, gridBox.error)
      assert(gridBox.hitSelf, `「网格线」勾选框被盖住/点不到：落点 ${Math.round(gridBox.x)},${Math.round(gridBox.y)} 矩形 ${gridBox.rect}，命中 <${gridBox.topTag} class="${gridBox.topClass}">`)
      assert(gridFlag === false, `点一下应把 showGrid 关掉，实际 ${gridFlag}`)
      assert(gridInkOff !== gridInkOn, `画布没有任何变化（墨量和 ${gridInkOn}）——勾选框只改了状态、没人通知画布重绘`)
      return `网格墨量 ${gridInkOn} → ${gridInkOff}（画布确实重绘了）`
    })
    // 复位：把网格开回来，别把"关着网格"的状态留给后面的断言
    if (!gridBox.error) await clickGrid()

    /*
     * 「? 也能打开快捷键速查」是顶栏那个按钮 **tooltip 里写的承诺**，而全仓没有任何
     * `?` / `Slash` 的键盘处理——按了没反应。这正是 §8.10 那类"界面上承诺了能力却没有实现"，
     * 只是这次承诺写在 title 属性里（更容易漏：静态审阅只 grep 代码，不会去读 tooltip）。
     *
     * 速查表自己还写着"快捷键以本表为唯一出处"，而表里没有 `?` 这一行——两处界面互相矛盾，
     * 所以修法是**实现它并补进表里**，而不是删掉 tooltip 那句话。
     *
     * 按之前先点一下画布：全局快捷键的守卫是"焦点在 INPUT/TEXTAREA/SELECT 上就让路"
     * （别在输入框里抢按键），而上一条断言刚点过一个 checkbox，焦点还在它身上。
     * 真实用户按 `?` 时焦点通常在画布/页面上，这里照那个顺序来。
     */
    const focusPt = JSON.parse(await cdp.eval(`(() => {
      const b = document.getElementById('board').getBoundingClientRect()
      return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2),
        active: document.activeElement ? document.activeElement.tagName : '(none)' })
    })()`))
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: focusPt.x, y: focusPt.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: focusPt.x, y: focusPt.y, button: 'left', clickCount: 1 })
    await sleep(200)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '?', code: 'Slash', modifiers: 8, windowsVirtualKeyCode: 191 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '?', code: 'Slash', modifiers: 8, windowsVirtualKeyCode: 191 })
    await sleep(250)
    const helpOpen = await cdp.eval(`!!document.querySelector('.modal-mask')`)
    const helpRow = await cdp.eval(`(() => {
      const m = document.querySelector('.modal-mask')
      return m ? [...m.querySelectorAll('td')].map((td) => td.textContent).join('|') : ''
    })()`)
    check('快捷键：按 `?` 能打开速查表（tooltip 承诺过），且表里列出这一条', () => {
      assert(helpOpen, `按 \`?\` 应打开快捷键速查表——顶栏按钮的 tooltip 写了「按 ? 也能打开」（按之前焦点在 ${focusPt.active}）`)
      assert(helpRow.includes('?'), '速查表里应有 `?` 这一行（表自称是快捷键的唯一出处）')
      return '? → 速查表已打开'
    })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(200)

    check('运行期无控制台错误', () => {
      assert(consoleErrors.length === 0, `控制台报错 ${consoleErrors.length} 条：${consoleErrors.slice(0, 2).join(' | ')}`)
      return '0 条'
    })
  } finally {
    await session.close()
  }

  report()
}

main().catch((err) => {
  console.error(`端到端测试无法运行：${err?.message ?? err}`)
  process.exit(1)
})
