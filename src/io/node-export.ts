/**
 * Node 侧"画布 → PNG 字节"的唯一入口。
 *
 * 之所以单独一层：core 必须保持平台无关（浏览器包里不能出现 `node:zlib`），
 * 而 Node 侧（CLI / 自检 / 单测）又确实需要字节流。
 * 把这两件事分别放在 `src/io/*` 与 `src/app/canvas-png.ts`，"平台绑定"就只存在于这两个薄文件里。
 */
import { artToImageData, type RasterOptions } from '../core/raster.ts'
import type { PixelArt } from '../core/types.ts'
import { encodePngNode } from './node-png.ts'

export function artToPngBytesNode(art: PixelArt, scale = 1, opts: RasterOptions = {}): Uint8Array {
  return encodePngNode(artToImageData(art, scale, opts))
}
