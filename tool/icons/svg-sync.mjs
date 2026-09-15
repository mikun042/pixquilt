#!/usr/bin/env node
/**
 * 把 SVG track 的图标数据写进 `src/app/ui/icons.ts` 的 `SVG_PATHS`。
 *
 * 一条命令从形状直达产物：`svg-shapes.mjs`（32 设计网格）
 *   → `svg-data.mjs` 的 `buildSvgPaths()`（缩放 32→24 + 数值自检）
 *   → 替换 icons.ts 里的 `SVG_PATHS` 数据块。
 *
 * 为什么不做中间文件：原先中间要落一份 `svg-paths.json`、再由另一个脚本读走。
 * 多一个中间产物就多一次"忘了重跑、两边不一致"的机会，而**那份数据恰恰正是
 * "32 空间塞进 24 盒"裁切缺陷的载体**（它静静躺了很久没人发现）。
 * 现在没有中间文件可漂移。
 *
 * 为什么用脚本而不是手改：单条 path 1KB+，手抄必错。
 *
 * 用法：
 *   node tool/icons/svg-sync.mjs            # 写入
 *   node tool/icons/svg-sync.mjs --check    # 只校验 icons.ts 是否已是最新（CI / 单测用）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildSvgPaths } from './svg-data.mjs'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const TARGET = join(ROOT, 'src', 'app', 'ui', 'icons.ts')
const CRLF = String.fromCharCode(13, 10)
const LF = String.fromCharCode(10)

/** 把数据渲染成 icons.ts 里的那段 `const SVG_PATHS = {...}` */
export function renderSvgPathsBlock(svgPaths) {
  const body = [
    'const SVG_PATHS: Record<string, { d: string; fill?: string; fr?: string; sw?: string }[]> = {',
  ]
  for (const [name, paths] of Object.entries(svgPaths)) {
    body.push(`  ${name}: [`)
    for (const x of paths) {
      const parts = [`d: '${x.d}'`]
      if (x.fill) parts.push(`fill: '${x.fill}'`)
      if (x.fr) parts.push(`fr: '${x.fr}'`)
      if (x.sw) parts.push(`sw: '${x.sw}'`)
      body.push(`    { ${parts.join(', ')} },`)
    }
    body.push('  ],')
  }
  body.push('}')
  return body.join('\n')
}

/** 读 icons.ts、替换 SVG_PATHS 数据块，返回新内容（不写盘，供 sync 与 --check 共用） */
export function replaceSvgPathsBlock(source, svgPaths) {
  let s = source.includes(CRLF) ? source.split(CRLF).join(LF) : source
  const start = s.indexOf('const SVG_PATHS: Record<string')
  const end = s.indexOf('\n}\n', start)
  if (start < 0 || end < 0) throw new Error('icons.ts 里定位不到 SVG_PATHS 数据块')
  s = s.slice(0, start) + renderSvgPathsBlock(svgPaths) + s.slice(end + '\n}'.length)
  return { text: s, hadCrlf: source.includes(CRLF) }
}

/** 当前 icons.ts 是否与形状定义一致（供 --check 与单测共用） */
export async function isSvgPathsFresh() {
  const svgPaths = await buildSvgPaths()
  const original = readFileSync(TARGET, 'utf8')
  const { text, hadCrlf } = replaceSvgPathsBlock(original, svgPaths)
  return {
    fresh: text === (hadCrlf ? original.split(CRLF).join(LF) : original),
    count: Object.keys(svgPaths).length,
  }
}

async function main() {
  const CHECK = process.argv.includes('--check')

  const svgPaths = await buildSvgPaths({ verbose: !CHECK })
  const original = readFileSync(TARGET, 'utf8')
  const { text, hadCrlf } = replaceSvgPathsBlock(original, svgPaths)

  if (CHECK) {
    if (text !== (hadCrlf ? original.split(CRLF).join(LF) : original)) {
      console.error(
        '✘ icons.ts 的 SVG_PATHS 与 svg-shapes.mjs 不一致。\n  改了形状后请跑：npm run icons:sync',
      )
      process.exit(1)
    }
    console.log(`✔ SVG_PATHS 与形状定义一致（${Object.keys(svgPaths).length} 个图标）`)
  } else {
    writeFileSync(TARGET, hadCrlf ? text.split(LF).join(CRLF) : text)
    console.log(`已写入 icons.ts 的 SVG_PATHS（${Object.keys(svgPaths).length} 个图标）`)
  }
}

/*
 * 只在**直接被当命令行跑**时执行 main()。
 * 否则任何 `import './svg-sync.mjs'`（例如单测想复用 replaceSvgPathsBlock）
 * 都会顺带改写 icons.ts —— 这个坑本项目在 artc.mjs 上真实踩过一次
 * （见 docs/ARCHITECTURE.md §8.7）。
 */
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  await main()
}
