#!/usr/bin/env node
/**
 * 工作色板编辑专项验证（微调颜色 / 替换颜色 / Esc 取消）。
 *
 * 背景：像素存的是**色板下标**，所以"改色板第 i 项"就等于改全图用该色的格子。这条链路短得
 * 容易让人以为不会出错，但它踩过两个真实的坑，都靠这里的断言钉住：
 *
 *  1. **只改显示、忘了模型**（或反过来）：画布/模型是两份数据，只同步一边就会出现
 *     "屏幕变了但导出没变"或"模型变了但屏幕没变"。所以下面既采样**屏幕像素**
 *     （`getImageData`，不看模型），又断言模型与撤销栈。
 *  2. **合并重复色时的下标重映射**：删掉色板第 i 项会让其后所有下标前移 1。
 *     写错不会报错，只会让整张图**静默错位**——所以这条按"用量守恒 + 逐格颜色一致"断言，
 *     而不是只看"色板长度少了一个"。
 *
 * 另外两条手势约定也在这里锁住：
 *  - **右键 = 放弃**（色板编辑器与参数滑条都是），且**不产生撤销帧**；
 *  - 一次编辑会话 = **恰好一条**撤销（中间拖多少下都算同一次）。
 *
 * 用法：node tool/e2e-palette.mjs [--app <html 路径>]
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { argValue, createChecker, startBrowser, sleep } from './cdp.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const { check, assert, report } = createChecker('色板编辑验证')

const app = argValue('app', join(ROOT, '像素画工作台.html'))
if (!existsSync(app)) throw new Error(`找不到 ${app}，先跑 npm run build`)

const session = await startBrowser({ profilePrefix: 'palette-e2e-' })
const { cdp } = session

/** 真实鼠标：`buttons` 在按下/移动时必须带 1，否则浏览器不认为是拖动 */
const mouse = (type, x, y, button = 'left', buttons) =>
  cdp.send('Input.dispatchMouseEvent', {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button,
    clickCount: 1,
    ...(buttons !== undefined ? { buttons } : {}),
  })

const evalJson = async (expr) => JSON.parse(await cdp.eval(`JSON.stringify(${expr})`))

/** 某个 `data-testid` 元素中心的屏幕坐标 */
const posOf = (testid, opts = {}) =>
  evalJson(`(() => {
    const b = document.querySelector('[data-testid=${JSON.stringify(testid)}]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + (${opts.top ?? 0.5}) * r.height, w: r.width, h: r.height, left: r.left, top: r.top }
  })()`)

/** 真实鼠标点击某元素中心 */
async function clickTestId(testid, opts = {}) {
  const p = await posOf(testid, opts)
  if (!p) throw new Error(`找不到 [data-testid=${testid}]`)
  await mouse('mousePressed', p.x, p.y)
  await mouse('mouseReleased', p.x, p.y, 'left', 0)
  await sleep(220)
}

/** 真实右键（Windows 与 macOS 的 contextmenu 时机不同，两条事件都给足） */
async function rightClick(x, y) {
  await mouse('mousePressed', x, y, 'right', 2)
  await sleep(60)
  await mouse('mouseReleased', x, y, 'right', 0)
  await sleep(220)
}

/** 画布上某格中心的屏幕像素（**不读模型**——专门用来抓"没回灌画布"那一类缺陷） */
const pixelAt = (cx, cy) =>
  cdp.eval(`(() => {
    const b = document.getElementById('board')
    const v = JSON.parse(b.dataset.lastDraw)
    const r = b.getBoundingClientRect()
    const dpr = b.width / r.width
    const x = Math.round((v.ox + (${cx} + 0.5) * v.cell) * dpr)
    const y = Math.round((v.oy + (${cy} + 0.5) * v.cell) * dpr)
    const d = b.getContext('2d').getImageData(x, y, 1, 1).data
    return d[0] + ',' + d[1] + ',' + d[2] + ',' + d[3]
  })()`)

const uiState = () =>
  evalJson(`({
    palette: window.pixelArtStudio.getPalette(),
    usage: window.pixelArtStudio.getUsage(),
    hash: window.pixelArtStudio.artHash(),
    past: window.__app.history.stats().past,
    editorOpen: !!document.querySelector('[data-testid="swatch-editor"] .cp'),
    editorInPanel: !!document.querySelector('#panel-palette [data-testid="swatch-editor"] .cp'),
    menuOpen: !!document.querySelector('[data-testid="ctx-menu"]'),
  })`)

