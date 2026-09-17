/**
 * @otq/tinode-harmony —— Tinode 即时通讯协议的 HarmonyOS 客户端 SDK。
 *
 * 许可：MIT（见同目录 LICENSE）。本实现为**独立 ArkTS 重写**；
 * 协议常量与报文形状参考 Tinode 官方文档与 Apache-2.0 的 `co/tinode/tinodesdk`（见 NOTICE）。
 */

/**
 * SDK 的**存储端口**：宿主把「消息/会话/草稿」落在哪里由宿主决定（RDB / 文件 / 内存 / 不落）。
 *
 * SDK 只依赖这个接口，**不碰任何数据库**；`MemoryTinodeStorage` 是默认实现，
 * 供 SDK 自己的测试、以及不需要持久化的宿主直接用。
 * 语义按 Tinode 服务端的口径：
 * - 消息按 `seq` 唯一：**同 seq 覆盖**（服务端活数据优先于本地 echo）；
 * - `loadMessages(topic, limit, beforeSeq)`：`beforeSeq <= 0` 表示要最新一页，否则要**严格小于** beforeSeq 的一页；
 *   返回按 seq **升序**（渲染顺序），`limit <= 0` 表示不限。
 */
import type { TinodeDraft, TinodeMessage, TinodeTopic } from './TinodeMessage.ts';

export interface TinodeStorage {
  loadTopics(): Promise<TinodeTopic[]>;
  upsertTopic(topic: TinodeTopic): Promise<void>;
  deleteTopic(topic: string): Promise<void>;

  loadMessages(topic: string, limit: number, beforeSeq: number): Promise<TinodeMessage[]>;
  /** 写一条消息：同 `seq` 覆盖（返回 true 表示是新增，false 表示覆盖）。 */
  putMessage(message: TinodeMessage): Promise<boolean>;
  deleteMessages(topic: string, seqs: number[]): Promise<number>;
  clearMessages(topic: string): Promise<void>;

  loadDraft(topic: string): Promise<TinodeDraft | null>;
  saveDraft(draft: TinodeDraft): Promise<void>;
  clearDraft(topic: string): Promise<void>;
}

/** 内存实现：SDK 自带，语义与端口约定一致（也当"参考实现"用）。 */
export class MemoryTinodeStorage implements TinodeStorage {
  private readonly topics: Map<string, TinodeTopic> = new Map<string, TinodeTopic>();
  private readonly messages: Map<string, Map<number, TinodeMessage>> = new Map<string, Map<number, TinodeMessage>>();
  private readonly drafts: Map<string, TinodeDraft> = new Map<string, TinodeDraft>();

  async loadTopics(): Promise<TinodeTopic[]> {
    const rows: TinodeTopic[] = [];
    this.topics.forEach((topic: TinodeTopic) => { rows.push(topic); });
    rows.sort((left: TinodeTopic, right: TinodeTopic): number => right.touchedAt - left.touchedAt);
    return rows;
  }

  async upsertTopic(topic: TinodeTopic): Promise<void> {
    this.topics.set(topic.topic, topic);
  }

  async deleteTopic(topic: string): Promise<void> {
    this.topics.delete(topic);
    this.messages.delete(topic);
    this.drafts.delete(topic);
  }

  async loadMessages(topic: string, limit: number, beforeSeq: number): Promise<TinodeMessage[]> {
    const bucket = this.messages.get(topic);
    if (bucket === undefined) return [];
    const rows: TinodeMessage[] = [];
    bucket.forEach((message: TinodeMessage) => {
      if (beforeSeq > 0 && message.seq >= beforeSeq) return;
      rows.push(message);
    });
    rows.sort((left: TinodeMessage, right: TinodeMessage): number => left.seq - right.seq);
    if (limit > 0 && rows.length > limit) return rows.slice(rows.length - limit);
    return rows;
  }

  async putMessage(message: TinodeMessage): Promise<boolean> {
    let bucket = this.messages.get(message.topic);
    if (bucket === undefined) {
      bucket = new Map<number, TinodeMessage>();
      this.messages.set(message.topic, bucket);
    }
    const existed = bucket.has(message.seq);
    bucket.set(message.seq, message);
    return !existed;
  }

  async deleteMessages(topic: string, seqs: number[]): Promise<number> {
    const bucket = this.messages.get(topic);
    if (bucket === undefined) return 0;
    let removed = 0;
    for (let i = 0; i < seqs.length; i++) {
      if (bucket.delete(seqs[i])) removed += 1;
    }
    return removed;
  }

  async clearMessages(topic: string): Promise<void> {
    this.messages.delete(topic);
  }

  async loadDraft(topic: string): Promise<TinodeDraft | null> {
    const draft = this.drafts.get(topic);
    return draft === undefined ? null : draft;
  }

  async saveDraft(draft: TinodeDraft): Promise<void> {
    this.drafts.set(draft.topic, draft);
  }

  async clearDraft(topic: string): Promise<void> {
    this.drafts.delete(topic);
  }
}
