/**
 * tinode-harmony —— Tinode 即时通讯协议的 HarmonyOS 客户端 SDK。
 *
 * 许可：MIT（见同目录 LICENSE）。本实现为**独立 ArkTS 重写**；
 * 协议常量与报文形状参考 Tinode 官方文档与 Apache-2.0 的 `co/tinode/tinodesdk`（见 NOTICE）。
 */

/**
 * `Tinode` 门面：把「会话状态机 + 存储端口」合成宿主真正想要的东西。
 *
 * 宿主只需要给：传输（或让它用 `TinodeSocket`）、会话配置、存储实现（可省，默认内存）、
 * 以及一组回调；门面负责握手/订阅/收发的编排**与落库**，宿主不再自己解析 `data` 报文。
 *
 * 与 `ImSession` 的分工：`ImSession` 是纯协议状态机（可单独用），`Tinode` 是它的门面 +
 * 存储端口接线 + 事件回调；**业务语义**（内容类型、送达状态、未读口径、列表偏好）仍在宿主。
 */
import type { ImHead } from './TinodeHead.ts';
import type { Drafty } from './Drafty.ts';
import type { TinodeTopicState } from './TinodeTopics.ts';
import { applyPresence, mergeProfiles, profileFromDesc, profilesFromMeta, sortTopicsByActivity, topicOfProfile } from './TinodeMeta.ts';
import type { TinodeProfile } from './TinodeMeta.ts';
import type { TinodeAuth } from './TinodeSession.ts';
import { ImSession, defaultSessionConfig } from './TinodeSession.ts';
import type { ImSessionConfig, ImSessionState, ImTransport } from './TinodeSession.ts';
import type { ImCtrl, ImData, ImInfo, ImMeta, ImNote, ImPres, DelRange } from './TinodeWire.ts';
import { redactTopic, tinodeLogDetail, tinodeLogFailure } from './TinodeLog.ts';
import { buildPub } from './TinodeWire.ts';
import { MemoryTinodeStorage } from './TinodeStorage.ts';
import type { TinodeStorage } from './TinodeStorage.ts';
import { tinodeMessageFromData } from './TinodeMessage.ts';
import type { TinodeDraft, TinodeMessage, TinodeTopic } from './TinodeMessage.ts';

/** 宿主回调（门面已经把消息落库，再交给宿主做业务投影）。 */
/** 单帧默认上限：Tinode 服务端默认 `max_message_size` ≈ 256 KB。 */
import { DEFAULT_MAX_FRAME_BYTES } from './TinodeWire.ts';
export { DEFAULT_MAX_FRAME_BYTES } from './TinodeWire.ts';

/** 归一化分页条数（非有限/≤0 → 默认值；上限 100，避免一次拉爆）。 */
function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  const rounded = Math.floor(value);
  return rounded > 100 ? 100 : rounded;
}

export interface TinodeHooks {
  /**
   * **原始** `data` 报文（在转换与落库之前）。已经自带消息管线的宿主用它可以完全接管落库，
   * 配合 `persistIncoming: false` 使用（这时门面只做协议操作，不碰存储）。
   */
  onRawData?: (data: ImData) => void;
  onMessage?: (message: TinodeMessage) => void;
  onState?: (state: ImSessionState) => void;
  onCtrl?: (ctrl: ImCtrl) => void;
  onInfo?: (info: ImInfo) => void;
  onPres?: (pres: ImPres) => void;
  onMeta?: (meta: ImMeta) => void;
  onNote?: (note: ImNote) => void;
  onFailure?: (text: string) => void;
  /** 服务端版本（`hi` 的 `ver`）。 */
  onServerVersion?: (version: string) => void;
  /** 主题状态变化（订阅结果 / 位点推进）——P1 新增，可选。 */
  onTopicState?: (state: TinodeTopicState) => void;
  /** 会话列表刷新（P5-min：收到 `meta` 合并后回调，可直接渲染列表）。 */
  onTopics?: (topics: TinodeTopic[]) => void;
  /** 服务端签发凭据（登录/注册成功；P3-min）——宿主自行安全保存 `token`。 */
  onAuth?: (auth: TinodeAuth) => void;
}

