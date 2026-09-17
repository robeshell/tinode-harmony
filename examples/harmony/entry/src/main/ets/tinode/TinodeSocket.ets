/**
 * tinode-harmony —— Tinode 即时通讯协议的 HarmonyOS 客户端 SDK。
 *
 * 许可：MIT（见同目录 LICENSE）。本实现为**独立 ArkTS 重写**；
 * 协议常量与报文形状参考 Tinode 官方文档与 Apache-2.0 的 `co/tinode/tinodesdk`（见 NOTICE）。
 */

import { webSocket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { redactError, tinodeLogDetail, tinodeLogFailure } from './TinodeLog.ts';
import { IM_HEADER_API_KEY } from './TinodeWire';
import type { ImTransport, ImTransportHandlers } from './TinodeSession';

/**
 * `ImTransport` 的平台实现：把 `TinodeSession` 的报文收发接到 `@kit.NetworkKit` 的 WebSocket
 * （API 见本地 SDK `@ohos.net.webSocket.d.ts`：`createWebSocket()` / `connect(url, {header})` /
 * `on('open'|'message'|'close'|'error')` / `send(string)` / `close()`）。
 *
 * 分工：**超时、退避、重连、代次、状态机全在纯逻辑 `TinodeSession` 里**（那些能主机测试），
 * 这里只做三件事：建连（带 apikey 头）、转发文本帧、把平台错误翻成中文。回调都带 `Date.now()`，
 * 会话因此不需要自己读时钟，也不需要平台定时器（重连由页面/服务的 `tick` 驱动）。
 *
 * 两处需要服务端确认（契约 `im.protocol` 的 openQuestions）：
 * 1. **apikey 从哪来**：Android 把它硬编码在 `TinodeImClient.kt:68`，本端**不入库**
 *    （docs/16:204 把「硬编码第三方凭据」列为不要移植项）。构造时由调用方传入；为空就**不发这个头**，
 *    让服务端如实拒绝（多为 401/403），而不是猜一个 key。
 * 2. **是否必须 apikey**：Tinode 部署可以不启用 apikey；若必须，正确做法是后端在
 *    `GET device/app/im/token` 的响应里一并下发（`docs/22` §6.7）。
 */
export class TinodeSocket implements ImTransport {
  private socket: webSocket.WebSocket | null = null;
  private handlers: ImTransportHandlers | null = null;
  private connecting: boolean = false;
  private closed: boolean = false;
  /** 本次 socket 的事件解绑器（`open()` 里设置，`close()`/重新 open 时调用）。 */
  private detach: (() => void) | null = null;
  private readonly url: string;
  private readonly apiKey: string;
  /** 是否允许明文 `ws://`（默认 true = 告警放行；false = 拒绝）。 */
  private readonly allowInsecure: boolean;

  constructor(url: string, apiKey: string, allowInsecure: boolean = true) {
    this.url = url;
    this.apiKey = apiKey;
    this.allowInsecure = allowInsecure;
  }

  /** 明文连接是否允许（默认允许但告警；`false` 时明文直接抛错）。 */
  private insecureAllowed(): boolean {
    return this.allowInsecure;
  }

  /** 是否已经连上（已收到 open 回调）；只用于页面显示，不代表「已认证」。 */
  isOpen(): boolean {
    return this.socket !== null && !this.connecting && !this.closed;
  }

  open(handlers: ImTransportHandlers): void {
    // **审计 P1-5**：明文 `ws://` 会把这个部署的 apikey（以及 login 里的 token）明码发出去。
    // 默认**只告警不拒绝**（很多内网部署就是 ws，直接拒绝会破坏现有集成）；
    // 需要严格模式的宿主可以传 `allowInsecure: false` 让它抛错。
    if (this.url.startsWith('ws://')) {
      if (!this.allowInsecure) {
        const refused = this.handlers;
        if (refused !== null) refused.onError('已禁止明文连接（allowInsecure=false），请改用 wss://', Date.now());
        return;
      }
      // 这是**告警**不是失败：走 detail 通道（level=warn），避免宿主把它渲染成"失败"。
      tinodeLogDetail('im/socket', '明文 ws:// 连接：凭据将不经 TLS 传输（如需禁止请设 allowInsecure=false）', 'warn');
    }
    // **审计 P1-4**：重复 open 必须先把上一只 socket 关掉并解绑，否则旧回调仍活着、socket 泄漏。
    this.close();
    this.handlers = handlers;
    this.connecting = true;
    this.closed = false;
    const socket = webSocket.createWebSocket();
    this.socket = socket;
    // 事件只认"本次 socket"：即使旧 socket 的回调迟到，也不会写进新连接的状态。
    const isCurrent = (): boolean => this.socket === socket && !this.closed;
    this.detach = () => {
      try {
        socket.off('open');
        socket.off('message');
        socket.off('close');
        socket.off('error');
      } catch (_) {
        // 解绑失败只影响日志噪音，不影响状态收敛。
      }
    };
    // 平台回调都带 nowMs：会话据此算超时与退避，不用平台定时器。
        socket.on('open', (error: BusinessError, value: Object) => {
      if (!isCurrent()) return;
      this.connecting = false;
      const target = this.handlers;
      if (target !== null) target.onOpen(Date.now());
    });
        socket.on('message', (error: BusinessError, value: string | ArrayBuffer) => {
      if (!isCurrent()) return;
      const target = this.handlers;
      if (target === null) return;
      if (typeof value !== 'string') {
        // Tinode 下行是文本帧；二进制帧不当报文解析（不猜内容）。
        tinodeLogFailure('im/socket', new Error('忽略非文本 WebSocket 帧'));
        return;
      }
      target.onMessage(value, Date.now());
    });
        socket.on('close', (error: BusinessError, value: webSocket.CloseResult) => {
      if (!isCurrent()) return;
      this.connecting = false;
      this.closed = true;
      const target = this.handlers;
      if (target !== null) target.onClose(Date.now());
    });
        socket.on('error', (error: BusinessError) => {
      if (!isCurrent()) return;
      this.connecting = false;
      tinodeLogFailure('im/socket', new Error(redactError(error)));
      const target = this.handlers;
      if (target !== null) target.onError('消息服务连接出错，请检查网络后重试', Date.now());
    });

    const options: webSocket.WebSocketRequestOptions = {};
    if (this.apiKey.length > 0) {
      const header: Record<string, string> = {};
      header[IM_HEADER_API_KEY] = this.apiKey;
      options.header = header;
    }
    socket.connect(this.url, options).then((ok: boolean) => {
      // `open` 事件才是「连上」；connect 的返回值只表示发起成功，不在这里改状态。
      if (!ok) tinodeLogFailure('im/socket', new Error('WebSocket connect 返回失败'));
    }).catch((error: BusinessError) => {
      if (!isCurrent()) return;
      this.connecting = false;
      tinodeLogFailure('im/socket', new Error(redactError(error)));
      const target = this.handlers;
      if (target !== null) target.onError('无法连接消息服务，请检查网络后重试', Date.now());
    });
  }

  send(text: string): void {
    const socket = this.socket;
    if (socket === null || this.closed || this.connecting) {
      // **审计 P1-3**：原来这里是静默 return，而注释（`TinodeSession.ts` 的端口说明）承诺会回调 onError。
      // 现在如实上报，调用方不会以为"发出去了"。
      const dropped = this.handlers;
      if (dropped !== null && !this.closed) dropped.onError('连接尚未就绪，消息未发送', Date.now());
      return;
    }
    socket.send(text).catch((error: BusinessError) => {
      tinodeLogFailure('im/socket', error);
      const target = this.handlers;
      // 发送失败按传输失败处理：会话会退避重连，而不是假装消息发出去了。
      if (target !== null && !this.closed) target.onError('消息发送失败，请检查网络后重试', Date.now());
    });
  }

  close(): void {
    this.closed = true;
    this.connecting = false;
    this.handlers = null;
    const socket = this.socket;
    this.socket = null;
    if (this.detach !== null) {
      this.detach();
      this.detach = null;
    }
    if (socket === null) return;
    socket.close().catch((error: BusinessError) => {
      // 关闭失败只记日志：调用方已经把会话状态收敛到 closed。
      tinodeLogFailure('im/socket', error);
    });
  }
}
