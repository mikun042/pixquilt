// 把 svg-shapes.mjs 的 8 个 SVG 形状转成 icons.ts 的接入格式（SVG_PATHS）。
//
// 形状在 **32 格设计网格**里描述（与像素图标的 32×32 画布同尺度，便于对照），
// 但 icons.ts 的图标 viewBox 恒为 `0 0 24 24`（像素图标与吸管都在这个空间里）。
// 因此这里必须做一次 **32 → 24 的等比缩放**（系数 0.75）。
//
// ⚠️ 这一步曾经缺失，后果很严重且完全静默：数据里是 32 空间的坐标（最大到 30），
// 塞进 24 的 viewBox 后被**裁掉**大半——
//   · 重新转换（环 + 箭头）只剩左上角一小段弧与一个碎片
//   · 快捷键（问号）的方点落在 y=25..30.4，**整个点看不见**
//   · 画笔的笔尖、撤销的弧尾一并被切
// 而且它是"看不清"而不是"报错"，所以能一直躺在仓库里。见 icons.ts 的注释与
// tool/e2e-regressions.mjs 里那条"所有图标的笔画都要落在自己的 viewBox 内"的断言。
//
// **本文件只算不写盘**：`buildSvgPaths()` 返回数据，由 svg-sync.mjs 写进 icons.ts。
// 原先它会把结果落成 `svg-paths.json` 再由另一个脚本读走，多一个中间文件就多一次
// "文件没重跑、两边不一致"的机会——而这份数据恰恰正是那个裁切缺陷的载体。
// 现在没有中间产物，`npm run icons:sync` 一条命令从形状直达 icons.ts。
//
// 现约定：本文件产出的一切数值（坐标 + stroke-width）**都已是 24 空间**，
// 接入侧（icons.ts）直接原样使用，不再做任何换算。

/** 设计网格边长（svg-shapes.mjs 里所有 <svg> 的 viewBox 都是 0 0 32 32） */
const DESIGN = 32
/** icons.ts 的图标 viewBox 边长 */
const VIEWBOX = 24
/** 32 格设计网格 → 24 viewBox 的等比系数 */
const SCALE = VIEWBOX / DESIGN

/** 形状定义文件的绝对路径（按 import.meta.url 定位，不依赖 CWD） */
const SHAPES_URL = new URL('./svg-shapes.mjs', import.meta.url)

const shortName = (id) =>
  id
    .replace(/^tool_/, '')
    .replace(/^act_/, '')
    .replace(/^cat_/, '')
    .replace(/_([a-z])/g, (_, c) => c.toUpperCase())

/**
 * 每条命令的参数个数。**A/a 的参数里有两个是"标志位"**（large-arc / sweep），
 * 它们不是长度、不能乘缩放系数（乘了就变成非法值或改变弧的走向）——
 * 这是本文件唯一需要逐命令区别对待的地方。
 */
const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }

/** 四舍五入到 2 位小数并去掉多余的 0（与 icons.ts 里既有的数字风格一致） */
const num = (v) => {
  const r = Math.round(v * 100) / 100
  return String(r)
}

/**
 * 对 path 的 `d` 做等比缩放。
 *
 * 逐命令解析（含**隐式重复**：`M0 0 1 1` 里后面的 `1 1` 是省略了 L 的续段），
 * 缩放规则：
 *   · 一般命令：所有参数都是坐标/长度 → 全部乘系数
 *   · A/a：`rx ry rot large-arc sweep x y`，只有 rx/ry/（相对命令的）dx/dy 是长度，
 *           rot 与两个 flag 原样保留 → 只缩放下标 0、1、5、6
 *   · H/h、V/v：单个坐标 → 直接乘
 */
