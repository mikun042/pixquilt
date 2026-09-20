# pixquilt（像素画工作台） · Agent 接口手册

> **本文件由 `node tool/describe.mjs --write` 从 `src/core/spec.ts` 生成，请勿手改。**
> 改了 `src/core/spec.ts` 里的算子 / 参数元数据后，必须重跑 `npm run describe` 再提交。

这份手册是给 **AI agent 与脚本** 用的：不点界面就能完成「导入 → 调参 → 转换 → 编辑 → 导出」，
并覆盖本项目的两个主要用途——**拼豆图纸**与**可批量生产的游戏美术资产**。

## 0. 三条最快的上手路径

```bash
# ① 命令行批处理（不需要浏览器，零第三方依赖）
node tool/artc.mjs --in 素材目录 --out 输出 --palette beads16 --long-edge 58 --bead
node tool/artc.mjs --in 素材目录 --out 输出 --palette gameboy --size 32x32 --alpha --sheet 4

# ② 自检与自省（先确认环境与能力，再写脚本）
node tool/artc.mjs --selftest      # 链路自检，无需任何素材（以它自己打印的 N/N 为准）
node tool/artc.mjs --describe     # 打印完整的算子/参数/能力 JSON

# ③ 页内 API（浏览器自动化 / Playwright / CDP evaluate）
#    打开 像素画工作台.html 后：window.pixelArtStudio.describe()
```