/** 在编辑器的 Hex 行里输入一个颜色并提交（比拖色轮精确，且不依赖色轮几何） */
async function typeEditorHex(hex) {
  const ok = await cdp.eval(`(() => {
    const i = document.querySelector('.swatch-editor .cp-hexrow .cp-num')
    if (!i) return false
    i.value = ${JSON.stringify(hex)}
    i.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  assert(ok, '编辑器里找不到 Hex 输入框')
  await sleep(280)
}

/** 在色轮上按下并拖到指定半径比例处（0 = 圆心，1 = 外圈） */
async function dragWheel(radius) {
  const geo = await evalJson(`(() => {
    const c = document.querySelector('[data-testid="swatch-editor"] .cp-wheel')
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { left: r.left, top: r.top, w: r.width, h: r.height }
  })()`)
  assert(geo, '编辑器里找不到色轮')
  const cx = geo.left + geo.w / 2
  const cy = geo.top + geo.h / 2
  await mouse('mousePressed', cx, cy, 'left', 1)
  await sleep(70)
  await mouse('mouseMoved', cx, cy - (geo.h / 2) * radius, 'left', 1)
  await sleep(120)
  return { cx, cy, geo }
}

/** 松掉左键（协作式收尾：拖动测试可能在中途失败，留下按住状态会污染后续断言） */
async function releaseLeft(x, y) {
  await mouse('mouseReleased', Math.round(x), Math.round(y), 'left', 0)
  await sleep(120)
}

await cdp.send('Runtime.enable')
await cdp.send('Page.enable')
// 桌面视口：窄屏规则会把左栏收成抽屉，色板没有布局尺寸，几何断言会全部失真
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })

// 控制台错误也要盯：新取色器任何异常都该在这里现形
const consoleErrors = []
cdp.ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
    consoleErrors.push(msg.params.args?.map((a) => a.value ?? a.description).join(' '))
  }
})

await cdp.send('Page.navigate', { url: pathToFileURL(app).href })
for (let i = 0; i < 60; i++) {
  if (await cdp.eval('!!window.pixelArtStudio')) break
  await sleep(200)
}

/*
 * 造一张**确定的**三色画布，不复用外部素材：
 * 底色 #ffffff（整幅），左上 6×6 = #ff0000，右下 6×6 = #00ff00。
 * 于是用量是 72 / 36 / 36，任何一步改动都能用"格数守恒"来判对错。
 */
await cdp.eval(`(() => {
  const ps = window.pixelArtStudio
  ps.newCanvas({ width: 12, height: 12, color: '#ffffff' })
  ps.edit([{ op: 'rect', x0: 0, y0: 0, x1: 5, y1: 5, color: '#ff0000' }])
  ps.edit([{ op: 'rect', x0: 6, y0: 6, x1: 11, y1: 11, color: '#00ff00' }])
  return true
})()`)
await sleep(400)

const base = await uiState()
const RED = base.palette.indexOf('#ff0000')
const GREEN = base.palette.indexOf('#00ff00')
assert(RED >= 0 && GREEN >= 0, `测试画布没造出预期的三色，实际色板：${JSON.stringify(base.palette)}`)
const cellsOf = (u) => Object.values(u).reduce((a, b) => a + b, 0)
const baseCells = cellsOf(base.usage)

/* ---------------------------------------------- 右键菜单 */

await check('右键色块弹出的菜单含「微调此颜色…」与「替换为…」两项', async () => {
  const p = await posOf(`swatch-${RED}`)
  await rightClick(p.x, p.y)
  const labels = await cdp.eval(`JSON.stringify([...document.querySelectorAll('[data-testid="ctx-menu"] .di-label')].map((n) => n.textContent))`)
  const s = await uiState()
  assert(s.menuOpen, '右键色块后没有出现菜单（未绑定 contextmenu？）')
  const arr = JSON.parse(labels)
  assert(arr.length === 2, `菜单应有 2 项，实际 ${JSON.stringify(arr)}`)
  assert(arr[0].includes('微调'), `第一项应是微调，实际「${arr[0]}」`)
  assert(arr[1].includes('替换'), `第二项应是替换，实际「${arr[1]}」`)
  return arr.join(' / ')
})

/* ---------------------------------------------- 微调：实时预览 */

await check('「微调此颜色…」：取色器就地展开在左栏色板列里，且源色块被高亮', async () => {
  await clickTestId('swatch-menu-tune')
  const s = await uiState()
  assert(s.editorOpen, '选了微调后取色器没有出现')
  // 「就地」是 matte-field 记过的坑：跑到别的面板去，用户视线不在这儿，反馈等于没发生
  assert(s.editorInPanel, '取色器不在 #panel-palette 内（跑到别的面板去了）')
  const cls = await cdp.eval(`document.querySelector('[data-testid="swatch-${RED}"]').className`)
  assert(cls.includes('editing'), `源色块应带 editing 高亮，实际 class=「${cls}」`)
  const title = await cdp.eval(`document.querySelector('.swatch-editor-title').textContent`)
  assert(title.includes('#ff0000'), `标题应写明正在改哪个色，实际「${title}」`)
  /*
   * 「点得动」不等于「看得见结果」（docs/开发.md §3.2 第 5 条，本项目真实踩过）：
   * 断言标题行与「完成」按钮**真的落在视口里**。取色器本体近 900px 高，左栏又是滚动容器——
   * 把操作头放在取色器下方时，它会整条掉到屏幕外，用户点完只看到色轮、找不到怎么结束。
   */
  const vis = await evalJson(`(() => {
    const h = document.querySelector('.swatch-editor-head')
    const b = document.querySelector('[data-testid="swatch-editor-done"]')
    const inView = (n) => {
      if (!n) return false
      const r = n.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight
    }
    return { head: inView(h), done: inView(b) }
  })()`)
  assert(vis.head, '编辑器标题行不该在视口外（用户看不到"在改哪个色"）')
  assert(vis.done, '「完成」按钮不该在视口外（用户找不到怎么提交）——操作头必须排在取色器上方')
  return `${title} · 高亮已加 · 标题与「完成」均在视口内`
})

await check('拖动色轮：**画布屏幕像素当场变化**（不是松手才变），且拖动中取色器不消失', async () => {
  const before = await pixelAt(2, 2)
  const { cx, cy } = await dragWheel(0.95)
  const during = await pixelAt(2, 2)
  /*
   * 三点采样（按下后 / 移动后 / 松手前都看得见取色器）：
   * 宿主一旦被重渲染摘出文档，指针捕获就断，表现为"一拖就断"。
   */
  const stillOpen = await cdp.eval(`!!document.querySelector('[data-testid="swatch-editor"] .cp')`)
  assert(stillOpen, '拖动中取色器消失了（宿主被重渲染摘掉了？）')
  assert(before !== during, `拖动中画布像素没变（${before} → ${during}）：预览没推到画布`)
  // 还没松手：模型与撤销栈都必须原样
  const s = await uiState()
  assert(s.palette[RED] === '#ff0000', `预览期间模型不该变，实际 ${s.palette[RED]}`)
  assert(s.past === base.past, `预览不该产生撤销帧，实际 past=${s.past}`)
  await mouse('mouseReleased', cx, cy, 'left', 0)
  await sleep(150)
  return `像素 ${before} → ${during}；模型与撤销栈未动`
})

/* ---------------------------------------------- 微调：Esc 放弃 */

await check('Esc 放弃：画布还原、编辑器关闭、**不产生撤销帧**', async () => {
  const beforeAbandonPalette = (await uiState()).palette[RED]
  // Esc 是取消键（右键取消已按用户反馈移除；浏览器里右键自带上下文菜单语义）
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(280)
  const s = await uiState()
  assert(!s.editorOpen, 'Esc 后编辑器没有关闭')
  assert(s.past === base.past, `放弃不该产生撤销帧，实际 past=${s.past}（基准 ${base.past}）`)
  assert(s.palette[RED] === beforeAbandonPalette, `放弃不该改模型，实际 ${s.palette[RED]}`)
  // 画布要还原成源色（红），不能停在预览色
  const px = await pixelAt(2, 2)
  assert(px === '255,0,0,255', `画布应还原为 #ff0000，实测像素 ${px}`)
  return `past=${s.past} 未增；画布还原为 ${px}`
})

