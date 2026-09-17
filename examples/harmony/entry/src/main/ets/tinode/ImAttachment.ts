/**
 * tinode-harmony —— Tinode 即时通讯协议的 HarmonyOS 客户端 SDK。
 *
 * 许可：MIT（见同目录 LICENSE）。本实现为**独立 ArkTS 重写**；
 * 协议常量与报文形状参考 Tinode 官方文档与 Apache-2.0 的 `co/tinode/tinodesdk`（见 NOTICE）。
 */

/**
 * 附件模块（P2）——**纯逻辑**部分，无平台依赖、无 IO。
 *
 * 官方 Java SDK 的 `LargeFileHelper` 直接管上传/下载；本 SDK 保持"薄层 + 端口"的定位：
 * - **本文件**：附件元数据校验、**大文件分块规划**、分块进度合并、缓存键与 **LRU 淘汰规划**、
 *   以及 Drafty 实体（`IM/AU/VD/EX`）的**双向转换** —— 全是可以直接跑主机测试的纯函数；
 * - **端口**：真正的 HTTP 传输由平台实现（HarmonyOS 见 `AttachmentHttp.ets`，Node 侧可自己实现），
 *   所以核心 SDK 不引入任何网络依赖，也不用它的应用不受影响。
 *
 * 用法（宿主侧）：
 * ```ts
 * const check = validateAttachment({ name, mime, size });
 * if (!check.ok) { /* 提示用户 *\/ }
 * const drafty = attachmentDrafty({ name, mime, size }, refFromUpload, name);   // 发给对方
 * session.sendPub(topic, { mime: 'application/json' }, drafty);
 * ```
 */

import { DRAFTY_ENT_AUDIO, DRAFTY_ENT_FILE, DRAFTY_ENT_IMAGE, DRAFTY_ENT_VIDEO } from './Drafty.ts';
import type { Drafty, DraftyEntity } from './Drafty.ts';

/** 单块默认大小（512 KB）：小文件一块发完，大文件按块推进（官方 SDK 也是分块上传）。 */
export const DEFAULT_ATTACHMENT_CHUNK_BYTES = 512 * 1024;
/** 单文件默认上限（64 MB）。宿主可按自己的后端策略传 `limits` 覆盖。 */
export const DEFAULT_ATTACHMENT_MAX_BYTES = 64 * 1024 * 1024;
/** 附件缓存默认预算（256 MB）。 */
export const DEFAULT_ATTACHMENT_CACHE_BYTES = 256 * 1024 * 1024;

/** 附件元数据（与 Drafty `ent[].data` 的键一一对应）。 */
export interface AttachmentMeta {
  name: string;
  mime: string;
  size: number;
  /** 图片/视频的像素或时长等可选信息（透传给消息实体）。 */
  width?: number;
  height?: number;
  duration?: number;
  /** 内联预览（图片常见）：base64 或 ref。 */
  preview?: string;
  premime?: string;
}

/** 上传成功后服务端给的引用（`ref` 是 Tinode 侧的稳定标识，`url` 是可直接播放/下载的地址）。 */
export interface AttachmentRef {
  ref: string;
  url?: string;
}

/** 校验约束（宿主按后端能力传）。 */
export interface AttachmentLimits {
  maxBytes?: number;
  allowedMimes?: string[];
}

export interface AttachmentValidation {
  ok: boolean;
  /** 不通过时给用户可读的中文原因；通过时为空串。 */
  reason: string;
}

export interface ChunkPlan {
  index: number;
  offset: number;
  length: number;
}

export interface ChunkProgress {
  index: number;
  loaded: number;
  length: number;
  done: boolean;
}

/** 缓存条目（宿主把本地落盘文件登记进来，用于 LRU 淘汰）。 */
export interface CacheEntry {
  key: string;
  bytes: number;
  lastUsedAtMs: number;
}

/** 按 MIME 归类：决定 Drafty 实体类型（`IM` 图 / `AU` 音 / `VD` 视频 / `EX` 其它文件）。 */
export function attachmentKindOf(mime: string): string {
  const value = mime.toLowerCase();
  if (value.startsWith('image/')) return 'image';
  if (value.startsWith('audio/')) return 'audio';
  if (value.startsWith('video/')) return 'video';
  return 'file';
}

/** MIME → Drafty 实体类型（与 `Drafty.ts` 的白名单一致）。 */
export function draftyEntityTypeOf(mime: string): string {
  const kind = attachmentKindOf(mime);
  if (kind === 'image') return DRAFTY_ENT_IMAGE;
  if (kind === 'audio') return DRAFTY_ENT_AUDIO;
  if (kind === 'video') return DRAFTY_ENT_VIDEO;
  return DRAFTY_ENT_FILE;
}

