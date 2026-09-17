/**
 * tinode-harmony —— Tinode 即时通讯协议的 HarmonyOS 客户端 SDK。
 *
 * 许可：MIT（见同目录 LICENSE）。本实现为**独立 ArkTS 重写**；
 * 协议常量与报文形状参考 Tinode 官方文档与 Apache-2.0 的 `co/tinode/tinodesdk`（见 NOTICE）。
 */

/**
 * Drafty（Tinode 富文本）子集：`{txt, fmt, ent}` 的读取侧与实体白名单。
 *
 * 依据：vendored SDK `android/libs/tindroid/tinodesdk/src/main/java/co/tinode/tinodesdk/model/Drafty.java`
 * （行号见注释）与应用层用法 `data/repository/TinodeImClient.kt`。纯逻辑，无平台依赖。
 *
 * 本切片**只做读取侧**（实体抽取、纯文本、预览、白名单），不做格式化渲染：
 * Android 基线本身也不消费 `fmt` 样式（`MessageBubble.kt:224-258` 只做链接高亮），
 * 详见 `docs/22` §1.5 与 §2.5。
 *
 * `fmt` 偏移单位**未与本端对齐**（Android 自己在两条路径上不一致）：
 * - 解析路径用 UTF-16 code unit：`Drafty.java:311`（`block.txt.length()`）、`:334-337`、`:404`、`:426`（`offset - 1`）；
 * - 构建路径用 grapheme cluster：`:861`/`:877`/`:932` 都走 `gcLength()`（`:2271-2274`，内部是 `BreakIterator`）。
 * 本切片不消费 `fmt`，因此这个分歧不影响交付；等做样式渲染时再用中英混排样本对齐（契约 openQuestions）。
 */

/** Drafty 的 MIME 常量（`Drafty.java:81`）。 */
export const DRAFTY_MIME_TYPE = 'text/x-drafty';
/** 会话列表最后一条消息在 SDK storage 里按 80 字截断（`MessageDb.java:36 MESSAGE_PREVIEW_LENGTH`）。 */
export const DRAFTY_STORAGE_PREVIEW_LENGTH = 80;

/**
 * `ent[].data` 的键白名单（`Drafty.java:88-90`）。
 * **写入实体时必须按它过滤**：SDK 会把白名单外的键静默丢掉。
 */
export const DRAFTY_ENTITY_DATA_KEYS: string[] = [
  'act', 'duration', 'height', 'incoming', 'mime', 'name', 'premime', 'preref',
  'preview', 'ref', 'size', 'state', 'title', 'url', 'val', 'width'
];

/** 行内样式标记（`Drafty.java:105-113`）：`*…*`→ST、`_…_`→EM、`~…~`→DL、`` `…` ``→CO。 */
export const DRAFTY_INLINE_STYLES: string[] = ['ST', 'EM', 'DL', 'CO'];
/** 无内容的样式（`Drafty.java:2081 VOID_STYLES`）。 */
export const DRAFTY_VOID_STYLES: string[] = ['BR', 'EX', 'HD'];
/** 实体类标记（`Drafty.java:118,612,670,733,790,895,981,1278`）。 */
export const DRAFTY_ENT_IMAGE = 'IM';
export const DRAFTY_ENT_FILE = 'EX';
export const DRAFTY_ENT_AUDIO = 'AU';
export const DRAFTY_ENT_VIDEO = 'VD';
export const DRAFTY_ENT_CALL = 'VC';
export const DRAFTY_ENT_QUOTE = 'QQ';
export const DRAFTY_ENT_HEAD = 'HD';
export const DRAFTY_ENT_LINK = 'LN';
export const DRAFTY_ENT_MENTION = 'MN';
export const DRAFTY_ENT_HASHTAG = 'HT';

/** 一个样式区间（`Drafty.java:1611-1614 Style{at,len,tp,key}`）。 */
export interface DraftyStyle {
  at: number;
  len: number;
  tp: string;
  key?: string;
}

