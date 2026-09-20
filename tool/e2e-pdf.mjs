#!/usr/bin/env node
/**
 * PDF 与图标专项验证。
 *
 * 两件事必须用真浏览器验，不能只靠单测：
 *
 * 1. **浏览器侧的 PDF 压缩格式**。PDF 的 `/FlateDecode` 要的是 **zlib 容器**
 *    （2 字节头 + adler32），不是裸 deflate。浏览器的 `CompressionStream('deflate')`
 *    按规范是 zlib 格式、裸的对应 `'deflate-raw'`——但这条只能实测确认：
 *    猜错的后果是 PDF 能生成却打不开，而单测用的是 Node 的 zlib，测不到浏览器这条路径。
 *    这里把页面上生成的 PDF 拿回来，用 Node 的 `inflateSync` 解压并断言能读回号色文字。
 *
 * 2. **吸管图标真的画出来了**。"有 svg 元素"不代表"是支吸管"，
 *    所以断言子路径几何：落在 viewBox 内、尺度足够、无退化笔画。
 *
 * 用法：node tool/e2e-pdf.mjs [--app <html 路径>]
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'

import { argValue, createChecker, sleep, startBrowser } from './cdp.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// 默认与其余 e2e 脚本一致，指向**根目录那份已入库的交付物**——
// 此前默认 `dist/index.html`（构建产物、gitignore），于是新克隆下直接跑本脚本会报
// "找不到产物"，而交付物明明就在根目录。要测构建产物请显式 `--app dist/index.html`。
const app = argValue('app', join(ROOT, '像素画工作台.html'))
if (!existsSync(app)) {
  console.error(`找不到产物：${app}（先跑 npm run build）`)
  process.exit(2)
}

const { results, check, assert, report } = createChecker('PDF 与图标验证')

/* ---------------------------------------------- CDP */

// 这个脚本原先用"读 DevToolsActivePort 文件"的方式取端口（stdout 抓不到 ws 时的备选路径），
// 共用模块两种方式都支持，这里保持它原来的策略不变。
const session = await startBrowser({ profilePrefix: 'e2e-pdf-', portStrategy: 'portfile', extraArgs: ['--window-size=1400,900'] })
const { cdp } = session

/** PDF 解析：取出所有 stream 并解压（只认独立成行的 stream 标记，避开 startxref 里的子串） */
function pdfStreams(bytes) {
  const text = new TextDecoder('latin1').decode(bytes)
  const out = []
  const re = /^stream$/gm
  let m
  while ((m = re.exec(text))) {
    const start = m.index + 'stream'.length + 1
    const end = text.indexOf('\nendstream', start)
    if (end < 0) continue
    out.push(bytes.subarray(start, end))
    re.lastIndex = end
  }
  return out
}

