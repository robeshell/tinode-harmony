/**
 * 示例用的 Node 传输层：**零依赖**，直接用 Node 22+ 内置的全局 `WebSocket`。
 *
 * 它实现 SDK 的 `ImTransport` 端口，和 HarmonyOS 的 `TinodeSocket` 语义一致：
 * `open(handlers)` / `send(text)` / `close()`，回调都带毫秒时间戳。
 *
 * 注意：浏览器/Node 的内置 WebSocket **不能自定义请求头**，所以 apikey 走
 * **查询参数** `?apikey=xxx` 传（Tinode 服务端支持这种形式，官方 JS SDK 也是这么做的）。
 */
export class NodeWebSocketTransport {
  constructor(url, apiKey = '') {
    this.url = url;
    this.apiKey = apiKey;
    this.socket = null;
    this.handlers = null;
    this.closed = false;
  }

  open(handlers) {
    this.handlers = handlers;
    this.closed = false;
    const url = this.apiKey.length > 0
      ? `${this.url}${this.url.includes('?') ? '&' : '?'}apikey=${encodeURIComponent(this.apiKey)}`
      : this.url;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener('open', () => { if (!this.closed) handlers.onOpen(Date.now()); });
    socket.addEventListener('message', (event) => {
      if (this.closed) return;
      if (typeof event.data !== 'string') return;
      handlers.onMessage(event.data, Date.now());
    });
    socket.addEventListener('close', () => { if (!this.closed) { this.closed = true; handlers.onClose(Date.now()); } });
    socket.addEventListener('error', () => {
      if (this.closed) return;
      handlers.onError('WebSocket 连接出错', Date.now());
    });
  }

  send(text) {
    const socket = this.socket;
    if (socket === null || this.closed || socket.readyState !== 1) {
      if (this.handlers !== null && !this.closed) this.handlers.onError('连接尚未就绪，消息未发送', Date.now());
      return;
    }
    socket.send(text);
  }

  close() {
    this.closed = true;
    this.handlers = null;
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      try { socket.close(); } catch (_) { /* 关闭失败不影响状态收敛 */ }
    }
  }
}
