/**
 * tinode-harmony —— Tinode 即时通讯协议的 HarmonyOS 客户端 SDK。
 *
 * 许可：MIT（见同目录 LICENSE）。本实现为**独立 ArkTS 重写**；
 * 协议常量与报文形状参考 Tinode 官方文档与 Apache-2.0 的 `co/tinode/tinodesdk`（见 NOTICE）。
 */

/**
 * Tinode 会话状态机（纯逻辑）：`connect → hi → login → ready`，带超时、退避重连、代次守卫。
 *
 * 依据：SDK `Tinode.java` 的 `ConnectedWsListener.onConnect`（`:2594-2620`：连上先 `hello(bkg)`，
 * 收到 hi 的 ctrl 后若 `mAutologin` 再 `login`）、`loginSuccessful`（`:1425-1460`：从 ctrl.params.user
 * 取 uid，与已知 uid 不一致就报 `UID mismatch`）、`ExpBackoff`（`:8-31`）与
 * `android/.../TinodeImClient.kt:171-226`（登录顺序）、`:418-441`（`ensureConnected` 重连语义）。
 *
 * **纯逻辑**：不直接碰 WebSocket，也不自己起定时器——时间由平台层通过 `tick(nowMs)` 喂进来
 * （与 `NotifyDedupe.shouldPublish(key, nowMs)`、`PatrolCaptureViewModel.tick` 同一套路），
 * 所以「握手超时／退避重连／代次丢弃」都能用假 transport 在主机上验证。
 *
 * 与 Android 的差异（有意）：
 * - **不做 loopback 改写**（`TinodeImClient.kt:872-887`）；拿到回环地址如实失败（docs/22 §6.7）。
 * - **不发定时心跳**：Android 只有 `networkProbe()`（`Tinode.java:606-608`，发字面量 `"1"`），
 *   没有周期心跳；本端默认 `heartbeatMs = 0`（关），需要时再打开。
 * - 服务端新签发的 token（`ctrl.params.token`）本端**不落盘**（Android 也不落库，见 docs/22 §2.3）。
 */

import {
  IM_PROBE_PAYLOAD,
  backoffDelayMs, buildDelMessages, buildDelTopic, buildGetHistory, buildHi, buildLeave, buildLogin,
  accFailureText, buildAccCreate, buildGetHistorySince, buildNoteKeyPress, buildNoteRead, buildPub, buildSub,
  ctrlFailureText, ctrlIsFatal, ctrlOk,
  parseServerMessage, parseWsEndpoint
} from './TinodeWire.ts';
import type {
  DelRange, ImCtrl, ImData, ImInfo, ImMeta, ImNote, ImPres, ImServerMessage, ImWsEndpoint
} from './TinodeWire.ts';
import { DEFAULT_MAX_FRAME_BYTES, DEFAULT_MAX_INBOUND_BYTES } from './TinodeWire.ts';
import { TinodeTopics } from './TinodeTopics.ts';
import type { TinodeTopicState } from './TinodeTopics.ts';
import { redactTopic, tinodeLogDetail } from './TinodeLog.ts';
import type { Drafty } from './Drafty.ts';
import type { ImHead } from './TinodeHead.ts';

/** 会话状态（渲染层据此显示「连接中／已连接／失败」，不允许谎报在线）。 */
export type ImSessionState = 'idle' | 'connecting' | 'handshake' | 'login' | 'ready' | 'closed' | 'failed';

/** 平台层要实现的传输（`im/TinodeSocket.ets` 用 `@kit.NetworkKit` 的 webSocket 实现）。 */
export interface ImTransportHandlers {
  /** 回调都带上平台侧的当前时间（ms），会话不用自己读时钟（可主机测试）。 */
  onOpen: (nowMs: number) => void;
  onMessage: (text: string, nowMs: number) => void;
  onError: (message: string, nowMs: number) => void;
  onClose: (nowMs: number) => void;
}