/* ---------------------------------------------- 微调：提交 */

await check('「完成」提交：模型色板更新、**一次会话只 +1 条撤销**（中途拖两次也只算一次）', async () => {
  const menu = await posOf(`swatch-${RED}`)
  await rightClick(menu.x, menu.y)
  await clickTestId('swatch-menu-tune')
  // 拖两次色轮：会话级提交下应当仍只产生一条撤销
  const first = await dragWheel(0.9)
  await releaseLeft(first.cx, first.cy)
  const second = await dragWheel(0.5)
  await releaseLeft(second.cx, second.cy)
  await clickTestId('swatch-editor-done')
  const s = await uiState()
  assert(!s.editorOpen, '「完成」后编辑器应关闭')
  assert(s.past === base.past + 1, `一次编辑会话应只 +1 条撤销，实际 past=${s.past}（基准 ${base.past}）`)
  assert(s.palette[RED] !== '#ff0000', `模型色板应已更新，实际仍为 ${s.palette[RED]}`)
  assert(s.hash !== base.hash, 'artHash 应随色板改动而变')
  const cells = cellsOf(s.usage)
  assert(cells === baseCells, `改色不改像素，总格数必须守恒：${baseCells} → ${cells}`)
  return `palette[${RED}]=${s.palette[RED]}；past=${s.past}；格数 ${cells} 守恒`
})

