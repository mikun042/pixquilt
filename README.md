# 像素画工作台

把照片 / 插图转成像素画，逐格精修，最后导出**拼豆图纸**或**游戏美术资产**。

- **产物是一个自包含 HTML**：双击即用，零外部依赖，不联网。
- **图片不上传**：转换、编辑、导出全部在你自己的浏览器里完成。
- **AI agent 可以不打开浏览器直接批量出图**：命令行（CLI）+ 页内 API 两条路。
- **刷新不丢编辑**：自动草稿兜底，重开时问你要不要恢复。

运行期 **0 依赖**；只有 3 个构建期依赖（esbuild / typescript / @types/node）。

---

## 给人类：三步开始用

### 1. 拿到这个 HTML

**方式一（推荐，什么都不用装）**：直接双击仓库根目录的 `像素画工作台.html`，
用 Chrome / Edge 打开即可。这个文件已经构建好并提交进仓库了。

**方式二（自己构建）**：改过代码、或想确认产物是自己机器上构建的：

```bash
npm install
npm run build        # 生成 / 刷新 像素画工作台.html
```

### 2. 上手三步

> **拖入图片 → 右侧调参数 → 顶栏「导出 ▾」**

画布中间那行「✚ 新建空白画布」可以不导入任何图片，直接从空白开始画。

### 3. 想做什么，看哪里

| 我想…… | 看 |
|---|---|
| 搞清界面每个按钮、每个参数的用处 | **[docs/使用手册.md](docs/使用手册.md)** |
| 做拼豆图纸（要买哪些珠子、每种几颗） | [docs/使用手册.md](docs/使用手册.md) 的「拼豆图纸」一节 |
| 做游戏精灵图 / 图集 | [docs/使用手册.md](docs/使用手册.md) 的「游戏资产」一节 |
| 知道哪些功能**还没做** | 本文下方「已知边界」 |

**最常用的一条路**（照片转拼豆图纸）：

1. 拖入照片 → 2. 右侧「预设」选**拼豆图纸** → 3. 调「长边格数」（决定成品多大、
   要买多少珠子）→ 4. 右下角点「重新转换」→ 5. 顶栏「导出 ▾ → 拼豆 → 图纸 SVG + 缺口清单 CSV」。

---

## 给 AI agent：交给它就能跑

> 把仓库地址交给 agent 即可。**先读 [`AGENTS.md`](AGENTS.md)** —— 那是给 agent 的交接单
> （任务→入口的路由表、环境要求、最容易踩的坑）。上来就要动手的 agent 读它。

**好消息：纯出图不需要 `npm install`。** `src/` 零第三方依赖，下面这些开箱即用：

```bash
node tool/quickstart.mjs         # 一条命令跑通全链路（自省 → 造素材 → 批量 → 拼豆 → 页内 API）
node tool/artc.mjs --selftest    # 42 项链路自检，不需要素材、不需要装依赖
node tool/artc.mjs --describe    # 打印全部能力 / 算子 / 参数（JSON，冷启动先读这个）
```

只有 `npm run build`（esbuild）和 `npm run typecheck`（tsc）需要先 `npm install`；
`npm run e2e*` 另外需要本机有 Chrome / Edge / Chromium。

**三条最常用的命令**：

```bash
# 1) 拼豆图纸：固定号色板 + 只用买得到的颜色 → 图纸 SVG + 缺口清单 CSV
node tool/artc.mjs --in 素材/ --out 输出/ --preset beads16 --long-edge 58 --bead --json

# 2) 游戏素材：精确尺寸 + 真 alpha + 图集坐标表（无损）
node tool/artc.mjs --in 精灵.png --size 64x64 --style sprite --out 输出/ --json

# 3) 纯程序化出图：不读任何素材，用算子画
node tool/artc.mjs --blank 32x32 --blank-transparent --ops @ops.json --out 输出/ --json
```

> **agent 必读两条**：
> ① `--json` 的 stdout 是**纯 JSON**，可直接 parse（要同时看进度加 `--progress`，它写 stderr）；
> ② **未知参数会报错**，不会静默忽略 —— 报告里会指出正确写法。别把"命令成功"当成"参数生效"。

