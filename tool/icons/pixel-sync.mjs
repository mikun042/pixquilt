#!/usr/bin/env node
/**
 * 把像素产线的图标数据写进 `src/app/ui/icons.ts` 的 `PIXEL_PATHS`。
 *
 * 与 `svg-sync.mjs` 对称：那条管 8 个 SVG 描边图标，这条管 20 个像素格图标
 * （其中 8 个与 SVG 版同名、渲染时被遮蔽，但仍然是本产线的产物、必须一起保持同步）。
 * 两者都是一条命令从形状定义直达 icons.ts，中间没有易失的中间产物。
 *
 * 用法：
 *   node tool/icons/pixel-sync.mjs            # 写入
 *   node tool/icons/pixel-sync.mjs --check    # 只校验 icons.ts 是否已是最新（CI / 单测用）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildPixelIcons } from './pixel-data.mjs'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const TARGET = join(ROOT, 'src', 'app', 'ui', 'icons.ts')
const CRLF = String.fromCharCode(13, 10)
const LF = String.fromCharCode(10)

/** 把数据渲染成 icons.ts 里的那段 `const PIXEL_PATHS = {...} as const` */
export function renderPixelPathsBlock(made) {
  const body = ['const PIXEL_PATHS = {']
  for (const m of made) {
    body.push(`  ${m.short}: '${m.d}',`)
  }
  body.push('} as const')
  return body.join('\n')
}

/** 读 icons.ts、替换 PIXEL_PATHS 数据块，返回新内容（不写盘，供 sync、--check 与单测共用） */
export function replacePixelPathsBlock(source, made) {
  const hadCrlf = source.includes(CRLF)
  let s = hadCrlf ? source.split(CRLF).join(LF) : source
  const start = s.indexOf('const PIXEL_PATHS = {')
  if (start < 0) throw new Error('icons.ts 里定位不到 PIXEL_PATHS 数据块')
  // 数据块以 `} as const` 收尾（每行一个 `short: 'd',`）
  const end = s.indexOf('\n} as const', start)
  if (end < 0) throw new Error('icons.ts 里定位不到 PIXEL_PATHS 的结尾 `} as const`')
  s = s.slice(0, start) + renderPixelPathsBlock(made) + s.slice(end + '\n} as const'.length)
  return { text: s, hadCrlf }
}

/**
 * 当前 icons.ts 是否与形状定义一致。
 *
 * 抽成函数是为了让**单测**能用同一套判断（`src/test/icons-freshness.test.ts`），
 * 不必 spawn 子进程。
 */
export function isPixelPathsFresh() {
  const { made, failures } = buildPixelIcons()
  if (failures.length) {
    throw new Error(`图标几何校验不通过：${failures.map((f) => `${f.id}(${f.reason})`).join('；')}`)
  }
  const original = readFileSync(TARGET, 'utf8')
  const { text, hadCrlf } = replacePixelPathsBlock(original, made)
  return { fresh: text === (hadCrlf ? original.split(CRLF).join(LF) : original), count: made.length, made }
}

async function main() {
  const CHECK = process.argv.includes('--check')

  const { made, failures } = buildPixelIcons()
  if (failures.length) {
    console.error(`✘ ${failures.length} 个图标几何校验不通过：`)
    for (const f of failures) console.error(`  - ${f.id}: ${f.reason}`)
    process.exit(1)
  }
  if (!CHECK) {
    for (const m of made) {
      console.log(
        `✔ ${m.id.padEnd(16)} → ${m.short.padEnd(12)} ${m.geo.w.toFixed(0)}×${m.geo.h.toFixed(0)} ${m.geo.strokePx.toFixed(2)}px`,
      )
    }
  }

  const original = readFileSync(TARGET, 'utf8')
  const { text, hadCrlf } = replacePixelPathsBlock(original, made)

  if (CHECK) {
    if (text !== (hadCrlf ? original.split(CRLF).join(LF) : original)) {
      console.error(
        '✘ icons.ts 的 PIXEL_PATHS 与 pixel-shapes.mjs 不一致。\n  改了形状后请跑：npm run icons:sync',
      )
      process.exit(1)
    }
    console.log(`✔ PIXEL_PATHS 与形状定义一致（${made.length} 个图标）`)
  } else {
    writeFileSync(TARGET, hadCrlf ? text.split(LF).join(CRLF) : text)
    console.log(`已写入 icons.ts 的 PIXEL_PATHS（${made.length} 个图标）`)
  }
}

/*
 * 只在**直接被当命令行跑**时执行 main()。
 *
 * 没有这个守卫时，任何 `import './pixel-sync.mjs'`（例如单测想复用
 * `replacePixelPathsBlock` 判断"接线是否最新"）都会顺带跑一遍 main() ——
 * 它会**直接改写 icons.ts**，甚至 `process.exit(1)` 把导入方一起带走。
 * 这个坑本项目在 artc.mjs 上真实踩过一次（见 docs/架构.md §8.7）。
 */
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  await main()
}

