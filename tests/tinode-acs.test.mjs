import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACS_ABILITIES, acsAbilityLabel, acsAllows, acsCanRead, acsCanWrite, acsIsOwner, acsSummary,
  normalizeAccessMode, parseAcs, parseDefacs
} from '../src/TinodeAcs.ts';

// P5 余项：访问模式与权限（纯逻辑）
test('normalizeAccessMode：只留已知字母、去重、按标准顺序', () => {
  assert.equal(normalizeAccessMode('wr'), 'RW');
  assert.equal(normalizeAccessMode('RWXZ'), 'RW', '未知字母丢弃');
  assert.equal(normalizeAccessMode('oorr'), 'RO', '按标准顺序（R 在 O 前）');
  assert.equal(normalizeAccessMode(''), '');
  assert.equal(normalizeAccessMode(null), '');
  assert.deepEqual(ACS_ABILITIES, ['J', 'R', 'W', 'P', 'A', 'S', 'D', 'O']);
});

test('acsAllows：按字母判定，O 全权，N/空一律 false', () => {
  assert.equal(acsAllows('JRW', 'W'), true);
  assert.equal(acsAllows('JRW', 'D'), false);
  assert.equal(acsAllows('JRW', 'w'), true, '大小写不敏感');
  assert.equal(acsAllows('O', 'D'), true, 'O 隐含全部');
  assert.equal(acsAllows('N', 'R'), false, 'N = 无权限');
  assert.equal(acsAllows('', 'R'), false);
  assert.equal(acsAllows('JRW', 'X'), false, '未知能力 false');
  assert.equal(acsAllows(null, 'R'), false);
  assert.equal(acsIsOwner('o'), true);
  assert.equal(acsCanWrite('RW'), true);
  assert.equal(acsCanWrite('R'), false);
  assert.equal(acsCanRead('R'), true);
});

test('parseAcs / parseDefacs：对象或缺失都安全', () => {
  const acs = parseAcs({ mode: 'rw', want: 'rw', given: 'w' });
  assert.deepEqual(acs, { mode: 'RW', want: 'RW', given: 'W' });
  assert.deepEqual(parseAcs(null), { mode: '', want: '', given: '' });
  assert.deepEqual(parseAcs({ mode: 123 }), { mode: '', want: '', given: '' }, '非字符串忽略');
  assert.deepEqual(parseDefacs({ auth: 'JRWP', anon: 'N' }), { auth: 'JRWP', anon: 'N' }, 'N（显式无权限）保留，与空串区分');
  assert.deepEqual(parseDefacs({ auth: 'JRWP', anon: 'X' }), { auth: 'JRWP', anon: '' }, '未知字母丢弃');
  assert.deepEqual(parseDefacs(undefined), { auth: '', anon: '' });
});

test('acsSummary / acsAbilityLabel：可读文案', () => {
  assert.equal(acsSummary('JRW'), '加入·读取·发送');
  assert.equal(acsSummary(''), '无权限');
  assert.equal(acsSummary('N'), '无权限', '显式无权限文案一致');
  assert.equal(normalizeAccessMode('N'), 'N');
  assert.equal(normalizeAccessMode('n'), 'N');
  assert.equal(acsAllows('N', 'N'), false, 'N 不是能力');
  assert.equal(acsSummary('O'), '所有者');
  assert.equal(acsAbilityLabel('p'), '在线状态');
  assert.equal(acsAbilityLabel('Z'), '');
});

// P3/P5 余项：acc 更新、凭据、getMeta、set desc 的报文形状
test('acc 更新 / 凭据 / getMeta / set desc 报文形状', async () => {
  const { buildAccAddCredential, buildAccUpdate, buildGetMetaDesc, buildGetMetaSub, buildSetPublicDesc,
    encodeBasicSecret, isValidBasicLogin } = await import('../src/TinodeWire.ts');
  // basic secret = base64(user:password)（与 Node 的 Buffer 对拍）
  assert.equal(encodeBasicSecret('alice', 'pw123456'), Buffer.from('alice:pw123456', 'utf8').toString('base64'));
  assert.equal(encodeBasicSecret('张三', 'pw'), Buffer.from('张三:pw', 'utf8').toString('base64'), '中文用户名按 UTF-8 编码');
  assert.equal(encodeBasicSecret('a:b', 'pw'), '', '用户名含冒号 → 空串');
  assert.equal(encodeBasicSecret('', 'pw'), '');
  assert.equal(isValidBasicLogin('alice'), true);
  assert.equal(isValidBasicLogin('a:b'), false);
  assert.equal(isValidBasicLogin('  '), false);
  const update = JSON.parse(buildAccUpdate('7', 'usrAlice', 'basic', 'alice:newPw', '新名字'));
  assert.equal(update.acc.user, 'usrAlice', '更新用 uid，不是 "new"');
  assert.equal(update.acc.login, false);
  assert.equal(update.acc.scheme, 'basic');
  assert.equal(update.acc.secret, 'alice:newPw', 'update 的 secret 由调用方给（低层不改）');
  assert.equal(update.acc.desc.public.fn, '新名字');
  const cred = JSON.parse(buildAccAddCredential('8', 'usrAlice', 'email', 'a@example.com'));
  assert.deepEqual(cred.acc.cred, [{ meth: 'email', val: 'a@example.com' }]);
  assert.equal(cred.acc.secret, '', '只加凭据时不带 secret');
  const desc = JSON.parse(buildGetMetaDesc('9', 'usrBob'));
  assert.deepEqual(desc.get, { id: '9', topic: 'usrBob', what: 'desc' });
  const subs = JSON.parse(buildGetMetaSub('10', 'me', 50));
  assert.equal(subs.get.what, 'sub');
  assert.deepEqual(subs.get.sub, { limit: 50 });
  const setDesc = JSON.parse(buildSetPublicDesc('11', 'usrAlice', '爱丽丝', 'ref/p1'));
  assert.equal(setDesc.set.desc.public.fn, '爱丽丝');
  assert.equal(setDesc.set.desc.public.photo, 'ref/p1');
  assert.deepEqual(JSON.parse(buildSetPublicDesc('12', 'usrAlice', '   ')).set.desc.public, {}, '空名字不带字段');
});
