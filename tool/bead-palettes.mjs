#!/usr/bin/env node
/**
 * 从 `maxcleme/beadcolors`（MIT）生成 `src/core/palettes-beads.ts`。
 *
 * ## 为什么是"生成 TS 常量"而不是运行期读文件
 *
 * 交付物是一个**自包含单文件 HTML**（双击即用、不联网），且 `src/core` 是零依赖纯逻辑层
 * （不许读文件、不许 fetch）。所以色卡数据必须在**构建期就变成源码常量**内联进去。
 * 这也是本项目 icons 产线的同一个策略：形状定义 → 生成物 → 新鲜度断言。
 *
 * ## 为什么需要联网脚本、却不接进 verify
 *
 * 数据源在 GitHub 上，抓取需要网络——把它接进 `npm run verify` 会让"离线也能全绿"
 * 这条前提失效。所以它是**一次性生成工具**：产物入库，之后构建/验证都不碰网络。
 * 数据要更新时手动重跑，diff 会被 review 看到（色卡变更本来就该被人看）。
 *
 * ## 两个实测坑（写在这里免得下次又踩）
 *
 * 1. **`raw.githubusercontent.com` 在本机不可达**（连接被重置，curl exit 56）。
 *    必须走 `api.github.com` + `Accept: application/vnd.github.raw`。
 * 2. **源数据里存在"号色不同、RGB 完全相同"的行**（实测 mard 291 行 → 290 个唯一色）。
 *    按既定决策**按颜色去重、保留首个号色**：色板里同一颜色出现两次会让用量统计合并、
 *    图纸上两个号色印同一个色块，反而更让人困惑。
 *
 * 用法：
 *   node tool/bead-palettes.mjs            # 抓取并生成（需要网络）
 *   node tool/bead-palettes.mjs --check    # 只校验现有生成物，不联网（供 CI/本地快速自检）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT = join(ROOT, 'src', 'core', 'palettes-beads.ts')

/** 色板上限：索引是 Uint8Array，超过 256 会让颜色回绕（见 core/limits.ts） */
const PALETTE_MAX = 256

/**
 * 收录的品牌。**只收实测 ≤ PALETTE_MAX 的**。
 *
 * 被排除的两个（写在这里是为了下次不必重新调研）：
 *  - `mard` 290 色 —— 国内点名率最高的拼豆品牌之一，超限
 *  - `diamondDotz` 461 色 —— 钻石画，不是拼豆
 * 要收录它们必须先做**索引位宽迁移**（Uint8Array → Uint16Array，牵动 pixbin 格式、
 * PNG 编码、export 校验等多处），那是独立一轮的结构性改动，不能和色卡数据混在一起。
 */
const BRANDS = [
  { slug: 'hama', id: 'hama_midi', name: 'Hama Midi', desc: 'Hama 中号拼豆（2.6mm）' },
  { slug: 'hama_mini', id: 'hama_mini', name: 'Hama Mini', desc: 'Hama 小号拼豆（1.5mm）' },
  { slug: 'hama_maxi', id: 'hama_maxi', name: 'Hama Maxi', desc: 'Hama 大号拼豆（4.5mm）' },
  { slug: 'perler', id: 'perler', name: 'Perler', desc: 'Perler 标准拼豆（5mm）' },
  { slug: 'perler_mini', id: 'perler_mini', name: 'Perler Mini', desc: 'Perler 小号拼豆' },
  { slug: 'perler_caps', id: 'perler_caps', name: 'Perler Caps', desc: 'Perler 胶囊珠' },
  { slug: 'artkal_a', id: 'artkal_a', name: 'Artkal A', desc: 'Artkal A 系列（2.6mm 软珠）' },
  { slug: 'artkal_c', id: 'artkal_c', name: 'Artkal C', desc: 'Artkal C 系列（2.6mm 硬珠）' },
  { slug: 'artkal_m', id: 'artkal_m', name: 'Artkal M', desc: 'Artkal M 系列（2.6mm 珠光）' },
  { slug: 'artkal_r', id: 'artkal_r', name: 'Artkal R', desc: 'Artkal R 系列（5mm）' },
  { slug: 'artkal_s', id: 'artkal_s', name: 'Artkal S', desc: 'Artkal S 系列（5mm 软珠）' },
  { slug: 'nabbi', id: 'nabbi', name: 'Nabbi', desc: 'Nabbi 中号拼豆（北欧常见）' },
  { slug: 'yant', id: 'yant', name: 'Yant', desc: 'Yant 拼豆' },
]

