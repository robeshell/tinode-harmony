/**
 * Tinode 线路层（WebSocket 报文）纯逻辑：信封构造、服务端报文解析、ctrl 码分类、wsUrl 归一化。
 *
 * 许可：MIT（见同目录 LICENSE）。本实现为独立 ArkTS 重写；协议常量与报文形状参考
 * Tinode 官方文档与 Apache-2.0 的 `co/tinode/tinodesdk`（见 NOTICE）。
 *
 * 依据：vendored SDK `co/tinode/tinodesdk/model/{ClientMessage,ServerMessage,MsgClientHi,MsgClientLogin,
 * MsgClientSub,MsgClientPub,MsgClientGet,MsgClientNote,MsgServerCtrl,MsgServerData,MsgServerInfo}.java`、
 * `co/tinode/tinodesdk/Tinode.java`（握手与登录流程、VERSION/PROTOVERSION）与
 * `android/.../data/repository/TinodeImClient.kt`（wsUrl 解析、报文用法）。协议事实见 `docs/22` §2.2–2.5。
 *
 * 纯逻辑：不发网络、不依赖平台；平台层（`im/TinodeSocket.ets`）只负责把字符串发出去。
 *
 * 与 Android 的**有意差异**：
 * - Android 的 `rewriteLoopbackHost()`（`TinodeImClient.kt:872-887`）是「后端 dev 环境配错 + Android
 *   本机回环」的兜底，本端**不移植**：拿到 loopback 地址就如实失败，不静默改写目标主机（docs/22 §6.7）。
 * - apikey 不走报文，放 WebSocket 升级头 `X-Tinode-APIKey`（`Connection.java:72-76`），由平台层设置。
  *
*/

import type { Drafty } from './Drafty.ts';
import type { ImHead } from './TinodeHead.ts';

/** 客户端协议版本（`Tinode.java:85` VERSION，进 `hi.ver`）。 */
export const IM_PROTO_VERSION = '0.22';
/** 协议序号（`Tinode.java:84` PROTOVERSION，进内部 hi 字段；线上只发 ver）。 */
export const IM_PROTO_VERSION_INT = 0;
/** WebSocket 路径（SDK `Connection.java` 固定 `/v0/channels`）。 */
export const IM_WS_PATH = '/v0/channels';
/** apikey 头（`Connection.java:72-76`）。 */
export const IM_HEADER_API_KEY = 'X-Tinode-APIKey';
/** token 走报文，HTTP 侧才用这个头（`Tinode.java:2316-2323`）。 */
export const IM_HEADER_AUTH = 'X-Tinode-Auth';
/** 无操作探针报文：SDK `networkProbe()` 发字面量 `"1"`（`Tinode.java:606-608`）。 */
export const IM_PROBE_PAYLOAD = '1';
/** 默认分页条数（`TinodeImClient.kt:385` 的 `withLaterData(24)`）。 */
export const IM_DEFAULT_PAGE_LIMIT = 24;
/** 会话订阅的默认消息条数（`ensurePeerTopic` 之后首次 `get`）。 */
export const IM_FIRST_PAGE_LIMIT = 24;

/** 服务端 ctrl 码（`model/ServerMessage.java:13-45`，HTTP 语义）。 */
export const IM_CODE_OK = 200;
export const IM_CODE_ACCEPTED = 202;
export const IM_CODE_BAD_REQUEST = 400;
export const IM_CODE_UNAUTHORIZED = 401;
export const IM_CODE_FORBIDDEN = 403;
export const IM_CODE_NOT_FOUND = 404;
export const IM_CODE_CONFLICT = 409;
export const IM_CODE_INTERNAL = 500;
export const IM_CODE_UNAVAILABLE = 503;

/** wsUrl 归一化结果：WebSocket 连接串 + 拆分出的主机信息。 */
export interface ImWsEndpoint {
  /** 交给平台层的完整连接串：`ws(s)://host[:port]/v0/channels`。 */
  channelUrl: string;
  scheme: string;
  host: string;
  port: number;
  tls: boolean;
  /** 原串是否回环地址（localhost/127.0.0.1/0.0.0.0）；回环时本端**如实失败**，不改写。 */
  loopback: boolean;
}

