/**
 * 折叠交互的独立验证脚本（不属于 verify 链，按需手动跑）。
 *
 * 与 e2e 里那条"全部分组都能折叠/展开"的分工：
 *   · e2e 那条读 `aria-expanded` 与主体高度，跑在每次 verify 里，是**回归防线**；
 *   · 本脚本做**独立复核**，不看属性、只看**真实控件在屏幕上的可见性**
 *     （offsetParent / getBoundingClientRect / 是否被遮挡），并且逐组截图。
 *
 * 为什么值得单独复核：断言读的是"实现自己声明的状态"，而用户感知的是"控件看不看得见"。
 * 两者可能不一致（例如属性改了但 CSS 没生效、或被其他元素盖住）——本项目在 §8.10
 * 记过"状态对了不等于画面对了"的事故。这里用不同的手段交叉验证一次。
 *
 * 用法：node tool/verify-sections.mjs
 */
import { mkdirSync } from 'node:fs'
import { startBrowser, sleep } from './cdp.mjs'

const APP = 'F:/<项目目录>/像素画工作台.html'
const SHOT_DIR = 'F:/<项目目录>/.tmp-shots/sections'

/** 每个分组里"最有代表性的控件"——用它来判断这一组是否真的显示了内容 */
const PROBE = {
  size: 'select',
  crop: 'select',
  palette: 'select',
  downsample: 'select',
  dither: 'select',
  cleanup: 'input[type=checkbox]',
  adjust: 'input.num',
  matte: '[data-testid="matte-swatch"]',
  display: '[data-testid="toggle-grid"]',
}

