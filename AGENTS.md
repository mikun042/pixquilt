# 给 AI agent 的入口

> 项目根目录：`F:/<项目目录>`
> 本文件是**给 agent 的交接单**。人类用户看 [`README.md`](README.md)。

## 先确认你要做什么，再选入口

| 你的任务 | 怎么做 |
|---|---|
| **产出像素素材**（精灵图 / 拼豆图纸 / 图标 / 图集） | `node tool/artc.mjs --help`，或先 `node tool/quickstart.mjs` |
| **要可打印的拼豆图纸** | 拼豆命令加 `--pdf` → A4 分页、每块板一页（见 `docs/AGENT-QUICKSTART.md` 配方 2） |
| **操作界面**（Playwright / CDP 驱动已打开的页面） | 看 [`docs/AGENT-QUICKSTART.md`](docs/AGENT-QUICKSTART.md) 第五节的页内 API |
| **测试本项目**（出测试报告） | 读 [`docs/TESTING-GUIDE.md`](docs/TESTING-GUIDE.md) |
| **改本项目代码** | 读 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)（先看「铁律」与「验证链」两节） |
| **改取色器外观** | 读 [`docs/UI-COLOR-PICKER.md`](docs/UI-COLOR-PICKER.md) |

## 环境：**不需要 `npm install`**

`src/` 零第三方依赖。下面这些**开箱即用**：

```bash
node tool/artc.mjs --selftest     # 32 项链路自检，不需要素材、不需要装依赖
node tool/artc.mjs --describe     # 打印全部能力/算子/参数（JSON，冷启动先读这个）
node tool/quickstart.mjs          # 全链路跑一遍并产出真实文件
node tool/artc.mjs --in 素材目录 --out 输出 ...   # 直接批量出图
```

只有 `npm run build`（esbuild）与 `npm run typecheck`（tsc）需要先 `npm install`；
`npm run e2e*` 另外需要本机 Edge 或 Chrome。**纯出图不需要其中任何一项。**

## 三条最容易踩的坑

1. **`--size` 不是 `--exact`**。未知参数会**报错**（不会静默忽略），报错信息会指出正确写法。
   不要把"命令成功退出"当成"参数生效了"。
2. **`--json` 的 stdout 是纯 JSON**，可直接 parse。要同时看进度加 `--progress`（它写 stderr）。
   此外 `--json` 之外的模式会在 stdout 混进度行。
3. **做像素素材要显式防损**：默认参数面向"照片转像素"，对已画好的像素图是有损的。
   用 `--style sprite`（最近邻 + 不做杂色清理 + 保留透明），或手写
   `--downsample nearest --no-cleanup --palette-k 64`。见
   [`docs/AGENT-QUICKSTART.md`](docs/AGENT-QUICKSTART.md) 第四节「做无损像素素材」。

## 契约以这两个为准，别猜

```bash
node tool/artc.mjs --describe      # 机器可读：能力 / 算子 / 参数 / 预置色卡
```

- [`docs/AGENT_API.md`](docs/AGENT_API.md) —— 完整接口手册，**由 `src/core/spec.ts` 生成**，
  有测试保证不与实现漂移。手改它没用，改的是 `spec.ts`。
- 别依赖本文档里的示例数字（格数、体积、测试项数都可能变），以命令输出为准。

## 项目结构（够用就行）

```
像素画工作台.html     交付物：单文件、双击即用、不联网（改代码后由 npm run build 重新生成）
src/core/            纯逻辑，零 DOM、零 node: 依赖，Node 可直接 import
src/io/              Node 侧平台绑定（PNG 编解码、文件读取）
src/app/             浏览器侧：UI、画布、页内 API
tool/artc.mjs        批处理 CLI（你的主入口）
docs/                现行文档；docs/history/ 是历史归档（不维护，数字已过期）
```

改代码前必读 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) 的「铁律」：
尤其 **`src/core` 里不允许出现 `node:` 或 `document.`/`window.`**——会让浏览器构建失败。
新增能力优先落进 `core`，四个入口（页内 API / CLI / Node 直调 / 自描述）就自动都有。
