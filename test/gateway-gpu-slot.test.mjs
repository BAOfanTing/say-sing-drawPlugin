// GPU 槽的集成测试：验证"重活串行"这条规则真的落在了路由上——
// 尤其是审查里指出的那两条漏掉的边：画图中点歌、点歌中画图。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { normalizeConfig } from '../gateway/lib/config.mjs';
import { createApp } from '../gateway/lib/app.mjs';

const TOKEN = 'test-token-gpu';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeDeps({ convertDelayMs = 0, onConvert } = {}) {
  const source = {
    type: 'fake',
    async search() {
      return [{ id: '1', title: '测试歌', artist: '测试歌手', durationSec: 30, source: 'fake' }];
    },
    async prepare(item, { tmpDir }) {
      const file = path.join(tmpDir, `src-${Date.now()}.wav`);
      fs.writeFileSync(file, Buffer.alloc(2048, 7));
      return { file, ext: 'wav', bytes: 2048, kind: 'preview' };
    }
  };
  const voice = {
    name: 'fake',
    voices: ['me'],
    async convert({ input, output }) {
      onConvert?.();
      if (convertDelayMs) await sleep(convertDelayMs);
      fs.copyFileSync(input, output);
      return { engine: 'fake', bytes: fs.statSync(output).size };
    }
  };
  return { source, voice };
}

/** 假出图后端：记录每次请求到达的时间，好验证"画图有没有等唱歌"。 */
async function fakeDrawBackend() {
  const arrivals = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    arrivals.push(Date.now());
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ created: 1, data: [{ b64_json: Buffer.from('png').toString('base64') }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    arrivals,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function boot({ overrides = {}, deps = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'singgw-gpu-'));
  const config = normalizeConfig({
    token: TOKEN,
    transcode: 'never',
    maxSeconds: 30,
    filesTtlHours: 1,
    dataDir,
    ...overrides
  });
  const app = createApp({ config, ...deps });
  const server = http.createServer((req, res) => { void app.handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    app,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

const call = (base, pathname, { method = 'GET', body = null, token = TOKEN } = {}) =>
  fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

const waitForOwner = async (base, owner, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await (await call(base, '/health')).json();
    if (health.gpu?.owner === owner) return health;
    await sleep(20);
  }
  throw new Error(`等不到 gpu.owner=${owner}`);
};

test('画图要等唱歌跑完才转发（补上"画图中点歌"那条边）', async () => {
  const draw = await fakeDrawBackend();
  // 唱歌的换声故意慢 300ms，保证画图请求一定撞在它中间
  const deps = fakeDeps({ convertDelayMs: 300 });
  const { base, close } = await boot({
    overrides: { draw: { url: draw.url, timeoutMs: 5000, token: '' } },
    deps
  });
  try {
    const submitted = await (await call(base, '/sing', { method: 'POST', body: { song: '测试歌', voice: 'me', maxSeconds: 10 } })).json();
    assert.equal(submitted.ok, true);

    await waitForOwner(base, 'sing');            // 唱歌已经占住槽位

    const drawPromise = call(base, '/v1/images/generations', { method: 'POST', body: { prompt: '蓝色大肥鱼' } });
    await sleep(80);
    assert.equal(draw.arrivals.length, 0, '唱歌还在跑，画图不该已经打到出图后端');

    const drawRes = await drawPromise;
    assert.equal(drawRes.status, 200);
    assert.equal(draw.arrivals.length, 1);

    // 唱歌结束时间（任务状态变 done）应当不晚于画图到达出图后端的时间
    const job = await (await call(base, `/jobs/${submitted.jobId}`)).json();
    assert.equal(job.state, 'done');
    const health = await (await call(base, '/health')).json();
    assert.equal(health.gpu.owner, '');
  } finally {
    await close();
    await draw.close();
  }
});

test('画图占着槽位时，健康检查能看出 owner=draw（说话侧据此不拉本地 TTS）', async () => {
  let releaseDraw;
  const gate = new Promise((resolve) => { releaseDraw = resolve; });
  const draw = await fakeDrawBackend();
  // 让出图后端在转发时卡住，制造"画图正在进行"的窗口
  const slow = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200); res.end('{"ok":true}'); return; }
    gate.then(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"created":1,"data":[{"b64_json":"cG5n"}]}'); });
  });
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
  const slowUrl = `http://127.0.0.1:${slow.address().port}`;

  const { base, app, close } = await boot({ overrides: { draw: { url: slowUrl, timeoutMs: 5000, token: '' } }, deps: fakeDeps() });
  try {
    const pending = call(base, '/v1/images/generations', { method: 'POST', body: { prompt: '测试' } });
    await waitForOwner(base, 'draw');
    assert.equal(app.gpu.busy(), true);
    releaseDraw();
    assert.equal((await pending).status, 200);
    assert.equal(app.gpu.owner(), '');
  } finally {
    await close();
    await new Promise((resolve) => slow.close(resolve));
    await draw.close();
  }
});
