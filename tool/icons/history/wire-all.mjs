// 把 20 个图标的 path 全部写进 src/app/ui/icons.ts（替换上一版的 12 个）。
// 用脚本而不是手改：单个 path 1KB+，手抄必错。
import { readFileSync, writeFileSync } from 'node:fs'

const entries = JSON.parse(readFileSync('output/_work/all20.json', 'utf8'))
const p = 'src/app/ui/icons.ts'
let s = readFileSync(p, 'utf8')
const CRLF = String.fromCharCode(13, 10)
const LF = String.fromCharCode(10)
const had = s.includes(CRLF)
if (had) s = s.split(CRLF).join(LF)

const shortName = (id) =>
  id
    .replace(/^tool_/, '')
    .replace(/^act_/, '')
    .replace(/^cat_/, '')
    .replace(/^caret_/, 'caret')
    .replace(/^panel_/, 'panel')
    .replace(/_([a-z])/g, (_, c) => c.toUpperCase())

// 替换整个 PIXEL_PATHS 块（从 `const PIXEL_PATHS = {` 到 `} as const`）
const blockStart = s.indexOf('const PIXEL_PATHS = {')
const blockEnd = s.indexOf('} as const', blockStart)
if (blockStart < 0 || blockEnd < 0) throw new Error('PIXEL_PATHS 定位失败')

const body = ['const PIXEL_PATHS = {']
for (const e of entries) body.push(`  ${shortName(e.id)}: '${e.d}',`)
body.push('} as const')
s = s.slice(0, blockStart) + body.join('\n') + s.slice(blockEnd + '} as const'.length)

// 更新注释里的"现状"描述（原来写的是"部分已换"，现在全换了）
s = s.replace(
  ' * 来源：`output/UI素材32/`（本仓库的像素画工作台生成，逐个通过校验：viewBox、',
  ' * 来源：`output/UI素材32/`（本仓库的像素画工作台生成，逐个通过校验：viewBox、',
)

writeFileSync(p, had ? s.split(LF).join(CRLF) : s)
console.log(`已写入 ${entries.length} 个图标`)
