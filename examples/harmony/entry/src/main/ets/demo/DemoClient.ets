/**
 * 示例 App 的 SDK 接线层：把 demo 需要的能力集中在一个类里，页面只管展示。
 *
 * 覆盖的 SDK 能力（对应 `src/` 里的模块）：
 * - 连接/握手/退避重连/代次守卫：`ImSession`（`tinode/TinodeSession.ts`）
 * - 注册与登录：`Tinode.registerAccount` / `configurePasswordLogin` / `loginScheme:'none'|'token'|'basic'|'anonymous'`
 * - 会话列表：`onTopics` + `profiles()`（`tinode/TinodeMeta.ts`）
 * - 主题登记与自动重订阅：`knownTopics()` / `onTopicState`（`tinode/TinodeTopics.ts`）
 * - 消息落库与缓存：`CachedTinodeStorage` + `MemoryTinodeStorage`（`tinode/TinodeStorageCache.ts`）
 * - 会话摘要/未读/淘汰规划：`TinodeStore.ts`
 * - 富文本：`Drafty.ts` 读写侧 + `draftySegments` 渲染
 * - 附件：`TinodeAttachment.ts`（校验/分块/进度/草稿）+ `TinodeAttachmentHttp.ets`（上传，**未真机验证**）
 * - 权限：`TinodeAcs.ts`（`acsSummary` 等）
 * - 在线/最后在线：`pres` → `TinodeTopic.lastSeenMs`
 */
import { common } from '@kit.AbilityKit';
import {
  CachedTinodeStorage, Drafty, DraftySegment, ImCtrl, ImData, ImInfo, ImMeta, ImNote, ImPres,
  ImSessionConfig, ImSessionState, MemoryTinodeStorage, StorageCacheStats, Tinode, TinodeAuth, TinodeHooks,
  TinodeMessage, TinodeOptions, TinodeProfile, TinodeSubscribeOptions, TinodeTopic, TinodeTopicState,
  acsSummary, attachmentDrafty, attachmentOfDrafty,
  cacheKeyOf, defaultSessionConfig, DelRange, draftyLink, draftyWithEntity, attachmentUploadUrl, uploadedRefOf, draftyPlain, draftySegments, draftyWithStyle, parseDraftyJson, planChunks,
  progressPercent, validateAttachment
} from '../tinode/Index.ts';
import { TinodeSocket } from '../tinode/Socket.ets';
import { HarmonyAttachmentHttp } from '../tinode/TinodeAttachmentHttp.ets';
import { PickedFile, RecordedVoice } from './DemoPickers';
import { durationTextOf, needsTimeLabel, previewOfKind, sizeTextOf, timeLabelOf } from './DemoFormat';
import type { AttachmentMeta } from '../tinode/Index.ts';

/** 页面展示用的一条消息（把线路消息 + 富文本片段合在一起）。 */
export interface DemoMessage {
  id: string;
  topic: string;
  seq: number;
  isMine: boolean;
  ts: number;
  text: string;
  segments: DraftySegment[];
  kind: string;
  /** 展示层：是否需要插时间标签、标签文案、送达状态。 */
  showTime: boolean;
  timeText: string;
  status: string;
  /** 附件类消息的展示信息。 */
  fileName: string;
  fileSize: number;
  durationMs: number;
}

/** 页面展示用的一个会话。 */
export interface DemoConversation {
  topic: string;
  name: string;
  photo: string;
  unread: number;
  online: boolean;
  lastSeenMs: number;
  seq: number;
  subscribed: boolean;
  accessSummary: string;
  /** 展示层：最后一条消息预览与时间。 */
  preview: string;
  timeText: string;
}

/** 回调：页面实现它接收数据（避免页面直接持有 SDK 类型）。 */
export interface DemoListener {
  onState: (state: string, detail: string) => void;
  onLog: (line: string) => void;
  onConversations: (list: DemoConversation[]) => void;
  onMessages: (list: DemoMessage[]) => void;
  onUploadProgress: (percent: number, note: string) => void;
}

interface DemoConfig {
  wsUrl: string;
  apiKey: string;
}

