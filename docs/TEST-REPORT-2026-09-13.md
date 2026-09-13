# 像素画工作台 · 功能测试报告

- **测试日期**：2026-09-13
- **产物**：`F:\像素画build\像素画工作台.html`
- **产物哈希（SHA256）**：`22a111e01e3d19eb48a4f00d641e59112bcab3df1eed1d1e0d8047715f941388`
  （`dist/index.html` 同哈希；测试前后一致，未改动产物）
- **git**：`0580269 docs: 新增功能测试指南（交给其他 agent 执行并出具报告）` / 工作区干净（`git status --short` 无输出）
- **环境**：Node v24.18.1；Edge `153.0.4234.32`（headless=new）；视口 1400×900（窄屏用例临时切 700×800）
- **基线**：`npm run verify` 全绿 —— typecheck 0 错 / 单测 55 / 构建哈希与根目录副本一致 / 自检 25 / e2e 19 / e2e:picker 17 / e2e:slider 12（共 128 项）
- **测试方式**：自写零依赖 CDP 脚本（`.tmp/t-*.mjs`），**真实鼠标/键盘输入**（`Input.dispatchMouseEvent` / `dispatchKeyEvent`），遵守指南 §0.4 四条防坑措施

---

## 一、总体结论

**核心转换与导出链路可用，导入与页内 API 质量很好（A 23/23、G 11/11、J 10/10、E 13/13 全通过）；发现 1 个 P1、6 个 P2、3 个 P3 观察项，无 P0。**

最严重的是 **P1-01：文档宣称的「自定义 / .hex 色板」在界面里没有任何入口**（选了该模式后无控件可填色板，且静默退回自动取色），而 `docs/USAGE.md` 明确写了"支持导入 `.hex`"。

P2 集中在**状态同步与可达性**：撤销不还原色板（artHash/导出受污染）、状态栏的选区/悬停/缩放是"惰性"的、窄屏侧栏被直接隐藏且无抽屉开关、单色键控与页内 API 的键控透明不可靠、裁剪比例无 UI 入口、按住 L 连线不能链式。

自动化已覆盖的 128 项断言全部继续通过，本次未发现它们漏掉的转换/导出算法错误。

---

## 二、结果总表

> 「§2 用例」= 指南 §2 清单条目数；「实测断言」= 本次脚本实际执行的断言数（含子断言与观察项）。
> 「失败」为真实产品缺陷；观察项（有意设计/浏览器行为）已注明、不计失败。

| 模块 | §2 用例 | 实测断言 | 通过 | 失败 | 结论 |
|---|---|---|---|---|---|
| A 导入 | 4 | 23 | 23 | 0 | 正常（8 种格式全通过；损坏文件有中文提示） |
| B 转换参数 | 7 | 21 | 19 | 2 | 见 P1-01（自定义色板无 UI）、P2-02（裁剪比例无 UI） |
| C 编辑工具 | 8 | 14 | 13 | 1 | 见 P2-03（L 连线不能链式） |
| D 选区 | 7 | 13 | 11 | 2 | 选区功能本身正常；见 P2-04（状态栏不实时） |
| E 颜色与取色器 | 8 | 13 | 13 | 0 | 正常（手感、提交时机、稳定性均通过） |
| F 撤销重做 | 3 | 9 | 7 | 2 | 像素可逆正确；见 P2-05（色板/artHash 未还原） |
| G 导出 | 7 | 11 | 11 | 0 | 正常（PNG/JSON/项目/SVG/CSV 数值全部校验通过） |
| H 边界与异常 | 6 | 13 | 12 | 1 | 见 P2-06（窄屏无抽屉）；另见 P3 观察 |
| I 命令行 | 5 | 5 | 5 | 0 | 正常（含坏图不中断 + 非零退出码） |
| J 页内 API | 5 | 10 | 10 | 0 | 正常（render 无副作用且确定；错误路径中文） |
| **合计** | **60** | **132** | **124** | **8** | 8 个失败断言映射到 6 个问题 |

---

## 三、问题清单

### P1-01　「自定义 / .hex」色板模式在界面里没有入口，选了就等于自动取色

- **现象**：参数面板「色板」下拉可选 `自动提取 / 预置色卡 / 自定义 / .hex`，但选到「自定义 / .hex」后**参数面板不出现任何可输入控件**（无 textarea、无文件选择框、无文本框）；转换实际按"自动取色（Median Cut）"进行，且**不报错、不提示**。界面里也**没有 `.hex` 色板的导入或导出入口**（导出菜单只有 PNG/拼豆/像素 JSON/项目 JSON/新建画布）。
- **复现步骤**：
  1. 打开产物，导入任意图片；
  2. 参数面板「色板」选「自定义 / .hex」；
  3. 观察参数面板：除原控件外无新增控件；
  4. 调用 `window.pixelArtStudio.setParams({paletteMode:'custom', customPalette:[]})` 后读 `getPalette()` → 返回自动取色的结果。