/**
 * 解析后端下发的 `wsUrl`（`TinodeImClient.kt:890-899` 同口径）并补上 `/v0/channels`。
 *
 * 口径：`wss`/`https` → tls=true；端口缺省时不带端口；**路径一律用 `/v0/channels`**
 * （Android 只把 host:port 交给 SDK，路径由 SDK 固定）。无法解析时返回 null，调用方如实报错。
 */
export function parseWsEndpoint(wsUrl: string): ImWsEndpoint | null {
  const trimmed = wsUrl.trim();
  if (trimmed.length === 0) return null;
  const match = /^(wss?|https?):\/\/([^/?#:]+)(?::(\d+))?/i.exec(trimmed);
  if (match === null) return null;
  const scheme = match[1].toLowerCase();
  const host = match[2];
  const port = match[3] === undefined ? 0 : Number.parseInt(match[3], 10);
  const tls = scheme === 'wss' || scheme === 'https';
  const secure = tls ? 'wss' : 'ws';
  const authority = port > 0 ? `${host}:${port}` : host;
  const lower = host.toLowerCase();
  return {
    channelUrl: `${secure}://${authority}${IM_WS_PATH}`,
    scheme: scheme,
    host: host,
    port: port,
    tls: tls,
    loopback: lower === 'localhost' || lower === '127.0.0.1' || lower === '0.0.0.0'
  };
}

// ── 上行信封 ────────────────────────────────────────────────────────────────

/** `hi`（`MsgClientHi{id,ver,ua,dev,lang,bkg}`）：连上后第一条。 */
export function buildHi(id: string, userAgent: string, deviceId: string, lang: string, background: boolean): string {
  return JSON.stringify({
    hi: { id: id, ver: IM_PROTO_VERSION, ua: userAgent, dev: deviceId, lang: lang, bkg: background }
  });
}

/** `login`（token scheme）：`{login:{id,scheme:"token",secret}}`（`Tinode.java:1388-1400`）。 */
export function buildLogin(id: string, token: string, scheme: string = 'token'): string {
  // `scheme` 默认 `token`（自有后端签发 token 的常规用法）；也支持 `basic`（user:password）
  // 与 `anonymous`（公开 Tinode 服务自测用，见 README「把 SDK 指向 Tinode 服务」）。
  if (scheme === 'anonymous') return JSON.stringify({ login: { id: id, scheme: 'anonymous' } });
  return JSON.stringify({ login: { id: id, scheme: scheme, secret: token } });
}

/**
 * `sub`：订阅 topic。
 * `withSub` 为 null 时用 `what: "desc sub"` 做**全量**订阅（切号场景必须全量，见 `TinodeImClient.kt:214-221`）。
 */
export function buildSub(id: string, topic: string, withDesc: boolean, withSub: boolean, limit: number): string {
  const what: string[] = [];
  if (withDesc) what.push('desc');
  if (withSub) what.push('sub');
  const get: ImSubGet = { what: what.join(' ') };
  if (limit > 0) get.data = { limit: limit };
  return JSON.stringify({ sub: { id: id, topic: topic, get: get } });
}

/** `sub.get` 的形状（`MsgClientSub{id,topic,set,get}` + `MetaGetData{since,before,limit}`）。 */
export interface ImSubGet {
  what: string;
  data?: ImPageRequest;
}

/** 分页请求（`MetaGetData`）：`before` 不含、`since` 含（`docs/22` §2.4）。 */
export interface ImPageRequest {
  before?: number;
  since?: number;
  limit?: number;
}

/** `get`：拉历史（`TinodeImClient.kt:806-819` 的 `withEarlierData(limit)`）。 */
export function buildGetHistory(id: string, topic: string, before: number, limit: number): string {
  return JSON.stringify({
    get: { id: id, topic: topic, what: 'data', data: { before: before, limit: limit } }
  });
}

/** 账号凭据（`Credential`）：`meth` 常见 `email` / `tel`；`resp` 是确认码；`done` 表示已验证。 */
export interface ImCredential {
  meth: string;
  val: string;
  resp?: string;
  done?: boolean;
}

/** `acc` 请求体（`MsgClientAcc`）：创建账号（`user:"new"`）并可选直接登录（`login:true`）。 */
export interface ImAccBody {
  id: string;
  user: string;
  login?: boolean;
  scheme?: string;
  secret?: string;
  desc?: ImAccDesc;
  /** 账号凭据（加/验邮箱、手机号）。 */
  cred?: ImCredential[];
  /** 账号标签（服务端可用于检索）。 */
  tags?: string[];
}

/** `acc.desc` 里本端只用 `public`（公开名片）。 */
export interface ImAccDesc {
  public?: ImCard;
}

/**
 * `acc{user:"new", login:true, scheme, secret, desc:{public:{fn}}}`：**注册账号并直接登录**（P3-min）。
 * `basic` 方案的 `secret` 是 `用户名:密码`；`anonymous` 不需要 secret。
 * 服务端应答的 `ctrl.params` 里带 `user` 与新签发的 `token`（会话据此完成登录并回调 `onAuth`）。
 */
export function buildAccCreate(id: string, scheme: string, secret: string, fn: string,
  login: boolean = true): string {
  const body: ImAccBody = { id: id, user: 'new', login: login, scheme: scheme };
  if (scheme !== 'anonymous') body.secret = secret;
  const card: ImCard = {};
  if (fn.trim().length > 0) card.fn = fn.trim();
  body.desc = { public: card };
  return JSON.stringify({ acc: body });
}

/**
 * `basic` 方案的 secret 编码：**base64(`用户名:密码`)**（上游 `AuthScheme.encodeBasicToken:49-57`）。
 * 用户名里**不能有 `:`**（会破坏分隔）；违反时返回空串，调用方应据此报错。
 * 自己实现 base64 是为了让纯逻辑层不依赖平台（`@kit.ArkTS` 的 `util.Base64Helper` 属平台 API）。
 */
export function encodeBasicSecret(user: string, password: string): string {
  const name = user.trim();
  if (name.length === 0 || name.indexOf(':') >= 0) return '';
  const bytes: number[] = [];
  const text = `${name}:${password}`;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : -1;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : -1;
    out += table.charAt(b0 >> 2);
    out += table.charAt(((b0 & 0x03) << 4) | (b1 < 0 ? 0 : b1 >> 4));
    out += b1 < 0 ? '=' : table.charAt(((b1 & 0x0f) << 2) | (b2 < 0 ? 0 : b2 >> 6));
    out += b2 < 0 ? '=' : table.charAt(b2 & 0x3f);
  }
  return out;
}

/** `basic` 用户名是否合法（不能为空、不能含 `:`）——注册/登录前先校验，避免服务端 400 malformed。 */
export function isValidBasicLogin(user: string): boolean {
  const name = user.trim();
  return name.length > 0 && name.indexOf(':') < 0;
}

/**
 * `acc` **更新**账号（P3 余项）：`user` 传要更新的 uid（见上游 `Tinode.java:1279` 的 `account(uid, …)`）。
 * - 改密：`scheme: 'basic'`，`secret: '用户名:新密码'`；
 * - 改公开名片：`fn` 非空时带上 `desc.public.fn`；
 * - 加/验凭据：`cred` 传 `[{meth, val}]`（PNG-3：确认码用 `resp`）。
 * `login` 固定 false（更新不是登录）。
 */
export function buildAccUpdate(id: string, uid: string, scheme: string, secret: string, fn?: string,
  cred?: ImCredential[]): string {
  const body: ImAccBody = { id: id, user: uid, login: false, scheme: scheme, secret: secret };
  if (fn !== undefined && fn.trim().length > 0) body.desc = { public: { fn: fn.trim() } };
  if (cred !== undefined && cred.length > 0) body.cred = cred;
  return JSON.stringify({ acc: body });
}

/** 便捷：加一个待验证凭据（邮箱/手机号）。 */
export function buildAccAddCredential(id: string, uid: string, meth: string, val: string): string {
  return buildAccUpdate(id, uid, 'basic', '', undefined, [{ meth: meth, val: val }]);
}

/**
 * `get{topic, what:"desc"}`：拉某个会话/用户的公开名片（上游 `MsgGetMeta.desc()`，
 * `Tinode.java:850` 用它取对方资料）。结果在 `meta.desc` 里。
 */
export function buildGetMetaDesc(id: string, topic: string): string {
  return JSON.stringify({ get: { id: id, topic: topic, what: 'desc' } });
}

/**
 * `get{topic:"me", what:"sub", sub:{limit}}`：拉"我的订阅列表"（会话列表）。
 * 与自动订阅 `me` 等价，适合宿主主动刷新。
 */
export function buildGetMetaSub(id: string, topic: string, limit: number): string {
  const sub: ImPageRequest = {};
  if (Number.isFinite(limit) && limit > 0) sub.limit = Math.floor(limit);
  return JSON.stringify({ get: { id: id, topic: topic, what: 'sub', sub: sub } });
}

/**
 * `set{topic, desc:{public:{fn,photo}}}`：改公开名片（上游 `MetaSetDesc`）。
 * 传空串表示"不改这个字段"。
 */
export function buildSetPublicDesc(id: string, topic: string, fn: string, photo?: string): string {
  const card: ImCard = {};
  if (fn.trim().length > 0) card.fn = fn.trim();
  if (photo !== undefined && photo.trim().length > 0) card.photo = photo.trim();
  return JSON.stringify({ set: { id: id, topic: topic, desc: { public: card } } });
}

/**
 * `acc` 失败的专用文案（P3-min）：409 在 `acc` 语境下是"用户名已存在/冲突"，
 * 与 topic 冲突的含义不同；其余码回落到通用文案。
 */
export function accFailureText(code: number, serverText: string): string {
  if (hasChinese(serverText)) return serverText;
  if (code === IM_CODE_CONFLICT) return '用户名已被占用，请换一个再试';
  if (code === IM_CODE_BAD_REQUEST) return '用户名或密码不符合要求（长度/字符限制）';
  return ctrlFailureText(code, serverText);
}

/**
 * `get{what:"data", data:{since, limit}}`：从某个位点**向后**补历史（断线重连用）。
 * 与 `buildGetHistory`（`before`）二选一：前者补缺口，后者翻旧账。
 */
export function buildGetHistorySince(id: string, topic: string, since: number, limit: number): string {
  return JSON.stringify({
    get: { id: id, topic: topic, what: 'data', data: { since: since, limit: limit } }
  });
}

/** `pub`：发消息（`MsgClientPub{id,topic,noecho,head,content}`）；`head` 与 `content` 都可能为空。 */
export function buildPub(id: string, topic: string, head: ImHead | null, content: Drafty | null): string {
  const pub: ImPubBody = { id: id, topic: topic };
  if (head !== null) pub.head = head;
  if (content !== null) pub.content = content;
  return JSON.stringify({ pub: pub });
}

/** `pub` 报文体。 */
export interface ImPubBody {
  id: string;
  topic: string;
  head?: ImHead;
  content?: Drafty;
}

/** `note`：已读回执（`MsgClientNote{topic,what,seq}`；`what` 取值见 `Tinode.java:116-121`）。 */
export function buildNoteRead(topic: string, seq: number): string {
  return JSON.stringify({ note: { topic: topic, what: 'read', seq: seq } });
}

/** `note`：正在输入（同信封，`what = "kp"`）。 */
export function buildNoteKeyPress(topic: string): string {
  return JSON.stringify({ note: { topic: topic, what: 'kp' } });
}

/**
 * `del`：删除会话（`what:"topic"`，`hard` 省略时是「软删」= 只对当前用户隐藏）。
 * 形状对齐 SDK `MsgClientDel(id, topic)` + `Tinode.delTopic`（`docs/22` §1）。
 */
export function buildDelTopic(id: string, topic: string, hard: boolean): string {
  const del: DelEnvelope = { id: id, topic: topic, what: 'topic' };
  if (hard) del.hard = true;
  return JSON.stringify({ del: del });
}

/**
 * `del`：删除消息区间（`what:"msg"`，`delseq:[{low, hi?}]`）。
 * `hard:true` 是「对所有用户硬删」（服务端可能拒绝，见契约的对话操作一节）。
 */
export function buildDelMessages(id: string, topic: string, ranges: DelRange[], hard: boolean): string {
  const del: DelEnvelope = { id: id, topic: topic, what: 'msg', delseq: ranges };
  if (hard) del.hard = true;
  return JSON.stringify({ del: del });
}

/** 删除请求的信封（`del`）。 */
interface DelEnvelope {
  id: string;
  topic: string;
  what: string;
  delseq?: DelRange[];
  hard?: boolean;
}

/** 删除区间（SDK `MsgRange`：`low` 必填，`hi` 可省=只删一条）。 */
export interface DelRange {
  low: number;
  hi?: number;
}

/** `leave`：离开 topic（切号/退出前清 SDK 侧订阅）。 */

export function buildLeave(id: string, topic: string): string {
  return JSON.stringify({ leave: { id: id, topic: topic } });
}

// ── 下行报文 ────────────────────────────────────────────────────────────────

/** `ctrl`（`MsgServerCtrl{id,topic,code,text,ts,params}`）。 */
export interface ImCtrl {
  id?: string;
  topic?: string;
  code: number;
  text?: string;
  ts?: string;
  params?: ImCtrlParams;
}

/** `ctrl.params`：只声明本端要读的键（`ver`/`build` 是 hi 的应答，`seq` 是 pub 的序号）。 */
export interface ImCtrlParams {
  ver?: string;
  build?: string;
  seq?: number;
  /** 登录应答里的 Tinode uid（`Tinode.java:1431` `getStringParam("user")`）。 */
  user?: string;
  /** 服务端可能回签新 token（本端不落盘，见文件头注释）。 */
  token?: string;
  /** 新 token 的过期时间字符串（Android 也没有使用，见 docs/22 §6.11）。 */
  expires?: string;
  /** 服务端限制（`SERVER_LIMITS`），本端暂不使用，保留字段以便记录。 */
  maxMessageSize?: number;
  maxSubscriberCount?: number;
  maxTagLength?: number;
}

/**
 * 订阅列表（空安全）：`meta.sub` 缺失时返回空数组。
 * `me` topic 的全量订阅（`sub{get{what:"desc sub"}}`）就靠这里拿到会话清单。
 */
export function metaSubs(meta: ImMeta | null | undefined): ImMetaSub[] {
  if (meta === null || meta === undefined) return [];
  const subs = meta.sub;
  return subs === undefined || subs === null ? [] : subs;
}

/** 名片显示名（`TheCard.fn`）。 */
export function cardName(card: ImCard | null | undefined): string {
  if (card === null || card === undefined) return '';
  const fn = card.fn;
  return typeof fn === 'string' ? fn : '';
}

/** 名片头像 ref：`photo` 是字符串就直接用，是 `{ref}` 结构就取 `ref`（SDK 两种形态都出现过）。 */
export function cardPhotoRef(card: ImCard | null | undefined): string {
  if (card === null || card === undefined) return '';
  const photo = card.photo;
  if (typeof photo === 'string') return photo;
  if (photo === undefined || photo === null) return '';
  const ref = photo.ref;
  return typeof ref === 'string' ? ref : '';
}

/** `data`（`MsgServerData{id,topic,head,from,ts,seq,content}`）：一条消息。 */
export interface ImData {
  id?: string;
  topic: string;
  head?: ImHead;
  from?: string;
  ts?: string;
  seq: number;
  content?: Drafty;
}

/** `info`（`MsgServerInfo{topic,src,from,what,seq,event,payload}`）：回执 / 输入中。 */
export interface ImInfo {
  topic: string;
  src?: string;
  from?: string;
  what: string;
  seq?: number;
}

/** 一条订阅（`model/Subscription.java:14-33` 里本端要读的字段）。 */
export interface ImMetaSub {
  topic?: string;
  /** 对方 uid（P2P 下与 topic 同值）。 */
  user?: string;
  /** 该 topic 的最大 seq。 */
  seq?: number;
  /** 自己读到的 seq（已读位点）。 */
  read?: number;
  /** 对端收到的 seq。 */
  recv?: number;
  /** 最后活动时间（Tinode 用 ISO 字符串）。 */
  touched?: string;
  online?: boolean;
  /** 对方的公开名片（`TheCard`）。 */
  pub?: ImCard;
}

/** Tinode 公开名片（`TheCard`）：只读 `fn`（显示名）与 `photo`（头像 ref）。 */
export interface ImCard {
  fn?: string;
  /** `photo` 线上两种形态都出现过：字符串 ref 或 `{ref}` 对象（`cardPhotoRef` 都认）。 */
  photo?: string | ImPhotoRef;
}

/** `photo` 可能是字符串或 `{ref}` 结构（SDK `PhotoRef` 序列化形态）。 */
export interface ImPhotoRef {
  ref?: string;
}

/** `meta`（`MsgServerMeta{id,topic,ts,desc,sub,del,tags,cred}`）。 */
export interface ImMeta {
  id?: string;
  topic: string;
  ts?: string;
  desc?: Object;
  sub?: ImMetaSub[];
}

/** `pres`（`MsgServerPres{topic,src,what,ua,...}`）：在线状态。 */
export interface ImPres {
  topic: string;
  src?: string;
  /** `on` | `off` | `gone` | `rec` … */
  what?: string;
  ua?: string;
  /** 事件时间（Tinode 用 ISO 字符串）：`off`/`gone` 时就是**最后在线**时间。 */
  t?: string;
  /** 事件序号（部分部署会带）。 */
  seq?: number;
}

/** 一条服务端报文（一次只带其中一个键；`extra` 忽略）。 */
export interface ImServerMessage {
  ctrl?: ImCtrl;
  data?: ImData;
  info?: ImInfo;
  meta?: ImMeta;
  pres?: ImPres;
  /** 服务端下发的 note（`what`: `kp` 正在输入 / `read` 已读 / `recv` 送达）。 */
  note?: ImNote;
}

/** `note` 报文（Tinode `MsgServerNote`）：正在输入与已读回执都走它。 */
export interface ImNote {
  topic?: string;
  /** `kp` | `read` | `recv` | `sub` | `upd` 等。 */
  what?: string;
  seq?: number;
  /** 发送者（`kp` 的发出方）。 */
  from?: string;
}

/** 入站帧默认上限（字节）。与出站 `DEFAULT_MAX_FRAME_BYTES` 同量级，避免解析超大 JSON 把宿主打死。 */
export const DEFAULT_MAX_INBOUND_BYTES = 1024 * 1024;

/** 出站单帧默认上限（字节，256 KB —— 与 Tinode 服务端默认 `max_message_size` 同量级）。 */
export const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;

/**
 * 解析服务端报文。空串、非 JSON、不含任何已知键的 JSON、**超过体量上限**、以及关键字段类型不对的，
 * 一律返回 null（不把脏数据当消息渲染，也不让畸形帧进入状态机）。
 *
 * `maxBytes` 默认 1 MB（`DEFAULT_MAX_INBOUND_BYTES`）；会话会用配置里的 `maxFrameBytes` 覆盖。
 */
export function parseServerMessage(text: string, maxBytes: number = DEFAULT_MAX_INBOUND_BYTES): ImServerMessage | null {
  if (text.trim().length === 0) return null;
  // 体量守卫：先看长度，避免对超大串做 JSON.parse（**审计 P0-2**）。
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_INBOUND_BYTES;
  if (text.length > limit) return null;
  let raw: Object;
  try {
    raw = JSON.parse(text) as Object;
  } catch (_) {
    return null;
  }
  if (raw === null || Array.isArray(raw) || typeof raw !== 'object') return null;
  const message = raw as ImServerMessage;
  if (message.ctrl === undefined && message.data === undefined && message.info === undefined
    && message.meta === undefined && message.pres === undefined && message.note === undefined) {
    return null;
  }
  // 关键字段类型校验：`ctrl.code` 必须是数字，`data.seq` 必须是数字（否则后续比较/取值会静默出错）。
  if (message.ctrl !== undefined && typeof message.ctrl.code !== 'number') return null;
  if (message.data !== undefined && typeof message.data.seq !== 'number') return null;
  return message;
}

/** ctrl 码分类（`docs/22` §2.4：200/202 成功、3xx 重定向类、4xx 客户端错误、5xx 服务端错误）。 */
export function ctrlKind(code: number): string {
  if (code >= 200 && code < 300) return 'ok';
  if (code >= 300 && code < 400) return 'redirect';
  if (code >= 400 && code < 500) return 'client';
  if (code >= 500) return 'server';
  return 'unknown';
}

/** 200/202 视为成功（`TinodeImClient.kt:854` 的 `code in 200..299`）。 */
export function ctrlOk(code: number): boolean {
  return code >= 200 && code < 300;
}

/**
 * 会话是否该放弃重连：鉴权类错误重连也没用（401/403），其余（网络、5xx、503）继续退避重试。
 * 依据 `TinodeImClient.kt:418-441` 的 `ensureConnected` 语义与 SDK 的 `ExpBackoff`（`:8-12`：
 * 基础 1 s、2^attempt 上限 shift 10）。
 */
export function ctrlIsFatal(code: number): boolean {
  return code === IM_CODE_UNAUTHORIZED || code === IM_CODE_FORBIDDEN
    || code === IM_CODE_BAD_REQUEST || code === IM_CODE_NOT_FOUND;
}

/** ctrl 失败的中文提示：优先服务端原话，否则按码给固定文案（不把英文原文直接丢给用户）。 */
export function ctrlFailureText(code: number, serverText: string): string {
  if (hasChinese(serverText)) return serverText;
  if (code === IM_CODE_UNAUTHORIZED) return '登录状态已失效，请重新登录后再试';
  if (code === IM_CODE_FORBIDDEN) return '没有权限访问该会话';
  if (code === IM_CODE_NOT_FOUND) return '会话不存在或已被删除';
  if (code >= 500) return '消息服务暂时不可用，请稍后重试';
  if (code >= 400) return '消息请求被拒绝';
  return '消息服务返回了未知错误';
}

/** 文本里有没有中文（与 `UserText.failureText` 同一口径：只有中文才当作用户可读文案）。 */
function hasChinese(text: string): boolean {
  if (text === undefined || text === null) return false;
  return /[\u4e00-\u9fa5]/.test(text);
}

/** 退避毫秒（SDK `ExpBackoff:8-31`：1000 * 2^n + 随机 [0, 1000 * 2^n)，n 上限 10）。 */
/**
 * 指数退避延迟（毫秒）。不传 `maxMs` 时无上限（保持历史语义，测试按原序列钉住）；
 * 传入时按上限截断 —— 审计 P1-2：移动端 IM 断线不该等到 25 分钟后才重连。
 */
export function backoffDelayMs(attempt: number, randomFraction: number, maxMs: number = 0): number {
  const shift = attempt > 10 ? 10 : (attempt < 0 ? 0 : attempt);
  const base = 1000 * (1 << shift);
  const jitter = Math.floor(base * normalizeFraction(randomFraction));
  const delay = base + jitter;
  if (!Number.isFinite(maxMs) || maxMs <= 0) return delay;
  return delay > maxMs ? maxMs : delay;
}

function normalizeFraction(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? 0.999 : value;
}
