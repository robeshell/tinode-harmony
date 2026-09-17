/**
 * tinode-harmony 示例 App —— 完整聊天 demo（4 个视图，单页切换）：
 *  1. 连接与账号：地址/apikey → 注册或密码登录（也可 anonymous）
 *  2. 会话列表：名字/头像/未读/在线/最后在线/权限摘要 + 刷新 + 主题登记状态
 *  3. 聊天：历史分页、收发、富文本（加粗/斜体）、附件（校验/分块/进度）、已读、正在输入、撤回
 *  4. 能力清单：SDK 每个能力 → 对应 API 与源码位置
 * 配置来源：页面输入框 或 gitignored 的 `resources/rawfile/im.local.json`。
 */
import { common } from '@kit.AbilityKit';
import { DemoClient, DemoConversation, DemoListener, DemoMessage } from '../demo/DemoClient';
import { DraftySegment } from '../tinode/Index.ts';
import { loadLocalConfig, LocalTinodeConfig } from '../tinode/LocalConfig';

const CAPABILITIES: string[][] = [
  ['连接 / hi 握手 / 服务端版本', 'ImSession.start + onServerVersion', 'tinode/TinodeSession.ts'],
  ['超时 / 指数退避重连 / 代次守卫', 'ImSession.tick（宿主驱动时间）', 'tinode/TinodeSession.ts'],
  ['登录 scheme', "token / basic(base64) / anonymous / none", 'tinode/TinodeWire.ts'],
  ['注册账号（acc user:"new"）', 'Tinode.registerAccount', 'tinode/Tinode.ts'],
  ['改密 / 加凭据 / 改名片', 'changePassword / addCredential / updatePublicName', 'tinode/Tinode.ts'],
  ['订阅 / 历史分页 / 已读 / 正在输入 / 撤回', 'subscribe / history / setRead / setTyping / deleteMessages', 'tinode/Tinode.ts'],
  ['主题登记 + 断线自动重订阅', 'TinodeTopics / onTopicState / knownTopics', 'tinode/TinodeTopics.ts'],
  ['会话列表（meta.sub）', 'profilesFromMeta / mergeProfiles / onTopics', 'tinode/TinodeMeta.ts'],
  ['在线与最后在线', 'applyPresence / lastSeenMs', 'tinode/TinodeMeta.ts'],
  ['消息去重合并 / 未读 / 会话摘要 / 容量淘汰', 'mergeMessages / unreadOf / conversationSummaryOf / planMessageEviction', 'tinode/TinodeStore.ts'],
  ['存储端口 + LRU 读缓存', 'CachedTinodeStorage(inner, capacity)', 'tinode/TinodeStorageCache.ts'],
  ['富文本写侧（加粗/斜体/链接/@/图片）', 'draftyWithStyle / draftyLink / draftyMention / draftyImage', 'tinode/Drafty.ts'],
  ['富文本编辑（偏移自动位移）', 'draftyInsert / draftyDelete / draftyTrim', 'tinode/Drafty.ts'],
  ['富文本渲染模型', 'draftySegments', 'tinode/Drafty.ts'],
  ['附件校验 / 分块 / 进度 / 缓存 LRU', 'validateAttachment / planChunks / planEviction', 'tinode/TinodeAttachment.ts'],
  ['附件上传（平台 HTTP）', 'HarmonyAttachmentHttp（未真机验证）', 'tinode/TinodeAttachmentHttp.ets'],
  ['权限模型', 'acsAllows / parseAcs / acsSummary', 'tinode/TinodeAcs.ts'],
  ['入站防御 / 出站帧体量守卫 / 日志脱敏', 'parseServerMessage / maxFrameBytes / redactTopic', 'tinode/TinodeWire.ts · TinodeLog.ts']
];

@Entry
@ComponentV2
struct Index {
  @Local view: number = 0;
  @Local wsUrl: string = '';
  @Local apiKey: string = '';
  @Local user: string = '';
  @Local password: string = '';
  @Local anonymous: boolean = false;
  @Local state: string = '未连接';
  @Local detail: string = '';
  @Local logLines: string[] = [];
  @Local conversations: DemoConversation[] = [];
  @Local messages: DemoMessage[] = [];
  @Local currentTopic: string = '';
  @Local draft: string = '';
  @Local bold: boolean = false;
  @Local italic: boolean = false;
  @Local uploadNote: string = '';
  @Local uploadPercent: number = 0;
  @Local subscribedCount: number = 0;
  @Local topicInput: string = '';
  @Local myUid: string = '';
  private client: DemoClient | null = null;

  aboutToAppear(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    loadLocalConfig(context).then((cfg: LocalTinodeConfig) => {
      this.wsUrl = cfg.wsUrl;
      this.apiKey = cfg.apiKey;
      this.user = cfg.user.length > 0 ? cfg.user : cfg.token;
      this.password = cfg.password;
      this.append('已读取本地配置（若无请手填）');
    }).catch(() => {});
    const listener: DemoListener = {
      onState: (state: string, detail: string) => { this.state = state; if (detail.length > 0) this.detail = detail; },
      onLog: (line: string) => this.append(line),
      onConversations: (list: DemoConversation[]) => { this.conversations = list; },
      onMessages: (list: DemoMessage[]) => { this.messages = list; },
      onUploadProgress: (percent: number, note: string) => { this.uploadPercent = percent; this.uploadNote = note; }
    };
    this.client = new DemoClient(listener);
  }

