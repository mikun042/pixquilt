/**
 * 零依赖的无头浏览器 CDP 客户端 + 启动/清理样板。
 *
 * 为什么抽出来：这段代码原先是**六份复制**（`e2e` / `e2e-picker` / `e2e-slider` /
 * `e2e-regressions` / `e2e-pdf` / `shoot`），浏览器候选路径、启动参数、临时 profile 清理、
 * 超时与定时器清理各写一遍，且已经出现细微分叉（有的脚本忘了在响应时清定时器，
 * 导致进程空转、有的用 `stdout` 抓 ws、有的读 `DevToolsActivePort` 文件）。
 * 拼错一份就等于少一条防线，而这类代码没有测试覆盖。
 *
 * 依赖只有 Node 内置模块（`node:child_process` / `node:fs` / `node:os` / `node:path`），
 * 与项目"零第三方依赖"的约定一致。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * **同步**睡眠：`exit` 钩子里不能用 `await`（事件循环已经停了），而删目录必须等浏览器真正退出。
 * 零依赖做法是 `Atomics.wait` 卡住主线程——只在退出兜底里用，且有明确的上限。
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 浏览器候选路径：**三个平台**的常见安装位置，顺序 Edge → Chrome → Chromium。
 *
 * 这里原先只有 Windows 的三处环境变量，于是在 macOS / Linux 上 `pickBrowser()` 恒为 null，
 * 八个浏览器套件全部启动不了；而 `startBrowser` 的报错文案却对所有人宣传"可用 `--browser` 指定"
 * ——而当时只有 `e2e.mjs` 一个脚本真的读这个参数。现在两件事一起修：候选路径补全 + 参数解析
 * 收进 `startBrowser` 内部（见 `browserFromEnv()`），**任何脚本都不用各自记得传**。
 *
 * 注：macOS / Linux 的路径是按各发行版常规位置写的，作者无法在本机（Windows）实测；
 * 找不到时会走 PATH 查找（`google-chrome` / `chromium` 等），仍然找不到才报错。
 */
export const BROWSER_CANDIDATES = [
  // Windows
  process.env['PROGRAMFILES'] && join(process.env['PROGRAMFILES'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['PROGRAMFILES'] && join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['LOCALAPPDATA'] && join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean)

/** PATH 里的可执行名（零依赖：自己按 `:` / `;` 拆，不引入 which 依赖） */
const PATH_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'msedge']

/** 在 PATH 里找一个可执行文件；找不到返回 null */
function findInPath() {
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  for (const name of PATH_NAMES) {
    for (const dir of dirs) {
      if (!dir) continue
      const full = join(dir, name)
      if (existsSync(full)) return full
    }
  }
  return null
}

/** 找一个可用的浏览器；显式路径优先，找不到返回 null（由调用方决定怎么报错） */
export function pickBrowser(explicitPath) {
  if (explicitPath) return existsSync(explicitPath) ? explicitPath : null
  return BROWSER_CANDIDATES.find((p) => existsSync(p)) ?? findInPath()
}

/**
 * 浏览器来源的统一优先级：`--browser <路径>` > `PIXEL_BROWSER` 环境变量 > 候选路径 / PATH。
 *
 * 放在 `cdp.mjs` 里由 `startBrowser` 自己调用，而不是让八个脚本各写一遍
 * （此前只有 `e2e.mjs` 接了 `--browser`，其余七个脚本收到了也当没看见）。
 */
export function browserFromEnv() {
  return argValue('browser') || process.env.PIXEL_BROWSER || undefined
}

/** 命令行取参小工具：`--name value` 或 `--flag` */
export function argValue(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}
export function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

/* ------------------------------------------------------------------ CDP */

/**
 * 极简 CDP 客户端：WebSocket + 自增 id + pending 表。
 *
 * 每个请求都带超时（默认 20s），**响应到达时会把定时器清掉**——
 * 早先有一版忘了清，进程在测完之后还要空转 120 秒才退出（`pendingTimers` 那行注释记着这事）。
 */
export class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
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

  /** 求值并返回结果值；页面抛错时原样抛出（便于断言里看到真实原因） */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }

  /** 求值并把结果当 JSON 解析（脚本里最常用的形式） */
  async evalJson(expression) {
    return JSON.parse(await this.eval(expression))
  }

  close() {
    for (const t of this.pendingTimers) clearTimeout(t)
    this.pendingTimers.clear()
    try {
      this.ws.close()
    } catch {
      /* 已经关了 */
    }
  }
}

/* ---------------------------------------------------- 启动 / 连接 / 清理 */

const LAUNCH_ARGS = (userDataDir, extra = []) => [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--allow-file-access-from-files',
  '--remote-debugging-port=0',
  `--user-data-dir=${userDataDir}`,
  ...extra,
  'about:blank',
]

