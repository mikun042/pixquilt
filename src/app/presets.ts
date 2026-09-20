/**
 * 预设（UI 侧）：让右侧「风格预设」可改、可存。
 *
 * 为什么要单独一层：`src/core/types.ts` 的 `STYLE_PRESETS` 是**出厂预设**，同时被页内 API
 * （`capabilities().stylePresets` / `applyStylePreset()` / `stylePreset()`）当作契约暴露给 agent。
 * 用户在工作台里改过的预设**绝不能写回 core**——否则 agent 拿到的"出厂参数"会随某个人调 UI 而变，
 * 同一份脚本在不同人的机器上跑出不同结果。所以这里把"用户改动"与"自定义预设"只存 localStorage，
 * 出厂值始终只读；`effectivePresets()` 负责把两者叠起来给 UI 用。
 *
 * 三层语义（改动前先读）：
 *   · **出厂**（core.STYLE_PRESETS）：只读，永不修改。
 *   · **覆盖**（overrides[id]）：用户对某个内置预设的改动；「恢复出厂」= 删掉这条。
 *   · **自定义**（custom[]）：用户新建的预设，与内置并列显示，可删。
 *
 * 之前的「工作模式」（图片→像素 / 拼豆图纸 / 游戏资产）就是另一套并行的参数打包机制，
 * 与预设职责重叠且内容不一致（模式漏设 cleanup、photo 模式是空对象）。现已合并到预设，
 * 三者的差异由 preset 内容表达（见 docs/使用手册.md）。
 */
import { DEFAULT_PARAMS, STYLE_PRESETS, coerceParams, type ConvertParams } from '../core/types.ts'

const KEY = 'pixel-build.presets'
/** 自定义预设数量上限：够用即可，避免 localStorage 被写爆、预设行拆成好几屏 */
const MAX_CUSTOM = 24

export interface UiPreset {
  id: string
  name: string
  desc: string
  /** true = 来自出厂 STYLE_PRESETS（可更新 / 可恢复出厂）；false = 用户新建（可删除） */
  builtin: boolean
  /** 内置预设是否被用户改过（自定义预设恒为 false） */
  modified: boolean
  /** 完整参数（已 coerce），可直接套用 */
  params: ConvertParams
}

interface StoredCustom {
  id: string
  name: string
  desc: string
  params: ConvertParams
}

interface StoredState {
  v: 1
  overrides: Record<string, ConvertParams>
  custom: StoredCustom[]
}

const EMPTY: StoredState = { v: 1, overrides: {}, custom: [] }

/**
 * 读盘。**坏数据一律丢弃而不是抛错**：localStorage 可能被手改、被早期版本写过，
 * 一个坏字段不该让整个界面起不来（这与 `sanitizePrefs` 的态度一致）。
 */
function load(): StoredState {
  let raw: unknown
  try {
    const text = localStorage.getItem(KEY)
    if (!text) return { ...EMPTY, overrides: {}, custom: [] }
    raw = JSON.parse(text)
  } catch {
    return { ...EMPTY, overrides: {}, custom: [] }
  }
  const src = raw as Partial<StoredState> | null
  if (!src || typeof src !== 'object' || src.v !== 1) return { ...EMPTY, overrides: {}, custom: [] }

  const overrides: Record<string, ConvertParams> = {}
  if (src.overrides && typeof src.overrides === 'object') {
    for (const [id, params] of Object.entries(src.overrides)) {
      // 只接受出厂里真实存在的 id，避免历史遗留的孤儿数据一直挂在状态里
      if (!STYLE_PRESETS.some((sp) => sp.id === id)) continue
      if (params && typeof params === 'object') overrides[id] = coerceParams(params)
    }
  }
  const custom: StoredCustom[] = []
  if (Array.isArray(src.custom)) {
    for (const c of src.custom) {
      if (!c || typeof c !== 'object') continue
      const name = typeof (c as StoredCustom).name === 'string' ? (c as StoredCustom).name.trim() : ''
      const id = typeof (c as StoredCustom).id === 'string' ? (c as StoredCustom).id : ''
      if (!name || !id) continue
      custom.push({
        id,
        name,
        desc: typeof (c as StoredCustom).desc === 'string' ? (c as StoredCustom).desc : '自定义预设',
        params: coerceParams((c as StoredCustom).params),
      })
      if (custom.length >= MAX_CUSTOM) break
    }
  }
  return { v: 1, overrides, custom }
}

function save(state: StoredState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* 无痕模式 / 配额满：静默忽略（与偏好持久化同一态度），界面照常可用 */
  }
}

/** 出厂预设 + 用户覆盖 + 自定义预设，按显示顺序返回 */
export function effectivePresets(): UiPreset[] {
  const st = load()
  const out: UiPreset[] = STYLE_PRESETS.map((sp) => {
    const ov = st.overrides[sp.id]
    return {
      id: sp.id,
      name: sp.name,
      desc: sp.desc,
      builtin: true,
      modified: !!ov,
      params: coerceParams({ ...DEFAULT_PARAMS, ...sp.params, ...(ov ?? {}) }),
    }
  })
  for (const c of st.custom) {
    out.push({ id: c.id, name: c.name, desc: c.desc, builtin: false, modified: false, params: coerceParams(c.params) })
  }
  return out
}

/** 把一个预设的参数改成 `params`（内置写入覆盖、自定义直接替换） */
export function updatePreset(id: string, params: ConvertParams): void {
  const st = load()
  if (STYLE_PRESETS.some((sp) => sp.id === id)) {
    st.overrides[id] = coerceParams(params)
  } else {
    const hit = st.custom.find((c) => c.id === id)
    if (!hit) return
    hit.params = coerceParams(params)
  }
  save(st)
}

/** 内置预设「恢复出厂」：删掉覆盖（对自定义预设无意义，调用方不会走到） */
export function resetPreset(id: string): void {
  const st = load()
  delete st.overrides[id]
  save(st)
}

/** 新建自定义预设；名称重复会自动加序号；数量超限返回 null（调用方据此提示） */
export function addCustomPreset(name: string, params: ConvertParams): UiPreset | null {
  const st = load()
  if (st.custom.length >= MAX_CUSTOM) return null
  const base = name.trim() || '我的预设'
  const taken = new Set([...STYLE_PRESETS.map((sp) => sp.name), ...st.custom.map((c) => c.name)])
  let finalName = base
  for (let i = 2; taken.has(finalName) && i < 100; i++) finalName = `${base} ${i}`
  const created: StoredCustom = {
    id: `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: finalName,
    desc: '自定义预设（保存在本机浏览器里）',
    params: coerceParams(params),
  }
  st.custom.push(created)
  save(st)
  return { ...created, builtin: false, modified: false }
}

export function removeCustomPreset(id: string): void {
  const st = load()
  st.custom = st.custom.filter((c) => c.id !== id)
  save(st)
}

/**
 * 两组参数是否完全相同。用于给"当前参数正好等于某个预设"时高亮那个 chip。
 * 用**排序后的键**做比较：参数对象的键顺序不稳定（合并/patch 的产物），直接 JSON.stringify 会误判。
 */
export function sameParams(a: ConvertParams, b: ConvertParams): boolean {
  const norm = (p: ConvertParams): string => {
    const bag = p as unknown as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(bag).sort()) if (bag[k] !== undefined) out[k] = bag[k]
    return JSON.stringify(out)
  }
  return norm(a) === norm(b)
}
