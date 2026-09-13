# 像素画工作台 · Agent 接口手册

> **本文件由 `node tool/describe.mjs --write` 从 `src/core/spec.ts` 生成，请勿手改。**
> 改了代码却忘了改文档时，`npm test` 会直接失败（比对重新生成的结果）。

这份手册是给 **AI agent 与脚本** 用的：不点界面就能完成「导入 → 调参 → 转换 → 编辑 → 导出」，
并覆盖本项目的两个主要用途——**拼豆图纸**与**可批量生产的游戏美术资产**。

## 0. 三条最快的上手路径

```bash
# ① 命令行批处理（不需要浏览器，零第三方依赖）
node tool/artc.mjs --in 素材目录 --out 输出 --palette beads16 --long-edge 58 --bead
node tool/artc.mjs --in 素材目录 --out 输出 --palette gameboy --size 32x32 --alpha --sheet 4

# ② 自检与自省（先确认环境与能力，再写脚本）
node tool/artc.mjs --selftest      # 25 项链路自检，无需任何素材
node tool/artc.mjs --describe     # 打印完整的算子/参数/能力 JSON

# ③ 页内 API（浏览器自动化 / Playwright / CDP evaluate）
#    打开 像素画工作台.html 后：window.pixelArtStudio.describe()
```

- 接口版本：`apiLevel = 2`，产品版本 `0.1.0`，项目文件 Schema `v3`
- 上限：画布单边 ≤ 2048 格；色板 ≤ 256 色；导出单边 ≤ 16384px 且面积 ≤ 67108864 像素
- 多帧动画：**尚未实现**（`capabilities().animation === false`）；动画素材请逐帧出图后用 `--sheet` 拼图集

## 1. 命令行参数（tool/artc.mjs）

```
node tool/artc.mjs --in <目录或文件> --out <目录> [选项]
node tool/artc.mjs --blank 58x58 --bead --palette beads16 --out out
node tool/artc.mjs --ops '[{"op":"eraseColor","color":"#ffffff"},{"op":"trim"}]' --in 素材 --out 输出
```

| 参数 | 说明 |
|---|---|
| `--in` | 输入目录（递归）或单张图片；Node 端仅 PNG 可直接解码，其他格式需先转 PNG 或用浏览器通道 |
| `--out` | 输出目录（默认 out/） |
| `--palette` | `auto` \| 预置 id（见下）\| `*.hex` 文件 \| `#aabbcc,#112233` |
| `--long-edge` | 输出长边格数（8–2048） |
| `--size` | 强制精确尺寸 `WxH`（游戏资产用，覆盖 --long-edge） |
| `--palette-k` | 自动取色颜色数（2–64） |
| `--style` | photo / gameboy / retro / silhouette / sprite / beads |
| `--dither` | `none` \| `floyd` \| `bayer` |
| `--downsample` | `average` \| `nearest` |
| `--crop` | `free` \| `1:1` \| `4:3` \| `16:9` |
| `--brightness / --contrast / --saturation` | 预处理（-100…100） |
| `--alpha` | 保留原图透明（真 alpha 通道） |
| `--transparent` | 背景色导出为透明（单色键控） |
| `--matte` | 合成 / 键控底色（默认 #ffffff） |
| `--lock-palette` | 只允许使用给定色板（拼豆与资产批次必备） |
| `--ops` | 算子数组 JSON（见第 3 节），与页内 edit() 完全一致 |
| `--bead [每板格数]` | 拼豆模式：输出 `*_图纸.svg` 与 `*_缺口清单.csv`（默认每板 58 格） |
| `--bead-mm / --bead-gram / --board` | 单颗直径 mm / 单颗重量 g / 每板格数 |
| `--sheet [列数]` | 输出 `_sheet.json` 图集坐标表（帧等尺寸 + offsetX/offsetY） |
| `--pixbin` | 额外输出 `.pixbin`（二进制像素数据，大画布往返更快） |
| `--scale` | PNG 整数倍放大（默认 1，超限自动降档） |
| `--name` | 命名模板：`{name}` `{index}` `{index:02}` `{w}` `{h}` `{scale}` |
| `--json` | 以 JSON 打印汇总（含每张的 hash / 尺寸 / 用量），便于脚本消费 |
| `--dry-run` | 只打印解析后的参数，不处理图片 |
| `--selftest` | 跑内置链路自检（无需素材） |
| `--describe` | 打印完整能力 / 算子 / 参数 JSON |

