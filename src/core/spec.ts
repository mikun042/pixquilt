/**
 * 算子与参数的**元数据单一真源**。
 *
 * 这个文件同时驱动四件事（这是"文档永不漂移"的机制，见 docs/DEVELOPMENT.md §5）：
 *   1. 页内 API 的 `describeOps()` / `describeParams()` / `describe()`
 *   2. CLI 的 `--describe` 与 `--help`
 *   3. `docs/AGENT_API.md` 的算子表与参数表（由 tool/describe.mjs 生成）
 *   4. 单测断言"这里列出的算子名集合 == ops.ts 实际处理的集合"
 *
 * 因此：**改算子必须改这里，改这里也会被测试逼着改实现。**
 */
import { ALPHA_THRESHOLD, CLEANUP_MIN_SIZE_MAX, CLEANUP_MIN_SIZE_MIN, EXPORT_SCALES, MAX_CANVAS_SIDE, MAX_EXPORT_PIXELS, MAX_EXPORT_SIDE, MIN_CANVAS_SIDE, PALETTE_K_MAX, PALETTE_K_MIN, PALETTE_MAX, SCHEMA_VERSION } from './limits.ts'
import { PRESETS } from './palettes.ts'
import { STYLE_PRESETS, TOOLS, type ConvertParams } from './types.ts'

export type FieldType = 'number' | 'string' | 'boolean' | 'hex' | 'enum' | 'cells' | 'opaque'

export interface OpFieldSpec {
  name: string
  type: FieldType
  required: boolean
  default?: unknown
  desc: string
}

export interface OpSpec {
  op: string
  desc: string
  fields: OpFieldSpec[]
  /** 备注：语义陷阱，agent 最容易踩的地方 */
  notes?: string[]
}

