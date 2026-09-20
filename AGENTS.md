# 给 AI agent 的入口

> 本文件是**给 agent 的交接单**，目标是：把仓库地址给你之后，你不问任何问题就能开始干活。
> 人类用户看 [`README.md`](README.md)。

---

## 1. 三十秒认识这个项目

**像素画工作台**：图片 → 像素画 → 拼豆图纸 / 游戏美术资产。

对你（agent）来说最重要的是三件事：

1. **有一个 CLI，不需要浏览器、不需要 `npm install` 就能批量出图** —— 这是你的主入口。
2. **有一个页内 API**（`window.pixelArtStudio`），能在已打开的页面上精确控制编辑器。
3. **两者参数与算子完全一致**，所以"页内调好 → 交给 CLI 批量跑"是安全的。

---

## 2. 先跑这一条确认环境（10 秒）

```bash
node tool/artc.mjs --selftest
```

预期最后一行是 `自检：N/N 通过`（N = 当前项数，会随版本增长），且**没有任何 `✘`**。
**不需要 `npm install`、不需要素材、不需要浏览器。**

不确定有哪些能力时，读这个（机器可读的 JSON，冷启动第一件事）：

```bash
node tool/artc.mjs --describe
```

想一次看到完整链路真的跑起来（会产出真实文件）：

```bash
node tool/quickstart.mjs        # 产出落在 .quickstart/，看完可以直接删
```

---

## 3. 环境要求：**纯出图什么都不用装**

| 你要做的事 | 需要什么 |
|---|---|
| **出图**（CLI 批量、算子作画） | **只要 Node ≥ 22.6。仅此而已。** |
| 读 `src/core/` 里的纯逻辑并 import | 同上（`src/` 零第三方依赖） |
| `npm run build` / `npm run typecheck` | 先 `npm install`（3 个 devDependencies） |
| `npm run e2e*`（端到端验证） | 本机有 Chrome / Edge / Chromium |

浏览器会自动在三个平台的常见位置找，再查 `PATH`；装在别处传 `--browser <路径>`
或设环境变量 `PIXEL_BROWSER=<路径>`。

**所以：如果任务只是"把这批图转成像素画"，不要 `npm install`，直接跑 CLI。**

---

## 4. 按任务选入口

| 你的任务 | 怎么做 |
|---|---|
| **产出像素素材**（精灵图 / 拼豆图纸 / 图标 / 图集） | `node tool/artc.mjs --help`，或先 `node tool/quickstart.mjs` |
| **要可打印的拼豆图纸** | 加 `--bead --pdf` → A4 分页、每块板一页 |
| **想用真实品牌色号** | `--palette hama_midi` / `perler` / `artkal_c` …（13 张品牌卡，见 `--describe` 的 `presets[].source`）。这些是**社区整理**数据，**与实物可能有偏差，以实物为准** |
| **想知道"图纸好不好" / 让工具自己找参数** | `--quality` 出质量报告（保真误差 / 色号数 / 珠子数 / 抖动代价）；`--auto-tune <n>` 在"色号数 ≤ n"约束下自动搜参，**只搜抖动/清理，不改尺寸**（尺寸由 `--long-edge` 定）。**判断抖动要看块平均误差，不是逐格误差**（见 `docs/架构.md` §8.15） |
| **要判断参数到底生效没有** | `--json` 里 `params` 是**你要的值**、`paramsEffective` 是**实际用的值**（逐图另看 `results[].paramsEffective`）；调参决策在 `autoTune` 字段。两者不一致就说明有东西没生效 |
| **输入是 JPG / WebP / GIF / BMP / AVIF / ICO / SVG** | 加 `--browser-decode`（借无头浏览器解码成 PNG；**需本机有浏览器**）。不加会被**跳过并如实报告**，不会静默忽略 |
| **图集元数据要喂给引擎** | `--sheet --engine godot\|unity\|tiled`（Unity 需 `--texture-guid`）。页内 API 是 `ps.exportSheetMeta()` |
| **自己的拼豆色卡要印上图纸** | 导入 `编号 #rrggbb` 两列的 `.hex`，号色会进参数并出现在图纸/清单/PDF 上 |
| **操作已打开的页面**（Playwright / CDP 驱动） | 看 [`docs/agent-上手.md`](docs/agent-上手.md) 的页内 API 一节 |
| **理解代码为什么长成这样** | [`docs/架构.md`](docs/架构.md)（§8 共 19 节缺陷复盘，都是静默失效类） |
| **改本项目代码** | [`docs/开发.md`](docs/开发.md)（**先读「铁律」与「验证链」两节**） |
| **改工具条/顶栏图标** | [`tool/icons/README.md`](tool/icons/README.md)（改形状定义 → `npm run icons:sync`；**不要手改 `icons.ts` 的 path 数据**） |
| **怀疑性能变慢** | `npm run bench`（`--quick` 更快）。**只信它报的比值**，绝对耗时随机器浮动 |

