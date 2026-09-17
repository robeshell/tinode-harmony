/**
 * tinode-harmony —— Tinode 即时通讯协议的 HarmonyOS 客户端 SDK。
 *
 * 许可：MIT（见同目录 LICENSE）。本实现为**独立 ArkTS 重写**；
 * 协议常量与报文形状参考 Tinode 官方文档与 Apache-2.0 的 `co/tinode/tinodesdk`（见 NOTICE）。
 */

/**
 * 访问模式与权限（P5 余项）——**纯逻辑**，对应官方 Java SDK 的 `Acs` / `AcsHelper` / `Defacs`。
 *
 * Tinode 的权限用一个"字母集合"表示（`AcsHelper:15-22`）：
 *
 * | 字母 | 含义 |
 * | --- | --- |
 * | `J` | 加入（join） |
 * | `R` | 读（read broadcasts） |
 * | `W` | 写（publish） |
 * | `P` | 收在线状态（presence） |
 * | `A` | 审批加入申请（approve） |
 * | `S` | 邀请他人（share） |
 * | `D` | 硬删除消息（delete） |
 * | `O` | 所有者（owner，全权） |
 * | `N` | 无权限（none，显式） |
 *
 * 服务端下发的 `desc.acs = {given, want, mode}`、`desc.defacs = {auth, anon}` 都按这套字母解析；
 * 本文件只做**解析与判定**（把权限下发给谁、如何申请，属于服务端与宿主产品逻辑）。
 */

/** 权限字母（顺序即展示顺序）。 */
export const ACS_ABILITIES: string[] = ['J', 'R', 'W', 'P', 'A', 'S', 'D', 'O'];

/** 人类可读的权限说明（用于调试/设置页展示）。 */
export const ACS_ABILITY_LABELS: string[] = [
  '加入', '读取', '发送', '在线状态', '审批', '邀请', '删除', '所有者'
];

/** 能力字母 → 含义（找不到返回空串）。 */
export function acsAbilityLabel(letter: string): string {
  const index = ACS_ABILITIES.indexOf(letter.toUpperCase());
  return index < 0 ? '' : ACS_ABILITY_LABELS[index];
}

/**
 * 把权限串规范成"只含已知字母、去重、按标准顺序"的形式（`"wr"` → `"RW"`）。
 * 特例：`N`（显式"无权限"）保留为 `'N'`，与空串（未指定）区分开；未知字母丢弃。
 */
export function normalizeAccessMode(mode: string | null | undefined): string {
  if (mode === null || mode === undefined) return '';
  const upper = mode.toUpperCase();
  const letters: string[] = [];
  for (let i = 0; i < ACS_ABILITIES.length; i++) {
    if (upper.indexOf(ACS_ABILITIES[i]) >= 0) letters.push(ACS_ABILITIES[i]);
  }
  if (letters.length === 0 && upper.indexOf('N') >= 0) return 'N';
  return letters.join('');
}

/** 能力字母对应的位（顺序与 `ACS_ABILITIES` 一致，对齐上游 `AcsHelper:15-22` 的 `MODE_*`）。 */
const ACS_MODE_BITS: number[] = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80];

/** 权限串 → 位掩码。非法字母返回 -1；含 `N` 或空串 → 0（"显式无权限"）。 */
function decodeAccessMask(mode: string): number {
  if (mode.length === 0) return -1;
  let mask = 0;
  for (let i = 0; i < mode.length; i++) {
    const letter = mode.charAt(i).toUpperCase();
    if (letter === 'N') return 0;
    const index = ACS_ABILITIES.indexOf(letter);
    if (index < 0) return -1;
    mask |= ACS_MODE_BITS[index];
  }
  return mask;
}

/** 位掩码 → 权限串（0 → `'N'`，与上游 `AcsHelper.encode` 同口径）。 */
function encodeAccessMask(mask: number): string {
  if (mask === 0) return 'N';
  let out = '';
  for (let i = 0; i < ACS_ABILITIES.length; i++) {
    if ((mask & ACS_MODE_BITS[i]) !== 0) out += ACS_ABILITIES[i];
  }
  return out;
}

/**
 * 应用一次权限修改（P7 群成员权限用；对齐上游 `AcsHelper.update:222-260`）：
 *
 * - **整串替换**：`updateAccessMode('RW', 'JSA')` → `'JAS'`（归一化后按标准顺序）；
 * - **增量**：`updateAccessMode('RW', '+P-S')` → `'RWP'`，`'-R'` 去掉读权限；
 * - `'N'` 在增量里是"无操作"（上游 `continue`），在整串里是"显式无权限"；
 * - **非法输入返回 `null`**：未知字母、`'R+W'`（字母写在增量前）、`'+'` 后为空。
 *   调用方据此提示，**不要**把脏值发出去 —— 服务端要的是整串，算错就是改错别人的权限；
 * - 空修改串返回当前权限的整串（无变更也给出可发的值）。
 */
