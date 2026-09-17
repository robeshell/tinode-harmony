/**
 * tinode-harmony —— Tinode 即时通讯协议的 HarmonyOS 客户端 SDK。
 *
 * 许可：MIT（见同目录 LICENSE）。本实现为**独立 ArkTS 重写**；
 * 协议常量与报文形状参考 Tinode 官方文档与 Apache-2.0 的 `co/tinode/tinodesdk`（见 NOTICE）。
 */

/**
 * 主题登记（P1：主题生命周期）——纯逻辑，无平台依赖。
 *
 * 官方 Java SDK 用 `Topic`/`MeTopic`/`ComTopic` 持有"我关注哪些会话、每个会话的位点"，
 * 断线重连后由 SDK 自己恢复订阅；本 SDK 原来把这些交给宿主。这个类把那份**最小必要状态**收进 SDK：
 * - **订阅意图**（`withDesc/withSub/limit`）：重连后据此自动重订阅；
 * - **位点**：`lastSeq`（见过的最大 `data.seq`）、`read`/`recv`（服务端 note 或本端 markRead）；
 * - **缺口**：`lastSeq>0` 时，重连后可以从 `lastSeq+1` 起补历史（是否真补由会话配置决定）。
 *
 * 它只记状态、不做 IO，所以可以完整地跑主机测试。
 */

/** 一个主题的订阅意图（`sub.get` 的三个参数）。 */
export interface TinodeTopicPrefs {
  withDesc: boolean;
  withSub: boolean;
  limit: number;
}

/** 一个主题当前已知的状态快照（宿主可只读消费）。 */
export interface TinodeTopicState {
  topic: string;
  prefs: TinodeTopicPrefs;
  /** 本轮连接里是否已经成功订阅（收到 2xx ctrl 后才为 true）。 */
  subscribed: boolean;
  /** 见过的最大 `data.seq`（0 = 还没收到过消息）。 */
  lastSeq: number;
  /** 服务端已读位点（`note{what:"read"}` 或本端 `markRead`）。 */
  read: number;
  /** 服务端送达位点（`note{what:"recv"}`）。 */
  recv: number;
  touchedAtMs: number;
}

/** 重连后需要补历史的主题（从 `since` 起）。 */
export interface TinodeTopicGap {
  topic: string;
  since: number;
}

function normalizeLimit(limit: number): number {
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 24;
}

function normalizeSeq(seq: number | undefined): number {
  return seq !== undefined && Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0;
}

export class TinodeTopics {
  private byTopic: Map<string, TinodeTopicState> = new Map();

  /** 登记（或更新）订阅意图；已存在时只更新 prefs 与时间，**不动位点**。 */
  remember(topic: string, withDesc: boolean, withSub: boolean, limit: number, nowMs: number): void {
    const key = topic.trim();
    if (key.length === 0) return;
    const existing = this.byTopic.get(key);
    const prefs: TinodeTopicPrefs = { withDesc: withDesc, withSub: withSub, limit: normalizeLimit(limit) };
    if (existing === undefined) {
      this.byTopic.set(key, {
        topic: key, prefs: prefs, subscribed: false, lastSeq: 0, read: 0, recv: 0, touchedAtMs: nowMs
      });
      return;
    }
    existing.prefs = prefs;
    existing.touchedAtMs = nowMs;
  }

  /** 离开/删除会话后忘掉它（不再自动重订阅）。 */
  forget(topic: string): void {
    this.byTopic.delete(topic.trim());
  }

  /**
   * 连接断掉/重连时调用：所有主题的"本轮已订阅"标记清零（wire 上的订阅已经不存在了），
   * 但**保留**订阅意图与位点 —— 重连后据此自动重订阅 + 补历史。
   */
  resetSubscriptions(): void {
    this.byTopic.forEach((state: TinodeTopicState) => {
      state.subscribed = false;
    });
  }

  /** 订阅结果（收到 ctrl 后由会话标记）。 */
  markSubscribed(topic: string, subscribed: boolean, nowMs: number): void {
    const state = this.byTopic.get(topic.trim());
    if (state === undefined) return;
    state.subscribed = subscribed;
    state.touchedAtMs = nowMs;
  }

  /** 收到 `data`：推进 `lastSeq`。返回是否变化（宿主据此决定要不要发 onTopicState）。 */
  observeData(topic: string, seq: number, nowMs: number): boolean {
    const state = this.byTopic.get(topic.trim());
    const value = normalizeSeq(seq);
    if (state === undefined || value === 0) return false;
    if (value <= state.lastSeq) return false;
    state.lastSeq = value;
    state.touchedAtMs = nowMs;
    return true;
  }

  /** 收到 `note`：推进 `read`/`recv` 位点（`kp` 与位点无关，忽略）。 */
  observeNote(what: string, topic: string | undefined, seq: number | undefined, nowMs: number): boolean {
    if (topic === undefined) return false;
    const state = this.byTopic.get(topic.trim());
    const value = normalizeSeq(seq);
    if (state === undefined || value === 0) return false;
    if (what === 'read') {
      if (value <= state.read) return false;
      state.read = value;
    } else if (what === 'recv') {
      if (value <= state.recv) return false;
      state.recv = value;
    } else {
      return false;
    }
    state.touchedAtMs = nowMs;
    return true;
  }

  /** 本端标记已读（与 `note{what:"read"}` 同口径推进位点）。 */
  markRead(topic: string, seq: number, nowMs: number): boolean {
    return this.observeNote('read', topic, seq, nowMs);
  }

  stateOf(topic: string): TinodeTopicState | null {
    const state = this.byTopic.get(topic.trim());
    if (state === undefined) return null;
    return {
      topic: state.topic,
      prefs: { withDesc: state.prefs.withDesc, withSub: state.prefs.withSub, limit: state.prefs.limit },
      subscribed: state.subscribed,
      lastSeq: state.lastSeq,
      read: state.read,
      recv: state.recv,
      touchedAtMs: state.touchedAtMs
    };
  }

  /** 全部登记过的主题（最近活动的在前）。 */
  known(): TinodeTopicState[] {
    const list: TinodeTopicState[] = [];
    this.byTopic.forEach((state: TinodeTopicState) => {
      const snapshot = this.stateOf(state.topic);
      if (snapshot !== null) list.push(snapshot);
    });
    list.sort((a: TinodeTopicState, b: TinodeTopicState) => b.touchedAtMs - a.touchedAtMs);
    return list;
  }

  /** 重连后需要重新订阅的主题（登记过但本轮还没订阅成功）。 */
  needingSubscribe(): TinodeTopicState[] {
    const list: TinodeTopicState[] = [];
    this.byTopic.forEach((state: TinodeTopicState) => {
      if (!state.subscribed) {
        const snapshot = this.stateOf(state.topic);
        if (snapshot !== null) list.push(snapshot);
      }
    });
    list.sort((a: TinodeTopicState, b: TinodeTopicState) => b.touchedAtMs - a.touchedAtMs);
    return list;
  }

  /** 重连后可以补历史的主题（`lastSeq>0`）。 */
  gaps(): TinodeTopicGap[] {
    const list: TinodeTopicGap[] = [];
    this.byTopic.forEach((state: TinodeTopicState) => {
      if (state.lastSeq > 0) list.push({ topic: state.topic, since: state.lastSeq + 1 });
    });
    list.sort((a: TinodeTopicGap, b: TinodeTopicGap) => a.topic < b.topic ? -1 : 1);
    return list;
  }

  size(): number {
    return this.byTopic.size;
  }
}