---

## 5. 五条最容易踩的坑

1. **`--size` 不是 `--exact`。**
   未知参数**会报错**（不会静默忽略），报错信息会指出正确写法。
   不要把"命令成功退出"当成"参数生效了"。`--dry-run` 可以只打印解析后的参数、不处理图片。

2. **`--json` 的 stdout 是纯 JSON**，可直接 parse。
   要同时看进度就加 `--progress`（进度写 stderr）。不加 `--json` 时 stdout 会混进度行。

3. **`--browser-decode` 是"另一条通道"，不是"Node 现在支持所有格式了"。**
   `capabilities().decodeFormatsInNode` 仍然只列 `png` —— 按它判断"Node 能不能直接解"是对的；
   按 `--browser-decode` 判断"要不要起浏览器"也是对的。两件事别混为一谈。

4. **做像素素材要显式防损。** 默认参数面向"照片转像素"，对已画好的像素图**是有损的**。
   用 `--style sprite`（最近邻 + 不清理杂色 + 保留透明），或手写
   `--downsample nearest --no-cleanup --palette-k 64`。详见
   [`docs/agent-上手.md`](docs/agent-上手.md) 的「做无损像素素材」。

5. **尺寸与透明有两套字段，别读错。**
   `--json` 里 `width/height/transparent` 是**模型侧**（格数、alphaMask）；
   `pngWidth/pngHeight/pngTransparent` 是**产物侧**（含 `--scale` 放大与 `--transparent` 键控）。
   **判断产物请用 `png*` 那三个。**

---

## 6. 契约以这两个为准，别猜

```bash
node tool/artc.mjs --describe      # 机器可读：能力 / 算子 / 参数 / 预置色卡 / 上限
```

- [`docs/AGENT_API.md`](docs/AGENT_API.md) —— 完整接口手册，**由 `src/core/spec.ts` 生成**
  （`npm run describe`）。**手改它没用**，改的是 `spec.ts`；改完元数据记得重跑生成。
  > 两道机器防线（都在 `npm test` 里跑，所以 `npm run verify` 会替你拦住）：
  > ① 算子 / 参数 / 色卡 / 上限是自动投影的，**CLI 参数表在生成时与 `KNOWN_FLAGS` 对账**（不一致直接报错）；
  > ② `src/test/describe-freshness.test.ts` 把生成结果与仓库里的文件**逐字节比对**。
- **别依赖文档里的示例数字**（格数、体积、测试项数都会变），以命令输出为准。

---

## 7. 项目结构（够用就行）

```
像素画工作台.html     交付物：单文件、双击即用、不联网（改代码后由 npm run build 重新生成）
src/core/            纯逻辑，零 DOM、零 node: 依赖，Node 可直接 import
src/io/              Node 侧平台绑定（PNG 编解码、文件读取）
src/app/             浏览器侧：UI、画布、页内 API
tool/artc.mjs        批处理 CLI（你的主入口）
tool/icons/          UI 图标管线（形状定义 → src/app/ui/icons.ts 的 path 表；见其 README）
docs/                现行文档
```

**改代码前必读** [`docs/开发.md`](docs/开发.md) 的「铁律」，
尤其 **`src/core` 里不允许出现 `node:` 或 `document.`/`window.`** —— 会让浏览器构建失败
（有静态断言在扫，`src/test/core-layering.test.ts`）。

**新增能力优先落进 `core`**，四个入口（页内 API / CLI / Node 直调 / 自描述）就自动都有。

---

## 8. 已知边界（不要为这些写代码，也不要向用户承诺）

- **多帧动画未实现**（`capabilities().animation === false`）。逐帧出图后用 `--sheet` 拼图集。
- **屏幕吸管未实现**（`eyeDropper: false`）。
- **Node 端只直接解码 PNG**（其余格式见第 4 节的 `--browser-decode`）。
- **单画布模型**：一次一张，批量由 CLI 逐张跑。
- **拼豆内建色卡分三类来源**（`--describe` 的 `presets[].source`）：`official` 主机硬件色表
  （PICO-8 / GameBoy / NES / CGA，权威）；`community` **社区整理**的 13 张品牌色卡
  （Hama / Perler / Artkal / Nabbi / Yant 等，**色值有据可查但与实物可能有偏差，以实物为准**）；
  `approximate` 自造的通用近似色（`beads16` / `beads24`，不属任何品牌）。
  **这 13 张品牌卡不是厂商官方色号**——界面与文档都必须这么写；要严格对应手上的号色请导入自己的 `.hex`。

这些是**用户明确的"后续再加"**，不要顺手实现。