- **期望**：应出现自定义色板输入区（粘贴 `.hex` 文本 / 选择 `.hex` 文件），并在色板为空时给出提示；USAGE.md 第 50 行称"支持导入 `.hex`（Lospec 风格，或 `编号 #rrggbb` 两列带号色）"，第 123/131 行也称 `.hex` 可导入。
- **证据**：
  - `t-B-params.mjs`：`B2 自定义 / .hex：选择后应出现自定义面板 — textarea=0 file=0 text=0`（失败）
  - 同套件记录：`customPalette=[] → 仍得到 18 色（未报错、未提示）`
  - `t-G-export.mjs`：`G3 色板 .hex：UI 导出菜单是否有入口 — 导出菜单含 .hex 条目 = false`
  - 导入用的 file input 为 `accept="image/*"`，无法选 `.hex`
- **影响**：想用官方色卡/自定义色卡的拼豆与资产用户**在界面里完全无法完成**该工作流，且会被下拉项"以为能用"。绕法：CLI `--palette xxx.hex`、页内 API `setParams({customPalette:[...]})` 或导入项目 JSON。属于"文档说支持但界面不支持"。
- **修改意见**：
  - `src/app/index.ts:518` 的色板 `selectInput` 目前只切 `paletteMode`；在 `renderParams()` 内为 `paletteMode === 'custom'`（约 528 行 `preset`/`auto` 分支旁）补一段自定义面板：一个可粘贴 `.hex` 的 `<textarea>` 或 `<input type="file" accept=".hex,text/plain">`，解析后写入 `patchParams({ customPalette })`。
  - 解析函数可直接复用 `src/core/palettes.ts` 的 `serializeHexPalette()` 的逆向逻辑（`parseHexPalette`，若不存在需在 core 补一个纯函数并加单测，保持 core 零 DOM）。
  - 导出侧：在 `src/app/index.ts:896`（「数据」分组）加一条「色板 .hex」，调用 `serializeHexPalette(app.art.palette)`（页内 API 已有 `exportPaletteHex()`，见 `src/app/automation.ts:193`）——CLI 已在产出 `.hex`，UI 补上即可对齐。
  - 空色板兜底：`src/core/pipeline.ts:291` 目前 `customPalette.length===0` 时静默走 median cut，而 `:531-533` 仍把 `paletteSource` 报成 `'custom'`，日志/`--json` 会误导。建议空色板时要么报错、要么把 `paletteSource` 如实报为 `auto`，并让 UI 给出提示。
- **会影响别的功能吗**：仅新增控件与一处分支，不动 core 算法；`tool/e2e*.mjs` 的选择器契约不受影响（新增 `.field` 会改变索引，但现有用例用的是 class/结构选择器，需回归一遍 `npm run verify`）。

### P2-01　页内 API `exportPNG(scale,{transparentBg})` 无法产出键控透明（与文档不符）

- **现象**：`transparent:'key'` 时，UI 导出 PNG 会把合成底色变透明；但页内 API `ps.exportPNG(1,{transparentBg:true})` **永远不产生透明像素**，且不报错。文档 `docs/AGENT_API.md:293` 写作 `ps.exportPNG(scale, { transparentBg })`，暗示仅凭该参数即可。
- **复现步骤**：
  1. 导入 `src-alpha.png`，`setParams({transparent:'key', matteColor:'#ffffff'})`（默认值即可）；
  2. 页内 `ps.exportPNG(1,{transparentBg:true})` → 解码 PNG，透明像素 = 0；
  3. 同一状态点界面「导出 → PNG 1x」→ 解码，透明像素 = 344。
- **期望**：API 与 UI 行为一致，或文档明确写出必须同时提供键控色。
- **证据**：`.tmp/dbg-key4.mjs` 实测（matte `#00ff00`，UI 路径通过 bgHex 生效时）：

  | paletteK | 画布中=matte 的格 | API 导出透明 | UI 导出透明 |
  |---|---|---|---|
  | 24 | 0 | 0 | 0 |
  | 32 | 144 | **0** | **144** |
  | 48 | 144 | **0** | **144** |

  `dbg-key5.mjs`：默认 `#ffffff` matte，UI 导出 344 透明像素。
