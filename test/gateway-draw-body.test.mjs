// 画图请求体上限：宿主「照着聊天里那张图」会把参考图编成 data URI 塞进 body，
// 原来 8 KB 的通用上限会直接把这种请求打死（实测报「画图后端不可用：请求体过大」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { normalizeConfig } from '../gateway/lib/config.mjs';
import { createApp } from '../gateway/lib/app.mjs';

const TOKEN = 'test-token-body';

/** 假出图后端：把收到的 body 原样留下来，顺便回一张假图。 */
async function fakeDrawBackend() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ created: 1, data: [{ b64_json: Buffer.from('png').toString('base64') }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, bodies, close: () => new Promise((r) => server.close(r)) };
}

async function boot(drawUrl) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'singgw-body-'));
  const config = normalizeConfig({ token: TOKEN, transcode: 'never', maxSeconds: 30, filesTtlHours: 1, dataDir, draw: { url: drawUrl, token: '', timeoutMs: 5000 } });
  const app = createApp({ config, source: { type: 'fake', async search() { return []; } }, voice: { name: 'fake' } });
  const server = http.createServer((req, res) => { void app.handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

const post = (base, body) => fetch(`${base}/v1/images/generations`, {
  method: 'POST',
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

test('带参考图（~2 MB data URI）的画图请求能转发出去，body 原样到后端', async () => {
  const draw = await fakeDrawBackend();
  const { base, close } = await boot(draw.url);
  try {
    const image = 'data:image/jpeg;base64,' + Buffer.alloc(1.5 * 1024 * 1024, 7).toString('base64');
    const r = await post(base, { prompt: '照着这张改成水彩', image });
    assert.equal(r.status, 200);
    assert.equal(draw.bodies.length, 1);
    const forwarded = JSON.parse(draw.bodies[0]);
    assert.equal(forwarded.prompt, '照着这张改成水彩');
    assert.equal(forwarded.image, image, '参考图要原样交给出图服务');
  } finally {
    await close();
    await draw.close();
  }
});

test('请求体超过画图上限时回 413 并说清楚，不冒充后端挂了', async () => {
  const draw = await fakeDrawBackend();
  const { base, close } = await boot(draw.url);
  try {
    const image = 'data:image/png;base64,' + Buffer.alloc(25 * 1024 * 1024, 9).toString('base64');
    const r = await post(base, { prompt: '猫', image });
    assert.equal(r.status, 413);
    const j = await r.json();
    assert.match(j.error.message, /参考图太大/);
    assert.equal(draw.bodies.length, 0, '不该打到出图后端');
  } finally {
    await close();
    await draw.close();
  }
});

test('不带图的小请求依旧走原来那条紧上限（不影响说话/点歌的 8 KB 规则）', async () => {
  const draw = await fakeDrawBackend();
  const { base, close } = await boot(draw.url);
  try {
    const r = await post(base, { prompt: '一只猫' });
    assert.equal(r.status, 200);
    assert.equal(draw.bodies.length, 1);
  } finally {
    await close();
    await draw.close();
  }
});