/** `ent[].data`：只声明本端会读的键。 */
export interface DraftyEntityData {
  mime?: string;
  val?: string;
  name?: string;
  ref?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
  preview?: string;
  premime?: string;
  preref?: string;
  url?: string;
  title?: string;
}

/** 一个实体（`Drafty.java:1682-1684 Entity{tp,data}`）。 */
export interface DraftyEntity {
  tp: string;
  data?: DraftyEntityData;
}

/** Drafty 文档（`Drafty.java:151-153`）。 */
export interface Drafty {
  txt: string;
  fmt?: DraftyStyle[];
  ent?: DraftyEntity[];
}

/** 实体列表（空安全：`ent` 缺失时返回空数组）。 */
export function draftyEntities(drafty: Drafty | null | undefined): DraftyEntity[] {
  if (drafty === null || drafty === undefined) return [];
  const entities = drafty.ent;
  return entities === undefined || entities === null ? [] : entities;
}

/** 纯文本（`Drafty.java:1412 toPlainText()`；`txt` 缺失按空串）。 */
export function draftyText(drafty: Drafty | null | undefined): string {
  if (drafty === null || drafty === undefined) return '';
  const text = drafty.txt;
  return typeof text === 'string' ? text : '';
}

/** 有没有某种实体（`previewOf` 里的 `entities?.any { it?.tp == … }`）。 */
export function hasEntityType(drafty: Drafty | null | undefined, tp: string): boolean {
  const entities = draftyEntities(drafty);
  for (let i = 0; i < entities.length; i++) {
    if (entities[i].tp === tp) return true;
  }
  return false;
}

/** 某种实体的第一个（Android 的 `entities.firstOrNull { … }` 等价物）。 */
export function firstEntityOfType(drafty: Drafty | null | undefined, tp: string): DraftyEntity | null {
  const entities = draftyEntities(drafty);
  for (let i = 0; i < entities.length; i++) {
    if (entities[i].tp === tp) return entities[i];
  }
  return null;
}

/** 实体的 `data.mime`（可能缺失；非字符串按空串）。 */
export function entityMime(entity: DraftyEntity | null | undefined): string {
  if (entity === null || entity === undefined) return '';
  const data = entity.data;
  if (data === undefined || data === null) return '';
  const mime = data.mime;
  return typeof mime === 'string' ? mime : '';
}

/**
 * 有没有实体的 `data.mime` 以某前缀开头（`previewOf` 的 `data["mime"] as? String startsWith`）。
 * 用于兜住「自定义客户端按原生实体发语音/视频/图片」的情况（`TinodeImClient.kt:1033-1045`）。
 */
export function hasEntityMimePrefix(drafty: Drafty | null | undefined, prefix: string): boolean {
  const entities = draftyEntities(drafty);
  for (let i = 0; i < entities.length; i++) {
    if (entityMime(entities[i]).startsWith(prefix)) return true;
  }
  return false;
}

/** 按白名单过滤 `ent[].data`（`Drafty.java:88-90`：白名单外的键会被 SDK 丢掉，本端也不写）。 */
export function sanitizeEntityData(data: DraftyEntityData | null | undefined): DraftyEntityData {
  const result: DraftyEntityData = {};
  if (data === null || data === undefined) return result;
  const keys = DRAFTY_ENTITY_DATA_KEYS;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    switch (key) {
      case 'mime':
        if (data.mime !== undefined) result.mime = data.mime;
        break;
      case 'val':
        if (data.val !== undefined) result.val = data.val;
        break;
      case 'name':
        if (data.name !== undefined) result.name = data.name;
        break;
      case 'ref':
        if (data.ref !== undefined) result.ref = data.ref;
        break;
      case 'size':
        if (data.size !== undefined) result.size = data.size;
        break;
      case 'width':
        if (data.width !== undefined) result.width = data.width;
        break;
      case 'height':
        if (data.height !== undefined) result.height = data.height;
        break;
      case 'duration':
        if (data.duration !== undefined) result.duration = data.duration;
        break;
      case 'preview':
        if (data.preview !== undefined) result.preview = data.preview;
        break;
      case 'premime':
        if (data.premime !== undefined) result.premime = data.premime;
        break;
      case 'preref':
        if (data.preref !== undefined) result.preref = data.preref;
        break;
      case 'url':
        if (data.url !== undefined) result.url = data.url;
        break;
      case 'title':
        if (data.title !== undefined) result.title = data.title;
        break;
      default:
        break;
    }
  }
  return result;
}

