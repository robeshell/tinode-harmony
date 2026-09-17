/**
 * 系统 picker 与麦克风录音（demo 用；平台 API 调用集中在这里）。
 *
 * - 图片：`photoAccessHelper.PhotoViewPicker`（系统图库选择器）
 * - 文件：`picker.DocumentViewPicker`（系统文件选择器）
 * - 录音：`@kit.AudioKit` 的 `AudioCapturer`（16 kHz / 单声道 / S16LE），照宿主 App 已真机验证的写法
 *
 * 返回的都是"能被 SDK 附件模块消费"的元数据：`{ uri, name, mime, size }`。
 */
import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';
import { audio } from '@kit.AudioKit';
import { media } from '@kit.MediaKit';
import { wavFromPcm } from '../tinode/Index.ts';
import { fileIo } from '@kit.CoreFileKit';
import { picker } from '@kit.CoreFileKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';

/** 一个本地文件（picker 或录音产物）的元数据。 */
export interface PickedFile {
  uri: string;
  name: string;
  mime: string;
  size: number;
}

/** 录音产物。 */
export interface RecordedVoice {
  bytes: Uint8Array;
  durationMs: number;
  /** 0–100 的简单电平（S16LE RMS），用于画一个简单的电平条。 */
  level: number;
  /** 落盘的 WAV 路径（沙箱内，可直接播放）；写入失败为空串。 */
  wavPath: string;
}

const MIC_PERMISSIONS: Permissions[] = ['ohos.permission.MICROPHONE'];

/** 按扩展名猜 MIME（够 demo 用；生产建议用服务端或文件头判断）。 */
export function mimeOfName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.m4a') || lower.endsWith('.aac')) return 'audio/mp4';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  return 'application/octet-stream';
}

/** 从 uri 里取文件名（`file://…/a.jpg` → `a.jpg`）。 */
export function fileNameOfUri(uri: string): string {
  const cut = uri.split('?')[0];
  const parts = cut.split('/');
  const last = parts.length === 0 ? '' : parts[parts.length - 1];
  return last.length === 0 ? 'file' : decodeURIComponent(last);
}

/** 读本地文件大小（不读内容）。 */
function sizeOfUri(uri: string): number {
  try {
    const file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
    const stat = fileIo.statSync(file.fd);
    fileIo.closeSync(file);
    return stat.size;
  } catch (error) {
    return 0;
  }
}

/** 读本地文件内容（demo 直接读进内存；大文件生产应流式）。 */
export function readUriBytes(uri: string, maxBytes: number): Uint8Array | null {
  try {
    const file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
    const stat = fileIo.statSync(file.fd);
    if (stat.size > maxBytes) {
      fileIo.closeSync(file);
      return null;
    }
    const buffer = new ArrayBuffer(stat.size);
    fileIo.readSync(file.fd, buffer);
    fileIo.closeSync(file);
    return new Uint8Array(buffer);
  } catch (error) {
    return null;
  }
}

/**
 * 把 picker 返回的 URI **复制进应用沙箱**：picker 给的授权是临时的（进程重启/后续读取会失败），
 * 复制到 `cacheDir` 之后既能稳定渲染缩略图，也能作为附件上传的来源。
 */
export function copyIntoCache(context: common.UIAbilityContext, uri: string, name: string): string {
  if (uri.length === 0) return '';
  try {
    const dir = `${context.cacheDir}/picked`;
    if (!fileIo.accessSync(dir)) fileIo.mkdirSync(dir, true);
    const target = `${dir}/${Date.now()}-${name}`;
    const source = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
    const dest = fileIo.openSync(target, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE);
    fileIo.copyFileSync(source.fd, dest.fd);
    fileIo.closeSync(source);
    fileIo.closeSync(dest);
    return target;
  } catch (error) {
    return uri;                     // 复制失败就退回原 URI（可能仍能渲染，也可能失败 → 界面回落文案）
  }
}