**退出码**：单张素材失败不会中断整批（逐张隔离），结尾给出失败清单；只要有失败就以非零码退出。
因此推荐流程是：跑一次 → 读失败清单 → 修素材 → 重跑。

### 预置色卡

| id | 名称 | 色数 | 号色 | 说明 |
|---|---|---|---|---|
| `pico8` | PICO-8 (16色) | 16 | 无 | 幻想主机 16 色，像素游戏最通用的一套 |
| `gameboy` | GameBoy (4色) | 4 | 无 | DMG 四绿，配合 Bayer 抖动出复古掌机感 |
| `nes` | NES 主机 (55色) | 55 | 无 | 2C02 色表，硬边像素风 |
| `cga` | CGA (16色) | 16 | 无 | 早期 PC 十六色，怀旧配色 |
| `beads16` | 拼豆 16 色（近似） | 16 | 有 | 通用拼豆配色，带号色，可出图纸与缺口清单 |
| `beads24` | 拼豆 24 色（近似） | 24 | 有 | 在 16 色上补中间色，适合照片类图纸 |

### 风格预设（一次性套用一组参数）

| id | 名称 | 说明 |
|---|---|---|
| `photo` | 照片写实 | 自动取色 32 色、区域平均，适合人像与风景照片 |
| `gameboy` | GameBoy | DMG 四绿 + Bayer 抖动，复古掌机观感 |
| `retro` | 复古主机 | NES 色表 + 最近邻，硬边像素风 |
| `silhouette` | 黑白剪影 | 2 色 + 强对比 + 去饱和，适合图标与剪影 |
| `sprite` | 游戏精灵 | 固定 32×32、PICO-8 色板、保留透明：游戏资产起步配置 |
| `beads` | 拼豆图纸 | 固定号色板 + 只用已有色 + 不抖动，保证图纸可复现且配色统一 |

## 2. 转换参数

| 参数 | 类型 | 范围 | 默认 | 说明 |
|---|---|---|---|---|
| `longEdge` | number | 8 … 2048 | `64` | 输出长边格数（短边按原图宽高比取整）（未指定 exactWidth/exactHeight 时生效） |
| `downsample` | enum | `average` / `nearest` | `"average"` | 降采样：区域平均（照片）或最近邻（硬边） |
| `cropRatio` | enum | `free` / `1:1` / `4:3` / `16:9` | `"free"` | 居中裁剪比例 |
| `paletteMode` | enum | `auto` / `preset` / `custom` | `"auto"` | 色板来源 |
| `paletteK` | number | 2 … 64 | `24` | 自动取色的目标颜色数（paletteMode=auto） |
| `presetPaletteId` | string | — | `"pico8"` | 预置色卡 id（pico8 / gameboy / nes / cga / beads16 / beads24）（paletteMode=preset） |
| `customPalette` | string | — | `[]` | 自定义色板（#rrggbb 数组，≤256）（paletteMode=custom） |
| `dither` | enum | `none` / `floyd` / `bayer` | `"none"` | 抖动方式（开启时自动关闭杂色清理） |
| `ditherStrength` | number | 0 … 100 | `100` | 抖动强度（dither!=none） |
| `cleanup` | boolean | — | `true` | 杂色清理：把孤立小色块并入邻域主色 |
| `cleanupMinSize` | number | 1 … 10 | `2` | 小于该格数的连通色块会被并入（cleanup=true） |
| `brightness` | number | -100 … 100 | `0` | 亮度调整（转换前） |
| `contrast` | number | -100 … 100 | `0` | 对比度调整（转换前） |
| `saturation` | number | -100 … 100 | `0` | 饱和度调整（转换前） |
| `transparent` | enum | `none` / `key` / `alpha` | `"none"` | 透明处理：不透明（合成到 matteColor）/ 单色键控 / 真 alpha 通道 |
| `matteColor` | hex | — | `"#ffffff"` | alpha 合成与单色键控用的底色 |
| `exactWidth` | number | 1 … 2048 | `null` | 强制输出宽度（游戏资产模式；须与 exactHeight 同时给出） |
| `exactHeight` | number | 1 … 2048 | `null` | 强制输出高度 |
| `lockPalette` | boolean | — | `false` | 只允许使用给定色板（拼豆/资产批次；量化与算子都不会新增颜色） |