await check('切换 / 重新打开色块：上一轮的改动**自动提交**，不得静默丢失', async () => {
  /*
   * 这一条锁的是会话级提交最容易出的一类缺陷（实现里踩过两次）：
   * 用户改完色块 A 不点「完成」、直接去改色块 B（或再点一次 A），A 的调整就**无声无息消失**了——
   * 既没提交、也没提示，而用户看到的是自己刚调好的颜色不见了。
   *
   * 会话级提交是为了让**取消**成为纯取消，不该顺带把"切目标 / 重新打开"也变成取消。
   * 三种情形一起验，缺一种就可能只修了其中一半（第一版只修了"切到不同色块"）。
   *
   * ⚠️ 本用例会**改动两处色板颜色**，所以结尾必须把它们撤回去：
   * 后面的用例依赖 `#ff0000` / `#00ff00` 仍各自占着格子（合并与替换那两条）。
   * 一条断言污染共享状态、让后面几条以"前置条件不满足"的形式变红，是最难查的假红。
   */
  const before = await uiState()
  const target = before.palette.indexOf('#00ff00')
  assert(target >= 0, '前置条件不满足：找不到 #00ff00')
  const undoBack = async (n) => {
    for (let k = 0; k < n; k++) {
      await cdp.eval('window.pixelArtStudio.undo()')
      await sleep(220)
    }
  }

  // ① 改 A 后不提交，直接去改 B —— A 必须已提交
  const a = await posOf(`swatch-${target}`)
  await rightClick(a.x, a.y)
  await clickTestId('swatch-menu-tune')
  await typeEditorHex('#0000ff')
  const b = await posOf(`swatch-${RED}`)
  await rightClick(b.x, b.y)
  await clickTestId('swatch-menu-tune')
  await sleep(200)
  const afterSwitch = await uiState()
  assert(
    afterSwitch.palette[target] === '#0000ff',
    `切到另一个色块时，上一个色块的改动应已自动提交，实际 pal[${target}]=${afterSwitch.palette[target]}`,
  )
  assert(afterSwitch.past === before.past + 1, `切换应恰好提交 1 条撤销，实际 past=${afterSwitch.past}`)

  // ② 在同一个色块上**再点一次**微调：上一轮同样要提交（实现里第二次才修好这一半）
  await typeEditorHex('#ff00ff')
  const same = await posOf(`swatch-${RED}`)
  await rightClick(same.x, same.y)
  await clickTestId('swatch-menu-tune')
  await sleep(200)
  const afterReopen = await uiState()
  assert(
    afterReopen.palette[RED] === '#ff00ff',
    `重新打开同一色块时上一轮应已提交，实际 pal[${RED}]=${afterReopen.palette[RED]}`,
  )
  assert(afterReopen.past === afterSwitch.past + 1, `重新打开应恰好提交 1 条，实际 past=${afterReopen.past}`)

  // ③ 什么都没改就切走：不该凭空多出撤销帧
  const beforeIdle = await uiState()
  const other = await posOf(`swatch-${target}`)
  await rightClick(other.x, other.y)
  await clickTestId('swatch-menu-tune')
  await clickTestId('swatch-editor-done')
  const afterIdle = await uiState()
  assert(
    afterIdle.past === beforeIdle.past,
    `没做任何改动就不该产生撤销帧：${beforeIdle.past} → ${afterIdle.past}`,
  )

  // 复原：①②各提交了一条（③没提交），一起退回去，别把状态留给后面的用例
  await undoBack(2)
  const restored = await uiState()
  assert(
    JSON.stringify(restored.palette) === JSON.stringify(before.palette) && restored.hash === before.hash,
    `本用例应把自己改的颜色撤回原样（后面几条依赖 #ff0000/#00ff00），实际 ${JSON.stringify(restored.palette)}`,
  )
  return `切换已提交(→${afterSwitch.past})；重开已提交(→${afterReopen.past})；空转不生帧；已复原`
})

