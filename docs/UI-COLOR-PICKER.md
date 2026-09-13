# 取色界面 UI 改造指南（交给具备视觉能力的模型执行）

> 这份文档写给**能看图的模型**：原作者当前的模型无法读取图片，因此参考图（Blender 取色器截图）
> 的像素级还原与后续微调交给视觉模型完成。
>
> **动手前必须做完「第 0 步」**：读懂参考图与现状截图，列出具体差异清单，再改代码。
> 不要凭"Blender 大概是这样"的印象改——本项目已经因为"没看图就按印象实现"返工过一次。

---

## 0. 第一步：看图，产出差异清单（不可跳过）

### 0.1 参考图与现状截图

| 用途 | 路径 |
|---|---|
| 参考图（目标样式，两张） | `C:\Users\<用户名>\Pictures\Screenshots\屏幕截图 2026-09-12 183650.png`（292×475）<br>`C:\Users\<用户名>\Pictures\Screenshots\屏幕截图 2026-09-12 183702.png`（282×490） |
| 现状截图（自己生成） | 见下一步，写到 `.tmp-shots/`（已在 .gitignore 中忽略） |

### 0.2 生成"现状截图"与像素分析

项目自带零依赖的无头浏览器工具，可以稳定产出截图与像素数据：

```bash
cd F:/<项目目录>
npm run build            # 先确保产物是最新代码
npm run shoot            # 产出 .tmp-shots/picker-full.png（整页）与 picker-crop.png（取色器区域）
npm run ref:analyze -- ".tmp-shots/picker-crop.png"    # 对现状做像素级结构分析
npm run ref:analyze -- "C:\Users\<用户名>\Pictures\Screenshots\屏幕截图 2026-09-12 183650.png"   # 对参考图做同样分析
```

`tool/shoot.mjs` 会用一个**桌面视口**（1400×900）打开单文件产物、点开取色器、截取参数面板区域。
**注意**：headless 默认视口是 800×600，会命中 ≤980px 的窄屏规则把左栏 `display:none`，取色器就没有布局尺寸了——
`shoot.mjs` 已经处理了这件事，自己另写脚本时也必须先设视口。

如果要做**定量**对比（而不是只看图），用同一套解码器打印参考图的结构：

```bash
node tool/ref-analysis.mjs <png 路径>
```

它会输出：主色直方图（占比）、字符画（可判断布局与色轮形状）、横向条带（可判断卡片/行高/分隔线）。
参考图的实测结论已经写在下面 §1.2，可直接复用。

### 0.3 差异清单模板（写进本次提交说明）

```
| 差异点 | 参考图 | 现状 | 打算怎么改 | 涉及文件 |
|---|---|---|---|---|
| 色轮直径 | 约面板宽度 65% | 184px 固定 | … | colorpicker.ts:56 |
| …      |         |      |            |           |
```

---

## 1. 现状实现说明（先读，再改）

### 1.1 文件与职责

| 文件 | 职责 | 行数参考 |
|---|---|---|
| `src/app/ui/colorpicker.ts` | **取色器全部逻辑与结构**（DOM 构建、canvas 绘制、指针交互、数值同步） | ~430 行 |
| `src/app/style.css` | 取色器外观（第 373 行起的「取色器（Blender 结构）」段落） | 该段约 145 行 |
| `src/app/index.ts` | 取色器的**挂载与宿主管理**、回调接线（`renderPickerPanel` / `ensurePicker` / `pickerGroups`） | 约 90 行 |
| `src/app/ui/store.ts` | `el()` / `clear()` 两个 DOM 小工具 | — |
| `src/core/color.ts` | 颜色换算（`hexToRgb` / `rgbToHsv` / `hsvToRgb` / `colorTextOn`）——**不要在这里改 UI 相关的东西** | — |

**只改 UI 时，绝大多数改动落在 `colorpicker.ts` 与 `style.css`。** 不要动 `src/core/*`（那是算法层，有 55 项单测守着）。

### 1.2 参考图实测特征（已量化，可直接用）

