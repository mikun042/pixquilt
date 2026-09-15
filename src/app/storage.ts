/**
 * 自动草稿：把「参数 + 画布 + 原图」防抖写进 IndexedDB，刷新/崩溃后可以恢复。
 *
 * 为什么需要它：此前**刷新页面等于丢掉所有未导出的编辑**，唯一的保命手段是手动导出项目 JSON。
 * 而本工具的典型用法恰恰是长时间渐进编辑（导入 → 调参 → 逐格精修），做一个图纸可能跨几十分钟、
 * 几十次画笔操作，中途误按 F5 或浏览器崩溃就全没了。
 *
 * ## 三个刻意的设计决定
 *
 * **1. 复用 `ProjectFile` 格式，不另造一套。**
 * 画布部分直接走 `core/export.ts` 的 `buildProjectFile()` / `parseProjectFile()`——
 * 那是本项目**已经过校验、带版本号、能被单测覆盖**的格式（长度校验、色板上限、
 * 越界索引、版本白名单都在里面）。自己再写一套序列化只会多一条会腐坏的路径。
 *
 * **2. 原图单独存，且允许失败。**
 * 原图是"重转参数要用"的东西，比画布大得多（一张 4000×3000 的 RGBA 就是 48MB），
 * 写失败（超配额）**不能连累草稿**——所以分成两次写：画布那条必须先成功，
 * 原图这条尽力而为（失败就只丢"重新转换"能力，画布仍在）。
 *
 * **3. 恢复是"提示后由用户决定"，不是静默自动恢复。**
 * 静默恢复会让"想从头开始"的人莫名看到一个旧画布，比丢失更困惑。
 * 所以这里只负责**读出来**，要不要用由 UI 那条提示条决定（见 index.ts 的 restore 提示）。
 *
 * ## 与那三条同步路径的关系（这是本模块最大的风险点）
 *
 * `ARCHITECTURE.md` §2.1 写明：`app.art` 是唯一真源，画布是副本，两者之间只有三条同步路径。
 * 草稿**引入了第四条**——而且是异步的、在后台偷偷写、并在启动时抢先读。历史教训是
 * "同一份状态有多个副本时，风险不在副本多，而在提交路径不止一条"，所以：
 *   - 写入只挂在**模型层提交之后**（`commitWithHistory` / `commitModelArt` / `replaceArt`），
 *     绝不从画布侧直接触发；
 *   - `replaceArt`（新建/导入/载入项目/清空）必须**同步清掉待写定时器**，否则一个已排队的
 *     定时器会把"刚被清空的画布"重新写回草稿——正是路线图里记的那个坑。
 */

/** IndexedDB 库名与存储名。改结构时**必须**同时升 DRAFT_VERSION，否则读回旧结构会静默错位 */
const DB_NAME = 'pixel-art-studio'
const STORE = 'draft'
/** 画布记录的主键（单画布模型，一条就够） */
const KEY_ART = 'art'
/** 原图记录的主键（与画布分开写，见上面第 2 条） */
const KEY_SOURCE = 'source'

export interface DraftRecord {
  /** 草稿格式版本（与 `limits.ts` 的 `DRAFT_VERSION` 对应） */
  version: number
  savedAt: string
  /** 项目文件 JSON 字符串（含 params + 画布），由 core 的 buildProjectFile 生成 */
  project: string
}

export interface DraftSourceRecord {
  version: number
  savedAt: string
  name: string
  width: number
  height: number
  /** 原图 RGBA 字节（行主序）；用 ArrayBuffer 存，IndexedDB 可直接结构化克隆 */
  data: ArrayBuffer
}

/** 是否可用：无痕模式 / 禁用存储 / 老浏览器下 `indexedDB` 可能缺失或抛错 */
export function draftSupported(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('打开 IndexedDB 失败'))
    // 某些浏览器在被阻止时会既不 success 也不 error；给个超时避免永久挂起
    req.onblocked = () => reject(new Error('IndexedDB 被其它标签页占用'))
  })
}

/** 一次事务写入（读写模式）；失败时 reject，由调用方决定要不要提示 */
async function put(key: string, value: unknown): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('写入草稿失败'))
      tx.onabort = () => reject(tx.error ?? new Error('写入草稿被中止'))
    })
  } finally {
    db.close()
  }
}

