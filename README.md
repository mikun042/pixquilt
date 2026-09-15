# 像素画工作台

把照片 / 插图一键转成像素画，再逐格精修，最后出**拼豆图纸**或**游戏美术资产**。

- **全部在本机完成**，图片不上传。
- **产物是一个自包含 HTML**，双击即用，零外部依赖。
- **AI agent 可以不打开浏览器直接批量出图**（CLI + 页内 API 两条路）。
- 运行期 **0 依赖**；只有 3 个构建期 devDependencies。

---

## 我要用（人类）

```bash
npm install
npm run build       # 生成 像素画工作台.html
```

然后**双击根目录的 `像素画工作台.html`**（Chrome / Edge 均可），
或 `npm run dev` 起本地预览。

上手三步：**拖入图片 → 右侧调参数 → 顶栏「导出 ▾」**。

- 完整操作说明：**[docs/USAGE.md](docs/USAGE.md)**（顶栏、参数、工具与快捷键、两种用途、常见问题）
- 想直接空手画：画布中间的「✚ 新建空白画布」，或顶栏「✚ 新建」

## 我是 AI agent（不打开浏览器）

> 直接把项目地址交给 agent 就行——`README.md` 与 [`AGENTS.md`](AGENTS.md) 都在根目录，
> 后者是**给 agent 的交接单**（入口选择、环境要求、三条最容易踩的坑）。
> **`src/` 零第三方依赖**：`artc.mjs` 与 `quickstart.mjs` 不需要 `npm install` 就能跑。

```bash
node tool/quickstart.mjs      # 一条命令跑通：自省 → 造素材 → 批量 → 拼豆 → 页内 API
```

这个脚本会**真的产出文件**并打印每一步的结果，同时告诉你下一步该读哪份文档。
产出全部落在 `.quickstart/`（已在 `.gitignore` 里），看完可以直接删；要换位置用 `--out 目录`。

之后按需查：

| 我想…… | 看这里 |
|---|---|
| 知道有哪些参数/算子、怎么调 | **[docs/AGENT-QUICKSTART.md](docs/AGENT-QUICKSTART.md)** |
| 要精确的接口契约 | **[docs/AGENT_API.md](docs/AGENT_API.md)**（**生成物**：`npm run describe`，改了 `src/core/spec.ts` 要重跑） |
| 让工具自己说 | `node tool/artc.mjs --describe`（JSON） / `--help` |

最常用的三条命令：

```bash
# 拼豆图纸：固定号色板 + 只买得到的颜色 → 图纸 SVG + 缺口清单 CSV
node tool/artc.mjs --in 素材/ --out 输出/ --palette beads16 --long-edge 58 --bead --json

# 游戏素材：精确尺寸 + 真 alpha + 图集坐标表（无损）
node tool/artc.mjs --in 精灵.png --size 64x64 --style sprite --out 输出/ --json

# 纯程序化出图：不读任何素材，用算子画
node tool/artc.mjs --blank 32x32 --blank-transparent --ops '@ops.json' --out 输出/ --json
```

> **agent 必读的两条**：①`--json` 的 stdout 是**纯 JSON**，可直接 parse（进度要加 `--progress`，写 stderr）；
> ②**未知参数会报错**，不会静默忽略——报告里会指出正确写法。别把"命令成功"当成"参数生效"。

---

## 输出示例

**拼豆图纸**：`*_图纸.svg`（格内标号色、板标注、图例）+ `*_缺口清单.csv`
（编号 / 颜色 / 格数 / 珠数 / 估算重量 / 建议袋数 / 分板）

要**打印**就加 `--pdf`（界面里是「导出 ▾ → 拼豆 → 可打印图纸 PDF」）：
A4、自适应缩放，常规尺寸落在一页，含格内号色与图例。

```
编号,颜色,格数,珠数,估算重量(g),建议袋数
B01,#FFFFFF,1571,1571,125.68,4
B05,#4A4A4A,442,442,35.36,1
合计,10 色,3364,3364,269.12,13
```

**游戏资产**：精确尺寸（16/24/32/48/64/128）+ 真 alpha + 命名模板，
配套 `_sheet.json` 图集坐标表（帧等尺寸 + `offsetX/offsetY`，引擎侧可直接用）。

---

## 目录