const IDS = Object.keys(PROBE)

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true })
  const { cdp, close } = await startBrowser()
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.navigate', { url: `file:///${APP}` })

  for (let i = 0; i < 60; i++) {
    let ready = false
    try {
      ready = await cdp.eval('!!window.pixelArtStudio')
    } catch {
      /* 导航中求值会抛错 */
    }
    if (ready) break
    await sleep(200)
  }

  const clickHead = async (id) => {
    // 清 toast：它 position:fixed、z-index 高于面板，会挡住点击（e2e 里踩过）
    await cdp.eval(`document.querySelectorAll('#toasts > *').forEach((n) => n.remove())`)
    const pos = JSON.parse(
      await cdp.eval(`(() => {
        const h = document.querySelector('[data-testid="section-head-${id}"]')
        if (!h) return JSON.stringify({ error: '找不到分组标题' })
        h.scrollIntoView({ block: 'center' })
        const r = h.getBoundingClientRect()
        const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
        const top = document.elementFromPoint(x, y)
        return JSON.stringify({
          x, y,
          // 命中测试：确认落点真的在标题栏上，而不是被别的元素盖住
          hitsHead: top === h || (h.contains ? h.contains(top) : false),
          hitWhat: top ? top.tagName + '.' + String(top.className).slice(0, 24) : null,
        })
      })()`),
    )
    if (pos.error) throw new Error(`${id}: ${pos.error}`)
    if (!pos.hitsHead) throw new Error(`${id}: 标题栏被遮挡，落点命中 ${pos.hitWhat}`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await sleep(180)
  }

  /** 读"真实可见性"：不信任 aria-expanded，直接看控件在屏幕上的状态 */
  const probe = async (id) =>
    JSON.parse(
      await cdp.eval(`(() => {
        const ctx = window.__probeCtx = window.__probeCtx || {}
        const head = document.querySelector('[data-testid="section-head-${id}"]')
        const body = document.querySelector('[data-testid="section-body-${id}"]')
        const core = body ? body.querySelector(${JSON.stringify(PROBE[id])}) : null
        let visible = false, inViewport = false, occluded = false
        if (core) {
          const r = core.getBoundingClientRect()
          // 真实可见 = 有尺寸 + 未被 display:none/visibility:hidden 隐藏 + 在视口内
          visible = r.width > 0 && r.height > 0 && core.offsetParent !== null && getComputedStyle(core).visibility !== 'hidden'
          inViewport = visible && r.top >= 0 && r.bottom <= window.innerHeight
          if (visible && inViewport) {
            const t = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
            // 被别的元素挡住：落点命中的既不是它自己、也不是它的子/父
            occluded = !(t === core || core.contains(t) || (t && t.contains(core)))
          }
        }
        return JSON.stringify({
          expanded: head ? head.getAttribute('aria-expanded') : null,
          caret: head ? (head.querySelector('.panel-caret') || {}).textContent : null,
          bodyH: body ? Math.round(body.getBoundingClientRect().height) : -1,
          coreFound: !!core,
          coreVisible: visible,
          inViewport,
          occluded,
        })
      })()`),
    )

  /*
   * ① 初始状态必须是**全部收起**。
   *
   * 这条守的是"右栏不要有的展开有的收起"这个明确要求（用户提出）。
   * 加它的理由：折叠功能本身早就有断言（下面的逐组展开/收起），但"初始状态"没有——
   * 于是把某组默认值改回 true 不会让任何断言变红。
   */
  const initial = []
  for (const id of IDS) initial.push({ id, ...(await probe(id)) })
  const expandedAtStart = initial.filter((s) => s.expanded !== 'false' || s.bodyH !== 0)
  console.log('初始状态检查：')
  for (const s of initial) console.log(`  ${s.expanded === 'false' && s.bodyH === 0 ? '✔' : '✘'} ${s.id.padEnd(11)} aria-expanded=${s.expanded} 主体高度=${s.bodyH}`)
  if (expandedAtStart.length) {
    console.log(`\n✘ 以下分组默认是展开的（要求全部默认收起）：${expandedAtStart.map((s) => s.id).join(' ')}`)
  } else {
    console.log('✔ 全部分组默认收起\n')
  }

  const rows = []
  for (const id of IDS) {
    // 先确保展开（幂等）
    let s = await probe(id)
    if (s.expanded === 'false') {
      await clickHead(id)
      s = await probe(id)
    }
    const openState = s

    await clickHead(id)
    const closedState = await probe(id)

    await clickHead(id)
    const reopenState = await probe(id)

    const checks = {
      // 展开时：控件真实可见
      openVisible: openState.coreVisible === true,
      // 收起时：控件不可见（且属性为 false）
      closedHidden: closedState.expanded === 'false' && closedState.coreVisible === false && closedState.bodyH === 0,
      // 再展开：回到可见
      reopenVisible: reopenState.expanded === 'true' && reopenState.coreVisible === true,
      // 三角指示符跟着变
      caretToggles: openState.caret !== closedState.caret,
    }
    const ok = Object.values(checks).every(Boolean)
    rows.push({ id, ok, checks, openState, closedState, reopenState })

    console.log(
      `${ok ? '✔' : '✘'} ${id.padEnd(11)} ` +
        `展开[可见=${openState.coreVisible} h=${openState.bodyH}] ` +
        `→ 收起[属性=${closedState.expanded} 可见=${closedState.coreVisible} h=${closedState.bodyH}] ` +
        `→ 再展开[可见=${reopenState.coreVisible}] ` +
        `三角 ${openState.caret}→${closedState.caret}`,
    )
  }

  // 逐组截图（展开态），供人工看画面
  for (const id of IDS) {
    const { cdp: _c } = { cdp }
    const box = JSON.parse(
      await cdp.eval(`(() => {
        const s = document.querySelector('[data-testid="section-${id}"]')
        if (!s) return JSON.stringify({ error: 1 })
        s.scrollIntoView({ block: 'center' })
        const r = s.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })
      })()`),
    )
    if (box.error || box.w <= 0 || box.h <= 0) continue
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 2 },
    })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(`${SHOT_DIR}/${id}.png`, Buffer.from(shot.data, 'base64'))
  }
  console.log(`\n逐组截图已存：${SHOT_DIR}`)

  const bad = rows.filter((r) => !r.ok)
  console.log(bad.length ? `\n✘ ${bad.length} 个分组异常：${bad.map((b) => b.id).join(' ')}` : `\n✔ ${rows.length} 个分组：展开可见 / 收起隐藏 / 再展开恢复 / 三角跟随，全部正常`)
  await close()
  // "初始状态全部收起"也计入失败：否则这条只打印、脚本仍以 0 退出，CI 里看不出问题
  const failed = bad.length + expandedAtStart.length
  if (expandedAtStart.length) console.log(`（另有 ${expandedAtStart.length} 个分组未按"默认收起"）`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(`验证脚本出错：${err?.message ?? err}`)
  process.exit(1)
})
