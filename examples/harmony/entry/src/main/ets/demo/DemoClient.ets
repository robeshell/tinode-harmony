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
  acsSummary, attachmentDrafty,
  cacheKeyOf, defaultSessionConfig, DelRange, draftyPlain, draftySegments, draftyWithStyle, parseDraftyJson, planChunks,
  progressPercent, validateAttachment
} from '../tinode/Index.ts';
import { TinodeSocket } from '../tinode/Socket.ets';

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

  constructor(listener: DemoListener) {
    this.listener = listener;
  }

  /** 连接（`loginScheme:'none'`：先连上，随后注册或登录）。 */
  connect(wsUrl: string, apiKey: string, appName: string = 'tinode-harmony-demo/0.1.0'): void {
    this.disconnect();
    this.transport = new TinodeSocket(wsUrl, apiKey);
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
      onTopicState: (state: TinodeTopicState) => this.listener.onLog(`主题 ${state.topic} 已订阅=${state.subscribed} lastSeq=${state.lastSeq}`),
      onRawData: undefined,
      onMessage: (message: TinodeMessage) => this.appendMine(message),
      onMeta: (meta: ImMeta) => this.listener.onLog(`meta（${meta.sub === undefined ? 0 : meta.sub.length} 条订阅）`),
      onPres: (pres: ImPres) => this.listener.onLog(`presence ${pres.topic} ${pres.what === undefined ? '' : pres.what}`),
      onNote: (note: ImNote) => this.listener.onLog(`note ${note.topic === undefined ? '' : note.topic} ${note.what === undefined ? '' : note.what}`),
      onInfo: (info: ImInfo) => this.listener.onLog(`info ${info.topic}`),
      onCtrl: (ctrl: ImCtrl) => this.listener.onLog(`ctrl code=${ctrl.code}`),
      onFailure: (text: string) => this.listener.onState('failed', text),
      onAuth: (auth: TinodeAuth) => this.listener.onLog(`凭据已签发 uid=${auth.uid}`)
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
    client.publish(this.currentTopic, drafty, { mime: 'text/x-drafty' });
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
    client.publish(this.currentTopic, drafty, { mime: 'text/x-drafty' });
    this.listener.onLog(`附件消息已发送（本地 ref，未真正上传）`);
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

  /** 自己发出的消息（门面 `onMessage` 回调，落库后的回显）。 */
  private appendMine(message: TinodeMessage): void {
    const drafty = message.content;
    const segments = draftySegments(drafty);
    const item: DemoMessage = {
      id: message.id, topic: message.topic, seq: message.seq, isMine: message.isMine, ts: message.ts,
      text: drafty === null ? '' : drafty.txt, segments: segments,
      kind: segments.length > 0 && segments[0].entity !== null ? segments[0].entity.tp : 'text'
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
    if (message.topic === this.currentTopic) this.listener.onMessages(bucket.slice());
  }

  /** 会话列表推送（SDK 的 `onTopics`）。 */
  private emitConversations(topics: TinodeTopic[]): void {
    const list: DemoConversation[] = [];
    for (let i = 0; i < topics.length; i++) {
      const topic = topics[i];
      list.push({
        topic: topic.topic,
        name: topic.name.length > 0 ? topic.name : topic.topic,
        photo: this.profilePhotos.get(topic.topic) === undefined ? '' : this.profilePhotos.get(topic.topic) as string,
        unread: topic.read > 0 ? Math.max(0, topic.seq - topic.read) : topic.seq,
        online: topic.online,
        lastSeenMs: topic.lastSeenMs === undefined ? 0 : topic.lastSeenMs,
        seq: topic.seq,
        subscribed: true,
        accessSummary: this.accessOf(topic.topic)
      });
    }
    this.listener.onConversations(list);
  }

  /** data 报文 → 页面消息（用 Drafty 读侧 + segments 渲染）。 */
  private absorbData(data: ImData): void {
    const drafty = parseDraftyJson(typeof data.content === 'string' ? data.content : JSON.stringify(data.content));
    const segments = draftySegments(drafty);
    let text = '';
    if (drafty !== null) text = drafty.txt;
    const message: DemoMessage = {
      id: `${data.topic}-${data.seq}`,
      topic: data.topic,
      seq: data.seq,
      isMine: false,
      ts: Date.now(),
      text: text,
      segments: segments,
      kind: segments.length > 0 && segments[0].entity !== null ? segments[0].entity.tp : 'text'
    };
    let bucket = this.messagesByTopic.get(data.topic);
    if (bucket === undefined) {
      bucket = [];
      this.messagesByTopic.set(data.topic, bucket);
    }
    bucket.push(message);
    if (data.topic === this.currentTopic) this.listener.onMessages(bucket.slice());
    this.listener.onLog(`收到 ${data.topic} seq=${data.seq}`);
  }
}
