/**
 * Demo 的展示格式化（纯函数）：时间标签、送达标记、文件大小、时长。
 * 时间标签规则与宿主 App 一致：同一天只显示 HH:mm，跨天显示 M月D日 HH:mm；相邻消息间隔 > 5 分钟才插一条标签。
 */
import { TinodeMessage } from '../tinode/Index.ts';

/** 相邻消息超过这个间隔就插一条时间标签（与 Android 基线一致）。 */
export const NEEDS_TIME_LABEL_MS = 5 * 60 * 1000;

function pad(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** 时间标签文案：今天 `HH:mm`、昨天 `昨天 HH:mm`、今年 `M月D日 HH:mm`、更早 `Y年M月D日 HH:mm`。 */
export function timeLabelOf(ts: number, nowMs: number, yesterdayLabel: string = '昨天'): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const date = new Date(ts);
  const now = new Date(nowMs);
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) return hm;
  const yesterday = new Date(nowMs - 24 * 3600 * 1000);
  const isYesterday = date.getFullYear() === yesterday.getFullYear() && date.getMonth() === yesterday.getMonth()
    && date.getDate() === yesterday.getDate();
  if (isYesterday) return `${yesterdayLabel} ${hm}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
}

/** 是否需要给这条消息插时间标签（首条、间隔超过 5 分钟、或时间回退）。 */
export function needsTimeLabel(previous: TinodeMessage | null, current: TinodeMessage): boolean {
  if (previous === null) return true;
  return current.ts - previous.ts >= NEEDS_TIME_LABEL_MS || current.ts < previous.ts;
}

/** 送达标记：发送中 / 已发送 / 已送达 / 失败（demo 里由发送结果与 ctrl 决定）。 */
export function deliveryMarkOf(status: string): string {
  if (status === 'sending') return '…';
  if (status === 'sent') return '✓';
  if (status === 'delivered') return '✓✓';
  if (status === 'failed') return '发送失败';
  return '';
}

/** 文件大小：B/KB/MB。 */
export function sizeTextOf(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 时长：`12"` / `1'05"`（与产品里语音气泡的写法一致）。 */
export function durationTextOf(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes === 0 ? `${seconds}"` : `${minutes}'${pad(seconds)}"`;
}

/** 会话列表里的预览文案（附件类消息给出类型前缀）。 */
export function previewOfKind(kind: string, text: string): string {
  if (kind === 'IM') return text.length > 0 ? `[图片] ${text}` : '[图片]';
  if (kind === 'EX') return text.length > 0 ? `[文件] ${text}` : '[文件]';
  if (kind === 'AU') return text.length > 0 ? `[语音] ${text}` : '[语音]';
  if (kind === 'VD') return text.length > 0 ? `[视频] ${text}` : '[视频]';
  if (kind === 'QQ') return text.length > 0 ? `[引用] ${text}` : '[引用]';
  return text;
}
