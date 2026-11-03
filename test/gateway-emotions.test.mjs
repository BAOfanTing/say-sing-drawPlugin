// 情绪通道：标记解析（纯函数）+ 端到端（假 say 引擎，不联网）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { normalizeConfig } from '../gateway/lib/config.mjs';
import { createApp } from '../gateway/lib/app.mjs';
import {
  DEFAULT_EMOTIONS, mergeEmotions, resolveEmotionKey, parseEmotionTag, emotionInstruction, emotionList
} from '../gateway/lib/emotions.mjs';

const TOKEN = 'emo-token';

// ── 纯函数 ────────────────────────────────────────────────────────────────
test('parseEmotionTag：认【生气】/ [撒娇] / （凶），并把标记剥掉', () => {
  assert.deepEqual(parseEmotionTag('【生气】你再说一遍试试。'), {
    emotion: 'angry', text: '你再说一遍试试。', tagged: true
  });
  assert.equal(parseEmotionTag('[撒娇] 人家不要嘛').emotion, 'sajiao');
  assert.equal(parseEmotionTag('（凶）走开').emotion, 'angry');
  assert.equal(parseEmotionTag('【angry】go away').emotion, 'angry');     // 大小写不敏感
  assert.equal(parseEmotionTag('【生气：】带冒号').text, '带冒号');
});

test('parseEmotionTag：不是情绪标记的方括号原样保留', () => {
  const text = '【重要】三点开会';
  assert.deepEqual(parseEmotionTag(text), { emotion: '', text, tagged: false });
  assert.equal(parseEmotionTag('【不存在的情绪】文本').tagged, false);
  assert.equal(parseEmotionTag('【生气】').tagged, false);                // 只有标记没有说话内容
  assert.equal(parseEmotionTag('普通文本').tagged, false);
  assert.equal(parseEmotionTag('').tagged, false);
});

test('resolveEmotionKey：中文别名与 id 都能认', () => {
  assert.equal(resolveEmotionKey('生气'), 'angry');
  assert.equal(resolveEmotionKey('凶'), 'angry');
  assert.equal(resolveEmotionKey('开心'), 'happy');
  assert.equal(resolveEmotionKey('sajiao'), 'sajiao');
  assert.equal(resolveEmotionKey('Sajiao'), 'sajiao');
  assert.equal(resolveEmotionKey('胡说八道'), '');
  assert.equal(resolveEmotionKey(''), '');
});

test('宿主 send_voice 的 emotion 枚举都能落到预设上', () => {
  // 宿主工具参数的 enum：neutral/happy/sad/angry/soft/excited/tired/shy/playful/serious
  const expected = {
    neutral: 'neutral', happy: 'happy', sad: 'sad', angry: 'angry',
    soft: 'gentle', excited: 'excited', tired: 'sad', shy: 'sajiao',
    playful: 'excited', serious: 'neutral'
  };
  for (const [asked, want] of Object.entries(expected)) {
    assert.equal(resolveEmotionKey(asked), want, `emotion=${asked}`);
  }
});

test('mergeEmotions：字段级覆盖，false 表示删掉这个情绪', () => {
  const table = mergeEmotions({
    angry: { instructions: '改过的凶' },
    sad: false,
    growl: { label: '低吼', instructions: '低吼', filter: 'volume=1.2' }
  });
  assert.equal(table.angry.label, '生气');            // 没给的字段沿用默认
  assert.equal(table.angry.instructions, '改过的凶');
  assert.ok(table.angry.filter.includes('atempo'));    // 默认滤镜还在
  assert.equal(table.sad, undefined);                  // 删掉了
  assert.equal(table.growl.label, '低吼');             // 新增的
  assert.equal(resolveEmotionKey('低吼', table), '');   // 别名表里没有，但 id 能用
  assert.equal(resolveEmotionKey('growl', table), 'growl');
});

test('emotionInstruction：基础音色描述 + 情绪短句，不重复句号', () => {
  assert.equal(emotionInstruction('清亮柔软的少女音。', { instructions: '语气很凶。' }),
    '清亮柔软的少女音。语气很凶。');
  assert.equal(emotionInstruction('', { instructions: '语气很凶。' }), '语气很凶。');
  assert.equal(emotionInstruction('清亮柔软的少女音。', { instructions: '' }), '清亮柔软的少女音。');
});

test('默认预设自洽：每个都有 label，滤镜只用保音高的手段', () => {
  const list = emotionList(DEFAULT_EMOTIONS);
  assert.ok(list.length >= 8);
  for (const item of list) {
    assert.ok(item.label, `${item.id} 缺 label`);
    assert.ok(!/asetrate|rubberband=pitch=/.test(item.filter), `${item.id} 的滤镜会改音高`);
  }
});

