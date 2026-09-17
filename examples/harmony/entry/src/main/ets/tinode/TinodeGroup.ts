/**
 * tinode-harmony —— Tinode 即时通讯协议的 HarmonyOS 客户端 SDK。
 *
 * 许可：MIT（见同目录 LICENSE）。本实现为**独立 ArkTS 重写**；
 * 协议常量与报文形状参考 Tinode 官方文档与 Apache-2.0 的 `co/tinode/tinodesdk`（见 NOTICE）。
 */

/**
 * 群组（P7 批次一）——**纯逻辑**：话题分类与命名、成员模型、群权限判定。
 *
 * Tinode 的群聊就是**另一种 topic**（`grpXXXXXX` 而不是 `usrXXXXXX`），协议面仍然是
 * `sub`/`get`/`set`/`del` 四条报文，所以本文件不新造协议，只把「群特有」的规则抽出来：
 *
 * | 事情 | 怎么做 | 上游依据 |
 * | --- | --- | --- |
 * | 建群 | 客户端造 `newXXXX` 名字 → `sub{set:{desc,tags}}` → **用应答 `ctrl.topic` 换名** | `Topic.java:96`、`:925-928` |
 * | 成员列表 | `get{topic:"grp…", what:"sub"}` → `meta.sub[]` | `MetaGetSub`、`MsgServerMeta` |
 * | 邀请 / 改权限 | `set{topic, sub:{user,mode}}`（**整串** mode） | `Topic.java:1308-1391` |
 * | 移出群 | `del{topic, what:"sub", user}` | `Tinode.java:1752` |
 * | 封禁 | 不是删除，而是把 `mode` 设成 `'N'` | `Topic.java:1422` |
 * | 默认权限 | `set{topic, desc:{defacs:{auth,anon}}}` | `Topic.java:1298` |
 *
 * 报文构造在 `TinodeWire.ts`（`buildSubCreate` / `buildSetSubMode` / `buildSetDefacs` /
 * `buildDelSubscription`；成员列表复用已有的 `buildGetMetaSub`），本文件负责**模型与判定**。
 *
 * ⚠️ **状态**：本批次只有「源码已实现 + 主机测试通过」，**没有真机、也没有对着真实服务端跑过建群全链路**；
 * 权限字母的含义来自上游 `AcsHelper:15-22`，但「服务端在什么权限下才允许某个动作」是**服务端的权威**，
 * 这里的判定只用于 UI 显隐，被拒仍要走 `onFailure`。
 */

import { cardName, cardPhotoRef, metaSubs } from './TinodeWire.ts';
import type { ImCard, ImMeta, ImMetaSub } from './TinodeWire.ts';
import { acsAllows, acsIsOwner, normalizeAccessMode, parseAcs, parseDefacs } from './TinodeAcs.ts';
import type { TinodeAcs, TinodeDefacs } from './TinodeAcs.ts';
import { messageTsOf } from './TinodeMessage.ts';

// ── 1. 话题分类 ────────────────────────────────────────────────────────────

/** 保留话题：我的订阅列表。 */
export const IM_TOPIC_ME = 'me';
/** 保留话题：发现/搜索（服务端需 REST，本 SDK 不实现）。 */
export const IM_TOPIC_FND = 'fnd';
/** 保留话题：服务端系统通知。 */
export const IM_TOPIC_SYS = 'sys';
/** 「新群」前缀：客户端自己先造名字，服务端在应答里改成真正的 `grp…`（`Topic.java:90`）。 */
export const IM_TOPIC_NEW = 'new';
/** 「新频道」前缀（`Topic.java:90` 的 `CHANNEL_NEW`）。 */
export const IM_CHANNEL_NEW = 'nch';
/** 已同步的群前缀。 */
export const IM_TOPIC_GRP_PREFIX = 'grp';
/** 已同步的频道前缀。 */
export const IM_TOPIC_CHN_PREFIX = 'chn';
/** 单聊前缀。 */
export const IM_TOPIC_USR_PREFIX = 'usr';

