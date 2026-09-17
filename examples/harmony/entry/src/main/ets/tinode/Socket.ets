/**
 * tinode-harmony —— Tinode 即时通讯协议的 HarmonyOS 客户端 SDK。
 *
 * 许可：MIT（见同目录 LICENSE）。本实现为**独立 ArkTS 重写**；
 * 协议常量与报文形状参考 Tinode 官方文档与 Apache-2.0 的 `co/tinode/tinodesdk`（见 NOTICE）。
 */

/** 平台传输入口（`.ets` 专用；`.ts` 侧请用 `./Index`）。 */
export { TinodeSocket } from './TinodeSocket';
export type { ImTransport, ImTransportHandlers } from './TinodeSession';