/** 构造门面的参数。 */
export interface TinodeOptions {
  transport: ImTransport;
  config: ImSessionConfig;
  /** 存储端口；不传用内存实现。`persistIncoming: false` 时不会用到。 */
  storage?: TinodeStorage;
  /**
   * 单帧上限（字节，默认 256 KB —— Tinode 服务端默认 `max_message_size`）。
   * 超限的 `publish` **不发出去**，按 `onFailure` 报错并返回空串（审计 P0-2）。
   */
  maxFrameBytes?: number;
  /** 连上后由 SDK 自动重新订阅登记过的主题（默认 true，见 `ImSessionConfig.autoResubscribe`）。 */
  autoResubscribe?: boolean;
  /**
   * 连上后自动订阅 `me`（默认 **true**）——`me` 的 `meta.sub[]` 就是"我的会话列表"，
   * 门面据此落库并回调 `hooks.onTopics`。宿主完全自己管会话列表时置 false。
   */
  autoSubscribeMe?: boolean;
  /** 重连后从各主题 `lastSeq+1` 补历史（默认 true，见 `ImSessionConfig.syncHistoryOnReconnect`）。 */
  syncHistoryOnReconnect?: boolean;
  /**
   * 是否由门面把收到的消息落库（默认 **true**，外部宿主开箱即用）。
   * 宿主自己有消息管线（本地 echo/送达状态/未读/列表刷新）时置 **false**，改用 `hooks.onRawData` 接管。
   */
  persistIncoming?: boolean;
  hooks?: TinodeHooks;
}

/** 订阅参数（默认要 desc 与 sub，一页 24 条——与 Android 客户端的取法一致）。 */
export interface TinodeSubscribeOptions {
  withDesc?: boolean;
  withSub?: boolean;
  limit?: number;
}

export class Tinode {
  private readonly session: ImSession;
  private readonly store: TinodeStorage;
  private readonly hooks: TinodeHooks;
  private readonly persistIncoming: boolean;
  private readonly maxFrameBytes: number;
  private readonly autoSubscribeMe: boolean;
  /** P5-min：已知的会话轮廓（内存态；落库走 `store.upsertTopic`）。 */
  private profilesByTopic: Map<string, TinodeProfile> = new Map();
  /** 最近一次落库的会话模型（保留 `lastPreview` 等宿主维护的字段）。 */
  private topicsByTopic: Map<string, TinodeTopic> = new Map();
  private meSubscribed: boolean = false;
  /** P3-min：注册/登录等待中的 Promise 回调（一次一个，够用且简单）。 */
  private pendingAuth: ((auth: TinodeAuth) => void) | null = null;
  private pendingAuthReject: ((reason: string) => void) | null = null;

