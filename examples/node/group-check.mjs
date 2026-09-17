/**
 * 群组端到端自检（P7）：在一个**真实 Tinode 服务**上跑完「建群 → 成员 → 权限 → 移出 → 清理」。
 *
 * 与其它 Node 示例的区别：这里用的是**门面**（`Tinode`），所以同时验证了
 * `createGroup` / `members` / `inviteMember` / `updateGroupDefacs` / `removeMember` / `groupInfo`
 * 这批 P7 接口与真实服务端的报文是否对得上（纯逻辑单测只能证明"形状对"，证明不了"服务端认"）。
 *
 * ## 配置（**不要提交真实地址与密钥**）
 * 优先级：环境变量 > `examples/node/config.local.json`（已 gitignore）。
 *
 * ```bash
 * export TINODE_WS_URL='wss://im.example.com:6061/v0/channels'
 * export TINODE_API_KEY='YOUR_API_KEY'
 * # 群主：脚本自己注册一个一次性账号（只需用户名/密码）
 * export TINODE_NEW_USER="grpcheck$(date +%s)"
 * export TINODE_NEW_PASSWORD='pw123456'
 * # 被邀请的人：一个**已存在**的账号（basic 登录），用来验证邀请/移出
 * export TINODE_PEER_USER='peeraccount'
 * export TINODE_PEER_PASSWORD='peerpassword'
 * node examples/node/group-check.mjs
 * ```
 *
 * 退出码：0 = 全部通过；1 = 有检查失败；2 = 配置缺失。
 * 会创建一个一次性账号与一个群，结束时**把群软删并把被邀请人移出**（账号本身留着，Tinode 无自助删号）。
 */
import { readFileSync } from 'node:fs';
import { MemoryTinodeStorage, Tinode, defaultSessionConfig, encodeBasicSecret, parseWsEndpoint } from '../../src/Index.ts';
import { NodeWebSocketTransport } from './transport.mjs';

function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(readFileSync(new URL('./config.local.json', import.meta.url), 'utf8'));
  } catch (_) {
    // 没有本地配置文件是正常的：全部走环境变量。
  }
  return {
    wsUrl: process.env.TINODE_WS_URL ?? file.wsUrl ?? '',
    apiKey: process.env.TINODE_API_KEY ?? file.apiKey ?? '',
    newUser: process.env.TINODE_NEW_USER ?? file.newUser ?? `grpcheck${Date.now()}`,
    newPassword: process.env.TINODE_NEW_PASSWORD ?? file.newPassword ?? 'pw123456',
    peerUser: process.env.TINODE_PEER_USER ?? file.peerUser ?? file.user ?? '',
    peerPassword: process.env.TINODE_PEER_PASSWORD ?? file.peerPassword ?? file.password ?? ''
  };
}

const cfg = loadConfig();
if (cfg.wsUrl.length === 0) {
  console.error('需要 TINODE_WS_URL（或 config.local.json 的 wsUrl）');
  process.exit(2);
}
if (cfg.peerUser.length === 0 || cfg.peerPassword.length === 0) {
  console.error('需要 TINODE_PEER_USER / TINODE_PEER_PASSWORD（一个已存在账号，用来验证邀请与移出）');
  process.exit(2);
}

const parsed = parseWsEndpoint(cfg.wsUrl);
console.log(`[group-check] 端点：${parsed === null ? '(无法解析)' : `${parsed.tls ? 'wss' : 'ws'}://***:${parsed.port}/v0/channels`}`);
console.log(`[group-check] 群主账号：${cfg.newUser}（本次注册）`);
console.log(`[group-check] 被邀请账号：${cfg.peerUser}（basic 登录）`);

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

/** 等一个条件成立（避免写死 sleep）。 */
function waitUntil(label, predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); return; }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`等待超时：${label}`));
      }
    }, 100);
  });
}

function buildFacade(config, inbox) {
  const transport = new NodeWebSocketTransport(cfg.wsUrl, cfg.apiKey);
  const facade = new Tinode({
    transport,
    config,
    storage: new MemoryTinodeStorage(),
    hooks: {
      onFailure: (text) => console.log(`[group-check] 失败回调：${text}`),
      onState: (state) => console.log(`[group-check] ${config.loginScheme} 状态 → ${state}`),
      onMessage: (message) => { inbox.push(message); }
    }
  });
  facade.start(Date.now());
  return facade;
}

/** 群里某个话题是否已经订阅成功（订阅成功前 pub 会 409）。 */
function subscribedTo(facade, topic) {
  const state = facade.topicState(topic);
  return state !== null && state.subscribed;
}

/** 收件箱里有没有这条群消息（按话题 + 正文）。 */
function hasMessage(inbox, topic, text) {
  return inbox.some((m) => m.topic === topic && m.content !== null && m.content !== undefined && m.content.txt === text);
}

const ownerConfig = defaultSessionConfig(cfg.wsUrl, '', 'tinode-harmony-group-check/0.1.0', '');
ownerConfig.loginScheme = 'none';                       // 走「注册并登录」
const peerConfig = defaultSessionConfig(cfg.wsUrl, encodeBasicSecret(cfg.peerUser, cfg.peerPassword),
  'tinode-harmony-group-check/0.1.0', '');
peerConfig.loginScheme = 'basic';                        // 已存在账号：basic 登录拿 uid

const ownerInbox = [];
const peerInbox = [];
const owner = buildFacade(ownerConfig, ownerInbox);
const peer = buildFacade(peerConfig, peerInbox);
const ticker = setInterval(() => { owner.tick(Date.now()); peer.tick(Date.now()); }, 200);

