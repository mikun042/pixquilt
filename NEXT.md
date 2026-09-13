# 下一轮开发计划（交接文档）

> 给下一个接手的人 / agent。先读 §0 与 §1，再挑一项开工。
> 上一轮（2026 首轮重写）已完成：核心引擎、新 UI、agent 接口、拼豆与游戏资产导出、四道验证链。

## 0. 怎么开始

```bash
cd F:/<项目目录>
npm install
npm run verify     # typecheck + 53 单测 + 构建 + 25 自检 + 13 端到端，五项必须全绿
```

单项命令：`npm run typecheck` / `npm test` / `npm run build` / `npm run selftest` / `npm run e2e`。

**铁律**（与上一轮一致，别绕过）：
1. 改 `src/` 后必须 `npm run build`，脚本会核对 `dist/index.html` 与根目录 `像素画工作台.html` 哈希一致；
2. 五项验证全绿才算完成；
3. 改了算子/参数必须跑 `npm run describe`（重新生成 `docs/AGENT_API.md`），否则单测里的"文档新鲜度"断言会红；
4. `src/core` 里**不允许出现 `node:` 前缀**（会打断浏览器构建）；
5. 每项改动单独 git 提交，提交信息用 `feat:` / `fix:` / `refactor:` / `docs:` / `test:` 前缀。

## 1. 现状

| 项 | 状态 |
|---|---|
| 单文件产物 | `像素画工作台.html`（97.5 KB，零外部依赖，双击即用） |
| 引擎 | 裁剪 → 多级降采样 → 预处理 → 取色（Median Cut 抽样）→ OKLab 量化（F-S / Bayer 抖动）→ 杂色清理 |
| 算子 | 10 类（fill / setCells / setAll / line / rect / ellipse / transform / trim / eraseColor / replaceAny） |
| 页内 API | `window.pixelArtStudio` apiLevel 2，含自描述与 `validateParams` 预演 |
| CLI | `tool/artc.mjs`，25 项自检；PNG 直读、无需浏览器 |
| 拼豆 | 图纸 SVG + 缺口清单 CSV + 分板 + 号色（16/24 色通用近似色卡） |
| 游戏资产 | 精确尺寸 + 真 alpha + 图集坐标表（帧等尺寸 + offsetX/offsetY） |
| 测试 | 53 单测 / 25 自检 / 13 端到端 |

## 2. 待办（按建议顺序）

### A1 · `getInfo().hasEdits` 目前恒为 false（已知缺口，最小改动）
页内 API 的 `hasEdits` 由 `deps` 注入一个常量 `false`。UI 的"有编辑"标记在 store 里（`hasEdits`）。
**做法**：给 `AutomationDeps` 加 `hasEdits: () => boolean`，`index.ts` 传入 `() => store.get('hasEdits')`；
同步 `docs/AGENT_API.md`（该字段已在文档里）。**验证**：e2e 加一条"edit 后 hasEdits=true，undo 到底后 false"。

### A2 · 游戏资产多引擎元数据导出
目前只有图集坐标表（`layoutSheet` + `--sheet`）。缺 Godot `.tres`、Unity/Phaser/Tiled 通用 JSON。
**做法**：`src/core/sheetmeta.ts` 纯函数，输入帧列表输出各格式文本；CLI 加 `--engine godot|unity|tiled|plain`；
单测断言 JSON 结构与"帧矩形互不相交、不越界"。**风险**：低（纯字符串生成）。

### A3 · 自动草稿（IndexedDB）
上一轮的 plan 里有、本轮未做。当前刷新页面会丢失所有编辑（只有一个手动导出的项目 JSON）。
**做法**：`src/app/storage.ts`（IndexedDB，存 params + art + 原图 Blob，防抖 800ms），启动恢复后调 `canvasApi.setArt`；
存储不可用时降级为提示。**风险**：中（要与"新建/导入项目清空草稿"的正确顺序对齐——旧项目在这条踩过坑：
草稿 effect 先 return 后 clearTimeout 会让已清空的画布复活）。

### A4 · Node 端多格式解码
目前 Node 只直接解码 PNG，JPEG/WebP/GIF 需要先转格式。对于"AI 批量生产素材"，输入常常是 JPG/WebP。
**做法**：优先用无依赖方案（`--browser-decode` 走无头浏览器做解码前处理），而不是引入 sharp 这类重依赖。
**建议**：先做 `--browser-decode`（复用 `tool/e2e.mjs` 里的 CDP 客户端，抽成 `tool/cdp.mjs`）。