export class DemoClient {
  private listener: DemoListener;
  private storage: CachedTinodeStorage = new CachedTinodeStorage(new MemoryTinodeStorage(), 16);
  private tinode: Tinode | null = null;
  private transport: TinodeSocket | null = null;
  private tickTimer: number = -1;
  private profilePhotos: Map<string, string> = new Map();
  private accessByTopic: Map<string, string> = new Map();
  private messagesByTopic: Map<string, DemoMessage[]> = new Map();
  private currentTopic: string = '';
  private apiKey: string = '';
  private serverBase: string = '';
  private authToken: string = '';
  /** 在途的 pub 报文：帧 id → 本地消息 id（ctl 回来时按 seq 更新送达状态）。 */
  private pendingPub: Map<string, string> = new Map();
  /** 本地消息 id → 报文 id（重发/失败的展示用）。 */
  private statusByLocalId: Map<string, string> = new Map();
  /** 订阅完成前排队等待发送的动作。 */
  private pendingSends: (() => void)[] = [];

  constructor(listener: DemoListener) {
    this.listener = listener;
  }

  /** 连接（`loginScheme:'none'`：先连上，随后注册或登录）。 */
  connect(wsUrl: string, apiKey: string, appName: string = 'tinode-harmony-demo/0.1.0'): void {
    this.disconnect();
    this.transport = new TinodeSocket(wsUrl, apiKey);
    this.apiKey = apiKey;
    this.serverBase = DemoClient.httpBaseOf(wsUrl);
    // 会话配置：先用 SDK 的默认值构造，再按 demo 需要覆盖（类型明确，避免 ArkTS 无类型字面量）
    const sessionConfig: ImSessionConfig = defaultSessionConfig(wsUrl, '', appName, '');
    sessionConfig.loginScheme = 'none';        // 先连上，再注册或登录
    sessionConfig.autoResubscribe = true;      // 断线后自动重订阅
    sessionConfig.syncHistoryOnReconnect = true;
    sessionConfig.maxBackoffMs = 30000;
    const hooks: TinodeHooks = {
      onState: (state: ImSessionState) => this.listener.onState(state, ''),
      onServerVersion: (version: string) => this.listener.onState('ready', `服务端协议 ${version}`),
      onTopics: (topics: TinodeTopic[]) => this.emitConversations(topics),
      onTopicState: (state: TinodeTopicState) => {
        this.listener.onLog(`主题 ${state.topic} 已订阅=${state.subscribed} lastSeq=${state.lastSeq}`);
        if (state.subscribed) this.flushPendingSends();      // 订阅成功后再补发排队中的消息
      },
      onRawData: undefined,
      onMessage: (message: TinodeMessage) => this.appendMine(message),
      onMeta: (meta: ImMeta) => this.listener.onLog(`meta（${meta.sub === undefined ? 0 : meta.sub.length} 条订阅）`),
      onPres: (pres: ImPres) => this.listener.onLog(`presence ${pres.topic} ${pres.what === undefined ? '' : pres.what}`),
      onNote: (note: ImNote) => this.listener.onLog(`note ${note.topic === undefined ? '' : note.topic} ${note.what === undefined ? '' : note.what}`),
      onInfo: (info: ImInfo) => this.listener.onLog(`info ${info.topic}`),
      onCtrl: (ctrl: ImCtrl) => {
        const frameId = ctrl.id === undefined ? '' : ctrl.id;
        const localId = this.pendingPub.get(frameId);
        if (localId !== undefined && ctrl.code >= 200 && ctrl.code < 300) {
          this.pendingPub.delete(frameId);
          this.markStatus(localId, 'sent');
        } else if (localId !== undefined && ctrl.code >= 400) {
          this.pendingPub.delete(frameId);
          this.markStatus(localId, 'failed');
        }
        this.listener.onLog(`ctrl code=${ctrl.code}`);
      },
      onFailure: (text: string) => this.listener.onState('failed', text),
      onAuth: (auth: TinodeAuth) => {
        this.authToken = auth.token;                       // 附件上传要带 token（HTTP 侧不是 WS 会话）
        this.listener.onLog(`凭据已签发 uid=${auth.uid}`);
      }
    };
    const options: TinodeOptions = {
      transport: this.transport,
      config: sessionConfig,
      storage: this.storage,
      hooks: hooks,
      autoSubscribeMe: true
    };
    this.tinode = new Tinode(options);
    this.tinode.start(Date.now());
    this.tickTimer = setInterval(() => {
      const client = this.tinode;
      if (client !== null) client.tick(Date.now());
    }, 200);
    this.listener.onLog(`开始连接 ${wsUrl}（apikey ${apiKey.length} 字符）`);
  }

