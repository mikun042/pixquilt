/**
 * 零依赖字节工具：CRC32 与 base64。
 *
 * 刻意不依赖 `Buffer` / `btoa`：这两个在 Node 与浏览器里互不相同，
 * 而本项目要求**同一份实现**同时服务页内 UI 与命令行 CLI（重构计划 §8 的 L3）。
 * 只依赖 `Uint8Array`，两边都能跑。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64[b0 >> 2]
    out += B64[((b0 & 3) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? B64[b2 & 63] : '='
  }
  return out
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = String(text).replace(/[^A-Za-z0-9+/=]/g, '')
  const len = clean.length
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  const out = new Uint8Array((len >> 2) * 3 - pad)
  let o = 0
  for (let i = 0; i < len; i += 4) {
    const c0 = B64.indexOf(clean[i])
    const c1 = B64.indexOf(clean[i + 1])
    const c2 = B64.indexOf(clean[i + 2])
    const c3 = B64.indexOf(clean[i + 3])
    out[o++] = (c0 << 2) | (c1 >> 4)
    if (o < out.length) out[o++] = ((c1 & 15) << 4) | (c2 >> 2)
    if (o < out.length) out[o++] = ((c2 & 3) << 6) | (c3 & 63)
  }
  return out
}

/** 文件名安全化：去扩展名 + 替换 Windows 非法字符（导出时统一走这里） */
export function safeFileBase(name: string | undefined): string {
  let base = (name ?? '').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_')
  base = base.replace(/[\s.]+$/, '').trim()
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base = `${base}_file`
  if (base.length > 120) base = base.slice(0, 120)
  return base || 'pixel-art'
}

/** 把 `</script>` 之类会在 HTML 里提前收尾的序列转义（内联脚本时用） */
export function escapeForInlineScript(code: string): string {
  return code.replace(/<\/script>/gi, '<\\/script>')
}
