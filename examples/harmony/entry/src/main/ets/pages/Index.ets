/**
 * tinode-harmony 示例 App —— 一个像样的 IM 界面（4 个视图），同时展示 SDK 能力：
 *   0 登录/连接 · 1 会话列表 · 2 聊天 · 3 能力清单
 * 视觉令牌集中在 `demo/DemoTheme.ets`（数值照宿主 App，与 Android 基线一致）。
 */
import { common } from '@kit.AbilityKit';
import { DemoClient, DemoConversation, DemoListener, DemoMessage } from '../demo/DemoClient';
import { DraftySegment } from '../tinode/Index.ts';
import { DemoTheme, avatarColorOf, initialOf } from '../demo/DemoTheme';
import { deliveryMarkOf, durationTextOf, sizeTextOf, timeLabelOf } from '../demo/DemoFormat';
import {
  DemoVoicePlayer, DemoVoiceRecorder, PickedFile, RecordedVoice, ensureMicPermission, pickDocument, pickImage, readUriBytes
} from '../demo/DemoPickers';
import { loadLocalConfig, LocalTinodeConfig } from '../tinode/LocalConfig';

interface CapabilityRow {
  name: string;
  api: string;
  where: string;
  status: string;
}

interface CapabilityGroup {
  title: string;
  rows: CapabilityRow[];
}

/** 表情面板（demo 用的静态表情表；真实产品会从服务端/资源包加载）。 */
const EMOJI_LIST: string[] = [
  '😀', '😄', '😁', '😆', '😅', '😂', '🙂', '😉',
  '😊', '😍', '😘', '😜', '🤔', '😐', '😴', '😭',
  '😡', '👍', '👎', '👌', '🙏', '👏', '💪', '🎉',
  '❤️', '🔥', '⭐', '✅', '❌', '📍', '📄', '🎤'
];

const CAPABILITY_GROUPS: CapabilityGroup[] = [
  {
    title: '连接与生命周期',
    rows: [
      { name: '连接 / hi 握手 / 服务端版本', api: 'ImSession.start · onServerVersion', where: 'TinodeSession.ts', status: '✅' },
      { name: '超时 / 指数退避重连 / 代次守卫', api: 'ImSession.tick（宿主喂时间）', where: 'TinodeSession.ts', status: '✅' },
      { name: '入站帧守卫 / 出站帧上限 / 日志脱敏', api: 'parseServerMessage · maxFrameBytes · redactTopic', where: 'TinodeWire.ts · TinodeLog.ts', status: '✅' }
    ]
  },
  {
    title: '账号与资料',
    rows: [
      { name: '注册 / 改密 / 加凭据 / 改名片', api: 'registerAccount · changePassword · addCredential · updatePublicName', where: 'Tinode.ts', status: '✅' },
      { name: '登录 scheme', api: 'token / basic(base64) / anonymous / none', where: 'TinodeWire.ts', status: '✅' },
      { name: '会话列表与显示名', api: 'profilesFromMeta · mergeProfiles · onTopics', where: 'TinodeMeta.ts', status: '✅' },
      { name: '在线 / 最后在线', api: 'applyPresence · lastSeenMs', where: 'TinodeMeta.ts', status: '✅' },
      { name: '权限模型', api: 'acsAllows · parseAcs · acsSummary', where: 'TinodeAcs.ts', status: '✅' }
    ]
  },
  {
    title: '消息',
    rows: [
      { name: '订阅 / 发布 / 历史分页 / 已读 / 输入中 / 撤回', api: 'subscribe · publish · history · setRead · setTyping · deleteMessages', where: 'Tinode.ts', status: '✅' },
      { name: '主题登记 + 断线自动重订阅', api: 'TinodeTopics · onTopicState', where: 'TinodeTopics.ts', status: '✅' },
      { name: '富文本写侧（加粗/斜体/链接/@/图片）', api: 'draftyWithStyle · draftyLink · draftyMention · draftyImage', where: 'Drafty.ts', status: '✅' },
      { name: '富文本编辑（偏移自动位移）', api: 'draftyInsert · draftyDelete · draftyTrim', where: 'Drafty.ts', status: '✅' },
      { name: '富文本渲染', api: 'draftySegments', where: 'Drafty.ts', status: '✅' }
    ]
  },
  {
    title: '存储与附件',
    rows: [
      { name: '存储端口 + LRU 读缓存', api: 'TinodeStorage · CachedTinodeStorage', where: 'TinodeStorageCache.ts', status: '✅' },
      { name: '去重合并 / 未读 / 摘要 / 淘汰', api: 'mergeMessages · unreadOf · planMessageEviction', where: 'TinodeStore.ts', status: '✅' },
      { name: '附件校验 / 分块 / 进度 / 缓存键', api: 'validateAttachment · planChunks · planEviction', where: 'TinodeAttachment.ts', status: '✅' },
      { name: '附件平台上传', api: 'HarmonyAttachmentHttp', where: 'TinodeAttachmentHttp.ets', status: '⚠️' },
      { name: '系统 picker（图片 / 文件）', api: 'PhotoViewPicker · DocumentViewPicker', where: 'demo/DemoPickers.ets', status: '✅' },
      { name: '麦克风录音（按住说话）', api: 'AudioCapturer · ohos.permission.MICROPHONE', where: 'demo/DemoPickers.ets', status: '✅' }
    ]
  },
  {
    title: '未实现（TODO）',
    rows: [
      { name: '群组 grp', api: '—', where: '—', status: '❌' },
      { name: '推送 set{deviceToken}', api: '—', where: '—', status: '❌' },
      { name: '模糊搜人（关键词）', api: '不在 Tinode WS 协议内', where: '—', status: '❌' }
    ]
  }
];