export interface ImTransport {
  /** 开始连接；成功后回调 `handlers.onOpen`。同一实例只连接一次。 */
  open(handlers: ImTransportHandlers): void;
  /** 发送一条文本报文；未连接时由平台层丢弃并回调 onError。 */
  send(text: string): void;
  /** 主动关闭（不再重连）。 */
  close(): void;
}

/** 会话配置（全部来自后端 `im/token` 响应或应用信息）。 */
/** 服务端签发的账号凭据（P3-min）：`uid` 为 Tinode 用户 id，`token` 用于下次登录（本端不落盘）。 */
export interface TinodeAuth {
  uid: string;
  token: string;
}

/** 判定"连接稳定"的窗口（毫秒）：撑过它再断线才算新问题，退避计数清零（审计 P1-1）。 */
export const STABLE_CONNECTION_MS = 5000;

export interface ImSessionConfig {
  /** 后端下发的 wsUrl（原样传入，由 `parseWsEndpoint` 归一化）。 */
  wsUrl: string;
  /** 后端下发的 Tinode token（`{login:{scheme:"token",secret}}`）。 */
  token: string;
  /**
   * 登录 scheme：`token`（默认，token 作为 secret）、`basic`（token 里放 `user:password`）、
   * `anonymous`（公开服务自测；此时 `token` 可以为空）、
   * **`none`（P3-min：连上握手后**不发 login**，停在"可发请求但未认证"的就绪态 ——
   * 注册流程用它先发 `acc{user:"new", login:true}` 注册并登录）**。
   */
  loginScheme?: string;
  userAgent: string;
  deviceId: string;
  lang: string;
  background: boolean;
  /** 建连 + hi 应答的超时（Android SDK connect timeout 3 s）。 */
  connectTimeoutMs: number;
  /** login 应答的超时。 */
  loginTimeoutMs: number;
  /** 退避重连的延迟上限（毫秒；≤0 表示不设上限）。 */
  maxBackoffMs: number;
  /** 帧体量上限（字节）：出站 publish 守卫 + 入站解析守卫（不传用 wire 的默认值）。 */
  maxFrameBytes?: number;
  /**
   * 连上并登录后，是否由 SDK **自动重新订阅**登记过的主题（默认 true）。
   * 宿主自己管订阅时置 false（我们自己的 App 就是自己管）。
   */
  autoResubscribe?: boolean;
  /** 重连后是否从各主题的 `lastSeq+1` 补历史（默认 true；宿主自己做增量同步时置 false）。 */
  syncHistoryOnReconnect?: boolean;
  /** 心跳间隔；0 = 关（默认，见文件头注释）。 */
  heartbeatMs: number;
  /** 抖动来源；测试注入确定值。 */
  random: () => number;
}

/** 默认配置（除 wsUrl/token 外都给安全默认值）。 */
export function defaultSessionConfig(wsUrl: string, token: string, userAgent: string, deviceId: string): ImSessionConfig {
  return {
    wsUrl: wsUrl,
    token: token,
    userAgent: userAgent,
    deviceId: deviceId,
    lang: 'zh',
    background: false,
    connectTimeoutMs: 3000,
    loginTimeoutMs: 10000,
    // 审计 P1-2：默认 60 s 封顶（无上限时第 20 次退避要等 25 分钟）。
    maxBackoffMs: 60000,
    heartbeatMs: 0,
    random: () => Math.random()
  };
}

/** 会话对外回调。 */
export interface ImSessionHooks {
  onState: (state: ImSessionState) => void;
  onData: (data: ImData) => void;
  onInfo: (info: ImInfo) => void;
  onPres: (pres: ImPres) => void;
  /** 服务端 note（正在输入 `kp` / 已读 `read` / 送达 `recv`）。 */
  onNote: (note: ImNote) => void;
  /** `meta`：订阅清单/分页元数据（`me` 的全量订阅靠它拿会话列表）。 */
  onMeta: (meta: ImMeta) => void;
  /**
   * ready 之后的 `ctrl` 应答（按报文 id 对应到具体请求）。
   * `pub` 的 `params.seq` 就靠它拿到（Android `TinodeImClient.extractSeq` 同口径）。
   */
  onCtrl: (ctrl: ImCtrl) => void;
  /** 用户可读的中文失败原因（已过 `ctrlFailureText`）。 */
  onFailure: (text: string) => void;
  /** hi 应答里的服务端版本（Android 存进 mServerVersion/Build）。 */
  onServerVersion: (ver: string, build: string) => void;
  /** 主题状态变化（订阅结果 / 位点推进）。**可选**：不关心就不实现。 */
  onTopicState?: (state: TinodeTopicState) => void;
  /** 服务端签发/更新凭据（登录或注册成功；P3-min）。**可选**。 */
  onAuth?: (auth: TinodeAuth) => void;
}

