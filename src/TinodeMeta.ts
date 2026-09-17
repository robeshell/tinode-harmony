/**
 * tinode-harmony —— Tinode 即时通讯协议的 HarmonyOS 客户端 SDK。
 *
 * 许可：MIT（见同目录 LICENSE）。本实现为**独立 ArkTS 重写**；
 * 协议常量与报文形状参考 Tinode 官方文档与 Apache-2.0 的 `co/tinode/tinodesdk`（见 NOTICE）。
 */

/**
 * 会话与资料（P5-min）——**纯逻辑**：把服务端的 `meta`/`sub` 变成可以直接渲染的会话轮廓。
 *
 * 官方 Java SDK 用 `MeTopic` 持有"我的订阅列表"、用 `User`/`LastSeen` 表示人；本 SDK 之前只把这些
 * 报文**透传**给宿主（`onMeta`），于是每个宿主都得自己写一遍"从 `meta.sub[]` 取名字/头像/未读"——
 * 我们自己的 App 就在 `im/ImConversation.ts`（446 行）里写了这套。这个文件把它变成 SDK 的纯函数：
 *
 * - `profileFromSub` / `profilesFromMeta`：`meta.sub[]` → `TinodeProfile`（名字/头像/位点/在线/最后活动）；
 * - `mergeProfiles`：按 topic 合并（**非空字段优先 + 位点取最大 + 时间取最新**），用于增量刷新；
 * - `topicOfProfile`：轮廓 → 端口模型 `TinodeTopic`（可直接 `upsertTopic` 落库）；
 * - `displayNameOf`：**通讯录 → Tinode `public.fn` → topic** 三级兜底（与 Android 基线同口径）；
 * - `sortTopicsByActivity`：会话列表排序。
 */

import { cardName, cardPhotoRef, metaSubs } from './TinodeWire.ts';
import type { ImMeta, ImMetaSub } from './TinodeWire.ts';
import { messageTsOf } from './TinodeMessage.ts';
import type { TinodeTopic } from './TinodeMessage.ts';

/** 一个会话（人）的轮廓：能直接渲染会话列表的那几个字段。 */
export interface TinodeProfile {
  topic: string;
  /** 对方 uid（P2P 下与 topic 同值）。 */
  peerUid: string;
  /** 服务端公开名片里的显示名（`public.fn`），可能为空。 */
  name: string;
  /** 头像 ref（`public.photo`），可能为空。 */
  photo: string;
  seq: number;
  read: number;
  recv: number;
  online: boolean;
  /** 最后活动时间（毫秒）。 */
  touchedAtMs: number;
  /** 最后在线时间（毫秒；0 = 未知）。由 `pres{what:"off"|"gone"}` 更新。 */
  lastSeenMs: number;
}