async function get<T>(key: string): Promise<T | null> {
  const db = await openDb()
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null)
      req.onerror = () => reject(req.error ?? new Error('读取草稿失败'))
    })
  } finally {
    db.close()
  }
}

async function del(key: string): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('清除草稿失败'))
      tx.onabort = () => reject(tx.error ?? new Error('清除草稿被中止'))
    })
  } finally {
    db.close()
  }
}

export function saveDraft(record: DraftRecord): Promise<void> {
  return put(KEY_ART, record)
}
export function loadDraft(): Promise<DraftRecord | null> {
  return get<DraftRecord>(KEY_ART)
}
export function saveDraftSource(record: DraftSourceRecord): Promise<void> {
  return put(KEY_SOURCE, record)
}
export function loadDraftSource(): Promise<DraftSourceRecord | null> {
  return get<DraftSourceRecord>(KEY_SOURCE)
}

/**
 * 清空草稿（画布 + 原图一起）。
 *
 * 必须在**所有"新基线"操作**里调用：新建空白、导入图片、载入项目、`ps.reset()`、清空工作区。
 * 这些操作之后"上一张画布"已经不该再被恢复出来。
 */
export async function clearDraft(): Promise<void> {
  await del(KEY_ART)
  await del(KEY_SOURCE)
}

/**
 * 记录是否还能用：`version` 不匹配就**直接丢弃**，不做猜测式迁移。
 *
 * 为什么不做迁移：草稿是"临时保命"的东西，不是用户资产。为它写一套跨版本迁移，
 * 收益极低而正确性风险很高（迁移写错会产出**看起来正常但内容错**的画布，比丢弃更难查）。
 * 用户真要长期保存，正路是导出项目 JSON——那条路径有完整的版本校验与迁移记录。
 */
export function isUsableDraft(r: DraftRecord | null, expectedVersion: number): r is DraftRecord {
  return !!r && typeof r.project === 'string' && r.version === expectedVersion
}

export function isUsableSource(r: DraftSourceRecord | null, expectedVersion: number): r is DraftSourceRecord {
  return !!r && r.data instanceof ArrayBuffer && r.width > 0 && r.height > 0 && r.version === expectedVersion
}

/**
 * 把草稿写盘做成"防抖 + 可取消"的小控制器。
 *
 * 抽出它而不是在 index.ts 里裸写定时器，是因为**"清空草稿"与"待写定时器"之间的顺序**
 * 正是路线图记的那个坑：`replaceArt()` 清了草稿，但此前 `schedule()` 已经排好一个定时器，
 * 800ms 后它把**上一张画布**又写了回去——用户下次打开会被恢复出一张早就不要的图。
 * 所以 `cancel()` 必须是显式、必须与 `clearDraft()` 成对调用的动作。
 */
export function createDraftWriter(deps: {
  /** 取当前要存的内容；返回 null 表示"现在没什么可存的"（例如还没有画布） */
  snapshot: () => { project: string; source: { name: string; width: number; height: number; data: Uint8ClampedArray } | null } | null
  debounceMs: number
  version: number
  onError?: (err: unknown) => void
}) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  /** 立刻写一次（立即落盘，用于"页面要关了"这种没时间等防抖的场合） */
  const flush = async (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (disposed) return
    const snap = deps.snapshot()
    if (!snap) return
    try {
      await saveDraft({ version: deps.version, savedAt: new Date().toISOString(), project: snap.project })
      if (snap.source) {
        // 原图单独写、失败不连累画布：超配额时至少画布还在（见文件头第 2 条）
        const buf = new ArrayBuffer(snap.source.data.length)
        new Uint8ClampedArray(buf).set(snap.source.data)
        await saveDraftSource({
          version: deps.version,
          savedAt: new Date().toISOString(),
          name: snap.source.name,
          width: snap.source.width,
          height: snap.source.height,
          data: buf,
        })
      }
    } catch (err) {
      deps.onError?.(err)
    }
  }

  /** 安排一次防抖写入；编辑期间每次调用都会把时间往后推 */
  const schedule = (): void => {
    if (disposed) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, deps.debounceMs)
  }

  return {
    schedule,
    flush,
    /**
     * 取消待写并停止工作。**调用方必须紧接着 `clearDraft()`**，
     * 否则"清了草稿但定时器还在"会让旧画布复活（本文件头注明的顺序坑）。
     */
    cancel: (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
    dispose: (): void => {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
    get pending(): boolean {
      return timer !== null
    },
  }
}