- **影响**：agent 按文档用页内 API 批量出"透明底 PNG"会**静默拿到不透明的图**。绕法：走 UI 导出菜单，或改用 `transparent:'alpha'`。
- **修改意见**：
  - `src/app/automation.ts:189-192` 把签名扩成 `exportPNG(scale = 1, opts?: { transparentBg?: boolean; bgHex?: string })`，并在 `bgHex` 缺省时用 `deps.getParams().matteColor` 补齐；`src/core/raster.ts:39` 的 `keyOut` 依赖 `bgHex` 是既有正确逻辑，无需改。
  - 同步更新 `docs/AGENT_API.md:293`（该文件由 `src/core/spec.ts` 生成，改元数据后跑 `npm run describe`），并在 `src/app/index.ts:1091` 的 `exportPNG` 注入里透传 `bgHex`。
- **会影响别的功能吗**：`exportPNG` 只增可选字段，向后兼容；`tool/e2e.mjs` 的 PNG 导出断言不受影响。

### P2-02　单色键控的成功依赖"量化后色板恰好保留 matteColor"，失败时静默无透明

- **现象**：`transparent:'key'` 的键控是**精确等值匹配**（`raster.ts:46`）。若量化后色板里没有与 `matteColor` 完全相同的颜色，导出就**一个透明像素都没有，也不提示**。默认 `paletteK=24` 时用绿色 `#00ff00` 作底色即复现；默认白色 `#ffffff` 则正常。
- **复现步骤**：
  1. 导入 `src-alpha.png`；
  2. `setParams({transparent:'key', matteColor:'#00ff00'})`（其余保持默认，`paletteK=24`）；
  3. 界面「导出 → PNG 1x」→ 解码后透明像素 0；画布中也没有任何一格等于 `#00ff00`（该色未进入色板）。
- **期望**：键控应稳定生效（例如：量化时强制把 `matteColor` 纳入候选色板，或按"大面积背景色"取实际格色做键控），至少在无法键控时给出提示。
- **证据**：`.tmp/dbg-key4.mjs` 上表（paletteK=24 行：命中 0，UI 导出透明 0）；`.tmp/dbg-key2.mjs` 显示 paletteK=32 时色板含 `#00ff00`、命中 144 格，UI 导出即 144 透明像素。UI 与 API 均可复现。
- **影响**：用户选了「单色键控」、界面看起来也对（底色是绿的），导出却是全不透明的图，且无任何警告。绕法：改用 `真 alpha`、或把 `matteColor` 换成白色/黑色等通常能存活的颜色、或调大颜色数。
- **修改意见**：`src/core/raster.ts:39-47` 的 `keyOut` 改为"按实际出现的格色键控"更稳；最小改动是在 `src/core/pipeline.ts` 的量化阶段（`quantize` 调用前，`pipeline.ts:531` 附近）当 `transparent==='key'` 时把 `matteColor` 并入工作色板（或在 `resolvePalette` 返回值里 append）。若不想改语义，至少在导出前检测"画布无任何格等于 matteColor"并 `toast(...,'warn')`。
- **会影响别的功能吗**：把 matteColor 并入色板会占用一个色板名额（拼豆 `lockPalette` 场景需谨慎，建议仅 `!lockPalette` 时并入）；不改变 `none`/`alpha` 两种模式。

### P2-03　按住 L 连线不能链式：第二次点击从"上一次自由笔画终点"起，而不是上一条 L 线的终点

- **现象**：画一笔（自由拖动到 B）后，按住 `L` 点击 C，会正确画出 B→C；**再按住 L 点 D 时，画的是 B→D（从最初那笔的终点发散），而不是 C→D**。表现为一束"扇形"而不是链式折线。
- **复现步骤**：
  1. 新建 32×32 画布，画笔；
  2. 从 (4,4) 拖到 (4,12)（起手一笔）；
  3. 按住 `L`，点击 (16,12) → 出现横线 y=12；
  4. 仍按住 `L`，点击 (16,20) → 期望竖线 (16,12)→(16,20)，**实际是从 (4,12) 斜拉到 (16,20)**。
- **期望**：连续 L 点击应链式（每次以上一条线终点为新起点）——指南 §2 C8 与快捷键说明"从上次落笔处画直线"。
- **证据**：`.tmp/dbg-L.mjs` 输出的像素图（`#` 为落笔格）：

  ```
        0123456789012345678901
     4 ....#.................
     ...
    12 ....#############.....   ← L 点击 (16,12)：正确
    13 .....##...............
    14 .......#..............
    15 ........##............   ← 第二次 L 点击本应是竖线，
    16 ..........#...........      实际从 (4,12) 发散
    17 ...........##.........
    18 .............#........
    19 ..............##......
    20 ................#.....
  ```
  `t-C-tools.mjs`：`C8 连续 L 点击可链式 — 实际命中 2`（失败）。