  constructor(options: TinodeOptions) {
    this.hooks = options.hooks === undefined ? {} : options.hooks;
    this.store = options.storage === undefined ? new MemoryTinodeStorage() : options.storage;
    this.persistIncoming = options.persistIncoming === undefined ? true : options.persistIncoming;
    this.autoSubscribeMe = options.autoSubscribeMe === undefined ? true : options.autoSubscribeMe;
    const cap = options.maxFrameBytes;
    this.maxFrameBytes = cap === undefined || !Number.isFinite(cap) || cap <= 0 ? DEFAULT_MAX_FRAME_BYTES : cap;
    this.session = new ImSession(options.transport, options.config, {
      onState: (state: ImSessionState) => {
        // P5-min：进入 ready 时自动订阅 `me`（会话列表来源）；离开 ready 时重置标记，重连后会再订一次。
        if (state === 'ready') {
          if (this.autoSubscribeMe && !this.meSubscribed) {
            this.meSubscribed = true;
            this.session.subscribeTracked('me', false, true, 0);
          }
        } else {
          this.meSubscribed = false;
        }
        const done = this.hooks.onState;
        if (done !== undefined) done(state);
      },
      onData: (data: ImData) => { this.handleData(data); },
      onInfo: (info: ImInfo) => {
        const done = this.hooks.onInfo;
        if (done !== undefined) done(info);
      },
      onPres: (pres: ImPres) => {
        this.absorbPresence(pres);                // P5-min：在线/最后在线
        const done = this.hooks.onPres;
        if (done !== undefined) done(pres);
      },
      onMeta: (meta: ImMeta) => {
        this.absorbMeta(meta);                    // P5-min：把 meta.sub[] 变成会话列表
        const done = this.hooks.onMeta;
        if (done !== undefined) done(meta);
      },
      onNote: (note: ImNote) => {
        const done = this.hooks.onNote;
        if (done !== undefined) done(note);
      },
      onCtrl: (ctrl: ImCtrl) => {
        const done = this.hooks.onCtrl;
        if (done !== undefined) done(ctrl);
      },
      onFailure: (text: string) => {
        const reject = this.pendingAuthReject;
        if (reject !== null) {
          this.pendingAuth = null;
          this.pendingAuthReject = null;
          reject(text);
        }
        const done = this.hooks.onFailure;
        if (done !== undefined) done(text);
      },
      onServerVersion: (version: string) => {
        tinodeLogDetail('tinode', `server ${version}`, 'info');
        const done = this.hooks.onServerVersion;
        if (done !== undefined) done(version);
      },
      onAuth: (auth: TinodeAuth) => {
        const resolve = this.pendingAuth;
        if (resolve !== null) {
          this.pendingAuth = null;
          this.pendingAuthReject = null;
          resolve(auth);
        }
        const done = this.hooks.onAuth;
        if (done !== undefined) done(auth);
      },
      onTopicState: options.hooks === undefined || options.hooks.onTopicState === undefined
        ? undefined : (state: TinodeTopicState) => {
          const done = options.hooks === undefined ? undefined : options.hooks.onTopicState;
          if (done !== undefined) done(state);
        }
    });
    // P1：主题生命周期开关（默认都开）。想自己管订阅/增量同步的宿主可显式关掉。
    if (options.autoResubscribe !== undefined) this.session.setAutoResubscribe(options.autoResubscribe);
    if (options.syncHistoryOnReconnect !== undefined) {
      this.session.setSyncHistoryOnReconnect(options.syncHistoryOnReconnect);
    }
  }

  /** 用默认配置 + 内置 WebSocket 的便捷构造（`Socket` 由 `.ets` 侧提供时才有）。 */
  static withDefaults(transport: ImTransport, wsUrl: string, token: string, appName: string,
    storage?: TinodeStorage, hooks?: TinodeHooks): Tinode {
    return new Tinode({
      transport: transport,
      config: defaultSessionConfig(wsUrl, token, appName, ''),
      storage: storage,
      hooks: hooks
    });
  }

  // ── 生命周期（tick 由宿主定时驱动，推荐 200ms） ────────────────────────────
  start(nowMs: number): void { this.session.start(nowMs); }
  tick(nowMs: number): void { this.session.tick(nowMs); }
  stop(): void { this.session.stop(); }
  /**
   * P5-min：把一条 `pres`（在线状态）应用到已知轮廓：`on` → 在线；`off`/`gone`/`rec` → 离线 + 记**最后在线**时间。
   * 没见过的 topic（还没收到 `meta`）先建一条骨架，保证 `onTopics` 拿到完整列表。
   */
  private absorbPresence(pres: ImPres): void {
    const topic = pres.topic === undefined ? '' : pres.topic.trim();
    if (topic.length === 0) return;
    const what = pres.what === undefined ? '' : pres.what;
    const known = this.profilesByTopic.get(topic);
    const base: TinodeProfile = known === undefined
      ? {
        topic: topic, peerUid: topic, name: '', photo: '', seq: 0, read: 0, recv: 0,
        online: false, touchedAtMs: 0, lastSeenMs: 0
      }
      : known;
    const updated = applyPresence(base, what, pres.t, Date.now());
    this.profilesByTopic.set(topic, updated);
    const nextTopic = topicOfProfile(updated, this.topicsByTopic.get(topic));
    this.topicsByTopic.set(topic, nextTopic);
    this.store.upsertTopic(nextTopic).catch((error: Object) => {
      tinodeLogDetail('tinode', `upsertTopic(pres) failed for ${redactTopic(topic)}`, 'error');
    });
    const rows: TinodeTopic[] = [];
    this.profilesByTopic.forEach((profile: TinodeProfile) => {
      const cached = this.topicsByTopic.get(profile.topic);
      if (cached !== undefined) rows.push(cached);
    });
    const done = this.hooks.onTopics;
    if (done !== undefined) done(sortTopicsByActivity(rows));
  }

