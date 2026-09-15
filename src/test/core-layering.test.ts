/**
 * R1 分层铁律的**静态检查**：`src/core/` 里不许出现平台绑定。
 *
 * ## 为什么需要它（此前只有"自然约束"）
 *
 * `DEVELOPMENT.md` §4 的 R1 说：`core` 是纯逻辑层，零 DOM、零 `node:`，所以
 * Node 能直接 import（L3 入口）、浏览器包也打得出来。但这条规则**一直没有静态检查**，
 * 靠的是"core 里出现 `node:zlib` 会让浏览器构建失败"这个自然约束。它的两个问题：
 *
 *  1. **反馈太晚**：只有真跑 `npm run build` 才暴露，而"改了 core 只跑单测"是常见操作。
 *  2. **只挡得住一半**：`node:` 会让浏览器构建失败，但 **`document.` / `window.` 不会**——
 *     浏览器侧它们完全正常，只有 Node 直调（L3）或单测里才炸。而 L3 恰恰是
 *     "agent / CI 只要结果不要 UI"的主力入口。也就是说：**DOM 泄漏是静默的**，
 *     正是本项目最忌讳的那类失败。
 *
 * 这个项目真实发生过一次同源事故：PNG 编码曾被放进 `core/export.ts` 并 import
 * `node:zlib`，浏览器构建直接挂掉，于是才拆出 `src/io/`（见 `DEVELOPMENT.md` §6 第 1 条）。
 *
 * ## 检查口径
 *
 * 逐文件扫 `src/core/**.ts`，命中即失败：
 *  `node:` 模块绑定、`document.`、`window.`、`globalThis.`、`localStorage`、`navigator.`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CORE_DIR = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'src', 'core')

/**
 * **只剥注释**，字符串原样保留。
 *
 * ## 为什么不能连字符串一起处理（这是第一版的真实设计错误）
 *
 * 最初的版本把字符串字面量也换成占位符（`'node:zlib'` → `'~~~~~~~~~'`）——思路是
 * "注释和字符串都不会真的执行，都该排除"。但这个设计**自相矛盾**：
 * `node:` 恰恰**只可能出现在字符串里**（模块名就是字符串字面量）。
 * 把它抹掉等于让 `from 'node:…'` 这条最重要的模式永远匹配不上。
 *
 * 变异验证时抓到了这一点：把 `import { deflateSync } from 'node:zlib'` 加进
 * `core/raster.ts`，断言**照样全绿**（字符串被抹成了 `'~~~~~~~~~'`）——那条防线当时是空的。
 * 而同一份代码在变异测试**之外**看起来完全正常，所以只有"故意改坏"才暴露得出来。
 *
 * 现在只剥注释：`document.` / `from 'node:…'` 都照抓；而"注释里讲解这些禁忌词"
 * （本项目注释里大量存在，例如"`document`/`Blob` 只属于浏览器层"）不会误报——
 * 那才是唯一需要排除的来源。
 *
 * 已知取舍：字符串里的无关词会误报（例如写 `const s = 'window.foo'`）。
 * 本项目 core 里**没有**这种用法，而漏掉真正的 `node:` 导入代价大得多——
 * 宁可偶尔误报，也不要一条永远不响的警报。
 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  type Mode = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl'
  let mode: Mode = 'code'
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    if (mode === 'code') {
      if (c === '/' && c2 === '/') { mode = 'line'; i += 2; continue }
      if (c === '/' && c2 === '*') { mode = 'block'; i += 2; continue }
      if (c === "'") { mode = 'sq'; out += c; i++; continue }
      if (c === '"') { mode = 'dq'; out += c; i++; continue }
      if (c === '`') { mode = 'tpl'; out += c; i++; continue }
      out += c
      i++
      continue
    }
    if (mode === 'line') {
      // 保留换行 → 行号与原文件对齐，报错信息才能指到那一行
      if (c === '\n') { mode = 'code'; out += c }
      i++
      continue
    }
    if (mode === 'block') {
      if (c === '*' && c2 === '/') { mode = 'code'; i += 2; continue }
      if (c === '\n') out += c
      i++
      continue
    }
    // 字符串内部：**原样抄下来**（见上面的说明，绝不抹内容）
    out += c
    if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === '`')) {
      mode = 'code'
    }
    i++
  }
  return out
}

/** 违规模式：模块绑定 + 浏览器全局 */
const FORBIDDEN: { re: RegExp; what: string }[] = [
  { re: /from\s*['"]node:/, what: "import 'node:…'（平台绑定只允许出现在 src/io）" },
  { re: /require\s*\(\s*['"]node:/, what: "require('node:…')" },
  { re: /import\s*\(\s*['"]node:/, what: "动态 import('node:…')" },
  { re: /\bdocument\s*\./, what: 'DOM（document）' },
  { re: /\bwindow\s*\./, what: 'DOM（window）' },
  { re: /\bglobalThis\s*\./, what: 'globalThis（隐式全局）' },
  { re: /\blocalStorage\b/, what: 'localStorage' },
  { re: /\bnavigator\s*\./, what: 'navigator' },
]

test('R1 分层：src/core 里不许出现 node: 或 DOM 绑定', () => {
  const files = readdirSync(CORE_DIR).filter((f) => f.endsWith('.ts'))
  assert.ok(files.length >= 15, `core 文件数异常（${files.length}），检查路径是否指对了`)

  const violations: string[] = []
  for (const f of files) {
    const raw = readFileSync(join(CORE_DIR, f), 'utf8')
    const code = stripComments(raw)
    const lines = raw.split('\n')
    for (const { re, what } of FORBIDDEN) {
      const m = code.match(re)
      if (!m) continue
      // 行号：在**剥注释后**的文本里定位（它保留了换行，所以行号与原文件一致）
      const idx = code.split('\n').findIndex((l) => re.test(l))
      const snippet = idx >= 0 ? (lines[idx] ?? '').trim().slice(0, 60) : ''
      violations.push(`src/core/${f}${idx >= 0 ? `:${idx + 1}` : ''} 出现 ${what}${snippet ? ` —— ${snippet}` : ''}`)
    }
  }

  assert.equal(
    violations.length,
    0,
    `core 必须是纯逻辑层（Node 能直接 import、浏览器包也打得出）。违规：\n  ${violations.join('\n  ')}\n` +
      `→ 平台相关的部分请放到 src/io（Node）或 src/app（浏览器），见 docs/DEVELOPMENT.md §4 的 R1`,
  )
})