所有参数都会过一遍校验：越界夹紧、坏类型回退默认，**并且如实报告每一处修正**
（页内 `validateParams()`，CLI 的 `--dry-run` 会打印）。这样 agent 不会误以为"我传的值生效了"。

## 3. 编辑算子（声明式）

同一套算子在三个入口完全一致：CLI `--ops`、页内 `edit(ops)`、页内 `render(..., { ops })`。

### `fill`

油漆桶：把 (x,y) 所在连通区域整体换色；erase:true 则整块挖成透明

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `x` | number | 必填 | — | 起点列（越界会被静默裁剪） |
| `y` | number | 必填 | — | 起点行 |
| `color` | hex | 可选 | `"当前主色"` | 填充色 |
| `erase` | boolean | 可选 | `false` | 为 true 时挖洞（透明格之间视为同一连通区域） |

注意：
- 无副作用路径（render/renderBlank 的 ops）必须显式给 color，否则报错

### `setCells`

指定格子批量上色或挖洞

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `cells` | cells | 必填 | — | 格子坐标数组 [[x,y],…] |
| `color` | hex | 可选 | `"当前主色"` | 上色颜色 |
| `erase` | boolean | 可选 | `false` | 为 true 时把这些格子挖成透明 |

### `setAll`

整幅涂色；erase:true 清空成全透明

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `color` | hex | 可选 | `"当前主色"` | 整幅颜色 |
| `erase` | boolean | 可选 | `false` | 整幅挖洞（全透明画布） |

### `line`

Bresenham 直线，与界面笔刷同一套足迹

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `x0` | number | 必填 | — | 起点列 |
| `y0` | number | 必填 | — | 起点行 |
| `x1` | number | 必填 | — | 终点列 |
| `y1` | number | 必填 | — | 终点行 |
| `color` | hex | 可选 | `"当前主色"` | 线色 |
| `brushSize` | number | 可选 | `1` | 笔刷边长 1–3 |

### `rect`

矩形：filled 省略时为实心

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `x0` | number | 必填 | — | 左上角列 |
| `y0` | number | 必填 | — | 左上角行 |
| `x1` | number | 必填 | — | 右下角列 |
| `y1` | number | 必填 | — | 右下角行 |
| `color` | hex | 可选 | `"当前主色"` | 颜色 |
| `filled` | boolean | 可选 | `true` | false 为空心描边 |

### `ellipse`

椭圆（内切于给定外接框），与界面椭圆工具同一栅格化

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `x0` | number | 必填 | — | 外接框左列 |
| `y0` | number | 必填 | — | 外接框上行 |
| `x1` | number | 必填 | — | 外接框右列 |
| `y1` | number | 必填 | — | 外接框下行 |
| `color` | hex | 可选 | `"当前主色"` | 颜色 |
| `filled` | boolean | 可选 | `true` | false 为空心圆环 |

### `transform`

