/**
 * @otq/tinode-harmony —— Tinode 即时通讯协议的 HarmonyOS 客户端 SDK。
 *
 * 许可：MIT（见同目录 LICENSE）。本实现为**独立 ArkTS 重写**；
 * 协议常量与报文形状参考 Tinode 官方文档与 Apache-2.0 的 `co/tinode/tinodesdk`（见 NOTICE）。
 */

/**
 * SDK 的**线路级**消息/会话/草稿模型。
 *
 * 只表达协议里真实存在的东西（`data` 报文的字段、`meta.sub` 的字段），**不含业务语义**
 * （不判断内容类型、不算送达状态、不做预览文案——那些是宿主应用的事）。
 * 宿主的存储实现（`TinodeStorage`）用这些类型读写，不需要理解 Tinode 报文。
 */

import type { Drafty } from './Drafty.ts';
import type { ImHead } from './TinodeHead.ts';
import type { ImData } from './TinodeWire.ts';

/** 一条消息（`data` 报文的等价物 + 常用派生字段）。 */
export interface TinodeMessage {
  /** 稳定主键：`<topic>-<seq>`（服务端消息有唯一 seq；本地临时消息由宿主自己管理）。 */
  id: string;
  topic: string;
  seq: number;
  from: string;
  isMine: boolean;
  /** 毫秒时间戳（`ts` 解析失败时由宿主传入 now）。 */
  ts: number;
  content: Drafty | null;
  head: ImHead | null;
}

/** 一个会话（`meta.sub` 的等价物）。 */
export interface TinodeTopic {
  topic: string;
  /** 展示名（服务端 `public.fn`；宿主可再用通讯录覆盖）。 */
  name: string;
  /** 对方 uid（P2P 就是 topic 名）。 */
  peerUid: string;
  seq: number;
  read: number;
  recv: number;
  online: boolean;
  touchedAt: number;
  lastPreview: string;
}

/** 草稿（`topic → text`；宿主自己决定存哪）。 */
export interface TinodeDraft {
  topic: string;
  text: string;
  updatedAt: number;
}

/** 解析 `data.ts`（RFC3339）为毫秒；解析不了用 `fallbackMs`。 */
export function messageTsOf(ts: string | undefined, fallbackMs: number): number {
  if (ts === undefined || ts === null || ts.length === 0) return fallbackMs;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

/** `data` 报文 → 线路级消息；`topic`/`seq` 不合法时返回 null（与 Tinode SDK 一样丢弃脏包）。 */
export function tinodeMessageFromData(data: ImData, myUid: string, nowMs: number): TinodeMessage | null {
  const topic = typeof data.topic === 'string' ? data.topic : '';
  const seq = typeof data.seq === 'number' ? data.seq : -1;
  if (topic.length === 0 || seq <= 0) return null;
  const from = typeof data.from === 'string' ? data.from : '';
  return {
    id: `${topic}-${seq}`,
    topic: topic,
    seq: seq,
    from: from,
    isMine: myUid.length > 0 && from === myUid,
    ts: messageTsOf(data.ts, nowMs),
    content: data.content === undefined || data.content === null ? null : data.content,
    head: data.head === undefined || data.head === null ? null : data.head
  };
}
