# Agent 上手：用本项目生产像素素材

> 面向 **AI agent / 脚本作者**。目标：不读源码、不猜接口，就能批量产出可用的像素素材
> （游戏精灵图、拼豆图纸、图标、图集）。
>
> **先跑一条命令确认环境，再照抄下面的配方。**
> 只知道仓库地址、还没确认环境的，先读 [`../AGENTS.md`](../AGENTS.md)。

```bash
node tool/artc.mjs --selftest    # 应输出 自检：42/42 通过（不需要 npm install）
```

---

## 1. 冷启动：先自省，再动手

不要猜参数名，让工具自己说：

```bash
node tool/artc.mjs --describe    # 全部能力 / 算子 / 参数 / 预置色卡 / 上限（JSON）
node tool/artc.mjs --help        # 人类可读的参数表
```

一条命令跑通全链路并**真的产出文件**（产出落在 `.quickstart/`，看完可以直接删）：

```bash
node tool/quickstart.mjs
```

它会依次做六件事并打印每步结论：自省 → 造素材 → 批量出资产 → 拼豆图纸 → 图集 → 页内 API。
**想确认"这个环境到底能不能干活"，跑它一次就够了。**

---

## 2. 配方一：批量出游戏资产（最常用）

**场景**：一堆精灵图 → 精确尺寸 + 真 alpha + 图集坐标表。

```bash
node tool/artc.mjs --in 素材目录 --out 输出 \
  --size 64x64 --style sprite --alpha --sheet 4 --json
```

| 参数 | 为什么这么写 |
|---|---|
| `--size 64x64` | **精确尺寸**（覆盖 `--long-edge`），游戏引擎要的就是确定尺寸 |
| `--style sprite` | 最近邻 + 不清理杂色 + 保留透明 —— **像素图的无损配置**（见第 3 节） |
| `--alpha` | 保留原图真 alpha 通道 |
| `--sheet 4` | 额外输出 `_sheet.json`（每帧 `offsetX/offsetY`），4 列排布 |
| `--json` | stdout 纯 JSON，可直接 parse 出每张的 hash / 尺寸 / 用量 |

**要喂给具体引擎**再加一条：

```bash
--engine godot      # .tres SpriteFrames
--engine unity      # .meta 的 spriteSheet 段（必须同时给 --texture-guid）
--engine tiled      # .tsx
```

---

## 3. 配方二：做无损像素素材（**最容易错的地方**）

**默认参数是给"照片转像素"调的，用在已经画好的像素图上是有损的**——1px 描边会被糊掉。

三种等价写法，任选其一：

```bash
--style sprite

# 或显式展开
--downsample nearest --no-cleanup --palette-k 64 --alpha
```

**判断你有没有踩这个坑**：如果输入的图本来就有硬边和 1px 细节，输出却变糊了，就是这里。

> 项目在这一点上有**唯一一手实测数据**：512→64 的 8:1 缩小下，`nearest` 的描边一根没丢；
> 用默认的 `average` 则明显糊。所以做素材务必显式指定。

---

## 4. 配方三：拼豆图纸

```bash
node tool/artc.mjs --in 图片.png --out 输出 \
  --preset beads16 --long-edge 58 --bead --pdf --json
```

- `--preset beads16` —— 固定号色板（`beads16` / `beads24`），号色会进图纸与清单
- `--long-edge 58` —— 58 格 ≈ 一块标准拼豆板
- `--bead` —— 输出 `*_图纸.svg` + `*_缺口清单.csv`
- `--pdf` —— 再输出 `*_拼豆图纸.pdf`（A4 分页，每块板一页，需与 `--bead` 同用）
- `--lock-palette` —— **只允许用色板里的颜色**（拼豆用户买不到图纸外的颜色，别退化成近似色）

**用自己的色号**：`--palette 我的色卡.hex`，文件每行 `编号 #rrggbb` 两列。

---

## 5. 配方四：纯程序化出图（不读任何素材）

用算子从零画：

```bash
node tool/artc.mjs --blank 32x32 --blank-transparent --out 输出 \
  --ops '[{"op":"rect","x0":2,"y0":2,"x1":29,"y1":29,"color":"#1d2b53"},{"op":"outline","color":"#000000"},{"op":"trim"}]'
```

算子数组很长时走文件（避开 shell 长度与引号转义）：

```bash
node tool/artc.mjs --blank 64x64 --blank-transparent --out 输出 --ops @ops.json --json
```

**13 类算子**（`--describe` 看完整字段表）：

| 算子 | 作用 |
|---|---|
| `fill` | 油漆桶：把 (x,y) 所在连通区域整体换色；`erase:true` 挖成透明 |
| `setCells` | 指定格子批量上色 / 挖洞（`cells: [[x,y],…]`） |
| `setAll` | 整幅涂色；`erase:true` 清空 |
| `line` | 画线（`brushSize` 可加粗） |
| `rect` / `ellipse` | 矩形 / 椭圆（`filled` 决定是否填充） |
| `transform` | 几何变换（`kind` 指定具体变换） |
| `trim` | 裁掉四周全透明的空白边 |
| `fit` | 缩放到指定 `width`/`height`（`mode` 控制策略） |
| `eraseColor` | 把某色挖成透明 |
| `replaceAny` | 把某色整体换成另一色 |
| `outline` | 描边（`connectivity` 控制连通性） |
| `mirror` | 镜像 |

> ⚠️ **无副作用路径（`render` / `renderBlank` 的 ops）里算子必须显式给 `color`**，
> 否则报错——它不继承"当前主色"，这样才可复现。

---

## 6. 配方五：页内 API（操作已打开的页面）

