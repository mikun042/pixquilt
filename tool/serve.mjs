#!/usr/bin/env node
/**
 * 本地静态服务器（仅为方便用真实浏览器打开产物，不是产品的一部分）。
 *
 * 为什么需要它：`file://` 下部分能力受限（剪贴板、部分解码路径在个别浏览器上会被拦）。
 * 想直接双击 HTML 也完全可以——这是"单文件交付"的意义。
 *
 * 用法：node tool/serve.mjs [端口]   # 默认 8080
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const port = Number(process.argv[2] ?? 8080)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.hex': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
}

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
  const rel = urlPath === '/' ? '/像素画工作台.html' : urlPath
  const file = resolve(join(ROOT, rel))

  // 目录穿越保护：只允许访问仓库内的文件
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('403 Forbidden')
    return
  }
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`404 找不到：${rel}`)
    return
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})

server.listen(port, '127.0.0.1', () => {
  console.log(`已启动：http://127.0.0.1:${port}/像素画工作台.html`)
  console.log('按 Ctrl+C 结束（也可以直接双击 HTML 文件，不需要这个服务器）')
})