  aboutToDisappear(): void {
    const client = this.client;
    if (client !== null) client.disconnect();
  }

  private append(line: string): void {
    const next = this.logLines.slice();
    next.push(line);
    this.logLines = next.length > 120 ? next.slice(next.length - 120) : next;
  }

  private clientOrNull(): DemoClient | null {
    return this.client;
  }

  @Builder
  connectionView() {
    Column({ space: 8 }) {
      Text('1 · 连接与账号').fontSize(18).fontWeight(FontWeight.Bold)
      Text(`状态：${this.state}${this.detail.length > 0 ? ` — ${this.detail}` : ''}`).fontSize(13)
      TextInput({ text: this.wsUrl, placeholder: 'wss://host:port/v0/channels' }).onChange((v: string) => { this.wsUrl = v; })
      TextInput({ text: this.apiKey, placeholder: 'apikey（可空）' }).onChange((v: string) => { this.apiKey = v; })
      TextInput({ text: this.user, placeholder: '用户名' }).onChange((v: string) => { this.user = v; })
      TextInput({ text: this.password, placeholder: '密码' }).onChange((v: string) => { this.password = v; })
      Row({ space: 10 }) {
        Button('连接').onClick(() => { const c = this.clientOrNull(); if (c !== null) c.connect(this.wsUrl, this.apiKey); })
        Button('注册').onClick(() => {
          const c = this.clientOrNull();
          if (c === null) return;
          c.register(this.user, this.password).then(() => {
            this.subscribedCount = c.topics().length;
            this.myUid = c.myUid();
          }).catch((error: Object) => this.append(`注册失败：${String(error)}`));
        })
        Button('密码登录').onClick(() => { const c = this.clientOrNull(); if (c !== null) c.login(this.user, this.password); })
        Button('断开').onClick(() => { const c = this.clientOrNull(); if (c !== null) c.disconnect(); this.state = '已断开'; })
      }
      Button('进入会话列表 →').onClick(() => { this.view = 1; })
    }.width('100%').alignItems(HorizontalAlign.Start)
  }

  @Builder
  conversationView() {
    Column({ space: 8 }) {
      Text('2 · 会话列表').fontSize(18).fontWeight(FontWeight.Bold)
      Row({ space: 10 }) {
        Button('刷新').onClick(() => { const c = this.clientOrNull(); if (c !== null) c.refreshConversations(); })
        Button('能力清单').onClick(() => { this.view = 3; })
        Button('← 连接').onClick(() => { this.view = 0; })
      }
      Row({ space: 8 }) {
        TextInput({ text: this.topicInput, placeholder: '打开会话：usrXXXXXX' }).layoutWeight(1)
          .onChange((v: string) => { this.topicInput = v; })
        Button('打开').onClick(() => {
          const c = this.clientOrNull();
          if (c === null || this.topicInput.length === 0) return;
          c.openTopic(this.topicInput);
          this.currentTopic = this.topicInput;
          this.view = 2;
        })
        Button('发给自己').onClick(() => {
          const c = this.clientOrNull();
          if (c === null) return;
          const uid = c.myUid();
          this.myUid = uid;
          if (uid.length === 0) { this.append('还没有 uid：先注册或登录'); return; }
          c.openTopic(uid);
          this.currentTopic = uid;
          this.view = 2;
        })
      }
      Text(this.myUid.length > 0 ? `我的 uid：${this.myUid}` : '').fontSize(11)
      Text(`会话 ${this.conversations.length} 个 · 已登记主题 ${this.subscribedCount} 个`).fontSize(12)
      List({ space: 6 }) {
        ForEach(this.conversations, (item: DemoConversation) => {
          ListItem() {
            Column({ space: 2 }) {
              Row({ space: 6 }) {
                Text(item.name).fontSize(16).fontWeight(FontWeight.Medium)
                if (item.unread > 0) Text(`未读 ${item.unread}`).fontSize(11)
                if (item.online) Text('在线').fontSize(11)
                if (item.lastSeenMs > 0) Text(`最后在线 ${new Date(item.lastSeenMs).toLocaleString()}`).fontSize(10)
              }
              Text(`topic=${item.topic} seq=${item.seq}${item.accessSummary.length > 0 ? ` 权限=${item.accessSummary}` : ''}`).fontSize(11)
            }.width('100%').alignItems(HorizontalAlign.Start)
          }.onClick(() => {
            const c = this.clientOrNull();
            if (c !== null) {
              c.openTopic(item.topic);
              this.currentTopic = item.topic;
              this.subscribedCount = c.topics().length;
              this.view = 2;
            }
          })
        }, (item: DemoConversation) => item.topic)
      }.layoutWeight(1).width('100%')
    }.width('100%').height('100%').alignItems(HorizontalAlign.Start)
  }