const CSV_URL = (slug) =>
  `https://api.github.com/repos/maxcleme/beadcolors/contents/gen/v3/${slug}.csv`

/**
 * 解析一行 CSV：`[号, 名称, 符号, R, G, B, hsl_h, hsl_s, hsl_l, lab_l, lab_a, lab_b, 贡献者]`
 *
 * 只取**号色 + RGB**三件套。LAB/HSL 不取——本项目自己的色差链路用 OKLab，
 * 而源数据给的是 CIELAB（两者不可混用，混了就是"看起来对、算起来错"）。
 * 真的要用色差时由 `core/color.ts` 从 RGB 现算，保持单一真源。
 */
function parseCsvLine(line) {
  const p = line.split(',')
  if (p.length < 6) return null
  const code = (p[0] ?? '').trim()
  const r = Number(p[3])
  const g = Number(p[4])
  const b = Number(p[5])
  if (!code) return null
  if (![r, g, b].every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) return null
  const hex = '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  return { code, hex }
}

/** 抓一个品牌，返回去重后的 { colors, codes } */
async function fetchBrand(slug) {
  const res = await fetch(CSV_URL(slug), { headers: { Accept: 'application/vnd.github.raw' } })
  if (!res.ok) throw new Error(`${slug}: HTTP ${res.status}`)
  const text = await res.text()

  const seen = new Map() // hex → code（首次出现的号色胜出，见文件头第 2 条坑）
  for (const line of text.trim().split(/\r?\n/)) {
    const row = parseCsvLine(line)
    if (row && !seen.has(row.hex)) seen.set(row.hex, row.code)
  }
  if (seen.size === 0) throw new Error(`${slug}: 没解析出任何颜色`)
  return { colors: [...seen.keys()], codes: [...seen.values()] }
}

