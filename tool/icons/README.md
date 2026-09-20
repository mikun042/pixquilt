# UI 图标管线

产出 `src/app/ui/icons.ts` 里那两张表的**唯一来源**。改图标只改这里的**形状定义**，
然后跑一条命令接线；不要手改 `icons.ts` 里的 path 数据（单条 1KB+，手抄必错）。

```
形状定义（本目录）  ──npm run icons:sync──▶  src/app/ui/icons.ts
   pixel-shapes.mjs  ─▶ PIXEL_PATHS      20 个定义（其中 8 个同名者被 SVG 版遮蔽 → 实际渲染 12 个）
   svg-shapes.mjs    ─▶ SVG_PATHS         8 个 SVG 描边图标（并遮蔽同名像素版）
```

## 两条产线

图标按**形状类型**分工——16px 下两者看不出区别，所以"哪种好画用哪种"：

| 产线 | 图标 | 画法 | 源文件 |
|---|---|---|---|
| **像素格** | 20 个定义、**实际渲染 12 个**：矩形 / 椭圆 / 选区 / 新建 / 转换 / 像素 / 齿轮 / 折叠箭头（上下 2 个）/ 栏开关（左右 2 个）/ 最大化 | 在 32×32 网格上堆格子 | `pixel-shapes.mjs` |
| **SVG 描边** | 8 个：画笔 / 填充 / 撤销 / 重做 / 重新转换 / 调色盘 / 快捷键 / 滑杆 | 直接写 `<path>`（含弧与箭头，堆格子画不准） | `svg-shapes.mjs` |

渲染优先级在 `iconEl()` 里：**先查 `SVG_PATHS`、再查 `PIXEL_PATHS`**。
所以同名的 8 个像素版（pencil/bucket/undo/redo/regenerate/help/palette/sliders）
**是死数据、永远不会被渲染**——它们是像素产线的完整产物，保留备查。

> ⚠️ 这个遮蔽关系曾经制造过一次真缺陷：那 8 份死数据里的 `undo` / `regenerate`
> 与形状定义漂移了却没人发现（因为渲染读的是 SVG 版）。现在两张表由同一条命令生成，
> 不会再有"其中一张悄悄过期"的情况。

## ⚠️ 坐标契约（改形状前必读）

**SVG 描边那条线的形状画在 32 格设计网格里，而图标 viewBox 恒为 `0 0 24 24`。**
接入前必须等比缩放（系数 **0.75**），由 `svg-data.mjs` 完成，并带一道"最大坐标 ≤ 24"的数值自检。

这一步**曾经缺失**，而且完全静默（2026-09-15 修复）——32 空间的坐标最大到 30，
塞进 24 的 viewBox 后被裁掉大半：

- 重新转换（环 + 箭头）只剩左上角一段残弧与一个碎片；
- 快捷键（问号）的方点落在 y=25..30.4，**整个点看不见**；
- 画笔笔尖、撤销弧尾一并被切。

同一批还修掉另外两个"`<g>` 上的东西没人管"的静默缺陷：

| 缺陷 | 症状 | 现在 |
|---|---|---|
| `<g transform>` 被丢掉 | **重做与撤销导出成完全相同的路径**（箭头都朝左） | 提取器遇 transform **直接报错**；镜像坐标由 JS 算好写成绝对值 |
| `<g fill="none">` 被丢掉 | 空心弧被填成**实心块**（问号一直是疙瘩，与半径/描边怎么调无关） | 提取器按 SVG 规则**继承组属性** |
| `fill-rule` 被丢掉 | 调色盘的颜料孔被填平，成一个**实心圆盘** | `fill-rule` 一并继承并写进 `SVG_PATHS` 的 `fr` |

**两条防线**：`svg-data.mjs` 生成期的数值自检（最大坐标 ≤ 24），
以及 `tool/e2e-regressions.mjs` 里"**每个**图标的笔画都落在自己的 viewBox 内"+
"重做必须是撤销的镜像"（原先只查吸管一个图标，所以上面这些都溜过去了）。

## 尺寸换算

图标显示在 16px 的按钮里，viewBox 恒为 24，所以：

