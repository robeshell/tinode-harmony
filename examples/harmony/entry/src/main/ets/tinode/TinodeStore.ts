/**
 * tinode-harmony —— Tinode 即时通讯协议的 HarmonyOS 客户端 SDK。
 *
 * 许可：MIT（见同目录 LICENSE）。本实现为**独立 ArkTS 重写**；
 * 协议常量与报文形状参考 Tinode 官方文档与 Apache-2.0 的 `co/tinode/tinodesdk`（见 NOTICE）。
 */

/**
 * 存储与缓存策略（P4）——**纯逻辑**，不碰数据库、不做 IO。
 *
 * 官方 Java SDK 自带 `Storage`/`LocalData`（缓存 + 未读 + 会话摘要）；本 SDK 保持"端口"定位，
 * 把**策略**做成纯函数，宿主无论用 RDB、文件还是内存都能复用：
 * - **去重合并**：同 `seq` 覆盖（服务端活数据优先于本地 echo），输出按 seq 升序；
 * - **未读**：`unreadOf`（按已读位点算，含"自己发的不算未读"）；
 * - **会话摘要**：`conversationSummaryOf` 给出最后一条、未读数、预览、排序时间；
 * - **容量控制**：`planMessageEviction` 按"每会话保留最近 N 条"给出该删的 `(topic, seq)`；
 * - **草稿预览**：`draftPreviewOf` 截断（对齐 Drafty 的预览长度约定）。
 */

import { draftyText } from './Drafty.ts';
import type { TinodeDraft, TinodeMessage, TinodeTopic } from './TinodeMessage.ts';

/** 消息主键（与 `TinodeMessage.id` 同口径：`<topic>-<seq>`）。 */
export function messageKeyOf(topic: string, seq: number): string {
  return `${topic}-${seq}`;
}

/** 一条消息是否"值得显示为未读"：不是自己发的、且 seq 大于已读位点。 */
export function isUnreadMessage(message: TinodeMessage, lastReadSeq: number): boolean {
  if (message.isMine) return false;
  return message.seq > (Number.isFinite(lastReadSeq) && lastReadSeq > 0 ? lastReadSeq : 0);
}

/** 未读数。 */
export function unreadOf(messages: TinodeMessage[], lastReadSeq: number): number {
  let count = 0;
  for (let i = 0; i < messages.length; i++) {
    if (isUnreadMessage(messages[i], lastReadSeq)) count += 1;
  }
  return count;
}

/**
 * 合并两组消息：**同 seq 覆盖**（incoming 优先）、按 seq 升序、剔除非法 seq。
 * 典型用法：`mergeMessages(已落库的一页, 新收到的若干条)`。
 */
export function mergeMessages(existing: TinodeMessage[], incoming: TinodeMessage[]): TinodeMessage[] {
  const bySeq: Map<number, TinodeMessage> = new Map();
  const put = (message: TinodeMessage): void => {
    if (!Number.isFinite(message.seq) || message.seq <= 0) return;
    bySeq.set(message.seq, message);
  };
  for (let i = 0; i < existing.length; i++) put(existing[i]);
  for (let i = 0; i < incoming.length; i++) put(incoming[i]);
  const rows: TinodeMessage[] = [];
  bySeq.forEach((message: TinodeMessage) => { rows.push(message); });
  rows.sort((left: TinodeMessage, right: TinodeMessage): number => left.seq - right.seq);
  return rows;
}

/** 最后一条消息（按 seq 最大；空列表返回 null）。 */
export function lastMessageOf(messages: TinodeMessage[]): TinodeMessage | null {
  let last: TinodeMessage | null = null;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!Number.isFinite(message.seq) || message.seq <= 0) continue;
    if (last === null || message.seq > last.seq) last = message;
  }
  return last;
}

/** 列表里展示用的预览文本（正文，最长 `maxLength`）。 */
export function previewOf(message: TinodeMessage | null, maxLength: number = 40): string {
  if (message === null) return '';
  const text = draftyText(message.content).replace(/\s+/g, ' ').trim();
  if (maxLength > 0 && text.length > maxLength) return `${text.slice(0, maxLength)}…`;
  return text;
}

/** 会话摘要（渲染会话列表用）。 */
export interface ConversationSummary {
  topic: string;
  name: string;
  peerUid: string;
  lastSeq: number;
  read: number;
  unread: number;
  preview: string;
  /** 排序用时间：最后一条消息的时间，没有消息时用会话自身的 `touchedAt`。 */
  sortAtMs: number;
  online: boolean;
}

/** 由会话 + 它的消息算出摘要（纯函数）。 */
export function conversationSummaryOf(topic: TinodeTopic, messages: TinodeMessage[],
  maxPreviewLength: number = 40): ConversationSummary {
  const last = lastMessageOf(messages);
  const lastSeq = last === null ? topic.seq : Math.max(topic.seq, last.seq);
  const read = Number.isFinite(topic.read) && topic.read > 0 ? topic.read : 0;
  return {
    topic: topic.topic,
    name: topic.name,
    peerUid: topic.peerUid,
    lastSeq: lastSeq,
    read: read,
    unread: unreadOf(messages, read),
    preview: previewOf(last, maxPreviewLength),
    sortAtMs: last === null ? topic.touchedAt : last.ts,
    online: topic.online
  };
}

/** 摘要列表：按 `sortAtMs` 倒序（最近的在最前）。 */
export function conversationSummariesOf(entries: ConversationSummary[]): ConversationSummary[] {
  const rows = entries.slice();
  rows.sort((left: ConversationSummary, right: ConversationSummary): number => right.sortAtMs - left.sortAtMs);
  return rows;
}

/** 一条待淘汰的消息引用。 */
export interface MessageRef {
  topic: string;
  seq: number;
}

/**
 * 容量控制：每个会话只保留最近 `keepPerTopic` 条，返回**该删除**的消息引用。
 * 纯计算：宿主拿到列表后自己删（RDB `DELETE` / 文件删行）。
 */
export function planMessageEviction(messagesByTopic: Map<string, TinodeMessage[]>,
  keepPerTopic: number = 500): MessageRef[] {
  const keep = Number.isFinite(keepPerTopic) && keepPerTopic > 0 ? Math.floor(keepPerTopic) : 500;
  const doomed: MessageRef[] = [];
  messagesByTopic.forEach((messages: TinodeMessage[], topic: string) => {
    const sorted = mergeMessages(messages, []);
    if (sorted.length <= keep) return;
    const excess = sorted.length - keep;
    for (let i = 0; i < excess; i++) {
      doomed.push({ topic: topic, seq: sorted[i].seq });
    }
  });
  doomed.sort((left: MessageRef, right: MessageRef): number =>
    left.topic === right.topic ? left.seq - right.seq : (left.topic < right.topic ? -1 : 1));
  return doomed;
}

/** 草稿预览（用于会话列表；空草稿返回空串）。 */
export function draftPreviewOf(draft: TinodeDraft | null | undefined, maxLength: number = 40): string {
  if (draft === null || draft === undefined) return '';
  const text = (draft.text === undefined ? '' : draft.text).replace(/\s+/g, ' ').trim();
  if (text.length === 0) return '';
  if (maxLength > 0 && text.length > maxLength) return `${text.slice(0, maxLength)}…`;
  return text;
}