/** 选图片（系统图库 picker）；返回的 `uri` 已是**沙箱内**路径，可直接 `Image('file://'+uri)` 渲染。 */
export async function pickImage(context: common.UIAbilityContext): Promise<PickedFile> {
  const options = new photoAccessHelper.PhotoSelectOptions();
  options.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
  options.maxSelectNumber = 1;
  const pickerView = new photoAccessHelper.PhotoViewPicker();
  const result = await pickerView.select(options);
  const source = result.photoUris.length > 0 ? result.photoUris[0] : '';
  const name = fileNameOfUri(source);
  const local = copyIntoCache(context, source, name);
  return { uri: local, name: name, mime: mimeOfName(name), size: sizeOfUri(local) };
}

/** 选文件（系统文件 picker）；同样复制进沙箱，便于后续上传/预览。 */
export async function pickDocument(context: common.UIAbilityContext): Promise<PickedFile> {
  const options = new picker.DocumentSelectOptions();
  options.maxSelectNumber = 1;
  const documentPicker = new picker.DocumentViewPicker();
  const uris = await documentPicker.select(options);
  const source = uris.length > 0 ? uris[0] : '';
  const name = fileNameOfUri(source);
  const local = copyIntoCache(context, source, name);
  return { uri: local, name: name, mime: mimeOfName(name), size: sizeOfUri(local) };
}

/** 申请麦克风权限（首次弹系统框）。 */
export async function ensureMicPermission(context: common.UIAbilityContext): Promise<boolean> {
  try {
    const manager = abilityAccessCtrl.createAtManager();
    const result = await manager.requestPermissionsFromUser(context, MIC_PERMISSIONS);
    const codes = result.authResults;
    return codes.length > 0 && codes[0] === 0;
  } catch (error) {
    return false;
  }
}

/** S16LE PCM 的简单电平（RMS → 0–100）。 */
export function pcmLevel(bytes: Uint8Array): number {
  if (bytes.length < 2) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    let sample = (bytes[i + 1] << 8) | bytes[i];
    if (sample >= 0x8000) sample -= 0x10000;
    sum += sample * sample;
    count += 1;
  }
  if (count === 0) return 0;
  const rms = Math.sqrt(sum / count);
  const ratio = rms / 32768;
  const value = Math.floor(ratio * 300);
  return value > 100 ? 100 : value;
}

/** 录音器（内存累积；页面销毁必须 `release()`）。 */
export class DemoVoiceRecorder {
  /** 录音落盘目录（页面用 `context.cacheDir` 传入）；为空则只留内存。 */
  private cacheDir: string = '';
  private capturer: audio.AudioCapturer | null = null;
  private chunks: Uint8Array[] = [];
  private total: number = 0;
  private startedAt: number = 0;
  private lastLevel: number = 0;

  setCacheDir(dir: string): void {
    this.cacheDir = dir;
  }

  isRecording(): boolean {
    return this.capturer !== null;
  }

  level(): number {
    return this.lastLevel;
  }

  /** 开始录音（调用方先申请权限）。 */
  async start(): Promise<boolean> {
    if (this.capturer !== null) return false;
    try {
      const streamInfo: audio.AudioStreamInfo = {
        samplingRate: audio.AudioSamplingRate.SAMPLE_RATE_16000,
        channels: audio.AudioChannel.CHANNEL_1,
        sampleFormat: audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE,
        encodingType: audio.AudioEncodingType.ENCODING_TYPE_RAW
      };
      const options: audio.AudioCapturerOptions = {
        streamInfo: streamInfo,
        capturerInfo: { source: audio.SourceType.SOURCE_TYPE_MIC, capturerFlags: 0 }
      };
      const capturer = await audio.createAudioCapturer(options);
      this.chunks = [];
      this.total = 0;
      this.lastLevel = 0;
      this.startedAt = Date.now();
      this.capturer = capturer;
      capturer.on('readData', (buffer: ArrayBuffer) => {
        const copy = new Uint8Array(buffer.byteLength);
        copy.set(new Uint8Array(buffer));
        this.chunks.push(copy);
        this.total += copy.length;
        this.lastLevel = pcmLevel(copy);
      });
      await capturer.start();
      return true;
    } catch (error) {
      this.capturer = null;
      return false;
    }
  }

