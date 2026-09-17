/**
 * tinode-harmony —— Tinode 即时通讯协议的 HarmonyOS 客户端 SDK。
 *
 * 许可：MIT（见同目录 LICENSE）。本实现为**独立 ArkTS 重写**；
 * 协议常量与报文形状参考 Tinode 官方文档与 Apache-2.0 的 `co/tinode/tinodesdk`（见 NOTICE）。
 */

/**
 * 带缓存的存储装饰器（P4）——套在**任何** `TinodeStorage` 外面即可。
 *
 * 典型场景：宿主用 RDB（每次 `loadMessages` 都是一次查询），但会话页会反复读同一页。
 * 这一层把最近读过的结果放进一个**容量受限的 LRU**，写操作按会话失效：
 *
 * ```ts
 * const storage = new CachedTinodeStorage(new MyRdbStorage(), 32);
 * const tinode = new Tinode({ transport, config, storage, hooks });
 * ```
 *
 * 语义与端口约定一致（含 `loadMessages` 的"同 seq 覆盖 / 升序 / beforeSeq 严格小于"）；
 * 缓存只影响**读**，写入仍原样落到内层实现，所以不会出现"缓存里是新数据、库里是旧数据"。
 */
import type { TinodeDraft, TinodeMessage, TinodeTopic } from './TinodeMessage.ts';
import type { TinodeStorage } from './TinodeStorage.ts';

/** 缓存命中统计（宿主可打日志观察收益）。 */
export interface StorageCacheStats {
  hits: number;
  misses: number;
  invalidations: number;
  entries: number;
}

interface CacheSlot {
  key: string;
  messages: TinodeMessage[];
  usedAt: number;
}

export class CachedTinodeStorage implements TinodeStorage {
  private readonly inner: TinodeStorage;
  private readonly capacity: number;
  private readonly slots: Map<string, CacheSlot> = new Map<string, CacheSlot>();
  private hits: number = 0;
  private misses: number = 0;
  private invalidations: number = 0;
  private clock: number = 0;

  constructor(inner: TinodeStorage, capacity: number = 32) {
    this.inner = inner;
    this.capacity = Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 32;
  }

  private keyOf(topic: string, limit: number, beforeSeq: number): string {
    return `${topic}|${limit}|${beforeSeq}`;
  }

  private touch(slot: CacheSlot): TinodeMessage[] {
    this.clock += 1;
    slot.usedAt = this.clock;
    return slot.messages;
  }

  private store(key: string, messages: TinodeMessage[]): TinodeMessage[] {
    this.clock += 1;
    this.slots.set(key, { key: key, messages: messages, usedAt: this.clock });
    this.trim();
    return messages;
  }

  /** 超容量时淘汰最久未用的槽位。 */
  private trim(): void {
    while (this.slots.size > this.capacity) {
      let oldestKey = '';
      let oldestAt = Number.MAX_SAFE_INTEGER;
      this.slots.forEach((slot: CacheSlot, key: string) => {
        if (slot.usedAt < oldestAt) {
          oldestAt = slot.usedAt;
          oldestKey = key;
        }
      });
      if (oldestKey.length === 0) return;
      this.slots.delete(oldestKey);
    }
  }

  /** 让某个会话的缓存失效（写操作后调用）。 */
  invalidate(topic: string): void {
    const prefix = `${topic}|`;
    const doomed: string[] = [];
    this.slots.forEach((slot: CacheSlot, key: string) => {
      if (key.startsWith(prefix)) doomed.push(key);
    });
    for (let i = 0; i < doomed.length; i++) {
      this.slots.delete(doomed[i]);
      this.invalidations += 1;
    }
  }

  async loadTopics(): Promise<TinodeTopic[]> {
    return this.inner.loadTopics();
  }

  async upsertTopic(topic: TinodeTopic): Promise<void> {
    await this.inner.upsertTopic(topic);
    this.invalidate(topic.topic);
  }

  async deleteTopic(topic: string): Promise<void> {
    await this.inner.deleteTopic(topic);
    this.invalidate(topic);
  }

  async loadMessages(topic: string, limit: number, beforeSeq: number): Promise<TinodeMessage[]> {
    const key = this.keyOf(topic, limit, beforeSeq);
    const slot = this.slots.get(key);
    if (slot !== undefined) {
      this.hits += 1;
      return this.touch(slot);
    }
    this.misses += 1;
    const rows = await this.inner.loadMessages(topic, limit, beforeSeq);
    return this.store(key, rows);
  }

  async putMessage(message: TinodeMessage): Promise<boolean> {
    const inserted = await this.inner.putMessage(message);
    this.invalidate(message.topic);
    return inserted;
  }

  async deleteMessages(topic: string, seqs: number[]): Promise<number> {
    const removed = await this.inner.deleteMessages(topic, seqs);
    this.invalidate(topic);
    return removed;
  }

  async clearMessages(topic: string): Promise<void> {
    await this.inner.clearMessages(topic);
    this.invalidate(topic);
  }

  async loadDraft(topic: string): Promise<TinodeDraft | null> {
    return this.inner.loadDraft(topic);
  }

  async saveDraft(draft: TinodeDraft): Promise<void> {
    await this.inner.saveDraft(draft);
    this.invalidate(draft.topic);
  }

  async clearDraft(topic: string): Promise<void> {
    await this.inner.clearDraft(topic);
    this.invalidate(topic);
  }

  /** 命中统计 + 当前槽位数。 */
  stats(): StorageCacheStats {
    return { hits: this.hits, misses: this.misses, invalidations: this.invalidations, entries: this.slots.size };
  }

  /** 清空缓存与统计（切号/退出登录时调用）。 */
  reset(): void {
    this.slots.clear();
    this.hits = 0;
    this.misses = 0;
    this.invalidations = 0;
    this.clock = 0;
  }
}
