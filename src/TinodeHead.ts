/**
 * @otq/tinode-harmony —— Tinode 即时通讯协议的 HarmonyOS 客户端 SDK。
 *
 * 许可：MIT（见同目录 LICENSE）。本实现为**独立 ArkTS 重写**；
 * 协议常量与报文形状参考 Tinode 官方文档与 Apache-2.0 的 `co/tinode/tinodesdk`（见 NOTICE）。
 */

/**
 * 自定义消息的 head（Tinode `MsgClientPub.head` 的 `mime`/`ld_*` 双键，见契约 `im.protocol.json` 的
 * `customHeadMime` 一节）。SDK 只需要「键值对」这一层，不解释业务含义，所以放在 SDK 里；
 * 应用侧 `ImModels.ts` 从本模块重新导出，保证只有一个定义。
 */
export interface ImHead {
  mime?: string;
  ld_mime?: string;
  ld_record_type?: string;
  ld_record_id?: string;
  ld_title?: string;
  ld_duration?: number;
  ld_judgment?: string;
  ld_reply_sender?: string;
  ld_reply_preview?: string;
  ld_duration_ms?: number;
  ld_lat?: number;
  ld_lng?: number;
  ld_address?: string;
  ld_recall_seq?: number;
}
