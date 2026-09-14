# Agent 快速上手：用本项目生产像素素材

> 面向 **AI agent / 脚本作者**。目标：不读源码、不猜接口，就能批量产出可用的像素素材
> （游戏精灵图、拼豆图纸、图标、图集）。
>
> 先跑一条命令确认环境，再照抄下面的配方。

```bash
cd F:/<项目目录>
node tool/quickstart.mjs        # 一条命令跑通全链路，产出落在 .quickstart/
```

它会依次做六件事并把每步结论打印出来（我在本机实测通过）：

```
1. 自省           apiLevel 2 · 画布上限 2048 格 / 色板 256 色 · 算子 12 类 · 参数 19 项
                  预置色卡：pico8 / gameboy / nes / cga / beads16(带号色) / beads24(带号色)
                  自检：32/32 通过
2. 造素材         自己生成 hero.png / slime.png（96×96，带透明背景）——不依赖仓库里有没有图
3. 批量出资产     2 张 → 每张精确 32×32、同一套 16 色、透明 484 格；_sheet.json 帧互不相交
4. 拼豆图纸       缺口清单 14 行（号色 B01/B05/P01… 全部来自色卡）；图纸 SVG 606 KB
                  守恒校验：合计 3364 + 透明 0 = 画布 3364
5. 页内 API       46 个方法；renderBlank 无副作用出图（18×18 / 3 条算子改动）；PNG 落盘
6. 产出清单       列出所有产物路径与体积（全部落在 .quickstart/，已 gitignore）
```

只跑引擎不看浏览器（CI / 无浏览器环境）：`node tool/quickstart.mjs --no-browser`

---

## 一、你能做什么（四层入口，按场景选）

| 层 | 入口 | 适用场景 | 需要浏览器吗 |
|---|---|---|---|
| **L1 页内 API** | `window.pixelArtStudio`（46 个方法） | 操作**已打开的工作台**；Playwright / CDP `evaluate` | 是 |
| **L2 批处理 CLI** | `node tool/artc.mjs` | 整套素材批量出图；agent 主力入口 | **否** |
| **L3 库内直调** | `src/core/pipeline.ts` 的 `runPipeline` + `src/io/node-*.ts` 的编解码器 | 自己写脚本、CI、无头批处理（同一份 core 算法） | 否 |
| **L4 自省/预演** | `--describe` / `ps.describe()` / `ps.validateParams()` | 冷启动时确认能力、改参前预演 | 否 / 是 |

**没有任何 HTML/浏览器也能出图**——这是本项目的设计目标之一（`src/core` 零 DOM 依赖）。

> **L3 怎么用（`core` 没有桶文件，按模块路径导入）**：入口是 `runPipeline(src, params)`，
> 它进 `SourceImage`（`{ width, height, data: Uint8ClampedArray }`）、出 `{ art, overflow, paletteSource, cleanup }`；
> PNG 编解码在 `src/io/node-png.ts`（`decodePngNode` / `encodePngNode`）。一个最小可跑脚本：
>
> ```js
> import { DEFAULT_PARAMS } from './src/core/types.ts'
> import { runPipeline } from './src/core/pipeline.ts'
> import { artToImageData } from './src/core/raster.ts'
> import { decodePngNode, encodePngNode } from './src/io/node-png.ts'
> import { readFileSync, writeFileSync } from 'node:fs'
>
> const src = decodePngNode(new Uint8Array(readFileSync('原图.png')))
> const { art } = runPipeline(src, { ...DEFAULT_PARAMS, longEdge: 32, paletteMode: 'preset', presetPaletteId: 'pico8' })
> // art 是索引色画布（indices + palette），出文件前要展开成 RGBA
> writeFileSync('out.png', encodePngNode(artToImageData(art)))
> ```
>
> 这段路径只依赖 `src/core` + `src/io`，不需要浏览器；`tool/artc.mjs` 内部走的就是同一条链路。
> 只是想要成品文件的话，**优先用 L2 的 CLI**——它把展开/编码/命名/图集都做好了。