@Entry
@ComponentV2
struct Index {
  @Local view: number = 0;
  @Local wsUrl: string = '';
  @Local apiKey: string = '';
  @Local user: string = '';
  @Local password: string = '';
  @Local state: string = 'idle';
  @Local detail: string = '';
  @Local busy: boolean = false;
  @Local logLines: string[] = [];
  @Local conversations: DemoConversation[] = [];
  @Local messages: DemoMessage[] = [];
  @Local currentTopic: string = '';
  @Local peerName: string = '';
  @Local peerOnline: boolean = false;
  @Local peerSeen: string = '';
  @Local draft: string = '';
  @Local newTopic: string = '';
  @Local bold: boolean = false;
  @Local italic: boolean = false;
  @Local showAttach: boolean = false;
  @Local showEmoji: boolean = false;
  private listScroller: Scroller = new Scroller();
  @Local voiceMode: boolean = false;
  @Local recording: boolean = false;
  @Local voiceLevel: number = 0;
  @Local uploadNote: string = '';
  @Local uploadPercent: number = 0;
  @Local cacheLine: string = '';
  @Local myUid: string = '';
  private client: DemoClient | null = null;
  @Local playingVoiceId: string = '';
  @Local previewImage: string = '';
  private recorder: DemoVoiceRecorder = new DemoVoiceRecorder();
  private voicePlayer: DemoVoicePlayer = new DemoVoicePlayer();

  aboutToAppear(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.recorder.setCacheDir(context.cacheDir);        // 录音落盘成 WAV，才能点气泡播放
    loadLocalConfig(context).then((cfg: LocalTinodeConfig) => {
      this.wsUrl = cfg.wsUrl;
      this.apiKey = cfg.apiKey;
      this.user = cfg.user.length > 0 ? cfg.user : cfg.token;
      this.password = cfg.password;
      this.newTopic = cfg.topic;                     // 配置里给了会话就直接预填，方便真机一键打开
      this.append('已读取本地配置');
    }).catch(() => {});
    const listener: DemoListener = {
      onState: (state: string, detail: string) => {
        this.state = state;
        if (detail.length > 0) this.detail = detail;
        if (state === 'ready' || state === 'failed' || state === 'closed') this.busy = false;
        const client = this.client;
        if (state === 'ready' && client !== null) {
          const uid = client.myUid();
          if (uid.length > 0) {
            this.myUid = uid;
            if (this.view === 0) this.view = 1;          // 已认证 → 直接进会话列表
            client.refreshConversations();
          }
        }
      },
      onLog: (line: string) => this.append(line),
      onConversations: (list: DemoConversation[]) => { this.conversations = list; },
      onMessages: (list: DemoMessage[]) => { this.messages = list; this.scrollToBottom(); },
      onUploadProgress: (percent: number, note: string) => { this.uploadPercent = percent; this.uploadNote = note; }
    };
    this.client = new DemoClient(listener);
  }

  aboutToDisappear(): void {
    this.voicePlayer.stop();
    this.recorder.release();
    const client = this.client;
    if (client !== null) client.disconnect();
  }

  /** 滚到最新一条（发送/收到/打开会话后调用；用户往上翻历史时不打扰）。 */
  private scrollToBottom(): void {
    setTimeout(() => {
      try {
        this.listScroller.scrollEdge(Edge.Bottom);
      } catch (error) {
        // 列表还没挂载时忽略
      }
    }, 30);
  }

  private append(line: string): void {
    const next = this.logLines.slice();
    next.push(line);
    this.logLines = next.length > 80 ? next.slice(next.length - 80) : next;
  }

  private clientOrNull(): DemoClient | null { return this.client; }

  private statusColor(): string {
    if (this.state === 'ready') return DemoTheme.success;
    if (this.state === 'failed') return DemoTheme.danger;
    if (this.state === 'connecting' || this.state === 'handshake' || this.state === 'login') return DemoTheme.warning;
    return DemoTheme.textHint;
  }

  private statusText(): string {
    if (this.state === 'ready') return this.detail.length > 0 ? `在线 · ${this.detail}` : '在线';
    if (this.state === 'failed') return this.detail.length > 0 ? this.detail : '连接失败';
    if (this.state === 'connecting') return '连接中…';
    if (this.state === 'handshake') return '握手中…';
    if (this.state === 'login') return '登录中…';
    if (this.state === 'closed') return '已断开';
    return '未连接';
  }

  private openConversation(topic: string, name: string, online: boolean, seenMs: number): void {
    const client = this.clientOrNull();
    if (client === null) return;
    client.openTopic(topic);
    this.currentTopic = topic;
    this.peerName = name.length > 0 ? name : topic;
    this.peerOnline = online;
    this.peerSeen = seenMs > 0 ? `最后在线 ${timeLabelOf(seenMs, Date.now())}` : '';
    this.cacheLine = client.cacheLine();
    this.view = 2;
    this.scrollToBottom();
  }

  private pickAndSendImage(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    pickImage(context).then((file: PickedFile) => {
      this.uploadNote = `已选图 ${file.name}（${sizeTextOf(file.size)}）`;
      const client = this.clientOrNull();
      if (client !== null) return client.sendPickedFile(file, readUriBytes(file.uri, 8 * 1024 * 1024));
      return undefined;
    }).catch((error: Object) => { this.uploadNote = `选图失败：${String(error)}`; });
  }

