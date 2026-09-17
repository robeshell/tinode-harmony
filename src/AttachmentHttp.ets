/**
 * tinode-harmony —— Tinode 即时通讯协议的 HarmonyOS 客户端 SDK。
 *
 * 许可：MIT（见同目录 LICENSE）。本实现为**独立 ArkTS 重写**；
 * 协议常量与报文形状参考 Tinode 官方文档与 Apache-2.0 的 `co/tinode/tinodesdk`（见 NOTICE）。
 */

/**
 * 附件传输的**平台实现**（HarmonyOS：`@kit.NetworkKit` 的 HTTP）。
 *
 * 这是 P2 的可选模块：只有用到上传/下载的宿主才需要它。核心逻辑（分块、进度、缓存、Drafty 互转）
 * 都在纯逻辑文件 `ImAttachment.ts` 里，本文件只负责"把字节按 HTTP 发出去"。
 *
 * ⚠️ 本文件**未在真机上跑过上传/下载**（宿主 App 目前走自己的后端附件接口）——
 *    使用前请先用 `examples/harmony` 或自己的工程验证一次。
 */
import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import type { AttachmentHttpResult, AttachmentTransferPort, AttachmentUploadRequest } from './ImAttachment.ts';
import { tinodeLogDetail } from './TinodeLog.ts';

export class HarmonyAttachmentHttp implements AttachmentTransferPort {
  /** 上传（multipart，字段名默认 `file`）；`onProgress` 来自 `dataSendProgress`。 */
  async upload(request: AttachmentUploadRequest,
    onProgress?: (loaded: number, total: number) => void): Promise<AttachmentHttpResult> {
    const httpRequest = http.createHttp();
    try {
      if (onProgress !== undefined) {
        httpRequest.on('dataSendProgress', (info: http.DataSendProgressInfo) => {
          onProgress(info.sendSize, info.totalSize);
        });
      }
      const headers: Record<string, string> = { 'Content-Type': 'multipart/form-data' };
      if (request.headers !== undefined) {
        const keys = Object.keys(request.headers);
        for (let i = 0; i < keys.length; i++) headers[keys[i]] = request.headers[keys[i]];
      }
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.POST,
        header: headers,
        extraData: {
          multiFormDataList: [{
            name: request.fieldName === undefined ? 'file' : request.fieldName,
            contentType: request.mime,
            remoteFileName: request.fileName,
            data: request.bytes
          }]
        },
        connectTimeout: 30000,
        readTimeout: 120000
      };
      const response = await httpRequest.request(request.url, options);
      const body = typeof response.result === 'string' ? response.result : '';
      return { status: response.responseCode, body: body };
    } catch (error) {
      tinodeLogDetail('im/attachment', `upload failed: ${String((error as BusinessError).code)}`, 'error');
      return { status: 0, body: '' };
    } finally {
      httpRequest.destroy();
    }
  }

  /** 下载（返回正文；二进制场景请宿主按 base64/落盘要求自行扩展）。 */
  async download(url: string, headers?: Record<string, string>,
    onProgress?: (loaded: number, total: number) => void): Promise<AttachmentHttpResult> {
    const httpRequest = http.createHttp();
    try {
      if (onProgress !== undefined) {
        httpRequest.on('dataReceiveProgress', (info: http.DataReceiveProgressInfo) => {
          onProgress(info.receiveSize, info.totalSize);
        });
      }
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.GET,
        header: headers === undefined ? {} : headers,
        connectTimeout: 30000,
        readTimeout: 120000
      };
      const response = await httpRequest.request(url, options);
      const body = typeof response.result === 'string' ? response.result : '';
      return { status: response.responseCode, body: body };
    } catch (error) {
      tinodeLogDetail('im/attachment', `download failed: ${String((error as BusinessError).code)}`, 'error');
      return { status: 0, body: '' };
    } finally {
      httpRequest.destroy();
    }
  }
}
