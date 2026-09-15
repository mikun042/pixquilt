/**
 * rasterize.mjs —— 把 SVG 形状栅格化成像素图，再交回工作台转成最终 SVG。
 *
 * 为什么要有这一步（这条流水线解决什么问题）：
 *   "回转箭头、环形箭头、油漆桶"这类**有明确语义的物件**，用"在 32×32 网格上堆格子"
 *   很难画准——实测磨了 4 轮仍未收敛（撤销被画成"门"形、刷新环成了"C"形）。
 *   而用 SVG 的 `stroke` 画圆弧与箭头是直接、可控的。
 *   所以顺序改成：**SVG 画形状 → 浏览器栅格化成 PNG → 工作台转像素 → 再转单色 SVG**。
 *
 * 为什么栅格化放浏览器：Node 端没有 SVG 解码器，而项目禁止引外部依赖（单文件、不联网）。
 * 浏览器（canvas + Image）本来就能栅格化 SVG，`tool/cdp.mjs` 又已经提供了零依赖的 CDP 客户端——
 * e2e 套件就是这么跑的。所以这里复用同一条通道，不新增任何依赖。
 *
 * 产出的是**位图**（PNG 字节），后续交给 `tool/artc.mjs` 做像素化：
 *   缩小到目标格数 → 二值化（阈值）→ 得到"哪些格是实心"，再转成 path。
 */
import { startBrowser } from '../../../tool/cdp.mjs'

/**
 * 在浏览器里把一批 SVG 字符串栅格化成 PNG 数据。
 *
 * @param svgs      `{ [id]: string }`，每个是完整 SVG 源码（含 xmlns）
 * @param size      栅格化边长（像素）。建议取目标格数的 4~8 倍，留够抗锯齿余量
 * @returns         `{ [id]: { width, height, data: number[] } }`（RGBA 数组）
 */
export async function rasterizeSvgs(svgs, { size = 128 } = {}) {
  const { cdp, close } = await startBrowser()
  try {
    // 空页面即可：我们只要 canvas 与 Image，不需要任何宿主元素
    await cdp.send('Page.navigate', { url: 'data:text/html,<html><body></body></html>' })
    await sleep(800)

    const ids = Object.keys(svgs)
    const results = {}
    for (const id of ids) {
      const svg = svgs[id]
      // 用 JSON 传参，避免字符串拼接把引号/换行弄坏
      const payload = JSON.stringify({ svg, size })
      const out = await cdp.eval(`(async () => {
        const { svg, size } = ${payload}
        const img = new Image()
        img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))
        await img.decode()
        const c = document.createElement('canvas')
        c.width = size
        c.height = size
        const g = c.getContext('2d')
        // 白底黑图：后续按"亮度阈值"判定实心，前景/背景对比要明确
        g.fillStyle = '#ffffff'
        g.fillRect(0, 0, size, size)
        g.drawImage(img, 0, 0, size, size)
        const d = g.getImageData(0, 0, size, size).data
        return JSON.stringify({ width: size, height: size, data: Array.from(d) })
      })()`)
      results[id] = JSON.parse(out)
    }
    return results
  } finally {
    await close()
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 栅格化结果 → 布尔网格（哪些格实心）。
 *
 * 判定用**覆盖率**而不是单点采样：把每个目标格覆盖的那一小块像素平均，
 * 超过阈值算实心。单点采样（只看格中心）会让细笔画整段消失——
 * 这正是"栅格化 + 二值化"比手画格子可靠的地方：形状由 SVG 保证，判定只需一个阈值。
 *
 * @param img    `{ width, height, data }`
 * @param grid   目标格数（如 32）
 * @param threshold 覆盖率阈值（0~1）。0.5 表示"过半即实心"
 */
export function toMask(img, grid, { threshold = 0.45 } = {}) {
  const { width: W, height: H, data } = img
  const mask = Array.from({ length: grid }, () => Array(grid).fill(0))
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const x0 = Math.floor((gx * W) / grid)
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * W) / grid))
      const y0 = Math.floor((gy * H) / grid)
      const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * H) / grid))
      let dark = 0
      let total = 0
      for (let y = y0; y < y1 && y < H; y++) {
        for (let x = x0; x < x1 && x < W; x++) {
          const i = (y * W + x) * 4
          // 背景是白、图形是黑：亮度越低越"实心"
          const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255
          if (lum < 0.5) dark++
          total++
        }
      }
      mask[gy][gx] = total && dark / total >= threshold ? 1 : 0
    }
  }
  return mask
}

/** 打印网格的 ASCII（审图与排错用） */
export function maskToAscii(mask) {
  return mask.map((row) => row.map((v) => (v ? '#' : '.')).join('')).join('\n')
}