  /**
   * P5-min：把一条 `meta` 里的 `sub[]` 合并成会话列表，落库并回调 `hooks.onTopics`。
   * 纯逻辑在 `TinodeMeta.ts`（`profilesFromMeta` / `mergeProfiles` / `topicOfProfile`）。
   */
  private absorbMeta(meta: ImMeta): void {
    const incoming = profilesFromMeta(meta);
    // `get{what:"desc"}` 的结果：把名片并进对应会话（P5 余项）。`meta.topic` 就是那个会话。
    const card = profileFromDesc(meta);
    if (card !== null) incoming.push(card);
    if (incoming.length === 0) return;
    const known: TinodeProfile[] = [];
    this.profilesByTopic.forEach((profile: TinodeProfile) => { known.push(profile); });
    const merged = mergeProfiles(known, incoming);
    this.profilesByTopic = new Map<string, TinodeProfile>();
    const topics: TinodeTopic[] = [];
    for (let i = 0; i < merged.length; i++) {
      const profile = merged[i];
      this.profilesByTopic.set(profile.topic, profile);
      const previous = this.topicsByTopic.get(profile.topic);
      const topic = topicOfProfile(profile, previous);
      this.topicsByTopic.set(profile.topic, topic);
      topics.push(topic);
      this.store.upsertTopic(topic).catch((error: Object) => {
        tinodeLogDetail('tinode', `upsertTopic failed for ${redactTopic(profile.topic)}`, 'error');
      });
    }
    const sorted = sortTopicsByActivity(topics);
    const done = this.hooks.onTopics;
    if (done !== undefined) done(sorted);
  }

  /**
   * P3-min：**注册账号并登录**（`acc{user:"new", login:true}`）。
   *
   * 前置：连接处于就绪态 —— 用 `loginScheme: 'none'` 构造（不要求 token），`start()` 后等 `state() === 'ready'`。
   * 成功返回服务端签发的 `{uid, token}`（**请自行安全保存**；SDK 不落盘）；失败 reject 一条用户可读文案。
   *
   * ```ts
   * const auth = await tinode.registerAccount('alice', 'pw123456', '爱丽丝');
   * // 下次直接用 token 登录：config.token = auth.token, loginScheme = 'token'
   * ```
   */
  registerAccount(user: string, password: string, fn: string = ''): Promise<TinodeAuth> {
    const name = user.trim();
    if (name.length === 0) return Promise.reject('用户名不能为空');
    if (password.length < 6) return Promise.reject('密码至少 6 位');
    if (this.session.state() !== 'ready') {
      return Promise.reject('连接尚未就绪：请用 loginScheme 设为 none 启动，等 state() 变成 ready 后再注册');
    }
    return new Promise<TinodeAuth>((resolve: (auth: TinodeAuth) => void, reject: (reason: string) => void) => {
      this.pendingAuth = resolve;
      this.pendingAuthReject = reject;
      const id = this.session.createAccount('basic', `${name}:${password}`, fn);
      if (id.length === 0) {
        this.pendingAuth = null;
        this.pendingAuthReject = null;
        reject('注册请求未发出：连接未就绪');
      }
    });
  }

  /**
   * P3-min：改成**用户名密码登录**（`basic` scheme）。必须在 `start()` **之前**调用。
   * 想先注册再登录的流程：用 `loginScheme:'none'` → `registerAccount()` → 拿 token 后下次用 `token` 登录。
   */
  configurePasswordLogin(user: string, password: string): void {
    this.session.setLoginScheme('basic');
    this.session.setToken(`${user.trim()}:${password}`);
  }

  /** 重新配置登录凭据（换号/重新登录时用；下一次 `start()` 生效）。 */
  configureTokenLogin(token: string): void {
    this.session.setLoginScheme('token');
    this.session.setToken(token);
  }

  /** P5 余项：拉某个会话/用户的名片（结果并进会话列表并回调 `onTopics`）。返回报文 id 或空串。 */
  loadProfile(topic: string): string {
    return this.session.loadProfile(topic);
  }

  /** P5 余项：拉"我的订阅列表"（会话列表）。返回报文 id；结果走 `meta` → `onTopics`。 */
  loadSubscriptions(limit: number = 0): string {
    return this.session.loadSubscriptions(limit);
  }