| 特征 | 实测值 |
|---|---|
| 面板底色 | `#181818`（深灰近黑，占 34%） |
| 容器/控件层次 | `#3c3c3c`、`#494944`、`#545454` |
| **强调色** | **`#4772b3`**（蓝，占 19%/11%） |
| 文字 | `#e6e6e6`（主）/ `#a7a7a7`（次要） |
| 结构 | 顶部标签栏 → 大圆形色轮 → 底部滑块/色块卡片 |

> 这些是参考图本身的值。**本项目的界面保留自己的深灰主题**（`--bg: #14161c` 等，见 `style.css:6` 的 `:root`），
> 只有取色器内部允许更接近参考图。若本次任务要求"整体换成参考图配色"，那是**全站换肤**，需要单独确认（见 §6）。

### 1.3 DOM 结构（当前实现，改样式前必须知道）

```
.picker-wrap                    ← 宿主（由 index.ts 持久化持有，**不要改成每次重建**）
└── .cp                         ← 取色器根（背景/圆角/内边距在这里）
    ├── .cp-tabs                ← RGB / HSV / Hex 三个 .cp-tab（.active 表示当前）
    ├── .cp-wheel-row           ← flex 行
    │   ├── .cp-wheel-wrap      ← 固定 184×184，内含
    │   │   ├── <canvas.cp-wheel>   ← 色轮，canvas 绘制
    │   │   └── .cp-cursor          ← 游标（绝对定位，transform 定位）
    │   └── .cp-bar-col         ← 竖列
    │       ├── .cp-bar-wrap    ← 明度条容器 22×184
    │       │   ├── <canvas.cp-bar>
    │       │   └── .cp-vknob       ← 明度游标（top 百分比）
    │       └── .cp-icon-btn        ← ✚ 吸管
    ├── .cp-alpha               ← 透明度横条；--alpha-color 自定义属性驱动渐变
    │   └── .cp-knob            ← 透明度游标（left 百分比）
    ├── .cp-fields              ← 数值行
    │   └── .cp-field × 7       ← R G B H S V Hex（按模型切换 display）
    │       ├── .cp-field-label
    │       └── input.cp-num
    ├── .cp-swatches            ← 色板
    │   └── .cp-swatch-row      ← 每组一行：.cp-swatch-name + N 个 .cp-swatch
    └── .cp-foot                ← 「收起」按钮
```

### 1.4 关键尺寸与常量（`colorpicker.ts`）

| 常量 | 行 | 值 | 作用 |
|---|---|---|---|
| `WHEEL_SIZE` | 56 | 184 | 色轮 canvas 边长（逻辑像素） |
| `BAR_W` / `BAR_H` | 58 | 22 / 184 | 明度条尺寸；`BAR_H` 跟随 `WHEEL_SIZE` |
| `ALPHA_ZERO_ZONE` | 68 | 0.06 | 透明度条左端"死区"，落进来即视为选透明色 |

改尺寸时**必须同时**改：`colorpicker.ts` 常量、`style.css` 里对应的 `width/height`（若有硬编码）、
以及 `positionCursor()` 里的游标半径偏移（当前 ±7px，见 `colorpicker.ts:202`）。

---

## 2. 动手前必须知道的 6 条"碰了就坏"约束

这些不是风格建议，是踩过的真实缺陷（详见 `docs/ARCHITECTURE.md` §8.3）：

1. **宿主元素 `.picker-wrap` 必须跨渲染存活。**
   它由 `index.ts` 的 `pickerHost`（模块级变量）持有。如果你让 `renderPickerPanel()` 每次新建宿主，
   取色器会"打开正常、一拖动就消失"（拖动会触发一次重渲染，实例 DOM 被留在旧宿主上）。

2. **所有"指针坐标 → 几何比例"的换算都要判零尺寸。**
   `getBoundingClientRect()` 在元素不可见时全是 0，除零会产生 `NaN`，
   并沿色相/饱和度一路污染成 `#NaNNaNNaN` 写进主色。参考实现见 `wheelFromEvent()`（`colorpicker.ts:353`）。

3. **`setPointerCapture` 必须走 `safeCapture()`（`colorpicker.ts:444`）。**
   它对"非活跃 pointerId"抛 `NotFoundError`（合成事件、部分触控设备），而它位于处理器开头，
   一抛就整段取色逻辑不执行。直接用 `el.setPointerCapture(pointerId)` 会重新引入这个 bug。