  /** 停止并返回录到的 PCM（太短返回 null）。 */
  async stop(minDurationMs: number = 400): Promise<RecordedVoice | null> {
    const capturer = this.capturer;
    if (capturer === null) return null;
    const duration = Date.now() - this.startedAt;
    try {
      await capturer.stop();
      capturer.release();
    } catch (error) {
      // 停止失败也要把状态清干净
    }
    this.capturer = null;
    if (duration < minDurationMs || this.total === 0) return null;
    const merged = new Uint8Array(this.total);
    let offset = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      merged.set(this.chunks[i], offset);
      offset += this.chunks[i].length;
    }
    // 裸 PCM 播放器不认：包成 WAV 落盘，点气泡时用 AVPlayer 播放
    let wavPath = '';
    if (this.cacheDir.length > 0) {
      try {
        const wav = wavFromPcm(merged, 16000, 1);
        const dir = `${this.cacheDir}/voice`;
        if (!fileIo.accessSync(dir)) fileIo.mkdirSync(dir, true);
        wavPath = `${dir}/voice-${Date.now()}.wav`;
        const file = fileIo.openSync(wavPath, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE);
        fileIo.writeSync(file.fd, wav.buffer as ArrayBuffer);
        fileIo.closeSync(file);
      } catch (error) {
        wavPath = '';
      }
    }
    this.chunks = [];
    return { bytes: merged, durationMs: duration, level: this.lastLevel, wavPath: wavPath };
  }

  /** 取消录音（丢弃内容）。 */
  async cancel(): Promise<void> {
    const capturer = this.capturer;
    this.capturer = null;
    this.chunks = [];
    this.total = 0;
    if (capturer === null) return;
    try {
      await capturer.stop();
      capturer.release();
    } catch (error) {
      // 忽略
    }
  }

  /** 页面销毁时释放（不释放会占着麦克风）。 */
  release(): void {
    const capturer = this.capturer;
    this.capturer = null;
    this.chunks = [];
    if (capturer === null) return;
    try {
      capturer.release();
    } catch (error) {
      // 忽略
    }
  }
}

/**
 * 语音播放（demo 用）：用 `@kit.MediaKit` 的 AVPlayer 播沙箱里的 WAV。
 * 一次只播一条；再次点同一条会停止。
 */
export class DemoVoicePlayer {
  private player: media.AVPlayer | null = null;
  private file: fileIo.File | null = null;
  private playingPath: string = '';

  isPlaying(path: string): boolean {
    return path.length > 0 && this.playingPath === path;
  }

  currentPath(): string {
    return this.playingPath;
  }

  /** 播放；`onDone` 在播完/停止后回调（页面据此复位按钮状态）。 */
  async play(path: string, onDone: () => void): Promise<boolean> {
    if (path.length === 0) return false;
    if (this.playingPath === path) {
      await this.stop();
      onDone();
      return false;
    }
    await this.stop();
    try {
      const player = await media.createAVPlayer();
      this.player = player;
      this.file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY);
      const fd = this.file.fd;
      this.playingPath = path;
      player.on('stateChange', (state: media.AVPlayerState) => {
        if (state === 'initialized') {
          player.prepare();
        } else if (state === 'prepared') {
          player.play();
        } else if (state === 'completed') {
          this.stop().then(() => onDone());
        } else if (state === 'error') {
          this.stop().then(() => onDone());
        }
      });
      player.fdSrc = { fd: fd, offset: 0, length: fileIo.statSync(fd).size };
      return true;
    } catch (error) {
      await this.stop();
      onDone();
      return false;
    }
  }

  /** 停止并释放（页面销毁时也要调用）。 */
  async stop(): Promise<void> {
    const player = this.player;
    const file = this.file;
    this.player = null;
    this.file = null;
    this.playingPath = '';
    if (player !== null) {
      try { player.release(); } catch (error) { /* 忽略 */ }
    }
    if (file !== null) {
      try { fileIo.closeSync(file); } catch (error) { /* 忽略 */ }
    }
  }
}