/**
 * 一次 Tinode 会话。生命周期：`start()` → 平台层每 200 ms 调 `tick(now)` → `stop()`。
 * 重连由本类自己驱动（`tick` 到点后重新 `transport.open`），不依赖平台层。
 */
export class ImSession {
  private transport: ImTransport;
  private config: ImSessionConfig;
  private hooks: ImSessionHooks;
  private currentState: ImSessionState = 'idle';
  private currentUid: string = '';
  private endpoint: ImWsEndpoint | null = null;
  private generationValue: number = 0;
  private nextMessageId: number = 1;
  private attempt: number = 0;
  /**
   * 本轮连接是否已经处理过失败（**审计 P1-2**）：平台层一次断线会同时回调 `onError` 与 `onClose`，
   * 不去重就会 `attempt` 翻倍、退避被推满。
   */
  private failureHandled: boolean = false;
  /** 最近一次进入 `ready` 的时刻（**审计 P1-1**：抖动式断线要保留退避，长期稳定后再清零）。 */
  private readyAtMs: number = 0;
  /** 主题登记（P1：订阅意图 + 位点 + 缺口）。 */
  private topics: TinodeTopics = new TinodeTopics();
  /** 在途的订阅请求：报文 id → topic（收到 ctrl 后据此标记订阅成功/失败）。 */
  private subRequests: Map<string, string> = new Map();
  /** 在途的注册请求（P3-min）：报文 id 集合（收到 ctrl 后完成登录）。 */
  private accRequests: Set<string> = new Set();
  private retryAtMs: number = 0;
  private deadlineMs: number = 0;
  private lastProbeMs: number = 0;
  private stopped: boolean = true;

  constructor(transport: ImTransport, config: ImSessionConfig, hooks: ImSessionHooks) {
    this.transport = transport;
    this.config = config;
    this.hooks = hooks;
  }

  state(): ImSessionState {
    return this.currentState;
  }

  /** 已登录的 Tinode uid；未登录为空串（不是「在线」的同义词）。 */
  myUid(): string {
    return this.currentUid;
  }

  /** 当前代次：切换账号/退出时递增，旧代次的回调一律丢弃。 */
  generation(): number {
    return this.generationValue;
  }

  /** 是否真的「已连且已认证」：只有收到登录成功应答后才是 true（不谎报在线）。 */
  ready(): boolean {
    return this.currentState === 'ready';
  }

  /** 错误信息：不暴露 token/地址（对齐仓库日志脱敏口径）。 */
  private fail(text: string): void {
    this.hooks.onFailure(text);
  }

  private setState(state: ImSessionState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.hooks.onState(state);
  }

  /** 开始（或切号后重新开始）。会先停掉旧代次。 */
  start(nowMs: number): void {
    this.generationValue += 1;
    this.stopped = false;
    this.attempt = 0;
    this.retryAtMs = 0;
    this.currentUid = '';
    const parsed = parseWsEndpoint(this.config.wsUrl);
    if (parsed === null) {
      this.endpoint = null;
      this.setState('failed');
      this.fail('消息服务地址无效，请重新登录后再试');
      return;
    }
    if (parsed.loopback) {
      // 不照抄 Android 的 loopback 改写：地址是回环就说明后端配置有问题，如实失败。
      this.endpoint = null;
      this.setState('failed');
      this.fail('消息服务地址指向本机（回环地址），请检查后台配置');
      return;
    }
    const scheme = this.config.loginScheme === undefined ? 'token' : this.config.loginScheme;
    if (scheme !== 'anonymous' && scheme !== 'none' && this.config.token.length === 0) {
      this.endpoint = null;
      this.setState('failed');
      this.fail('缺少消息服务凭据，请重新登录后再试');
      return;
    }
    this.endpoint = parsed;
    this.connect(nowMs);
  }