完整的 agent 上手文档（含无损配方、页内 API、能力边界）：
**[docs/agent-上手.md](docs/agent-上手.md)** ·
精确接口契约：**[docs/AGENT_API.md](docs/AGENT_API.md)**（**生成物**，`npm run describe`）。

---

## 输出长什么样

**拼豆图纸**：`*_图纸.svg`（格内标号色、分板标注、图例）+ `*_缺口清单.csv`
（编号 / 颜色 / 格数 / 珠数 / 估算重量 / 建议袋数）。

要**打印**就在导出菜单里选「可打印图纸 PDF」（A4、自适应缩放，常规尺寸落在一页），
或 CLI 加 `--pdf`。

```
编号,颜色,格数,珠数,估算重量(g),建议袋数
B01,#FFFFFF,1571,1571,125.68,4
B05,#4A4A4A,442,442,35.36,1
合计,10 色,3364,3364,269.12,13
```

**游戏资产**：精确尺寸（16/24/32/48/64/128）+ 真 alpha + 命名模板，
配套 `_sheet.json` 图集坐标表（帧等尺寸 + `offsetX/offsetY`），
还能再导出 Godot / Unity / Tiled 直接能吃的元数据（CLI `--engine`）。

---

## 目录

```
像素画工作台.html        ← 交付物（单文件，dist/index.html 的副本，构建时核对哈希一致）
src/core/                ← 纯逻辑：零 DOM、零 node: 依赖，Node 可直接 import
   spec.ts               ←   算子/参数/上限元数据的【单一真源】，驱动文档生成与一致性断言
   limits.ts             ←   全部魔法数字集中在此
   pipeline.ts           ←   像素化管线（像素化 / 量化 / 抖动 / 清理的固定顺序）
   ops.ts rasterize.ts   ←   13 类编辑算子 / 几何栅格化
   quality.ts auto-tune.ts ←  图纸质量度量 / 在色号数约束下自动搜参
   palette-edit.ts       ←   色板条目编辑与合并的去重、下标重映射（纯函数）
   palettes.ts           ←   预置色卡（主机色表）
   palettes-beads.ts     ←   13 张品牌拼豆色卡（社区整理数据，逐卡声明来源）
   export.ts bead.ts     ←   序列化、拼豆图纸与缺口清单
   sheetmeta.ts          ←   图集元数据 → Godot / Unity / Tiled 三引擎格式（纯函数）
src/io/                  ← Node 侧平台绑定（PNG 编解码、文件 IO、浏览器通道解码）
src/app/                 ← 浏览器侧：UI、画布、页内 API、导出动作、撤销栈、自动草稿
   ui/                   ←   参数面板、取色器、色板编辑器、数值滑条、右键菜单、帮助弹窗
tool/artc.mjs            ← 批处理 CLI（agent 主入口）
tool/selftest.mjs        ← 链路自检（从 artc.mjs 拆出）
tool/quickstart.mjs      ← Agent 快速上手（一条命令跑通全链路）
tool/bead-palettes.mjs   ← 由社区数据生成品牌色卡的脚本
tool/build.mjs           ← 单文件构建（内联 CSS + JS，核对产物哈希）
tool/describe.mjs        ← 由 core/spec.ts 生成 docs/AGENT_API.md
tool/cdp.mjs             ← 零依赖 CDP 客户端（e2e / 截图 / 探针共用这一份）
tool/e2e*.mjs            ← 无头浏览器验证
tool/icons/              ← UI 图标管线（见其 README）
docs/                    ← 见下方「文档导航」
```

## 文档导航

| 文档 | 给谁看 |
|---|---|
| **[docs/使用手册.md](docs/使用手册.md)** | 人类用户：界面怎么用、两种用途、常见问题 |
| **[docs/agent-上手.md](docs/agent-上手.md)** | AI agent：CLI 与页内 API 上手、无损配方、能力边界 |
| **[docs/AGENT_API.md](docs/AGENT_API.md)** | 接口契约（**生成物**，改 `spec.ts` 后跑 `npm run describe`） |
| [AGENTS.md](AGENTS.md) | AI agent 的交接单：任务→入口路由、环境、易踩的坑 |
| [docs/架构.md](docs/架构.md) | 维护者：分层、数据模型、关键决策、缺陷复盘 |
| [docs/开发.md](docs/开发.md) | 贡献者：铁律、验证链、结构规则、踩过的坑、路线图 |
| [tool/icons/README.md](tool/icons/README.md) | 改工具条/顶栏图标：坐标契约、预览工具、四条硬规则 |

