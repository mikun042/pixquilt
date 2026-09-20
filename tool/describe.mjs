#!/usr/bin/env node
/**
 * 文档生成：由 `src/core/spec.ts`（元数据单一真源）生成 `docs/AGENT_API.md`。
 *
 * 为什么生成而不是手写：旧项目的算子表只活在 Markdown 里，代码改了文档没改，agent 就按错的信息干活。
 * 这里把「文档 = 元数据的投影」：算子、参数、色卡、上限全部从 `src/core/spec.ts` 投影而来。
 *
 * 两道防线（都在 `npm test` 里自动跑）：
 *  1. 本脚本每次运行都与 `tool/artc.mjs` 的 `KNOWN_FLAGS` 对账——参数表少收录或多收录都会直接抛错；
 *  2. `src/test/describe-freshness.test.ts` 把 `build()` 的输出与仓库里的 `docs/AGENT_API.md`
 *     逐字节比对，所以"改了 `spec.ts` 忘了重跑 describe"会**直接变红**（此前只写在文档里，没有守着）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CAPABILITIES, OP_SPECS, PARAM_SPECS } from '../src/core/spec.ts'
import { STYLE_PRESETS } from '../src/core/types.ts'
import { KNOWN_FLAGS } from './artc.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT = join(ROOT, 'docs', 'AGENT_API.md')

function fieldTable(fields) {
  if (fields.length === 0) return '_无参数_\n'
  const rows = fields.map((f) => {
    const def = f.default === undefined ? '—' : `\`${JSON.stringify(f.default)}\``
    return `| \`${f.name}\` | ${f.type} | ${f.required ? '必填' : '可选'} | ${def} | ${f.desc} |`
  })
  return ['| 字段 | 类型 | 必填 | 默认 | 说明 |', '|---|---|---|---|---|', ...rows].join('\n') + '\n'
}

function paramTable() {
  const rows = PARAM_SPECS.map((p) => {
    let range = '—'
    if (p.enum) range = p.enum.map((e) => `\`${e}\``).join(' / ')
    else if (p.min !== undefined || p.max !== undefined) range = `${p.min ?? '−∞'} … ${p.max ?? '∞'}`
    const when = p.when ? `（${p.when}）` : ''
    return `| \`${p.key}\` | ${p.type} | ${range} | \`${JSON.stringify(p.default)}\` | ${p.desc}${when} |`
  })
  return ['| 参数 | 类型 | 范围 | 默认 | 说明 |', '|---|---|---|---|---|', ...rows].join('\n') + '\n'
}

export function build() {
  const lines = []
  lines.push('# 像素画工作台 · Agent 接口手册')
  lines.push('')
  lines.push('> **本文件由 `node tool/describe.mjs --write` 从 `src/core/spec.ts` 生成，请勿手改。**')
  lines.push('> 改了 `src/core/spec.ts` 里的算子 / 参数元数据后，必须重跑 `npm run describe` 再提交。')
  lines.push('')
  lines.push('这份手册是给 **AI agent 与脚本** 用的：不点界面就能完成「导入 → 调参 → 转换 → 编辑 → 导出」，')
  lines.push('并覆盖本项目的两个主要用途——**拼豆图纸**与**可批量生产的游戏美术资产**。')
  lines.push('')
  lines.push('## 0. 三条最快的上手路径')
  lines.push('')
  lines.push('```bash')
  lines.push('# ① 命令行批处理（不需要浏览器，零第三方依赖）')
  lines.push('node tool/artc.mjs --in 素材目录 --out 输出 --palette beads16 --long-edge 58 --bead')
  lines.push('node tool/artc.mjs --in 素材目录 --out 输出 --palette gameboy --size 32x32 --alpha --sheet 4')
  lines.push('')
  lines.push('# ② 自检与自省（先确认环境与能力，再写脚本）')
  lines.push('node tool/artc.mjs --selftest      # 链路自检，无需任何素材（以它自己打印的 N/N 为准）')
  lines.push('node tool/artc.mjs --describe     # 打印完整的算子/参数/能力 JSON')
  lines.push('')
  lines.push('# ③ 页内 API（浏览器自动化 / Playwright / CDP evaluate）')
  lines.push('#    打开 像素画工作台.html 后：window.pixelArtStudio.describe()')
  lines.push('```')
  lines.push('')
  lines.push(`- 接口版本：\`apiLevel = ${CAPABILITIES.apiLevel}\`，产品版本 \`${CAPABILITIES.version}\`，项目文件 Schema \`v${CAPABILITIES.schemaVersion}\``)
  lines.push(`- 上限：画布单边 ≤ ${CAPABILITIES.canvasSideMax} 格；色板 ≤ ${CAPABILITIES.paletteMax} 色；导出单边 ≤ ${CAPABILITIES.exportSideMax}px 且面积 ≤ ${CAPABILITIES.exportPixelsMax} 像素`)
  lines.push(`- 多帧动画：**尚未实现**（\`capabilities().animation === false\`）；动画素材请逐帧出图后用 \`--sheet\` 拼图集`)
  lines.push('')
  lines.push('## 1. 命令行参数（tool/artc.mjs）')
  lines.push('')
  lines.push('```')
  lines.push('node tool/artc.mjs --in <目录或文件> --out <目录> [选项]')
  lines.push('node tool/artc.mjs --blank 58x58 --bead --palette beads16 --out out')
  lines.push('node tool/artc.mjs --ops \'[{"op":"eraseColor","color":"#ffffff"},{"op":"trim"}]\' --in 素材 --out 输出')
  lines.push('```')
  lines.push('')
  lines.push('| 参数 | 说明 |')
  lines.push('|---|---|')
  /*
   * CLI 参数表：每行是 `[显示名, 说明, 它覆盖的 flag 名]`。
   *
   * 这张表**必须覆盖 tool/artc.mjs 的 KNOWN_FLAGS 全集**，下面有对账逻辑强制这一点。
   * 起因：它原先是一张手写且不完整的表，漏掉了 `--blank` / `--blank-transparent` / `--ops-file` /
   * `--no-cleanup` / `--preset` / `--pdf` / `--progress` / `--quiet` 等已经实现的开关——
   * 因为文档的"单一真源"只覆盖算子与参数元数据，**不含 CLI 开关**，于是这一块悄悄漂移了很久。
   */
  const cli = [
    ['--in', '输入目录（递归）或单张图片；Node 端仅 PNG 可直接解码，其他格式需先转 PNG 或用浏览器通道', ['in']],
    ['--out', '输出目录（默认 out/）', ['out']],
    ['--name', '命名模板：`{name}` `{index}` `{index:02}` `{w}` `{h}` `{scale}`', ['name']],
    ['--scale', 'PNG 整数倍放大（默认 1，超限自动降档）', ['scale']],
    ['--json', '以 JSON 打印汇总（含每张的 hash / 尺寸 / 用量）；stdout 只有这一份 JSON，可直接 parse。**注意两套尺寸/透明字段**：`width`/`height`/`transparent` 是模型侧（格数、alphaMask），`pngWidth`/`pngHeight`/`pngTransparent` 是产物侧（含 `--scale` 放大与 `--transparent` 键控）；判断产物请用后者', ['json']],
    ['--dry-run', '只打印解析后的参数，不处理图片', ['dry-run']],
    ['--quiet', '少打印过程信息', ['quiet']],
    ['--progress', '与 `--json` 同用时把进度行写到 stderr（保证 stdout 仍是纯 JSON）', ['progress']],
    ['--help', '打印帮助；**未知参数一律报错**（不会静默忽略），错误信息会给出最接近的正确参数名', ['help']],

    ['--blank <WxH>', '建一张空白画布（不读任何素材），可继续用 `--ops` 作画', ['blank']],
    ['--blank-color', '空白填充色（默认 #ffffff）', ['blank-color']],
    ['--blank-transparent', '空白为透明（只影响底色，与 `--palette` / `--size` 无关）', ['blank-transparent']],
    ['--index', '命名模板里 `{index}` 的取值（批量空白时用于区分同名产物）', ['index']],

    ['--long-edge', '输出长边格数（8–2048）', ['long-edge']],
    ['--size', '强制精确尺寸 `WxH`（游戏资产用，覆盖 --long-edge）', ['size']],
    ['--downsample', '`average` \\| `nearest`', ['downsample']],
    ['--crop', '`free` \\| `1:1` \\| `4:3` \\| `16:9`', ['crop']],
    ['--palette', '`auto` \\| 预置 id（见下）\\| `*.hex` 文件 \\| `#aabbcc,#112233`', ['palette']],
    ['--preset', '只指定预置色卡（等价于 `--palette <预置 id>`；带号色的卡会把号色写进图纸 / 清单 / `.hex`）', ['preset']],
    ['--palette-k', '自动取色颜色数（2–64）', ['palette-k']],
    ['--style', STYLE_PRESETS.map((s) => s.id).join(' / '), ['style']],
    ['--dither', '`none` \\| `floyd` \\| `atkinson` \\| `bayer` \\| `bayer8`', ['dither']],
    ['--dither-max-colors', '抖动时最多用到几种色号（0=不限）；拼豆场景约束到"手上只有这么多种"', ['dither-max-colors']],
    ['--quality', '额外输出图纸质量报告（保真误差 / 色号数 / 珠子数 / 抖动代价）', ['quality']],
    ['--auto-tune', '自动搜参：在「色号数 ≤ n」约束下找观感最好的参数组合（确定性）', ['auto-tune']],
    ['--no-cleanup', '关闭杂色清理（像素素材请开它：清理会吃掉 1px 高光/描边断点）', ['no-cleanup']],
    ['--cleanup-min', '杂色清理阈值（1–10）', ['cleanup-min']],
    ['--brightness / --contrast / --saturation', '预处理（-100…100）', ['brightness', 'contrast', 'saturation']],
    ['--alpha', '保留原图透明（真 alpha 通道）', ['alpha']],
    ['--transparent', '背景色导出为透明（单色键控）', ['transparent']],
    ['--matte', '合成 / 键控底色（默认 #ffffff）', ['matte']],
    [
      '--key-mode',
      '键控范围：`global`（默认）全图同色都透明；`border` 只键掉与四边连通的底色区域。白底 + 主体内部有同色高光（眼白/高光）时必须用 `border`，否则那些像素会被一起挖穿成洞',
      ['key-mode'],
    ],
    [
      '--key-tolerance',
      '键控颜色容差 0–255（三通道最大差，默认 0 = 精确同色）。扩散模型（ComfyUI 等）输出的「白底」实际是 254/255 混合噪声，容差 0 一个都键不掉，需要 1–3',
      ['key-tolerance'],
    ],
    ['--lock-palette', '只允许使用给定色板（拼豆与资产批次必备）', ['lock-palette']],
    [
      '--browser-decode',
      '借无头浏览器原生解码器，把 Node 解不了的格式（JPEG/WebP/GIF/BMP/AVIF/ICO/SVG）先转 PNG 再处理。**需要本机有 Chrome/Edge/Chromium**；不加时非 PNG 会被跳过并如实报告（不是静默忽略）',
      ['browser-decode'],
    ],

    [
      '--slice',
      '把输入图**切成多张**（与 `--sheet` 方向相反：`--sheet` 拼图集、`--slice` 拆图集）。`auto` 按全透明行/列自动推断；`列数x行数` 显式网格；`WxHpx` 每格像素尺寸',
      ['slice'],
    ],
    ['--sheet [列数]', '输出 `_sheet.json` 图集坐标表（帧等尺寸 + offsetX/offsetY）', ['sheet']],
    ['--pixbin', '额外输出 `.pixbin`（二进制像素数据，大画布往返更快）', ['pixbin']],
    [
      '--engine <格式>',
      '在 `_sheet.json` 之外，再输出一份**引擎能直接吃**的图集元数据：`godot`（`.tres` SpriteFrames）/ `unity`（`.meta` 的 spriteSheet 段，需 `--texture-guid`）/ `tiled`（`.tsx`）。坐标与 `_sheet.json` 同源',
      ['engine'],
    ],
    ['--texture-path <路径>', '`--engine` 里引用的贴图路径（默认 `_sheet.png`）', ['texture-path']],
    ['--texture-guid <guid>', 'Unity 格式**必需**：从你那份 `.png.meta` 里取（没有 guid 的 `.meta` 无效，所以这里直接报错而不是留空）', ['texture-guid']],
    ['--ppu <n>', 'Unity 的 `pixelsPerUnit`（默认取帧高——像素画要的是「1 格 = 1 单位」，不是 Unity 默认的 100）', ['ppu']],
    ['--tile-size <WxH>', 'Tiled 的瓦片尺寸（默认取帧尺寸）', ['tile-size']],
    ['--bead [每板格数]', '拼豆模式：输出 `*_图纸.svg` 与 `*_缺口清单.csv`（默认每板 58 格）', ['bead']],
    ['--pdf', '额外输出 `*_拼豆图纸.pdf`（A4 分页可打印；需同时用 `--bead`）', ['pdf']],
    ['--bead-mm / --bead-gram', '单颗直径 mm（默认 5）/ 单颗重量 g（默认 0.08）', ['bead-mm', 'bead-gram']],
    ['--board', '每板格数（默认 58）', ['board']],

    ['--ops', '算子数组 JSON（见第 3 节），与页内 `edit()` 完全一致', ['ops']],
    ['--ops-file', '从文件读算子数组（也写作 `--ops @file.json`）；批量 setCells 动辄十几 KB，走文件可避开 shell 长度与引号转义', ['ops-file']],

    ['--selftest', '跑内置链路自检（无需素材）', ['selftest']],
    ['--describe', '打印完整能力 / 算子 / 参数 JSON', ['describe']],
  ]
  for (const [k, v] of cli) lines.push(`| \`${k}\` | ${v} |`)
  lines.push('')
  lines.push('> 上表与 CLI 真正接受的开关集**每次生成时对账**（对的是 `tool/artc.mjs` 的 `KNOWN_FLAGS`）：')
  lines.push('> 少收录或多收录任何一项都会让本脚本直接报错，不再靠人记得同步。')
  lines.push('')
  {
    const documented = new Set(cli.flatMap(([, , flags]) => flags))
    const missing = [...KNOWN_FLAGS].filter((f) => !documented.has(f))
    const extra = [...documented].filter((f) => !KNOWN_FLAGS.has(f))
    if (missing.length || extra.length) {
      throw new Error(
        'CLI 参数表与 tool/artc.mjs 的 KNOWN_FLAGS 不一致：' +
          (missing.length ? `未收录 ${missing.map((f) => `--${f}`).join(' / ')}` : '') +
          (missing.length && extra.length ? '；' : '') +
          (extra.length ? `多出（CLI 里并不存在）${extra.map((f) => `--${f}`).join(' / ')}` : ''),
      )
    }
  }
  lines.push('**退出码**：单张素材失败不会中断整批（逐张隔离），结尾给出失败清单；只要有失败就以非零码退出。')
  lines.push('因此推荐流程是：跑一次 → 读失败清单 → 修素材 → 重跑。')
  lines.push('')
  lines.push('### 预置色卡')
  lines.push('')
  lines.push('**`source` 决定色号可不可信**（三类，别混用）：')
  lines.push('')
  lines.push('- `official` —— 厂商/规范公开的色表，色号与颜色是权威的。')
  lines.push('- `community` —— **社区整理**的品牌拼豆色卡，有据可查但**不保证与实物零偏差**，以实物为准。')
  lines.push('- `approximate` —— 我们自造的通用近似色，只为让图纸有稳定号色，不属任何品牌。')
  lines.push('')
  lines.push('| id | 名称 | 色数 | 号色 | 来源 | 说明 |')
  lines.push('|---|---|---|---|---|---|')
  for (const p of CAPABILITIES.presets) {
    lines.push(`| \`${p.id}\` | ${p.name} | ${p.colors} | ${p.hasCodes ? '有' : '无'} | ${p.source} | ${p.desc} |`)
  }
  lines.push('')
  lines.push('> 品牌色卡取自 [maxcleme/beadcolors](https://github.com/maxcleme/beadcolors)（MIT），')
  lines.push('> 由 `tool/bead-palettes.mjs` 生成。**Mard（290 色）与 Diamond Dotz（461 色）因超过色板上限 256 未收录**；')
  lines.push('> 需要它们时用 `--palette 我的色卡.hex` 导入（支持带号色），或等索引位宽迁移（属独立一轮）。')
  lines.push('')
  lines.push('### 风格预设（一次性套用一组参数）')
  lines.push('')
  lines.push('| id | 名称 | 说明 |')
  lines.push('|---|---|---|')
  for (const s of CAPABILITIES.stylePresets) lines.push(`| \`${s.id}\` | ${s.name} | ${s.desc} |`)
  lines.push('')
  lines.push('## 2. 转换参数')
  lines.push('')
  lines.push(paramTable())
  lines.push('所有参数都会过一遍校验：越界夹紧、坏类型回退默认，**并且如实报告每一处修正**')
  lines.push('（页内 `validateParams()`，CLI 的 `--dry-run` 会打印）。这样 agent 不会误以为"我传的值生效了"。')
  lines.push('')
  lines.push('## 3. 编辑算子（声明式）')
  lines.push('')
  lines.push('同一套算子在三个入口完全一致：CLI `--ops`、页内 `edit(ops)`、页内 `render(..., { ops })`。')
  lines.push('')
  for (const spec of OP_SPECS) {
    lines.push(`### \`${spec.op}\``)
    lines.push('')
    lines.push(spec.desc)
    lines.push('')
    lines.push(fieldTable(spec.fields))
    if (spec.notes?.length) {
      lines.push('注意：')
      for (const n of spec.notes) lines.push(`- ${n}`)
      lines.push('')
    }
  }
  lines.push('### 统一返回形状（`EditSummary`）')
  lines.push('')
  lines.push('```json')
  lines.push('{')
  lines.push('  "applied": true,')
  lines.push('  "changes": [{ "op": "rect", "cells": 256, "changed": true }],')
  lines.push('  "width": 64, "height": 64,')
  lines.push('  "paletteSize": 9, "hasAlpha": false, "transparent": 0,')
  lines.push('  "usage": { "#112233": 256 }')
  lines.push('}')
  lines.push('```')
  lines.push('')
  lines.push('- **`changed` 是权威判定**：索引 / 不透明度 / 尺寸任一变化都算改动（含"只挖洞不改色"的编辑）。')
  lines.push('- `cells` 是受影响格数；形状重排记 0 并用 `kind` 说明（例如 `rotate90`）。')
  lines.push('- 整串算子都没改动时 `applied: false`。')
  lines.push('')
  lines.push('## 4. 页内 API（`window.pixelArtStudio`）')
  lines.push('')
  lines.push('打开单文件 HTML 后自动挂载。**所有方法名与返回形状保持稳定**，新增能力只做加法。')
  lines.push('')
  lines.push('### 自省（先调这些，别猜）')
  lines.push('')
  lines.push('```js')
  lines.push('ps.describe()          // 能力 + 算子 + 参数，一次拿全')
  lines.push('ps.describeOps()       // 算子表（与本文档同源）')
  lines.push('ps.describeParams()    // 参数表')
  lines.push('ps.capabilities()      // 上限、解码格式、是否支持动画等')
  lines.push('ps.validateParams({ longEdge: 99999 })   // 干跑校验：不落状态，返回被修正的字段')
  lines.push('await ps.whenReady()   // 就绪信号（脚本开头调用一次）')
  lines.push('```')
  lines.push('')
  lines.push('### 转换与参数')
  lines.push('')
  lines.push('```js')
  lines.push('ps.getParams()                       // 当前参数（副本）')
  lines.push('ps.setParams({ longEdge: 64 })       // 改参并立即重转，返回最终参数')
  lines.push('ps.defaultParams()                   // 出厂默认（批处理的可复现基底）')
  lines.push('ps.applyStylePreset("gameboy")       // 套用预设（写状态）')
  lines.push('ps.stylePreset("gameboy")            // 只读查询预设（不改状态）')
  lines.push('ps.presetPalettes()                  // 预置色卡列表（含拼豆号色）')
  lines.push('await ps.importImage(fileOrBlobOrDataURLOrURL)')
  lines.push('ps.convert()                         // 用当前参数重跑（无原图会报错）')
  lines.push('ps.reset()                           // 清空工作区（不弹确认）')
  lines.push('```')
  lines.push('')
  lines.push('### 读取')
  lines.push('')
  lines.push('```js')
  lines.push('ps.getInfo()        // hasImage/width/height/paletteSize/hasAlpha/transparent/params/工具与颜色…')
  lines.push('ps.getPalette()     // 工作色板')
  lines.push('ps.getUsage()       // { "#hex": 格数 }（不含透明格，透明格见 countTransparent）')
  lines.push('ps.hasAlpha()  ps.countTransparent()  ps.artHash()')
  lines.push('```')
  lines.push('')
  lines.push('### 导出（返回字符串/字节，不触发下载）')
  lines.push('')
  lines.push('```js')
  lines.push('ps.exportPNG(scale, { transparentBg, bgHex })   // → dataURL')
  lines.push('//   transparentBg: true 时按「单色键控」把某个颜色导出为透明；bgHex 省略则自动用')
  lines.push('//   当前参数的 matteColor（键控色就是它），所以通常只传 transparentBg 即可')
  lines.push('ps.exportPixelJSON()                     // 每格颜色 + 每色用量（拼豆原料清单）')
  lines.push('ps.exportPaletteHex()                    // → .hex 文本')
  lines.push('ps.exportProject()                       // → 项目 JSON（参数+色板+像素，不含原图）')
  lines.push('ps.exportPixBin()                        // → base64 的二进制像素数据（大画布更快）')
  lines.push('ps.importPixBin(base64, palette?)        // 回读')
  lines.push('ps.loadProject(json)                     // 载入项目 JSON')
  lines.push('```')
  lines.push('')
  lines.push('### 拼豆与游戏资产')
  lines.push('')
  lines.push('```js')
  lines.push('ps.beadReport({ codes, beadMm, beadGram, boardCells })')
  lines.push('// → { rows:[{code,color,cells,beads,grams,bags}], colorCount, totalBeads, totalGrams,')
  lines.push('//     transparentCells, board:{columns,rows}, physical:{widthMm,heightMm} }')
  lines.push('ps.exportBeadSvg({ cellPx: 22 })   // 可打印图纸（格内写号色 + 板标注 + 图例）')
  lines.push('ps.exportBeadCsv()                 // 缺口清单（照着买）')
  lines.push('ps.layoutSheet(frames, columns, padding)  // 图集坐标表：帧等尺寸 + offsetX/offsetY')
  lines.push('ps.exportSheetMeta(fmt, frames, opts)      // 转成引擎格式：godot | unity（需 textureGuid）| tiled')
  lines.push('//   opts: { columns?, padding?, texturePath, textureGuid?, name?, pixelsPerUnit? }')
  lines.push('//   与 CLI 的 --engine 同一份实现（src/core/sheetmeta.ts），坐标同源、不会两处漂移')
  lines.push('```')
  lines.push('')
  lines.push('### 编辑（不必依赖界面操作，但**会改当前画布**）')
  lines.push('')
  lines.push('> 下面这些都写**当前工作区**：画布、撤销栈会跟着变，屏幕（如果开着）也会跟着刷新。')
  lines.push('> 想要"完全不碰工作区"的批处理，用 `render()` / `renderBlank()`——它们才是无副作用的。')
  lines.push('')
  lines.push('```js')
  lines.push('ps.newCanvas({ width: 32, height: 32, transparent: true })   // 空白画布（无需原图），并清空撤销栈')
  lines.push('ps.edit([{ op: "rect", x0: 4, y0: 4, x1: 27, y1: 27, color: "#223344" }, { op: "trim" }])')
  lines.push('ps.undo()  ps.redo()')
  lines.push('ps.render(fileOrDataURL, params, scale, { transparentBg, ops })      // 无副作用一站式')
  lines.push('await ps.renderBlank({ width: 32, height: 32, transparent: true, ops: [...] }, params, scale, { transparentBg })')
  lines.push('//   renderBlank = 「空白画布 + 算子 + 导出」的无副作用一站式（无需原图、不碰工作区状态），')
  lines.push('//   CLI 的 --blank 走的是同一条链路；返回形状与 render() 一致')
  lines.push('```')
  lines.push('')
  lines.push('### 编辑器状态写入')
  lines.push('')
  lines.push('```js')
  lines.push(`ps.setTool(${CAPABILITIES.tools.map((t) => `"${t}"`).join(' | ')} )`)
  lines.push('ps.setPrimary("#ff6600")   ps.setBg("#ffffff")   ps.swapColors()')
  lines.push('ps.setBrushSize(3)         ps.setEraseToAlpha(true)   ps.setLockPalette(true)')
  lines.push('ps.thumbnail(160)          // 原图缩略图 dataURL')
  lines.push('```')
  lines.push('')
  lines.push('## 5. 可以依赖的稳定约定')
  lines.push('')
  lines.push('- **确定性**：同一张图 + 同一组参数 + 同一串算子 = 同一结果；用 `artHash()` / `--json` 里的 `hash` 跨运行比对。')
  lines.push('- **镜像同步**：`setParams` / `importImage` / `reset` / `loadProject` 之后，**同一次 JS 调用内**紧接读 `getInfo` / `getUsage` / `exportPNG` 就能拿到最新值，不需要等下一帧。')
  lines.push('- **无副作用路径**：`render()` 不碰当前画布、撤销栈与偏好，适合批量；`edit()` / `newCanvas()` 会改当前画布并进撤销栈。')
  lines.push('- **错误**：一律 `throw Error`（中文原因），例如无画布导出、色板里没有该颜色、图片解码失败、项目文件损坏。')
  lines.push('- **整体替换 = 新基线**：`newCanvas` / `loadProject` / `importPixBin` / `convert` / `reset`（以及界面上的导入、重新转换、新建）')
  lines.push('  都是**换掉整幅画布**，因此会**清空撤销栈**——之后 `undo()` 不会回到上一张画布。')
  lines.push('  只有 `edit()` 这类"在现有画布上改"的操作才可以用 `undo()` 回退。')
  lines.push('- **越界**：坐标静默裁剪；画布尺寸超上限夹紧到 2048 并通过返回值/自省告知实际尺寸。')
  lines.push('')
  lines.push('## 6. 边界与注意事项')
  lines.push('')
  lines.push('- **Node 端解码能力**：只承诺 PNG（位深 8/16、颜色类型 0/2/3/4/6、非隔行）。')
  lines.push('  其他格式要么先用工具转成 PNG，要么走页内 API（浏览器原生解码覆盖 PNG/JPG/WebP/GIF/BMP/AVIF/ICO/SVG）。')
  lines.push('- **单画布模型**：引擎一次只有一张画布；多帧动画尚未实现（见上）。逐帧出图后用 `--sheet` 或 `layoutSheet()` 拼图集。')
  lines.push('- **拼豆模式请锁定色板**：`--lock-palette`（或参数 `lockPalette: true`）保证量化与算子都不引入色板外的颜色，')
  lines.push('  这样图纸上出现的每个号色都是你真买得到的。')
  lines.push('- **游戏资产请用精确尺寸**：`--size 32x32` + `--alpha`，导出帧尺寸恒等，引擎侧无需二次对齐。')
  lines.push('')
  return lines.join('\n')
}

function main() {
  const write = process.argv.includes('--write')
  const text = build()
  if (write) {
    mkdirSync(dirname(OUT), { recursive: true })
    writeFileSync(OUT, text, 'utf8')
    console.log(`✔ 已生成 docs/AGENT_API.md（${text.length} 字节）`)
    return
  }
  process.stdout.write(text)
}


/*
 * 只在**直接被当命令行跑**时执行：被 import 时（例如别的脚本想读它的导出）不该顺带跑一遍 main，
 * 更不该 process.exit 把导入方一起带走（tool/artc.mjs 末尾记录过这条教训）。
 */
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main()
}