/** 话题种类。`grp` 是群，`chn` 是频道，`p2p` 是单聊。 */
export type TinodeTopicKind = 'me' | 'fnd' | 'sys' | 'p2p' | 'grp' | 'chn' | 'unknown';

/**
 * 按名字判话题种类。与上游 `Topic.getTopicTypeByName:158-174` 同源，但把**频道**从 `grp` 里分出来
 * （上游把 `chn…` 也归进 `TopicType.GRP`）：`new…` 是「还没同步的群」，仍算 `grp`。
 */
export function topicKindOf(name: string | null | undefined): TinodeTopicKind {
  if (name === null || name === undefined) return 'unknown';
  const value = name.trim();
  if (value.length === 0) return 'unknown';
  if (value === IM_TOPIC_ME) return 'me';
  if (value === IM_TOPIC_FND) return 'fnd';
  if (value === IM_TOPIC_SYS) return 'sys';
  if (value.startsWith(IM_TOPIC_GRP_PREFIX) || value.startsWith(IM_TOPIC_NEW)) return 'grp';
  if (value.startsWith(IM_TOPIC_CHN_PREFIX) || value.startsWith(IM_CHANNEL_NEW)) return 'chn';
  if (value.startsWith(IM_TOPIC_USR_PREFIX)) return 'p2p';
  return 'unknown';
}

/** 是否「群类通信话题」（`grp…`/`new…`/`chn…`/`nch…`）——对齐上游 `Topic.isGrpType`（频道也算）。 */
export function isGroupTopic(name: string | null | undefined): boolean {
  const kind = topicKindOf(name);
  return kind === 'grp' || kind === 'chn';
}

/**
 * 是否是「还没和服务端同步的新话题」（`new…`/`nch…`）。
 * 对这类话题**不能**发 `set`/邀请：上游直接抛 `NotSynchronizedException`（`Topic.java:1385-1389`），
 * 必须先等建群应答把名字换成 `grp…`。
 */
export function isNewTopic(name: string | null | undefined): boolean {
  if (name === null || name === undefined) return false;
  const value = name.trim();
  return value.startsWith(IM_TOPIC_NEW) || value.startsWith(IM_CHANNEL_NEW);
}

/** 是否单聊话题（`usr…`）。 */
export function isP2PTopic(name: string | null | undefined): boolean {
  return topicKindOf(name) === 'p2p';
}

/** 是否频道话题（`chn…`/`nch…`）。 */
export function isChannelTopic(name: string | null | undefined): boolean {
  return topicKindOf(name) === 'chn';
}

// ── 2. 新话题命名 ──────────────────────────────────────────────────────────

/** 名字生成用的进制：与上游 `Long.toString(x, 32)` 同为 32 进制（数字 + `a`-`v`）。 */
const TOPIC_NAME_RADIX = 32;
/** 随机段的空间（32³）。 */
const TOPIC_NAME_RANDOM_SPACE = 32768;

function base32Of(value: number): string {
  return Math.floor(Math.abs(value)).toString(TOPIC_NAME_RADIX);
}

/**
 * 生成「新话题名」的后缀（不含 `new`/`nch` 前缀）。
 *
 * **与上游不逐位一致，是有意的**：上游 `Tinode.nextUniqueString:2337-2340` 用
 * `(now - 1414213562373) << 16 | counter`（Java `long`）。同样写法在 JS/ArkTS 里有两处硬伤：
 * `<<` 按 int32 溢出、值本身又超过 `Number.MAX_SAFE_INTEGER`（约 2.2e16 > 9e15），
 * 结果是**低位 counter 被精度丢掉**，同一毫秒内连续调用会撞名。这里改成
 * 「秒级时间戳 + 自增计数 + 随机段」三段 32 进制拼接，长度约 10–12 字符。
 *
 * 对服务端而言只有 `new` 前缀有意义（**真正的名字由服务端在 `ctrl.topic` 里下发**），
 * 所以不追求与上游逐位对齐；同毫秒内靠 `counter`、跨调用靠 `randomFraction` 区分。
 *
 * 纯函数：随机性由调用方以 `randomFraction ∈ [0,1)` 传入（与 `backoffDelayMs` 同口径），因此可测。
 */