### A5 · 拼豆官方色卡导入向导
内建色卡是通用近似色。给"色卡文件 → 号色 → 图纸"一条更顺的路：导入 `.hex`（已支持 `编号 #rrggbb`）后，
在 UI 里显示号色表并允许改号、删色、按品牌保存到 localStorage。
**风险**：低。**价值**：高（拼豆用户最在意"号色对不对"）。

### B1 · 动画（用户明确说"后续再加"，别抢跑）
数据模型已预留 `PixelArt.frames`，UI/API/导出**一律未暴露**。真要做时：时间轴 UI → 帧编辑 →
`packSheet(frames)` → GIF/WebP 导出（GIF 编码需自己写或引入依赖，届时要重新评估依赖策略）。
**现在不要动**：半成品 API 一旦冻结，清理成本远大于收益。

### C1 · 性能基准脚本
`docs/ARCHITECTURE.md` 讲了性能取舍但没有可复现的基准。加 `tool/bench.mjs`：2048² 各算子耗时 + 取色耗时，
输出表格；可选与历史值对比。**风险**：低。

### C2 · UI 细节
- 窄屏（≤980px）抽屉目前只有 CSS，头部缺「色板 / 参数」开关按钮；
- 调色板缺"最近使用色"与"自定义色板编辑"（本轮只做了工作色板）；
- 取色器目前是原生 `<input type="color">`，未做计划里的色轮（§16.2 的第 5 条）。

## 3. 看起来像 bug、其实是设计（别"修"）

1. `--lock-palette` 下色板已满且需要新颜色时**报错**而不是退化——拼豆用户买不到图纸上没有的颜色。
2. `countUsage()` / `getUsage()` **不含透明格**；透明格数另有 `countTransparent()`。
3. `render()` / `renderBlank()` 的算子**必须显式给 color**（无副作用路径不继承主色，才可复现）。
4. `trim` 在全透明或已无透明边时返回 `changed: false` 且不报错（批处理里这是合法状态）。
5. 抖动开启时 `cleanup` 被强制关闭——抖动的单像素点就是杂色。
6. 越界坐标静默裁剪；画布尺寸 >2048 夹紧到 2048（返回值给出实际尺寸）。
7. 拼豆 24 色卡是"16 色 + 中间色"，不是某品牌官方色号。
8. 单张素材失败不中断整批，但结尾以非零码退出（agent 需要"读失败清单 → 修素材 → 重跑"）。

## 4. 环境与工具（本机实测）

| 项 | 值 |
|---|---|
| Node | v24.18.1（`node --test` 直接跑 `.ts`，靠类型剥离，不需要先构建测试） |
| 依赖 | 3 个 devDependencies（esbuild / typescript / @types/node），运行期 0 依赖 |
| 浏览器 | Edge `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`、Chrome `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| 无头验证 | `tool/e2e.mjs` 自写 CDP 客户端（零依赖）。注意：headless 下 **rAF 可能不产帧**，绘制调度必须 rAF + 定时器双保险 |

## 5. 本轮踩过的坑（省下你一次返工）

1. **`core` 里 import `node:zlib` 会让浏览器构建失败**——所以 PNG 编码被拆成 `src/io/node-png.ts`（Node）与
   `src/app/canvas-png.ts`（浏览器），core 只留纯编解码与栅格化。
2. **headless 下只靠 `requestAnimationFrame` 做重绘去重会让画布永远空白**（rAF 不回调，去重标志位堵死后续所有重绘）。
3. **我一度误判 `DataView.setUint32` 有 bug**——实际是我把 hex 串 `...00000005...` 读错了位；
   真正的缺陷是**我设计的 pixbin 头布局字段重叠**（offset 6 的 uint32 占 6–9，又去写 offset 8）。
   教训：字节布局要逐字段写清并加"结构断言"，只测"往返一致"抓不到字段互相覆盖。
4. **模拟测试数据要看几何是否可达**：曾断言"对称图形 rotate180 应产生改动"，实际它本就无变化——
   断言写错会伪装成产品缺陷。
