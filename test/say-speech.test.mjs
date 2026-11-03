// say-speech 的单测：直接调 synthesize()，不起 HTTP、不碰真模型。
// 钉住：情绪标记剥离、切句拼装、auto 落本地要占 GPU 槽、失败时清理临时文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSaySpeech } from '../gateway/lib/say-speech.mjs';
import { createGpuSlot } from '../gateway/lib/gpu-slot.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sayspeech-'));

function harness({ engine = 'breeze', split = false, emotionTag = true } = {}) {
  const state = { converts: [], filters: 0, resumes: 0, gpuDuringLocal: null };
  const say = {
    async convert({ text, output, seed, instructions, boost }) {
      state.converts.push({ text, seed, instructions, boost });
      fs.writeFileSync(output, Buffer.alloc(1024, 3));
      return { file: output, bytes: 1024, chars: String(text).length, format: 'wav', via: 'cloud' };
    }
  };
  const gpu = createGpuSlot();
  const speech = createSaySpeech({
    config: {
      say: {
        engine,
        maxChars: 800,
        splitSentences: split,
        maxSegmentChars: 12,
        emotionTag,
        instructions: '清亮柔软',
        emotions: { angry: { label: '生气', instructions: '语气冲一点', boost: true, filter: 'x' } }
      }
    },
    say,
    gpu,
    resumeLocalSay: async () => { state.resumes += 1; state.gpuDuringLocal = gpu.owner(); return true; },
    pitchNormalize: async (file) => file,
    synthesizeInRegister: async (text, output, seed, voiceOptions) => say.convert({ text, output, seed, ...voiceOptions }),
    splitSayText: (text, maxChars) => {
      const parts = String(text).split(/(?<=[。！？])/).map((x) => x.trim()).filter(Boolean);
      return parts.length ? parts : [String(text)];
    },
    concatAudio: async (parts, merged) => { fs.writeFileSync(merged, Buffer.alloc(2048, 4)); return true; },
    probeSeconds: async () => 3,
    applyFilter: async () => { state.filters += 1; return false; },
    parseEmotionTag: (text, table) => {
      const m = /^【(.+?)】([\s\S]*)$/.exec(String(text));
      if (!m) return { emotion: '', text: String(text) };
      const key = Object.keys(table).find((k) => table[k].label === m[1]);
      return key ? { emotion: key, text: m[2] } : { emotion: '', text: String(text) };
    },
    resolveEmotionKey: (key) => (key ? String(key) : ''),
    emotionInstruction: (base, preset) => `${base}｜${preset.instructions}`,
    now: () => Date.now(),
    log: () => {}
  });
  return { speech, state, gpu };
}

test('纯云端：一次合成，返回 buffer / contentType / 时长', async () => {
  const { speech, state } = harness();
  const out = await speech.synthesize('你好呀', { tmpDir: TMP });
  assert.equal(out.contentType, 'audio/wav');
  assert.equal(out.seconds, 3);
  assert.equal(out.buffer.length, 1024);
  assert.equal(state.converts.length, 1);
  out.cleanup();
});

test('情绪标记被剥掉，且带上表演指令与 boost', async () => {
  const { speech, state } = harness();
  const out = await speech.synthesize('【生气】你再说一遍试试。', { tmpDir: TMP });
  assert.equal(state.converts[0].text, '你再说一遍试试。', '标记不该被念出来');
  assert.match(state.converts[0].instructions, /语气冲一点/);
  assert.equal(state.converts[0].boost, true);
  out.cleanup();
});

test('切句：多句逐句合成后拼回一条', async () => {
  const { speech, state } = harness({ split: true });
  const out = await speech.synthesize('第一句。第二句。第三句。', { tmpDir: TMP });
  assert.ok(state.converts.length >= 2, `应该逐句合成，实际 ${state.converts.length}`);
  assert.equal(out.contentType, 'audio/wav');
  out.cleanup();
});

test('breeze-local：合成期间必须占着 GPU 槽', async () => {
  const { speech, state } = harness({ engine: 'breeze-local' });
  const out = await speech.synthesize('你好', { tmpDir: TMP });
  assert.equal(state.resumes, 1, '本地模式要先确保 TTS 在跑');
  assert.equal(state.gpuDuringLocal, 'say', 'resume 时槽位应在 say 手里');
  out.cleanup();
});

test('失败时把临时文件清掉（不留半成品）', async () => {
  const { speech } = harness();
  // 让 convert 抛错
  const broken = createSaySpeech({
    config: { say: { engine: 'breeze', maxChars: 800 } },
    say: { convert: async ({ output }) => { fs.writeFileSync(output, 'x'); throw Object.assign(new Error('boom'), { code: 'E_SAY_NET' }); } },
    gpu: createGpuSlot(),
    resumeLocalSay: async () => false,
    pitchNormalize: async (f) => f,
    synthesizeInRegister: async (text, output) => { fs.writeFileSync(output, 'x'); throw new Error('boom'); },
    splitSayText: (t) => [String(t)],
    concatAudio: async () => true,
    probeSeconds: async () => 0,
    applyFilter: async () => false,
    log: () => {}
  });
  await assert.rejects(broken.synthesize('hi', { tmpDir: TMP }), /读这段话失败/);
  const leftovers = fs.readdirSync(TMP).filter((f) => f.startsWith('say-') && f.endsWith('.wav'));
  assert.equal(leftovers.length, 0, `临时文件应被清掉，实际还剩 ${leftovers.join(',')}`);
  assert.ok(speech);   // 只为让变量被使用
});
