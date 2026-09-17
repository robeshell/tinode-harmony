/**
 * tinode-harmony 示例页：填「服务地址 / apikey / token（或选 anonymous）」→ 连接 → 订阅 → 发一条文本。
 *
 * 配置来源：优先用页面输入框（方便试），其次读 `resources/rawfile/im.local.json`（**该文件已 gitignore**，
 * 仓库里只提供 `im.local.json.example` 占位符 —— 不要把自己的服务地址与密钥提交上去）。
 */
import { common } from '@kit.AbilityKit';
import {
  ImCtrl, ImData, ImInfo, ImMeta, ImNote, ImPres, ImSession, ImSessionState, ImWsEndpoint,
  defaultSessionConfig, parseWsEndpoint, setTinodeLogSink
} from '../tinode/Index.ts';
// 平台传输在 `.ets` 出口（纯逻辑出口不带 @kit.* 依赖），见 SDK README「安装」。
import { TinodeSocket } from '../tinode/Socket.ets';
import { loadLocalConfig, LocalTinodeConfig } from '../tinode/LocalConfig';

@Entry
@Component
struct Index {
  @State wsUrl: string = '';
  @State apiKey: string = '';
  @State token: string = '';
  @State topic: string = '';
  @State anonymous: boolean = false;
  @State status: string = '未连接';
  @State log: string[] = [];
  private session: ImSession | null = null;
  private tickTimer: number = -1;

  aboutToAppear(): void {
    setTinodeLogSink({
      detail: (topic: string, message: string) => this.append(`[${topic}] ${message}`),
      failure: (topic: string, error: Object) => this.append(`[${topic}] 失败`)
    });
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    loadLocalConfig(context).then((cfg: LocalTinodeConfig) => {
      this.wsUrl = cfg.wsUrl;
      this.apiKey = cfg.apiKey;
      this.token = cfg.token;
      this.topic = cfg.topic;
      this.anonymous = cfg.scheme === 'anonymous';
      this.append('已读取本地配置（若无则请手填）');
    }).catch(() => {});
  }

  aboutToDisappear(): void {
    this.disconnect();
  }

  private append(line: string): void {
    const next = this.log.slice();
    next.push(line);
    this.log = next.length > 200 ? next.slice(next.length - 200) : next;
  }

  private disconnect(): void {
    if (this.tickTimer >= 0) { clearInterval(this.tickTimer); this.tickTimer = -1; }
    const session = this.session;
    this.session = null;
    if (session !== null) session.stop();
    this.status = '已断开';
  }

  private connect(): void {
    this.disconnect();
    const parsed: ImWsEndpoint | null = parseWsEndpoint(this.wsUrl);
    if (parsed === null) { this.append('服务地址不合法：应形如 wss://host:port/v0/channels'); return; }
    if (this.anonymous !== true && this.token.trim().length === 0) { this.append('token 为空：请填 token，或勾选 anonymous'); return; }
    const transport = new TinodeSocket(parsed.channelUrl, this.apiKey.trim());
    const config = defaultSessionConfig(parsed.channelUrl, this.token.trim(), 'TinodeExample/0.1.0', '');
    config.loginScheme = this.anonymous ? 'anonymous' : 'token';
    // 会话层 hooks：`onData` 是原始 data 报文（门面才有 onMessage 这类已落库回调）。
    const session = new ImSession(transport, config, {
      onState: (state: ImSessionState) => { this.status = state; this.append(`状态 → ${state}`); },
      onServerVersion: (ver: string, build: string) => this.append(`服务端协议版本 ${ver}${build.length > 0 ? ` (${build})` : ''}`),
      onData: (data: ImData) => this.append(`收到 topic=${data.topic} seq=${data.seq}`),
      onCtrl: (ctrl: ImCtrl) => this.append(`ctrl id=${ctrl.id === undefined ? '' : ctrl.id} code=${ctrl.code}`),
      onFailure: (text: string) => this.append(`失败：${text}`),
      onInfo: (info: ImInfo) => {},
      onPres: (pres: ImPres) => {},
      onMeta: (meta: ImMeta) => {},
      onNote: (note: ImNote) => {}
    });
    this.session = session;
    session.start(Date.now());
    this.tickTimer = setInterval(() => session.tick(Date.now()), 200);
    this.append('开始连接…');
  }

  private subscribeAndSend(): void {
    const session = this.session;
    if (session === null || session.state() !== 'ready') { this.append('还没就绪：先等状态变成 ready'); return; }
    if (this.topic.trim().length === 0) { this.append('请先填 topic（形如 usrXXXXXX）'); return; }
    session.subscribe(this.topic.trim(), true, true, 24);
    session.sendPub(this.topic.trim(), null, { txt: 'hello from tinode-harmony example' });
    this.append(`已订阅 ${this.topic.trim()} 并发送一条文本`);
  }

  build() {
    Column({ space: 8 }) {
      Text('tinode-harmony 示例').fontSize(20).fontWeight(FontWeight.Bold)
      Text(`状态：${this.status}`).fontSize(14)
      TextInput({ text: this.wsUrl, placeholder: 'wss://host:port/v0/channels' })
        .onChange((v: string) => { this.wsUrl = v; })
      TextInput({ text: this.apiKey, placeholder: 'apikey（可空）' })
        .onChange((v: string) => { this.apiKey = v; })
      TextInput({ text: this.token, placeholder: '登录 token（anonymous 时留空）' })
        .onChange((v: string) => { this.token = v; })
      TextInput({ text: this.topic, placeholder: 'topic，例如 usrXXXXXX（可空）' })
        .onChange((v: string) => { this.topic = v; })
      Row({ space: 12 }) {
        Toggle({ type: ToggleType.Checkbox, isOn: this.anonymous })
          .onChange((on: boolean) => { this.anonymous = on; })
        Text('anonymous 登录（公开服务自测用）').fontSize(13)
      }
      Row({ space: 12 }) {
        Button('连接').onClick(() => { this.connect(); })
        Button('订阅并发一条').onClick(() => { this.subscribeAndSend(); })
        Button('断开').onClick(() => { this.disconnect(); })
      }
      List({ space: 2 }) {
        ForEach(this.log, (line: string, index: number) => {
          ListItem() { Text(line).fontSize(12) }
        }, (line: string, index: number) => `${index}-${line}`)
      }
      .layoutWeight(1).width('100%')
    }
    .width('100%').height('100%').padding(16).alignItems(HorizontalAlign.Start)
  }
}
