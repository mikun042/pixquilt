/**
 * pixel-data.mjs —— 像素产线的**唯一入口**：把 `pixel-shapes.mjs` 里的形状定义
 * 跑成"图标 → 单色 path 数据 + 几何校验结果"。
 *
 * 为什么单独抽一层：这条数据有两个消费者，它们必须**用同一份构造过程**——
 *   1. `pixel-gen.mjs`：出整包素材（SVG / PNG 预览 / 清单）
 *   2. `pixel-sync.mjs`：把 path 数据写进 `src/app/ui/icons.ts` 的 `PIXEL_PATHS`
 * 各写一遍遍历与命名映射，迟早分叉（"预览里是对的、接进产品里是旧的"这类最难查）。
 *
 * 原先这条链中间还要经过一个手写的 `icons-data-32.ts` 草稿 + `output/_work/*.json`，
 * 那些中间文件后来都丢了，于是 **12 个像素图标彻底无法重新生成**（改一格都改不动）。
 * 现在直接从形状定义算到 icons.ts，中间没有任何易失产物。
 */
import { ICONS } from './pixel-shapes.mjs'
import { checkGeometry } from './pixel-grid.mjs'

/**
 * `icons.ts` 里 `PIXEL_PATHS` 的键名（短名）与形状定义 id 的映射。
 *
 * 三种前缀都要去掉，且**下划线也要去掉并转小写**——icons.ts 用的是
 * `caretdown` / `caretright` / `panelleft` / `panelright`（全小写无下划线），
 * 而形状定义里写的是 `caret_down` / `panel_left`。
 * 这条映射原先只活在那个已丢失的接入脚本里，等于没有出处；现在它在这里。
 */
export function shortPixelName(id) {
  return id.replace(/^(tool_|act_|cat_)/, '').replace(/_/g, '').toLowerCase()
}

/**
 * 遍历全部形状定义，返回 `{ made, failures }`。
 *
 * 每个 made 项：`{ id, short, name, cat, grid, geo, d, svg }`。
 * **几何校验不过的图标会进 failures 而不是静默跳过**——"主体厚 ≥1.4px"是本套图标
 * 能在 16px 下看清的前提，不能靠画的人自觉（见 pixel-grid.mjs 的说明）。
 */
export function buildPixelIcons() {
  const made = []
  const failures = []
  for (const [id, def] of Object.entries(ICONS)) {
    try {
      const grid = def.make()
      if (grid.count() === 0) throw new Error('空图标（一个格子都没有）')
      const d = grid.toPathD()
      const geo = checkGeometry(grid, { skipSizeCheck: !!def.skipSizeCheck })
      if (!geo.ok) throw new Error(`几何校验失败：${geo.problems.join('；')}`)
      made.push({ id, short: shortPixelName(id), name: def.name, cat: def.cat, grid, geo, d })
    } catch (e) {
      failures.push({ id, reason: e.message })
    }
  }
  return { made, failures }
}