镜像 / 旋转；rotate90 与 rotate270 会交换宽高，alpha 一起搬

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `kind` | enum | 必填 | — | flipX | flipY | rotate90 | rotate180 | rotate270 |

注意：
- 形状重排时 cells 记 0，用 kind 说明发生了什么；changed 仍按真实变化判定

### `trim`

裁掉四周透明边，画布缩到不透明内容的外接框

_无参数_

注意：
- 全透明或已无透明边时返回 changed:false 且不报错（批处理里这是合法状态）

### `eraseColor`

便捷算子：把某色全部挖成透明（一键去白底）

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `color` | hex | 必填 | — | 要挖掉的画布已有颜色（色板里没有则报错） |

注意：
- 等价于「按色选区 + setCells(erase)」；保留是因为"去白底"在精灵图流程里高频

### `replaceAny`

便捷算子：把某色整体换成另一色（拼豆"没有这个色，换一个看看"）

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `color` | hex | 必填 | — | 源色（必须是画布色板里已有的颜色） |
| `to` | hex | 必填 | — | 目标色（允许是色板外的新色） |

注意：
- 源色与目标色相同的等价情形返回 changed:false 而非报错

### 统一返回形状（`EditSummary`）

```json
{
  "applied": true,
  "changes": [{ "op": "rect", "cells": 256, "changed": true }],
  "width": 64, "height": 64,
  "paletteSize": 9, "hasAlpha": false, "transparent": 0,
  "usage": { "#112233": 256 }
}
```

- **`changed` 是权威判定**：索引 / 不透明度 / 尺寸任一变化都算改动（含"只挖洞不改色"的编辑）。
- `cells` 是受影响格数；形状重排记 0 并用 `kind` 说明（例如 `rotate90`）。
- 整串算子都没改动时 `applied: false`。

## 4. 页内 API（`window.pixelArtStudio`）

打开单文件 HTML 后自动挂载。**所有方法名与返回形状保持稳定**，新增能力只做加法。

### 自省（先调这些，别猜）

```js
ps.describe()          // 能力 + 算子 + 参数，一次拿全
ps.describeOps()       // 算子表（与本文档同源）
ps.describeParams()    // 参数表
ps.capabilities()      // 上限、解码格式、是否支持动画等
ps.validateParams({ longEdge: 99999 })   // 干跑校验：不落状态，返回被修正的字段
await ps.whenReady()   // 就绪信号（脚本开头调用一次）
```

### 转换与参数

```js
ps.getParams()                       // 当前参数（副本）
ps.setParams({ longEdge: 64 })       // 改参并立即重转，返回最终参数
ps.defaultParams()                   // 出厂默认（批处理的可复现基底）
ps.applyStylePreset("gameboy")       // 套用预设（写状态）
ps.stylePreset("gameboy")            // 只读查询预设（不改状态）
ps.presetPalettes()                  // 预置色卡列表（含拼豆号色）
await ps.importImage(fileOrBlobOrDataURLOrURL)
ps.convert()                         // 用当前参数重跑（无原图会报错）
ps.reset()                           // 清空工作区（不弹确认）
```

### 读取

```js
ps.getInfo()        // hasImage/width/height/paletteSize/hasAlpha/transparent/params/工具与颜色…
ps.getPalette()     // 工作色板
ps.getUsage()       // { "#hex": 格数 }（不含透明格，透明格见 countTransparent）
ps.hasAlpha()  ps.countTransparent()  ps.artHash()
```

### 导出（返回字符串/字节，不触发下载）

```js
ps.exportPNG(scale, { transparentBg, bgHex })   // → dataURL
//   transparentBg: true 时按「单色键控」把某个颜色导出为透明；bgHex 省略则自动用
//   当前参数的 matteColor（键控色就是它），所以通常只传 transparentBg 即可
ps.exportPixelJSON()                     // 每格颜色 + 每色用量（拼豆原料清单）
ps.exportPaletteHex()                    // → .hex 文本
ps.exportProject()                       // → 项目 JSON（参数+色板+像素，不含原图）
ps.exportPixBin()                        // → base64 的二进制像素数据（大画布更快）
ps.importPixBin(base64, palette?)        // 回读
ps.loadProject(json)                     // 载入项目 JSON
```