- 接口版本：`apiLevel = 2`，产品版本 `0.1.0`，项目文件 Schema `v4`
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
| `--name` | 命名模板：`{name}` `{index}` `{index:02}` `{w}` `{h}` `{scale}` |
| `--scale` | PNG 整数倍放大（默认 1，超限自动降档） |
| `--json` | 以 JSON 打印汇总（含每张的 hash / 尺寸 / 用量）；stdout 只有这一份 JSON，可直接 parse。**注意两套尺寸/透明字段**：`width`/`height`/`transparent` 是模型侧（格数、alphaMask），`pngWidth`/`pngHeight`/`pngTransparent` 是产物侧（含 `--scale` 放大与 `--transparent` 键控）；判断产物请用后者 |
| `--dry-run` | 只打印解析后的参数，不处理图片 |
| `--quiet` | 少打印过程信息 |
| `--progress` | 与 `--json` 同用时把进度行写到 stderr（保证 stdout 仍是纯 JSON） |
| `--help` | 打印帮助；**未知参数一律报错**（不会静默忽略），错误信息会给出最接近的正确参数名 |
| `--blank <WxH>` | 建一张空白画布（不读任何素材），可继续用 `--ops` 作画 |
| `--blank-color` | 空白填充色（默认 #ffffff） |
| `--blank-transparent` | 空白为透明（只影响底色，与 `--palette` / `--size` 无关） |
| `--index` | 命名模板里 `{index}` 的取值（批量空白时用于区分同名产物） |
| `--long-edge` | 输出长边格数（8–2048） |
| `--size` | 强制精确尺寸 `WxH`（游戏资产用，覆盖 --long-edge） |
| `--downsample` | `average` \| `nearest` |
| `--crop` | `free` \| `1:1` \| `4:3` \| `16:9` |
| `--palette` | `auto` \| 预置 id（见下）\| `*.hex` 文件 \| `#aabbcc,#112233` |
| `--preset` | 只指定预置色卡（等价于 `--palette <预置 id>`；带号色的卡会把号色写进图纸 / 清单 / `.hex`） |
| `--palette-k` | 自动取色颜色数（2–64） |
| `--style` | photo / gameboy / retro / silhouette / sprite / beads |
| `--dither` | `none` \| `floyd` \| `atkinson` \| `bayer` \| `bayer8` |
| `--dither-max-colors` | 抖动时最多用到几种色号（0=不限）；拼豆场景约束到"手上只有这么多种" |
| `--quality` | 额外输出图纸质量报告（保真误差 / 色号数 / 珠子数 / 抖动代价） |
| `--auto-tune` | 自动搜参：在「色号数 ≤ n」约束下找观感最好的参数组合（确定性） |
| `--no-cleanup` | 关闭杂色清理（像素素材请开它：清理会吃掉 1px 高光/描边断点） |
| `--cleanup-min` | 杂色清理阈值（1–10） |
| `--brightness / --contrast / --saturation` | 预处理（-100…100） |
| `--alpha` | 保留原图透明（真 alpha 通道） |
| `--transparent` | 背景色导出为透明（单色键控） |
| `--matte` | 合成 / 键控底色（默认 #ffffff） |
| `--key-mode` | 键控范围：`global`（默认）全图同色都透明；`border` 只键掉与四边连通的底色区域。白底 + 主体内部有同色高光（眼白/高光）时必须用 `border`，否则那些像素会被一起挖穿成洞 |
| `--key-tolerance` | 键控颜色容差 0–255（三通道最大差，默认 0 = 精确同色）。扩散模型（ComfyUI 等）输出的「白底」实际是 254/255 混合噪声，容差 0 一个都键不掉，需要 1–3 |
| `--lock-palette` | 只允许使用给定色板（拼豆与资产批次必备） |
| `--browser-decode` | 借无头浏览器原生解码器，把 Node 解不了的格式（JPEG/WebP/GIF/BMP/AVIF/ICO/SVG）先转 PNG 再处理。**需要本机有 Chrome/Edge/Chromium**；不加时非 PNG 会被跳过并如实报告（不是静默忽略） |
| `--slice` | 把输入图**切成多张**（与 `--sheet` 方向相反：`--sheet` 拼图集、`--slice` 拆图集）。`auto` 按全透明行/列自动推断；`列数x行数` 显式网格；`WxHpx` 每格像素尺寸 |
| `--sheet [列数]` | 输出 `_sheet.json` 图集坐标表（帧等尺寸 + offsetX/offsetY） |
| `--pixbin` | 额外输出 `.pixbin`（二进制像素数据，大画布往返更快） |
| `--engine <格式>` | 在 `_sheet.json` 之外，再输出一份**引擎能直接吃**的图集元数据：`godot`（`.tres` SpriteFrames）/ `unity`（`.meta` 的 spriteSheet 段，需 `--texture-guid`）/ `tiled`（`.tsx`）。坐标与 `_sheet.json` 同源 |
| `--texture-path <路径>` | `--engine` 里引用的贴图路径（默认 `_sheet.png`） |
| `--texture-guid <guid>` | Unity 格式**必需**：从你那份 `.png.meta` 里取（没有 guid 的 `.meta` 无效，所以这里直接报错而不是留空） |
| `--ppu <n>` | Unity 的 `pixelsPerUnit`（默认取帧高——像素画要的是「1 格 = 1 单位」，不是 Unity 默认的 100） |
| `--tile-size <WxH>` | Tiled 的瓦片尺寸（默认取帧尺寸） |
| `--bead [每板格数]` | 拼豆模式：输出 `*_图纸.svg` 与 `*_缺口清单.csv`（默认每板 58 格） |
| `--pdf` | 额外输出 `*_拼豆图纸.pdf`（A4 分页可打印；需同时用 `--bead`） |
| `--bead-mm / --bead-gram` | 单颗直径 mm（默认 5）/ 单颗重量 g（默认 0.08） |
| `--board` | 每板格数（默认 58） |
| `--ops` | 算子数组 JSON（见第 3 节），与页内 `edit()` 完全一致 |
| `--ops-file` | 从文件读算子数组（也写作 `--ops @file.json`）；批量 setCells 动辄十几 KB，走文件可避开 shell 长度与引号转义 |
| `--selftest` | 跑内置链路自检（无需素材） |
| `--describe` | 打印完整能力 / 算子 / 参数 JSON |

> 上表与 CLI 真正接受的开关集**每次生成时对账**（对的是 `tool/artc.mjs` 的 `KNOWN_FLAGS`）：
> 少收录或多收录任何一项都会让本脚本直接报错，不再靠人记得同步。

**退出码**：单张素材失败不会中断整批（逐张隔离），结尾给出失败清单；只要有失败就以非零码退出。
因此推荐流程是：跑一次 → 读失败清单 → 修素材 → 重跑。

### 预置色卡

**`source` 决定色号可不可信**（三类，别混用）：

- `official` —— 厂商/规范公开的色表，色号与颜色是权威的。
- `community` —— **社区整理**的品牌拼豆色卡，有据可查但**不保证与实物零偏差**，以实物为准。
- `approximate` —— 我们自造的通用近似色，只为让图纸有稳定号色，不属任何品牌。