  /** 停止会话（退出登录、切号、页面销毁时调用），不再自动重连。 */
  stop(): void {
    this.stopped = true;
    this.generationValue += 1;
    this.endpoint = null;
    this.currentUid = '';
    try {
      this.transport.close();
    } catch (_) {
      // 关闭失败不影响状态收敛
    }
    this.setState('closed');
  }

  private connect(nowMs: number): void {
    const endpoint = this.endpoint;
    if (endpoint === null || this.stopped) return;
    this.setState('connecting');
    this.deadlineMs = nowMs + this.config.connectTimeoutMs;
    const generation = this.generationValue;
    this.transport.open({
      onOpen: (nowMs: number) => {
        if (generation !== this.generationValue) return;
        this.onOpen(nowMs);
      },
      onMessage: (text: string, nowMs: number) => {
        if (generation !== this.generationValue) return;
        this.onMessage(text, nowMs);
      },
      onError: (message: string, nowMs: number) => {
        if (generation !== this.generationValue) return;
        this.onTransportFailure(nowMs, message);
      },
      onClose: (nowMs: number) => {
        if (generation !== this.generationValue) return;
        this.onTransportFailure(nowMs, '');
      }
    });
  }

  /** 连上：先发 `hi`（SDK 顺序），等 ctrl 应答。 */
  private onOpen(nowMs: number): void {
    this.failureHandled = false;
    this.setState('handshake');
    this.deadlineMs = nowMs + this.config.connectTimeoutMs;
    this.transport.send(buildHi(
      this.takeId(), this.config.userAgent, this.config.deviceId, this.config.lang, this.config.background));
  }

  private takeId(): string {
    const id = this.nextMessageId;
    this.nextMessageId += 1;
    return `${id}`;
  }

  /**
   * 取一个**全会话唯一**的报文 id（与内部请求共用同一个单调计数器）。
   *
   * 为什么必须唯一：真机实测 Tinode 对重复的 `pub` id 回 **409 Conflict**
   * （同一条本地 echo 的负 seq 跨进程复用会撞上）。Android SDK 的 `getNextId()`
   * 也是所有请求共用一个计数器（`Tinode.java`）；本地负 seq 只是**行主键的一部分**，
   * 不能当报文 id 用。
   */
  nextRequestId(): string {
    return this.takeId();
  }

  /**
   * 平台层定时喂时间：处理握手/登录超时、心跳（默认关）与退避重连。
   * 返回状态没有变化也安全，重复调用无副作用。
   */
  tick(nowMs: number): void {
    if (this.stopped) return;
    if (this.currentState === 'connecting' || this.currentState === 'handshake'
      || this.currentState === 'login') {
      if (nowMs >= this.deadlineMs) {
        this.onTransportFailure(nowMs, '');
        return;
      }
    }
    if (this.currentState === 'ready' && this.config.heartbeatMs > 0) {
      if (nowMs - this.lastProbeMs >= this.config.heartbeatMs) {
        this.lastProbeMs = nowMs;
        this.transport.send(IM_PROBE_PAYLOAD);
      }
    }
    if (this.currentState === 'idle' && this.retryAtMs > 0 && nowMs >= this.retryAtMs) {
      this.retryAtMs = 0;
      this.connect(nowMs);
    }
  }

