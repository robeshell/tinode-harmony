# 存储与缓存策略（P4）

SDK **不碰数据库**：它只依赖 `TinodeStorage` 端口（消息/会话/草稿）。P4 补齐的是**策略**——无论你用 RDB、文件还是内存都能复用的纯逻辑，
以及一个套在任意实现外面的**缓存装饰器**。

## 1. 端口（回顾）

```ts
export interface TinodeStorage {
  loadTopics(): Promise<TinodeTopic[]>;
  upsertTopic(topic: TinodeTopic): Promise<void>;
  deleteTopic(topic: string): Promise<void>;
  loadMessages(topic: string, limit: number, beforeSeq: number): Promise<TinodeMessage[]>;  // 升序；beforeSeq 严格小于
  putMessage(message: TinodeMessage): Promise<boolean>;   // 同 seq 覆盖，返回"是否新增"
  deleteMessages(topic: string, seqs: number[]): Promise<number>;
  clearMessages(topic: string): Promise<void>;
  loadDraft(topic: string): Promise<TinodeDraft | null>;
  saveDraft(draft: TinodeDraft): Promise<void>;
  clearDraft(topic: string): Promise<void>;
}
```

自带 `MemoryTinodeStorage`（语义即参考实现，也用于 SDK 自己的测试）。

## 2. 纯逻辑策略（`TinodeStore.ts`）

| 函数 | 用途 |
| --- | --- |
| `mergeMessages(existing, incoming)` | **同 seq 覆盖**（服务端活数据优先）、按 seq 升序、剔除非法 seq —— 拉历史/补缺口后合并一页时用 |
| `unreadOf(messages, lastReadSeq)` / `isUnreadMessage` | 未读数（**自己发的不算**，按已读位点） |
| `lastMessageOf` / `previewOf` | 最后一条与列表预览（空白折叠 + 截断） |
| `conversationSummaryOf(topic, messages)` / `conversationSummariesOf` | 会话摘要（未读、预览、排序时间）与倒序列表 |
| `planMessageEviction(byTopic, keepPerTopic)` | **容量控制**：每会话只留最近 N 条，返回该删的 `(topic, seq)`（只算不删） |
| `draftPreviewOf(draft, maxLength?)` | 草稿预览（会话列表里的"草稿："） |
| `messageKeyOf(topic, seq)` | 稳定主键（与 `TinodeMessage.id` 同口径） |

## 3. 缓存装饰器（`TinodeStorageCache.ts`）

```ts
import { CachedTinodeStorage, MemoryTinodeStorage } from '../tinode/Index.ts';

const storage = new CachedTinodeStorage(myRdbStorage, 32);   // 容量 32 个"读槽位"
const tinode = new Tinode({ transport, config, storage, hooks });

// 观察收益 / 切号时清理
storage.stats();   // { hits, misses, invalidations, entries }
storage.reset();
```

- 缓存的是 `loadMessages(topic, limit, beforeSeq)` 的结果（LRU，超容量淘汰最久未用）；
- **任何写操作按会话失效**（`putMessage`/`deleteMessages`/`clearMessages`/`deleteTopic`/`upsertTopic`/`saveDraft`/`clearDraft`），
  所以不会出现"缓存里新、库里旧"；
- `loadTopics`/`loadDraft` 仍直通内层（列表与草稿变化频繁，缓存收益低且易脏）。

## 4. 推荐组合

| 场景 | 建议 |
| --- | --- |
| 只做演示 / 测试 | `MemoryTinodeStorage` |
| HarmonyOS 生产（我们自己的 App 就是这样） | 自己实现 `TinodeStorage`（RDB）+ 外面套 `CachedTinodeStorage` |
| 消息很多、要控制体积 | 定期跑 `planMessageEviction(byTopic, 500)`，按返回列表删库 |
| 会话列表 | `conversationSummariesOf(topics.map(t => conversationSummaryOf(t, msgs)))` |

## 5. 已知边界

- 本 SDK **不提供** RDB/文件实现（各平台差异大，宿主最清楚自己要什么）；`MemoryTinodeStorage` 是进程内存，重启即空；
- 缓存只按"会话"失效，不做逐条增量更新（简单可靠优先）；
- 未做：跨端同步冲突解决、消息加密存储、附件缓存落盘（附件见 [attachments.md](./attachments.md)）。
