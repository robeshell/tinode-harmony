/**
 * @otq/tinode-harmony —— Tinode 即时通讯协议的 HarmonyOS 客户端 SDK。
 *
 * 许可：MIT（见同目录 LICENSE）。本实现为**独立 ArkTS 重写**；
 * 协议常量与报文形状参考 Tinode 官方文档与 Apache-2.0 的 `co/tinode/tinodesdk`（见 NOTICE）。
 */

/**
 * SDK 的日志出口（**端口**，不是实现）。
 *
 * SDK 不能依赖宿主应用的日志模块，所以这里只声明一个可注入的 sink：
 * 宿主在启动时调用 `setTinodeLogSink({ detail, failure })` 把 `logDetail`/`logFailure` 接进来；
 * 不注入时是**静默**的（默认 no-op），SDK 的其它行为完全不受影响。
 */
export interface TinodeLogSink {
  /** 诊断详情（level: 'info' | 'warn' | 'error'）。 */
  detail: (tag: string, message: string, level: string) => void;
  /** 失败（宿主侧一般会脱敏/落盘）。 */
  failure: (tag: string, error: Object) => void;
}

const SILENT: TinodeLogSink = {
  detail: () => {},
  failure: () => {}
};

let sink: TinodeLogSink = SILENT;

/** 注入日志实现（宿主调用；重复调用以最后一次为准）。 */
export function setTinodeLogSink(next: TinodeLogSink): void {
  sink = next;
}

/** 还原为静默（测试/卸载时用）。 */
export function resetTinodeLogSink(): void {
  sink = SILENT;
}

/** SDK 内部用的详情日志。 */
export function tinodeLogDetail(tag: string, message: string, level: string = 'info'): void {
  sink.detail(tag, message, level);
}

/** SDK 内部用的失败日志。 */
export function tinodeLogFailure(tag: string, error: Object): void {
  sink.failure(tag, error);
}

/**
 * 日志脱敏（**审计 P1-6**）：topic 名对 P2P 会话就是**对方 uid**，属可识别信息，
 * 公开 SDK 不该把原文交给宿主的日志系统。这里统一只留前 6 位 + 长度：
 * `usrD7D5MQ08-bA` → `usrD7D…(14)`。宿主如果确实需要原文，自己在上层记录。
 */
export function redactTopic(topic: string): string {
  const text = topic.trim();
  if (text.length === 0) return '';
  const head = text.length > 6 ? `${text.slice(0, 6)}…(${text.length})` : text;
  return head;
}

/** 错误脱敏：只保留 `code` 与 `message`，丢掉 stack/BusinessError 里的其他字段。 */
export function redactError(error: Object | null | undefined): string {
  if (error === null || error === undefined) return '';
  const record = error as Record<string, Object>;
  const code = record.code;
  const message = record.message;
  const parts: string[] = [];
  if (typeof code === 'number' || typeof code === 'string') parts.push(`code=${String(code)}`);
  if (typeof message === 'string' && message.length > 0) parts.push(`message=${message}`);
  return parts.length > 0 ? parts.join(' ') : 'unknown error';
}
