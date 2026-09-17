import test from 'node:test';
import assert from 'node:assert/strict';
import { CachedTinodeStorage } from '../src/TinodeStorageCache.ts';
import { MemoryTinodeStorage } from '../src/TinodeStorage.ts';

// P4：带缓存的存储装饰器
const msg = (topic, seq) => ({ id: `${topic}-${seq}`, topic, seq, from: 'x', isMine: false, ts: seq, content: { txt: `m${seq}` }, head: null });

function counting(inner) {
  const calls = { load: 0, put: 0, del: 0 };
  return {
    calls,
    port: {
      loadTopics: () => inner.loadTopics(),
      upsertTopic: (t) => inner.upsertTopic(t),
      deleteTopic: (t) => inner.deleteTopic(t),
      loadMessages: (t, l, b) => { calls.load += 1; return inner.loadMessages(t, l, b); },
      putMessage: (m) => { calls.put += 1; return inner.putMessage(m); },
      deleteMessages: (t, s) => { calls.del += 1; return inner.deleteMessages(t, s); },
      clearMessages: (t) => inner.clearMessages(t),
      loadDraft: (t) => inner.loadDraft(t),
      saveDraft: (d) => inner.saveDraft(d),
      clearDraft: (t) => inner.clearDraft(t)
    }
  };
}

test('读缓存：同参数第二次命中，不落到内层', async () => {
  const inner = new MemoryTinodeStorage();
  await inner.putMessage(msg('usrA', 1));
  await inner.putMessage(msg('usrA', 2));
  const { port, calls } = counting(inner);
  const cache = new CachedTinodeStorage(port, 8);
  const first = await cache.loadMessages('usrA', 0, 0);
  const second = await cache.loadMessages('usrA', 0, 0);
  assert.deepEqual(first.map((m) => m.seq), [1, 2]);
  assert.deepEqual(second.map((m) => m.seq), [1, 2]);
  assert.equal(calls.load, 1, '第二次走缓存');
  assert.deepEqual(cache.stats(), { hits: 1, misses: 1, invalidations: 0, entries: 1 });
  await cache.loadMessages('usrA', 10, 0);      // 不同参数 = 不同槽位
  assert.equal(calls.load, 2);
});

test('写操作按会话失效缓存（不会读到旧数据）', async () => {
  const inner = new MemoryTinodeStorage();
  const { port, calls } = counting(inner);
  const cache = new CachedTinodeStorage(port, 8);
  await cache.loadMessages('usrA', 0, 0);
  assert.equal(calls.load, 1);
  await cache.putMessage(msg('usrA', 5));       // 写入 → usrA 失效
  const after = await cache.loadMessages('usrA', 0, 0);
  assert.equal(calls.load, 2, '失效后重新查库');
  assert.deepEqual(after.map((m) => m.seq), [5]);
  await cache.deleteMessages('usrA', [5]);
  await cache.loadMessages('usrA', 0, 0);
  assert.equal(calls.load, 3);
  assert.equal((await cache.loadMessages('usrA', 0, 0)).length, 0);
  assert.ok(cache.stats().invalidations >= 2, 'putMessage / deleteMessages 各失效一次');
});

test('容量受限：超过 capacity 淘汰最久未用', async () => {
  const inner = new MemoryTinodeStorage();
  const { port, calls } = counting(inner);
  const cache = new CachedTinodeStorage(port, 2);
  await cache.loadMessages('a', 0, 0);
  await cache.loadMessages('b', 0, 0);
  await cache.loadMessages('c', 0, 0);          // 淘汰 a
  assert.equal(cache.stats().entries, 2);
  await cache.loadMessages('b', 0, 0);          // 命中
  const before = calls.load;
  await cache.loadMessages('a', 0, 0);          // a 已被淘汰 → 回源
  assert.equal(calls.load, before + 1);
  assert.equal(cache.stats().hits, 1);
});

test('reset 清空缓存与统计', async () => {
  const inner = new MemoryTinodeStorage();
  const cache = new CachedTinodeStorage(inner, 4);
  await cache.loadMessages('usrA', 0, 0);
  cache.reset();
  assert.deepEqual(cache.stats(), { hits: 0, misses: 0, invalidations: 0, entries: 0 });
});