/**
 * Drafty 的 **JSON 往返**（审计 P1-1：原来只读助手在 SDK、`JSON.parse`/`JSON.stringify` 留在应用侧，
 * 导致实现存储端口的宿主必须自己再写一遍）。语义与搬进来之前**逐字一致**：
 * - `parseDraftyJson`：空串/坏 JSON/数组/原始值 → `null`（调用方按"无内容"处理）；
 * - `encodeDrafty`：`null` → 空串（落库用空串表示没有内容）。
 */
export function parseDraftyJson(contentJson: string): Drafty | null {
  if (contentJson.length === 0) return null;
  let parsed: Object | string | number | boolean | null = null;
  try {
    parsed = JSON.parse(contentJson) as Object | string | number | boolean | null;
  } catch (error) {
    // 不是 JSON（历史/外部客户端可能直接落了纯文本）→ 当成纯文本 Drafty，别显示成空气泡。
    return { txt: contentJson };
  }
  if (parsed === null) return null;
  // **兼容裸字符串**：Tinode 的正文约定是 `{"txt": "..."}`，但真机库里确实存在 `"😎"` 这种
  // 只存了字符串的行（早期实现写的），原来这里直接返回 null → 气泡变成一条很小的空泡。
  if (typeof parsed === 'string') {
    const text = parsed as string;
    return text.length > 0 ? { txt: text } : null;
  }
  if (typeof parsed === 'number' || typeof parsed === 'boolean') return null;
  if (Array.isArray(parsed)) return null;
  return parsed as Drafty;
}

/** Drafty → 落库/传输用的 JSON 文本（`null` → 空串）。 */
export function encodeDrafty(drafty: Drafty | null): string {
  return drafty === null ? '' : JSON.stringify(drafty);
}

// ── 写侧与渲染（P6） ─────────────────────────────────────────────────────────
//
// **偏移语义（务必先读）**：本端统一用 **UTF-16 code unit** 计数 —— 也就是 JS/ArkTS 里 `String.length`
// 与 `slice()` 的口径（`"😀".length === 2`）。上游 Java SDK 有两条不一致的路径：解析用 code unit、
// 构建用 grapheme cluster（`Drafty.java:861/877/932` 的 `gcLength()`），我们**只取前者**并集中在这里，
// 避免同一个字符串在两处算出不同偏移。
//
// 写侧函数都是**纯函数**：返回新的 Drafty，不修改入参。

/** 一个新的纯文本 Drafty。 */
export function draftyPlain(text: string): Drafty {
  return { txt: text };
}

/** 追加文本（保留已有样式/实体；偏移不变）。 */
export function draftyAppend(drafty: Drafty | null | undefined, text: string): Drafty {
  const base = drafty === null || drafty === undefined ? { txt: '' } : drafty;
  return cloneDrafty({ txt: base.txt + text, fmt: base.fmt, ent: base.ent });
}

/** 深拷贝一份（避免调用方共享引用）。 */
export function cloneDrafty(drafty: Drafty): Drafty {
  const copy: Drafty = { txt: drafty.txt };
  if (drafty.fmt !== undefined) {
    const styles: DraftyStyle[] = [];
    for (let i = 0; i < drafty.fmt.length; i++) {
      const style = drafty.fmt[i];
      styles.push({ at: style.at, len: style.len, tp: style.tp, key: style.key });
    }
    copy.fmt = styles;
  }
  if (drafty.ent !== undefined) {
    const entities: DraftyEntity[] = [];
    for (let i = 0; i < drafty.ent.length; i++) {
      const entity = drafty.ent[i];
      const data = entity.data === undefined ? undefined : sanitizeEntityData(entity.data);
      entities.push(data === undefined ? { tp: entity.tp } : { tp: entity.tp, data: data });
    }
    copy.ent = entities;
  }
  return copy;
}