  private pickAndSendDocument(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    pickDocument(context).then((file: PickedFile) => {
      this.uploadNote = `已选文件 ${file.name}（${sizeTextOf(file.size)}）`;
      const client = this.clientOrNull();
      if (client !== null) return client.sendPickedFile(file, readUriBytes(file.uri, 8 * 1024 * 1024));
      return undefined;
    }).catch((error: Object) => { this.uploadNote = `选文件失败：${String(error)}`; });
  }

  private startRecording(): void {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    ensureMicPermission(context).then((granted: boolean) => {
      if (!granted) { this.uploadNote = '没有麦克风权限'; return; }
      this.recorder.start().then((ok: boolean) => {
        this.recording = ok;
        this.uploadNote = ok ? '正在录音…松开发送' : '录音启动失败';
        if (ok) {
          const timer = setInterval(() => {
            if (!this.recording) { clearInterval(timer); return; }
            this.voiceLevel = this.recorder.level();
          }, 120);
        }
      });
    });
  }

  private stopRecording(send: boolean): void {
    if (!this.recording) return;
    this.recording = false;
    const pending = send ? this.recorder.stop() : this.recorder.cancel().then(() => null);
    pending.then((voice: RecordedVoice | null) => {
      this.voiceLevel = 0;
      if (voice === null) { this.uploadNote = send ? '录音太短，已取消' : '已取消录音'; return; }
      this.uploadNote = `语音 ${durationTextOf(voice.durationMs)}`;
      const client = this.clientOrNull();
      if (client !== null) return client.sendVoice(voice);
      return undefined;
    });
  }

  // ── 通用小部件 ─────────────────────────────────────────────────────────────

  @Builder
  avatar(name: string, topic: string, size: number) {
    Stack() {
      Text(initialOf(name, topic))
        .fontSize(size / 2.4)
        .fontColor(Color.White)
        .fontWeight(FontWeight.Medium)
    }
    .width(size).height(size)
    .borderRadius(size / 2)
    .backgroundColor(avatarColorOf(topic))
  }

  @Builder
  statusChip() {
    Row({ space: 6 }) {
      Circle({ width: 8, height: 8 }).fill(this.statusColor())
      Text(this.statusText()).fontSize(12).fontColor(DemoTheme.textSecondary)
    }
    .padding({ left: 10, right: 10, top: 4, bottom: 4 })
    .borderRadius(12)
    .backgroundColor(DemoTheme.surface)
  }

  @Builder
  labeledField(label: string, value: string, placeholder: string, onChange: (text: string) => void) {
    Column({ space: 6 }) {
      Text(label).fontSize(12).fontColor(DemoTheme.textSecondary)
      TextInput({ text: $$value, placeholder: placeholder })
        .height(44)
        .backgroundColor(DemoTheme.fieldFill)
        .borderRadius(8)
        .onChange((text: string) => onChange(text))
    }.width('100%').alignItems(HorizontalAlign.Start)
  }

  // ── 0 · 登录 / 连接 ────────────────────────────────────────────────────────

  @Builder
  loginView() {
    Scroll() {
      Column({ space: 18 }) {
        Column({ space: 10 }) {
          Stack() {
            Text('T').fontSize(30).fontColor(Color.White).fontWeight(FontWeight.Bold)
          }
          .width(72).height(72).borderRadius(20).backgroundColor(DemoTheme.brand)
          Text('tinode-harmony').fontSize(22).fontWeight(FontWeight.Bold).fontColor(DemoTheme.textPrimary)
          Text('Tinode 协议的 HarmonyOS 客户端 SDK 示例').fontSize(13).fontColor(DemoTheme.textHint)
        }.margin({ top: 32 })

        this.statusChip()

        Column({ space: 14 }) {
          Column({ space: 6 }) {
            Text('服务地址').fontSize(12).fontColor(DemoTheme.textSecondary)
            TextInput({ text: $$this.wsUrl, placeholder: 'wss://host:port/v0/channels' })
              .height(44).backgroundColor(DemoTheme.fieldFill).borderRadius(8)
          }.width('100%').alignItems(HorizontalAlign.Start)
          Column({ space: 6 }) {
            Text('apikey（可空）').fontSize(12).fontColor(DemoTheme.textSecondary)
            TextInput({ text: $$this.apiKey, placeholder: 'X-Tinode-APIKey' })
              .height(44).backgroundColor(DemoTheme.fieldFill).borderRadius(8)
          }.width('100%').alignItems(HorizontalAlign.Start)
          Column({ space: 6 }) {
            Text('用户名').fontSize(12).fontColor(DemoTheme.textSecondary)
            TextInput({ text: $$this.user, placeholder: '注册或登录用的账号' })
              .height(44).backgroundColor(DemoTheme.fieldFill).borderRadius(8)
          }.width('100%').alignItems(HorizontalAlign.Start)
          Column({ space: 6 }) {
            Text('密码').fontSize(12).fontColor(DemoTheme.textSecondary)
            TextInput({ text: $$this.password, placeholder: '至少 6 位' })
              .height(44).type(InputType.Password).backgroundColor(DemoTheme.fieldFill).borderRadius(8)
          }.width('100%').alignItems(HorizontalAlign.Start)
        }
        .padding(16)
        .backgroundColor(Color.White)
        .borderRadius(DemoTheme.cardRadius)
        .width('100%')

        Column({ space: 10 }) {
          Button(this.busy ? '处理中…' : '连接')
            .width('100%').height(46).borderRadius(10)
            .backgroundColor(DemoTheme.brand)
            .enabled(!this.busy)
            .onClick(() => {
              const client = this.clientOrNull();
              if (client === null) return;
              this.busy = true;
              client.connect(this.wsUrl, this.apiKey);
            })
          Row({ space: 10 }) {
            Button('注册并登录')
              .layoutWeight(1).height(44).borderRadius(10)
              .backgroundColor(Color.White).fontColor(DemoTheme.brandText)
              .border({ width: 1, color: DemoTheme.brand })
              .onClick(() => {
                const client = this.clientOrNull();
                if (client === null) return;
                this.busy = true;
                client.register(this.user, this.password).then(() => {
                  this.myUid = client.myUid();
                  this.busy = false;
                  client.refreshConversations();
                  this.view = 1;
                }).catch((error: Object) => {
                  this.busy = false;
                  this.append(`注册失败：${String(error)}`);
                });
              })
            Button('密码登录')
              .layoutWeight(1).height(44).borderRadius(10)
              .backgroundColor(Color.White).fontColor(DemoTheme.textPrimary)
              .border({ width: 1, color: DemoTheme.border })
              .onClick(() => {
                const client = this.clientOrNull();
                if (client === null) return;
                client.login(this.user, this.password);
              })
          }.width('100%')
        }.width('100%')

        if (this.logLines.length > 0) {
          Column({ space: 2 }) {
            Text('运行日志').fontSize(12).fontColor(DemoTheme.textSecondary)
            ForEach(this.logLines.slice(Math.max(0, this.logLines.length - 6)), (line: string, index: number) => {
              Text(line).fontSize(10).fontColor(DemoTheme.textHint).width('100%')
            }, (line: string, index: number) => `${index}-${line}`)
          }
          .width('100%').padding(12)
          .backgroundColor(Color.White).borderRadius(DemoTheme.cardRadius)
        }
      }
      .width('100%').padding(DemoTheme.pagePadding)
    }
    .width('100%').height('100%').backgroundColor(DemoTheme.pageBackground)
    .scrollBar(BarState.Off)
  }

