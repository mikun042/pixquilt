#!/usr/bin/env node
/**
 * 单文件构建：把 UI（TS + CSS + HTML 模板）打包成**一个自包含 HTML**。
 *
 * 为什么不用 Vite/Rollup：产物只有一个 HTML，需求是"内联一切"，用 esbuild 一次 bundle
 * 就够（它同时承担 TS 转译与打包），少一层依赖就少一层将来会腐坏的东西。
 *
 * 产物同步（约束见 docs/开发.md §5 第 2 条）：
 *   dist/index.html  ←构建→  根目录 `像素画工作台.html`
 * 两者哈希必须逐位一致；`npm run build` 结束时会自己核对，不一致就直接失败退出。
 */
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const APP_DIR = join(ROOT, 'src', 'app')
const DIST = join(ROOT, 'dist')
const TARGET = join(ROOT, '像素画工作台.html')
const OUT = join(DIST, 'index.html')

/** 把 script 里的 `</script>` 转义，避免提前结束内联脚本块 */
function safeInline(code) {
  return code.replace(/<\/script>/gi, '<\\/script>')
}

async function bundle() {
  const result = await build({
    entryPoints: [join(APP_DIR, 'index.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome110', 'edge110', 'firefox110', 'safari16'],
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    write: false,
    logLevel: 'warning',
  })
  return result.outputFiles[0].text
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

async function main() {
  const templatePath = join(APP_DIR, 'index.html')
  if (!existsSync(templatePath)) throw new Error(`缺少 HTML 模板：${templatePath}`)

  const script = await bundle()
  const css = readFileSync(join(APP_DIR, 'style.css'), 'utf8')
  const template = readFileSync(templatePath, 'utf8')

  if (!template.includes('/*__STYLE__*/') || !template.includes('/*__SCRIPT__*/')) {
    throw new Error('HTML 模板缺少 /*__STYLE__*/ 或 /*__SCRIPT__*/ 占位符')
  }
  const html = template.replace('/*__STYLE__*/', () => css).replace('/*__SCRIPT__*/', () => safeInline(script))

  mkdirSync(DIST, { recursive: true })
  writeFileSync(OUT, html, 'utf8')
  writeFileSync(TARGET, html, 'utf8')

  const h1 = sha256(readFileSync(OUT, 'utf8'))
  const h2 = sha256(readFileSync(TARGET, 'utf8'))
  if (h1 !== h2) throw new Error('产物哈希不一致（dist/index.html 与根目录副本不同步）')

  const kb = (html.length / 1024).toFixed(1)
  console.log(`✔ 单文件构建完成：dist/index.html（${kb} KB）`)
  console.log(`✔ 已同步到根目录：像素画工作台.html`)
  console.log(`✔ 哈希一致：${h1.slice(0, 16)}…`)
  console.log('  双击该 HTML 即可使用；也可用 node tool/artc.mjs 在命令行批量出图。')
}

/*
 * 只在**直接被当命令行跑**时执行：被 import 时不该顺带跑一遍 main，
 * 更不该 process.exit 把导入方一起带走（tool/artc.mjs 末尾记录过这条教训）。
 */
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`构建失败：${err?.message ?? err}`)
    process.exit(1)
  })
}