---

## 验证链

改完代码，一次跑完全部；**全绿才算通过**：

```bash
npm run verify
```

| 步骤 | 内容 | 需要浏览器 |
|---|---|---|
| `typecheck` | `tsc --noEmit` | 否 |
| `test` | 181 项单元测试 | 否 |
| `build` | 单文件产物 + 核对两份 HTML 哈希一致 | 否 |
| `selftest` | 50 项链路自检（不需要素材） | 否 |
| `e2e` | 36 项端到端 | **是** |
| `e2e:picker` / `e2e:slider` | 取色器 18 项 / 滑条 12 项 | **是** |
| `e2e:palette` | 色板编辑 14 项（右键微调 / 替换 / Esc 放弃） | **是** |
| `e2e:regressions` | 35 项已修缺陷的回归防线 | **是** |
| `e2e:pdf` | 10 项：PDF 在真实浏览器里的压缩格式 + 吸管图标几何 | **是** |

> 数字会过期，**以命令输出为准**。需要浏览器的那几步会自己找 Chrome / Edge / Chromium
> （Windows / macOS / Linux 的常见位置，再查 `PATH`）；装在别处时用 `--browser <路径>`
> 或环境变量 `PIXEL_BROWSER=<路径>` 指定。
> 性能基准 `npm run bench` 只把**比值**当断言，绝对耗时随机器浮动、不作验收标准，也不在 verify 里。

---

## 已知边界（如实声明，不做半成品）

- **多帧动画未实现**（`capabilities().animation === false`）。逐帧出图后用 `--sheet` 拼图集。
- **Node 端只直接解码 PNG**。JPEG/WebP/GIF/BMP/AVIF/ICO/SVG 有三条出路：
  CLI 加 `--browser-decode`（借无头浏览器原生解码器批量转 PNG，**需本机有浏览器**）、
  走页内 API 的浏览器通道、或先用图像工具转成 PNG。
- **屏幕吸管未实现**（`eyeDropper: false`）。画布取色用取色工具 `I` 或 `Alt+点击`。
- **单画布模型**：一次处理一张图（批量由 CLI 逐张跑）。
- **`--auto-tune` 不会自动挑尺寸**：它只在你指定的尺寸下搜抖动/清理，尺寸由 `--long-edge` 决定。
  这是刻意的——跨尺寸没有可靠判据，两个候选指标（块平均误差、色号数）**都随画布变小而变小**，
  拿它们排序会一致地选出最糊的方案。宁可老实不选，也不假装"观感最优"（见 [docs/架构.md](docs/架构.md) §8.17）。
- **内建色卡分三类来源**（`source`）：
  - `official` —— 主机硬件色表（PICO-8 / GameBoy / NES / CGA），权威；
  - `community` —— **社区整理**的品牌拼豆色卡（Hama / Perler / Artkal / Nabbi / Yant 等，来自
    [beadcolors](https://github.com/maxcleme/beadcolors) 的 MIT 数据）。
    **有据可查，但与实物可能有偏差，以实物为准**；
  - `approximate` —— 自造的通用近似色（`beads16` / `beads24`）。

  要严格对应手上的号色，请导入自己的 `.hex`。
  - **Mard（290 色）与 Diamond Dotz（461 色）未收录**：色板数组上限是 256
    （索引存成 `Uint8Array`，超限会让颜色回绕出错误结果），这两张卡超了。
    要用它们走 `--palette 我的色卡.hex`（支持带号色）；要内置则需先把索引位宽迁到
    `Uint16Array` —— 那会牵动 pixbin 字节布局等多处，属独立一轮的结构性改动。
- **自动草稿只保"最近一次"**（刷新后弹「恢复 / 放弃」提示条）：它防手滑，不是归档；
  很大的原图可能因浏览器配额存不进去（此时画布照常恢复，只是不能重新转换）。
  要长期保存请导出项目 JSON。

其余"还没做但值得做"的项见 [docs/开发.md](docs/开发.md) 的路线图。

## 许可

MIT，全文见 [LICENSE](LICENSE)。