function scalePathData(d, s) {
  // 拆成 [{ cmd, args }]，同时把隐式重复展开成显式命令
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi)
  if (!tokens) throw new Error(`无法解析 path：${d}`)

  const out = []
  let i = 0
  let cmd = null
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) {
      cmd = tokens[i]
      i++
      if (cmd === 'Z' || cmd === 'z') {
        out.push('Z')
        continue
      }
    } else if (cmd === null) {
      throw new Error(`path 以数字开头（缺少命令字母）：${d}`)
    } else if (cmd === 'M') {
      // 隐式续段：M 之后的多余坐标按 L 处理（SVG 规范）
      cmd = 'L'
    } else if (cmd === 'm') {
      cmd = 'l'
    }
    const n = ARITY[cmd.toUpperCase()]
    if (n === undefined) throw new Error(`未知的 path 命令 ${cmd}：${d}`)
    const args = tokens.slice(i, i + n).map(Number)
    if (args.length < n || args.some(Number.isNaN)) throw new Error(`命令 ${cmd} 参数不足：${d}`)
    i += n

    const upper = cmd.toUpperCase()
    let scaled
    if (upper === 'A') {
      // rx ry rot large-arc-flag sweep-flag x y —— 只缩放下标 0/1/5/6
      scaled = args.map((v, k) => ([0, 1, 5, 6].includes(k) ? v * s : v))
    } else {
      scaled = args.map((v) => v * s)
    }
    out.push(cmd + scaled.map(num).join(' '))
  }
  return out.join(' ')
}

/** 从属性串里读一个属性（没有则 undefined） */
const attr = (s, name) => (s.match(new RegExp(`${name}="([^"]+)"`)) || [])[1]

/**
 * 解析 SVG，返回叶子图形元素（path / rect / circle），**并带上从 <g> 继承来的属性**。
 *
 * 为什么必须做继承：`fill="none"` 通常写在 `<g>` 上（`S()` 与 help 的钩都是这么写的），
 * 而只读 `<path>` 自身属性会让这些元素退回"默认填充"——**空心弧于是被填成实心块**。
 * 这正是"快捷键（问号）"反复读成实心疙瘩的真正原因：
 * 它的弧在 `<g fill="none">` 里，接入后却按实心渲染，内孔被完全填死，与半径/描边怎么调都无关。
 * 同源的另一个缺陷是 `<g transform>` 被丢掉（见下面的守卫）——都是"组上的东西没人管"。
 *
 * 继承规则与 SVG 一致：子元素自己的属性覆盖祖先；`stroke-width` 也一并继承。
 */
function parseShapes(svg) {
  /* transform 必须显式拒绝，不能忽略：重做图标原本用
   * `<g transform="translate(32,0) scale(-1,1)">` 表达镜像，而提取器不做坐标变换，
   * 于是**重做与撤销导出成了完全相同的两条路径**（箭头都朝左）。屏幕上看得出来，
   * 工具链却一声不吭——正是本项目最忌讳的那类静默失效。
   * 现在形状一律写成绝对坐标（镜像由 JS 算好，见 svg-shapes.mjs 的 redo）。 */
  if (/transform\s*=/.test(svg)) {
    throw new Error(
      'svg-shapes.mjs 里出现了 transform：本提取器不做坐标变换，会把它静默丢掉（重做图标曾因此与撤销一模一样）。\n' +
        '请把形状写成绝对坐标，或改用 arc()/earc()/arrow() 这类几何工具算出点位。',
    )
  }

  const out = []
  /** <g> 属性栈；栈顶是当前生效的继承上下文 */
  const stack = [{ fill: undefined, sw: undefined, fr: undefined }]
  const top = () => stack[stack.length - 1]

  for (const m of svg.matchAll(/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g)) {
    const [, closing, tag, attrs] = m
    if (tag === 'g') {
      if (closing) {
        if (stack.length > 1) stack.pop()
      } else {
        stack.push({
          fill: attr(attrs, 'fill') ?? top().fill,
          sw: attr(attrs, 'stroke-width') ?? top().sw,
          fr: attr(attrs, 'fill-rule') ?? top().fr,
        })
      }
      continue
    }
    if (!['path', 'rect', 'circle'].includes(tag)) continue

    // 子元素自身属性优先，否则继承组上的值
    out.push({
      tag,
      attrs,
      fill: attr(attrs, 'fill') ?? top().fill,
      sw: attr(attrs, 'stroke-width') ?? top().sw,
      fr: attr(attrs, 'fill-rule') ?? top().fr,
    })
  }
  return out
}