  // ── 1 · 会话列表 ───────────────────────────────────────────────────────────

  @Builder
  conversationRow(item: DemoConversation) {
    Row({ space: 12 }) {
      Stack() {
        this.avatar(item.name, item.topic, DemoTheme.avatarSize)
        if (item.online) {
          Circle({ width: 10, height: 10 })
            .fill(DemoTheme.success)
            .border({ width: 2, color: Color.White })
            .offset({ x: 15, y: 15 })
        }
      }.width(DemoTheme.avatarSize).height(DemoTheme.avatarSize)
      Column({ space: 4 }) {
        Row() {
          Text(item.name).fontSize(16).fontWeight(FontWeight.Medium).fontColor(DemoTheme.textPrimary)
            .layoutWeight(1).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(item.timeText).fontSize(11).fontColor(DemoTheme.textHint)
        }.width('100%')
        Row({ space: 8 }) {
          Text(item.preview.length > 0 ? item.preview : '（还没有消息）')
            .fontSize(13).fontColor(DemoTheme.textSecondary)
            .layoutWeight(1).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          if (item.accessSummary.length > 0) {
            Text(item.accessSummary).fontSize(10).fontColor(DemoTheme.textHint).maxLines(1)
          }
          if (item.unread > 0) {
            Text(`${item.unread > 99 ? '99+' : item.unread}`)
              .fontSize(11).fontColor(Color.White)
              .padding({ left: 6, right: 6, top: 1, bottom: 1 })
              .borderRadius(9).backgroundColor(DemoTheme.danger)
          }
        }.width('100%')
      }.layoutWeight(1).alignItems(HorizontalAlign.Start)
    }
    .width('100%').padding({ left: 16, right: 16, top: 12, bottom: 12 })
    .backgroundColor(Color.White)
    .onClick(() => this.openConversation(item.topic, item.name, item.online, item.lastSeenMs))
  }