/**
 * 起一个无头浏览器并连上它的 page target。
 *
 * 两种取端口的方式都支持（各脚本原先各用一种，都保留以免破坏某台机器上的行为）：
 *  - `'stdout'`（默认）：从进程输出里正则抓 `ws://…`，再查 `/json/list`；
 *  - `'portfile'`：读 profile 目录下的 `DevToolsActivePort`（某些环境下 stdout 抓不到）。
 *
 * 浏览器路径的优先级由 `browserFromEnv()` 决定（`--browser` > `PIXEL_BROWSER` > 候选路径/PATH），
 * 所以**脚本不必自己解析这个参数**。
 *
 * 清理有**三重**保障，都不依赖调用方记得写 finally：
 *  1. 正常路径：调用方在 finally 里 `close()`；
 *  2. **启动失败**：`mkdtemp` 之后的任何抛错（等端口超时 / 无 page target / 连不上）都在 catch 里
 *     kill 掉子进程并删掉临时 profile——此前这段会漏，系统 temp 里积过 68 个残留 profile（1.1GB）；
 *  3. **进程退出兜底**：注册一次 `exit` 钩子（同步 kill + 同步删目录），覆盖"脚本中途抛错但没写
 *     finally"的情形。有了它，就不必为了清理去改写那几个几百行的顶层线性脚本。
 *
 * 返回 `{ cdp, child, browser, userDataDir, close() }`；**建议在 finally 里调 `close()`**（更及时），
 * 忘了也不会留下残留。
 */
export async function startBrowser(options = {}) {
  const {
    browserPath,
    profilePrefix = 'pixel-art-cdp-',
    extraArgs = [],
    portStrategy = 'stdout',
    timeoutMs = 25000,
  } = options

  const browser = pickBrowser(browserPath ?? browserFromEnv())
  if (!browser) {
    throw new Error(
      `找不到 Chrome / Edge / Chromium。找过这些路径：\n  ${BROWSER_CANDIDATES.join('\n  ')}\n` +
        `也在 PATH 里找过：${PATH_NAMES.join(' / ')}\n` +
        `——可用 --browser <路径> 指定，或设环境变量 PIXEL_BROWSER=<路径>`,
    )
  }

  const userDataDir = mkdtempSync(join(tmpdir(), profilePrefix))
  /** 同步清理：close() 与 exit 兜底共用，幂等 */
  let cleaned = false
  let child = null
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    try {
      child?.kill()
    } catch {
      /* 已经退出 */
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* 临时目录清理失败不影响结论 */
    }
  }
  /**
   * `exit` 兜底：Windows 上浏览器进程被杀后还会短暂占着 profile 里的文件句柄，
   * 立刻删会 EBUSY/EPERM（实测：同步删一次删不掉，`close()` 因为有 300ms 等待才成功）。
   * 这里在**退出路径**上同步重试几次——只能卡主线程，所以给一个明确上限（约 3 秒）。
   */
  const cleanupOnExit = () => {
    if (cleaned) return
    try {
      child?.kill()
    } catch {
      /* 已经退出 */
    }
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(userDataDir, { recursive: true, force: true })
        cleaned = true
        return
      } catch {
        sleepSync(150)
      }
    }
  }
  process.once('exit', cleanupOnExit)

  try {
    child = spawn(browser, LAUNCH_ARGS(userDataDir, extraArgs), { stdio: ['ignore', 'pipe', 'pipe'] })
    const port = portStrategy === 'portfile' ? await waitPortFile(userDataDir, timeoutMs) : await waitPortFromStdout(child, timeoutMs)
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find((t) => t.type === 'page')
    if (!page) throw new Error('浏览器没有可用的 page target')
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl)

    return {
      cdp,
      child,
      browser,
      userDataDir,
      async close() {
        cdp.close()
        cleanup()
        await sleep(300)
        // kill 之后浏览器可能还在收尾写盘，再删一次；`force: true` 让"目录已不存在"不成问题
        try {
          rmSync(userDataDir, { recursive: true, force: true })
        } catch {
          /* 忽略 */
        }
      },
    }
  } catch (err) {
    // 失败路径：不留 profile、不留进程（见上面第 2 条）
    cleanup()
    throw err
  }
}

async function waitPortFile(userDataDir, timeoutMs) {
  const portFile = join(userDataDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const port = Number(readFileSync(portFile, 'utf8').split('\n')[0])
      if (port) return port
    }
    await sleep(100)
  }
  throw new Error('等待 DevToolsActivePort 超时（浏览器没起来？）')
}

async function waitPortFromStdout(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('等待 DevTools 端口超时（浏览器没起来？）')), timeoutMs)
    const onData = (chunk) => {
      buf += String(chunk)
      const m = buf.match(/ws:\/\/[^\s]+/)
      if (!m) return
      clearTimeout(timer)
      const port = m[0].match(/:(\d+)\//)?.[1]
      if (port) resolve(port)
      else reject(new Error(`无法从 DevTools 地址解析端口：${m[0]}`))
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
  })
}

/* ---------------------------------------------------------------- 断言 */

/**
 * 极简断言收集器：一条失败不影响后面的检查全部跑完（要一次性看到所有问题）。
 *
 * `check` 支持同步与异步两种回调——**异步回调必须 `await check(...)`**，
 * 否则 Promise 不会被等，失败会被吞掉、看起来"永远通过"（回归脚本里踩过，
 * 那里专门写了注释；这里用 `await Promise.resolve(fn())` 统一处理）。
 */
export function createChecker(label) {
  const results = []
  const check = async (name, fn) => {
    try {
      const detail = await Promise.resolve(fn())
      results.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) })
    } catch (err) {
      results.push({ name, ok: false, detail: err?.message ?? String(err) })
    }
  }
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg)
  }
  /** 打印全部结果并以退出码反映结论（全绿 0 / 有失败 1） */
  const report = () => {
    const passed = results.filter((r) => r.ok).length
    for (const r of results) console.log(` ${r.ok ? '✔' : '✘'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
    console.log(`\n${label}：${passed}/${results.length} 通过`)
    process.exit(passed === results.length ? 0 : 1)
  }
  return { results, check, assert, report }
}