let groupTopic = '';

async function run() {
  await waitUntil('两个会话都就绪', () => owner.ready() && peer.ready());
  const peerUid = peer.myUid();
  check('对端账号已登录（拿到 uid）', peerUid.startsWith('usr'), `uid=${peerUid}`);

  const auth = await owner.registerAccount(cfg.newUser, cfg.newPassword, '群主');
  check('群主账号注册并登录', auth.uid.startsWith('usr'), `uid=${auth.uid}`);

  // ① 建群：客户端造 new… 占位名，服务端应在应答里改名成 grp…
  const groupName = `自检群 ${new Date().toISOString().slice(0, 19)}`;
  const created = await owner.createGroup(groupName, { defacs: { auth: 'JRWPA', anon: 'N' } });
  groupTopic = created.topic;
  check('createGroup 返回服务端给的真名', created.topic.startsWith('grp'),
    `requested=${created.requestedTopic} → topic=${created.topic} renamed=${created.renamed}`);
  check('建群应答里带我的权限（ctrl.params.acs）', created.mode.length > 0, `mode=${created.mode}`);
  check('建群后登记表里是真名（可重连重订阅）',
    owner.topicState(created.topic) !== null && owner.topicState(created.requestedTopic) === null);

  // ② 成员：先看自己，再邀请对端
  const before = await owner.members(groupTopic);
  check('members 能拿到成员列表', Array.isArray(before), `人数=${before.length}`);

  await owner.inviteMember(groupTopic, peerUid, 'JRWPA');
  const afterInvite = await owner.members(groupTopic);
  const peerRow = afterInvite.find((m) => m.user === peerUid);
  check('inviteMember 后成员列表里出现对端', peerRow !== undefined,
    `人数 ${before.length} → ${afterInvite.length}`);
  check('对端权限是邀请时给的 JRWPA', peerRow !== undefined && peerRow.mode === 'JRWPA',
    peerRow === undefined ? '(没找到对端)' : `mode=${peerRow.mode}`);

  // ③ 群资料与默认权限
  // 注意：**重复发相同的值，Tinode 回 304 Not Modified**（幂等写）。304 不是失败 ——
  // 这条正是用真实服务端才发现的（纯逻辑单测证明不了服务端回什么码）。
  await owner.updateGroupDefacs(groupTopic, 'JRWPA', 'N');
  check('重复发相同默认权限（服务端回 304）不报错', true, '幂等写：304/303 都算"服务端接受了"');

  await owner.updateGroupDefacs(groupTopic, 'JRWPAS', 'N');
  const info = await owner.groupInfo(groupTopic);
  check('groupInfo 解析出群名与权限', info !== null && info.name === groupName,
    info === null ? '(null)' : `name=${info.name} kind=${info.kind}`);
  check('默认权限按请求生效（auth=JRWPAS anon=N）',
    info !== null && info.defacs.auth === 'JRWPAS' && info.defacs.anon === 'N',
    info === null ? '' : `defacs=${JSON.stringify(info.defacs)}`);
  check('groupInfo 里我的权限含所有者标记', info !== null && info.acs.mode.indexOf('O') >= 0,
    info === null ? '' : `mode=${info.acs.mode}`);

  // ④ **群内收发消息**（"群聊"本身：双方订阅同一个群，互发消息都应收到）
  owner.subscribe(groupTopic);
  peer.subscribe(groupTopic);
  await waitUntil('双方都订阅上这个群', () => subscribedTo(owner, groupTopic) && subscribedTo(peer, groupTopic));

  const ownerText = `群主：大家好 ${Date.now()}`;
  owner.publish(groupTopic, { txt: ownerText }, { mime: 'text/x-drafty' });
  await waitUntil('对方收到群主发的消息', () => hasMessage(peerInbox, groupTopic, ownerText));
  check('群主发 → 成员收到（群聊下行）', true, `"${ownerText}"`);

  const peerText = `成员：收到 ${Date.now()}`;
  peer.publish(groupTopic, { txt: peerText }, { mime: 'text/x-drafty' });
  await waitUntil('群主收到成员发的消息', () => hasMessage(ownerInbox, groupTopic, peerText));
  check('成员发 → 群主收到（群聊上行）', true, `"${peerText}"`);

  check('自己的消息也会被服务端回显（同一条只算一次）',
    hasMessage(ownerInbox, groupTopic, ownerText), '服务端 echo：自己发的也会以 data 回来');

  // ⑤ 移出成员
  await owner.removeMember(groupTopic, peerUid);
  const afterRemove = await owner.members(groupTopic);
  check('removeMember 后对端不在成员里',
    afterRemove.find((m) => m.user === peerUid) === undefined,
    `人数 ${afterInvite.length} → ${afterRemove.length}`);

  // ⑥ 清理：软删这个自检群（只对群主隐藏，不删别人的数据）
  owner.deleteTopic(groupTopic);
  check('已请求软删自检群（清理）', true, groupTopic);
}

run().then(() => {
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[group-check] 结果：${checks.length - failed.length}/${checks.length} 项通过`);
  if (failed.length > 0) {
    console.log('[group-check] 未通过：');
    for (const f of failed) console.log(`   - ${f.name}${f.detail === undefined ? '' : ` (${f.detail})`}`);
  }
  clearInterval(ticker);
  owner.stop();
  peer.stop();
  process.exit(failed.length === 0 ? 0 : 1);
}).catch((error) => {
  console.error(`[group-check] 中断：${error instanceof Error ? error.message : String(error)}`);
  clearInterval(ticker);
  owner.stop();
  peer.stop();
  process.exit(1);
});