  @Builder
  conversationView() {
    Column() {
      Row({ space: 10 }) {
        Text('消息').fontSize(20).fontWeight(FontWeight.Bold).layoutWeight(1)
        this.statusChip()
        Text('刷新').fontSize(13).fontColor(DemoTheme.brand).onClick(() => {
          const client = this.clientOrNull();
          if (client !== null) client.refreshConversations();
        })
        Text('能力').fontSize(13).fontColor(DemoTheme.brand).onClick(() => { this.view = 3; })
        Text('退出').fontSize(13).fontColor(DemoTheme.textSecondary).onClick(() => { this.view = 0; })
      }
      .width('100%').height(DemoTheme.appBarHeight).padding({ left: 16, right: 16 })
      .backgroundColor(Color.White)

      Row({ space: 8 }) {
        TextInput({ text: $$this.newTopic, placeholder: '新会话：输入 usrXXXXXX' })
          .layoutWeight(1).height(36).backgroundColor(DemoTheme.fieldFill).borderRadius(18)
        Button('打开').height(36).borderRadius(18).backgroundColor(DemoTheme.brand).fontSize(13)
          .onClick(() => {
            if (this.newTopic.trim().length === 0) return;
            this.openConversation(this.newTopic.trim(), this.newTopic.trim(), false, 0);
          })
        Button('发给自己').height(36).borderRadius(18).fontSize(13)
          .backgroundColor(Color.White).fontColor(DemoTheme.brandText)
          .border({ width: 1, color: DemoTheme.brand })
          .onClick(() => {
            const client = this.clientOrNull();
            if (client === null) return;
            const uid = client.myUid();
            this.myUid = uid;
            if (uid.length === 0) { this.append('还没有 uid：先注册或登录'); return; }
            this.openConversation(uid, '我自己', true, 0);
          })
      }
      .width('100%').padding({ left: 12, right: 12, bottom: 10 }).backgroundColor(Color.White)

      if (this.conversations.length === 0 && this.busy) {
        Column({ space: 10 }) {
          LoadingProgress().width(36).height(36).color(DemoTheme.brand)
          Text('正在加载会话…').fontSize(13).fontColor(DemoTheme.textSecondary)
        }.layoutWeight(1).justifyContent(FlexAlign.Center).width('100%')
      } else if (this.conversations.length === 0) {
        Column({ space: 8 }) {
          Text('💬').fontSize(40)
          Text('还没有会话').fontSize(15).fontColor(DemoTheme.textSecondary)
          Text('新注册的账号没有任何会话：用上面的输入框打开 usrXXXXXX，或点「发给自己」').fontSize(12).fontColor(DemoTheme.textHint)
            .textAlign(TextAlign.Center).padding({ left: 32, right: 32 })
        }.layoutWeight(1).justifyContent(FlexAlign.Center).width('100%')
      } else {
        List() {
          ForEach(this.conversations, (item: DemoConversation) => {
            ListItem() { this.conversationRow(item) }
          }, (item: DemoConversation) => item.topic)
        }
        .layoutWeight(1).width('100%').divider({ strokeWidth: 0.5, color: DemoTheme.divider, startMargin: 68 })
      }

      Row({ space: 8 }) {
        Text(this.myUid.length > 0 ? `我的 uid：${this.myUid}` : '')
          .fontSize(10).fontColor(DemoTheme.textHint).layoutWeight(1)
        if (this.cacheLine.length > 0) {
          Text(this.cacheLine).fontSize(10).fontColor(DemoTheme.textHint)
        }
      }.width('100%').padding({ left: 16, top: 6, bottom: 6 })
    }
    .width('100%').height('100%').backgroundColor(DemoTheme.pageBackground)
  }

  // ── 2 · 聊天 ───────────────────────────────────────────────────────────────

  /** 点气泡：语音播放/停止、图片全屏预览、文件与位置给出可读提示。 */
  private onBubbleTap(item: DemoMessage): void {
    if (item.kind === 'AU') {
      if (item.voicePath.length === 0) {
        this.uploadNote = '对端语音（本示例不接文件服务，只演示本机录制与播放）';
        return;
      }
      const playing = this.voicePlayer.isPlaying(item.voicePath);
      this.playingVoiceId = playing ? '' : item.id;
      this.uploadNote = playing ? '已停止播放' : '正在播放语音…';
      this.voicePlayer.play(item.voicePath, () => { this.playingVoiceId = ''; this.uploadNote = '播放结束'; });
      return;
    }
    if (item.kind === 'IM' || item.kind === 'VD') {
      if (item.imageUri.length > 0) {
        this.previewImage = item.imageUri;
        return;
      }
      this.uploadNote = '对端图片（本示例不接文件服务，只演示本机选图与预览）';
      return;
    }
    if (item.kind === 'LN' && (item.placeLat !== 0 || item.placeLng !== 0)) {
      this.uploadNote = `位置：${item.placeLabel}（${item.placeLat}, ${item.placeLng}）—— 示例不拉地图`;
      return;
    }
    if (item.kind === 'EX') {
      this.uploadNote = `文件：${item.fileName.length > 0 ? item.fileName : item.text}（${sizeTextOf(item.fileSize)}）—— 示例不做打开/下载`;
      return;
    }
    this.uploadNote = '';
  }