export function uniqueTopicSuffix(nowMs: number, counter: number, randomFraction: number): string {
  const now = Number.isFinite(nowMs) && nowMs > 0 ? Math.floor(nowMs) : 0;
  const seconds = Math.floor(now / 1000);
  const seq = Number.isFinite(counter) && counter > 0 ? Math.floor(counter) : 1;
  let fraction = Number.isFinite(randomFraction) ? randomFraction : 0;
  if (fraction < 0) fraction = 0;
  if (fraction >= 1) fraction = 0.999999;
  const salt = Math.floor(fraction * TOPIC_NAME_RANDOM_SPACE);
  return base32Of(seconds) + base32Of(seq) + base32Of(salt);
}

/** 造一个待创建的新群话题名（`new…`）；建群成功后必须用服务端应答的 `ctrl.topic` 替换它。 */
export function newGroupTopicName(nowMs: number, counter: number, randomFraction: number): string {
  return IM_TOPIC_NEW + uniqueTopicSuffix(nowMs, counter, randomFraction);
}

/** 造一个待创建的新频道话题名（`nch…`）。 */
export function newChannelTopicName(nowMs: number, counter: number, randomFraction: number): string {
  return IM_CHANNEL_NEW + uniqueTopicSuffix(nowMs, counter, randomFraction);
}

// ── 3. 成员模型 ────────────────────────────────────────────────────────────

/**
 * 群成员：`get{topic:"grp…", what:"sub"}` 应答里 `meta.sub[]` 的一条。
 * 注意群成员**每条都必须有 `user`**（只有单聊的 `sub` 才会只给 `topic` 不给 `user`），所以 `user` 为空的行会被丢弃。
 */
export interface TinodeMember {
  /** 成员 uid（`usrXXXXXX`）。 */
  user: string;
  /** 群话题名（`meta.sub[]` 有时不带 `topic`，用所在的群补上）。 */
  topic: string;
  /** 服务端算好的**实际**权限（`acs.mode` = want & given）。 */
  mode: string;
  /** 管理员想给的权限（`acs.want`）。 */
  want: string;
  /** 服务端已授予的权限（`acs.given`）。 */
  given: string;
  online: boolean;
  /** 成员名片显示名（`public.fn`）。 */
  name: string;
  /** 成员头像 ref（`public.photo`）。 */
  photo: string;
  /** 最后活动时间（毫秒；0 = 未知）。 */
  touchedAtMs: number;
}

/** 单条 `meta.sub[]` → 成员；没有 `user` 的（单聊形态）返回 null。 */
export function memberFromSub(sub: ImMetaSub, fallbackTopic?: string): TinodeMember | null {
  const user = sub.user === undefined ? '' : sub.user.trim();
  if (user.length === 0) return null;
  const own = sub.topic === undefined ? '' : sub.topic.trim();
  const fallback = fallbackTopic === undefined ? '' : fallbackTopic.trim();
  const acs = parseAcs(sub.acs);
  return {
    user: user,
    topic: own.length > 0 ? own : fallback,
    mode: acs.mode,
    want: acs.want,
    given: acs.given,
    online: sub.online === true,
    name: cardName(sub.pub),
    photo: cardPhotoRef(sub.pub),
    touchedAtMs: messageTsOf(sub.touched, 0)
  };
}

/** `meta` → 成员列表（`meta.sub[]` 逐条转换，丢弃没有 `user` 的行）。 */
export function membersFromMeta(meta: ImMeta | null | undefined, fallbackTopic?: string): TinodeMember[] {
  const rows = metaSubs(meta);
  const metaTopic = meta === null || meta === undefined ? undefined : meta.topic;
  const fallback = metaTopic === undefined ? fallbackTopic : metaTopic;
  const list: TinodeMember[] = [];
  for (let i = 0; i < rows.length; i++) {
    const member = memberFromSub(rows[i], fallback);
    if (member !== null) list.push(member);
  }
  return list;
}

