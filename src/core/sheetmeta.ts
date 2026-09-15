/**
 * 图集元数据的**多引擎导出**：把 `layoutSheet()` 的坐标表翻译成各引擎认识的格式。
 *
 * 为什么需要它：现在只有 `_sheet.json`（自定义结构）。它对人可读、对自写脚本方便，
 * 但引擎不认——Godot 要 `.tres` 资源、Unity 要 `.meta` 的 `spriteSheet`、Tiled 要 `.tsx`。
 * 让用户自己写转换脚本，等于把"对坐标"这件事推给每个使用者各做一遍（还各有各的错法）。
 *
 * 设计约束（与 `core` 的其它模块一致）：
 *  - **纯函数**：只产出字符串/结构，不碰 fs、不碰 DOM，所以 CLI 与页内 API 都能用；
 *  - **不做像素**：只处理"帧在整图里的位置"，坐标由 `layoutSheet()` 算好传进来；
 *  - **诚实**：格式里表达不了的信息不做假装（例如 Tiled 的 tsx 不表达 pivot，
 *    就不往 properties 里硬塞一个语义不明的东西）。
 *
 * 坐标约定见 `layoutSheet()`：帧尺寸**恒等**（不裁边），内容偏移用 `offsetX/offsetY` 表达。
 */
import type { SheetFrame, SheetResult } from './export.ts'

/** 支持的引擎格式 id（CLI 的 `--engine` 用它） */
export const ENGINE_FORMATS = ['godot', 'unity', 'tiled'] as const
export type EngineFormat = (typeof ENGINE_FORMATS)[number]

export function isEngineFormat(v: string): v is EngineFormat {
  return (ENGINE_FORMATS as readonly string[]).includes(v)
}

/** 资源名清洗：各引擎对 id/资源名有自己的字符限制，统一成"字母数字下划线"最安全 */
function safeId(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_')
  // 不能以数字开头（Godot / Tiled 都会当成非法标识符）
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned
}

/** 转义 Godot 字符串字面量里的反斜杠与引号 */
function godotStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Godot 4 的 `SpriteFrames` 资源（`.tres`）。
 *
 * 结构：`SpriteFrames` 里有一个 `AtlasTexture`，其 `region` 指到整图上的矩形。
 * 这是 Godot 4 动画精灵的标准做法（4.x 用 `SpriteFrames`，不是 3.x 的 `Sprite` + `hframes`）。
 *
 * **为什么用 text 格式而不是二进制**：`.tres` 是文本、可 diff、可手改，
 * 而且不需要引入 Godot 的二进制序列化——与"零依赖"一致。
 *
 * 注意 `load_steps` 必须 = 资源数 + 1（Godot 会用它预分配；写错不会报错，但会在编辑器里
 * 出现奇怪的加载表现）。所以这里按实际帧数算，而不是写死。
 */
export function toGodotTres(sheet: SheetResult, opts: { texturePath: string; resourceName?: string }): string {
  const frames = sheet.frames
  const name = safeId(opts.resourceName ?? 'sheet')
  const lines: string[] = []
  lines.push(`[gd_resource type="SpriteFrames" load_steps=${frames.length + 1} format=3]`)
  lines.push('')
  lines.push(`[ext_resource type="Texture2D" path="${godotStr(opts.texturePath)}" id="1_tex"]`)
  lines.push('')
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    lines.push(`[sub_resource type="AtlasTexture" id="Atlas_${i}"]`)
    lines.push(`atlas = ExtResource("1_tex")`)
    lines.push(`region = Rect2(${f.x}, ${f.y}, ${f.width}, ${f.height})`)
    lines.push('')
  }
  lines.push('[resource]')
  // resource_name 让编辑器里显示成用户起的名字（不写就显示文件名，多张图集时不好认）
  lines.push(`resource_name = "${godotStr(name)}"`)
  // Godot 的 animations 是 Array[Dictionary]：每个 { "frames": [...], "loop": bool, "name": &"..." }
  // 单帧动画在我们这里没有意义，所以按"每个帧一条动画"导出——这样用户在 Godot 里
  // 能直接看到一列动画名，想合成一条就自己合并（比强行猜用户意图好）。
  const anims = frames
    .map((f, i) => `{\n"frames": [{\n"duration": 1.0,\n"texture": SubResource("Atlas_${i}")\n}],\n"loop": true,\n"name": &"${godotStr(safeId(f.name))}"\n}`)
    .join(', ')
  lines.push(`animations = [${anims}]`)
  lines.push('')
  return lines.join('\n')
}

/**
 * Unity 的 `.meta` 片段：`TextureImporter` 的 `spriteSheet.sprites` 列表。
 *
 * 为什么只出"片段"而不是完整 `.meta`：完整 `.meta` 里含 `guid`、`fileIDToRecycleName`
 * 等由 Unity 自己生成的字段，**伪造它们比让用户手工合并更危险**（guid 撞车会导致资源引用错乱）。
 * 所以这里产出的是"把你现有的 `.meta` 里 `spriteSheet:` 段替换成这段"的可粘贴内容，
 * 并在文件头用注释写明这一点。
 *
 * ⚠️ Unity 的 `.meta` 是 YAML，但**不吃标准 YAML 解析**（`--- !u!` 标签、制表符敏感）。
 * 这里按 Unity 自己写出来的形状生成：2 空格缩进、`- serializedVersion: 2` 开头。
 */