await check('Esc 放弃后切到别的色块：被放弃的改动不得"复活"', async () => {
  // 放弃是纯取消——它必须真的什么都没留下，而不是被后续的切换顺手提交上去
  const before = await uiState()
  const a = await posOf(`swatch-${RED}`)
  await rightClick(a.x, a.y)
  await clickTestId('swatch-menu-tune')
  await typeEditorHex('#abcdef')
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(280)
  const afterEsc = await uiState()
  assert(afterEsc.palette[RED] === before.palette[RED], `Esc 后模型不该变，实际 ${afterEsc.palette[RED]}`)
  assert(afterEsc.past === before.past, `Esc 不该产生撤销帧，实际 past=${afterEsc.past}`)

  const b = await posOf(`swatch-${GREEN}`)
  await rightClick(b.x, b.y)
  await clickTestId('swatch-menu-tune')
  const afterSwitch = await uiState()
  assert(
    afterSwitch.palette[RED] === before.palette[RED],
    `被 Esc 放弃的颜色不该在切换后复活，实际 pal[${RED}]=${afterSwitch.palette[RED]}`,
  )
  assert(afterSwitch.past === before.past, `切换一个"已被放弃的会话"不该产生撤销帧，实际 past=${afterSwitch.past}`)
  // 本用例全程没提交任何东西，点「完成」也只是关掉空会话，不会改状态
  await clickTestId('swatch-editor-done')
  const done = await uiState()
  assert(done.past === before.past && done.hash === before.hash, '本用例不该留下任何改动')
  return `Esc 后 pal[${RED}]=${afterEsc.palette[RED]}；切换后仍为 ${afterSwitch.palette[RED]}，past=${afterSwitch.past}`
})

await check('撤销改色：artHash 与 getPalette() **双还原**（P2-05 那族缺陷的防线）', async () => {
  await cdp.eval('window.pixelArtStudio.undo()')
  await sleep(300)
  const s = await uiState()
  assert(s.hash === base.hash, `撤销后 artHash 应还原：${base.hash} → ${s.hash}`)
  assert(
    JSON.stringify(s.palette) === JSON.stringify(base.palette),
    `撤销后色板必须逐项还原：${JSON.stringify(base.palette)} → ${JSON.stringify(s.palette)}`,
  )
  return `hash=${s.hash}；色板 ${s.palette.length} 项全部还原`
})

/* ---------------------------------------------- 合并重复色 */