/**
 * 合并成员列表（增量刷新用）：按 `user` 合并，**非空字段优先**，权限以带权限的那份为准。
 * `incoming` 里没出现的成员保持原样（不会因为只拉了一页就把列表清空）。
 */
export function mergeMembers(known: TinodeMember[], incoming: TinodeMember[]): TinodeMember[] {
  const byUser: Map<string, TinodeMember> = new Map();
  for (let i = 0; i < known.length; i++) byUser.set(known[i].user, known[i]);
  for (let i = 0; i < incoming.length; i++) {
    const fresh = incoming[i];
    const old = byUser.get(fresh.user);
    if (old === undefined) {
      byUser.set(fresh.user, fresh);
      continue;
    }
    byUser.set(fresh.user, {
      user: fresh.user,
      topic: fresh.topic.length > 0 ? fresh.topic : old.topic,
      // 权限：`'N'`（封禁/无权限）也是**有效值**，所以判空而不是判真假。
      mode: fresh.mode.length > 0 ? fresh.mode : old.mode,
      want: fresh.want.length > 0 ? fresh.want : old.want,
      given: fresh.given.length > 0 ? fresh.given : old.given,
      online: fresh.online ? true : old.online,
      name: fresh.name.length > 0 ? fresh.name : old.name,
      photo: fresh.photo.length > 0 ? fresh.photo : old.photo,
      touchedAtMs: Math.max(old.touchedAtMs, fresh.touchedAtMs)
    });
  }
  const merged: TinodeMember[] = [];
  byUser.forEach((member: TinodeMember) => { merged.push(member); });
  return merged;
}

/** 找一个成员（找不到返回 null）。 */
export function memberOf(members: TinodeMember[], uid: string): TinodeMember | null {
  const key = uid.trim();
  if (key.length === 0) return null;
  for (let i = 0; i < members.length; i++) {
    if (members[i].user === key) return members[i];
  }
  return null;
}

/**
 * 成员排序：**所有者在前** → 在线的在前 → 有名字的在前（按名字） → 按 uid 稳定。
 * 不改原数组。
 */
export function sortMembers(members: TinodeMember[]): TinodeMember[] {
  const rows = members.slice();
  rows.sort((left: TinodeMember, right: TinodeMember): number => {
    const ownerDiff = (acsIsOwner(right.mode) ? 1 : 0) - (acsIsOwner(left.mode) ? 1 : 0);
    if (ownerDiff !== 0) return ownerDiff;
    if (left.online !== right.online) return left.online ? -1 : 1;
    const leftNamed = left.name.length > 0 ? 1 : 0;
    const rightNamed = right.name.length > 0 ? 1 : 0;
    if (leftNamed !== rightNamed) return rightNamed - leftNamed;
    if (left.name !== right.name) return left.name < right.name ? -1 : 1;
    return left.user < right.user ? -1 : (left.user === right.user ? 0 : 1);
  });
  return rows;
}

// ── 4. 群权限判定 ──────────────────────────────────────────────────────────

/**
 * 群权限的**客户端提示**（用于按钮显隐）。字母含义见上游 `AcsHelper:15-22`：
 * `S` 邀请他人、`A` 审批、`D` 硬删消息、`W` 发消息、`R` 读、`O` 所有者（全权）。
 */
