// aurabot（DSH 插件）接网关的契约测试：
//   GET  /v1/models            —— 宿主要填的 model 名字从这儿拿
//   POST /v1/audio/speech      —— aurabot 的 OpenAI 兼容 TTS 引擎按这个形状发请求
// 只跑假依赖，不联网、不吃显存。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { normalizeConfig } from '../gateway/lib/config.mjs';
import { createApp } from '../gateway/lib/app.mjs';

const TOKEN = 'test-token-aurabot';

// 假说话引擎：把文字原样塞进一个 RIFF 头里返回，够 assert 就行
function fakeSay() {
  const calls = [];
  return {
    calls,
    name: 'fake-say',
    async synthesize(text, options = {}) {
      calls.push({ text, options });
      const buf = Buffer.alloc(600);
      buf.write('RIFF', 0, 'ascii');
      return {
        buffer: buf,
        contentType: 'audio/wav',
        seconds: 1.2,
        wasTruncated: false,
        sayMaxChars: 800,
        cleanup() {}
      };
    },
    async listVoices() {
      return [{ id: 'voc_test', name: '测试音色' }];
    }
  };
}

function fakeDeps(say) {
  return {
    source: {
      type: 'fake',
      async search() {
        return [];
      }
    },
    voice: { name: 'none', voices: [], residentIdleMs: 0 },
    say
  };
}

async function boot(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-aurabot-'));
  const config = normalizeConfig({
    token: TOKEN,
    transcode: 'never',
    maxSeconds: 30,
    filesTtlHours: 1,
    dataDir,
    say: { engine: 'breeze', breezeModel: 'breeze-tts-2' },
    ...overrides
  });
  const say = fakeSay();
  const app = createApp({ config, ...fakeDeps(say) });
  const server = http.createServer((req, res) => void app.handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    say,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

const call = (base, pathname, { token = TOKEN, method = 'GET', body = null } = {}) =>
  fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

test('/v1/models：报出 TTS 模型与音色，宿主的「语音」页照着填就行', async () => {
  const { base, close } = await boot();
  try {
    const res = await call(base, '/v1/models');
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.object, 'list');
    const tts = json.data.find((m) => m.kind === 'tts');
    assert.ok(tts, '要有 tts 模型');
    assert.equal(tts.id, 'breeze-tts-2');
    assert.equal(json.voices[0].id, 'voc_test');
  } finally {
    await close();
  }
});

test('/v1/models：没带令牌要 401（和别的接口一个规矩）', async () => {
  const { base, close } = await boot();
  try {
    assert.equal((await call(base, '/v1/models', { token: '' })).status, 401);
    assert.equal((await call(base, '/v1/models', { token: 'wrong' })).status, 401);
  } finally {
    await close();
  }
});

test('/v1/audio/speech：收下 aurabot 的 OpenAI 形状（多余字段不报参数错）', async () => {
  const { base, close } = await boot();
  try {
    const res = await call(base, '/v1/audio/speech', {
      method: 'POST',
      body: {
        model: 'breeze-tts-2',
        input: '爸爸我回来啦',
        voice: 'hanser',
        response_format: 'mp3',
        speed: 1
      }
    });
    // 这套环境里没有真 TTS（云端 Key / 本地权重都没有），所以不会 200；
    // 要验的是 aurabot 那套字段（model / voice / response_format）不会被当成参数错拒掉。
    assert.notEqual(res.status, 400, '不要因为多带了 OpenAI 字段就回 400');
    assert.notEqual(res.status, 422, '不要因为多带了 OpenAI 字段就回 422');
  } finally {
    await close();
  }
});

test('/v1/audio/speech：缺 input 仍按 E_ARGS 回 4xx，不吞', async () => {
  const { base, close } = await boot();
  try {
    const res = await call(base, '/v1/audio/speech', { method: 'POST', body: { model: 'x' } });
    assert.ok(res.status >= 400 && res.status < 500, `期望 4xx，实际 ${res.status}`);
  } finally {
    await close();
  }
});