  /** P5 余项：改自己的公开名片（`set{topic:"me"}`）。返回报文 id。 */
  updatePublicName(fn: string, photo?: string): string {
    return this.session.updatePublicName(fn, photo);
  }

  /** P3 余项：改密码（`acc{user:<uid>, scheme:"basic"}`）。返回报文 id；结果走 `onCtrl`/`onFailure`。 */
  changePassword(login: string, newPassword: string): string {
    return this.session.changePassword(login, newPassword);
  }

  /** P3 余项：加待验证凭据（邮箱/手机号）。返回报文 id。 */
  addCredential(meth: string, val: string): string {
    return this.session.addCredential(meth, val);
  }

  /** P5-min：当前已知的会话列表（按最后活动倒序；未收到 `meta` 前为空）。 */
  profiles(): TinodeProfile[] {
    const rows: TinodeProfile[] = [];
    this.profilesByTopic.forEach((profile: TinodeProfile) => { rows.push(profile); });
    return rows;
  }

  /** P5-min：单个会话的轮廓（没收到过返回 null）。 */
  profileOf(topic: string): TinodeProfile | null {
    const profile = this.profilesByTopic.get(topic.trim());
    return profile === undefined ? null : profile;
  }

  /** 登记一个已知会话模型（宿主自己 upsert 过 topic 时同步进来，避免 `lastPreview` 被覆盖）。 */
  rememberTopic(topic: TinodeTopic): void {
    this.topicsByTopic.set(topic.topic, topic);
  }

  /** P1：登记过的主题快照（宿主可据此渲染会话列表/未读，最近活动的在前）。 */
  knownTopics(): TinodeTopicState[] { return this.session.knownTopics(); }

  /** P1：单个主题的状态快照（订阅结果 / lastSeq / read / recv）；没登记过返回 null。 */
  topicState(topic: string): TinodeTopicState | null { return this.session.topicState(topic); }

  state(): ImSessionState { return this.session.state(); }
  ready(): boolean { return this.session.ready(); }
  myUid(): string { return this.session.myUid(); }
  generation(): number { return this.session.generation(); }

  // ── 协议操作（返回值是报文 id，宿主可用它在 onCtrl 里认领结果） ──────────────
  subscribe(topic: string, options?: TinodeSubscribeOptions): string {
    // 审计 P0-1：门面做最小校验/归一，别把空 topic、0/负数 limit 透传给服务端。
    if (!this.acceptTopic(topic, 'subscribe')) return '';
    const opts: TinodeSubscribeOptions = options === undefined ? {} : options;
    const withDesc = opts.withDesc === undefined ? true : opts.withDesc;
    const withSub = opts.withSub === undefined ? true : opts.withSub;
    const limit = normalizeLimit(opts.limit, 24);
    return this.session.subscribeTracked(topic, withDesc, withSub, limit);
  }

  publish(topic: string, content: Drafty | null, head?: ImHead | null): string {
    if (!this.acceptTopic(topic, 'publish')) return '';
    const headValue = head === undefined ? null : head;
    const id = this.session.nextRequestId();
    // 先按真实帧算体量（审计 P0-2）：超限不发，避免服务端直接断连/丢帧。
    const frame = buildPub(id, topic, headValue, content);
    if (frame.length > this.maxFrameBytes) {
      this.reject(`publish: 帧 ${frame.length} 字节超过上限 ${this.maxFrameBytes}`);
      return '';
    }
    this.session.sendPubWithId(id, topic, headValue, content);
    return id;
  }

  /** 标记已读。返回**是否已发出**（note 报文协议上没有 id，故不进 id 口径）。 */
  setRead(topic: string, seq: number): boolean {
    if (!this.acceptTopic(topic, 'setRead')) return false;
    if (!Number.isFinite(seq) || seq < 1) {
      this.reject(`setRead: 非法 seq=${seq}`);
      return false;
    }
    return this.session.markRead(topic, seq);
  }

  /** 正在输入（`kp`）。返回是否已发出（同上，note 没有 id）。 */
  setTyping(topic: string): boolean {
    if (!this.acceptTopic(topic, 'setTyping')) return false;
    return this.session.sendTyping(topic);
  }