---

## 二、三条常用配方（可直接复制）

### 配方 1：批量出游戏资产

```bash
node tool/artc.mjs --in 素材目录 --out 输出 \
  --palette pico8 --size 32x32 --alpha --scale 4 --sheet 4
```

- `--size 32x32` → **精确尺寸**（不按比例推，引擎按固定格切片）
- `--alpha` → **真 alpha**（保留原图透明区，精灵图必开）
- `--sheet 4` → 额外产出 `_sheet.json` 图集坐标表，帧含 `offsetX/offsetY`
- 产物：`<名>_32x32_4x.png` + `.hex` + `.json`（含每色用量）+ `_sheet.json`

**关键提醒**：一批素材务必**固定色板**（`--palette pico8` 或某个 `.hex`）。
用 `auto` 时每张图各提取一套色板，整批风格会不统一。

### 配方 2：拼豆图纸

```bash
node tool/artc.mjs --in 图片.png --out 输出 --preset beads16 --long-edge 58 --bead
```

- `--preset beads16` → 用自带的拼豆号色卡（**带号色**：B01/R01/G02…）
- `--long-edge 58` → 58×58 格 = 29×29 孔的大方板
- `--bead` → 产出 `*_图纸.svg`（格内印号色、板编号、图例）+ `*_缺口清单.csv`
- 缺省自动**锁定色板**（`lockPalette`），保证图纸上不出现色卡外的颜色
- 加 `--pdf` → 额外产出 `*_拼豆图纸.pdf`：**A4 分页、每块板一页**，含格内号色与图例，可直接打印

```bash
# 要打印出来照着拼就用这个
node tool/artc.mjs --in 图片.png --out 输出 --preset beads16 --long-edge 58 --bead --pdf --json
```

> PDF 的**页内标题是英文**（`Bead Pattern 58x58`）：PDF 内置字体只支持 ASCII，中文会变乱码。
> 文件名仍是中文。格内号色与 SVG / CSV **完全一致**（同一套色卡），三者可混用。
>
> **排版是自适应的**：默认把整幅缩放进一页（16×16 / 32×32 / 58×58 / 120×120 实测都是 1 页）；
> 只有缩到格子印不清时才按板分页（200×200 → 16 页，每页一块板、格子放到最大）。
> 格内号色较小（约占格宽 45%），缩放后若小于约 1.1mm 就不印号色——**这时请改用 SVG 看编号**。

缺口清单长这样（实测）：

```csv
编号,颜色,格数,珠数,估算重量(g),建议袋数
B01,#FFFFFF,1571,1571,125.68,4
B05,#4A4A4A,442,442,35.36,1
合计,10 色,3364,3364,269.12,13
透明格,留空,0,, ,
画布,58x58,3364,, ,
```

**要用品牌官方色号**：把色卡整理成 `.hex`（每行 `编号 #rrggbb`）后
`--palette 我的色卡.hex`。内建卡是**通用近似色**，不是任何品牌官方色号。

### 配方 3：纯程序化出素材（不需要输入图）

```bash
node tool/artc.mjs --blank 32x32 --blank-transparent --out 输出 \
  --ops '[{"op":"rect","x0":2,"y0":2,"x1":29,"y1":29,"color":"#1d2b53"},
          {"op":"ellipse","x0":6,"y0":6,"x1":25,"y1":25,"color":"#ff004d"},
          {"op":"trim"}]'
```

适合"用代码画图标/角色/地图块"，或给 UI 造占位图。

---

## 三、12 类算子（声明式编辑）

一条 `--ops` 或 `ps.edit(ops)` 就是**一个撤销单位**。算子表（同源信息用 `--describe` 拿）：

