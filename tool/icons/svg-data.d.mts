/**
 * tool/icons/svg-data.mjs 的类型声明。
 *
 * 为什么需要：见 `svg-sync.d.mts`。
 */
import type { PixelIcon } from './pixel-sync.d.mts'

/** `SVG_PATHS` 里的一项：一条 path 及其可选的覆盖属性 */
export interface SvgPathItem {
  d: string
  fill?: string
  fr?: string
  sw?: string
}

/** 生成 SVG track 的全部图标数据（24 空间）：`{ 短名: [path, ...] }` */
export function buildSvgPaths(opts?: { verbose?: boolean }): Promise<Record<string, SvgPathItem[]>>

/** 形状定义里的一项（`svg-shapes.mjs` 的 SVG_SHAPES 值是一个 SVG 字符串） */
export type SvgShapeMap = Record<string, string>

export type { PixelIcon }