| 网格 | 1 单位 = 多少屏幕像素 | 含义 |
|---|---|---|
| 32 格设计网格 | **0.5 px** | `stroke-width` 至少 2.8 才够 1.4px；视觉上"描边 3.4 ≈ 1.7px" |

**清晰度来自"最终笔画 ≥1.4px"，不是画布大本身。** 这条由 `pixel-grid.mjs` 的
`checkGeometry` 强制（`主体厚 ≥1.4px`），不靠画的人自觉。

## 命令

```bash
npm run icons:sync      # ★ 改完形状后必跑：把两张表写进 src/app/ui/icons.ts
npm run icons:check     # 只校验 icons.ts 是否已是最新（改了形状没接线 → 非零退出）
npm run icons:gen       # 像素产线出整包素材（SVG + PNG 预览 + 清单）→ tool/icons/.out/
npm run icons:preview   # 16/24/32/48px 四档并排，看**形状**对不对
npm run icons:16        # 实机 16px、最近邻 ×8，看**能不能读出来**（真验收点）
```

改形状的推荐节奏：改 `*-shapes.mjs` → `icons:preview` 看形状 → `icons:16` 看可读性 →
`icons:sync` 接线 → `npm run verify` 收尾。

**别走"改 icons.ts → build → 截整页"**：一轮十几秒，而且只能看到 16px 一档。

`ascii16.mjs` 是最后一招：把某个图标在 16px 下的真实像素打成 ASCII，用来判断
"孔有没有被抗锯齿糊死""笔画实际几 px 厚"这种只有看像素才能确定的事。

```bash
node tool/icons/preview-16.mjs .tmp-shots/t16.png pencil,bucket   # 先出真值图
node tool/icons/ascii16.mjs .tmp-shots/t16.png 0                  # 再看第 0 个的像素
```

## 文件

| 文件 | 作用 |
|---|---|
| `pixel-shapes.mjs` | 像素产线的形状定义（20 个，`Grid` / ASCII 画法） |
| `pixel-grid.mjs` | 32 格网格 + 几何校验 + 单色 SVG / path 生成 |
| `pixel-data.mjs` | 遍历形状 → `{ made, failures }`（**两个消费者共用这一条构造路径**） |
| `pixel-sync.mjs` | 写 `PIXEL_PATHS` 进 icons.ts（`--check` 只校验） |
| `pixel-gen.mjs` | 像素产线出整包素材 → `.out/`（不写 icons.ts） |
| `svg-shapes.mjs` | SVG 产线的形状定义（8 个，32 设计网格）+ `arc` / `earc` / `arrow` 几何工具 |
| `svg-data.mjs` | 提取 path + 继承组属性 + 缩放 32→24 + 数值自检 → `buildSvgPaths()` |
| `svg-sync.mjs` | 写 `SVG_PATHS` 进 icons.ts（`--check` 只校验） |
| `preview-svg.mjs` | 多尺寸预览写真值 PNG |
| `preview-16.mjs` | 实机 16px 真值图（最近邻 ×8） |
| `ascii16.mjs` | 真值图里某个图标的像素 → ASCII |

## 四条硬规则

1. **形状定义是唯一真源。** `icons.ts` 里两张表都是生成物，手改会被 `icons:sync` 覆盖。
2. **不落第二份副本。** 曾经这条链中间有 `svg-paths.json`、`icons-data-32.ts`、
   `output/_work/*.json` 等中间产物，结果是"改了形状、忘了重跑接线"以及数据漂移
   （`undo` / `regenerate` 就是这么漂的）。现在从形状定义直达 icons.ts，没有中间文件可漂移。
3. **辅助脚本必须与 `iconEl()` 逐项对齐。** `preview-*.mjs` 复刻 `iconEl` 的渲染规则，
   少复刻一项**预览就会撒谎**：曾经漏了 `fill-rule`，于是调色盘在预览里是实心圆盘，
   让人去怀疑数据——其实数据是对的，是预览工具没画对。
4. **校验不过就报错，不要静默跳过。** 几何不达标的图标进 `failures` 并以非零码退出。