| id | 名称 | 色数 | 号色 | 来源 | 说明 |
|---|---|---|---|---|---|
| `pico8` | PICO-8 (16色) | 16 | 无 | official | 幻想主机 16 色，像素游戏最通用的一套 |
| `gameboy` | GameBoy (4色) | 4 | 无 | official | DMG 四绿，配合 Bayer 抖动出复古掌机感 |
| `nes` | NES 主机 (55色) | 55 | 无 | official | 2C02 色表，硬边像素风 |
| `cga` | CGA (16色) | 16 | 无 | official | 早期 PC 十六色，怀旧配色 |
| `beads16` | 拼豆 16 色（近似） | 16 | 有 | approximate | 通用近似配色，不属任何品牌；带号色，可出图纸与缺口清单 |
| `beads24` | 拼豆 24 色（近似） | 24 | 有 | approximate | 在 16 色基础上补中间色，不属任何品牌 |
| `hama_midi` | Hama Midi（92色） | 92 | 有 | community | Hama 中号拼豆（2.6mm）· 社区整理色卡，以实物为准 |
| `hama_mini` | Hama Mini（78色） | 78 | 有 | community | Hama 小号拼豆（1.5mm）· 社区整理色卡，以实物为准 |
| `hama_maxi` | Hama Maxi（25色） | 25 | 有 | community | Hama 大号拼豆（4.5mm）· 社区整理色卡，以实物为准 |
| `perler` | Perler（103色） | 103 | 有 | community | Perler 标准拼豆（5mm）· 社区整理色卡，以实物为准 |
| `perler_mini` | Perler Mini（41色） | 41 | 有 | community | Perler 小号拼豆· 社区整理色卡，以实物为准 |
| `perler_caps` | Perler Caps（26色） | 26 | 有 | community | Perler 胶囊珠· 社区整理色卡，以实物为准 |
| `artkal_a` | Artkal A（145色） | 145 | 有 | community | Artkal A 系列（2.6mm 软珠）· 社区整理色卡，以实物为准 |
| `artkal_c` | Artkal C（174色） | 174 | 有 | community | Artkal C 系列（2.6mm 硬珠）· 社区整理色卡，以实物为准 |
| `artkal_m` | Artkal M（220色） | 220 | 有 | community | Artkal M 系列（2.6mm 珠光）· 社区整理色卡，以实物为准 |
| `artkal_r` | Artkal R（89色） | 89 | 有 | community | Artkal R 系列（5mm）· 社区整理色卡，以实物为准 |
| `artkal_s` | Artkal S（199色） | 199 | 有 | community | Artkal S 系列（5mm 软珠）· 社区整理色卡，以实物为准 |
| `nabbi` | Nabbi（30色） | 30 | 有 | community | Nabbi 中号拼豆（北欧常见）· 社区整理色卡，以实物为准 |
| `yant` | Yant（118色） | 118 | 有 | community | Yant 拼豆· 社区整理色卡，以实物为准 |

