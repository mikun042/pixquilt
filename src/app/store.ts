/**
 * 极简状态容器：**按 key 精确通知**。
 *
 * 为什么不用框架：编辑器主体是 canvas 2D + 指针事件 + 直写 DOM（拖动取色时每帧只改几个属性），
 * 框架的整树协调在这里是纯开销；按 key 订阅还能避免"鼠标每跨一格就重渲染整个应用"。
 * 约束见 重构计划 §16.3。
 *
 * 约定：
 *  - `get()` 只用于渲染或赋值瞬间，不要在事件回调里长期持有；
 *  - `set()` 只通知关心该 key 的订阅者；`setMany()` 用于一次交互改多个字段（只发一轮通知）；
 *  - `subscribe()` 返回取消函数，UI 模块在初始化时登记、销毁时取消。
 */
import { ALPHA_THRESHOLD } from '../core/limits.ts'
import { normalizeHex } from '../core/types.ts'

export interface EditorState {
  /** 当前画布（null = 未导入）。这里用 unknown 是为了让 store 不依赖 core 的具体类型，
   *  真正的类型约束在 canvas 与 automation 层的入参签名上。 */
  art: null
  tool: string
  primary: string
  bg: string
  brushSize: number
  /** 当前绘制色是否为「透明色」（画笔/填充/形状/清选区都挖洞） */
  transparent: boolean
  showGrid: boolean
  showMag: boolean
  showPicker: boolean
  selectedCount: number
  hasEdits: boolean
  zoomPct: number
  hoverText: string
  clipboardHas: boolean
  mode: 'photo' | 'beads' | 'asset'
}

export const initialState: EditorState = {
  art: null,
  tool: 'pencil',
  primary: '#1a1a1a',
  bg: '#ffffff',
  brushSize: 1,
  transparent: false,
  showGrid: true,
  showMag: true,
  showPicker: false,
  selectedCount: 0,
  hasEdits: false,
  zoomPct: 100,
  hoverText: '',
  clipboardHas: false,
  mode: 'photo',
}

type AnyKey = keyof EditorState
type Listener = (state: EditorState, key: string) => void

class Store {
  private current: EditorState = { ...initialState }
  private readonly listeners = new Map<string, Set<Listener>>()

  get state(): EditorState {
    return this.current
  }

  get<K extends AnyKey>(key: K): EditorState[K] {
    return this.current[key]
  }

  set<K extends AnyKey>(key: K, value: EditorState[K]): void {
    if (Object.is(this.current[key], value)) return
    this.current = { ...this.current, [key]: value }
    this.notify(key)
  }

  /** 一次交互改多个字段：只通知一轮，避免中间态导致画面闪烁 */
  setMany(patch: Partial<EditorState>): void {
    const bag = this.current as unknown as Record<string, unknown>
    const changed: string[] = []
    for (const [key, value] of Object.entries(patch)) {
      if (Object.is(bag[key], value)) continue
      changed.push(key)
    }
    if (changed.length === 0) return
    this.current = Object.assign({}, this.current, patch) as EditorState
    this.notify(...changed)
  }

  subscribe(keys: AnyKey | AnyKey[], fn: Listener): () => void {
    const list = Array.isArray(keys) ? keys : [keys]
    for (const key of list) {
      let set = this.listeners.get(key)
      if (!set) {
        set = new Set()
        this.listeners.set(key, set)
      }
      set.add(fn)
    }
    return () => {
      for (const key of list) this.listeners.get(key)?.delete(fn)
    }
  }

  private notify(...keys: string[]): void {
    const called = new Set<Listener>()
    for (const key of keys) {
      const set = this.listeners.get(key)
      if (!set) continue
      for (const fn of set) {
        if (called.has(fn)) continue
        called.add(fn)
        try {
          fn(this.current, key)
        } catch (err) {
          // 单个订阅者出错不应连带拖垮其它 UI 模块
          console.error(`[store] 订阅者处理 ${key} 时抛错：`, err)
        }
      }
    }
  }
}

export const store = new Store()

/* ------------------------------------------------------------------ DOM 小工具 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, unknown>> = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = String(value)
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value as Partial<CSSStyleDeclaration>)
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value as Record<string, string>)
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children) {
    if (child === null || child === undefined) continue
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

/** 颜色是否合法的唯一入口（store 侧只用到这一处校验） */
export function isValidHex(value: string): boolean {
  return normalizeHex(value) !== null
}

/** 透明阈值转发：UI 判断"某格是否透明"时用同一个口径 */
export const UI_ALPHA_THRESHOLD = ALPHA_THRESHOLD