  /** 传输或超时失败：退避后自动重连（鉴权类错误不再重试）。 */
  private onTransportFailure(nowMs: number, message: string): void {
    if (this.stopped) return;
    if (this.failureHandled) return;
    this.failureHandled = true;
    // 抖动保护（审计 P1-1）：连上后没撑住稳定窗口就再断 → 保留退避计数，避免重连风暴；
    // 稳定撑过窗口后清零，避免"一次成功后永久按旧 attempt 退避"。
    if (this.readyAtMs > 0 && nowMs - this.readyAtMs >= STABLE_CONNECTION_MS) this.attempt = 0;
    // P1：wire 上的订阅随连接一起没了 → 清标记（保留订阅意图与位点，重连后自动重订 + 补历史）。
    this.topics.resetSubscriptions();
    this.subRequests.clear();
    try {
      this.transport.close();
    } catch (_) {
      // 忽略
    }
    const delay = backoffDelayMs(this.attempt, this.config.random(), this.config.maxBackoffMs);
    this.attempt += 1;
    this.retryAtMs = nowMs + delay;
    this.currentUid = '';
    this.setState('idle');
    if (message.length > 0) this.fail(message);
  }

  /** 处理一条下行报文。 */
  onMessage(text: string, nowMs: number): void {
    if (this.stopped) return;
    const message: ImServerMessage | null = parseServerMessage(text, this.config.maxFrameBytes === undefined
      ? DEFAULT_MAX_INBOUND_BYTES : this.config.maxFrameBytes);
    if (message === null) return;
    const ctrl = message.ctrl;
    if (ctrl !== undefined) {
      this.onCtrl(ctrl, nowMs);
      return;
    }
    const data = message.data;
    if (data !== undefined) {
      if (this.topics.observeData(data.topic, data.seq, nowMs)) this.emitTopicState(data.topic);
      this.hooks.onData(data);
      return;
    }
    // 注意：`info` 与 `pres/meta/note` **可以同帧**（Tinode 服务端常见 info+meta），
    // 所以这里不能 return，否则同帧后续键会被静默吞掉（审计 P0-4）。
    const info = message.info;
    if (info !== undefined) {
      this.hooks.onInfo(info);
    }
    const pres = message.pres;
    if (pres !== undefined) {
      this.hooks.onPres(pres);
    }
    const note = message.note;
    if (note !== undefined) {
      const what = note.what === undefined ? '' : note.what;
      if (this.topics.observeNote(what, note.topic, note.seq, nowMs) && note.topic !== undefined) {
        this.emitTopicState(note.topic);
      }
      this.hooks.onNote(note);
    }
    const meta = message.meta;
    if (meta !== undefined) this.hooks.onMeta(meta);
    // 到不了这里：五类键在 parseServerMessage 里已经过滤过。
  }