export function toUnityMetaSnippet(sheet: SheetResult, opts: { textureGuid: string; pixelsPerUnit?: number }): string {
  const ppu = opts.pixelsPerUnit ?? sheet.frames[0]?.height ?? 32
  const head = [
    '# 把下面 spriteSheet: 段替换进你现有的 <贴图名>.png.meta（**不要整个覆盖**——',
    '# .meta 里有 Unity 生成的 guid，覆盖会导致资源引用错乱）。',
    '# textureGuid 需填你那份 .meta 里已有的那个。',
    '',
  ].join('\n')
  const lines: string[] = []
  lines.push('  spriteSheet:')
  lines.push('    serializedVersion: 2')
  lines.push('    sprites:')
  for (const f of sheet.frames) {
    lines.push(`    - serializedVersion: 2`)
    lines.push(`      name: ${safeId(f.name)}`)
    // Unity 的 rect 原点在**左下**，而我们的 y 是从上往下数 → 必须换算，否则所有帧上下颠倒
    const unityY = sheet.height - f.y - f.height
    lines.push(`      rect:`)
    lines.push(`        serializedVersion: 2`)
    lines.push(`        x: ${f.x}`)
    lines.push(`        y: ${unityY}`)
    lines.push(`        width: ${f.width}`)
    lines.push(`        height: ${f.height}`)
    lines.push(`      alignment: 0`)
    lines.push(`      pivot: {x: 0.5, y: 0.5}`)
    lines.push(`      border: {x: 0, y: 0, z: 0, w: 0}`)
    lines.push(`      spriteID: `)
    lines.push(`      internalID: 0`)
  }
  lines.push(`    outline: []`)
  lines.push(`    physicsShape: []`)
  lines.push(`    bones: []`)
  lines.push(`    spriteID: `)
  lines.push(`    internalID: 0`)
  lines.push(`    vertices: []`)
  lines.push(`    indices: `)
  lines.push(`    edges: []`)
  lines.push(`    weights: []`)
  lines.push(`    secondaryTextures: []`)
  lines.push(`    nameFileIdTable: {}`)
  lines.push(`  mipmapLimitGroupName: `)
  lines.push(`  pixelsPerUnit: ${ppu}`)
  lines.push(`  spriteMeshType: 1`)
  lines.push(`  alignment: 0`)
  lines.push(`  spritePivot: {x: 0, y: 0}`)
  lines.push(`  spritePixelsToUnits: ${ppu}`)
  lines.push(`  spriteBorder: {x: 0, y: 0, z: 0, w: 0}`)
  lines.push(`  spriteGenerateFallbackPhysicsShape: 1`)
  lines.push('')
  lines.push(`# textureGuid 参考值（填进上面的 ext_resource 时用你自己的）：${opts.textureGuid}`)
  return head + lines.join('\n')
}

/**
 * Tiled 的 `.tsx` 图集瓦片集。
 *
 * 与另两个格式的区别：Tiled 的瓦片是**等尺寸网格**，用 `tilecount` / `columns` 表达，
 * 而不是逐个列矩形——所以这里用 `columns` + `tilecount`，只在"每个瓦片需要额外属性"时
 * 才逐个 `<tile>` 列出。我们的帧尺寸恒等且是规则网格，正好符合这个模型。
 *
 * ⚠️ 诚实说明：Tiled **没有 pivot 概念**，所以 `offsetX/offsetY` 在这里**表达不了**。
 * 不往 properties 里塞一个语义不明的字段（那会让下游以为它能用）。
 */
export function toTiledTsx(
  sheet: SheetResult,
  opts: { textureSource: string; name?: string; tileWidth?: number; tileHeight?: number; margin?: number; spacing?: number },
): string {
  const tileW = opts.tileWidth ?? sheet.frames[0]?.width ?? 32
  const tileH = opts.tileHeight ?? sheet.frames[0]?.height ?? 32
  const id = safeId(opts.name ?? 'sheet')
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  const margin = opts.margin ?? 0
  const spacing = opts.spacing ?? 0
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push(
    `<tileset version="1.10" tiledversion="1.10.2" name="${esc(id)}" tilewidth="${tileW}" tileheight="${tileH}" ` +
      `tilecount="${sheet.frames.length}" columns="${sheet.columns}" margin="${margin}" spacing="${spacing}">`,
  )
  lines.push(` <image source="${esc(opts.textureSource)}" width="${sheet.width}" height="${sheet.height}"/>`)
  lines.push('</tileset>')
  lines.push('')
  return lines.join('\n')
}

/** 按格式分发；CLI 与页内 API 都从这里走，避免两处各写一遍 switch */
export function exportSheetMeta(
  format: EngineFormat,
  sheet: SheetResult,
  opts: { texturePath: string; textureGuid?: string; name?: string; pixelsPerUnit?: number; tileWidth?: number; tileHeight?: number; margin?: number; spacing?: number },
): string {
  if (format === 'godot') return toGodotTres(sheet, { texturePath: opts.texturePath, resourceName: opts.name })
  if (format === 'unity') {
    if (!opts.textureGuid) {
      // 明确报错而不是留空：Unity 的 .meta 没有 guid 是无效的，静默产出会让用户以为可用
      throw new Error('Unity 格式需要 textureGuid（从你那份 .png.meta 里取），例如 --texture-guid <guid>')
    }
    return toUnityMetaSnippet(sheet, { textureGuid: opts.textureGuid, pixelsPerUnit: opts.pixelsPerUnit })
  }
  return toTiledTsx(sheet, {
    textureSource: opts.texturePath,
    name: opts.name,
    tileWidth: opts.tileWidth,
    tileHeight: opts.tileHeight,
    margin: opts.margin,
    spacing: opts.spacing,
  })
}

/** 各格式的推荐文件扩展名（CLI 生成文件名时用） */
export const ENGINE_EXT: Record<EngineFormat, string> = {
  godot: '.tres',
  unity: '.meta.txt',
  tiled: '.tsx',
}

export type { SheetFrame, SheetResult }
