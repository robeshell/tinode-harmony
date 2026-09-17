/**
 * 读取本地 Tinode 配置：`resources/rawfile/im.local.json`。
 *
 * **不要把真实服务地址与密钥提交进仓库**：仓库里只有 `im.local.json.example` 占位符，
 * 真正的 `im.local.json` 在 .gitignore 里；读不到就返回空值，由页面手填。
 */
import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';

export interface LocalTinodeConfig {
  wsUrl: string;
  apiKey: string;
  token: string;
  topic: string;
  scheme: string;
}

const EMPTY: LocalTinodeConfig = { wsUrl: '', apiKey: '', token: '', topic: '', scheme: 'token' };

interface RawConfig {
  wsUrl?: string;
  apiKey?: string;
  token?: string;
  topic?: string;
  scheme?: string;
}

export async function loadLocalConfig(context: common.UIAbilityContext): Promise<LocalTinodeConfig> {
  try {
    const content: Uint8Array = await context.resourceManager.getRawFileContent('im.local.json');
    const text = new util.TextDecoder('utf-8').decodeToString(content);
    const raw = JSON.parse(text) as RawConfig;
    return {
      wsUrl: raw.wsUrl ?? '',
      apiKey: raw.apiKey ?? '',
      token: raw.token ?? '',
      topic: raw.topic ?? '',
      scheme: raw.scheme ?? 'token'
    };
  } catch (error) {
    return EMPTY;
  }
}
