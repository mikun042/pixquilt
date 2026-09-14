/**
 * `docs/AGENT_API.md` 的**新鲜度**：仓库里的文件必须与 `tool/describe.mjs` 现生成的内容一致。
 *
 * 为什么必须有这条：那份手册是**给 agent 的契约**（算子、参数、上限、稳定约定都在里面），
 * 而它由 `src/core/spec.ts` 的元数据投影而来。此前"改了元数据必须重跑 `npm run describe`"
 * **只写在文档里、没有任何断言守着**——`npm run verify` 链里不含 describe，`npm test` 也不比对。
 * 于是文档会安静地过期（历史上真的发生过：表里长期写着 `--selftest 25 项`，实际是 32 项）。
 * 现在改成：忘记重跑 → 这条测试变红 → 提交前就被拦住。
 *
 * 另外它不是多余的重复：人手改 `AGENT_API.md` 会被下一次 describe **原样覆盖**（文件头也写着"请勿手改"），
 * 这条测试同时守住"别手改生成文件"——手改后即使不重跑 describe，只要生成结果与仓库文件不一致就会红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from '../../tool/describe.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
/** 比较内容而不是行尾：行尾策略由 `.gitattributes` 管，这里只关心"内容是否过期" */
const normalize = (text: string): string => text.replace(/\r\n/g, '\n')

test('docs/AGENT_API.md 与 describe 的生成结果一致（改了 spec.ts 必须重跑 npm run describe）', () => {
  const onDisk = normalize(readFileSync(join(ROOT, 'docs', 'AGENT_API.md'), 'utf8'))
  const generated = normalize(build())
  assert.equal(
    onDisk,
    generated,
    'docs/AGENT_API.md 已过期或被人手改过：跑 `npm run describe` 重新生成后一起提交（该文件是生成的，不要手改）',
  )
})