4. **拖动过程中不要重建 DOM。**
   `refresh()`（`:323`）只更新数值文本、游标 transform、渐变；`repaint()`（`:332`）才重建色板。
   拖动时调 `repaint()` 会让 pointer capture 与焦点失效（视觉上表现为"拖着手感发飘/断掉"）。

5. **`window.addEventListener('pointerup' / 'pointercancel' / 'blur')` 的兜底不能删。**
   它保证"拖到窗口外松手"不会让拖拽状态悬挂。新增的全局监听都必须在 `dispose()`（`:438` 返回的 API）里成对移除。

6. **提交时机不能改。**
   拖动中只 `onPreview()`（实时预览，不进撤销栈）；松手 / 数值输入 / 点色块才 `onCommit()`。
   若改成拖动中提交，一次拖动会产生几十条撤销记录。

---

## 3. 常见改造任务该改哪里

### 3.1 换配色（最高频）

只改 `style.css` 的取色器段落（第 373 行起）。**不要**在 `colorpicker.ts` 里写颜色字面量。

CSS 变量在 `style.css:6` 的 `:root`：

```css
--bg: #14161c;        /* 全站底 */
--bg-2: #1b1e26;      /* 面板底 */
--bg-3: #232733;      /* 控件底 */
--line: #2f3442;      /* 描边 */
--text: #e8eaf0;      /* 主文字 */
--dim: #99a0b0;       /* 次要文字 */
--accent: #6ea8fe;    /* 强调（高亮/焦点） */
--accent-2: #4d7fd6;  /* 强调（填充） */
```

若要让取色器更贴近参考图（`#181818` 底、`#4772b3` 蓝），**推荐只覆盖取色器作用域内的变量**，例如：

```css
.cp {
  --bg-3: #3c3c3c;      /* 控件底 */
  --line: #545454;      /* 描边 */
  --accent-2: #4772b3;  /* 蓝色强调 */
  --text: #e6e6e6;
  --dim: #a7a7a7;
  background: #181818;
}
```

这样不会波及界面其它区域，改动可控、可回退。

### 3.2 改色轮外观（尺寸 / 描边 / 游标样式）

- **尺寸**：改 `WHEEL_SIZE`（`:56`），并把 `style.css` 里 `.cp-wheel-wrap` 的固定宽高同步（若有硬编码）。
- **圆边羽化**：`drawWheel()`（`:152`）末尾 3 行是 1px 抗锯齿，改外观时别把这段删掉，否则圆边发锯齿。
- **游标**：样式在 `style.css` 的 `.cp-cursor`（`:415`），定位由 `positionCursor()`（`:202`）用 `transform` 写入。
  改游标尺寸时同步改 `positionCursor()` 里的 `-7`（= 游标半径）。

### 3.3 改布局（例如"明度条改横条放色轮下方"）

改 `colorpicker.ts:107` 的 `wheelRow` 组装方式即可（结构都在这一行附近），配套改 `.cp-wheel-row` / `.cp-bar-col` 的 CSS。
**不要在 DOM 结构里加"每次都重建"的中间层**（见约束 1）。

### 3.4 改数值行（标签 / 单位 / 小数位）

- 标签集合：`colorpicker.ts:82` 附近的 `tabKeys` / `tabLabels`。
- 显示逻辑与单位换算：`paintFields()`（`:219`）与 `applyNumberField()`（`:279` 附近）。
- 新增字段：在 `fieldInputs` 的循环里加 key，并在 `paintFields()` 的显隐判断里加分支。

### 3.5 改色板（行数 / 每行几个 / 是否显示号色）

- 数据来源：`index.ts` 的 `pickerGroups()`——它返回 `{ name, colors }[]`，想加"拼豆号色"就改这里。
- 渲染：`paintSwatches()`（`:242`）。当前每行最多 32 个（`.slice(0, 32)`），行内换行由 CSS `flex-wrap` 决定。

---

## 4. 环境与验证（改完必须跑）

### 4.1 环境事实