| 算子 | 参数 | 说明 |
|---|---|---|
| `fill` | `x,y,color?,erase?` | 油漆桶：连通区域换色；`erase:true` 整块挖透明 |
| `setCells` | `cells:[[x,y],…],color?,erase?` | 指定格子上色/挖洞 |
| `setAll` | `color?,erase?` | 整幅涂色 / 整幅清空 |
| `line` | `x0,y0,x1,y1,color?,brushSize?` | 直线（`brushSize` 1–3） |
| `rect` | `x0,y0,x1,y1,color?,filled?` | 矩形（默认实心） |
| `ellipse` | `x0,y0,x1,y1,color?,filled?` | 椭圆（默认实心） |
| `transform` | `kind` | `flipX`/`flipY`/`rotate90`/`rotate180`/`rotate270` |
| `trim` | — | 裁掉四周透明边 |
| `eraseColor` | `color` | 便捷：把某色全挖成透明（一键去白底） |
| `replaceAny` | `color,to` | 便捷：全图换色（拼豆"没这个色，换一个看看"） |
| `outline` | `color?,connectivity?,offset?` | 给内容外侧描一圈（默认完整一圈含斜角；`offset` 加粗）。只往空格写，不动已有内容 |
| `mirror` | `kind,color?` | 以画布中线镜像**加一份**（原内容保留），做对称角色/倒影 |

**注意**：无副作用路径（`render` / `renderBlank` / CLI 的 `--ops`）**不继承工作台主色**，
绘画类算子**必须显式给 `color`**，否则结果不可复现（会直接报错）。

常见组合：

```bash
# 去白底 + 裁边 + 水平镜像
--ops '[{"op":"eraseColor","color":"#ffffff"},{"op":"trim"},{"op":"transform","kind":"flipX"}]'
# 描边（先挖透明轮廓，再画空心矩形）
--ops '[{"op":"setAll","color":"#ffffff"},{"op":"rect","x0":1,"y0":1,"x1":30,"y1":30,"color":"#000000","filled":false}]'
```

**算子很长就写文件**。逐格 `setCells` 动辄十几 KB，塞进命令行既要处理引号转义、
又容易撞长度上限，报错还定位不到位置：

```bash
node tool/artc.mjs --in 底图.png --ops-file ops.json --out 输出 --json
node tool/artc.mjs --in 底图.png --ops @ops.json  --out 输出 --json   # 等价简写
```

---

## 四、做**无损**像素素材（最容易踩的一条）

默认参数面向"照片转像素"，对**已经画好的像素素材**是有损的。两条路可选：

**路线 A：直接用 `sprite` 风格预设**（省事，先试这个）

```bash
node tool/artc.mjs --in 精灵.png --size 64x64 --style sprite --out 输出 --json
```

`--style sprite` = 最近邻 + **不做杂色清理** + 保留透明 + PICO-8 色板。其中"不做杂色清理"是关键：
清理针对的是照片压缩噪点，而像素素材里的"小连通块"往往正是故意画的高光、眼神、描边断点。

**路线 B：手动给全开关**（要精确控制色数时）

```bash
node tool/artc.mjs --in 精灵.png --size 64x64 --alpha \
  --downsample nearest --no-cleanup --palette-k 64 --out 输出 --json
```

每个开关挡掉一类损失（实测数据，64×64 探针精灵：1px 描边 + 1px 孤立高光）：

| 开关 | 不加会怎样 |
| --- | --- |
| `--no-cleanup` | **杂色清理会吃掉 1px 细节**——孤立高光、眼神、描边断点正是它要"并入邻色"的对象，实测 1px 高光被整块吞掉（眼睛也从 9 格掉到 8 格） |
| `--downsample nearest` | 默认 `average` 会按面积混色，**造出源图里不存在的颜色**（实测多出 8 个混合色，1px 高光被染成 `#fff5bf`）；整数倍缩小时 `nearest` 是无损的（512→64 的 8:1 实测描边一根没丢） |
| `--palette-k 64` | 自动取色默认只取 24 色，会把接近的颜色合并；设成 ≥ 实际色数才不会丢色 |
| `--size WxH` | 注意是 `--size`，**没有 `--exact` 这个参数**（写了会报未知参数并从错误信息里看到它吞掉了什么） |