async function main() {
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.navigate', { url: pathToFileURL(app).href })

  let ready = false
  for (let i = 0; i < 80; i++) {
    if (await cdp.eval('!!window.pixelArtStudio')) { ready = true; break }
    await sleep(200)
  }
  check('页面装配：window.pixelArtStudio 已挂载', () => {
    assert(ready, '脚本未在 16 秒内完成装配')
    return 'ok'
  })
  if (!ready) return

  /* ---------------- 吸管图标 ---------------- */

  /*
   * 选择器必须**明确指向吸管**，不能再用 `.cp-icon-btn svg || .tool-btn svg`。
   *
   * 那个写法原先能跑，只是因为当时整个 DOM 里只有吸管一个 SVG。2026-09-15 引入像素图标后，
   * `.tool-btn svg` 命中的是**画笔**（单条实心 path），于是断言报
   * "吸管至少要有管身与管头两条路径，实际 1"——失败信息指向吸管，出问题的却是选择器。
   * 靠"DOM 里只有它一个"这种隐式约定的断言，加进第二个同类元素就会崩；改成按名字找。
   */
  const geom = JSON.parse(await cdp.eval(`(() => {
    const pickBtn = [...document.querySelectorAll('.tool-btn')]
      .find((b) => (b.title || '').includes('取色'))
    const svg = (pickBtn && pickBtn.querySelector('svg')) ||
      document.querySelector('.cp-icon-btn svg')
    if (!svg) return JSON.stringify({ error: '找不到吸管 SVG（既不在取色工具按钮里，也不在取色器里）' })
    const paths = [...svg.querySelectorAll('path')].map((p) => {
      const b = p.getBBox()
      return { x: b.x, y: b.y, w: b.width, h: b.height, len: p.getTotalLength() }
    })
    const box = paths.reduce((a, p) => ({
      x0: Math.min(a.x0, p.x), y0: Math.min(a.y0, p.y),
      x1: Math.max(a.x1, p.x + p.w), y1: Math.max(a.y1, p.y + p.h),
    }), { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 })
    return JSON.stringify({ paths, box, viewBox: svg.getAttribute('viewBox') })
  })()`))

  check('吸管图标：是内联 SVG（不是准星字符），且笔画几何有效', () => {
    assert(!geom.error, geom.error)
    assert(geom.paths.length >= 2, `吸管至少要有管身与管头两条路径，实际 ${geom.paths.length}`)
    assert(geom.viewBox === '0 0 24 24', `viewBox 应为 0 0 24 24，实际 ${geom.viewBox}`)
    const { box } = geom
    assert(box.x0 >= 0 && box.y0 >= 0 && box.x1 <= 24 && box.y1 <= 24, `笔画超出画布会被裁切：${JSON.stringify(box)}`)
    assert(box.x1 - box.x0 >= 12 && box.y1 - box.y0 >= 12, `图标过小：宽 ${(box.x1 - box.x0).toFixed(1)} 高 ${(box.y1 - box.y0).toFixed(1)}`)
    for (const p of geom.paths) assert(p.len > 2, `存在退化笔画（长度 ${p.len.toFixed(2)}）`)
    return `${geom.paths.length} 条路径，包围盒 ${box.x1 - box.x0 < 0 ? '' : ''}${(box.x1 - box.x0).toFixed(1)}×${(box.y1 - box.y0).toFixed(1)}`
  })

  const toolIcon = JSON.parse(await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('.tool-btn')].find((b) => (b.title || '').includes('取色'))
    if (!btn) return JSON.stringify({ error: '工具条里找不到取色工具' })
    const svg = btn.querySelector('svg')
    const r = svg ? svg.getBoundingClientRect() : null
    return JSON.stringify({ hasSvg: !!svg, w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0,
      text: btn.textContent.trim(), stroke: svg ? getComputedStyle(svg).stroke : null })
  })()`))

  check('取色工具按钮：用吸管图标且跟随文字色（currentColor 生效）', () => {
    assert(!toolIcon.error, toolIcon.error)
    assert(toolIcon.hasSvg, '工具按钮里没有 SVG 图标')
    assert(toolIcon.w > 8 && toolIcon.h > 8, `图标尺寸为 0（${toolIcon.w}×${toolIcon.h}）`)
    assert(/^rgb/.test(toolIcon.stroke), `stroke 未解析成颜色（currentColor 没生效）：${toolIcon.stroke}`)
    return `${toolIcon.text} · ${toolIcon.w}×${toolIcon.h} · ${toolIcon.stroke}`
  })

  /* ---------------- 浏览器侧 PDF ---------------- */

  // 用页面 API 直接生成 PDF：不依赖点击导出（无头下下载行为不可靠），但走的是同一条实现
  const pdfInfo = JSON.parse(await cdp.eval(`(async () => {
    const ps = window.pixelArtStudio
    ps.newCanvas({ width: 24, height: 18, color: '#ffffff', transparent: false })
    ps.edit([
      { op: 'rect', x0: 0, y0: 0, x1: 23, y1: 17, color: '#e94560' },
      { op: 'rect', x0: 4, y0: 4, x1: 12, y1: 12, color: '#1a1a2e' },
      { op: 'rect', x0: 16, y0: 4, x1: 20, y1: 8, color: '#f5f5f5' },
    ])
    const mod = await import('./app/pdf.js').catch(() => null)
    return JSON.stringify({ hasModule: !!mod, compressed: typeof CompressionStream !== 'undefined' })
  })()`))

  check('浏览器支持 CompressionStream（PDF 压缩依赖它）', () => {
    assert(pdfInfo.compressed, '当前浏览器没有 CompressionStream，PDF 导出会明确报错而不是产出坏文件')
    return '可用'
  })

  /*
   * 真正生成 PDF。页面里没有暴露 PDF 方法（它是 UI 功能），
   * 所以这里直接驱动导出菜单按钮，并把生成的 Blob 截下来换成 base64 传回 Node 校验。
   * 拦截方式：临时替换 URL.createObjectURL，拿到 Blob 后读成 ArrayBuffer。
   */
  const b64 = await cdp.eval(`(async () => {
    const ps = window.pixelArtStudio
    ps.setParams({ paletteMode: 'preset', presetPaletteId: 'beads16' })
    // 挂上钩子：download() 会调用 URL.createObjectURL(blob)
    const orig = URL.createObjectURL
    let captured = null
    URL.createObjectURL = (blob) => { captured = blob; return orig.call(URL, blob) }
    try {
      document.getElementById('btn-export').click()
      await new Promise((r) => setTimeout(r, 200))
      const item = document.querySelector('[data-testid="export-bead-pdf"]')
      if (!item) return JSON.stringify({ error: '导出菜单里没有 PDF 项' })
      if (item.disabled) return JSON.stringify({ error: 'PDF 项被禁用（应该已有画布）' })
      item.click()
      for (let i = 0; i < 60 && !captured; i++) await new Promise((r) => setTimeout(r, 100))
      if (!captured) return JSON.stringify({ error: '8 秒内没有产出 Blob' })
      const buf = new Uint8Array(await captured.arrayBuffer())
      let s = ''
      for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i])
      return JSON.stringify({ size: buf.length, type: captured.type, b64: btoa(s) })
    } finally { URL.createObjectURL = orig }
  })()`)

  const pdf = JSON.parse(b64)
  check('界面导出 PDF：产出非空 application/pdf Blob', () => {
    assert(!pdf.error, pdf.error)
    assert(pdf.type === 'application/pdf', `MIME 应为 application/pdf，实际 ${pdf.type}`)
    assert(pdf.size > 1000, `文件过小（${pdf.size} 字节），可能是空文档`)
    return `${pdf.size} 字节`
  })

  if (!pdf.error && pdf.b64) {
    const bytes = Buffer.from(pdf.b64, 'base64')
    const text = bytes.toString('latin1')

    // 调试用：把浏览器产出的 PDF 落盘，便于逐字节核对（--keep 时保留）
    if (process.argv.includes('--keep')) {
      const { mkdirSync, writeFileSync } = await import('node:fs')
      const p = join(ROOT, '.tmp', 'browser-bead.pdf')
      // `.tmp/` 是 gitignore 的临时目录，不保证存在（清理过、或刚 clone）：不建目录就直接写会 ENOENT
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, bytes)
      console.log(`  （已保存浏览器产出的 PDF：${p}）`)
    }

    check('浏览器产出的 PDF：结构与 xref 偏移正确', () => {
      assert(text.startsWith('%PDF-1.4'), 'PDF 头缺失')
      assert(text.trimEnd().endsWith('%%EOF'), 'PDF 尾缺失')
      const xrefAt = /^xref$/m.exec(text)
      assert(xrefAt, '缺少 xref')
      const startxref = Number(/^startxref\r?\n(\d+)/m.exec(text)?.[1])
      assert(startxref === xrefAt.index, `startxref(${startxref}) 没指向 xref(${xrefAt.index})`)
      const trailerAt = /^trailer$/m.exec(text)
      const count = Number(/^xref\r?\n0 (\d+)/m.exec(text)?.[1])
      const entries = [...text.slice(xrefAt.index, trailerAt.index).matchAll(/(\d{10}) (\d{5}) ([nf])/g)]
      assert(entries.length === count, `xref 记录数 ${entries.length} != 声明 ${count}`)
      for (let i = 1; i < entries.length; i++) {
        const off = Number(entries[i][1])
        assert(text.startsWith(`${i} 0 obj`, off), `xref[${i}] 指向 ${off}，那里是 ${JSON.stringify(text.slice(off, off + 14))}`)
      }
      return `${count} 个对象，偏移全部正确`
    })

    /*
     * 本条是整个文件的核心：浏览器用 CompressionStream('deflate') 压出来的流，
     * 必须能被 Node 的 zlib **以 zlib 容器**解开。解不开就说明浏览器那条路写错了格式
     * （例如误用 deflate-raw），而那种 PDF 在阅读器里会直接报错。
     */
    check('浏览器 CompressionStream 产出的是 zlib 容器（不是裸 deflate）', () => {
      const streams = pdfStreams(bytes)
      assert(streams.length >= 1, '没有找到任何 stream')
      const first = streams[0]
      assert(first[0] === 0x78, `zlib 头首字节应为 0x78，实际 0x${first[0].toString(16)}（若是裸 deflate 则 PDF 打不开）`)
      let content
      try {
        content = inflateSync(first).toString('latin1')
      } catch (e) {
        throw new Error(`Node 无法以 zlib 解开浏览器的流：${e.message}`)
      }
      const codes = [...content.matchAll(/\(([A-Z]\d+)\) Tj/g)].map((m) => m[1])
      assert(codes.length > 0, '解压后没有号色文字，内容流可能是空的')
      assert(!/[^\x00-\x7f]/.test(content), '内容流里出现非 ASCII（会显示成乱码）')
      return `zlib 头 0x78，解压得 ${content.length} 字节、${codes.length} 条号色`
    })

    check('浏览器产出的 PDF：格内号色覆盖全部不透明格', () => {
      const content = inflateSync(pdfStreams(bytes)[0]).toString('latin1')
      const codes = [...content.matchAll(/\(([A-Z]\d+)\) Tj/g)].map((m) => m[1])
      // 24×18 = 432 格；用例里全幅涂满，所以号色数应等于 432
      assert(codes.length === 432, `号色数应等于不透明格数 432，实际 ${codes.length}`)
      return `${codes.length} 格`
    })

    /*
     * 排版三件套：自适应 A4、尽量不跨页、号色字号小到不挤格子。
     * 用同一份浏览器产出的 PDF 就能验——不必另跑 CLI。
     */
    const geometry = () => {
      const content = inflateSync(pdfStreams(bytes)[0]).toString('latin1')
      const segs = [...content.matchAll(/([\d.]+) ([\d.]+) m\n([\d.]+) ([\d.]+) l\nS/g)]
      const vx = [...new Set(segs.filter((s) => Math.abs(Number(s[1]) - Number(s[3])) < 0.001).map((s) => Number(s[1])))].sort(
        (a, b) => a - b,
      )
      const cell = vx.length >= 2 ? Math.min(...vx.slice(1).map((x, i) => x - vx[i])) : NaN

      /*
       * 号色字号**从号色文字实际用的 Tf 反推**，不要"猜一个尺寸区间来筛"。
       * 我第一版按 `size <= 6` 过滤，而格子大时号色字号会超过 6pt（上限 6.5），
       * 于是被自己的过滤器丢掉，断言误报"没有找到号色字号"。
       * 号色的特征不是"字小"，而是"内容是 B01/G02 这样的编号"。
       */
      const codeSizes = []
      for (const blk of content.matchAll(/BT\n([\s\S]*?)ET/g)) {
        if (!/\(([A-Z]\d+)\) Tj/.test(blk[1])) continue
        const tf = /\/Helvetica(?:-Bold)? ([\d.]+) Tf/.exec(blk[1])
        if (tf) codeSizes.push(Number(tf[1]))
      }
      return { vx, cell, code: codeSizes.length ? codeSizes[0] : NaN, codeCount: codeSizes.length, content }
    }

    check('排版：常规尺寸自适应成一页，且内容落在页边距内', () => {
      const g = geometry()
      assert(Number(/\/Type \/Pages \/Count (\d+)/.exec(text)?.[1]) === 1, '24×18 这种小画布必须是单页')
      assert(g.vx.length >= 2, '没找到竖网格线')
      const span = g.vx[g.vx.length - 1] - g.vx[0]
      assert(span <= 595.28 - 40, `图纸宽度 ${span.toFixed(1)}pt 超出 A4 可用宽度`)
      return `${g.vx.length} 条竖线，格子 ${(g.cell / 72 * 25.4).toFixed(2)}mm，跨 ${span.toFixed(0)}pt`
    })

    check('排版：号色字号明显小于格子边长（不再挤满格子）', () => {
      const g = geometry()
      assert(g.code > 0, '没有找到号色字号')
      /*
       * 断言的是**比例区间**，不是精确值：将来微调比例属于设计调整，不该让测试红；
       * 但两端越界都要抓住——用户就是为"字挤满格子"反馈的。
       *
       * 上限 45%：旧版实测 62%（min(6.5, cellW*0.62)，字几乎贴边）。
       * 下限 15%：格宽比例受 `MAX_CODE_PT` 兜底，**超大格子上的比例必然偏低**——
       * 本用例 24×18 的格子有 7.93mm，6.5pt 上限对应约 2.3mm 字，占 29%。
       * 想要这个比例也到 45% 就得把上限抬到 15pt 以上，那会让大画布上的字失控变大。
       * 宁可让"格子特别大时字相对偏小"，也不要"格子小的时候字糊成一团"。
       */
      const ratio = g.code / g.cell
      assert(ratio <= 0.45, `号色字号占格宽 ${(ratio * 100).toFixed(0)}%，超过 45% 会挤到格子边框`)
      assert(ratio >= 0.15, `号色字号只占格宽 ${(ratio * 100).toFixed(0)}%，小到读不了`)
      return `字号 ${(g.code / 72 * 25.4).toFixed(2)}mm / 格子 ${(g.cell / 72 * 25.4).toFixed(2)}mm = ${(ratio * 100).toFixed(0)}%`
    })
  }
}

let fatal = null
try {
  await main()
} catch (err) {
  fatal = err
}

await session.close()
if (fatal) {
  console.log(`
✘ 运行中断：${fatal.message}`)
  process.exit(1)
}
report()