/** 12 类算子：8 个基础 + 4 个便捷（便捷算子等价于"按色选区 + 上色/挖洞/描边/镜像"，保留是因为拼豆、去白底、对称作画这些场景高频） */
export const OP_SPECS: OpSpec[] = [
  {
    op: 'fill',
    desc: '油漆桶：把 (x,y) 所在连通区域整体换色；erase:true 则整块挖成透明',
    fields: [
      { name: 'x', type: 'number', required: true, desc: '起点列（越界会被静默裁剪）' },
      { name: 'y', type: 'number', required: true, desc: '起点行' },
      { name: 'color', type: 'hex', required: false, default: '当前主色', desc: '填充色' },
      { name: 'erase', type: 'boolean', required: false, default: false, desc: '为 true 时挖洞（透明格之间视为同一连通区域）' },
    ],
    notes: ['无副作用路径（render/renderBlank 的 ops）必须显式给 color，否则报错'],
  },
  {
    op: 'setCells',
    desc: '指定格子批量上色或挖洞',
    fields: [
      { name: 'cells', type: 'cells', required: true, desc: '格子坐标数组 [[x,y],…]' },
      { name: 'color', type: 'hex', required: false, default: '当前主色', desc: '上色颜色' },
      { name: 'erase', type: 'boolean', required: false, default: false, desc: '为 true 时把这些格子挖成透明' },
    ],
  },
  {
    op: 'setAll',
    desc: '整幅涂色；erase:true 清空成全透明',
    fields: [
      { name: 'color', type: 'hex', required: false, default: '当前主色', desc: '整幅颜色' },
      { name: 'erase', type: 'boolean', required: false, default: false, desc: '整幅挖洞（全透明画布）' },
    ],
  },
  {
    op: 'line',
    desc: 'Bresenham 直线，与界面笔刷同一套足迹',
    fields: [
      { name: 'x0', type: 'number', required: true, desc: '起点列' },
      { name: 'y0', type: 'number', required: true, desc: '起点行' },
      { name: 'x1', type: 'number', required: true, desc: '终点列' },
      { name: 'y1', type: 'number', required: true, desc: '终点行' },
      { name: 'color', type: 'hex', required: false, default: '当前主色', desc: '线色' },
      { name: 'brushSize', type: 'number', required: false, default: 1, desc: '笔刷边长 1–3' },
    ],
  },
  {
    op: 'rect',
    desc: '矩形：filled 省略时为实心',
    fields: [
      { name: 'x0', type: 'number', required: true, desc: '左上角列' },
      { name: 'y0', type: 'number', required: true, desc: '左上角行' },
      { name: 'x1', type: 'number', required: true, desc: '右下角列' },
      { name: 'y1', type: 'number', required: true, desc: '右下角行' },
      { name: 'color', type: 'hex', required: false, default: '当前主色', desc: '颜色' },
      { name: 'filled', type: 'boolean', required: false, default: true, desc: 'false 为空心描边' },
    ],
  },
  {
    op: 'ellipse',
    desc: '椭圆（内切于给定外接框），与界面椭圆工具同一栅格化',
    fields: [
      { name: 'x0', type: 'number', required: true, desc: '外接框左列' },
      { name: 'y0', type: 'number', required: true, desc: '外接框上行' },
      { name: 'x1', type: 'number', required: true, desc: '外接框右列' },
      { name: 'y1', type: 'number', required: true, desc: '外接框下行' },
      { name: 'color', type: 'hex', required: false, default: '当前主色', desc: '颜色' },
      { name: 'filled', type: 'boolean', required: false, default: true, desc: 'false 为空心圆环' },
    ],
  },
  {
    op: 'transform',
    desc: '镜像 / 旋转；rotate90 与 rotate270 会交换宽高，alpha 一起搬',
    fields: [{ name: 'kind', type: 'enum', required: true, desc: 'flipX | flipY | rotate90 | rotate180 | rotate270' }],
    notes: ['形状重排时 cells 记 0，用 kind 说明发生了什么；changed 仍按真实变化判定'],
  },
  {
    op: 'trim',
    desc: '裁掉四周透明边，画布缩到不透明内容的外接框',
    fields: [],
    notes: ['全透明或已无透明边时返回 changed:false 且不报错（批处理里这是合法状态）'],
  },
  {
    op: 'eraseColor',
    desc: '便捷算子：把某色全部挖成透明（一键去白底）',
    fields: [{ name: 'color', type: 'hex', required: true, desc: '要挖掉的画布已有颜色（色板里没有则报错）' }],
    notes: ['等价于「按色选区 + setCells(erase)」；保留是因为"去白底"在精灵图流程里高频'],
  },
  {
    op: 'replaceAny',
    desc: '便捷算子：把某色整体换成另一色（拼豆"没有这个色，换一个看看"）',
    fields: [
      { name: 'color', type: 'hex', required: true, desc: '源色（必须是画布色板里已有的颜色）' },
      { name: 'to', type: 'hex', required: true, desc: '目标色（允许是色板外的新色）' },
    ],
    notes: ['源色与目标色相同的等价情形返回 changed:false 而非报错'],
  },
  {
    op: 'outline',
    desc: '描边：给不透明内容的边界外侧补一圈实色（像素画收尾常用）',
    fields: [
      { name: 'color', type: 'hex', required: false, default: '当前主色', desc: '描边色' },
      { name: 'connectivity', type: 'enum', required: false, default: 8, desc: '8（默认，完整一圈含斜角） | 4（只描正交相邻那圈，四角留空）' },
      { name: 'offset', type: 'number', required: false, default: 1, desc: '描边层数（向外扩几圈）' },
    ],
    notes: [
      '只往空的（透明）格写，已有内容一律不被覆盖',
      '描边是**扩张**操作：对同一张图再描一次会把刚描的一圈当成内容继续向外扩。想加粗请用 offset，不要在算子数组里连写两次',
      '判定有无内容看 alpha 而非颜色索引：挖过洞的格子里仍留着旧索引，只看索引会贴着看不见的东西描',
      '外侧没有空格时返回 changed:false，且**不会**把描边色加进色板（空操作不该污染颜色表）',
    ],
  },
  {
    op: 'mirror',
    desc: '镜像加笔：把当前内容镜像到画布另一侧（对称角色/道具/装饰）',
    fields: [
      { name: 'kind', type: 'enum', required: true, desc: 'h（左右） | v（上下） | both（四向）' },
      { name: 'color', type: 'hex', required: false, default: '当前主色', desc: '镜像副本的颜色（想做出"倒影"就用更暗的色）' },
    ],
    notes: [
      '以画布中线为轴，原内容保留，镜像副本叠加上去',
      '副本里的透明格不落笔（否则镜像一次会把原内容抹掉一半）',
      '已有内容的格子不被覆盖，便于"先摆一半再镜像"',
      '与 transform flipX 的区别：flipX 是把整幅翻转（原内容不在原位），mirror 是保留原内容再补一份',
    ],
  },
]

/** 参数元数据：range/enum 与 sanitize 的实际行为必须一致（单测会抽样校验） */
export interface ParamSpec {
  key: keyof ConvertParams
  type: FieldType
  desc: string
  enum?: readonly string[]
  min?: number
  max?: number
  default: unknown
  /** 何时生效（条件参数说明，例如 paletteK 只在 auto 档有意义） */
  when?: string
}