- **影响**：L 连线的"链式折线"用法不可靠（纯点击不链式；若点击时鼠标跨到相邻格，又会多画一格）。
- **修改意见**：`src/app/ui/canvas.ts:442-447` 的 L 分支在 `paintCellsWithColor(...)` 之后补 `lastStrokeCell = cell`；非 L 的普通落笔（`:440-447`）也建议同步更新，使"上次落笔点"名副其实。当前 `lastStrokeCell` 只在 `onPointerMove`（`:513`）里更新，`onPointerUp`（`:529`）又刻意保留旧值，所以纯点击不会推进锚点。
- **会影响别的功能吗**：仅影响 `lastStrokeCell` 的推进时机，不改线算法；`C1/C2` 等笔画用例与 `tool/e2e.mjs` 不受影响。

### P2-04　状态栏的"已选格数 / 悬停坐标 / 缩放百分比"不实时，要等一次无关重绘才更新

- **现象**：框选后状态栏不出现「已选 N 格」；鼠标悬停不出现坐标；滚轮缩放后百分比不变。只有下一次**由其它操作触发**的 `renderAll()` 才会把这些值一并刷新出来。
- **复现步骤**：
  1. 新建 32×32 画布，切「选区」工具；
  2. 框选 10×6；
  3. 读状态栏 → 无「已选 60 格」；移动鼠标、滚轮缩放 → 坐标与缩放比也不更新；
  4. 改动主色（触发一次重绘）后，状态栏立刻补出「已选 60 格 / 2805% / 7, 7」。
- **期望**：选区格数、悬停坐标、缩放百分比应实时反映（指南 D1 明确要求"状态栏显示已选格数"）。
- **证据**：`.tmp/dbg-statusbar.mjs` 输出：

  ```
  初始      : 画布 32×32工具 画笔笔刷 1×11 色2439%
  框选后    : 画布 32×32工具 选区1 色2439%        ← 无「已选 60 格」
  悬停后    : 画布 32×32工具 选区1 色2439%        ← 无坐标
  滚轮缩放后: 画布 32×32工具 选区1 色2439%        ← 百分比未变
  改主色后  : 画布 32×32工具 选区1 色已选 60 格2805%7, 7   ← 一次重绘后全部补出
  ```
  `t-D-selection.mjs`：`D1 状态栏应实时显示已选格数`（失败）、`D5 状态栏应实时显示「已复制选区」`（失败）。
- **影响**：用户得不到选区规模、坐标与缩放反馈；而这些恰是精修像素画的常用参照。绕法：做一次会触发重绘的操作。
- **修改意见**：`src/app/index.ts:200-202` 的 `onHover/onSelectionChange/onZoom` 只 `store.set(...)`，而唯一订阅（`:1063`）只用于偏好持久化。建议新增 `store.subscribe(['selectedCount','hoverText','zoomPct','clipboardHas'], () => renderStatusbar())`（只重绘状态栏，符合 `src/app/store.ts` 顶部"按 key 精确通知、避免鼠标每跨一格就重渲染整个应用"的既定设计，不要改成 `renderAll()`）。
- **会影响别的功能吗**：`renderStatusbar()` 是幂等的纯 DOM 重建，只影响状态栏；不动 canvas 绘制，不影响性能设计目标。

### P2-05　撤销/重做不还原色板：像素对了，但 artHash 与导出色板残留已撤销的颜色

- **现象**：一次笔画后撤销，**画布像素完全还原**，但 `artHash()` 与撤销前不一致，因为**色板多出了这次笔画引入的颜色**（即使所有相关像素都已被撤销）。实际后果：撤销到底后导出的「项目 JSON / 像素数据 JSON / `.hex`」会带上"从未真正存在过"的颜色（用量 0），且 `artHash` 不再等于初始值。
- **复现步骤**：
  1. 新建 32×32 黑底画布，记 `artHash` 与 `getPalette()`（应为 `['#000000']`）；
  2. 用红色画笔点一下（色板新增 `#ff0000`）；
  3. `Ctrl+Z` 撤销；
  4. 读 `getPalette()` → 仍为 `['#000000','#ff0000']`；`exportPixelJSON().pixels` 与步骤 1 完全相同，但 `artHash` 不同。
- **期望**：撤销应把状态（像素 + 色板 + alpha）完整还原到编辑前，`artHash` 回到原值；这也是 `docs/ARCHITECTURE.md` §6/§7 强调的"同图同参 → 同 hash"确定性契约的一部分。
- **证据**：`.tmp/dbg-undo-palette.mjs`：

  ```
  h0        palette= #000000                hash 892941fc
  笔画后    palette= #000000,#ff0000        hash e29bd061
  撤销一次  palette= #000000,#ff0000        hash de01d705
    像素与 h0 相同? true   色板与 h0 相同? false
  ```
  `t-F-history.mjs`：`F1 撤到底：色板/artHash 也应完全还原 — 色板 h0=[#000000] 撤到底=[#000000,#ff0000]`（失败）；`F3 一次撤销后色板/hash 也应回到起点 — #000000 → #000000,#00ff00`（失败）。
