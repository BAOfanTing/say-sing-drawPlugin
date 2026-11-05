import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  joinUrl,
  normalizeGatewayUrl,
  isPrivateHost,
  normalizeSettings,
  normalizeSongName,
  normalizeVoice,
  authHeaders,
  formatDuration
} from '../plugin/sing/lib.mjs';

test('joinUrl 不会产生双斜杠，也不会丢路径', () => {
  assert.equal(joinUrl('https://x.example.com/', '/search'), 'https://x.example.com/search');
  assert.equal(joinUrl('https://x.example.com', 'search'), 'https://x.example.com/search');
  assert.equal(joinUrl('https://x.example.com/', ''), 'https://x.example.com');
  assert.equal(joinUrl('', '/search'), '');
});

test('网关地址：只收 https，http 要显式打开且不能是内网', () => {
  assert.equal(normalizeGatewayUrl('https://sing.example.com/'), 'https://sing.example.com');
  assert.throws(() => normalizeGatewayUrl('http://sing.example.com'), /必须是 https/);
  assert.equal(
    normalizeGatewayUrl('http://sing.example.com', { allowInsecureHttp: true }),
    'http://sing.example.com'
  );
  assert.throws(
    () => normalizeGatewayUrl('http://127.0.0.1:8899', { allowInsecureHttp: true }),
    /内网\/本机地址/
  );
  assert.throws(() => normalizeGatewayUrl(''), /没有配置网关地址/);
  assert.throws(() => normalizeGatewayUrl('不是网址'), /不是合法 URL/);
});

test('内网判定覆盖常见私有段', () => {
  for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.1.5', '172.20.0.1', '169.254.1.1', 'x.local']) {
    assert.equal(isPrivateHost(host), true, host);
  }
  for (const host of ['sing.example.com', '8.8.8.8', '1.2.3.4']) {
    assert.equal(isPrivateHost(host), false, host);
  }
});

test('设置收敛：越界一律夹紧，缺字段退回默认', () => {
  const conf = normalizeSettings({ gatewayUrl: ' https://a.example.com/ ', maxSeconds: 999, pollIntervalMs: 50 });
  assert.equal(conf.gatewayUrl, 'https://a.example.com/');
  assert.equal(conf.pollIntervalMs, 1000);
  assert.equal(conf.allowInsecureHttp, false);

  const empty = normalizeSettings(null);
  assert.equal(empty.maxSeconds, DEFAULTS.maxSeconds);
  assert.equal(empty.gatewayUrl, '');
});

test('歌名/音色清洗会给出人话', () => {
  assert.equal(normalizeSongName('  孤勇者   陈奕迅 '), '孤勇者 陈奕迅');
  assert.throws(() => normalizeSongName('   '), /要唱哪首歌/);
  assert.throws(() => normalizeSongName('歌'.repeat(61)), /歌名太长/);
  assert.equal(normalizeVoice(' me '), 'me');
  assert.equal(normalizeVoice(''), '');
  assert.throws(() => normalizeVoice('音色 一'), /只能用字母/);
});

test('请求头只在有 token 时带 Authorization', () => {
  assert.deepEqual(authHeaders(''), {});
  assert.deepEqual(authHeaders('  '), {});
  assert.deepEqual(authHeaders('abc'), { authorization: 'Bearer abc' });
});



test('时长格式化', () => {
  assert.equal(formatDuration(0), '');
  assert.equal(formatDuration(45), '45 秒');
  assert.equal(formatDuration(63), '1 分 3 秒');
  assert.equal(formatDuration(120), '2 分');
});
