# 像素画工作台（重写版）

把照片 / 插图一键转成像素画，再逐格精修，最后出**拼豆图纸**或**游戏美术资产**。
全部处理在你自己的电脑上完成，图片不上传；产物是**一个自包含 HTML**，双击即用。

```bash
npm install
npm run verify        # 类型检查 + 单测 + 构建 + 自检（四项全绿才算通过）
npm run dev           # 本地预览（也可直接双击 像素画工作台.html）
```

## 三条上手路径

**① 人用界面**

双击根目录 `像素画工作台.html`（Chrome / Edge）→ 拖入图片 → 右侧调参 → 左侧工具精修 → 顶栏导出。

**② AI agent / 脚本批量出图（不需要浏览器）**

```bash
node tool/artc.mjs --selftest                                  # 先自检（25 项，无需素材）
node tool/artc.mjs --describe                                  # 打印全部能力/算子/参数（JSON）
node tool/artc.mjs --in 素材 --out 输出 --palette beads16 --long-edge 58 --bead
node tool/artc.mjs --in 素材 --out 输出 --palette gameboy --size 32x32 --alpha --sheet 4
```

**③ 页内 API（浏览器自动化）**

```js
await page.evaluate(() => window.pixelArtStudio.describe())   // 先自省：能力 + 算子 + 参数
const r = await page.evaluate(() => window.pixelArtStudio.render(png, { longEdge: 64, paletteMode: 'preset', presetPaletteId: 'gameboy' }, 8))
```

完整接口手册：`docs/AGENT_API.md`（**由代码生成**，不会与实现漂移）。

## 两个主要用途

**拼豆图纸**：固定号色板 + 锁色板（只用你买得到的颜色）→ 出 `*_图纸.svg`（格内标号色、板标注、图例）+ `*_缺口清单.csv`（编号 / 颜色 / 格数 / 珠数 / 估算重量 / 建议袋数 / 分板）。

**游戏美术资产**：精确尺寸（16/24/32/48/64/128）+ 真 alpha + 命名模板 → 一条命令批量出图 + 图集坐标表（帧等尺寸 + `offsetX/offsetY`，引擎侧直接用）。

## 目录

```
像素画工作台.html      ← 交付物（单文件，dist/index.html 的副本，哈希一致）
src/core/              ← 纯逻辑：零 DOM、零框架、Node 可 import（管线/算子/导出/拼豆/元数据）
src/io/                ← Node 侧平台绑定（PNG 编解码、文件读取）
src/app/               ← 浏览器侧：UI、画布、页内 API、平台绑定
tool/artc.mjs          ← 批处理 CLI（agent 主入口）
tool/build.mjs         ← 单文件构建（内联 CSS + JS）
tool/describe.mjs      ← 由 src/core/spec.ts 生成 docs/AGENT_API.md
tool/e2e.mjs           ← 真浏览器端到端冒烟测试
docs/                  ← AGENT_API.md（生成）· ARCHITECTURE.md · USAGE.md
重构计划.md             ← 本次重写的设计与决策记录（含可维护性验收门）
```

## 验证链（改任何代码后都跑）

```bash
npm run typecheck     # tsc 0 错
npm test              # node:test，53 项单元测试（不需要浏览器）
npm run build         # 生成 dist/index.html 并同步根目录 HTML（哈希一致性由脚本核对）
node tool/artc.mjs --selftest   # 25 项链路自检（引擎/算子/导出/拼豆）
npm run e2e           # 13 项真浏览器端到端（UI 装配 + 绘制 + 导出，无头 Edge/Chrome）
```

`npm run verify` 会依次跑前四项。

## 已知边界（如实声明，不做半成品）

- **多帧动画未实现**：`capabilities().animation === false`。动画素材请逐帧出图后用 `--sheet` 拼图集。数据模型已预留 `frames` 字段（见 `重构计划.md` §4.7）。
- **Node 端只直接解码 PNG**（位深 8/16、颜色类型 0/2/3/4/6、非隔行）。其他格式走浏览器通道（页内 API）或先转 PNG。
- **屏幕吸管未实现**（`eyeDropper: false`）：画布取色请用取色工具 `I` 或 `Alt+点击`。
- 单画布模型：一次处理一张图。

## 许可

MIT。