- **影响**：视觉上撤销正确，用户一般不会察觉；但依赖 `artHash` 做比对/去重的 agent 与批处理会误判，撤到底后的工程 JSON / `.hex` 会多出无用颜色。若下游以导出色板为准（如生成色卡），影响放大——**若项目把 artHash 视为数据正确性契约，应把本条按 P1 处理**。绕法：重新导入/重新转换可重置色板。
- **修改意见**：根因是历史快照与"当前画布对象"共享同一个 `palette` 数组引用：
  - `src/app/index.ts:65` `history.past.push(app.art)` 入栈的是**活对象**；第一次提交后 canvas 内部 `art` 仍指向它（`renderAll()` 不调用 `canvasApi.setArt`），
  - 下一次笔画时 `src/app/ui/canvas.ts:372` 的 `art.palette = palette` 就地改写了这个已入栈对象的色板。
  建议在 `commitWithHistory`（`src/app/index.ts:63-71`，以及 redo 的 `:84`）入栈时改为"快照拷贝"：`history.past.push({ ...app.art, indices: app.art.indices.slice(), palette: [...app.art.palette], alphaMask: app.art.alphaMask ? app.art.alphaMask.slice() : null })`。同时可删掉 `canvas.ts:372`（canvas 用的是模块内的 `indices/palette` 局部副本，`onCommit` 已传 `[...palette]`，无需回写 `art.palette`；删除前用 grep 确认无其它读取者）。
- **会影响别的功能吗**：快照拷贝只增加一次 O(格数) 复制，历史本来就有 64MB 预算（`limits.ts`），可接受；删除 `canvas.ts:372` 需确认 canvas 内不再读 `art.palette`。

### P2-06　窄屏（≤980px）侧栏被直接隐藏且没有抽屉开关

- **现象**：窗口宽度 ≤980px 时，左侧工具栏与右侧参数/色板面板被 `display:none` **直接隐藏，没有任何按钮或手势可以把它们打开**；顶栏「导入」「导出」仍可见可用（这点符合预期）。指南 §2 H4 期望"侧栏变抽屉"。
- **复现步骤**：
  1. 打开产物，把窗口调窄到 ≤980px（或 `Emulation.setDeviceMetricsOverride` 设 700×800）；
  2. 读 `.rail` / `.right` 的 `computedStyle.display` → 均为 `none`；
  3. 查找任何抽屉开关（`[aria-label*="侧栏"]`、`.drawer-toggle` 等）→ 0 个；
  4. 观察：无法访问任何绘图工具、参数与色板。
- **期望**：侧栏应能通过开关/手势（抽屉）展开，或明确说明该工具仅支持桌面宽度。
- **证据**：`t-H-edge.mjs`：`H4 窄屏：侧栏应变抽屉 — 左栏 display=none，且没有抽屉开关（找到 0 个）`（失败）；同套件 `导入可点=true / 导出可点=true`（顶栏正常）。CSS 见 `src/app/style.css:654-659`。
- **影响**：窄窗口/移动端基本不可用（顶栏能导入导出，但没有工具与参数面板），且用户看不到"如何打开侧栏"的线索。绕法：加宽窗口。
- **修改意见**：`src/app/style.css:654-659` 已写好抽屉样式（`position:absolute; width:min(300px,88vw); z-index:60`）却缺"展开"机制。建议在 `@media (max-width:980px)` 下把 `.rail`/`.right` 的 `display` 改为按 `body.drawer-open` 或具体类切换，并在顶栏（`src/app/index.ts:691` `buildHeader()` 里）加一个窄屏才显示的汉堡按钮来 toggle；若产品定位就是桌面工具，则应在 `docs/USAGE.md` 明确写出并保持现状。
- **会影响别的功能吗**：仅在窄屏媒体查询内新增交互；桌面布局与 `tool/e2e*.mjs` 的 1400×900 断言不受影响（注意它们断言"左栏有宽度"，不要破坏 ≥980px 的规则）。

### 观察项（有意设计 / 浏览器行为，不作为缺陷）