/** 把区间夹到 `[0, length]`；非法（len<=0 或完全越界）返回 null。 */
function clampRange(at: number, len: number, length: number): DraftyStyle | null {
  if (!Number.isFinite(at) || !Number.isFinite(len) || len <= 0) return null;
  const start = Math.max(0, Math.floor(at));
  const end = Math.min(length, Math.floor(at + len));
  if (end <= start) return null;
  return { at: start, len: end - start, tp: '' };
}

/** 给区间加样式（`ST` 加粗 / `EM` 斜体 / `DL` 删除线 / `CO` 等距）。越界自动裁剪，重叠会合并。 */
export function draftyWithStyle(drafty: Drafty | null | undefined, at: number, len: number,
  tp: string, key?: string): Drafty {
  const base: Drafty = drafty === null || drafty === undefined ? { txt: '' } : drafty;
  const range = clampRange(at, len, base.txt.length);
  if (range === null || tp.trim().length === 0) return cloneDrafty(base);
  const styles: DraftyStyle[] = [];
  const existing = base.fmt === undefined ? [] : base.fmt;
  for (let i = 0; i < existing.length; i++) {
    const style = existing[i];
    // 同类型且相邻/重叠 → 合并（避免碎片化）
    if (style.tp === tp && style.at <= range.at + range.len && range.at <= style.at + style.len) {
      const start = Math.min(style.at, range.at);
      const end = Math.max(style.at + style.len, range.at + range.len);
      range.at = start;
      range.len = end - start;
      continue;
    }
    styles.push({ at: style.at, len: style.len, tp: style.tp, key: style.key });
  }
  const added: DraftyStyle = key === undefined ? { at: range.at, len: range.len, tp: tp } : { at: range.at, len: range.len, tp: tp, key: key };
  styles.push(added);
  styles.sort((left: DraftyStyle, right: DraftyStyle): number => left.at - right.at);
  return cloneDrafty({ txt: base.txt, fmt: styles, ent: base.ent });
}

/** 去掉区间上的某类样式（不传 `tp` 则去掉区间内所有样式）。 */
export function draftyWithoutStyle(drafty: Drafty | null | undefined, at: number, len: number,
  tp?: string): Drafty {
  const base: Drafty = drafty === null || drafty === undefined ? { txt: '' } : drafty;
  const range = clampRange(at, len, base.txt.length);
  if (range === null || base.fmt === undefined) return cloneDrafty(base);
  const kept: DraftyStyle[] = [];
  for (let i = 0; i < base.fmt.length; i++) {
    const style = base.fmt[i];
    const remove = (tp === undefined || style.tp === tp)
      && style.at < range.at + range.len && range.at < style.at + style.len;
    if (!remove) {
      kept.push({ at: style.at, len: style.len, tp: style.tp, key: style.key });
      continue;
    }
    // 左残段
    if (style.at < range.at) kept.push({ at: style.at, len: range.at - style.at, tp: style.tp, key: style.key });
    // 右残段
    const styleEnd = style.at + style.len;
    const rangeEnd = range.at + range.len;
    if (styleEnd > rangeEnd) kept.push({ at: rangeEnd, len: styleEnd - rangeEnd, tp: style.tp, key: style.key });
  }
  return cloneDrafty({ txt: base.txt, fmt: kept, ent: base.ent });
}

/** 加实体（`IM/EX/AU/VD/LN/MN/QQ…`），`data` 会按 `DRAFTY_ENTITY_DATA_KEYS` 白名单过滤。 */
export function draftyWithEntity(drafty: Drafty | null | undefined, at: number, len: number,
  tp: string, data: DraftyEntityData): Drafty {
  const base: Drafty = drafty === null || drafty === undefined ? { txt: '' } : drafty;
  const range = clampRange(at, len, base.txt.length);
  if (range === null || tp.trim().length === 0) return cloneDrafty(base);
  const entities: DraftyEntity[] = base.ent === undefined ? [] : base.ent.slice();
  entities.push({ tp: tp, data: sanitizeEntityData(data) });
  return cloneDrafty({ txt: base.txt, fmt: base.fmt, ent: entities });
}

