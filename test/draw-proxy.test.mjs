// draw-proxy 的单元测试：全部注入（fetch / spawn / gpu 槽），不起真进程、不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDrawProxy } from '../gateway/lib/draw-proxy.mjs';
import { createGpuSlot } from '../gateway/lib/gpu-slot.mjs';

const baseConfig = (overrides = {}) => ({
  dataDir: '.',
  draw: { url: 'http://127.0.0.1:7880', token: '', timeoutMs: 5000, startCommand: '', startTimeoutMs: 1000, ...overrides }
});

test('健康时直接转发，返回状态码与响应体', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, method: init?.method });
    if (String(url).endsWith('/health')) return { ok: true };
    return { status: 200, headers: new Map([['content-type', 'application/json']]), text: async () => '{"data":[]}' };
  };
  const gpu = createGpuSlot();
  const proxy = createDrawProxy({ config: baseConfig(), gpu, fetchFn, now: () => Date.now() });
  const out = await proxy.forward('{"prompt":"x"}');
  assert.equal(out.status, 200);
  assert.equal(out.body, '{"data":[]}');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1, '只该转发一次');
  assert.equal(gpu.owner(), '', '转发结束要释放槽位');
});

test('第一次转发被掐断 → 重试一次，并把 token 带上', async () => {
  let posts = 0;
  const seenAuth = [];
  const fetchFn = async (url, init) => {
    if (String(url).endsWith('/health')) return { ok: true };
    seenAuth.push(init.headers.authorization);
    posts += 1;
    if (posts === 1) throw new Error('fetch failed');
    return { status: 200, headers: new Map(), text: async () => 'ok' };
  };
  const gpu = createGpuSlot();
  const proxy = createDrawProxy({ config: baseConfig({ token: 'tk' }), gpu, fetchFn });
  const out = await proxy.forward('{}');
  assert.equal(out.status, 200);
  assert.equal(posts, 2);
  assert.deepEqual(seenAuth, ['Bearer tk', 'Bearer tk']);
});

test('两次都失败就抛出去（路由层负责变 502，不能让网关崩）', async () => {
  const fetchFn = async (url) => {
    if (String(url).endsWith('/health')) return { ok: true };
    throw new Error('ECONNREFUSED');
  };
  const gpu = createGpuSlot();
  const proxy = createDrawProxy({ config: baseConfig(), gpu, fetchFn });
  await assert.rejects(proxy.forward('{}'), /ECONNREFUSED/);
  assert.equal(gpu.owner(), '');
});

test('没配 draw.url 直接报 E_DRAW_OFF，不碰网络', async () => {
  let touched = false;
  const proxy = createDrawProxy({
    config: { dataDir: '.', draw: { url: '' } },
    gpu: createGpuSlot(),
    fetchFn: async () => { touched = true; }
  });
  await assert.rejects(proxy.forward('{}'), (error) => error.code === 'E_DRAW_OFF');
  assert.equal(touched, false);
});

test('出图服务没起且没配 startCommand → ensure 返回 false（不假装成功）', async () => {
  const proxy = createDrawProxy({
    config: baseConfig({ startCommand: '' }),
    gpu: createGpuSlot(),
    fetchFn: async () => { throw new Error('ECONNREFUSED'); },
    now: () => Date.now()
  });
  assert.equal(await proxy.ensure(), false);
  assert.equal(proxy.status().failures, 1);
});

test('转发期间占着 GPU 槽：别的租户要等（重活串行的边界）', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchFn = async (url) => {
    if (String(url).endsWith('/health')) return { ok: true };
    await gate;
    return { status: 200, headers: new Map(), text: async () => 'ok' };
  };
  const gpu = createGpuSlot();
  const proxy = createDrawProxy({ config: baseConfig(), gpu, fetchFn });
  const drawing = proxy.forward('{}');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(gpu.owner(), 'draw', '转发中应持有槽位');
  let singEntered = false;
  const singing = gpu.run('sing', async () => { singEntered = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(singEntered, false, '画图没结束，唱歌不能进');
  release();
  await drawing;
  await singing;
  assert.equal(gpu.owner(), '');
});