function normalizeSeq(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 单条 `meta.sub[]` → 轮廓；topic 为空返回 null。 */
export function profileFromSub(sub: ImMetaSub, fallbackTopic?: string): TinodeProfile | null {
  const topic = (sub.topic === undefined || sub.topic.length === 0 ? fallbackTopic : sub.topic);
  if (topic === undefined || topic.trim().length === 0) return null;
  const user = sub.user === undefined || sub.user.length === 0 ? topic : sub.user;
  return {
    topic: topic.trim(),
    peerUid: user,
    name: cardName(sub.pub),
    photo: cardPhotoRef(sub.pub),
    seq: normalizeSeq(sub.seq),
    read: normalizeSeq(sub.read),
    recv: normalizeSeq(sub.recv),
    online: sub.online === true,
    touchedAtMs: messageTsOf(sub.touched, 0),
    lastSeenMs: 0
  };
}

/** `meta` → 轮廓列表（`meta.sub[]` 逐条转换，丢弃非法项）。 */
export function profilesFromMeta(meta: ImMeta | null | undefined, fallbackTopic?: string): TinodeProfile[] {
  const rows = metaSubs(meta);
  const list: TinodeProfile[] = [];
  for (let i = 0; i < rows.length; i++) {
    const profile = profileFromSub(rows[i], meta === null || meta === undefined ? fallbackTopic : meta.topic);
    if (profile !== null) list.push(profile);
  }
  return list;
}

/**
 * 合并轮廓：incoming 里**非空**的字段覆盖旧值，`seq`/`read`/`recv` 取最大值，`touchedAtMs` 取最新。
 * `incoming` 里没出现的 topic 保持原样（增量刷新不会把列表清空）。
 */
export function mergeProfiles(known: TinodeProfile[], incoming: TinodeProfile[]): TinodeProfile[] {
  const byTopic: Map<string, TinodeProfile> = new Map();
  for (let i = 0; i < known.length; i++) byTopic.set(known[i].topic, known[i]);
  for (let i = 0; i < incoming.length; i++) {
    const fresh = incoming[i];
    const old = byTopic.get(fresh.topic);
    if (old === undefined) {
      byTopic.set(fresh.topic, fresh);
      continue;
    }
    byTopic.set(fresh.topic, {
      topic: fresh.topic,
      peerUid: fresh.peerUid.length > 0 ? fresh.peerUid : old.peerUid,
      name: fresh.name.length > 0 ? fresh.name : old.name,
      photo: fresh.photo.length > 0 ? fresh.photo : old.photo,
      seq: Math.max(old.seq, fresh.seq),
      read: Math.max(old.read, fresh.read),
      recv: Math.max(old.recv, fresh.recv),
      // `online` 只有服务端明确下发时才覆盖（`meta` 里通常没有这个字段）。
      online: fresh.online ? true : old.online,
      touchedAtMs: Math.max(old.touchedAtMs, fresh.touchedAtMs),
      lastSeenMs: Math.max(old.lastSeenMs, fresh.lastSeenMs)
    });
  }
  const merged: TinodeProfile[] = [];
  byTopic.forEach((profile: TinodeProfile) => { merged.push(profile); });
  return merged;
}

/** 轮廓 → 端口模型（`TinodeTopic`），可直接 `storage.upsertTopic`。 */
export function topicOfProfile(profile: TinodeProfile, previous?: TinodeTopic): TinodeTopic {
  return {
    topic: profile.topic,
    name: profile.name.length > 0 ? profile.name : (previous === undefined ? '' : previous.name),
    peerUid: profile.peerUid.length > 0 ? profile.peerUid : profile.topic,
    seq: profile.seq > 0 ? profile.seq : (previous === undefined ? 0 : previous.seq),
    read: profile.read > 0 ? profile.read : (previous === undefined ? 0 : previous.read),
    recv: profile.recv > 0 ? profile.recv : (previous === undefined ? 0 : previous.recv),
    online: profile.online,
    touchedAt: profile.touchedAtMs > 0 ? profile.touchedAtMs : (previous === undefined ? 0 : previous.touchedAt),
    lastPreview: previous === undefined ? '' : previous.lastPreview,
    lastSeenMs: profile.lastSeenMs > 0 ? profile.lastSeenMs
      : (previous === undefined || previous.lastSeenMs === undefined ? 0 : previous.lastSeenMs)
  };
}

/**
 * 显示名三级兜底（与 Android 基线同口径）：
 * **通讯录名字 → Tinode `public.fn` → topic（`usrXXXXXX`）**。
 * 宿主把通讯录里的名字传进来即可；不需要通讯录就传空串。
 */
export function displayNameOf(topic: string, contactName: string, publicFn: string): string {
  if (contactName.trim().length > 0) return contactName.trim();
  if (publicFn.trim().length > 0) return publicFn.trim();
  return topic;
}

/**
 * 应用一条 `pres`（在线状态）：
 * - `what === 'on'` → `online = true`；
 * - `what === 'off' | 'gone' | 'rec'` → `online = false` 且用 `t`（ISO）记**最后在线**时间；
 * 其它 `what`（如 `kp`/`upd`）不动状态，但仍刷新"最后活动时间"。
 * 返回更新后的轮廓（不改原对象）。
 */
export function applyPresence(profile: TinodeProfile, what: string, t: string | undefined,
  nowMs: number): TinodeProfile {
  const next: TinodeProfile = {
    topic: profile.topic, peerUid: profile.peerUid, name: profile.name, photo: profile.photo,
    seq: profile.seq, read: profile.read, recv: profile.recv,
    online: profile.online, touchedAtMs: Math.max(profile.touchedAtMs, nowMs), lastSeenMs: profile.lastSeenMs
  };
  if (what === 'on') {
    next.online = true;
  } else if (what === 'off' || what === 'gone' || what === 'rec') {
    next.online = false;
    const seen = messageTsOf(t, 0);
    if (seen > 0) next.lastSeenMs = Math.max(profile.lastSeenMs, seen);
  }
  return next;
}

/** 会话列表排序：按最后活动时间倒序（相同则按 topic 稳定排序）。 */
export function sortTopicsByActivity(topics: TinodeTopic[]): TinodeTopic[] {
  const rows = topics.slice();
  rows.sort((left: TinodeTopic, right: TinodeTopic): number => {
    if (right.touchedAt !== left.touchedAt) return right.touchedAt - left.touchedAt;
    return left.topic < right.topic ? -1 : (left.topic === right.topic ? 0 : 1);
  });
  return rows;
}