await check('微调成色板里已有的颜色 → 自动合并：色板 -1 项、**总格数守恒**、没有颜色错位', async () => {
  const pre = await uiState()
  const greenCells = pre.usage['#00ff00'] ?? 0
  const redCells = pre.usage['#ff0000'] ?? 0
  assert(greenCells > 0 && redCells > 0, '前置条件不满足：两色都应有格子')

  // 把 #00ff00 微调成 #ff0000 → 触发合并
  const p = await posOf(`swatch-${GREEN}`)
  await rightClick(p.x, p.y)
  await clickTestId('swatch-menu-tune')
  await typeEditorHex('#ff0000')
  await clickTestId('swatch-editor-done')
  const post = await uiState()

  assert(post.palette.length === pre.palette.length - 1, `合并后色板应少 1 项：${pre.palette.length} → ${post.palette.length}`)
  assert(!post.palette.includes('#00ff00'), '被合并掉的颜色不该还留在色板里')
  assert(post.past === pre.past + 1, `合并应只产生 1 条撤销，实际 past=${post.past}`)
  /*
   * 守恒是这条的核心：合并只改"哪些格子指向哪一项"，**不改像素**。
   * 若下标重映射写错（例如漏了"大于源下标的前移 1"），格数会凭空多/少，
   * 或者两色的格数对不上——两种情况都会在这里变红。
   */
  assert(cellsOf(post.usage) === cellsOf(pre.usage), `合并前后总格数必须守恒：${cellsOf(pre.usage)} → ${cellsOf(post.usage)}`)
  assert(
    (post.usage['#ff0000'] ?? 0) === redCells + greenCells,
    `合并后 #ff0000 应等于两色之和：期望 ${redCells + greenCells}，实际 ${post.usage['#ff0000'] ?? 0}`,
  )
  return `色板 ${pre.palette.length}→${post.palette.length} 项；#ff0000 用量 ${redCells}+${greenCells}=${post.usage['#ff0000']}`
})

await check('撤销合并：色板长度与哈希都还原（合并动了 indices，必须能整体退回）', async () => {
  const before = await uiState()
  await cdp.eval('window.pixelArtStudio.undo()')
  await sleep(300)
  const s = await uiState()
  assert(s.palette.length === base.palette.length, `撤销后色板长度应还原为 ${base.palette.length}，实际 ${s.palette.length}`)
  assert(
    JSON.stringify(s.palette) === JSON.stringify(base.palette),
    `撤销后色板内容应逐项还原（顺序也不能变）：${JSON.stringify(s.palette)}`,
  )
  assert(s.hash === base.hash, `撤销后 artHash 应还原：${base.hash} → ${s.hash}（合并前 ${before.hash}）`)
  return `色板 ${s.palette.length} 项与 hash 均还原`
})

/* ---------------------------------------------- 替换颜色 */

await check('「替换为…」：源色用量归零、目标色格数按原源色格数增加、总格数守恒', async () => {
  const pre = await uiState()
  const redCells = pre.usage['#ff0000'] ?? 0
  assert(redCells > 0, '前置条件不满足：#ff0000 应有格子')

  await clickTestId(`swatch-${RED}`)
  await sleep(80)
  const p = await posOf(`swatch-${RED}`)
  await rightClick(p.x, p.y)
  await clickTestId('swatch-menu-replace')

  const title = await cdp.eval(`document.querySelector('.swatch-editor-title').textContent`)
  assert(title.includes('#ff0000'), `替换模式的标题应写明源色，实际「${title}」`)

  // 预览：源色的格子应当"看起来"已经变成目标色（画布采样，不看模型）
  await typeEditorHex('#0000ff')
  const px = await pixelAt(2, 2)
  assert(px === '0,0,255,255', `预览中画布应显示目标色，实测像素 ${px}`)
  const during = await uiState()
  assert(during.palette[RED] === '#ff0000', `预览期间模型不该变，实际 ${during.palette[RED]}`)

  await clickTestId('swatch-editor-done')
  const post = await uiState()
  assert(
    (post.usage['#ff0000'] ?? 0) === 0,
    `替换后源色用量应归零，实际 ${post.usage['#ff0000'] ?? 0}`,
  )
  assert(
    (post.usage['#0000ff'] ?? 0) === redCells,
    `目标色用量应等于原源色格数：期望 ${redCells}，实际 ${post.usage['#0000ff'] ?? 0}`,
  )
  assert(cellsOf(post.usage) === cellsOf(pre.usage), `替换前后总格数必须守恒：${cellsOf(pre.usage)} → ${cellsOf(post.usage)}`)
  assert(post.past === pre.past + 1, `替换应只产生 1 条撤销，实际 past=${post.past}`)
  return `${redCells} 格 #ff0000 → #0000ff；格数守恒；past=${post.past}`
})