  private onCtrl(ctrl: ImCtrl, nowMs: number): void {
    if (this.currentState === 'handshake') {
      if (!ctrlOk(ctrl.code)) {
        this.failHandshake(ctrl, nowMs);
        return;
      }
      const params = ctrl.params;
      if (params !== undefined) {
        this.hooks.onServerVersion(
          params.ver === undefined ? '' : params.ver,
          params.build === undefined ? '' : params.build);
      }
      const scheme = this.config.loginScheme === undefined ? 'token' : this.config.loginScheme;
      if (scheme === 'none') {
        // P3-min：不发 login，直接进入就绪态（未认证），宿主用 `createAccount` 发 `acc` 注册并登录。
        this.currentUid = '';
        this.retryAtMs = 0;
        this.lastProbeMs = nowMs;
        this.readyAtMs = nowMs;
        this.failureHandled = false;
        this.setState('ready');
        this.resubscribeAll();
        return;
      }
      // hi 应答成功 → 发 login（SDK 在 onConnect 里紧接着 login）。
      this.setState('login');
      this.deadlineMs = nowMs + this.config.loginTimeoutMs;
      this.transport.send(buildLogin(this.takeId(), this.config.token, scheme));
      return;
    }
    if (this.currentState === 'login') {
      if (!ctrlOk(ctrl.code)) {
        this.failHandshake(ctrl, nowMs);
        return;
      }
      const params = ctrl.params;
      const uid = params === undefined || params.user === undefined ? '' : params.user;
      if (this.currentUid.length > 0 && uid !== this.currentUid) {
        // SDK 的 UID mismatch：同一会话里换了账号，必须清掉重来（Tinode.java:1432-1439）。
        this.currentUid = '';
        this.setState('failed');
        this.fail('消息服务返回的账号与当前登录账号不一致，请重新登录');
        this.stop();
        return;
      }
      this.currentUid = uid;
      this.retryAtMs = 0;
      this.lastProbeMs = nowMs;
      this.readyAtMs = nowMs;
      this.failureHandled = false;
      this.setState('ready');
      // P3-min：把服务端签发的 token 交给宿主（本端不落盘）。
      const issued = params === undefined || params.token === undefined ? '' : params.token;
      this.emitAuth(uid, issued);
      // P1：连上并登录后自动把登记过的主题重新订回来（可关），需要时从 lastSeq 补历史。
      this.resubscribeAll();
      return;
    }
    // 注册应答（P3-min）：`acc` 成功即完成登录（服务端回 user + token）。
    const accId = ctrl.id === undefined ? '' : ctrl.id;
    if (this.accRequests.has(accId)) {
      this.accRequests.delete(accId);
      if (!ctrlOk(ctrl.code)) {
        this.fail(accFailureText(ctrl.code, ctrl.text === undefined ? '' : ctrl.text));
        return;
      }
      const accParams = ctrl.params;
      const accUid = accParams === undefined || accParams.user === undefined ? '' : accParams.user;
      if (accUid.length > 0) this.currentUid = accUid;
      const accToken = accParams === undefined || accParams.token === undefined ? '' : accParams.token;
      this.emitAuth(accUid, accToken);
      return;
    }
    // 订阅应答：按报文 id 归因，标记该主题订阅成功/失败（P1）。
    const subId = ctrl.id === undefined ? '' : ctrl.id;
    const subTopic = this.subRequests.get(subId);
    if (subTopic !== undefined) {
      this.subRequests.delete(subId);
      this.topics.markSubscribed(subTopic, ctrlOk(ctrl.code), Date.now());
      this.emitTopicState(subTopic);
    }
    // ready 之后的 ctrl：属于「某个具体请求」的应答，交给上层按 id 对应（如 pub 的 seq）。
    tinodeLogDetail('im/ctrl', `id=${ctrl.id === undefined ? '' : ctrl.id} code=${ctrl.code} `
      + `seq=${ctrl.params === undefined || ctrl.params.seq === undefined ? '' : ctrl.params.seq}`, 'info');
    this.hooks.onCtrl(ctrl);
    if (!ctrlOk(ctrl.code) && ctrlIsFatal(ctrl.code)) {
      this.fail(ctrlFailureText(ctrl.code, ctrl.text === undefined ? '' : ctrl.text));
    }
  }

  /**
   * P1：连上后把登记过的主题重新订阅回来，并（可选）从 `lastSeq+1` 补历史。
   * 首次连接时登记表通常还是空的，所以不会发无用报文；只有"订阅过又断线"才真正用到。
   */
  private resubscribeAll(): void {
    if (this.config.autoResubscribe !== false) {
      const pending = this.topics.needingSubscribe();
      for (let i = 0; i < pending.length; i++) {
        const state = pending[i];
        const id = this.takeId();
        this.subRequests.set(id, state.topic);
        this.transport.send(buildSub(id, state.topic, state.prefs.withDesc, state.prefs.withSub, state.prefs.limit));
        tinodeLogDetail('im/sub', `resubscribe topic=${redactTopic(state.topic)} id=${id}`, 'info');
      }
    }
    if (this.config.syncHistoryOnReconnect === false) return;
    const gaps = this.topics.gaps();
    for (let i = 0; i < gaps.length; i++) {
      const gap = gaps[i];
      const state = this.topics.stateOf(gap.topic);
      const limit = state === null ? 24 : state.prefs.limit;
      this.transport.send(buildGetHistorySince(this.takeId(), gap.topic, gap.since, limit));
      tinodeLogDetail('im/history', `sync topic=${redactTopic(gap.topic)} since=${gap.since}`, 'info');
    }
  }

