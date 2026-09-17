/**
 * @otq/tinode-harmony —— Tinode 即时通讯协议的 HarmonyOS 客户端 SDK。
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