| 项 | 值 |
|---|---|
| 项目根 | `F:\像素画build` |
| Node | v24.18.1（`node --test` 可直接跑 `.ts`） |
| 浏览器 | Edge `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`；Chrome `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| 依赖 | 3 个 devDependency，运行期 0 依赖；写盘前无需联网 |

### 4.2 构建与验证命令

```bash
cd F:/<项目目录>
npm run typecheck      # 必须 0 错（tsc noUnusedLocals 开着，未用变量会直接报错）
npm run build          # 产出单文件 HTML，并核对 dist 与根目录副本哈希一致
npm run e2e:picker     # 取色器专项：11 项（几何方向、标签切换、色板、透明度、零尺寸免疫）
npm run verify         # 全套：typecheck + 55 单测 + build + 25 自检 + 19 端到端 + 11 取色器
```

**只跑 `e2e:picker` 是不够的**：`npm run verify` 里还有"UI 装配/顶栏分组/导入导出"等断言，
改 DOM 结构很可能碰坏它们（例如把 `#btn-export` 挪走会让端到端直接失败）。

### 4.3 交付前必须满足

- [ ] `npm run verify` 全绿（六项）
- [ ] `tool/e2e-picker.mjs` 里**至少新增或更新一条断言**，锁住本次改动的可验证结果
      （例如改了色轮尺寸，就断言 `wheelSize` 等于新值；改了色板行数，就断言行数）
- [ ] 用 `node tool/shoot.mjs` 出一张截图，与参考图并排看过，差异清单里每一项都已落实或明确放弃
- [ ] 提交信息里写清"参考图哪些特征被还原、哪些有意保留现状"

### 4.4 故意改坏一次，确认断言真的能抓住

新增断言后，**临时**把对应代码改坏（例如把 `positionCursor()` 的 `hsv.s` 改成 `1 - hsv.s`），
确认 `npm run e2e:picker` 变红，再改回来。只验证"能通过"的断言没有价值。

---

## 5. 现有断言覆盖了什么（避免重复造轮子）

`tool/e2e-picker.mjs` 当前 11 项：

1. 结构：色轮存在且尺寸 > 100、明度条、透明度条、三个标签、色板行数 ≥ 2
2. 色轮**右侧** → 偏红（色相 0° 方向）
3. 色轮**上方** → 偏蓝（色相随角度变化，且与右侧结果不同）
4. 色轮**圆心** → 灰阶（半径 = 饱和度）
5. 色轮**边缘** → 通道极差明显（饱和度夹满，不甩出圆外）
6. **明度条**：顶部比底部亮（V 轴方向）
7. **标签切换**：RGB / HSV / Hex 改变数值行单位
8. Hex 数值输入生效
9. 色板点选生效
10. 透明度条拖到最左 → 进入透明绘制态
11. 取色不改变画布内容

---

## 6. 需要先确认的边界（不要自作主张）

| 事项 | 说明 |
|---|---|
| 是否只改取色器 | 用户当前明确要求的是"**调色界面**"。若要顺带改全站配色（顶栏/左栏/参数面板/状态栏），请先确认——那是换肤，改动面大得多 |
| 是否引入外部资源 | **禁止**：产物必须保持"单文件、双击即用、不联网"。不要加 CDN、外部字体、外链图片 |
| 是否换图标方案 | 当前用 Unicode 字符（`✚`、`∅`、`▦`）。若要用图标字体/SVG，注意单文件内联与体积 |
| 是否动算法层 | **不要动** `src/core/*`。那是 55 项单测 + 25 项自检守着的算法层，与 UI 无关 |
| 依赖 | 不要新增 npm 依赖。现有 UI 是零框架 vanilla TS + `el()` 工具，新增依赖会破坏"运行期 0 依赖"的承诺 |

---

## 7. 一句话交接

> 改 `src/app/ui/colorpicker.ts`（结构/绘制/交互）与 `src/app/style.css` 第 373 行起的取色器段落；
> 优先用 `:root` 变量与 `.cp` 作用域覆盖变量来调色，不要在 TS 里写颜色字面量；
> 宿主持久化、零尺寸守卫、`safeCapture`、拖动期不重建 DOM 这四条不能破；
> 改完跑 `npm run verify`，并为本次改动补一条断言。