  /** 主题状态变化时回调宿主（可选 hook）。 */
  private emitTopicState(topic: string): void {
    const emit = this.hooks.onTopicState;
    if (emit === undefined) return;
    const state = this.topics.stateOf(topic);
    if (state !== null) emit(state);
  }

  /** 登记过的主题快照（P1：宿主可据此渲染会话列表/未读）。 */
  knownTopics(): TinodeTopicState[] {
    return this.topics.known();
  }

  /** 单个主题的状态快照；没登记过返回 null。 */
  topicState(topic: string): TinodeTopicState | null {
    return this.topics.stateOf(topic);
  }

  private failHandshake(ctrl: ImCtrl, nowMs: number): void {
    const text = ctrlFailureText(ctrl.code, ctrl.text === undefined ? '' : ctrl.text);
    if (ctrlIsFatal(ctrl.code)) {
      // 鉴权/请求类错误重连也没用：停掉并如实报错。
      this.stopped = true;
      this.endpoint = null;
      this.setState('failed');
      this.fail(text);
      return;
    }
    // 服务端类错误按退避重试（onTransportFailure 里负责发这条失败文案）。
    this.onTransportFailure(nowMs, text);
  }

  // ── 发送（01c/01d 使用；本切片只用主机测试验证 id 递增与报文形状） ──────────

  /** 订阅 topic（`withSub=false` 时是增量订阅；切号必须全量，见 docs/22 §2.4）。 */
  subscribe(topic: string, withDesc: boolean, withSub: boolean, limit: number): void {
    this.subscribeTracked(topic, withDesc, withSub, limit);
  }

  /**
   * 订阅并返回报文 id：调用方要按这个 id 认领 `ctrl`，确认**订阅成功后才能发布**。
   * 真机实测：订阅还在途中就 `pub`，Tinode 回 **409 Conflict**（H4-01d 联调）。
   */
  subscribeTracked(topic: string, withDesc: boolean, withSub: boolean, limit: number): string {
    if (this.currentState !== 'ready') return '';
    const id = this.takeId();
    this.subRequests.set(id, topic);
    this.topics.remember(topic, withDesc, withSub, limit, Date.now());
    this.transport.send(buildSub(id, topic, withDesc, withSub, limit));
    return id;
  }

  /**
   * 删除会话（软删：只对当前用户隐藏，可被新消息或重新订阅恢复）。
   * 返回报文 id，调用方按它认领 ctrl 判断服务端是否接受。
   */
  deleteTopic(topic: string): string {
    if (this.currentState !== 'ready') return '';
    const id = this.takeId();
    this.transport.send(buildDelTopic(id, topic, false));
    return id;
  }

  /** 删除消息区间（`hard` 由调用方决定；服务端可能拒绝）。 */
  deleteMessages(topic: string, ranges: DelRange[], hard: boolean): string {
    if (this.currentState !== 'ready') return '';
    const id = this.takeId();
    this.transport.send(buildDelMessages(id, topic, ranges, hard));
    return id;
  }

  /** 拉历史（`before` 不含、`since` 含）。 */
  loadHistory(topic: string, before: number, limit: number): void {
    this.loadHistoryWithId(topic, before, limit);
  }

  /** 拉历史并返回报文 id：调用方按这个 id 认领 ctrl（判断这一页有没有内容）。 */
  loadHistoryWithId(topic: string, before: number, limit: number): string {
    if (this.currentState !== 'ready') return '';
    const id = this.takeId();
    this.transport.send(buildGetHistory(id, topic, before, limit));
    return id;
  }