/** 从 SVG 字符串里抽出图形列表（d + fill + stroke-width + fill-rule，均已缩放并解析继承） */
function extractPaths(svg) {
  const out = []
  for (const { tag, attrs, fill, sw, fr } of parseShapes(svg)) {
    const style = {
      ...(fill ? { fill } : {}),
      ...(fr ? { fr } : {}),
      // stroke-width 也是 32 空间的长度，同样要缩（否则线会比设计粗 1/3）
      ...(sw ? { sw: num(Number(sw) * SCALE) } : {}),
    }

    if (tag === 'path') {
      const d = attr(attrs, 'd')
      if (!d) continue
      out.push({ d: scalePathData(d, SCALE), ...style })
      continue
    }

    /*
     * <rect> 与 <circle> 也要支持：问号的"点"用 <rect> 画（实心方点，比线段清晰），
     * 填充桶的"滴"用 <circle>。只认 <path> 会让这些部件**被静默丢弃**——
     * 实测踩过两次：调色盘用 <ellipse> 时取到 0 条 path、问号的点消失。
     * 这里把它们统一转成等价的 path 语法，接入侧就不用管标签差异了。
     */
    if (tag === 'rect') {
      const x = Number(attr(attrs, 'x') ?? NaN)
      const y = Number(attr(attrs, 'y') ?? NaN)
      const w = Number(attr(attrs, 'width') ?? NaN)
      const h = Number(attr(attrs, 'height') ?? NaN)
      if ([x, y, w, h].some(Number.isNaN)) continue
      // 跳过整幅白底（它是背景 rect，不是图标部件）
      if (x === 0 && y === 0 && w === DESIGN && h === DESIGN) continue
      out.push({ d: scalePathData(`M${x} ${y}h${w}v${h}h${-w}Z`, SCALE), ...style })
      continue
    }

    // circle → 两段半圆弧（与 icons.ts 里吸管胶头同一手法）
    const cx = Number(attr(attrs, 'cx') ?? NaN)
    const cy = Number(attr(attrs, 'cy') ?? NaN)
    const r = Number(attr(attrs, 'r') ?? NaN)
    if ([cx, cy, r].some(Number.isNaN)) continue
    out.push({
      d: scalePathData(`M${cx - r} ${cy} a${r} ${r} 0 1 0 ${r * 2} 0 a${r} ${r} 0 1 0 ${-r * 2} 0 Z`, SCALE),
      ...style,
    })
  }
  return out
}

/**
 * 生成 SVG track 的全部图标数据（24 空间）。
 *
 * 返回 `{ 短名: [{ d, fill?, fr?, sw? }] }`，直接对应 icons.ts 的 `SVG_PATHS`。
 * `opts.verbose` 时把每个图标的最大坐标打到 stdout（改形状时用来看有没有出界）。
 */
export async function buildSvgPaths({ verbose = false } = {}) {
  const mod = await import(SHAPES_URL.href)

  const result = {}
  for (const [id, svg] of Object.entries(mod.SVG_SHAPES)) {
    const paths = extractPaths(svg)
    if (!paths.length) throw new Error(`${id} 未提取到 path`)
    result[shortName(id)] = paths
    if (verbose) console.log(`✔ ${shortName(id).padEnd(12)} ${paths.length} 条 path`)
  }

  /*
   * 自检：缩放后所有**坐标**必须落在 24 的 viewBox 内。
   * 这是"32 空间塞进 24 盒"那个缺陷的直接防线——
   * 纯数值检查、不依赖浏览器，改完形状立刻能发现问题（比端到端快得多）。
   */
  const OVERFLOW_TOLERANCE = 0.51 // 描边半宽 + 舍入余量（round linecap 允许端点略微出界）
  for (const [name, paths] of Object.entries(result)) {
    let maxSeen = 0
    for (const { d } of paths) {
      const nums = d.match(/-?\d*\.?\d+/g)?.map(Number) ?? []
      maxSeen = Math.max(maxSeen, ...nums)
    }
    if (maxSeen > VIEWBOX + OVERFLOW_TOLERANCE) {
      throw new Error(
        `${name} 的坐标最大到 ${maxSeen}，超出 ${VIEWBOX} 的 viewBox —— 会被裁切。` +
          `检查 svg-shapes.mjs 的坐标是否仍在 32 设计网格内。`,
      )
    }
    if (verbose) console.log(`  ${name.padEnd(12)} 最大坐标 ${maxSeen.toFixed(2)} ≤ ${VIEWBOX}`)
  }

  return result
}
