/**
 * tool/describe.mjs 的类型声明。
 *
 * 为什么需要：tsc --noEmit 覆盖 src 与 tool 下的 .mjs，而 describe.mjs 是 JS、没有类型。
 * src/test/describe-freshness.test.ts 要 import 它的 build() 做"文档是否过期"的比对，
 * 没有声明就会报 TS7016（隐式 any）。标准做法是给 JS 配一个同名 .d.mts。
 *
 * 写这条注释时踩了一下，留个记录：正文里若出现 glob 通配（`tool` + 星号星号 + 斜杠 + 星号 + `.mjs`），
 * 其中连续的"星号斜杠"会**提前终止块注释**，后面的文字被当成代码解析、报出一串莫名其妙的语法错。
 * 凡是注释里要写 glob，别把 `*` 和 `/` 挨着写。
 */
export function build(): string