await check('撤销替换：像素与色板都还原', async () => {
  await cdp.eval('window.pixelArtStudio.undo()')
  await sleep(300)
  const s = await uiState()
  assert(s.hash === base.hash, `撤销后 artHash 应还原：${base.hash} → ${s.hash}`)
  assert((s.usage['#ff0000'] ?? 0) > 0, '撤销后 #ff0000 的格子应当回来')
  return `hash=${s.hash}；#ff0000 用量 ${s.usage['#ff0000']}`
})

/* ---------------------------------------------- 参数滑条：右键**不再**是取消 */

/*
 * 这里原先断言"右键放弃本次调整"。按用户反馈**该功能已移除**：浏览器里右键自带上下文菜单语义，
 * 拿它当"取消"与用户预期打架。所以这条断言现在**反过来锁**：
 * 拖动中按右键必须**什么都不发生**（值不受影响、也不该被当成取消）。
 *
 * 为什么值得留一条（而不是直接删掉）：这类"已移除的手势"最容易以另一种形式复活——
 * 将来谁在滑条上绑 `contextmenu` 或对 `buttons` 做判断，都会被这条拦住。
 */
await check('参数滑条：拖动中按右键不改变数值（右键已不是取消手势）', async () => {
  // 展开「图像调整」分组（默认收起）
  await cdp.eval(`(() => {
    const h = document.querySelector('[data-testid="section-head-adjust"]')
    if (h.getAttribute('aria-expanded') === 'false') h.click()
    return true
  })()`)
  await sleep(300)

  /*
   * 定位滑条用 `data-testid`（`num-slider-<标签的码点>`），不靠类名或文本：
   * 面板重排时文本匹配会**静默指错元素**（docs/开发.md §3.2 的教训）。
   * `u4eaeu5ea6` = 「亮度」的码点编号。
   */
  const trackSel = '[data-testid="num-slider-u4eaeu5ea6"] .num-slider-track'
  const geo = await evalJson(`(() => {
    const t = document.querySelector(${JSON.stringify(trackSel)})
    if (!t) return null
    const r = t.getBoundingClientRect()
    return { left: r.left, w: r.width, y: r.top + r.height / 2 }
  })()`)
  assert(geo, '找不到亮度滑条的轨道')
  assert(geo.w > 50, `轨道必须有实际宽度（实测 ${geo.w}px）——否则断言会假通过`)

  const brightness = () => cdp.eval('window.pixelArtStudio.getInfo().params.brightness')
  const start = await brightness()

  // 真实鼠标拖到 85%（亮度 -100…100 → 应得到明显非 0 的值）
  await mouse('mousePressed', geo.left + geo.w * 0.5, geo.y, 'left', 1)
  await sleep(80)
  await mouse('mouseMoved', geo.left + geo.w * 0.85, geo.y, 'left', 1)
  await sleep(150)
  const dragged = await brightness()
  assert(dragged !== start, `拖动没生效：仍是 ${dragged}`)

  // 左键仍按住时按右键：**不该**发生任何事（既不是取消，也不是把值改掉）
  await mouse('mousePressed', geo.left + geo.w * 0.85, geo.y, 'right', 3)
  await sleep(140)
  const duringRight = await brightness()
  assert(duringRight === dragged, `拖动中按右键不该改变数值：${dragged} → ${duringRight}（右键不再是取消手势）`)
  await mouse('mouseReleased', geo.left + geo.w * 0.85, geo.y, 'right', 1)
  await sleep(140)

  // 松左键后值应当保持在拖动终点
  await mouse('mouseReleased', geo.left + geo.w * 0.85, geo.y, 'left', 0)
  await sleep(180)
  const afterRelease = await brightness()
  assert(afterRelease === dragged, `松手后值应保持在 ${dragged}，实际 ${afterRelease}`)
  return `拖到 ${dragged}；右键后仍为 ${afterRelease}（未被取消）`
})

/* ---------------------------------------------- 收尾 */

await check('运行期无控制台错误（新取色器 / 菜单的任何异常都在这里现形）', () => {
  assert(consoleErrors.length === 0, `控制台报错 ${consoleErrors.length} 条：${consoleErrors.slice(0, 3).join(' | ')}`)
  return '0 条'
})

await session.close()
report()