/** 校验附件（大小/类型/文件名）。纯函数，宿主在选完文件后先调它。 */
export function validateAttachment(meta: AttachmentMeta, limits?: AttachmentLimits): AttachmentValidation {
  const maxBytes = limits === undefined || limits.maxBytes === undefined
    ? DEFAULT_ATTACHMENT_MAX_BYTES : limits.maxBytes;
  const allowed = limits === undefined ? undefined : limits.allowedMimes;
  if (meta.name.trim().length === 0) return { ok: false, reason: '文件名为空' };
  if (meta.mime.trim().length === 0) return { ok: false, reason: '文件类型未知' };
  if (!Number.isFinite(meta.size) || meta.size <= 0) return { ok: false, reason: '文件内容为空' };
  if (maxBytes > 0 && meta.size > maxBytes) {
    return { ok: false, reason: `文件超过上限（${Math.floor(maxBytes / 1024 / 1024)} MB）` };
  }
  if (allowed !== undefined && allowed.length > 0) {
    const hit = allowed.indexOf(meta.mime) >= 0;
    if (!hit) return { ok: false, reason: `不支持的格式：${meta.mime}` };
  }
  return { ok: true, reason: '' };
}

/** 大文件分块规划：返回每块的偏移与长度（最后一块可能不足）。 */
export function planChunks(totalBytes: number, chunkBytes: number = DEFAULT_ATTACHMENT_CHUNK_BYTES): ChunkPlan[] {
  const total = Number.isFinite(totalBytes) && totalBytes > 0 ? Math.floor(totalBytes) : 0;
  const size = Number.isFinite(chunkBytes) && chunkBytes > 0 ? Math.floor(chunkBytes) : DEFAULT_ATTACHMENT_CHUNK_BYTES;
  const plans: ChunkPlan[] = [];
  let offset = 0;
  let index = 0;
  while (offset < total) {
    const length = Math.min(size, total - offset);
    plans.push({ index: index, offset: offset, length: length });
    offset += length;
    index += 1;
  }
  return plans;
}

/** 初始进度表（来自 `planChunks`）。 */
export function initialProgress(plans: ChunkPlan[]): ChunkProgress[] {
  const list: ChunkProgress[] = [];
  for (let i = 0; i < plans.length; i++) {
    list.push({ index: plans[i].index, loaded: 0, length: plans[i].length, done: false });
  }
  return list;
}

/** 合并一块的上报进度（取最大值，避免乱序回调把进度打回去）。 */
export function mergeChunkProgress(list: ChunkProgress[], index: number, loaded: number): ChunkProgress[] {
  const next: ChunkProgress[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item.index !== index) {
      next.push(item);
      continue;
    }
    const value = Math.max(item.loaded, Math.min(loaded, item.length));
    next.push({ index: item.index, loaded: value, length: item.length, done: value >= item.length });
  }
  return next;
}

/** 已上传字节数。 */
export function uploadedBytesOf(list: ChunkProgress[]): number {
  let sum = 0;
  for (let i = 0; i < list.length; i++) sum += list[i].loaded;
  return sum;
}

/** 进度百分比（0–100，向下取整）；总长为 0 时返回 0。 */
export function progressPercent(uploaded: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const value = Math.floor((uploaded / total) * 100);
  if (value < 0) return 0;
  return value > 100 ? 100 : value;
}

/** 是否所有块都传完。 */
export function isUploadComplete(list: ChunkProgress[]): boolean {
  if (list.length === 0) return false;
  for (let i = 0; i < list.length; i++) {
    if (!list[i].done) return false;
  }
  return true;
}

/** 把附件包成消息内容（Drafty `{txt, ent:[{tp,data}]}`）。 */
export function attachmentDrafty(meta: AttachmentMeta, ref: AttachmentRef, text?: string): Drafty {
  const data: Record<string, string | number> = { name: meta.name, mime: meta.mime, size: meta.size, ref: ref.ref };
  if (ref.url !== undefined && ref.url.length > 0) data.url = ref.url;
  if (meta.width !== undefined) data.width = meta.width;
  if (meta.height !== undefined) data.height = meta.height;
  if (meta.duration !== undefined) data.duration = meta.duration;
  if (meta.preview !== undefined) data.preview = meta.preview;
  if (meta.premime !== undefined) data.premime = meta.premime;
  return { txt: text === undefined || text.length === 0 ? meta.name : text, ent: [{ tp: draftyEntityTypeOf(meta.mime), data: data }] };
}