// ── 端到端：假 say 引擎 ───────────────────────────────────────────────────
function fakeSay() {
  const calls = [];
  const wavOf = (seconds = 0.3) => {
    const samples = Math.round(16000 * seconds);
    const buf = Buffer.alloc(44 + samples * 2);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(36 + samples * 2, 4);
    buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii');
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(16000, 24);
    buf.writeUInt32LE(32000, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(samples * 2, 40);
    return buf;
  };
  return {
    name: 'breeze',                                   // 非 none：/v1/audio/speech 才肯读
    calls,
    async convert(args) {
      calls.push(args);
      fs.mkdirSync(path.dirname(args.output), { recursive: true });
      fs.writeFileSync(args.output, wavOf());
      return { file: args.output, bytes: 2048, chars: String(args.text).length, format: 'wav', via: 'cloud' };
    },
    async status() { return { online: true, hasKey: true, hasVoice: true, balance: null, note: '' }; },
    async listVoices() { return []; },
    async balance() { return null; },
    setCredentials() {}
  };
}

const fakeVoice = () => ({ name: 'fake', voices: ['me'], async convert({ input, output }) { fs.copyFileSync(input, output); return {}; } });
const fakeSource = () => ({ type: 'fake', async search() { return []; }, async prepare() { throw new Error('不该用到音源'); } });

async function boot(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emosay-'));
  const config = normalizeConfig({
    token: TOKEN,
    transcode: 'never',
    maxSeconds: 30,
    dataDir,
    say: {
      engine: 'auto',
      enable: true,
      instructions: '清亮柔软、略带奶气的普通话少女音。',
      ...(overrides.say || {})
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'say'))
  });
  const say = fakeSay();
  const app = createApp({ config, source: fakeSource(), voice: fakeVoice(), say });
  const server = http.createServer((req, res) => { void app.handler(req, res); });
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

const speak = (base, body) => fetch(`${base}/v1/audio/speech`, {
  method: 'POST',
  headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

test('/v1/audio/speech：没有情绪标记时行为完全不变', async () => {
  const { base, say, close } = await boot();
  try {
    const response = await speak(base, { input: '今天下午三点开会。' });
    assert.equal(response.status, 200);
    assert.equal(say.calls.length, 1);
    assert.equal(say.calls[0].text, '今天下午三点开会。');
    assert.equal(say.calls[0].instructions, undefined);   // 不覆盖 → 网关用配置里那句
    assert.equal(say.calls[0].boost, undefined);
  } finally { await close(); }
});

test('/v1/audio/speech：【生气】换表演指令 + 开 speaker boost + 剥掉标记', async () => {
  const { base, say, close } = await boot();
  try {
    const response = await speak(base, { input: '【生气】你再说一遍试试。' });
    assert.equal(response.status, 200);
    const call = say.calls.at(-1);
    assert.equal(call.text, '你再说一遍试试。');           // 标记不能念出来
    assert.ok(call.instructions.includes('清亮柔软'), '基础音色描述必须保留');
    assert.ok(call.instructions.includes('训人'), '生气预设的表演指令要传下去');
    assert.equal(call.boost, true);                        // 保音色的关键
  } finally { await close(); }
});

test('/v1/audio/speech：body.emotion 也能指定情绪', async () => {
  const { base, say, close } = await boot();
  try {
    const response = await speak(base, { input: '人家不想去嘛', emotion: '撒娇' });
    assert.equal(response.status, 200);
    const call = say.calls.at(-1);
    assert.equal(call.text, '人家不想去嘛');
    assert.ok(call.instructions.includes('撒娇'));
    assert.equal(call.boost, true);
  } finally { await close(); }
});

test('say.emotionTag=false 时标记不解析（老行为：原样念）', async () => {
  const { base, say, close } = await boot({ say: { emotionTag: false } });
  try {
    const response = await speak(base, { input: '【生气】你再说一遍试试。' });
    assert.equal(response.status, 200);
    const call = say.calls.at(-1);
    assert.equal(call.text, '【生气】你再说一遍试试。');
    assert.equal(call.instructions, undefined);
  } finally { await close(); }
});

test('/say/status 暴露情绪通道状态', async () => {
  const { base, close } = await boot();
  try {
    const response = await fetch(`${base}/say/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.emotionTag, true);
    assert.ok(json.emotions.includes('angry'));
    assert.ok(json.emotions.includes('sajiao'));
  } finally { await close(); }
});