  /**
   * note 类报文（`read`/`kp`）的统一出口。**协议里 note 没有 id**，所以这类方法统一返回
   * `boolean`（是否已发出），而不是像 `publish` 那样返回报文 id —— 这是审计 P1-8 的统一口径。
   */
  /**
   * 注册账号并直接登录（P3-min）：`acc{user:"new", login:true, scheme, secret, desc.public.fn}`。
   * 需要连接处于就绪态（`loginScheme:'none'` 时连上即可；已认证的连接也能发，用于同账号加凭据）。
   * 返回报文 id；结果通过 `hooks.onAuth(uid, token)` / `hooks.onFailure(text)` 回来。
   */
  createAccount(scheme: string, secret: string, fn: string): string {
    if (this.currentState !== 'ready') return '';
    const id = this.takeId();
    this.accRequests.add(id);
    this.transport.send(buildAccCreate(id, scheme, secret, fn, true));
    return id;
  }

  /** 切换登录 scheme（P3-min：`'basic'` 配合 `setToken('user:password')` 做密码登录）。 */
  setLoginScheme(scheme: string): void {
    this.config.loginScheme = scheme;
  }

  /** 设置登录 token（`basic` 时是 `用户名:密码`）。 */
  setToken(token: string): void {
    this.config.token = token;
  }

  /** 服务端签发凭据时回调宿主（P3-min：注册/登录成功后拿 token）。 */
  private emitAuth(uid: string, token: string): void {
    const emit = this.hooks.onAuth;
    if (emit === undefined || (uid.length === 0 && token.length === 0)) return;
    emit({ uid: uid, token: token });
  }

  /** 开关：连上后自动重订阅（默认开）。 */
  setAutoResubscribe(enabled: boolean): void {
    this.config.autoResubscribe = enabled;
  }

  /** 开关：重连后从 lastSeq 补历史（默认开）。 */
  setSyncHistoryOnReconnect(enabled: boolean): void {
    this.config.syncHistoryOnReconnect = enabled;
  }

  private sendNote(frame: string): boolean {
    if (this.currentState !== 'ready') return false;
    this.transport.send(frame);
    return true;
  }

  /** 发消息（head 承载自定义语义，见契约 `customHeadMime`）。走带 id 的出口，体量守卫只有一处。 */
  sendPub(topic: string, head: ImHead | null, content: Drafty | null): void {
    if (this.currentState !== 'ready') return;
    this.sendPubWithId(this.takeId(), topic, head, content);
  }

  /**
   * 用指定报文 id 发消息：调用方要按这个 id 认领 `ctrl` 应答（拿 `params.seq`）。
   * id 必须是调用方自己分配的数字串（不能与 `takeId()` 生成的重号）。
   */
  sendPubWithId(id: string, topic: string, head: ImHead | null, content: Drafty | null): void {
    if (this.currentState !== 'ready') return;
    const frame = buildPub(id, topic, head, content);
    // **唯一出口**在这里做体量守卫：`sendPub` / 门面 `publish` 都走它（审计 P0-3，
    // 此前只有门面 publish 检查，公开的 sendPub 能绕过）。
    const limit = this.config.maxFrameBytes === undefined ? DEFAULT_MAX_FRAME_BYTES : this.config.maxFrameBytes;
    if (Number.isFinite(limit) && limit > 0 && frame.length > limit) {
      this.hooks.onFailure(`publish: 帧 ${frame.length} 字节超过上限 ${limit}`);
      return;
    }
    tinodeLogDetail('im/pub', `id=${id} topic=${redactTopic(topic)} state=${this.currentState}`, 'info');
    this.transport.send(frame);
  }

  /** 标记已读。 */

  markRead(topic: string, seq: number): boolean {
    const sent = this.sendNote(buildNoteRead(topic, seq));
    if (sent && this.topics.markRead(topic, seq, Date.now())) this.emitTopicState(topic);
    return sent;
  }

  /** 正在输入（节流交给调用方，Android 是 2 s，见 docs/22 §1.10）。 */
  sendTyping(topic: string): boolean {
    return this.sendNote(buildNoteKeyPress(topic));
  }

  /** 离开 topic（切号/退出前清订阅）。 */
  leave(topic: string): boolean {
    if (this.currentState !== 'ready') return false;
    this.transport.send(buildLeave(this.takeId(), topic));
    this.topics.forget(topic);
    return true;
  }
}