  @Builder
  messageContent(item: DemoMessage) {
    Column({ space: 4 }) {
      if (item.kind === 'IM' || item.kind === 'VD') {
        Column({ space: 4 }) {
          if (item.imageUri.length > 0) {
            // 本地沙箱里的图片直接渲染缩略图（picker 选中的图已复制进 cacheDir）
            Image(`file://${item.imageUri}`)
              .width(200)
              .height(item.kind === 'VD' ? 112 : 150)
              .objectFit(ImageFit.Cover)
              .borderRadius(8)
              .alt($r('app.media.app_icon'))
          } else {
            Row({ space: 8 }) {
              Text(item.kind === 'VD' ? '[视频]' : '[图片]').fontSize(13)
                .fontColor(item.isMine ? Color.White : DemoTheme.textPrimary)
              Text('对端图片（本示例不接文件服务）')
                .fontSize(12).fontColor(item.isMine ? '#E6F2FF' : DemoTheme.textHint)
                .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
            }
          }
          if (item.text.length > 0) {
            Text(item.text).fontSize(12).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
              .fontColor(item.isMine ? '#E6F2FF' : DemoTheme.textHint)
          }
        }.alignItems(HorizontalAlign.Start)
      } else if (item.kind === 'EX') {
        Row({ space: 10 }) {
          Text('📄').fontSize(22)
          Column({ space: 2 }) {
            Text(item.fileName.length > 0 ? item.fileName : item.text).fontSize(14).fontWeight(FontWeight.Medium)
              .fontColor(item.isMine ? Color.White : DemoTheme.textPrimary).maxLines(2)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
            Text(sizeTextOf(item.fileSize)).fontSize(11)
              .fontColor(item.isMine ? '#E6F2FF' : DemoTheme.textHint)
          }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        }.width('100%')
      } else if (item.kind === 'AU') {
        Row({ space: 8 }) {
          Text(this.playingVoiceId === item.id ? '⏸' : '▶').fontSize(16)
            .fontColor(item.isMine ? Color.White : DemoTheme.brand)
          Text(durationTextOf(item.durationMs)).fontSize(14)
            .fontColor(item.isMine ? Color.White : DemoTheme.textPrimary)
          if (item.voicePath.length === 0) {
            Text('对端语音（本示例不接文件服务）').fontSize(11)
              .fontColor(item.isMine ? '#E6F2FF' : DemoTheme.textHint)
          }
        }
      } else if (item.kind === 'LN' && (item.placeLat !== 0 || item.placeLng !== 0)) {
        // 位置卡片（照 Android 基线 LocationBubble：上部浅蓝地图区 + 红色定位图标 + 地址与坐标）
        Column({ space: 0 }) {
          Stack() {
            Text('📍').fontSize(24)
          }
          .width('100%').height(80)
          .backgroundColor('#E8F0FE')
          .borderRadius({ topLeft: DemoTheme.bubbleRadius, topRight: DemoTheme.bubbleRadius })
          .alignContent(Alignment.Center)
          Column({ space: 2 }) {
            Text(item.placeLabel.length > 0 ? item.placeLabel : '位置').fontSize(14)
              .fontWeight(FontWeight.Medium)
              .fontColor(item.isMine ? Color.White : DemoTheme.textPrimary)
              .maxLines(2).textOverflow({ overflow: TextOverflow.Ellipsis })
            Text(`${item.placeLat.toFixed(5)}, ${item.placeLng.toFixed(5)}`).fontSize(11)
              .fontColor(item.isMine ? '#E6F2FF' : DemoTheme.textHint)
          }
          .width('100%').padding({ left: 10, right: 10, top: 6, bottom: 8 })
          .alignItems(HorizontalAlign.Start)
        }
        .width(200)
      } else if (item.kind === 'QQ') {
        Column({ space: 4 }) {
          Text('引用').fontSize(10).fontColor(item.isMine ? '#E6F2FF' : DemoTheme.textHint)
          Text(item.text).fontSize(14).fontColor(item.isMine ? Color.White : DemoTheme.textPrimary)
        }.alignItems(HorizontalAlign.Start)
      } else {
        Flex({ wrap: FlexWrap.Wrap }) {
          ForEach(item.segments, (segment: DraftySegment, index: number) => {
            Text(segment.text)
              .fontSize(15)
              .fontColor(item.isMine ? Color.White : DemoTheme.textPrimary)
              .fontWeight(segment.styles.indexOf('ST') >= 0 ? FontWeight.Bold : FontWeight.Normal)
              .fontStyle(segment.styles.indexOf('EM') >= 0 ? FontStyle.Italic : FontStyle.Normal)
              .decoration({ type: segment.styles.indexOf('DL') >= 0 ? TextDecorationType.LineThrough : TextDecorationType.None })
          }, (segment: DraftySegment, index: number) => `${item.id}-${index}`)
        }
      }
    }.alignItems(HorizontalAlign.Start)
  }

  @Builder
  messageRow(item: DemoMessage) {
    Column({ space: 6 }) {
      if (item.showTime) {
        Text(item.timeText).fontSize(11).fontColor(DemoTheme.textHint)
          .width('100%').textAlign(TextAlign.Center).margin({ top: 6, bottom: 2 })
      }
      Row({ space: 8 }) {
        if (!item.isMine) {
          this.avatar(this.peerName, item.topic, 32)
        } else {
          Blank().width(32)
        }
        Column({ space: 2 }) {
          Row() {
            Column() { this.messageContent(item) }
              .padding(item.kind === 'LN' && (item.placeLat !== 0 || item.placeLng !== 0)
                ? 0
                : { left: DemoTheme.bubblePaddingH, right: DemoTheme.bubblePaddingH, top: DemoTheme.bubblePaddingV, bottom: DemoTheme.bubblePaddingV })
              .constraintSize({ maxWidth: DemoTheme.bubbleMaxWidth })
              .backgroundColor(item.isMine ? DemoTheme.bubbleMine : DemoTheme.bubblePeer)
              .borderRadius(DemoTheme.bubbleRadius)
              .border(item.isMine ? { width: 0 } : { width: 0.5, color: DemoTheme.bubbleBorder })
              .onClick(() => this.onBubbleTap(item))
          }
          .width('100%')
          .justifyContent(item.isMine ? FlexAlign.End : FlexAlign.Start)
          .alignItems(VerticalAlign.Top)
          if (item.isMine && item.status.length > 0) {
            Text(deliveryMarkOf(item.status)).fontSize(10)
              .fontColor(item.status === 'failed' ? DemoTheme.danger : DemoTheme.textHint)
              .width('100%').textAlign(TextAlign.End).padding({ right: 4 })
          }
        }.layoutWeight(1)
      }.width('100%').alignItems(VerticalAlign.Top)
    }.width('100%')
  }

  /** 表情面板：点一下插入输入框（demo 静态表情表，真实产品从服务端/资源包取）。 */
  @Builder
  emojiPanel() {
    Column({ space: 10 }) {
      Row() {
        Text('表情').fontSize(15).fontColor(DemoTheme.textSecondary).layoutWeight(1)
        Text('收起').fontSize(13).fontColor(DemoTheme.brand)
          .onClick(() => { this.showEmoji = false; })
      }.width('100%')
      Grid() {
        ForEach(EMOJI_LIST, (emoji: string) => {
          GridItem() {
            Text(emoji).fontSize(26)
          }
          .onClick(() => {
            this.draft = this.draft + emoji;
            this.uploadNote = `已插入 ${emoji}`;
          })
        }, (emoji: string) => emoji)
      }
      .columnsTemplate('1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr')
      .rowsGap(8).columnsGap(8)
      .height(200)
    }
    .width('100%').padding(12).backgroundColor(Color.White)
  }

