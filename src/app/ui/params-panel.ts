/**
 * 参数面板：**预设区 + 转换参数 + 显示开关**。
 *
 * 从 `index.ts` 拆出来的（那片文件曾到 1700 行）。这里只做"渲染 + 把用户动作翻译成一个 deps 调用"，
 * 不持有也不推导任何画布/参数状态——所有读写都经 `ParamsPanelDeps` 走调用方。
 *
 * 为什么现在能拆了：面板里唯一"必须跨渲染存活"的状态是合成底色那块（含就地取色盘），
 * 它已经在 `matte-field.ts` 里自成一个工厂；剩下的 `presetEditorOpen` 是纯面板内状态，
 * 跟着工厂实例走即可。**上一轮拆不动，就是因为没先做这一步**（见 529f3b1 的提交说明）。
 */
import { DEFAULT_PARAMS, coerceParams, type ConvertParams, type PixelArt } from '../../core/types.ts'
import { PRESETS, getPreset, paletteCodes, parseHexPalette, serializeHexPalette, type PaletteSource } from '../../core/palettes.ts'
import { addCustomPreset, effectivePresets, removeCustomPreset, resetPreset, sameParams, updatePreset } from '../presets.ts'
import { colorTextOn } from '../../core/color.ts'
import { el } from '../store.ts'
import { createNumSlider, type NumSliderApi } from './num-slider.ts'
import type { MatteFieldApi } from '../matte-field.ts'

export interface ParamsPanelDeps {
  /** 参数面板的容器元素（`#panel-params`） */
  host: HTMLElement
  getParams: () => ConvertParams
  /** 改一小组参数：有原图时重转，否则重绘 */
  patch: (patch: Partial<ConvertParams>) => void
  /** 写入**整份**参数（套用预设 / 从精确尺寸切回长边时用），后续同上 */
  commitParams: (next: ConvertParams) => void
  getArt: () => PixelArt | null
  /** 面板状态变化后请调用方重渲染整个界面 */
  rerender: () => void
  toast: (message: string, kind?: 'info' | 'warn' | 'error') => void
  /**
   * 「显示」区的两个开关（它们存在 store 里，不属于转换参数）。
   * `setFlag` 的实现**必须顺带重绘画布**：画布是在 `draw()` 里读这两个值的，
   * 只改 store 的话勾选框会"没反应"（曾经如此，见 docs/架构.md §8.10 ④）。
   */
  getFlag: (key: 'showGrid' | 'showMag') => boolean
  setFlag: (key: 'showGrid' | 'showMag', value: boolean) => void
  /** 合成底色字段（含就地展开的取色盘），状态在它自己的工厂里 */
  matte: MatteFieldApi
}

export interface ParamsPanelApi {
  /** 重绘整个面板（`renderAll()` 里调用） */
  render: () => void
}

/* ------------------------------------------------------------------ 分组折叠状态 */

const COLLAPSE_KEY = 'pixelstudio.params.collapsed'

/**
 * 读取"用户显式改过的折叠状态"：`{ 分组 id: 是否展开 }`。
 * localStorage 不可用（无痕 / 禁用存储）时静默返回空对象，不报错——与项目对
 * "存储不可用就静默降级"的既有约定一致（存储不可用即静默降级、不弹提示、不报错）。
 */
function readCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(obj)) if (typeof v === 'boolean') out[k] = v
    return out
  } catch {
    return {}
  }
}

function writeCollapsed(map: Record<string, boolean>): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(map))
  } catch {
    /* 存储不可用：折叠态不持久化而已，不影响功能 */
  }
}

/**
 * 本次会话内用户**当场改过**的折叠状态：`{ 分组 id: 是否展开 }`。
 *
 * 为什么要与持久化分开：必须让**这次点击立刻生效**，而持久化值可能来自上一次会话。
 * 早先把状态只存在 localStorage、并用"从 map 里 delete"表示"不记忆"，
 * 结果 isSectionOpen 读不到值、回落到默认值，表现就是**点了标题栏毫无反应**
 * （用户报过的 bug）。所以分成两份状态：`sessionOpen` 管"当场"，localStorage 管"跨会话"。
 */
const sessionOpen = new Map<string, boolean>()

/**
 * 某分组当前是否展开。
 *
 * 取值优先级：
 *  1. 本次会话当场改过 → 听用户的（保证点击立即生效）
 *  2. 其余 → 用持久化值；没有则用代码里的默认值（除"预设"外，其余 9 组默认收起）
 */
function isSectionOpen(id: string, defaultOpen: boolean): boolean {
  if (sessionOpen.has(id)) return sessionOpen.get(id) === true
  const saved = readCollapsed()[id]
  return typeof saved === 'boolean' ? saved : defaultOpen
}

function toggleSection(id: string, open: boolean): void {
  // 当场状态记在内存里：保证点击立即生效
  sessionOpen.set(id, open)
  // 同时落盘，刷新后保持用户的选择
  const map = readCollapsed()
  map[id] = open
  writeCollapsed(map)
}

