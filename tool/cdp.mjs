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
 * 浏览器候选路径，覆盖面取各脚本的并集（顺序：Edge 优先，然后 Chrome）。
 * 用 `--browser <路径>` 可覆盖（见 `startBrowser`）。
 */
export const BROWSER_CANDIDATES = [
  process.env['PROGRAMFILES'] && join(process.env['PROGRAMFILES'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['PROGRAMFILES'] && join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['LOCALAPPDATA'] && join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean)

/** 找一个可用的浏览器；显式路径优先，找不到返回 null（由调用方决定怎么报错） */
export function pickBrowser(explicitPath) {
  if (explicitPath) return existsSync(explicitPath) ? explicitPath : null
  return BROWSER_CANDIDATES.find((p) => existsSync(p)) ?? null
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
 * 返回 `{ cdp, child, userDataDir, close() }`；**务必在 finally 里调 `close()`**，
 * 否则会留下无头进程与临时 profile。
 */
export async function startBrowser(options = {}) {
  const {
    browserPath,
    profilePrefix = 'pixel-art-cdp-',
    extraArgs = [],
    portStrategy = 'stdout',
    timeoutMs = 25000,
  } = options

  const browser = pickBrowser(browserPath)
  if (!browser) {
    throw new Error(
      `找不到 Edge / Chrome（找过这些路径：\n  ${BROWSER_CANDIDATES.join('\n  ')}\n）——可用 --browser <路径> 指定`,
    )
  }

  const userDataDir = mkdtempSync(join(tmpdir(), profilePrefix))
  const child = spawn(browser, LAUNCH_ARGS(userDataDir, extraArgs), { stdio: ['ignore', 'pipe', 'pipe'] })

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
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
      await sleep(300)
      try {
        rmSync(userDataDir, { recursive: true, force: true })
      } catch {
        /* 临时目录清理失败不影响结论 */
      }
    },
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