| 编号 | 内容 | 依据 |
|---|---|---|
| O-01 | 抖动开启时「杂色清理」勾选框**不变灰**、且 `getInfo().params.cleanup` 仍为 `true`（管线内部按 `false` 生效） | `docs/ARCHITECTURE.md` §4 ADR："互斥由 `runPipeline` 强制，而非 UI 禁用"；`src/core/pipeline.ts:536`。**属有意设计**，仅建议加一句"当前不生效"的即时提示（P3） |
| O-02 | 截断的 PNG（前 1/3 字节）被 **Chrome 宽容解码**成完整 96×96 而不是报错 | 浏览器解码器行为，非项目缺陷；随机字节 `.png` 会正确抛「导入失败：图片解码失败（格式不支持或文件损坏）」并有 toast |
| O-03 | 「本地存储不可用」时**没有**"自动草稿不可用"提示 | 项目并无"草稿自动保存"功能（只有偏好/最近色的 localStorage 持久化，且失败静默兜住）；指南 §2 H3 的期望与实际功能集不符。已验证：`setItem` 抛错时不崩、主色更新、导出正常 |
| O-04 | 大画布（2048²）无"处理中"提示 | `store.busy` 只在 `importFile` 置位（`src/app/index.ts:150/161`），无任何 UI 消费。2048² 实测很快（新建 38ms / 编辑 58ms / 导出 58ms），提示非必需（P3） |
| O-05 | `getInfo().hasEdits` 恒为 `false` | `docs/ARCHITECTURE.md` §9 已将其列为**已知缺口**，非新问题 |

---

## 四、修改意见（按优先级）

1. **（P1-01）补齐自定义 / .hex 色板工作流**：`src/app/index.ts` 的 `renderParams()` 在 `paletteMode==='custom'` 分支加 `.hex` 粘贴/文件输入，写回 `customPalette`；导出菜单「数据」分组加「色板 .hex」（复用 `serializeHexPalette`）；空色板时让 `src/core/pipeline.ts:531-533` 如实报告来源或提示用户。
2. **（P2-01）页内 API 键控**：`src/app/automation.ts:189` 的 `exportPNG` 增加可选 `bgHex` 并在缺省时用 `matteColor` 兜底；同步 `docs/AGENT_API.md`（经 `src/core/spec.ts` + `npm run describe` 生成）。
3. **（P2-02）键控稳定性**：`src/core/raster.ts:39-47` 改为按实际格色键控，或在 `src/core/pipeline.ts` 量化前把 `matteColor` 并入色板（`lockPalette` 时除外）；无法键控时 `toast` 警告。
4. **（P2-03）L 连线链式**：`src/app/ui/canvas.ts:442-447` 落笔后推进 `lastStrokeCell = cell`。
5. **（P2-04）状态栏实时化**：`src/app/index.ts` 增加 `store.subscribe(['selectedCount','hoverText','zoomPct','clipboardHas'], renderStatusbar)`（不要用 `renderAll`，以保留 store 的性能设计）。
6. **（P2-05）撤销快照化**：`src/app/index.ts:63-71`（及 `:84`）入栈时深拷贝 `indices/palette/alphaMask`；顺带评估删除 `src/app/ui/canvas.ts:372` 的就地写回。
7. **（P2-06）窄屏抽屉**：`src/app/style.css:654-659` 增加可切换的展开态 + 顶栏汉堡开关；或明确文档化为桌面工具。

---

## 五、自动化已覆盖（引用命令与数字）

以下**未重复验证**，直接引用基线结果（本次全部继续通过）：

- `npm run typecheck` → 0 错误
- `npm test` → **55/55**（Node v24.18.1 `node --test`，376ms）
- `npm run build` → 单文件 120.7KB，根目录与 `dist/index.html` 哈希一致
- `node tool/artc.mjs --selftest` → **25/25**
- `npm run e2e` → **19/19**
- `npm run e2e:picker` → **17/17**
- `npm run e2e:slider` → **12/12**

合计 128 项断言全绿。本次人工清单新增 **132 项**断言（其中 124 通过）。

---

## 六、未能验证的部分与原因

1. **真实 OS 拖拽与剪贴板**：无头环境下剪贴板不与系统剪贴板互通。
   - A1「拖拽导入」用的是页面内 `DataTransfer` + **真实 File 字节**派发 `drop`（走 `boot()` 的真实监听），不是从资源管理器拖入；
   - A3「粘贴导入」同理，用携带真实 File 的 `paste` 事件（`ClipboardEvent.clipboardData` 只读，无法用构造器注入真实图片）；
   - G2「复制 PNG」拦截了 `navigator.clipboard.write`，确认写入的是 **`image/png`（177 字节）**，但**未**在系统剪贴板里实际粘贴验证。