  @Builder
  attachPanel() {
    Column({ space: 10 }) {
      Row({ space: 10 }) {
        Button('图片').layoutWeight(1).height(40).borderRadius(10)
          .backgroundColor(DemoTheme.fieldFill).fontColor(DemoTheme.textPrimary).fontSize(13)
          .onClick(() => { this.showAttach = false; this.pickAndSendImage(); })
        Button('文件').layoutWeight(1).height(40).borderRadius(10)
          .backgroundColor(DemoTheme.fieldFill).fontColor(DemoTheme.textPrimary).fontSize(13)
          .onClick(() => { this.showAttach = false; this.pickAndSendDocument(); })
        Button('位置').layoutWeight(1).height(40).borderRadius(10)
          .backgroundColor(DemoTheme.fieldFill).fontColor(DemoTheme.textPrimary).fontSize(13)
          .onClick(() => {
            this.showAttach = false;
            const client = this.clientOrNull();
            if (client !== null) client.sendLocation('公司', 31.86, 117.28);
          })
      }.width('100%')
      Row({ space: 10 }) {
        Button('表情面板').layoutWeight(1).height(40).borderRadius(10)
          .backgroundColor(DemoTheme.fieldFill).fontColor(DemoTheme.textPrimary).fontSize(13)
          .onClick(() => { this.showAttach = false; this.showEmoji = true; })
        Button('引用末条').layoutWeight(1).height(40).borderRadius(10)
          .backgroundColor(DemoTheme.fieldFill).fontColor(DemoTheme.textPrimary).fontSize(13)
          .onClick(() => {
            this.showAttach = false;
            const client = this.clientOrNull();
            if (client !== null && this.messages.length > 0) {
              client.sendQuote('收到', this.messages[this.messages.length - 1].seq);
            }
          })
        Button('撤回末条').layoutWeight(1).height(40).borderRadius(10)
          .backgroundColor(DemoTheme.fieldFill).fontColor(DemoTheme.textPrimary).fontSize(13)
          .onClick(() => {
            this.showAttach = false;
            const client = this.clientOrNull();
            if (client !== null && this.messages.length > 0) {
              const last = this.messages[this.messages.length - 1];
              if (last.seq > 0) client.retract(last.seq);
              else this.uploadNote = '本地未落库的消息无法撤回';
            }
          })
      }.width('100%')
      if (this.uploadNote.length > 0) {
        Text(`${this.uploadNote}${this.uploadPercent > 0 && this.uploadPercent < 100 ? `（${this.uploadPercent}%）` : ''}`)
          .fontSize(11).fontColor(DemoTheme.textHint)
      }
    }
    .width('100%').padding(12).backgroundColor(Color.White)
  }

