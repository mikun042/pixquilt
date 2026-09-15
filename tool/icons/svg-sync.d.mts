/**
 * tool/icons/svg-sync.mjs 的类型声明。
 *
 * 为什么需要：`tsc --noEmit` 覆盖 tool 下的 .mjs，而它们是 JS、没有类型；
 * `src/test/icons-freshness.test.ts` 要 import 它的纯函数做"接线是否最新"的比对，
 * 没有声明就会报 TS7016（隐式 any）。与 `tool/describe.d.mts` 同一套做法。
 *
 * 这里**只声明单测与外部会用到的那部分**，不追求把内部实现全表出来。
 */
import type { SvgPathItem } from './svg-data.d.mts'

/** 把数据渲染成 icons.ts 里的 SVG_PATHS 数据块 */
export function renderSvgPathsBlock(svgPaths: Record<string, SvgPathItem[]>): string

/** 读 icons.ts 源码、替换 SVG_PATHS 数据块，返回新内容（不写盘） */
export function replaceSvgPathsBlock(
  source: string,
  svgPaths: Record<string, SvgPathItem[]>,
): { text: string; hadCrlf: boolean }

/** 当前 icons.ts 的 SVG_PATHS 是否与形状定义一致 */
export function isSvgPathsFresh(): Promise<{ fresh: boolean; count: number }>