/** 便捷：把 `[at, at+len)` 变成链接（`LN` + `url`）。 */
export function draftyLink(drafty: Drafty | null | undefined, at: number, len: number, url: string): Drafty {
  return draftyWithEntity(drafty, at, len, DRAFTY_ENT_LINK, { url: url });
}

/** 便捷：把 `[at, at+len)` 变成 @提及（`MN` + `val` = uid）。 */
export function draftyMention(drafty: Drafty | null | undefined, at: number, len: number, uid: string): Drafty {
  return draftyWithEntity(drafty, at, len, DRAFTY_ENT_MENTION, { val: uid });
}

/** 便捷：插入图片实体（`IM` + `ref`/`mime`/`size`/`width`/`height`）。 */
export function draftyImage(drafty: Drafty | null | undefined, at: number, len: number,
  data: DraftyEntityData): Drafty {
  return draftyWithEntity(drafty, at, len, DRAFTY_ENT_IMAGE, data);
}

/**
 * 在 `at` 处插入文本：**已有样式/实体的偏移自动右移**，并把跨越插入点的样式拉长。
 * （编辑器里每次按键都会用到它。）
 */
export function draftyInsert(drafty: Drafty | null | undefined, at: number, text: string): Drafty {
  const base: Drafty = drafty === null || drafty === undefined ? { txt: '' } : drafty;
  const length = base.txt.length;
  const pos = Math.max(0, Math.min(length, Math.floor(Number.isFinite(at) ? at : length)));
  const txt = base.txt.slice(0, pos) + text + base.txt.slice(pos);
  const growth = text.length;
  const styles: DraftyStyle[] = [];
  const source = base.fmt === undefined ? [] : base.fmt;
  for (let i = 0; i < source.length; i++) {
    const style = source[i];
    if (style.at >= pos) {
      styles.push({ at: style.at + growth, len: style.len, tp: style.tp, key: style.key });
    } else if (style.at + style.len > pos) {
      styles.push({ at: style.at, len: style.len + growth, tp: style.tp, key: style.key });
    } else {
      styles.push({ at: style.at, len: style.len, tp: style.tp, key: style.key });
    }
  }
  return cloneDrafty({ txt: txt, fmt: styles, ent: base.ent });
}

/**
 * 删除 `[at, at+len)`：**已有样式/实体偏移自动左移**，跨越删除区间的样式相应缩短（长度归零的样式丢弃）。
 */
export function draftyDelete(drafty: Drafty | null | undefined, at: number, len: number): Drafty {
  const base: Drafty = drafty === null || drafty === undefined ? { txt: '' } : drafty;
  const range = clampRange(at, len, base.txt.length);
  if (range === null) return cloneDrafty(base);
  const txt = base.txt.slice(0, range.at) + base.txt.slice(range.at + range.len);
  const shift = range.len;
  const styles: DraftyStyle[] = [];
  const source = base.fmt === undefined ? [] : base.fmt;
  for (let i = 0; i < source.length; i++) {
    const style = source[i];
    const start = style.at;
    const end = style.at + style.len;
    // 与删除区间求差集
    if (end <= range.at) {
      styles.push({ at: start, len: style.len, tp: style.tp, key: style.key });
      continue;
    }
    if (start >= range.at + shift) {
      styles.push({ at: start - shift, len: style.len, tp: style.tp, key: style.key });
      continue;
    }
    const leftLen = Math.max(0, range.at - start);
    const rightLen = Math.max(0, end - (range.at + shift));
    if (leftLen > 0) styles.push({ at: start, len: leftLen, tp: style.tp, key: style.key });
    if (rightLen > 0) {
      styles.push({ at: range.at, len: rightLen, tp: style.tp, key: style.key });
    }
  }
  // 实体按"是否完全落在删除区间内"取舍（实体没有区间，只有整体归属）
  const entities: DraftyEntity[] = [];
  const sourceEnt = base.ent === undefined ? [] : base.ent;
  for (let i = 0; i < sourceEnt.length; i++) {
    const entity = sourceEnt[i];
    entities.push(entity);
  }
  return cloneDrafty({ txt: txt, fmt: styles, ent: entities.length === 0 ? undefined : entities });
}