/** 自校验：**写盘前**跑，任一不满足就抛错——绝不产出坏数据 */
function validate(brand, { colors, codes }) {
  const where = `${brand.id}（${brand.name}）`
  if (colors.length > PALETTE_MAX) {
    throw new Error(`${where} 有 ${colors.length} 色，超过 PALETTE_MAX=${PALETTE_MAX}——不该收进 BRANDS 列表`)
  }
  if (codes.length !== colors.length) {
    throw new Error(`${where} 号色 ${codes.length} 个与颜色 ${colors.length} 个不等长（靠下标对齐，必须一致）`)
  }
  const codeSet = new Set(codes)
  if (codeSet.size !== codes.length) throw new Error(`${where} 号色有重复——重复号色会让用户买错色`)
  const colorSet = new Set(colors)
  if (colorSet.size !== colors.length) throw new Error(`${where} 颜色有重复（按颜色去重这一步没生效）`)
  for (const c of colors) if (!/^#[0-9a-f]{6}$/.test(c)) throw new Error(`${where} 颜色格式不对：${c}`)
  for (const c of codes) if (!c.trim()) throw new Error(`${where} 有空号色——空号色在 PDF 上会被静默跳过`)
}

/** 把字符串数组按每行 n 个排成 TS 字面量 */
function fmtArray(name, arr, exportIt) {
  const perLine = 8
  const rows = []
  for (let i = 0; i < arr.length; i += perLine) {
    rows.push('  ' + arr.slice(i, i + perLine).map((s) => `'${s}'`).join(', ') + ',')
  }
  return `${exportIt ? 'export ' : ''}const ${name} = [\n${rows.join('\n')}\n]\n`
}

/** 生成整份 TS 源码 */
function render(data, fetchedAt) {
  const head = `/**
 * 品牌拼豆色卡 —— **本文件由 \`tool/bead-palettes.mjs\` 生成，不要手改。**
 *
 * 数据来源：https://github.com/maxcleme/beadcolors （**MIT License, © 2020 maxcleme**）
 * 抓取时间：${fetchedAt}
 * 收录：${data.length} 个品牌，共 ${data.reduce((n, d) => n + d.colors.length, 0)} 色
 *
 * ## 这些是"社区整理数据"，不是厂商官方色号
 *
 * 上游仓库的动机写得很直白：社区里流传的拼豆色卡表格"经常过时或不准"，
 * 所以它靠 PR 众筹维护（实测 16 位贡献者，前两位提供了约一半数据）。
 * 也就是说：**色值有据可查、但不保证与实物零偏差**。
 * 因此这些卡在 \`PRESETS\` 里一律标 \`source: 'community'\`，
 * 界面与文档都必须写明"以实物为准"——不假装官方。
 *
 * ## 生成时做了两件处理
 *
 * 1. **按颜色去重**（保留首个号色）：源数据里有"号色不同、RGB 完全相同"的行
 *    （实测 mard 291 行 → 290 个唯一色）。不去重的话色板里同一颜色出现两次，
 *    用量统计会合并、图纸上两个号色印同一色块，反而更让人困惑。
 * 2. **只收 ≤ ${PALETTE_MAX} 色的品牌**（索引是 Uint8Array）。
 *    Mard（290 色）与 Diamond Dotz（461 色）因此**未收录**——
 *    要收它们得先做索引位宽迁移，那是独立一轮的事。
 */
import type { BeadBrandPalette } from './palettes-beads-types.ts'

`
  const body = data
    .map((d) => {
      return (
        `/** ${d.brand.name} —— ${d.brand.desc}（${d.colors.length} 色，社区整理） */\n` +
        fmtArray(`COLORS_${d.varId}`, d.colors) +
        '\n' +
        fmtArray(`CODES_${d.varId}`, d.codes)
      )
    })
    .join('\n')

  const table = data
    .map(
      (d) =>
        `  {\n` +
        `    id: '${d.brand.id}',\n` +
        `    name: '${d.brand.name}',\n` +
        `    desc: '${d.brand.desc}',\n` +
        `    colors: COLORS_${d.varId},\n` +
        `    codes: CODES_${d.varId},\n` +
        `  },`,
    )
    .join('\n')

  return (
    head +
    body +
    `\n/**\n * 品牌色卡清单（顺序即界面下拉顺序）。\n *\n * 用 \`BeadBrandPalette\` 这个窄接口而不是直接给 \`PalettePreset\`：\n * 这里只负责"颜色 + 号色 + 名字"，\`source: 'community'\` 这类声明由 \`palettes.ts\` 统一加上——\n * 生成物不该知道业务语义，否则改一次语义就要重跑抓取脚本。\n */\nexport const BEAD_BRAND_PALETTES: BeadBrandPalette[] = [\n` +
    table +
    '\n]\n'
  )
}

/** 只校验现有生成物（不联网）：供快速自检用 */
function checkOnly() {
  const src = readFileSync(OUT, 'utf8')
  const count = (src.match(/^export |^const COLORS_/gm) ?? []).length
  const colors = (src.match(/const COLORS_/g) ?? []).length
  const codes = (src.match(/const CODES_/g) ?? []).length
  if (colors !== BRANDS.length || codes !== BRANDS.length) {
    throw new Error(`生成物与 BRANDS 列表不一致：颜色常量 ${colors} / 号色常量 ${codes} / 期望 ${BRANDS.length}`)
  }
  console.log(`✔ ${OUT} 含 ${BRANDS.length} 个品牌色卡（常量 ${count} 处）`)
}

async function main() {
  if (process.argv.includes('--check')) return checkOnly()

  const data = []
  for (const brand of BRANDS) {
    const r = await fetchBrand(brand.slug)
    validate(brand, r)
    data.push({ brand, varId: brand.id.toUpperCase(), ...r })
    console.log(`  ${brand.id.padEnd(14)} ${String(r.colors.length).padStart(3)} 色（号色唯一 ✅）`)
  }

  const fetchedAt = new Date().toISOString().slice(0, 10)
  writeFileSync(OUT, render(data, fetchedAt), 'utf8')
  const total = data.reduce((n, d) => n + d.colors.length, 0)
  console.log(`✔ 已生成 ${OUT}`)
  console.log(`  ${data.length} 个品牌 / ${total} 色 / 抓取日期 ${fetchedAt}`)
  console.log('  下一步：npm run describe、npm run build、npm run verify')
}

main().catch((err) => {
  console.error(`生成失败：${err?.message ?? err}`)
  process.exit(1)
})