  @Builder
  chatView() {
    Column() {
      Row({ space: 10 }) {
        Text('‹').fontSize(26).fontColor(DemoTheme.textPrimary).onClick(() => { this.view = 1; })
        Column({ space: 2 }) {
          Text(this.peerName.length > 0 ? this.peerName : this.currentTopic).fontSize(16).fontWeight(FontWeight.Medium)
          Text(this.peerOnline ? '在线' : (this.peerSeen.length > 0 ? this.peerSeen : this.currentTopic))
            .fontSize(11).fontColor(this.peerOnline ? DemoTheme.success : DemoTheme.textHint)
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        Text('更早').fontSize(13).fontColor(DemoTheme.brand).onClick(() => {
          const client = this.clientOrNull();
          if (client !== null && this.messages.length > 0) client.loadHistory(this.currentTopic, this.messages[0].seq, 30);
        })
        Text('已读').fontSize(13).fontColor(DemoTheme.brand).onClick(() => {
          const client = this.clientOrNull();
          if (client !== null && this.messages.length > 0) client.markRead(this.messages[this.messages.length - 1].seq);
        })
      }
      .width('100%').height(DemoTheme.appBarHeight).padding({ left: 12, right: 12 })
      .backgroundColor(Color.White).border({ width: { bottom: 0.5 }, color: DemoTheme.divider })

      if (this.messages.length === 0) {
        Column({ space: 6 }) {
          Text('这里还没有消息').fontSize(14).fontColor(DemoTheme.textSecondary)
          Text('发一条试试；也可以点「加号」发图片/文件/位置/表情').fontSize(12).fontColor(DemoTheme.textHint)
        }.layoutWeight(1).justifyContent(FlexAlign.Center).width('100%')
      } else {
        List({ space: 2, scroller: this.listScroller }) {
          ForEach(this.messages, (item: DemoMessage) => {
            ListItem() { this.messageRow(item) }
          }, (item: DemoMessage) => item.id)
        }
        .layoutWeight(1).width('100%').padding({ left: 12, right: 12, top: 8 })
      }

      if (this.showAttach) { this.attachPanel() }
      if (this.showEmoji) { this.emojiPanel() }

      Row({ space: 8 }) {
        Text(this.voiceMode ? '⌨️' : '🎤').fontSize(20)
          .onClick(() => { this.voiceMode = !this.voiceMode; })
        if (this.voiceMode) {
          Text(this.recording ? `松开发送（${this.voiceLevel}%）` : '按住说话')
            .layoutWeight(1).height(40).textAlign(TextAlign.Center)
            .fontSize(14).fontColor(DemoTheme.textPrimary)
            .backgroundColor(this.recording ? DemoTheme.surface : DemoTheme.fieldFill)
            .borderRadius(20)
            .onTouch((event: TouchEvent) => {
              if (event.type === TouchType.Down) this.startRecording();
              else if (event.type === TouchType.Up) this.stopRecording(true);
              else if (event.type === TouchType.Cancel) this.stopRecording(false);
            })
        } else {
          TextInput({ text: $$this.draft, placeholder: '输入消息' })
            .layoutWeight(1).height(40).backgroundColor(DemoTheme.fieldFill).borderRadius(20)
          Text(this.bold ? 'B✓' : 'B').fontSize(15).fontWeight(FontWeight.Bold)
            .fontColor(this.bold ? DemoTheme.brand : DemoTheme.textSecondary)
            .onClick(() => { this.bold = !this.bold; })
          Text('I').fontSize(15).fontStyle(FontStyle.Italic)
            .fontColor(this.italic ? DemoTheme.brand : DemoTheme.textSecondary)
            .onClick(() => { this.italic = !this.italic; })
          Text('😊').fontSize(19)
            .fontColor(this.showEmoji ? DemoTheme.brand : DemoTheme.textSecondary)
            .onClick(() => { this.showEmoji = !this.showEmoji; this.showAttach = false; })
          Text('＋').fontSize(22).fontColor(DemoTheme.textSecondary)
            .onClick(() => { this.showAttach = !this.showAttach; this.showEmoji = false; })
          Button('发送').height(40).borderRadius(20).fontSize(14)
            .backgroundColor(this.draft.length > 0 ? DemoTheme.brand : DemoTheme.border)
            .enabled(this.draft.length > 0)
            .onClick(() => {
              const client = this.clientOrNull();
              if (client === null || this.draft.length === 0) return;
              client.sendText(this.draft, this.bold, this.italic);
              this.draft = '';
            })
        }
      }
      .width('100%').padding({ left: 12, right: 12, top: 8, bottom: 8 })
      .backgroundColor(Color.White).border({ width: { top: 0.5 }, color: DemoTheme.divider })

      if (this.uploadNote.length > 0) {
        Text(`${this.uploadNote}${this.uploadPercent > 0 && this.uploadPercent < 100 ? `（${this.uploadPercent}%）` : ''}`)
          .fontSize(11).fontColor(DemoTheme.textHint)
          .width('100%').padding({ left: 16, right: 16, bottom: 6 })
          .backgroundColor(Color.White)
      }
    }
    .width('100%').height('100%').backgroundColor(DemoTheme.pageBackground)
  }

  // ── 3 · 能力清单 ───────────────────────────────────────────────────────────

  @Builder
  capabilityView() {
    Column() {
      Row({ space: 10 }) {
        Text('‹').fontSize(26).fontColor(DemoTheme.textPrimary).onClick(() => { this.view = 1; })
        Text('SDK 能力清单').fontSize(18).fontWeight(FontWeight.Bold).layoutWeight(1)
      }
      .width('100%').height(DemoTheme.appBarHeight).padding({ left: 12, right: 12 }).backgroundColor(Color.White)

      List({ space: 12 }) {
        ForEach(CAPABILITY_GROUPS, (group: CapabilityGroup) => {
          ListItem() {
            Column({ space: 10 }) {
              Text(group.title).fontSize(14).fontWeight(FontWeight.Bold).fontColor(DemoTheme.textPrimary)
              ForEach(group.rows, (row: CapabilityRow) => {
                Row({ space: 8 }) {
                  Text(row.status).fontSize(13)
                  Column({ space: 2 }) {
                    Text(row.name).fontSize(13).fontColor(DemoTheme.textPrimary)
                    Text(row.api).fontSize(11).fontColor(DemoTheme.textSecondary)
                    Text(row.where).fontSize(10).fontColor(DemoTheme.textHint)
                  }.alignItems(HorizontalAlign.Start).layoutWeight(1)
                }.width('100%')
              }, (row: CapabilityRow) => row.name)
            }
            .width('100%').padding(14).backgroundColor(Color.White).borderRadius(DemoTheme.cardRadius)
          }
        }, (group: CapabilityGroup) => group.title)
      }
      .layoutWeight(1).width('100%').padding(12)
    }
    .width('100%').height('100%').backgroundColor(DemoTheme.pageBackground)
  }

  @Builder
  imagePreview() {
    Stack() {
      Image(`file://${this.previewImage}`)
        .width('100%')
        .objectFit(ImageFit.Contain)
      Row({ space: 10 }) {
        Text('‹').fontSize(26).fontColor(Color.White)
        Text('图片预览').fontSize(16).fontColor(Color.White).layoutWeight(1)
      }
      .width('100%').padding(16)
      .position({ x: 0, y: 0 })
    }
    .width('100%').height('100%')
    .backgroundColor('#E6000000')
    .onClick(() => { this.previewImage = ''; })
  }

  build() {
    Stack() {
      if (this.view === 0) { this.loginView() }
      else if (this.view === 1) { this.conversationView() }
      else if (this.view === 2) { this.chatView() }
      else { this.capabilityView() }
      if (this.previewImage.length > 0) { this.imagePreview() }
    }
    .width('100%').height('100%')
  }
}