### 拼豆与游戏资产

```js
ps.beadReport({ codes, beadMm, beadGram, boardCells })
// → { rows:[{code,color,cells,beads,grams,bags}], colorCount, totalBeads, totalGrams,
//     transparentCells, board:{columns,rows}, physical:{widthMm,heightMm} }
ps.exportBeadSvg({ cellPx: 22 })   // 可打印图纸（格内写号色 + 板标注 + 图例）
ps.exportBeadCsv()                 // 缺口清单（照着买）
ps.layoutSheet(frames, columns, padding)  // 图集坐标表：帧等尺寸 + offsetX/offsetY
```

### 后台编辑（不必碰界面）

```js
ps.newCanvas({ width: 32, height: 32, transparent: true })   // 空白画布（无需原图）
ps.edit([{ op: "rect", x0: 4, y0: 4, x1: 27, y1: 27, color: "#223344" }, { op: "trim" }])
ps.undo()  ps.redo()
ps.render(fileOrDataURL, params, scale, { transparentBg, ops })      // 无副作用一站式
await ps.renderBlank({ width: 32, height: 32, transparent: true, ops: [...] }, params, scale, { transparentBg })
//   renderBlank = 「空白画布 + 算子 + 导出」的无副作用一站式（无需原图、不碰工作区状态），
//   CLI 的 --blank 走的是同一条链路；返回形状与 render() 一致
```

### 编辑器状态写入

```js
ps.setTool("pencil" | "bucket" | "picker" | "rect" | "ellipse" | "selection" )
ps.setPrimary("#ff6600")   ps.setBg("#ffffff")   ps.swapColors()
ps.setBrushSize(3)         ps.setEraseToAlpha(true)   ps.setLockPalette(true)
ps.thumbnail(160)          // 原图缩略图 dataURL
```

## 5. 可以依赖的稳定约定

- **确定性**：同一张图 + 同一组参数 + 同一串算子 = 同一结果；用 `artHash()` / `--json` 里的 `hash` 跨运行比对。
- **镜像同步**：`setParams` / `importImage` / `reset` / `loadProject` 之后，**同一次 JS 调用内**紧接读 `getInfo` / `getUsage` / `exportPNG` 就能拿到最新值，不需要等下一帧。
- **无副作用路径**：`render()` 不碰当前画布、撤销栈与偏好，适合批量；`edit()` / `newCanvas()` 会改当前画布并进撤销栈。
- **错误**：一律 `throw Error`（中文原因），例如无画布导出、色板里没有该颜色、图片解码失败、项目文件损坏。
- **越界**：坐标静默裁剪；画布尺寸超上限夹紧到 2048 并通过返回值/自省告知实际尺寸。

## 6. 边界与注意事项

- **Node 端解码能力**：只承诺 PNG（位深 8/16、颜色类型 0/2/3/4/6、非隔行）。
  其他格式要么先用工具转成 PNG，要么走页内 API（浏览器原生解码覆盖 PNG/JPG/WebP/GIF/BMP/AVIF/ICO/SVG）。
- **单画布模型**：引擎一次只有一张画布；多帧动画尚未实现（见上）。逐帧出图后用 `--sheet` 或 `layoutSheet()` 拼图集。
- **拼豆模式请锁定色板**：`--lock-palette`（或参数 `lockPalette: true`）保证量化与算子都不引入色板外的颜色，
  这样图纸上出现的每个号色都是你真买得到的。
- **游戏资产请用精确尺寸**：`--size 32x32` + `--alpha`，导出帧尺寸恒等，引擎侧无需二次对齐。
