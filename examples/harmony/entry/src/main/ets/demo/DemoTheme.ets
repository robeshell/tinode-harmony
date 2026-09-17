/**
 * Demo 的视觉令牌：数值照宿主 App（`theme/AppTheme.ets` + `im/ImBubbleStyle.ts`，两者已对齐 Android 基线），
 * 这样示例看起来就是产品该有的样子，而不是一堆裸控件。
 */
export class DemoTheme {
  static readonly brand: string = '#1890FF';
  static readonly brandText: string = '#0054C7';
  static readonly danger: string = '#FF4D4F';
  static readonly success: string = '#4CAF50';
  static readonly warning: string = '#FF9800';

  static readonly textPrimary: string = '#222222';
  static readonly textSecondary: string = '#666666';
  static readonly textHint: string = '#8C8C8C';

  static readonly divider: string = '#EEEEEE';
  static readonly border: string = '#D9D9D9';
  static readonly surface: string = '#F0F0F0';
  static readonly pageBackground: string = '#F3F2F8';
  static readonly fieldFill: string = '#EFF1F5';
  static readonly bubbleMine: string = '#1890FF';
  static readonly bubblePeer: string = '#FFFFFF';
  static readonly bubbleBorder: string = '#E0E0E0';
  static readonly avatarColors: string[] = ['#1890FF', '#4CAF50', '#FF9800', '#9C27B0', '#00BCD4', '#795548'];

  static readonly pagePadding: number = 16;
  static readonly cardRadius: number = 12;
  static readonly bubbleRadius: number = 12;
  static readonly bubbleMaxWidth: number = 260;
  static readonly bubblePaddingH: number = 12;
  static readonly bubblePaddingV: number = 8;
  static readonly avatarSize: number = 40;
  static readonly avatarFontSize: number = 16;
  static readonly appBarHeight: number = 52;
}

/** 头像底色（按 topic 稳定取色，避免每次渲染变色）。 */
export function avatarColorOf(topic: string): string {
  let sum = 0;
  for (let i = 0; i < topic.length; i++) sum += topic.charCodeAt(i);
  const palette = DemoTheme.avatarColors;
  return palette[sum % palette.length];
}

/** 头像首字：取名字第一个字符（中文/emoji 安全）。 */
export function initialOf(name: string, fallback: string): string {
  const text = name.trim().length > 0 ? name.trim() : fallback;
  if (text.length === 0) return '?';
  return Array.from(text)[0];
}