  disconnect(): void {
    if (this.tickTimer >= 0) {
      clearInterval(this.tickTimer);
      this.tickTimer = -1;
    }
    const client = this.tinode;
    this.tinode = null;
    if (client !== null) client.stop();
  }

  /** 注册（`acc{user:"new"}`；服务端会直接签发 token）。 */
  async register(user: string, password: string): Promise<void> {
    const client = this.tinode;
    if (client === null) throw new Error('未连接');
    const auth = await client.registerAccount(user, password, user);
    this.listener.onLog(`注册成功 uid=${auth.uid}`);
    client.loadSubscriptions(50);
  }

  /** 用已注册的账号密码登录（basic scheme）。 */
  login(user: string, password: string): void {
    const client = this.tinode;
    if (client === null) {
      this.listener.onState('failed', '未连接');
      return;
    }
    // basic secret 由 SDK 负责 base64 编码
    client.configurePasswordLogin(user, password);
    client.start(Date.now());
  }

  /** 附件上传要带的头：apikey（服务端要求时）+ 登录 token（`file/u` 需要已认证身份）。 */
  private uploadHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.apiKey.length > 0) headers['X-Tinode-APIKey'] = this.apiKey;
    if (this.authToken.length > 0) headers['X-Tinode-Auth'] = this.authToken;
    return headers;
  }

  /**
   * 订阅成功前不发消息：Tinode 对"还没订阅就 pub"会回 409。
   * `whenSubscribed` 把动作排队，等 `onTopicState(subscribed=true)` 时统一补发。
   */
  private whenSubscribed(action: () => void): void {
    const client = this.tinode;
    const state = client === null ? null : client.topicState(this.currentTopic);
    if (state !== null && state.subscribed) {
      action();
      return;
    }
    this.pendingSends.push(action);
    this.listener.onLog('会话还在订阅中，消息已排队，订阅完成后自动发送');
  }

  /** 订阅完成后补发排队消息。 */
  private flushPendingSends(): void {
    if (this.pendingSends.length === 0) return;
    const queued = this.pendingSends;
    this.pendingSends = [];
    for (let i = 0; i < queued.length; i++) queued[i]();
    this.listener.onLog(`已补发 ${queued.length} 条排队消息`);
  }

  /** 由 ws(s) 端点推导 http(s) 基地址（附件上传用；推导不出返回空串走"仅本地 ref"路径）。 */
  private static httpBaseOf(wsUrl: string): string {
    const text = wsUrl.trim();
    if (text.startsWith('wss://')) return `https://${text.slice(6).split('/')[0]}`;
    if (text.startsWith('ws://')) return `http://${text.slice(5).split('/')[0]}`;
    return '';
  }

  /**
   * 发送 picker 选中的图片/文件：SDK 侧做校验 → 分块规划 → （可选）真上传 → 发布实体消息。
   * 上传走 `HarmonyAttachmentHttp`（**未真机验证**）；未配置服务端基地址或上传失败时退回本地 ref，并如实打日志。
   */
  async sendPickedFile(file: PickedFile, bytes: Uint8Array | null): Promise<void> {
    const client = this.tinode;
    if (client === null || this.currentTopic.length === 0) {
      this.listener.onUploadProgress(0, '先打开一个会话');
      return;
    }
    const check = validateAttachment({ name: file.name, mime: file.mime, size: file.size });
    if (!check.ok) {
      this.listener.onUploadProgress(0, check.reason);
      return;
    }
    const chunks = planChunks(file.size);
    this.listener.onUploadProgress(0, `准备上传 ${file.name}（${chunks.length} 块）`);
    let ref = '';
    let url: string | undefined = undefined;
    if (bytes !== null && this.serverBase.length > 0) {
      this.listener.onUploadProgress(5, `上传中 ${file.name}`);
      const http = new HarmonyAttachmentHttp();
      const target = attachmentUploadUrl(this.serverBase);
      const response = await http.upload({
        url: target,
        headers: this.uploadHeaders(),
        fieldName: 'file',
        fileName: file.name,
        mime: file.mime,
        bytes: bytes.buffer as ArrayBuffer,
        topic: this.currentTopic
      }, (loaded: number, total: number) => {
        this.listener.onUploadProgress(progressPercent(loaded, total), `上传 ${file.name}`);
      });
      const parsed = uploadedRefOf(response.body);
      if (parsed === null) {
        this.listener.onUploadProgress(0, `上传失败（HTTP ${response.status}），退回本地 ref`);
        ref = cacheKeyOf(file.uri, file.mime);
      } else {
        ref = parsed.ref;
        url = parsed.url;
        this.listener.onUploadProgress(100, `上传完成 ${file.name}`);
      }
    } else {
      ref = cacheKeyOf(file.uri, file.mime);
      this.listener.onUploadProgress(100, bytes === null ? `${file.name}：内容过大未读取，仅发元数据` : `${file.name}：未配置上传地址，仅发本地 ref`);
    }
    const drafty = attachmentDrafty(
      { name: file.name, mime: file.mime, size: file.size }, { ref: ref, url: url }, file.name);
    client.publish(this.currentTopic, drafty, { mime: 'text/x-drafty' });
    this.listener.onLog(`附件消息已发送 ${file.name}（${file.mime} / ${file.size}B / ref=${ref.slice(0, 12)}…）`);
  }

  /** 发送录到的语音（PCM/WAV 元数据；真上传同样走附件 HTTP）。 */
  async sendVoice(voice: RecordedVoice): Promise<void> {
    const client = this.tinode;
    if (client === null || this.currentTopic.length === 0) return;
    const name = `voice-${Date.now()}.wav`;
    const check = validateAttachment({ name: name, mime: 'audio/wav', size: voice.bytes.length });
    if (!check.ok) {
      this.listener.onUploadProgress(0, check.reason);
      return;
    }
    let ref = cacheKeyOf(name, 'audio/wav');
    let url: string | undefined = undefined;
    if (this.serverBase.length > 0) {
      const http = new HarmonyAttachmentHttp();
      const response = await http.upload({
        url: attachmentUploadUrl(this.serverBase),
        headers: this.uploadHeaders(),
        fieldName: 'file',
        fileName: name,
        mime: 'audio/wav',
        bytes: voice.bytes.buffer as ArrayBuffer,
        topic: this.currentTopic
      }, (loaded: number, total: number) => {
        this.listener.onUploadProgress(progressPercent(loaded, total), '上传语音');
      });
      const parsed = uploadedRefOf(response.body);
      if (parsed !== null) {
        ref = parsed.ref;
        url = parsed.url;
      } else {
        this.listener.onUploadProgress(0, `语音上传失败（HTTP ${response.status}），仅发元数据`);
      }
    }
    const drafty = attachmentDrafty(
      { name: name, mime: 'audio/wav', size: voice.bytes.length, duration: voice.durationMs },
      { ref: ref, url: url }, name);
    client.publish(this.currentTopic, drafty, { mime: 'text/x-drafty' });
    this.listener.onLog(`语音已发送 ${voice.durationMs}ms / ${voice.bytes.length}B`);
  }

  /** 自己的 uid（注册/登录后才有）。 */
  myUid(): string {
    const client = this.tinode;
    return client === null ? '' : client.myUid();
  }

  /** 拉会话列表（`get{topic:"me", what:"sub"}`）。 */
  refreshConversations(): void {
    const client = this.tinode;
    if (client !== null) client.loadSubscriptions(50);
  }

  /** 打开会话：订阅 + 拉最近一页历史。 */
  openTopic(topic: string): void {
    const client = this.tinode;
    if (client === null) return;
    this.currentTopic = topic;
    const subscribeOptions: TinodeSubscribeOptions = { withDesc: true, withSub: true, limit: 24 };
    client.subscribe(topic, subscribeOptions);
    client.loadProfile(topic);
    this.loadHistory(topic, 0, 30);
    this.listener.onLog(`打开会话 ${topic}`);
  }

  /** 历史分页（`before` 翻旧账）。 */
  loadHistory(topic: string, beforeSeq: number, limit: number): void {
    const client = this.tinode;
    if (client === null) return;
    client.history(topic, beforeSeq, limit);
  }

  /** 发文本（可带富文本标记，演示 P6 写侧）。 */
  sendText(text: string, bold: boolean, italic: boolean): void {
    const client = this.tinode;
    if (client === null || this.currentTopic.length === 0) return;
    let drafty: Drafty = draftyPlain(text);
    if (bold) drafty = draftyWithStyle(drafty, 0, text.length, 'ST');
    if (italic) drafty = draftyWithStyle(drafty, 0, text.length, 'EM');
    const localId = `local-${Date.now()}`;
    this.appendLocal(localId, this.currentTopic, text, draftySegments(drafty), 'text', 'sending');
    this.whenSubscribed(() => {
      const frameId = client.publish(this.currentTopic, drafty, { mime: 'text/x-drafty' });
      if (frameId.length > 0) this.pendingPub.set(frameId, localId);
      else this.markStatus(localId, 'failed');
    });
    this.listener.onLog(`发送（${text.length} 字${bold ? '，加粗' : ''}${italic ? '，斜体' : ''}）`);
  }

  /**
   * 附件：校验 → 分块规划 → 进度 → 生成消息内容。
   * 演示只做"本地文件大小/类型"的纯逻辑部分 + 实体落库；真正上传需要平台 HTTP（`TinodeAttachmentHttp`，未真机验证）。
   */
  sendLocalFile(name: string, mime: string, size: number): void {
    const client = this.tinode;
    if (client === null || this.currentTopic.length === 0) return;
    const check = validateAttachment({ name: name, mime: mime, size: size });
    if (!check.ok) {
      this.listener.onUploadProgress(0, check.reason);
      return;
    }
    const chunks = planChunks(size);
    this.listener.onUploadProgress(progressPercent(0, size), `准备上传：${name}（${chunks.length} 块）`);
    for (let i = 0; i < chunks.length; i++) {
      this.listener.onUploadProgress(progressPercent(chunks[i].offset + chunks[i].length, size),
        `分块 ${i + 1}/${chunks.length}`);
    }
    // 无后端时用本地 ref 占位，演示消息内容结构（实体 + 名称/大小/mime）
    const drafty = attachmentDrafty({ name: name, mime: mime, size: size }, { ref: cacheKeyOf(name, mime) }, name);
    this.whenSubscribed(() => client.publish(this.currentTopic, drafty, { mime: 'text/x-drafty' }));
    this.listener.onLog(`附件消息已发送（本地 ref，未真正上传）`);
  }

  /** 引用消息（`QQ` 实体 + 被引序号放在 data.val）。 */
  sendQuote(text: string, quotedSeq: number): void {
    const client = this.tinode;
    if (client === null || this.currentTopic.length === 0) return;
    const drafty = draftyWithEntity(draftyPlain(text), 0, text.length, 'QQ', { val: `seq:${quotedSeq}` });
    this.whenSubscribed(() => client.publish(this.currentTopic, drafty, { mime: 'text/x-drafty' }));
    this.listener.onLog(`引用 seq=${quotedSeq} 并发送`);
  }

  /** 位置（demo 用链接形态承载 `geo:lat,lng`；真实产品用自定义 head 承载坐标）。 */
  sendLocation(label: string, lat: number, lng: number): void {
    const client = this.tinode;
    if (client === null || this.currentTopic.length === 0) return;
    const text = `${label}`;
    const drafty = draftyLink(draftyPlain(text), 0, text.length, `geo:${lat},${lng}`);
    this.whenSubscribed(() => client.publish(this.currentTopic, drafty, { mime: 'text/x-drafty' }));
    this.listener.onLog(`位置已发送 ${label}`);
  }

  /** 表情（表情在 Tinode 里也是消息内容；这里直接发 emoji 文本）。 */
  sendSticker(emoji: string): void {
    const client = this.tinode;
    if (client === null || this.currentTopic.length === 0) return;
    this.whenSubscribed(() => client.publish(this.currentTopic, draftyPlain(emoji), { mime: 'text/x-drafty' }));
    this.listener.onLog(`表情已发送 ${emoji}`);
  }

  /** 存储缓存统计（P4：`CachedTinodeStorage.stats()`）。 */
  cacheLine(): string {
    const stats = this.storage.stats();
    return `缓存 命中=${stats.hits} 未命中=${stats.misses} 槽位=${stats.entries}`;
  }

  /** 已读 / 正在输入 / 撤回 / 权限摘要 / 缓存统计。 */
  markRead(seq: number): void {
    const client = this.tinode;
    if (client !== null && this.currentTopic.length > 0) client.setRead(this.currentTopic, seq);
  }

  sendTyping(): void {
    const client = this.tinode;
    if (client !== null && this.currentTopic.length > 0) client.setTyping(this.currentTopic);
  }

  retract(seq: number): void {
    const client = this.tinode;
    if (client !== null && this.currentTopic.length > 0) {
      const range: DelRange = { low: seq };
      client.deleteMessages(this.currentTopic, [range], false);
      this.listener.onLog(`撤回/删除 seq=${seq}`);
    }
  }

  accessOf(topic: string): string {
    const mode = this.accessByTopic.get(topic);
    return mode === undefined ? '' : acsSummary(mode);
  }

  cacheStats(): StorageCacheStats {
    return this.storage.stats();
  }

  topics(): TinodeTopicState[] {
    const client = this.tinode;
    return client === null ? [] : client.knownTopics();
  }

  profiles(): TinodeProfile[] {
    const client = this.tinode;
    return client === null ? [] : client.profiles();
  }

  /** 某个会话的最后一条消息（会话列表预览用）。 */
  private lastMessageOfTopic(topic: string): DemoMessage | null {
    const bucket = this.messagesByTopic.get(topic);
    if (bucket === undefined || bucket.length === 0) return null;
    let last: DemoMessage | null = null;
    for (let i = 0; i < bucket.length; i++) {
      if (last === null || bucket[i].ts >= last.ts) last = bucket[i];
    }
    return last;
  }

  /** 自己发出的消息（门面 `onMessage` 回调，落库后的回显）。 */
  private appendMine(message: TinodeMessage): void {
    const drafty = message.content;
    const segments = draftySegments(drafty);
    const attachment: AttachmentMeta | null = attachmentOfDrafty(drafty);
    const kind = segments.length > 0 && segments[0].entity !== null ? segments[0].entity.tp : 'text';
    const item: DemoMessage = {
      id: message.id, topic: message.topic, seq: message.seq, isMine: message.isMine, ts: message.ts,
      text: drafty === null ? '' : drafty.txt, segments: segments, kind: kind,
      showTime: false, timeText: timeLabelOf(message.ts, Date.now()), status: 'sent',
      fileName: attachment === null ? '' : attachment.name,
      fileSize: attachment === null ? 0 : attachment.size,
      durationMs: attachment === null || attachment.duration === undefined ? 0 : attachment.duration
    };
    let bucket = this.messagesByTopic.get(message.topic);
    if (bucket === undefined) {
      bucket = [];
      this.messagesByTopic.set(message.topic, bucket);
    }
    let replaced = false;
    for (let i = 0; i < bucket.length; i++) {
      if (bucket[i].id === item.id) {
        bucket[i] = item;
        replaced = true;
      }
    }
    if (!replaced) bucket.push(item);
    this.decorate(bucket);
    if (message.topic === this.currentTopic) this.listener.onMessages(bucket.slice());
  }

  /** 本地先落一条消息（发送中），等 ctrl 回来再改状态。 */
  private appendLocal(localId: string, topic: string, text: string, segments: DraftySegment[],
    kind: string, status: string): void {
    let bucket = this.messagesByTopic.get(topic);
    if (bucket === undefined) {
      bucket = [];
      this.messagesByTopic.set(topic, bucket);
    }
    const now = Date.now();
    bucket.push({
      id: localId, topic: topic, seq: -1, isMine: true, ts: now, text: text, segments: segments, kind: kind,
      showTime: false, timeText: timeLabelOf(now, now), status: status,
      fileName: '', fileSize: 0, durationMs: 0
    });
    this.statusByLocalId.set(localId, status);
    this.decorate(bucket);
    if (topic === this.currentTopic) this.listener.onMessages(bucket.slice());
  }

  /** 更新某条本地消息的送达状态。 */
  private markStatus(localId: string, status: string): void {
    this.statusByLocalId.set(localId, status);
    this.messagesByTopic.forEach((bucket: DemoMessage[], topic: string) => {
      for (let i = 0; i < bucket.length; i++) {
        if (bucket[i].id === localId) bucket[i].status = status;
      }
      if (topic === this.currentTopic) this.listener.onMessages(bucket.slice());
    });
  }

  /** 计算时间标签（相邻间隔 > 5 分钟插一条）并按时间排序。 */
  private decorate(bucket: DemoMessage[]): void {
    bucket.sort((left: DemoMessage, right: DemoMessage): number => left.ts - right.ts);
    let previous: TinodeMessage | null = null;
    for (let i = 0; i < bucket.length; i++) {
      const item = bucket[i];
      const asWire: TinodeMessage = {
        id: item.id, topic: item.topic, seq: item.seq, from: '', isMine: item.isMine, ts: item.ts,
        content: null, head: null
      };
      item.showTime = needsTimeLabel(previous, asWire);
      item.timeText = timeLabelOf(item.ts, Date.now());
      previous = asWire;
    }
  }

  /** 会话列表推送（SDK 的 `onTopics`）。 */
  private emitConversations(topics: TinodeTopic[]): void {
    const list: DemoConversation[] = [];
    for (let i = 0; i < topics.length; i++) {
      const topic = topics[i];
      if (topic.topic === 'me') continue;              // `me` 是"我的订阅列表"这个伪主题，不是会话
      const last = this.lastMessageOfTopic(topic.topic);
      list.push({
        topic: topic.topic,
        name: topic.name.length > 0 ? topic.name : topic.topic,
        photo: this.profilePhotos.get(topic.topic) === undefined ? '' : this.profilePhotos.get(topic.topic) as string,
        unread: topic.read > 0 ? Math.max(0, topic.seq - topic.read) : topic.seq,
        online: topic.online,
        lastSeenMs: topic.lastSeenMs === undefined ? 0 : topic.lastSeenMs,
        seq: topic.seq,
        subscribed: true,
        accessSummary: this.accessOf(topic.topic),
        preview: last === null ? '' : previewOfKind(last.kind, last.text),
        timeText: last === null ? '' : timeLabelOf(last.ts, Date.now())
      });
    }
    list.sort((left: DemoConversation, right: DemoConversation): number => right.seq - left.seq);
    this.listener.onConversations(list);
  }

  /** data 报文 → 页面消息（用 Drafty 读侧 + segments 渲染）。 */
  private absorbData(data: ImData): void {
    const drafty = parseDraftyJson(typeof data.content === 'string' ? data.content : JSON.stringify(data.content));
    const segments = draftySegments(drafty);
    let text = '';
    if (drafty !== null) text = drafty.txt;
    const attachment: AttachmentMeta | null = attachmentOfDrafty(drafty);
    const receivedKind = segments.length > 0 && segments[0].entity !== null ? segments[0].entity.tp : 'text';
    const message: DemoMessage = {
      id: `${data.topic}-${data.seq}`,
      topic: data.topic,
      seq: data.seq,
      isMine: false,
      ts: Date.now(),
      text: text,
      segments: segments,
      kind: receivedKind,
      showTime: false, timeText: timeLabelOf(Date.now(), Date.now()), status: 'delivered',
      fileName: attachment === null ? '' : attachment.name,
      fileSize: attachment === null ? 0 : attachment.size,
      durationMs: attachment === null || attachment.duration === undefined ? 0 : attachment.duration
    };
    let bucket = this.messagesByTopic.get(data.topic);
    if (bucket === undefined) {
      bucket = [];
      this.messagesByTopic.set(data.topic, bucket);
    }
    bucket.push(message);
    this.decorate(bucket);
    if (data.topic === this.currentTopic) this.listener.onMessages(bucket.slice());
    this.listener.onLog(`收到 ${data.topic} seq=${data.seq}`);
  }
}
