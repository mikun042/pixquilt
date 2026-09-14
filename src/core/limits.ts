/**
 * 全局硬上限与配额：所有"魔法数字"只在这里出现一次。
 * 每个常量都必须有一句"为什么是这个值"，否则下次维护只能靠猜。
 * 对应文档：docs/ARCHITECTURE.md「限额与预算」。
 */

/** 画布单边格数上限。2048² ≈ 419 万格，Uint8Array 索引约 4MB，浏览器端仍可交互 */
export const MAX_CANVAS_SIDE = 2048
/** 像素数量滑条/参数的默认下限（再小看不出内容，也没有实用价值） */
export const MIN_CANVAS_SIDE = 8

/** 索引是 Uint8Array：色板超过 256 项会让重排回绕出错误颜色 */
export const PALETTE_MAX = 256

/** alpha 低于该值即视为透明格（全项目唯一出处，草稿/项目文件/导出共用） */
export const ALPHA_THRESHOLD = 128

/** 撤销栈帧数上限。单独按帧数封顶会让内存随画布面积线性膨胀，故同时有字节上限 */
export const HISTORY_MAX_FRAMES = 50
/**
 * 撤销栈字节上限。**这里必须按"整帧两份字节"算**：一帧快照 = indices + 可选 alphaMask，
 * 2048² 时各约 4MB，带 alpha 的单帧是 8MB（不是 4MB），所以 64MB 实际约 **8 帧**。
 * 弱机也不会 OOM。两条上限先到先算（淘汰逻辑在 app 层的撤销栈里）。
 */
export const HISTORY_MAX_BYTES = 64 * 1024 * 1024

/** 导出画布单边上限（Chromium 硬上限附近），倍数据此自动降档 */
export const MAX_EXPORT_SIDE = 16384
/** 导出面积上限：16384² = 268M 像素贴近硬上限，按面积再夹一道更稳 */
export const MAX_EXPORT_PIXELS = 64 * 1024 * 1024
/** 导出倍数单一来源：UI 菜单与 CLI 共用，避免两处列表漂移 */
export const EXPORT_SCALES = [1, 2, 4, 6, 8, 10, 12, 16, 20] as const

/** 自动取色（Median Cut）的颜色数范围与抽样阈值 */
export const PALETTE_K_MIN = 2
export const PALETTE_K_MAX = 64
/** 超过该格数时对取色抽样：切分是统计性聚类，几百万像素只会让盒内排序白白变慢 */
export const MEDIAN_CUT_SAMPLE_LIMIT = 250_000

/** 杂色清理阈值（小于该格数的连通色块并入邻域主色），与参数面板滑块上限一致 */
export const CLEANUP_MIN_SIZE_MIN = 1
export const CLEANUP_MIN_SIZE_MAX = 10

/** SVG 栅格化的长边范围：太小看不清笔画，太大只是浪费内存 */
export const SVG_RASTER_MIN = 512
export const SVG_RASTER_MAX = 4096

/** 编辑器偏好落盘防抖（localStorage 写入很便宜，但要避免每次拖色都写） */
export const PREFS_DEBOUNCE_MS = 400
/*
 * 下面两个是**给"自动草稿"预留的**（路线图 A2，尚未实现：目前刷新页面会丢失未导出的编辑）。
 * 先放在这里是因为草稿一旦实现，参数写得就是这两个数；留个说明免得下次审计把它们当死代码删掉。
 */
/** 自动草稿落盘防抖：编辑时每 800ms 存一次，兼顾"别丢"与"别卡" */
export const DRAFT_DEBOUNCE_MS = 800
/** 草稿格式版本：格式不兼容时直接丢弃重来，不做猜测式迁移 */
export const DRAFT_VERSION = 1

/** 参数与项目文件的 Schema 版本（v3：字段瘦身 + 透明单一开关） */
export const SCHEMA_VERSION = 3
/** 读取时接受的历史版本（v1 无 alpha；v2 无 transparent） */
export const SUPPORTED_VERSIONS = [1, 2, 3] as const