export function createParamsPanel(deps: ParamsPanelDeps): ParamsPanelApi {
  /**
   * 自定义 / .hex 色板编辑区。
   *
   * 为什么需要它：`paletteMode: 'custom'` 与 `customPalette` 一直是 core 与 CLI/页内 API 支持的能力
   * （CLI 的 `--palette xxx.hex` 就是走它），但**参数面板从来没有对应控件**——
   * 《使用说明》却写了"支持导入 .hex"，于是用户选中"自定义 / .hex"后什么也做不了，
   * 转换还静默按自动取色进行。这是"文档说支持、界面不支持"的典型，测试报告里列为 P1。
   *
   * 输入兼容两种 .hex 行式（见 core/palettes.ts 的 parseHexPalette）：
   *   `#rrggbb` 每行一个；或 `S12 #ff8800` 两列带号色（拼豆图纸用）。
   */
  function renderCustomPaletteField(p: ConvertParams): HTMLElement {
    const count = p.customPalette.length
    const fileInput = el('input', {
      type: 'file',
      accept: '.hex,.txt,text/plain',
      style: { display: 'none' },
      onchange: (e: Event) => {
        const f = (e.target as HTMLInputElement).files?.[0]
        ;(e.target as HTMLInputElement).value = ''
        if (!f) return
        void f.text().then((text) => {
          const parsed = parseHexPalette(text)
          if (parsed.colors.length === 0) {
            deps.toast('这个文件里没有解析出颜色（需要每行一个 #rrggbb，或「编号 #rrggbb」两列）', 'warn')
            return
          }
          /*
           * ⚠️ **号色必须一起存下来**（`customPaletteCodes`）。
           * 原先这里只存 `parsed.colors`，`parsed.codes` 解析完就被丢掉——于是用户
           * 导入自己的色卡后，图纸/清单上印的仍是自动编号 C1/C2…，
           * 而"编号与我的色卡对不对得上"正是拼豆用户最在意的事。
           */
          deps.patch({
            paletteMode: 'custom',
            customPalette: parsed.colors,
            customPaletteCodes: parsed.codes,
          })
          const codeNote = parsed.codes ? '，已带号色' : ''
          deps.toast(
            `已载入 ${parsed.colors.length} 个颜色${codeNote}${parsed.truncated ? `（超出 256 的部分已截断）` : ''}${parsed.skipped ? `，跳过 ${parsed.skipped} 行无法解析的内容` : ''}`,
          )
        })
      },
    })

    const textarea = el('textarea', {
      class: 'hex-textarea',
      spellcheck: 'false',
      rows: '5',
      placeholder: '#0f380f\n#306230\n或带号色：S12 #ff8800',
      onchange: (e: Event) => {
        const parsed = parseHexPalette((e.target as HTMLTextAreaElement).value)
        if (parsed.colors.length === 0) {
          deps.toast('没有解析出颜色：每行一个 #rrggbb，或「编号 #rrggbb」两列', 'warn')
          return
        }
        // 同理：手打的两列格式也要把号色一起收下
        deps.patch({ customPalette: parsed.colors, customPaletteCodes: parsed.codes })
        deps.toast(`自定义色板已更新为 ${parsed.colors.length} 色${parsed.codes ? '（含号色）' : ''}`)
      },
    })

    const row = el('div', { class: 'row wrap' })
    row.append(
      el('button', { class: 'btn tiny', type: 'button', onclick: () => fileInput.click() }, ['导入 .hex 文件']),
      el('button', {
        class: 'btn tiny',
        type: 'button',
        title: '把当前画布色板填进上面的输入框（便于改几个色再导入）',
        disabled: deps.getArt() ? false : true,
        onclick: () => {
          // 取一次存下来：`deps.getArt()` 是函数调用，连写两次 TS 收窄不了（也少调一次）
          const art = deps.getArt()
          if (!art) return
          textarea.value = serializeHexPalette(art.palette).trim()
          deps.toast('已填入当前画布色板，改完按回车（或在别处点一下）生效')
        },
      }, ['填入当前画布色板']),
      el('button', {
        class: 'btn tiny',
        type: 'button',
        disabled: count === 0 ? true : false,
        onclick: () => {
          textarea.value = ''
          deps.patch({ customPalette: [], customPaletteCodes: undefined })
        },
      }, ['清空']),
    )

    textarea.value = count > 0 ? serializeHexPalette(p.customPalette, p.customPaletteCodes).trim() : ''

    const field = el('div', { class: 'field-inner' }, [
      el('span', { class: 'hint' }, [
        count > 0
          ? `当前自定义色板：${count} 色（超 256 截断，空色板会退回自动取色）`
          : '⚠ 自定义色板为空：此时会退回「自动取色」，请在下面输入颜色或导入 .hex 文件',
      ]),
      textarea,
      row,
      el('span', { class: 'hint' }, ['每行一个 #rrggbb；也可用「编号 #rrggbb」两列（拼豆号色，图纸与清单会带上编号）']),
      fileInput,
    ])

    // 有号色时才出这张表：没号色的话它只是把颜色重复列一遍，白占地方
    if (count > 0 && p.customPaletteCodes?.some(Boolean)) field.append(renderCodesTable(p))
    return field
  }

  /**
   * 号色表：逐色显示「号色 / 色块 / hex」，允许**改号**与**删色**。
   *
   * 为什么需要它（路线图 A3）：拼豆用户的色卡品牌各异，建内卡只是近似色。
   * 光有"导入 .hex"还不够——真实使用的色卡常常是**有编号、需要微调**的：
   * 某个号色写错了、或者手上没有那一色想整体删掉。没有这张表就只能回去改文件重导。
   *
   * 两条实现约定：
   *  1. **改号走 `onchange`（失焦/回车才提交）**，不是每次按键都 patch——
   *     每按键都 patch 会触发重转管线，输入 `S12` 的过程中要白跑三次转换。
   *  2. **删色必须同步删号**：两条数组靠下标对齐，只删一边会让后面所有号色整体错位
   *     （图纸上的编号集体串行，比没有编号更糟）。所以这里永远成对操作。
   */
  function renderCodesTable(p: ConvertParams): HTMLElement {
    const colors = p.customPalette
    // 号色一律取"解析后的最终值"（缺项显示成 C1/C2…），否则用户看到的编号与图纸不一致
    const codes = paletteCodes(colors, p.customPaletteCodes)

    const setCode = (index: number, value: string): void => {
      const next = [...codes]
      next[index] = value.trim()
      deps.patch({ customPaletteCodes: next })
    }
    const removeColor = (index: number): void => {
      // 颜色与号色**一起**删，保持下标对齐（见上面第 2 条约定）
      const nextColors = colors.filter((_, i) => i !== index)
      const nextCodes = codes.filter((_, i) => i !== index)
      deps.patch({
        customPalette: nextColors,
        customPaletteCodes: nextCodes.some((c, i) => c !== `C${i + 1}`) ? nextCodes : undefined,
      })
      deps.toast(`已移除「${codes[index]}」${colors[index]}`)
    }

    const list = el('div', { class: 'codes-table', 'data-testid': 'codes-table' })
    colors.forEach((hex, i) => {
      const input = el('input', {
        class: 'code-input',
        type: 'text',
        spellcheck: false,
        value: codes[i],
        title: '改号色后按回车（或点别处）生效；图纸与清单会用它标注',
        'aria-label': `${hex} 的号色`,
        onchange: (e: Event) => setCode(i, (e.target as HTMLInputElement).value),
        /*
         * 回车必须**显式接管**：`onchange` 只在"值变了且失焦"时触发，
         * 单按回车**不会**触发它（Chrome/Edge 下实测确认）——而 tooltip 里写着"按回车生效"。
         * 不补这一条就又是一句空头承诺（本项目最忌讳的那类：界面承诺了、代码没兑现）。
         * 提交后主动 blur，让 DOM 与参数状态都落定，不留"看着改了其实没改"的中间态。
         */
        onkeydown: (e: KeyboardEvent) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          const target = e.target as HTMLInputElement
          setCode(i, target.value)
          target.blur()
        },
      })
      list.append(
        el('div', { class: 'code-line', 'data-testid': `code-line-${i}` }, [
          input,
          el('span', { class: 'code-chip', style: { background: hex, color: colorTextOn(hex) } }),
          el('span', { class: 'code-hex' }, [hex]),
          el('button', {
            class: 'btn tiny code-del',
            type: 'button',
            title: `从色板里移除这个颜色（${hex}）`,
            'data-testid': `code-del-${i}`,
            onclick: () => removeColor(i),
          }, ['删']),
        ]),
      )
    })

    return el('div', { class: 'codes-wrap' }, [
      el('span', { class: 'hint' }, ['号色表：可直接改编号，或删掉不需要的颜色（颜色与号色会一起删，避免编号错位）']),
      list,
    ])
  }


  /** 预设「管理」区是否展开。工厂级持有：面板每次 render 都重建 DOM，状态不能放在渲染函数里 */
  let presetEditorOpen = false

  /**
   * 图像调整的三个滑条（亮度 / 对比度 / 饱和度）。
   *
   * 与 `presetEditorOpen` 同一个理由留在工厂级：**面板每次 render 都重建 DOM**。
   * 但比它更进一步——滑条连**节点本身**都必须跨渲染存活（拖动中的指针捕获在节点上，
   * 重建即断，表现为"一拖就断"）。所以这里是惰性建一次、之后只复用，
   * 见 `renderParams` 里那段注释。
   */
  let adjustSliders: NumSliderApi[] | null = null

  /**
   * 套用预设 = **替换**，不是合并。
   *
   * 旧实现（模式与预设都）用 `patchParams(preset.params)` 合并进当前参数，于是上一个预设留下的
   * `exactWidth/exactHeight`、`lockPalette` 会残留——换预设后尺寸/锁色板并不是你选的那个
   * （实测：拼豆→游戏资产→图片，最后仍带着 exact 32×32 与锁色板）。以**出厂默认**为基底再叠预设，
   * 结果就只取决于"点了哪个预设"。
   */
  function applyPreset(params: Partial<ConvertParams>): void {
    deps.commitParams(coerceParams({ ...DEFAULT_PARAMS, ...params }))
  }

  /** 当前参数的快照（自定义色板要复制，否则存下来的预设会跟着后续编辑一起变） */
  function presetSnapshot(): ConvertParams {
    const cur = deps.getParams()
    /*
     * 两个数组都要**深拷一份**：预设会被长期存着，而参数里的数组是活的——
     * 共享引用的话，之后用户在面板里改号色/删色会**连带改掉已保存的预设**
     * （customPalette 原本就拷了，这轮加了 customPaletteCodes，同样要拷）。
     */
    return {
      ...cur,
      customPalette: [...cur.customPalette],
      customPaletteCodes: cur.customPaletteCodes ? [...cur.customPaletteCodes] : undefined,
    }
  }

  function saveCurrentAsPreset(): void {
    const input = prompt('新预设名称（会出现在右侧预设里）', '我的预设')
    if (input === null) return
    const name = input.trim()
    if (!name) {
      deps.toast('预设名称不能为空', 'warn')
      return
    }
    const created = addCustomPreset(name, presetSnapshot())
    if (!created) {
      deps.toast('自定义预设已达数量上限，请先删掉几个', 'warn')
      return
    }
    deps.toast(`已保存预设「${created.name}」`)
    deps.rerender()
  }

  /**
   * 预设区：一排 chip（点击套用）+ 一行动作（存为预设 / 管理预设）。
   *
   * 「管理」默认收起——预设是"一次点一个"的控件，把更新/恢复出厂/删除全铺开会把面板压得很长。
   * 展开后每个预设一行：内置可「用当前参数更新」「恢复出厂」，自定义可「更新」「删除」。
   */
  /**
   * 预设区的内容（chip 行 + 动作条 + 可选的「管理」列表）。
   *
   * **返回 body 元素数组、自己不往 host 上挂**——这样才能并进 `section()` 那套折叠机制里
   * （与尺寸/色板等分组同一套标题栏、同一条 localStorage 折叠状态、同一批 data-testid）。
   * 标题也交给分组头，这里不再自己画 `.panel-title`：两处都有标题会出现"预设 / 预设"两个标题。
   */
  function presetSectionBody(): HTMLElement[] {
    const presets = effectivePresets()
    // 当前参数正好等于某个预设时高亮它——不然用户看不出"我现在用的是哪套"
    const activeId = presets.find((ps) => sameParams(ps.params, deps.getParams()))?.id ?? ''

    const row = el('div', { class: 'row wrap preset-row' })
    for (const ps of presets) {
      row.append(
        el('button', {
          class: `btn small preset-chip${ps.builtin ? '' : ' custom'}${ps.modified ? ' modified' : ''}${activeId === ps.id ? ' active' : ''}`,
          title: `${ps.desc}${ps.modified ? '\n（已按你的参数改过）' : ''}\n点击套用；要改它请用下面的「管理预设」`,
          onclick: () => applyPreset(ps.params),
        }, [ps.builtin ? ps.name : `★ ${ps.name}`]),
      )
    }

    const bar = el('div', { class: 'row wrap preset-bar' })
    bar.append(
      el('button', { class: 'btn tiny', title: '把当前面板里的参数存成一个新预设（可命名、可删除）', onclick: saveCurrentAsPreset }, ['＋ 存为预设']),
      el('button', { class: 'btn tiny', onclick: () => { presetEditorOpen = !presetEditorOpen; deps.rerender() } }, [presetEditorOpen ? '收起管理 ▴' : '管理预设 ▾']),
    )

    const body: HTMLElement[] = [row, bar]
    if (!presetEditorOpen) return body

    const list = el('div', { class: 'preset-editor' })
    for (const ps of presets) {
      list.append(
        el('div', { class: 'preset-line' }, [
          el('span', { class: 'preset-line-name', title: ps.desc }, [`${ps.name}${ps.modified ? ' ·已改' : ''}`]),
          el('button', {
            class: 'btn tiny',
            title: '把当前面板里的参数写回这个预设',
            onclick: () => {
              updatePreset(ps.id, presetSnapshot())
              deps.toast(`已用当前参数更新「${ps.name}」`)
              deps.rerender()
            },
          }, ['用当前参数更新']),
          ps.builtin
            ? el('button', {
                class: 'btn tiny',
                disabled: !ps.modified,
                title: '丢弃你的改动，恢复出厂参数',
                onclick: () => {
                  resetPreset(ps.id)
                  deps.toast(`「${ps.name}」已恢复出厂`)
                  deps.rerender()
                },
              }, ['恢复出厂'])
            : el('button', {
                class: 'btn tiny',
                title: '删除这个自定义预设',
                onclick: () => {
                  removeCustomPreset(ps.id)
                  deps.toast(`已删除预设「${ps.name}」`)
                  deps.rerender()
                },
              }, ['删除']),
        ]),
      )
    }
    body.push(list)
    return body
  }

  /**
   * 从「精确尺寸」切回「长边格数」：**必须显式删掉这两个字段**。
   * 留着它们时 `computeGridSize` 会用精确尺寸（exact 优先于 longEdge），
   * 于是长边控件看起来调了却没效果——实测踩过，所以单独一个函数、不走 patchParams。
   */
  function clearExactSize(): void {
    const next = { ...deps.getParams() }
    delete next.exactWidth
    delete next.exactHeight
    deps.commitParams(next)
  }

  /**
   * 参数面板：预设区 → 转换参数（按用途分组，避免把 23 个参数堆成一个长列表）→ 显示开关。
   *
   * 全部 10 个分组统一走 `section()`（含预设）：同一套标题栏、同一条 localStorage 折叠状态。
   * 只有**预设默认展开**（主入口 + 最高频动作），其余默认收起。
   */
  function renderParams(): void {
    // 只移除面板自己的子节点，**保留合成底色字段**（它含取色盘宿主，必须跨渲染存活，
    // 否则拖动中指针捕获会断、手感全失）——见 matte-field.ts 顶部第 2 条坑
    for (const child of [...deps.host.children]) {
      if (child !== deps.matte.element) child.remove()
    }
    const p = deps.getParams()

    /**
     * 字段工厂。
     *
     * `forId` 可选：给了就把标签关联到那个控件——`<label for>` 对 `<button>` 同样有效，
     * 于是"点标签也能触发"（用户点"合成底色"那四个字而没点色块是很常见的）。
     *
     * `testId` 可选：写到 `.field` 上作为 `data-testid`。**为什么需要它**：
     * 面板断言原先靠结构耦合定位控件（"第一个 select 就是尺寸方式"、`.field > label`
     * 文本含尺寸方式、"勾选框的下一个兄弟文本含网格线"）。这些写法一旦面板重排
     * （例如折叠分组）就会静默指错元素，而失败信息往往指向别处。
     * 用稳定的 data-testid 定位后，面板结构可以自由调整。
     */
    const field = (label: string, control: HTMLElement, hint?: string, forId?: string, testId?: string) =>
      el('div', testId ? { class: 'field', 'data-testid': testId } : { class: 'field' }, [
        el('label', forId ? { for: forId } : {}, [label]),
        control,
        hint ? el('span', { class: 'hint' }, [hint]) : null,
      ])

    /**
     * 创建一个可折叠分组。
     *
     * 三条设计约束（都是踩过或推演出来的，动它前先读）：
     *
     * 1. **收起用 `display:none`，绝不惰性渲染**。所有子节点始终在 DOM 里——
     *    页内 API 与 e2e 断言都靠 `querySelector` 找控件，把节点从 DOM 摘掉会让它们
     *    全部失效（"面板里找不到某控件"），而这类失败信息很难指向"分组被折叠了"。
     * 2. **默认展开的分组承载着"真鼠标命中"断言**（尺寸 / 合成底色 / 显示；预设算半个——
     *    它的 chip 断言走 `querySelector` + 程序化 `.click()`，折叠也不受影响，但它是面板
     *    主入口，仍然默认展开）。那些"真鼠标命中"断言要算元素屏幕坐标再 `elementFromPoint`，
     *    `display:none` 时 rect 全为 0，必然失败。所以它们必须默认展开。
     * 3. 折叠状态存 localStorage，但**读回来的值不能覆盖约束 2**：那几组若被用户折叠过，
     *    下一次打开也该是收起的（听用户的），约束 2 只约束"没有存过值时"的初值。
     */
    const section = (id: string, title: string, body: HTMLElement[], defaultOpen: boolean) => {
      const open = isSectionOpen(id, defaultOpen)
      const head = el('button', {
        class: `panel-head${open ? '' : ' collapsed'}`,
        type: 'button',
        'aria-expanded': open ? 'true' : 'false',
        'data-testid': `section-head-${id}`,
        onclick: () => {
          toggleSection(id, !isSectionOpen(id, defaultOpen))
          renderParams()
        },
      }, [el('span', { class: 'panel-caret' }, [open ? '▾' : '▸']), el('span', { class: 'panel-head-title' }, [title])])
      const box = el('div', {
        class: 'panel-body',
        'data-testid': `section-body-${id}`,
      }, body)
      // 收起态：直接给内联 display:none（不靠 CSS 类，避免样式表加载顺序影响）
      if (!open) box.style.display = 'none'
      return el('div', { class: `panel-section${open ? '' : ' is-collapsed'}`, 'data-testid': `section-${id}` }, [head, box])
    }

    /*
     * 预设区也并进同一套折叠机制（与尺寸/色板等分组长得一样、共用 localStorage 折叠状态）。
     *
     * **默认展开**：它是这条面板的主入口（三种用途都靠它一键切换），
     * 而且"点 chip 套用"是最高频动作——默认收起会让第一次用的人找不到怎么切用途。
     * 其余转换参数分组保持默认收起（次要、按需展开）。
     */
    deps.host.append(section('preset', '预设', presetSectionBody(), true))

    // 尺寸：**一套控件管两种方式**。「精确尺寸」时写入 exactWidth/Height，「长边」时显式删除（见 clearExactSize）
    const exactW = p.exactWidth ?? 0
    const exactH = p.exactHeight ?? 0
    const exact = exactW > 0 && exactH > 0
    const sizeFields: HTMLElement[] = []
    sizeFields.push(
      field(
        '尺寸方式',
        selectInput(
          exact ? 'exact' : 'long',
          [
            ['long', '长边格数（按比例）'],
            ['exact', '精确尺寸 W×H'],
          ],
          (v) => {
            if (v === 'exact') {
              const side = Math.max(1, Math.min(2048, Math.min(58, p.longEdge) || 32))
              deps.patch({ exactWidth: exact ? exactW : side, exactHeight: exact ? exactH : side })
            } else {
              clearExactSize()
            }
          },
        ),
        exact ? '帧尺寸恒等，引擎侧无需二次对齐' : '短边按原图宽高比取整',
        undefined,
        'size-mode',
      ),
    )
    if (exact) {
      sizeFields.push(
        field(
          '画布尺寸（格）',
          el('div', { class: 'row' }, [
            numberInput(exactW, 1, 2048, (v) => deps.patch({ exactWidth: v, exactHeight: exactH })),
            el('span', {}, ['×']),
            numberInput(exactH, 1, 2048, (v) => deps.patch({ exactWidth: exactW, exactHeight: v })),
          ]),
          '常见：拼豆方板 58×58（29×29 孔）· 游戏资产 16/24/32/48/64/128',
        ),
      )
      const quick = el('div', { class: 'row wrap' })
      for (const n of [16, 24, 32, 48, 58, 64, 96, 128]) {
        quick.append(el('button', { class: `btn tiny${exactW === n && exactH === n ? ' active' : ''}`, onclick: () => deps.patch({ exactWidth: n, exactHeight: n }) }, [`${n}²`]))
      }
      sizeFields.push(quick)
    } else {
      sizeFields.push(field('长边格数', numberInput(p.longEdge, 8, 2048, (v) => deps.patch({ longEdge: v })), `${p.longEdge} 格`))
      const quick = el('div', { class: 'row wrap' })
      for (const n of [16, 32, 48, 64, 96, 128, 256, 512]) {
        quick.append(el('button', { class: `btn tiny${p.longEdge === n ? ' active' : ''}`, onclick: () => deps.patch({ longEdge: n }) }, [String(n)]))
      }
      sizeFields.push(quick)
    }
    deps.host.append(section('size', '尺寸', sizeFields, false))

    // 裁剪比例：core 与 CLI（--crop）一直支持，但参数面板此前没有入口——
    // 用户只能靠 CLI/API 设置（测试报告 B6）。这里补上四档选择。
    const cropFields: HTMLElement[] = []
    cropFields.push(
      field(
        '裁剪比例',
        selectInput(
          p.cropRatio,
          [
            ['free', '保持原比例'],
            ['1:1', '1:1 方形'],
            ['4:3', '4:3'],
            ['16:9', '16:9'],
          ],
          (v) => deps.patch({ cropRatio: v as ConvertParams['cropRatio'] }),
        ),
        '按所选比例从中心裁剪原图（拼豆常用 1:1，游戏资产常用 1:1）',
      ),
    )
    deps.host.append(section('crop', '裁剪', cropFields, false))

    const paletteFields: HTMLElement[] = []
    paletteFields.push(
      field('色板', selectInput(p.paletteMode, [['auto', '自动提取'], ['preset', '预置色卡'], ['custom', '自定义 / .hex']], (v) => deps.patch({ paletteMode: v as ConvertParams['paletteMode'] }))),
    )
    if (p.paletteMode === 'preset') {
      /*
       * 19 张卡按 `source` 分三组显示（分组标题与色卡自己的声明同源，不在这里硬编码 id）。
       * 顺序刻意是"越可信越靠前"：官方硬件色表 → 社区整理品牌卡 → 自造近似色。
       * 组标题里带上"以实物为准"这类提示，让用户不必读文档也知道社区卡的边界。
       */
      const groups: { source: PaletteSource; group: string }[] = [
        { source: 'official', group: '官方硬件色表' },
        { source: 'community', group: '品牌拼豆（社区整理，以实物为准）' },
        { source: 'approximate', group: '通用近似色（不属任何品牌）' },
      ]
      const colorGroups = groups
        .map(({ source, group }) => ({
          group,
          items: PRESETS.filter((x) => x.source === source).map((x) => [x.id, x.name] as [string, string]),
        }))
        .filter((g) => g.items.length > 0)
      paletteFields.push(
        el('div', { class: 'field-inner' }, [
          selectInput(p.presetPaletteId, colorGroups, (v) => deps.patch({ presetPaletteId: v })),
          el('span', { class: 'hint' }, [getPreset(p.presetPaletteId)?.desc ?? '']),
        ]),
      )
    }
    if (p.paletteMode === 'auto') {
      paletteFields.push(field('颜色数', numberInput(p.paletteK, 2, 64, (v) => deps.patch({ paletteK: v }))))
    }
    if (p.paletteMode === 'custom') {
      paletteFields.push(renderCustomPaletteField(p))
    }
    deps.host.append(section('palette', '色板', paletteFields, false))

    // 降采样 / 抖动 / 杂色清理 / 图像调整：各自成组，便于按需展开
    deps.host.append(
      section('downsample', '降采样', [
        field('降采样', selectInput(p.downsample, [['average', '区域平均（照片）'], ['nearest', '最近邻（硬边）']], (v) => deps.patch({ downsample: v as ConvertParams['downsample'] }))),
      ], false),
    )
    deps.host.append(
      section('dither', '抖动', [
        field('抖动', selectInput(p.dither, [['none', '关闭'], ['floyd', 'Floyd–Steinberg'], ['bayer', 'Bayer']], (v) => deps.patch({ dither: v as ConvertParams['dither'] }))),
      ], false),
    )
    deps.host.append(
      section('cleanup', '杂色清理', [
        field('杂色清理', checkbox(p.cleanup, (v) => deps.patch({ cleanup: v })), '开启抖动时自动关闭（抖动的点就是杂色）'),
      ], false),
    )
    /*
     * 图像调整：三个值各占一行，**结构一次性建好、跨渲染复用**。
     *
     * 为什么不能像别的字段那样每次 `renderParams()` 现建：
     * 拖动滑条会连续改参数 → 每次都触发重跑管线 → `renderAll()` → 面板重建 DOM。
     * 若滑条节点跟着重建，"正在拖哪一个 / 指针捕获在谁身上"第一帧就被冲掉，表现为**一拖就断**。
     * 这与合成底色那块的处境相同（见 matte-field.ts 文件头第 2 条），因此同样收进
     * `createNumSlider()` 的闭包里，这里只持有实例、每次渲染把 `element` 放回原位。
     *
     * 三个都铺开而不是塞进一个 `.row`：亮度/对比度/饱和度是**要来回比着调**的一组参数
     * （调完对比度往往要回补亮度），并排三个数字输入框既看不清当前档位、也没法拖。
     */
    const adjustFields: HTMLElement[] = []
    if (!adjustSliders) {
      adjustSliders = [
        createNumSlider({
          label: '亮度',
          min: -100,
          max: 100,
          neutral: 0,
          title: '亮度 -100…100：0 为中位。拖动滑条时画面实时更新，松手即成一次编辑',
          get: () => deps.getParams().brightness,
          apply: (v) => deps.patch({ brightness: v }),
        }),
        createNumSlider({
          label: '对比度',
          min: -100,
          max: 100,
          neutral: 0,
          title: '对比度 -100…100：0 为中位，照片发灰先加这一项',
          get: () => deps.getParams().contrast,
          apply: (v) => deps.patch({ contrast: v }),
        }),
        createNumSlider({
          label: '饱和度',
          min: -100,
          max: 100,
          neutral: 0,
          title: '饱和度 -100…100：0 为中位，-100 为完全去色（灰度）',
          get: () => deps.getParams().saturation,
          apply: (v) => deps.patch({ saturation: v }),
        }),
      ]
    }
    for (const s of adjustSliders) {
      // 每次渲染都同步一次：值可能被预设、页内 API 或项目文件改掉，界面得跟上
      s.sync()
      adjustFields.push(s.element)
    }
    deps.host.append(section('adjust', '图像调整', adjustFields, false))
    const transparentFields: HTMLElement[] = [
      field('透明处理', selectInput(p.transparent, [['none', '不透明（合成到底色）'], ['key', '单色键控（导出透明）'], ['alpha', '真 alpha（保留原图透明）']], (v) => deps.patch({ transparent: v as ConvertParams['transparent'] }))),
    ]
    if (p.transparent !== 'alpha') {
      /*
       * 合成底色用**自家取色盘**，不用原生 `<input type="color">`：原生控件会弹出操作系统的调色板
       * （Windows 那个带吸管的弹窗），外观与本工具的取色器完全两回事，也没法用"本图用色 / 最近 / 预置色卡"。
       *
       * 字段本身（含就地展开的取色盘）由 `matte-field.ts` 的工厂负责：它持有那 5 个必须跨渲染
       * 存活的状态。这里只做两件事——**把稳定的 `element` 放回序列中的位置**，再让它同步一次外观。
       * `element` 是同一个节点（只创建一次），所以拖动中的指针捕获不会因为重渲染而断。
       */
      transparentFields.push(deps.matte.element)
      /*
       * ⚠️ 顺序要求：`matte.render()` 必须在**整个分组挂进文档之后**再调。
       *
       * 为什么：`render()` 里在"刚展开"时会 `host.scrollIntoView()` 把取色盘滚进视野。
       * 如果此时 element 还在一个尚未 append 的游离容器里，`scrollIntoView` 什么都做不了
       * **且不报错**——表现为"点了色块，取色盘在视口外，用户以为没反应"。
       * 重构前 element 是直接 append 到已经在文档里的 host，所以没暴露；改成先收集进数组、
       * 最后统一 append 之后，这个顺序就变成必须显式保证的了（下方 `matte.render()` 的调用点）。
       */
    } else {
      // 切到「真 alpha」后这个字段会消失，把就地的取色器一起收掉，别留下孤儿宿主
      deps.matte.collapseForAlpha()
    }
    // 锁定色板对三种用途都成立（拼豆/资产批次），因此常显，不再按"模式"藏起来
    transparentFields.push(
      field('锁定色板', checkbox(!!p.lockPalette, (v) => deps.patch({ lockPalette: v })), '只用给定色板，绝不新增颜色（拼豆/资产批次必备）', undefined, 'lock-palette'),
    )
    deps.host.append(section('matte', '透明处理', transparentFields, false))
    // 挂进文档之后再让合成底色字段同步外观（其中的 scrollIntoView 需要它在文档里，见上）
    if (p.transparent !== 'alpha') deps.matte.render()

    const displayFields: HTMLElement[] = []
    displayFields.push(
      el('div', { class: 'field', 'data-testid': 'display-toggles' }, [
        /*
         * 这两个开关必须**让画面跟上**（`setFlag` 的实现里含一次 `canvasApi.redraw()`）：
         * `store` 只通知关心该 key 的订阅者，而画布是在 `draw()` 里读它们的，
         * 少了这一跳就会"勾了没反应"，直到下一次无关重绘才突然生效。见 docs/架构.md §8.10 ④。
         *
         * ⚠️ 勾选框上挂 `data-testid` 是必需的：断言原先靠"勾选框的下一个兄弟元素文本含网格线"
         * 定位（`nextElementSibling`），那是绑死在 DOM 顺序上的写法——把这两个勾选框
         * 包进 `<label>`（更规范的无障碍写法）或调换顺序，断言就会找不到控件。
         */
        checkbox(deps.getFlag('showGrid'), (v) => deps.setFlag('showGrid', v), 'toggle-grid'),
        el('span', {}, [' 网格线']),
        el('br'),
        // showMag 同时管"笔刷足迹预览"与放大镜两处显示
        checkbox(deps.getFlag('showMag'), (v) => deps.setFlag('showMag', v), 'toggle-magnifier'),
        el('span', {}, [' 笔刷预览 / 放大镜']),
      ]),
    )
    deps.host.append(section('display', '显示', displayFields, false))
  }

  function numberInput(value: number, min: number, max: number, onCommit: (v: number) => void): HTMLInputElement {
    return el('input', {
      class: 'num',
      type: 'number',
      value: String(value),
      min: String(min),
      max: String(max),
      onchange: (e: Event) => {
        const raw = Number((e.target as HTMLInputElement).value)
        const v = Math.min(max, Math.max(min, Number.isFinite(raw) ? Math.round(raw) : value))
        onCommit(v)
      },
    })
  }

  /**
   * 下拉框。两种入参形态：
   *  - `[val, label][]` —— 平铺
   *  - `{ group: string; items: [val, label][] }[]` —— 带 `<optgroup>` 分组
   *
   * 为什么需要分组：预置色卡从 6 张变 19 张之后，平铺的列表既长又读不出结构
   * （"哪张是硬件色表、哪张是社区整理的品牌卡"全靠名称后缀猜）。
   * 分组维度直接用色卡自己的 `source` 字段，不在 UI 里硬编码 id ——
   * 声明与呈现同源，将来加第四类来源时这里不用改。
   */
  function selectInput(
    value: string,
    options: [string, string][] | { group: string; items: [string, string][] }[],
    onChange: (v: string) => void,
  ): HTMLSelectElement {
    const sel = el('select', { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) })
    const addOption = (parent: HTMLElement, val: string, label: string): void => {
      const opt = el('option', { value: val }, [label])
      if (val === value) opt.setAttribute('selected', '')
      parent.append(opt)
    }
    const grouped = options.length > 0 && !Array.isArray(options[0])
    if (grouped) {
      for (const g of options as { group: string; items: [string, string][] }[]) {
        // 空组不产出（否则会出现一个没有任何选项的分组标题）
        if (g.items.length === 0) continue
        const og = el('optgroup', { label: g.group })
        for (const [val, label] of g.items) addOption(og, val, label)
        sel.append(og)
      }
    } else {
      for (const [val, label] of options as [string, string][]) addOption(sel, val, label)
    }
    return sel
  }

  /**
   * 勾选框。`testId` 可选——挂 `data-testid` 供断言稳定定位（见上面 display-toggles 的说明）。
   */
  function checkbox(checked: boolean, onChange: (v: boolean) => void, testId?: string): HTMLInputElement {
    const input = el('input', {
      type: 'checkbox',
      onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked),
      ...(testId ? { 'data-testid': testId } : {}),
    })
    if (checked) input.setAttribute('checked', '')
    input.checked = checked
    return input
  }
  return { render: () => renderParams() }
}