**cleanup 动了像素会明确警告**，不会静默：

```
⚠ 精灵.png：杂色清理改掉 1 格，1 种颜色整幅消失：#ffd700(1格)
  若这些是刻意画的细节，请加 --no-cleanup（本张产物已按清理后写出）
```

`--json` 里也有对应字段，可以程序化判断：

```json
"cleanup": { "changedCells": 1, "removedColors": [{ "index": 2, "hex": "#ffd700", "cells": 1 }], "truncated": false }
```

看到 `removedColors` 非空，先确认那些颜色是不是故意画的，再决定要不要 `--no-cleanup` 重跑。

---

## 五、页内 API（浏览器路径）

```js
await page.evaluate(() => window.pixelArtStudio.whenReady())   // 就绪信号（等 UI 初始化完成）
const info = await page.evaluate(() => window.pixelArtStudio.describe())   // 先自省

// 无副作用一站式：不碰工作区状态与撤销栈 → 适合批量并行
// （注意：本项目**没有自动草稿**功能，whenReady() 不做任何恢复，只是一个就绪信号）
const r = await page.evaluate(() => window.pixelArtStudio.renderBlank(
  { width: 32, height: 32, transparent: true,
    ops: [{ op: 'ellipse', x0: 4, y0: 4, x1: 27, y1: 27, color: '#ff004d' }, { op: 'trim' }] },
  { longEdge: 32 }, 4))
// r = { width, height, palette, usage, transparent, changes, png(dataURL), pixelJSON, paletteHex, hash }
```

其它常用：`render(src, params, scale, {ops})`（有输入图的无副作用路径）、
`beadReport()` / `exportBeadSvg()` / `exportBeadCsv()`（拼豆三件套）、
`layoutSheet(frames, columns)`（图集布局计算）、`exportPNG(scale,{transparentBg})`、
`edit(ops)` / `undo()` / `redo()` / `newCanvas()`（会改当前画布）、
`validateParams({...})`（**干跑校验**，返回被夹紧的字段）。

`getInfo().hasEdits` 会如实告诉你画布是否被手动编辑过。

---

## 六、可以依赖的稳定约定

- **确定性**：同图 + 同参 + 同算子 = 同结果。用 `artHash`（CLI 的 `--json` 里有 `hash` 字段）跨运行比对。
- **镜像同步**：`setParams` / `importImage` / `reset` / `loadProject` 之后，**同一次 JS 调用内**紧接读
  `getInfo` / `getUsage` / `exportPNG` 就能拿到最新值，不用等下一帧。
- **错误**：一律 `throw Error`（中文原因）；CLI 单张失败**不中断整批**，结尾给失败清单并以非零码退出。
- **越界**：坐标静默裁剪；尺寸超 2048 夹紧并在返回值里给出实际尺寸。
- **号色**：用带号色的预置卡或 `.hex` 时，号色会进入 图纸 SVG / 缺口清单 / `.hex` / 像素 JSON。

---

## 七、能力边界（如实声明，别踩）

| 限制 | 说明 / 绕法 |
|---|---|
| **Node 端只直读 PNG** | JPG/WebP/GIF/BMP/AVIF/ICO/SVG 请先转 PNG，或走浏览器路径（`ps.importImage` 用浏览器原生解码，9 种格式） |
| **无多帧动画** | `capabilities().animation === false`。动画素材请**逐帧出图后用 `--sheet` 拼图集** |
| **单画布模型** | 引擎一次持有一张画布；批量时逐张处理（CLI 已这么做） |
| **拼豆内建色卡是近似色** | 非品牌官方色号；要严格对应请导入官方 `.hex` |
| **无文本渲染** | 没有"打字生成像素字"的能力，字形请自己用算子拼 |
| **导出上限** | 单边 ≤16384px 且面积 ≤67108864（约 6710 万）像素，超出自动降倍 |
| **色板上限 256** | 索引是 Uint8Array；自定义色板超出会被截断 |