```
像素画工作台.html        ← 交付物（单文件，dist/index.html 的副本，脚本核对哈希一致）
src/core/                ← 纯逻辑：零 DOM、零 node: 依赖，Node 可直接 import
   spec.ts               ←   算子/参数元数据的【单一真源】，驱动文档生成与一致性断言
   limits.ts             ←   全部魔法数字集中在此
   pipeline.ts           ←   像素化管线
   ops.ts rasterize.ts   ←   12 类编辑算子 / 几何栅格化（+ canvas-query、ops-shapes）
   export.ts bead.ts     ←   序列化、拼豆图纸与缺口清单
src/io/                  ← Node 侧平台绑定（PNG 编解码、文件 IO）
src/app/                 ← 浏览器侧：UI、画布、页内 API（automation.ts）、预设（presets.ts）、
                            导出动作（export-actions.ts）、撤销栈（history.ts）
tool/artc.mjs            ← 批处理 CLI（agent 主入口）
tool/quickstart.mjs      ← Agent 快速上手（一条命令跑通全链路）
tool/build.mjs           ← 单文件构建（内联 CSS + JS，核对产物哈希）
tool/describe.mjs        ← 由 core/spec.ts 生成 docs/AGENT_API.md
tool/cdp.mjs             ← 零依赖 CDP 客户端 + 启动/断言样板（e2e/截图/探针共用这一份）
tool/e2e*.mjs            ← 无头浏览器验证（全都建在 tool/cdp.mjs 上）
docs/                    ← 见下方「文档导航」
```

## 文档导航

| 文档 | 给谁看 |
|---|---|
| **[docs/USAGE.md](docs/USAGE.md)** | 人类用户：界面怎么用、两种用途、常见问题 |
| **[docs/AGENT-QUICKSTART.md](docs/AGENT-QUICKSTART.md)** | AI agent：CLI 与页内 API 上手、无损配方、能力边界 |
| **[docs/AGENT_API.md](docs/AGENT_API.md)** | 接口契约（**生成物**，`npm run describe`） |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 贡献者：铁律、验证链、结构规则、踩过的坑、路线图 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 维护者：分层、数据模型、关键决策、缺陷复盘 |
| [docs/TESTING-GUIDE.md](docs/TESTING-GUIDE.md) | 外部测试 agent：测试清单与报告格式 |
| [docs/UI-COLOR-PICKER.md](docs/UI-COLOR-PICKER.md) | 做取色器视觉改造的模型 |
| [docs/history/](docs/history/) | 想追溯决策与修复过程的人（**归档，不维护**） |

---

## 验证链

```bash
npm run verify     # 一次跑完全部，全绿才算通过
```

| 步骤 | 内容 | 需要浏览器 |
|---|---|---|
| `typecheck` | `tsc --noEmit` | 否 |
| `test` | 106 项单元测试 | 否 |
| `build` | 单文件产物 + 核对两份 HTML 哈希一致 | 否 |
| `selftest` | 40 项链路自检（不需要素材） | 否 |
| `e2e` | 36 项端到端 | **是** |
| `e2e:picker` / `e2e:slider` | 取色器 17 项 / 滑条 12 项 | **是** |
| `e2e:regressions` | 25 项已修缺陷的回归防线 | **是** |
| `e2e:pdf` | 10 项：PDF 在真实浏览器里的压缩格式 + 吸管图标几何 | **是** |

> 数字会过期，以命令输出为准。改 UI 外观另有两个工具：
> `npm run shoot`（截图）、`npm run ref:analyze -- <png>`（截图结构分析）。
>
> 需要浏览器的那几步会自己找 Chrome / Edge / Chromium（Windows / macOS / Linux 的常见位置，
> 再查 `PATH`）；装在别处时用 `--browser <路径>` 或环境变量 `PIXEL_BROWSER=<路径>` 指定。

---

## 已知边界（如实声明，不做半成品）

- **多帧动画未实现**（`capabilities().animation === false`）。逐帧出图后用 `--sheet` 拼图集。
- **Node 端只直接解码 PNG**。JPEG/WebP/GIF/BMP/AVIF/ICO/SVG 请走浏览器通道（页内 API），或先转 PNG。
- **屏幕吸管未实现**（`eyeDropper: false`）。画布取色用取色工具 `I` 或 `Alt+点击`。
- **单画布模型**：一次处理一张图（批量由 CLI 逐张跑）。
- **拼豆内建色卡是通用近似色**，不是任何品牌官方色号；要严格对应请导入自己的 `.hex`。

其余"还没做但值得做"的项见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) §8 路线图。

## 许可

MIT。