  history(topic: string, beforeSeq: number, limit: number): string {
    if (!this.acceptTopic(topic, 'history')) return '';
    const before = Number.isFinite(beforeSeq) && beforeSeq > 0 ? Math.floor(beforeSeq) : 0;
    return this.session.loadHistoryWithId(topic, before, normalizeLimit(limit, 24));
  }

  deleteTopic(topic: string): string {
    if (!this.acceptTopic(topic, 'deleteTopic')) return '';
    return this.session.deleteTopic(topic);
  }

  deleteMessages(topic: string, ranges: DelRange[], hard: boolean): string {
    if (!this.acceptTopic(topic, 'deleteMessages')) return '';
    const valid: DelRange[] = [];
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i];
      const low = Number.isFinite(range.low) ? Math.floor(range.low) : 0;
      const hi = Number.isFinite(range.hi) ? Math.floor(range.hi) : 0;
      if (low < 1 || hi < low) continue;   // 丢弃非法区间（hi<low / 非正）
      valid.push({ low: low, hi: hi });
    }
    if (valid.length === 0) {
      this.reject('deleteMessages: 没有合法区间');
      return '';
    }
    return this.session.deleteMessages(topic, valid, hard);
  }

  /** 离开会话。返回是否已发出（`leave` 无 id 语义）。 */
  leave(topic: string): boolean {
    if (!this.acceptTopic(topic, 'leave')) return false;
    return this.session.leave(topic);
  }

  // ── 存储端口包装（宿主/上层直接可用，不必自己碰存储实现） ───────────────────
  async conversations(): Promise<TinodeTopic[]> { return this.store.loadTopics(); }
  async upsertTopic(topic: TinodeTopic): Promise<void> { return this.store.upsertTopic(topic); }
  async messagesOf(topic: string, limit: number = 0, beforeSeq: number = 0): Promise<TinodeMessage[]> {
    return this.store.loadMessages(topic, limit, beforeSeq);
  }
  async saveDraft(topic: string, text: string, nowMs: number): Promise<void> {
    if (text.trim().length === 0) {
      await this.store.clearDraft(topic);
      return;
    }
    const draft: TinodeDraft = { topic: topic, text: text, updatedAt: nowMs };
    await this.store.saveDraft(draft);
  }
  async draftOf(topic: string): Promise<TinodeDraft | null> { return this.store.loadDraft(topic); }
  async clearHistory(topic: string): Promise<void> { return this.store.clearMessages(topic); }
  async removeTopic(topic: string): Promise<void> { return this.store.deleteTopic(topic); }

  /** `data` 报文 → 线路消息 → **落库** → 回调宿主。seq 不合法或不是自己的 topic 时丢弃。 */
  /** 门面层的输入校验：空 topic 一律不发（审计 P0-1）。 */
  private acceptTopic(topic: string, action: string): boolean {
    if (topic.trim().length > 0) return true;
    this.reject(`${action}: 空 topic`);
    return false;
  }

  /** 统一的"拒绝"出口：日志 + 宿主的失败回调（不静默）。 */
  private reject(reason: string): void {
    tinodeLogFailure('tinode', new Error(reason));
    const failure = this.hooks.onFailure;
    if (failure !== undefined) failure(reason);
  }

  private handleData(data: ImData): void {
    // 先给宿主的原始报文钩子（自带管线的宿主在这里接管；门面不再落库）。
    const raw = this.hooks.onRawData;
    if (raw !== undefined) raw(data);
    if (!this.persistIncoming) return;
    // **审计 P1-7**：在入口快照 myUid —— 落库是异步的，期间可能切号/断线，
    // 那时再读会把自己发的消息算成对方的（isMine 翻转）。
    const myUidAtIngest = this.myUid();
    const message = tinodeMessageFromData(data, myUidAtIngest, Date.now());
    if (message === null) {
      tinodeLogDetail('tinode', 'dropped a data message without topic/seq', 'warn');
      return;
    }
    this.store.putMessage(message).then((inserted: boolean) => {
      tinodeLogDetail('tinode', `stored ${message.id} inserted=${inserted}`, 'info');
      const done = this.hooks.onMessage;
      if (done !== undefined) done(message);
    }).catch((error: Object) => {
      tinodeLogDetail('tinode', `store failed for ${message.id}`, 'error');
    });
  }
}