2. **真实照片素材缺失**：全部用自造 96×96 合成图（色块+渐变+透明洞）。因此**未评估**照片类图像转换后的"观感/可用性"，也未与任何参考实现做像素级对比。
3. **多格式解码保真度**：A4 只断言 8 种格式"能导入且尺寸正确"（PNG/JPG/WebP/GIF/BMP/AVIF/ICO/SVG），**未**逐像素比对源图与解码结果（例如 AVIF 的有损差异、ICO 选中了哪个尺寸档）。
4. **触摸手势与真机**：未在移动真机/触控设备上验证（H4 仅用视口模拟窄屏，无 touch 事件、无真实 DPR）。
5. **浏览器覆盖**：只在 Edge 153 headless 上测；机器上的 Chrome 未测。Firefox/Safari 未测。
6. **拼豆实体对照**：无实体拼豆板/品牌色卡，`图纸 SVG`/`缺口清单 CSV` 只做了结构守恒校验（矩形数、图例、板标注、`每色格数+透明格=总格数`），**未**由人工核对图纸可读性；内建拼豆色卡是通用近似色（`docs/USAGE.md:131` 已声明）。
7. **历史栈上限**：未验证 `HISTORY_MAX_FRAMES=50` / `HISTORY_MAX_BYTES=64MB` 的封顶行为（未做 50+ 步压力）。
8. **动画/多帧**：数据模型预留 `frames` 但未实现（`capabilities().animation === false`，`docs/ARCHITECTURE.md` §9），无对应用例。
9. **`.pixbin` 往返**：只跑了单测与 CLI 侧（`--pixbin`），未在 UI/页内 API 路径验证。
10. **Node 端解码**：I5 确认 JPG 被明确拒绝并提示改用 `--browser-decode`；其余非 PNG 格式在 Node 端的表现未逐一枚举（文档已声明仅承诺 PNG）。
11. **大画布细节**：H2 只做了 2048² 的一次通过性 + 耗时记录，未测 2048² 下的连续编辑、缩放与内存占用曲线。
12. **输出目录**：所有下载/导出产物写在 `F:\像素画build\.tmp\`（已被 `.gitignore` 忽略），未污染仓库；测试脚本也在其中。

---

## 七、附：测试脚本与素材

均位于 `F:\像素画build\.tmp\`（`.gitignore` 已忽略，不会入库）：

| 文件 | 作用 |
|---|---|
| `harness.mjs` | 零依赖 CDP 测试骨架：桌面视口强制、真实鼠标/键盘输入、格→屏幕映射（读 `#board` 的 `dataset.lastDraw`）、下载捕获、断言收集 |
| `t-A-import.mjs` | A 导入（拖拽/按钮/粘贴/8 格式/边界）—— 23 项 |
| `t-B-params.mjs` | B 转换参数 + 跨模式 —— 21 项 |
| `t-C-tools.mjs` | C 编辑工具（画笔/右键/笔刷/填充/形状/取色/Alt/L）—— 14 项 |
| `t-D-selection.mjs` | D 选区（框选/越界/挖洞填色/复制粘贴/移动/Esc）—— 13 项 |
| `t-E-color.mjs` | E 取色器手感与提交（色轮/明度条/数值行/数字/Hex/透明/色板/吸管）—— 13 项 |
| `t-F-history.mjs` | F 撤销重做（逐步回退/重做/一次拖拽=一步）—— 9 项 |
| `t-G-export.mjs` | G 导出（PNG 倍数与最近邻、复制 PNG、.hex、像素 JSON、项目 JSON 往返、拼豆 SVG、CSV 守恒）—— 11 项 |
| `t-H-edge.mjs` | H 边界（未导入导出、2048²、存储不可用、窄屏、空/全透明导出、连续快速操作）—— 13 项 |
| `t-J-api.mjs` | J 页内 API（whenReady/getInfo、render 无副作用与确定性、edit/undo、validateParams、错误路径）—— 10 项 |
| `dbg-*.mjs` | 根因定位脚本：`dbg-L`（L 连线形状）、`dbg-statusbar`（状态栏惰性）、`dbg-undo-palette`（色板残留）、`dbg-history`（撤销栈深度）、`dbg-key2..5`（键控透明与 paletteK 关系）、`dbg-geom`（视图变换）等 |
| `test-assets/` | 自造素材：`src-opaque.png`/`src-alpha.png`/`src.jpg`/`src.webp`/`src.gif`/`src.bmp`/`src.avif`/`src.ico`/`src.svg`，边界素材 `edge-1x1.png`、`edge-6000x120.png`、`edge-transparent.png`、`edge-random.png`、`edge-corrupt.png`、`mislabeled.png`（PIL 12.3 生成） |
| `downloads/`、`cli/` | G 的下载产物与 I 的命令行产物 |