/** 从消息内容里读出附件（读侧；不是附件消息返回 null）。 */
export function attachmentOfDrafty(drafty: Drafty | null | undefined): AttachmentMeta | null {
  if (drafty === null || drafty === undefined || drafty.ent === undefined) return null;
  for (let i = 0; i < drafty.ent.length; i++) {
    const entity: DraftyEntity = drafty.ent[i];
    if (entity.tp !== DRAFTY_ENT_IMAGE && entity.tp !== DRAFTY_ENT_AUDIO
      && entity.tp !== DRAFTY_ENT_VIDEO && entity.tp !== DRAFTY_ENT_FILE) {
      continue;
    }
    const data = entity.data;
    if (data === undefined) continue;
    const name = data.name === undefined ? '' : data.name;
    const mime = data.mime === undefined ? '' : data.mime;
    const size = data.size === undefined || !Number.isFinite(data.size) ? 0 : data.size;
    return {
      name: name, mime: mime, size: size,
      width: data.width, height: data.height, duration: data.duration,
      preview: data.preview, premime: data.premime
    };
  }
  return null;
}

/** 附件在本地缓存里的键（同一 ref + mime 稳定命中；无 hash 依赖，纯字符串）。 */
export function cacheKeyOf(ref: string, mime?: string): string {
  const key = ref.trim();
  const suffix = mime === undefined ? '' : `:${mime.trim().toLowerCase()}`;
  // 替换掉不适合做文件名的字符，保持与 ref 一一对应（不做有损 hash）。
  return `${key.replace(/[^A-Za-z0-9._-]/g, '_')}${suffix}`;
}

/** 缓存总占用。 */
export function cacheBytesOf(entries: CacheEntry[]): number {
  let sum = 0;
  for (let i = 0; i < entries.length; i++) sum += Math.max(0, entries[i].bytes);
  return sum;
}

/**
 * LRU 淘汰规划：超预算时返回**要删除的 key 列表**（最久未用优先）。
 * 纯计算，不删文件；宿主拿到列表后自己落盘删除。
 */
export function planEviction(entries: CacheEntry[], budgetBytes: number = DEFAULT_ATTACHMENT_CACHE_BYTES): string[] {
  const budget = Number.isFinite(budgetBytes) && budgetBytes > 0 ? budgetBytes : DEFAULT_ATTACHMENT_CACHE_BYTES;
  let total = cacheBytesOf(entries);
  if (total <= budget) return [];
  const sorted = entries.slice().sort((a: CacheEntry, b: CacheEntry) => a.lastUsedAtMs - b.lastUsedAtMs);
  const doomed: string[] = [];
  for (let i = 0; i < sorted.length && total > budget; i++) {
    doomed.push(sorted[i].key);
    total -= Math.max(0, sorted[i].bytes);
  }
  return doomed;
}

// ── 传输端口（真正的 HTTP 由平台实现；核心 SDK 不引入网络依赖） ────────────────

/** 上传请求（宿主把字节或其本地路径交给平台实现）。 */
export interface AttachmentUploadRequest {
  /** 目标地址（默认 Tinode 的 `{server}/v0/file/u/`，见 `attachmentUploadUrl`）。 */
  url: string;
  /** 需要带的头（例如 `X-Tinode-APIKey`、`Authorization`）。 */
  headers?: Record<string, string>;
  /** 表单字段名（Tinode 用 `file`）。 */
  fieldName?: string;
  fileName: string;
  mime: string;
  /** 内容字节（大文件时宿主可按 `planChunks` 自行分块调用）。 */
  bytes: ArrayBuffer;
  /** Tinode 的 `file/upload` 需要 `topic`（用于权限判断）。 */
  topic?: string;
}

/** 传输结果（成功与否看 `status`，正文原样带回由纯函数解析）。 */
export interface AttachmentHttpResult {
  status: number;
  body: string;
}

/** 平台传输端口：上传/下载。实现见 `AttachmentHttp.ets`（HarmonyOS）或宿主自建。 */
export interface AttachmentTransferPort {
  upload(request: AttachmentUploadRequest, onProgress?: (loaded: number, total: number) => void): Promise<AttachmentHttpResult>;
  download(url: string, headers?: Record<string, string>, onProgress?: (loaded: number, total: number) => void): Promise<AttachmentHttpResult>;
}

/** Tinode 文件上传地址：`{server}/v0/file/u/`（`server` 形如 `https://im.example.com:6061`）。 */
export function attachmentUploadUrl(serverBase: string): string {
  const base = serverBase.trim().replace(/\/+$/, '');
  return `${base}/v0/file/u/`;
}

/**
 * 从上传响应里解析引用（纯函数，便于测试）：
 * Tinode 返回 `{"id":"..."}`；有些部署返回 `{"ref":...}` 或带 `url`，这里都认。
 */
export function uploadedRefOf(body: string): AttachmentRef | null {
  if (body.trim().length === 0) return null;
  let raw: Object;
  try {
    raw = JSON.parse(body) as Object;
  } catch (_) {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, Object>;
  const id = record.id;
  const ref = record.ref;
  const url = record.url;
  const value = typeof id === 'string' && id.length > 0 ? id : (typeof ref === 'string' ? ref : '');
  if (value.length === 0) return null;
  return { ref: value, url: typeof url === 'string' && url.length > 0 ? url : undefined };
}