export interface TinodeGroupPermissions {
  isOwner: boolean;
  canRead: boolean;
  canWrite: boolean;
  /** 能邀请/移出成员（`S`，`O` 隐含）。 */
  canInvite: boolean;
  /** 能审批加入申请（`A`，`O` 隐含）。 */
  canApprove: boolean;
  /** 能硬删群内消息（`D`，`O` 隐含）。 */
  canDeleteMessages: boolean;
  /**
   * 能改群资料/默认权限。**本端按「需要 `O`」处理**（上游 SDK 没做这个判定，服务端才是权威）：
   * 它只用来决定设置入口显不显示，真被拒仍要照 `onFailure` 提示。
   */
  canEdit: boolean;
  /** 是否被封禁/无权限（`mode` 为 `'N'`）。 */
  isBanned: boolean;
}

/** 由我在某个群里的 `mode` 算出可做的事（UI 提示；权威在服务端）。 */
export function groupPermissionsOf(mode: string | null | undefined): TinodeGroupPermissions {
  const normalized = normalizeAccessMode(mode);
  const owner = acsIsOwner(normalized);
  return {
    isOwner: owner,
    canRead: acsAllows(normalized, 'R'),
    canWrite: acsAllows(normalized, 'W'),
    canInvite: acsAllows(normalized, 'S'),
    canApprove: acsAllows(normalized, 'A'),
    canDeleteMessages: acsAllows(normalized, 'D'),
    canEdit: owner,
    isBanned: normalized === 'N'
  };
}

/** 能不能邀请/移出成员（`S`；`O` 隐含）。单独列出便于宿主直接判断。 */
export function canInviteMembers(mode: string | null | undefined): boolean {
  return acsAllows(mode, 'S');
}

/** 能不能审批加入申请（`A`；`O` 隐含）。 */
export function canApproveMembers(mode: string | null | undefined): boolean {
  return acsAllows(mode, 'A');
}

/** 能不能改群资料/默认权限（本端按「需要 `O`」处理，见 `TinodeGroupPermissions.canEdit`）。 */
export function canEditGroup(mode: string | null | undefined): boolean {
  return acsIsOwner(mode);
}

/** 能不能硬删群内消息（`D`；`O` 隐含）。 */
export function canDeleteGroupMessages(mode: string | null | undefined): boolean {
  return acsAllows(mode, 'D');
}

// ── 5. 群资料 ──────────────────────────────────────────────────────────────

/** 群资料：`meta.desc`（`get{what:"desc"}` 或订阅内联 `get{desc}` 的应答）。 */
export interface TinodeGroupInfo {
  topic: string;
  kind: TinodeTopicKind;
  /** 群名（`desc.public.fn`）。 */
  name: string;
  /** 群头像 ref（`desc.public.photo`）。 */
  photo: string;
  /** 默认权限（`desc.defacs`）：新成员 / 匿名用户默认拿到什么。 */
  defacs: TinodeDefacs;
  /** 我在这个群里的权限（`desc.acs`）。 */
  acs: TinodeAcs;
}

/**
 * 从 `meta.desc` 解析群资料。**只认群/频道话题**（`grp…`/`new…`/`chn…`/`nch…`）；
 * 单聊名片用 `TinodeMeta.profileFromDesc`。话题缺失或不是群类返回 null。
 */
export function groupInfoFromMeta(meta: ImMeta | null | undefined): TinodeGroupInfo | null {
  if (meta === null || meta === undefined) return null;
  const topic = (meta.topic === undefined ? '' : meta.topic).trim();
  if (topic.length === 0) return null;
  const kind = topicKindOf(topic);
  if (kind !== 'grp' && kind !== 'chn') return null;
  const desc = meta.desc;
  const record: Record<string, Object> | null =
    (desc === null || desc === undefined || typeof desc !== 'object') ? null : (desc as Record<string, Object>);
  const pub = record === null ? undefined : record.public;
  const card: ImCard | null =
    (pub === null || pub === undefined || typeof pub !== 'object') ? null : (pub as ImCard);
  return {
    topic: topic,
    kind: kind,
    name: card === null ? '' : cardName(card),
    photo: card === null ? '' : cardPhotoRef(card),
    defacs: parseDefacs(record === null ? undefined : record.defacs),
    acs: parseAcs(record === null ? undefined : record.acs)
  };
}