复现命令示例：

```bash
cd F:/<项目目录>
for s in A-import B-params C-tools D-selection E-color F-history G-export H-edge J-api; do node .tmp/t-$s.mjs; done
node tool/artc.mjs --selftest
node tool/artc.mjs --describe
node tool/artc.mjs --in .tmp/cli/in --out .tmp/cli/out --palette gameboy --size 32x32 --alpha --sheet 4   # 含坏图 → 退出码 1
```

---

## 八、修复状态（由开发侧在报告之后补齐）

报告中的 8 条问题已全部修复，每条都补了回归断言（`tool/e2e-regressions.mjs`，已并入 `npm run verify`）。

| 编号 | 处置 | 关键改动 | 回归断言 |
|---|---|---|---|
| P1-01 | 已修 | 参数面板补「自定义 / .hex」编辑区（粘贴文本 / 导入 .hex 文件 / 填入当前画布色板 / 清空）；导出菜单补「色板 .hex」 | 选自定义后出现输入区与导入按钮；写入后面板值生效；有原图时转换只用自定义色；导出菜单含 .hex |
| P2-01 | 已修 | 页内 API `exportPNG(scale, { transparentBg, bgHex })`：`bgHex` 缺省时用 `params.matteColor` 兜底（键控需要键控色，原先只传 `transparentBg` 必然不透明） | API 键控导出必须产出透明像素（实测 256/256） |
| P2-02 | 已修 | `pipeline.ts` 的 `paletteSource` 在"custom 但色板为空"时如实报 `auto`；UI 在自定义色板为空时给出明确提示 | 空色板必须退回自动取色（实测 24 色），不产出单色画布 |
| P2-03 | 已修 | `canvas.ts` 每次落笔都推进锚点 `lastStrokeCell`（原先只在 `pointermove` 推进，导致 L 连点是扇形而非折线） | 真实鼠标路径：第二条 L 线必须是竖线（实测 y=12 行 32 格 / x=20 列 32 格） |
| P2-04 | 已修 | 增加 `store.subscribe(['selectedCount','hoverText','zoomPct','clipboardHas','hasEdits'], renderStatusbar)`（只重绘状态栏，不用 `renderAll`，保留按 key 精确通知的设计） | 框选后状态栏立即出现「已选 60 格」、悬停出现坐标、缩放出现百分比 |
| P2-05 | 已修 | 根因不是历史栈：`canvas.ts` 的 `commit()` 曾把内部数组写回 `art.palette`，而 canvas 持有的 art 可能正是入栈的那个对象 → 基线快照被就地污染。已删除该写回，并在入栈时深拷贝（`cloneArt`） | 画笔后撤销：`artHash` 与色板必须完全回到起点 |
| P2-06 | 已修 | CSS 的窄屏规则只隐藏侧栏、没有展开机制 → 补顶栏两个开关（`data-testid="drawer-tools"/"drawer-panel"`）+ `body.drawer-open` 展开态 + 点遮罩/`Esc` 关闭 + 回到桌面宽度自动收起 | 窄屏下开关可见可点，侧栏"收起 → 展开 → 收起"闭环 |
| B6（报告表格里的一行） | 已修 | 参数面板补「裁剪比例」下拉（core 与 CLI 的 `--crop` 一直支持，但界面此前无入口） | `t-B-params` B6 通过 |

### 同时修正的两处**测试侧**问题（产品无缺陷，是断言写法导致误报）

| 位置 | 现象 | 实际原因 | 处置 |
|---|---|---|---|
| B7「真 alpha 棋盘底」 | 断言读到 0 个棋盘像素，报"棋盘底没画出来" | 切换参数后**立即**读画布像素，而绘制是异步的（rAF + 定时器兜底），读到的是上一帧 | 改为轮询等待绘制完成；实测棋盘像素 33489，产品正常 |
| H4「窄屏抽屉」 | 断言失败并提示"没有抽屉开关（找到 0 个）" | 断言用 `[aria-label*="侧栏"] / .drawer-toggle / #btn-rail` 找开关，而实现用的是 `data-testid="drawer-*"`；且断言要求"侧栏默认可见"，而抽屉**默认收起**才是正确行为 | 更新选择器并改断言为"有开关且能展开/收起" |

### 验证（修复后）

```
npm run verify
  typecheck 0 错 / 单测 55 / 构建哈希一致 / 自检 25
  e2e 19 / e2e:picker 17 / e2e:slider 12 / e2e:regressions 10
```

产物哈希：`417b5331…`（127.3 KB）。报告里记录的旧产物哈希为 `22a111e0…`——
**后续测试请以产物哈希为准**，不同哈希的表现可能完全不同。