> 品牌色卡取自 [maxcleme/beadcolors](https://github.com/maxcleme/beadcolors)（MIT），
> 由 `tool/bead-palettes.mjs` 生成。**Mard（290 色）与 Diamond Dotz（461 色）因超过色板上限 256 未收录**；
> 需要它们时用 `--palette 我的色卡.hex` 导入（支持带号色），或等索引位宽迁移（属独立一轮）。

### 风格预设（一次性套用一组参数）

| id | 名称 | 说明 |
|---|---|---|
| `photo` | 照片写实 | 自动取色 32 色、区域平均，适合人像与风景照片 |
| `gameboy` | GameBoy | DMG 四绿 + Bayer 抖动，复古掌机观感 |
| `retro` | 复古主机 | NES 色表 + 最近邻，硬边像素风 |
| `silhouette` | 黑白剪影 | 2 色 + 强对比 + 去饱和，适合图标与剪影 |
| `sprite` | 游戏精灵 | 固定 32×32、PICO-8 色板、保留透明、不做杂色清理：像素资产起步配置（1px 细节原样保留） |
| `beads` | 拼豆图纸 | 固定号色板 + 只用已有色 + 不抖动，保证图纸可复现且配色统一 |

## 2. 转换参数

| 参数 | 类型 | 范围 | 默认 | 说明 |
|---|---|---|---|---|
| `longEdge` | number | 8 … 2048 | `64` | 输出长边格数（短边按原图宽高比取整）（未指定 exactWidth/exactHeight 时生效） |
| `downsample` | enum | `average` / `nearest` | `"average"` | 降采样：区域平均（照片）或最近邻（硬边） |
| `cropRatio` | enum | `free` / `1:1` / `4:3` / `16:9` | `"free"` | 居中裁剪比例 |
| `paletteMode` | enum | `auto` / `preset` / `custom` | `"auto"` | 色板来源 |
| `paletteK` | number | 2 … 64 | `24` | 自动取色的目标颜色数（paletteMode=auto） |
| `presetPaletteId` | string | — | `"pico8"` | 预置色卡 id（共 19 张：官方硬件色表 / 品牌拼豆（社区整理）/ 通用近似，完整清单见「预置色卡」小节）（paletteMode=preset） |
| `customPalette` | string | — | `[]` | 自定义色板（#rrggbb 数组，≤256）（paletteMode=custom） |
| `customPaletteCodes` | string | — | `[]` | 自定义色板的号色数组，与 customPalette 按下标一一对应（如 ["S12","S31"]）；缺项留空串，下游会自动编号 C1/C2…。**拼豆用户靠它让自己的色卡编号印在图纸上**（paletteMode=custom（与 customPalette 等长）） |
| `dither` | enum | `none` / `floyd` / `atkinson` / `bayer` / `bayer8` | `"none"` | 抖动方式（开启时自动关闭杂色清理）。floyd=误差扩散；atkinson=误差扩散但只扩散 3/4、对比度更高更干净（有限色板友好）；bayer/bayer8=有序抖动（8×8 层次更细） |
| `ditherStrength` | number | 0 … 100 | `100` | 抖动强度（dither!=none） |
| `ditherMaxColors` | number | 0 … 64 | `0` | 抖动时允许实际用到的最大色号数（0=不限制）。抖动会增加色号数与珠子总数，拼豆场景可用它约束到"我手上只有这么多种豆子"；超出时先按真实用量取用量最大的 N 个作候选色板，再带着这个缩小的色板重跑一遍量化，因此色号数一定 ≤ N（dither!=none && ditherMaxColors>0） |
| `cleanup` | boolean | — | `true` | 杂色清理：把孤立小色块并入邻域主色。注意它**只改颜色归属，不删除脱离主体的小碎片**（不减少连通块数）——去碎片请在上游处理或用 --no-cleanup 自行保留 |
| `cleanupMinSize` | number | 1 … 10 | `2` | 小于该格数的连通色块会被并入（cleanup=true） |
| `brightness` | number | -100 … 100 | `0` | 亮度调整（转换前） |
| `contrast` | number | -100 … 100 | `0` | 对比度调整（转换前） |
| `saturation` | number | -100 … 100 | `0` | 饱和度调整（转换前） |
| `transparent` | enum | `none` / `key` / `alpha` | `"none"` | 透明处理：不透明（合成到 matteColor）/ 单色键控 / 真 alpha 通道 |
| `matteColor` | hex | — | `"#ffffff"` | alpha 合成与单色键控用的底色 |
| `keyMode` | enum | `global` / `border` | `"global"` | 键控范围：global 全图同色都透明；border 只键掉与四边连通的底色区域（白底 + 主体内部有同色高光时必须用 border）（transparent=key） |
| `keyTolerance` | number | 0 … 255 | `0` | 键控颜色容差（三通道最大差，0=精确同色）；扩散模型输出的白底常是 254/255 噪声，需要 1–3（transparent=key） |
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
- **只裁边、不缩放**：要"裁到内容再适配成固定尺寸"请接着用 fit

### `fit`

把内容缩放并居中放进 WxH 画布（游戏资产定尺寸）

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `width` | number | 必填 | — | 目标宽度（格） |
| `height` | number | 必填 | — | 目标高度（格） |
| `mode` | enum | 可选 | `"contain"` | contain 等比放下留透明边 | cover 等比铺满裁溢出 | stretch 直接拉伸（会变形） |

注意：
- 以**不透明内容**为基准缩放，不是整张画布——否则周围的透明留白会被一起算进去、主体偏小
- 缩放用最近邻，保证像素画边缘锐利（绝不插值）
- 与 trim 的分工：`--size` 在管线阶段（比算子早），所以"先裁后适配"必须写成 `[{op:"trim"},{op:"fit",width:64,height:64}]`；只用 trim 得不到目标尺寸

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

### `outline`

描边：给不透明内容的边界外侧补一圈实色（像素画收尾常用）

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `color` | hex | 可选 | `"当前主色"` | 描边色 |
| `connectivity` | enum | 可选 | `8` | 8（默认，完整一圈含斜角） | 4（只描正交相邻那圈，四角留空） |
| `offset` | number | 可选 | `1` | 描边层数（向外扩几圈） |

注意：
- 只往空的（透明）格写，已有内容一律不被覆盖
- 描边是**扩张**操作：对同一张图再描一次会把刚描的一圈当成内容继续向外扩。想加粗请用 offset，不要在算子数组里连写两次
- 判定有无内容看 alpha 而非颜色索引：挖过洞的格子里仍留着旧索引，只看索引会贴着看不见的东西描
- 外侧没有空格时返回 changed:false，且**不会**把描边色加进色板（空操作不该污染颜色表）

### `mirror`

镜像加笔：把当前内容镜像到画布另一侧（对称角色/道具/装饰）

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `kind` | enum | 必填 | — | h（左右） | v（上下） | both（四向） |
| `color` | hex | 可选 | `"当前主色"` | 镜像副本的颜色（想做出"倒影"就用更暗的色） |

注意：
- 以画布中线为轴，原内容保留，镜像副本叠加上去
- 副本里的透明格不落笔（否则镜像一次会把原内容抹掉一半）
- 已有内容的格子不被覆盖，便于"先摆一半再镜像"
- 与 transform flipX 的区别：flipX 是把整幅翻转（原内容不在原位），mirror 是保留原内容再补一份

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
ps.exportSheetMeta(fmt, frames, opts)      // 转成引擎格式：godot | unity（需 textureGuid）| tiled
//   opts: { columns?, padding?, texturePath, textureGuid?, name?, pixelsPerUnit? }
//   与 CLI 的 --engine 同一份实现（src/core/sheetmeta.ts），坐标同源、不会两处漂移
```

### 编辑（不必依赖界面操作，但**会改当前画布**）

> 下面这些都写**当前工作区**：画布、撤销栈会跟着变，屏幕（如果开着）也会跟着刷新。
> 想要"完全不碰工作区"的批处理，用 `render()` / `renderBlank()`——它们才是无副作用的。

```js
ps.newCanvas({ width: 32, height: 32, transparent: true })   // 空白画布（无需原图），并清空撤销栈
ps.edit([{ op: "rect", x0: 4, y0: 4, x1: 27, y1: 27, color: "#223344" }, { op: "trim" }])
ps.undo()  ps.redo()
ps.render(fileOrDataURL, params, scale, { transparentBg, ops })      // 无副作用一站式
await ps.renderBlank({ width: 32, height: 32, transparent: true, ops: [...] }, params, scale, { transparentBg })
//   renderBlank = 「空白画布 + 算子 + 导出」的无副作用一站式（无需原图、不碰工作区状态），
//   CLI 的 --blank 走的是同一条链路；返回形状与 render() 一致
//   options 只认 width / height / color / transparent / ops；拼错的字段名、或非正的宽高
//   都会**当场报错**（不会静默退化成一张 0×0 的坏画布）。ops 也必须给在这个参数里
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
- **整体替换 = 新基线**：`newCanvas` / `loadProject` / `importPixBin` / `convert` / `reset`（以及界面上的导入、重新转换、新建）
  都是**换掉整幅画布**，因此会**清空撤销栈**——之后 `undo()` 不会回到上一张画布。
  只有 `edit()` 这类"在现有画布上改"的操作才可以用 `undo()` 回退。
- **越界**：坐标静默裁剪；画布尺寸超上限夹紧到 2048 并通过返回值/自省告知实际尺寸。

## 6. 边界与注意事项

- **Node 端解码能力**：只承诺 PNG（位深 8/16、颜色类型 0/2/3/4/6、非隔行）。
  其他格式要么先用工具转成 PNG，要么走页内 API（浏览器原生解码覆盖 PNG/JPG/WebP/GIF/BMP/AVIF/ICO/SVG）。
- **单画布模型**：引擎一次只有一张画布；多帧动画尚未实现（见上）。逐帧出图后用 `--sheet` 或 `layoutSheet()` 拼图集。
- **拼豆模式请锁定色板**：`--lock-palette`（或参数 `lockPalette: true`）保证量化与算子都不引入色板外的颜色，
  这样图纸上出现的每个号色都是你真买得到的。
- **游戏资产请用精确尺寸**：`--size 32x32` + `--alpha`，导出帧尺寸恒等，引擎侧无需二次对齐。