  @Builder
  chatView() {
    Column({ space: 8 }) {
      Text(`3 · 聊天 ${this.currentTopic}`).fontSize(18).fontWeight(FontWeight.Bold)
      Row({ space: 8 }) {
        Button('← 列表').onClick(() => { this.view = 1; })
        Button('拉更早').onClick(() => { const c = this.clientOrNull(); if (c !== null && this.messages.length > 0) c.loadHistory(this.currentTopic, this.messages[0].seq, 30); })
        Button('正在输入').onClick(() => { const c = this.clientOrNull(); if (c !== null) c.sendTyping(); })
        Button('全部已读').onClick(() => {
          const c = this.clientOrNull();
          if (c !== null && this.messages.length > 0) c.markRead(this.messages[this.messages.length - 1].seq);
        })
      }
      Row({ space: 8 }) {
        Button('图片').onClick(() => { const c = this.clientOrNull(); if (c !== null) c.sendLocalFile('photo.jpg', 'image/jpeg', 240 * 1024); })
        Button('文件').onClick(() => { const c = this.clientOrNull(); if (c !== null) c.sendLocalFile('report.pdf', 'application/pdf', 3 * 1024 * 1024); })
        Text(this.uploadNote.length > 0 ? `${this.uploadNote}（${this.uploadPercent}%）` : '').fontSize(11)
      }
      List({ space: 4 }) {
        ForEach(this.messages, (item: DemoMessage) => {
          ListItem() {
            Column({ space: 2 }) {
              Row({ space: 4 }) {
                Text(item.isMine ? '我' : '对方').fontSize(11)
                Text(`#${item.seq}`).fontSize(10)
              }
              // 富文本：按 segments 渲染（加粗/斜体/等距）
              Flex({ wrap: FlexWrap.Wrap }) {
                ForEach(item.segments, (segment: DraftySegment, index: number) => {
                  Text(segment.text)
                    .fontSize(15)
                    .fontWeight(segment.styles.indexOf('ST') >= 0 ? FontWeight.Bold : FontWeight.Normal)
                    .fontStyle(segment.styles.indexOf('EM') >= 0 ? FontStyle.Italic : FontStyle.Normal)
                }, (segment: DraftySegment, index: number) => `${item.id}-${index}`)
              }
              if (item.segments.length === 0) Text(item.text).fontSize(15)
              if (item.kind !== 'text') Text(`[${item.kind} 附件] ${item.text}`).fontSize(12)
            }.width('100%').alignItems(HorizontalAlign.Start)
          }.onClick(() => { const c = this.clientOrNull(); if (c !== null) c.markRead(item.seq); })
        }, (item: DemoMessage) => item.id)
      }.layoutWeight(1).width('100%')
      Row({ space: 8 }) {
        TextInput({ text: this.draft, placeholder: '输入消息' }).layoutWeight(1).onChange((v: string) => { this.draft = v; })
        Toggle({ type: ToggleType.Checkbox, isOn: this.bold }).onChange((on: boolean) => { this.bold = on; })
        Text('B').fontWeight(FontWeight.Bold)
        Toggle({ type: ToggleType.Checkbox, isOn: this.italic }).onChange((on: boolean) => { this.italic = on; })
        Text('I').fontStyle(FontStyle.Italic)
        Button('发送').onClick(() => {
          const c = this.clientOrNull();
          if (c === null || this.draft.length === 0) return;
          c.sendText(this.draft, this.bold, this.italic);
          this.draft = '';
        })
      }.width('100%')
    }.width('100%').height('100%').alignItems(HorizontalAlign.Start)
  }

  @Builder
  capabilityView() {
    Column({ space: 8 }) {
      Text('4 · SDK 能力清单').fontSize(18).fontWeight(FontWeight.Bold)
      Button('← 会话列表').onClick(() => { this.view = 1; })
      List({ space: 6 }) {
        ForEach(CAPABILITIES, (row: string[]) => {
          ListItem() {
            Column({ space: 2 }) {
              Text(row[0]).fontSize(14).fontWeight(FontWeight.Medium)
              Text(row[1]).fontSize(11)
              Text(row[2]).fontSize(10)
            }.width('100%').alignItems(HorizontalAlign.Start)
          }
        }, (row: string[]) => row[0])
      }.layoutWeight(1).width('100%')
    }.width('100%').height('100%').alignItems(HorizontalAlign.Start)
  }

  build() {
    Column({ space: 8 }) {
      Text('tinode-harmony 示例').fontSize(20).fontWeight(FontWeight.Bold)
      if (this.view === 0) { this.connectionView() }
      else if (this.view === 1) { this.conversationView() }
      else if (this.view === 2) { this.chatView() }
      else { this.capabilityView() }
      Text(`日志（最近 ${this.logLines.length} 条）`).fontSize(11)
      List({ space: 2 }) {
        ForEach(this.logLines, (line: string, index: number) => {
          ListItem() { Text(line).fontSize(10) }
        }, (line: string, index: number) => `${index}-${line}`)
      }.height(120).width('100%')
    }.width('100%').height('100%').padding(12).alignItems(HorizontalAlign.Start)
  }
}
