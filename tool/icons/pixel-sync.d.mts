/**
 * tool/icons/pixel-sync.mjs 的类型声明。
 *
 * 为什么需要：见 `svg-sync.d.mts`。
 */

/** 一个像素图标：形状定义 id、icons.ts 用的短名、以及生成好的 path 数据与几何校验结果 */
export interface PixelIcon {
  id: string
  short: string
  name: string
  cat: string
  d: string
  geo: { w: number; h: number; strokePx: number; ok: boolean; problems: string[]; [k: string]: unknown }
}

/** 把数据渲染成 icons.ts 里的 PIXEL_PATHS 数据块 */
export function renderPixelPathsBlock(made: PixelIcon[]): string

/** 读 icons.ts 源码、替换 PIXEL_PATHS 数据块，返回新内容（不写盘） */
export function replacePixelPathsBlock(
  source: string,
  made: PixelIcon[],
): { text: string; hadCrlf: boolean }

/** 当前 icons.ts 的 PIXEL_PATHS 是否与形状定义一致 */
export function isPixelPathsFresh(): { fresh: boolean; count: number; made: PixelIcon[] }