---

## 八、排错

| 现象 | 原因 / 处理 |
|---|---|
| `renderBlank 不是函数` | 已修复（0.1.0 之后）。请确认产物/代码是当前版本：`git log --oneline -1` |
| 图纸上的编号是 `C1/C2…` 而不是 `B01/R01…` | 已修复。旧版会丢预置卡号色；用 `--preset beads16` 或 `--palette beads16` |
| JPG 报"Node 端只能直接解码 PNG" | 正常限制。先转 PNG，或用浏览器路径 |
| 一批图配色不统一 | 你用了 `--palette auto`；改成固定色板（`--palette <预设 id 或 .hex>`） |
| 算子报"必须显式给 color" | 无副作用路径不继承主色；给每个绘画算子补 `color` |
| 想把结果喂给引擎但帧对不齐 | 用 `--size WxH` 固定尺寸 + `--sheet` 拿 `offsetX/offsetY`；不要用 `trim` 破坏帧尺寸 |
| 想看某次调用到底改了什么 | `--json` 汇总里有 `hash` / `changes` / `transparent`；页内 API 返回 `changes[]`，其中 `changed` 是权威判定 |
| 报"未知参数：--xxx" | 是真的写错了，工具**不会静默忽略**。错误信息会给出最接近的正确参数名，并提示该参数吞掉了后面的哪个值 |
| 报"命名模板解析后仍含占位符" | `--name` 里用了不支持的占位符。可用：`{name}` `{index}` `{w}` `{h}` `{scale}`（可写 `{index:02}` 补零） |
| 素材目录里混了 `.svg` 导致整批失败 | 已修复。现在会记进 `skippedFiles` 并以 0 退出；Node 端本来就只解码 PNG，非 PNG 请走浏览器路径 |
| `--json` 的 stdout 解析失败 | 已修复（stdout 现在是纯 JSON）。若要同时看进度，加 `--progress`（进度写 stderr） |
| 产物里出现 `undefined.png` | 已修复（0.1.0 之后）。确认产物是当前版本：`git log --oneline -1` |
| 算子好像"没生效" | 检查 `ops` 放的位置：**`render` 的 `ops` 在第 4 个参数，`renderBlank` 的在第 1 个**。放错位置会直接报错并说明正确写法（以前是静默丢掉算子） |

---

## 九、相关文档

| 文档 | 内容 |
|---|---|
| `docs/AGENT_API.md` | **完整接口契约**（由 `src/core/spec.ts` 生成：`npm run describe`；改元数据后要重跑，目前无断言守着） |
| `docs/TESTING-GUIDE.md` | 如何系统性测试本项目（含自动化清单与防坑要点） |
| `docs/USAGE.md` | 用户向：界面、参数表、快捷键、FAQ |
| `docs/DEVELOPMENT.md` | 贡献者向：铁律、验证链、结构规则、踩过的坑、路线图 |
| `docs/ARCHITECTURE.md` | 分层、数据模型、决策记录、缺陷复盘 |
| `docs/UI-COLOR-PICKER.md` | 取色器改造指南（给改 UI 的 agent） |

---

## 十、一句话给 agent

> 先 `node tool/quickstart.mjs` 确认环境并看懂产出形态；
> 批量出图用 `tool/artc.mjs`（**固定色板** + `--size` + `--alpha` + `--sheet`）；
> 拼豆用 `--preset beads16 --bead`（号色会进图纸与清单）；
> 需要交互/无头浏览器之外的格式时走页内 API；
> 拿不准接口就跑 `--describe`，拿不准参数就跑 `--dry-run` 或 `ps.validateParams()`。