export const PARAM_SPECS: ParamSpec[] = [
  { key: 'longEdge', type: 'number', desc: '输出长边格数（短边按原图宽高比取整）', min: MIN_CANVAS_SIDE, max: MAX_CANVAS_SIDE, default: 64, when: '未指定 exactWidth/exactHeight 时生效' },
  { key: 'downsample', type: 'enum', desc: '降采样：区域平均（照片）或最近邻（硬边）', enum: ['average', 'nearest'], default: 'average' },
  { key: 'cropRatio', type: 'enum', desc: '居中裁剪比例', enum: ['free', '1:1', '4:3', '16:9'], default: 'free' },
  { key: 'paletteMode', type: 'enum', desc: '色板来源', enum: ['auto', 'preset', 'custom'], default: 'auto' },
  { key: 'paletteK', type: 'number', desc: '自动取色的目标颜色数', min: PALETTE_K_MIN, max: PALETTE_K_MAX, default: 24, when: 'paletteMode=auto' },
  { key: 'presetPaletteId', type: 'string', desc: `预置色卡 id（${PRESETS.map((p) => p.id).join(' / ')}）`, default: 'pico8', when: 'paletteMode=preset' },
  { key: 'customPalette', type: 'string', desc: '自定义色板（#rrggbb 数组，≤256）', default: [], when: 'paletteMode=custom' },
  { key: 'dither', type: 'enum', desc: '抖动方式（开启时自动关闭杂色清理）', enum: ['none', 'floyd', 'bayer'], default: 'none' },
  { key: 'ditherStrength', type: 'number', desc: '抖动强度', min: 0, max: 100, default: 100, when: 'dither!=none' },
  { key: 'cleanup', type: 'boolean', desc: '杂色清理：把孤立小色块并入邻域主色', default: true },
  { key: 'cleanupMinSize', type: 'number', desc: '小于该格数的连通色块会被并入', min: CLEANUP_MIN_SIZE_MIN, max: CLEANUP_MIN_SIZE_MAX, default: 2, when: 'cleanup=true' },
  { key: 'brightness', type: 'number', desc: '亮度调整（转换前）', min: -100, max: 100, default: 0 },
  { key: 'contrast', type: 'number', desc: '对比度调整（转换前）', min: -100, max: 100, default: 0 },
  { key: 'saturation', type: 'number', desc: '饱和度调整（转换前）', min: -100, max: 100, default: 0 },
  { key: 'transparent', type: 'enum', desc: '透明处理：不透明（合成到 matteColor）/ 单色键控 / 真 alpha 通道', enum: ['none', 'key', 'alpha'], default: 'none' },
  { key: 'matteColor', type: 'hex', desc: 'alpha 合成与单色键控用的底色', default: '#ffffff' },
  {
    key: 'keyMode',
    type: 'enum',
    desc: '键控范围：global 全图同色都透明；border 只键掉与四边连通的底色区域（白底 + 主体内部有同色高光时必须用 border）',
    enum: ['global', 'border'],
    default: 'global',
    when: 'transparent=key',
  },
  {
    key: 'keyTolerance',
    type: 'number',
    desc: '键控颜色容差（三通道最大差，0=精确同色）；扩散模型输出的白底常是 254/255 噪声，需要 1–3',
    min: 0,
    max: 255,
    default: 0,
    when: 'transparent=key',
  },
  { key: 'exactWidth', type: 'number', desc: '强制输出宽度（游戏资产模式；须与 exactHeight 同时给出）', min: 1, max: MAX_CANVAS_SIDE, default: null },
  { key: 'exactHeight', type: 'number', desc: '强制输出高度', min: 1, max: MAX_CANVAS_SIDE, default: null },
  { key: 'lockPalette', type: 'boolean', desc: '只允许使用给定色板（拼豆/资产批次；量化与算子都不会新增颜色）', default: false },
]

export interface Capabilities {
  version: string
  apiLevel: number
  schemaVersion: number
  paletteMax: number
  canvasSideMax: number
  canvasSideMin: number
  exportSideMax: number
  exportPixelsMax: number
  exportScales: readonly number[]
  alphaThreshold: number
  tools: readonly string[]
  presets: { id: string; name: string; desc: string; colors: number; hasCodes: boolean }[]
  stylePresets: { id: string; name: string; desc: string }[]
  decodeFormatsInNode: readonly string[]
  decodeFormatsInBrowser: readonly string[]
  /** 多帧动画：字段已预留，尚未实现（见 docs/DEVELOPMENT.md §8 的 B1） */
  animation: false
  /** 是否支持只用已有色板（拼豆/资产批次） */
  lockPalette: true
  /** 屏幕吸管：刻意未实现（JS 无法跨窗口取色；画布取色请用 picker 工具或 Alt+点击） */
  eyeDropper: false
}

export const CAPABILITIES: Capabilities = {
  version: '0.1.0',
  apiLevel: 2,
  schemaVersion: SCHEMA_VERSION,
  paletteMax: PALETTE_MAX,
  canvasSideMax: MAX_CANVAS_SIDE,
  canvasSideMin: MIN_CANVAS_SIDE,
  exportSideMax: MAX_EXPORT_SIDE,
  exportPixelsMax: MAX_EXPORT_PIXELS,
  exportScales: EXPORT_SCALES,
  alphaThreshold: ALPHA_THRESHOLD,
  tools: TOOLS,
  presets: PRESETS.map((p) => ({ id: p.id, name: p.name, desc: p.desc, colors: p.colors.length, hasCodes: !!p.codes })),
  stylePresets: STYLE_PRESETS.map((s) => ({ id: s.id, name: s.name, desc: s.desc })),
  decodeFormatsInNode: ['png'],
  decodeFormatsInBrowser: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'ico', 'svg'],
  animation: false,
  lockPalette: true,
  eyeDropper: false,
}

/** 自描述载荷：agent 冷启动时一次拿全（比翻文档快，也不会与实现漂移） */
export function describeAll(): Record<string, unknown> {
  return {
    ...CAPABILITIES,
    ops: OP_SPECS.map((s) => ({ op: s.op, desc: s.desc, fields: s.fields, notes: s.notes ?? [] })),
    params: PARAM_SPECS,
  }
}
