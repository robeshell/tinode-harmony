# 附件（P2，可选模块）

附件在 Tinode 里就是**消息内容里的一个实体**：先把文件传给某个 HTTP 接口拿到 `ref`（+ 可选 `url`），
再用 Drafty 把 `ref` 放进消息。所以本 SDK 把它拆成两半：

| 部分 | 位置 | 要不要用 |
| --- | --- | --- |
| **纯逻辑**：校验、分块规划、进度合并、缓存键与 LRU 淘汰、Drafty 实体互转 | `src/ImAttachment.ts`（无 IO、无平台依赖） | 都可用（纯函数，直接单测） |
| **平台传输**：真正发 HTTP | `src/AttachmentHttp.ets`（HarmonyOS `@kit.NetworkKit`） | 只有需要 SDK 代你上传/下载时才用；宿主已有自己的文件接口（例如你们后端）就**不需要** |

> ⚠️ `AttachmentHttp.ets` **尚未真机验证过上传/下载**（我们自己的 App 走的是后端附件接口）。首次使用请先在一个小工程里跑通再上线。

## 1. 走 Tinode 原生文件接口（对外发布推荐）

```ts
import { HarmonyAttachmentHttp, ImAttachment } from '../tinode/Socket.ets';   // .ets 侧
import { attachmentDrafty, attachmentUploadUrl, planChunks, uploadedRefOf, validateAttachment } from '../tinode/Index.ts';

const meta = { name: 'photo.jpg', mime: 'image/jpeg', size: bytes.byteLength };
const check = validateAttachment(meta, { maxBytes: 32 * 1024 * 1024, allowedMimes: ['image/jpeg', 'image/png'] });
if (!check.ok) { /* 直接提示 check.reason */ }

const http = new HarmonyAttachmentHttp();
const chunks = planChunks(meta.size);                    // 大文件分块
const response = await http.upload({
  url: attachmentUploadUrl('https://im.example.com:6061'),
  headers: { 'X-Tinode-APIKey': apiKey },
  fieldName: 'file', fileName: meta.name, mime: meta.mime, bytes: bytes, topic: 'usrXXXXXX'
}, (loaded, total) => { /* 进度：progressPercent(loaded, total) */ });

const ref = uploadedRefOf(response.body);                // {"id":"..."} → {ref, url?}
if (ref === null) { /* 上传失败 */ }
session.sendPub('usrXXXXXX', null, attachmentDrafty(meta, ref));   // 消息里带 ref
```

## 2. 走自己的后端（我们 App 的做法）

后端接口返回 `url`/`ref` 后，**只用纯逻辑**把它包成消息即可，不需要 `AttachmentHttp.ets`：

```ts
const ref = { ref: uploadedId, url: downloadUrl };
session.sendPub(topic, null, attachmentDrafty(meta, ref, '照片'));
```

## 3. 读侧：从消息里取附件

```ts
const meta = attachmentOfDrafty(message.content);   // 不是附件消息 → null
const key = cacheKeyOf(meta.ref ?? url, meta.mime); // 本地缓存键
const doomed = planEviction(entries, 256 * 1024 * 1024);  // 超预算时该删哪些（LRU）
```

| 函数 | 作用 |
| --- | --- |
| `validateAttachment(meta, limits?)` | 大小/类型/文件名校验，返回 `{ok, reason}`（中文原因可直接提示用户） |
| `planChunks(total, chunk?)` / `initialProgress` / `mergeChunkProgress` / `uploadedBytesOf` / `progressPercent` / `isUploadComplete` | 大文件分块与进度（乱序回退不覆盖、超报会截断） |
| `attachmentDrafty(meta, ref, text?)` / `attachmentOfDrafty(drafty)` | 消息内容 ↔ 附件元数据（实体类型 `IM/AU/VD/EX` 按 MIME 自动选） |
| `cacheKeyOf(ref, mime?)` / `cacheBytesOf` / `planEviction(entries, budget)` | 缓存键与 LRU 淘汰**规划**（只算不删，落盘由宿主做） |
| `attachmentUploadUrl(serverBase)` / `uploadedRefOf(body)` | Tinode 上传地址与响应解析（纯函数） |

## 4. 已知边界

- 上传**分块**目前只做到"规划 + 进度"；把块真正并发/续传发出去由宿主（或后续把 `chunked upload` 补进 `AttachmentHttp.ets`）；
- 下载返回正文文本；二进制落盘/解码（如写沙箱、生成缩略图）由宿主负责；
- 未做：断点续传、秒传（同一 `ref` 去重已有 `cacheKeyOf` 可用）、图片压缩/转码。