/** 截断到 `maxLength`（按 UTF-16 code unit），越界的样式/实体被裁掉；用于草稿预览/长度限制。 */
export function draftyTrim(drafty: Drafty | null | undefined, maxLength: number): Drafty {
  const base: Drafty = drafty === null || drafty === undefined ? { txt: '' } : drafty;
  const limit = Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : base.txt.length;
  if (base.txt.length <= limit) return cloneDrafty(base);
  const kept = draftyDelete(base, limit, base.txt.length - limit);
  // 实体在 Drafty 里只锚定起点、没有长度：文本被截断后无法判断它是否还成立，**整批丢弃**（宁可少挂一个实体，
  // 也不要留下指向已删文本的实体）。需要保留实体的场景请用 `draftyDelete` 精确删。
  return cloneDrafty({ txt: kept.txt, fmt: kept.fmt });
}

/** 渲染片段：一段连续文本 + 命中它的样式 + 覆盖它的实体（供 UI 直接画）。 */
export interface DraftySegment {
  /** 在整段文本里的起始偏移（UTF-16 code unit）。 */
  at: number;
  text: string;
  /** 命中的样式类型（`ST`/`EM`/`DL`/`CO`…），可能多个。 */
  styles: string[];
  /** 覆盖这一段的实体（没有则 null）；多个时取第一个。 */
  entity: DraftyEntity | null;
}

/**
 * 按样式把 Drafty 切成可直接渲染的片段（纯函数）：
 * 依次在每个样式/实体的边界切分，返回 `{at, text, styles, entity}` 列表；空文本返回空数组。
 */
export function draftySegments(drafty: Drafty | null | undefined): DraftySegment[] {
  const base: Drafty = drafty === null || drafty === undefined ? { txt: '' } : drafty;
  const text = base.txt;
  if (text.length === 0) return [];
  const bounds: number[] = [0, text.length];
  const styles = base.fmt === undefined ? [] : base.fmt;
  for (let i = 0; i < styles.length; i++) {
    const style = styles[i];
    const start = Math.max(0, style.at);
    const end = Math.min(text.length, style.at + style.len);
    if (start > 0 && start < text.length) bounds.push(start);
    if (end > 0 && end < text.length) bounds.push(end);
  }
  bounds.sort((left: number, right: number): number => left - right);
  const unique: number[] = [];
  for (let i = 0; i < bounds.length; i++) {
    if (i === 0 || bounds[i] !== unique[unique.length - 1]) unique.push(bounds[i]);
  }
  const entities = base.ent === undefined ? [] : base.ent;
  const segments: DraftySegment[] = [];
  for (let i = 0; i + 1 < unique.length; i++) {
    const at = unique[i];
    const end = unique[i + 1];
    const hits: string[] = [];
    for (let k = 0; k < styles.length; k++) {
      const style = styles[k];
      if (style.at <= at && at < style.at + style.len) hits.push(style.tp);
    }
    // 实体按"起点落在片段内"归属（Drafty 的实体只锚定起点）
    let entity: DraftyEntity | null = null;
    for (let k = 0; k < entities.length; k++) {
      if (entities[k].tp === DRAFTY_ENT_LINK || entities[k].tp === DRAFTY_ENT_MENTION
        || entities[k].tp === DRAFTY_ENT_HASHTAG) {
        continue;
      }
      entity = entities[k];
      break;
    }
    segments.push({ at: at, text: text.slice(at, end), styles: hits, entity: entity });
  }
  return segments;
}