**什么时候用它**：页面已经开着、你想精确控制编辑器状态，或需要验证界面行为。

全量方法表见 [`AGENT_API.md`](AGENT_API.md)（**生成物**，47 个成员）。

**最重要的一条**——无副作用一站式出图，改完不留痕：

```js
const out = await window.pixelArtStudio.renderBlank(
  {
    width: 24, height: 16, color: '#101820',
    ops: [{ op: 'rect', x0: 2, y0: 2, x1: 10, y1: 10, color: '#ff0000' }],
  },
  { longEdge: 24 },   // 参数
  2,                  // 放大倍数
)
// out: { width, height, palette, png(dataURL), pixelJSON, changes, hash }
```

返回字段固定为 `width / height / palette / png / pixelJSON / changes / hash`。

**其他常用方法**（完整表看 `AGENT_API.md`）：

| 方法 | 作用 |
|---|---|
| `await ps.whenReady()` | 等页面就绪（驱动页面前先 await 它） |
| `ps.newCanvas({width,height,color})` | 新建空白画布 |
| `await ps.importImage(urlOrFile)` | 导入图片 |
| `ps.convert()` | 用当前参数重新转换 |
| `ps.setParams({...})` / `ps.getParams()` | 读写参数 |
| `ps.applyStylePreset('sprite')` | 套风格预设 |
| `ps.edit([...ops])` | 在画布上跑算子（进撤销栈） |
| `ps.undo()` / `ps.redo()` | 撤销 / 重做 |
| `ps.exportPNG(scale)` | 导出 PNG dataURL |
| `ps.getInfo()` | 画布尺寸 / 是否已编辑等状态 |
| `ps.getUsage()` / `ps.countTransparent()` | 每色用量 / 透明格数（**用量不含透明格**） |
| `ps.describe()` / `ps.describeOps()` / `ps.describeParams()` | 自省，同 CLI 的 `--describe` |
| `ps.exportSheetMeta('godot', opts)` | 图集元数据（三引擎） |

**版本与能力**：

```js
ps.apiLevel              // 2
ps.capabilities()        // { animation: false, eyeDropper: false, decodeFormatsInNode: ['png'], … }
```

---

## 7. 常见组合与坑

### `--json` 怎么用

```bash
node tool/artc.mjs --in 素材 --out 输出 --json --progress   # 进度进 stderr，stdout 仍是纯 JSON
```

**尺寸与透明有两套字段，别读错**：

| 字段 | 含义 |
|---|---|
| `width` / `height` / `transparent` | **模型侧**（格数、alphaMask） |
| `pngWidth` / `pngHeight` / `pngTransparent` | **产物侧**（含 `--scale` 放大与 `--transparent` 键控） |

**判断产物请用 `png*` 那三个。**

### 非 PNG 输入

```bash
node tool/artc.mjs --in 照片 --out 输出 --browser-decode --json
```

借无头浏览器解码 JPEG/WebP/GIF/BMP/AVIF/ICO/SVG。**需要本机有 Chrome/Edge/Chromium**。
不加这个开关时，非 PNG 会被**跳过并在报告里说明**（不是静默忽略，也不是失败）。

### 去背景

```bash
--transparent --matte '#ffffff' --key-mode border --key-tolerance 2
```

- `--key-mode border`：**只键与四边连通的底色区域**。
  白底 + 主体内部有同色高光（眼白、金属反光）时**必须用这个**，否则高光会被挖穿成洞。
- `--key-tolerance 1..3`：AI 生图的"白底"常是 254/255 噪声，容差 0 键不掉。

### 切图集（与 `--sheet` 方向相反）

```bash
--slice auto            # 按全透明行/列自动推断
--slice 4x3             # 4 列 3 行
--slice 32x32px         # 每格 32×32 像素
```

### 其它

- **`--dry-run`**：只打印解析后的参数，不处理任何图片。不确定参数拼对没有，先跑它。
- **越界坐标静默裁剪**；宽高超 2048 会**夹紧并在 JSON 里给出实际尺寸**——别假设你给的就是你得到的。
- **单张失败不中断整批**，结尾给失败清单并以非零码退出。
- **颜色默认值**：命令行路径可省略 `color`（用默认主色 `#1a1a1a`），但**算子数组里建议显式给**，
  这样换工具或改默认色都不影响结果。

---

## 8. 能力边界（如实声明，别向用户承诺）

```js
ps.capabilities()
```

| 能力 | 状态 | 说明 |
|---|---|---|
| `animation` | **false** | 多帧动画未实现。逐帧出图后用 `--sheet` 拼图集 |
| `eyeDropper` | **false** | 屏幕吸管未实现。画布取色用 `I` 或 `Alt+点击` |
| `decodeFormatsInNode` | `['png']` | Node 端只直接解码 PNG（其余走 `--browser-decode`） |
| 单画布 | —— | 一次一张，批量由 CLI 逐张跑 |

**上限**（`--describe` 里有）：画布单边 8–2048，色板 ≤256，导出单边 ≤16384，
导出倍数 `1/2/4/6/8/10/12/16/20`，撤销栈 50 帧 / 64MB。

---

## 9. 下一步

| 我想…… | 去哪 |
|---|---|
| 精确接口契约、参数默认值 | [`AGENT_API.md`](AGENT_API.md)（生成物；改 `spec.ts` 后跑 `npm run describe`） |
| 人类用户怎么用界面 | [`使用手册.md`](使用手册.md) |
| 理解代码为什么长成这样 | [`架构.md`](架构.md)（含 8 类静默失效缺陷复盘） |
| 改本项目代码 | [`开发.md`](开发.md)（**先读铁律与验证链**） |
