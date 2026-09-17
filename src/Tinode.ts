/**
 * @otq/tinode-harmony —— Tinode 即时通讯协议的 HarmonyOS 客户端 SDK。
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
import { ImSession, defaultSessionConfig } from './TinodeSession.ts';
import type { ImSessionConfig, ImSessionState, ImTransport } from './TinodeSession.ts';
import type { ImCtrl, ImData, ImInfo, ImMeta, ImNote, ImPres, DelRange } from './TinodeWire.ts';
import { tinodeLogDetail, tinodeLogFailure } from './TinodeLog.ts';
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

  constructor(options: TinodeOptions) {
    this.hooks = options.hooks === undefined ? {} : options.hooks;
    this.store = options.storage === undefined ? new MemoryTinodeStorage() : options.storage;
    this.persistIncoming = options.persistIncoming === undefined ? true : options.persistIncoming;
    const cap = options.maxFrameBytes;
    this.maxFrameBytes = cap === undefined || !Number.isFinite(cap) || cap <= 0 ? DEFAULT_MAX_FRAME_BYTES : cap;
    this.session = new ImSession(options.transport, options.config, {
      onState: (state: ImSessionState) => {
        const done = this.hooks.onState;
        if (done !== undefined) done(state);
      },
      onData: (data: ImData) => { this.handleData(data); },
      onInfo: (info: ImInfo) => {
        const done = this.hooks.onInfo;
        if (done !== undefined) done(info);
      },
      onPres: (pres: ImPres) => {
        const done = this.hooks.onPres;
        if (done !== undefined) done(pres);
      },
      onMeta: (meta: ImMeta) => {
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
        const done = this.hooks.onFailure;
        if (done !== undefined) done(text);
      },
      onServerVersion: (version: string) => {
        tinodeLogDetail('tinode', `server ${version}`, 'info');
        const done = this.hooks.onServerVersion;
        if (done !== undefined) done(version);
      }
    });
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

  setRead(topic: string, seq: number): void {
    if (!this.acceptTopic(topic, 'setRead')) return;
    if (!Number.isFinite(seq) || seq < 1) {
      this.reject(`setRead: 非法 seq=${seq}`);
      return;
    }
    this.session.markRead(topic, seq);
  }

  setTyping(topic: string): void {
    if (!this.acceptTopic(topic, 'setTyping')) return;
    this.session.sendTyping(topic);
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

  leave(topic: string): void {
    if (!this.acceptTopic(topic, 'leave')) return;
    this.session.leave(topic);
  }

  /** 上报推送 token（`set{what:"deviceToken"}`）；平台侧取 token 由宿主负责。 */

  nextRequestId(): string { return this.session.nextRequestId(); }

  /** 交给调用方的会话对象（高级用法：需要更细的控制时）。 */
  rawSession(): ImSession { return this.session; }

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