export function updateAccessMode(mode: string | null | undefined,
  change: string | null | undefined): string | null {
  let current = decodeAccessMask(normalizeAccessMode(mode));
  if (current < 0) current = 0;
  const delta = change === null || change === undefined ? '' : change.trim();
  if (delta.length === 0) return encodeAccessMask(current);
  const first = delta.charAt(0);
  if (first !== '+' && first !== '-') {
    const parsed = decodeAccessMask(delta.toUpperCase());
    return parsed < 0 ? null : encodeAccessMask(parsed);
  }
  let mask = current;
  let at = 0;
  while (at < delta.length) {
    const action = delta.charAt(at);
    if (action !== '+' && action !== '-') return null;
    at += 1;
    const start = at;
    while (at < delta.length && delta.charAt(at) !== '+' && delta.charAt(at) !== '-') at += 1;
    const letters = delta.substring(start, at);
    if (letters.length === 0) return null;
    const part = decodeAccessMask(letters.toUpperCase());
    if (part < 0) return null;
    if (part === 0) continue;
    mask = action === '+' ? (mask | part) : (mask & ~part);
  }
  return encodeAccessMask(mask);
}

/** `O`（所有者）隐含全部权限。 */
export function acsIsOwner(mode: string | null | undefined): boolean {
  return normalizeAccessMode(mode).indexOf('O') >= 0;
}

/**
 * 判定某个权限串是否允许某项能力：`acsAllows('JRW', 'W') === true`；
 * `O`（所有者）对任何已定义能力都返回 true；`N`/空串一律 false。
 */
export function acsAllows(mode: string | null | undefined, ability: string): boolean {
  const normalized = normalizeAccessMode(mode);
  if (normalized.length === 0) return false;
  const letter = ability.trim().toUpperCase();
  if (letter.length === 0 || ACS_ABILITIES.indexOf(letter) < 0) return false;
  if (normalized.indexOf('O') >= 0) return true;
  return normalized.indexOf(letter) >= 0;
}

/** 一个 topic 的访问模式（`desc.acs`）。 */
export interface TinodeAcs {
  /** 我实际得到的权限（服务端算好的 `mode`）。 */
  mode: string;
  /** 我请求的权限（`want`）。 */
  want: string;
  /** 服务端授予的权限（`given`）。 */
  given: string;
}

/** 默认权限（`desc.defacs`）：新订阅者/匿名用户默认拿到什么。 */
export interface TinodeDefacs {
  auth: string;
  anon: string;
}

/** 解析服务端下发的 `acs`（对象或缺失都安全）。 */
export function parseAcs(raw: Object | null | undefined): TinodeAcs {
  const empty: TinodeAcs = { mode: '', want: '', given: '' };
  if (raw === null || raw === undefined || typeof raw !== 'object') return empty;
  const record = raw as Record<string, Object>;
  const pick = (key: string): string => {
    const value = record[key];
    return typeof value === 'string' ? normalizeAccessMode(value) : '';
  };
  return { mode: pick('mode'), want: pick('want'), given: pick('given') };
}

/** 解析服务端下发的 `defacs`。 */
export function parseDefacs(raw: Object | null | undefined): TinodeDefacs {
  const empty: TinodeDefacs = { auth: '', anon: '' };
  if (raw === null || raw === undefined || typeof raw !== 'object') return empty;
  const record = raw as Record<string, Object>;
  const pick = (key: string): string => {
    const value = record[key];
    return typeof value === 'string' ? normalizeAccessMode(value) : '';
  };
  return { auth: pick('auth'), anon: pick('anon') };
}

/** 人类可读的权限摘要（例：`JRW` → `加入·读取·发送`；空 → `无权限`）。 */
export function acsSummary(mode: string | null | undefined): string {
  const normalized = normalizeAccessMode(mode);
  if (normalized.length === 0 || normalized === 'N') return '无权限';
  const parts: string[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const label = acsAbilityLabel(normalized[i]);
    parts.push(label.length > 0 ? label : normalized[i]);
  }
  return parts.join('·');
}

/** 能否在会话里发消息（最常用的一条判定；等价于 `acsAllows(mode, 'W')`）。 */
export function acsCanWrite(mode: string | null | undefined): boolean {
  return acsAllows(mode, 'W');
}

/** 能否读该会话（`R` 或所有者）。 */
export function acsCanRead(mode: string | null | undefined): boolean {
  return acsAllows(mode, 'R');
}
