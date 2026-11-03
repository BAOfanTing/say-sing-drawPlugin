// 说话（TTS）：只走 Breeze 云端（https://api.breeze.blue）。
//
// 为什么只留这一个：本机 SAPI 的机械感没法听，Edge 那条路又依赖 edge-tts 环境；
// 而 Breeze TTS 2 是现在开源权重里质量最好的，云端调用不占显存、音色可在插件里选、
// 还能用自然语言指令控制语气。
//
// 接口形状来自官方 openapi.json（ElevenLabs 风格）：
//   POST {baseUrl}/v1/text-to-speech/{voiceId}?output_format=mp3_24000_128&delivery=sync
//   header: xi-api-key
//   body:  { text, model_id, language_code?, instructions?, voice_settings: { guidance_scale } }
//   → 200 audio/*
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE = 'https://api.breeze.blue';

/** Breeze 的一次请求。网络层错误统一翻译成人话。 */
async function breezeFetch(url, { apiKey, method = 'GET', body = null, timeoutMs = 30000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method,
      headers: {
        'xi-api-key': apiKey,
        accept: 'application/json, audio/*',
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal
    });
  } catch (error) {
    const reason = error?.name === 'AbortError'
      ? `超时（${Math.round(timeoutMs / 1000)} 秒）`
      : String(error?.message ?? error);
    throw Object.assign(new Error(`连不上 Breeze：${reason}`), { code: 'E_SAY_NET' });
  } finally {
    clearTimeout(timer);
  }
}

function hintForStatus(status) {
  if (status === 401) return '（API Key 不对或未激活）';
  if (status === 403) return '（这个 Key 没权限用该音色/模型）';
  if (status === 402 || status === 429) return '（额度不足或触到频率限制）';
  if (status === 404) return '（音色 id 不存在）';
  if (status === 503 || status === 504) return '（Breeze 服务端忙/超时）';
  return '';
}

function makeCloudEngine(say) {
  const enabled = true;

  // 运行期可被插件覆盖：插件设置里填 Key / 选音色后推到网关，立即生效并落盘
  const runtime = { apiKey: String(say.breezeKey || ''), voiceId: String(say.voiceId || '') };
  // 备用 Key：主 Key 报额度不足/失效时自动换下一个（多账号白嫖额度的场景）
  const spareKeys = Array.isArray(say.breezeKeys) ? say.breezeKeys.filter(Boolean) : [];
  let keyCursor = -1;
  const baseUrl = String(say.breezeUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const modelId = String(say.breezeModel || 'breeze-tts-2');
  const languageCode = String(say.languageCode || '');
  const instructions = String(say.instructions || '');
  const guidanceScale = Number.isFinite(Number(say.guidanceScale)) ? Number(say.guidanceScale) : 0;
  const outputFormat = String(say.outputFormat || 'mp3_24000_128');
  const maxChars = Math.max(20, Number(say.maxChars) || 800);
  const timeoutMs = Math.max(5000, Number(say.timeoutMs) || 120000);

  let balanceCache = { at: 0, value: null };
  let onlineCache = { at: 0, value: null };   // 连通性检查也缓存，别被插件探针刷爆 Breeze

  const engine = {
    name: enabled ? 'breeze' : 'none',

    /**
     * 插件推上来的 Key / 音色，立即生效。
     * replace=true 时按"完整覆盖"处理：空字符串表示清除（插件设置是唯一真相源）。
     */
    setCredentials({ apiKey, voiceId, replace = false } = {}) {
      if (replace) {
        if (typeof apiKey === 'string') runtime.apiKey = apiKey.trim();
        if (typeof voiceId === 'string') runtime.voiceId = voiceId.trim();
        return;
      }
      if (typeof apiKey === 'string' && apiKey.trim()) runtime.apiKey = apiKey.trim();
      if (typeof voiceId === 'string' && voiceId.trim()) runtime.voiceId = voiceId.trim();
    },
    credentials: () => ({ ...runtime }),

    /**
     * 把文字读成音频，写进 output（扩展名按 content-type 决定）。
     * seed 可逐次覆盖；instructions / boost 可由调用方逐条覆盖（情绪预设用）。
     */
    async convert({ text, output, instructions: overrideInstructions, boost } = {}) {
      if (!enabled) throw Object.assign(new Error('说话功能没开（网关 config.say.engine 不是 breeze）'), { code: 'E_SAY_OFF' });
      if (!runtime.apiKey) throw Object.assign(new Error('还没配 Breeze API Key'), { code: 'E_SAY_NO_KEY' });
      if (!runtime.voiceId) throw Object.assign(new Error('还没选 Breeze 音色'), { code: 'E_SAY_NO_VOICE' });

      const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
      if (!clean) throw Object.assign(new Error('要读的文字是空的'), { code: 'E_SAY_EMPTY' });

      // 逐条覆盖优先；不传就用配置里那句固定的
      const effectiveInstructions = overrideInstructions === undefined
        ? instructions
        : String(overrideInstructions ?? '').trim();

      const url = `${baseUrl}/v1/text-to-speech/${encodeURIComponent(runtime.voiceId)}`
        + `?output_format=${encodeURIComponent(outputFormat)}&delivery=sync`;
      const payload = { text: clean, model_id: modelId };
      if (languageCode) payload.language_code = languageCode;
      if (effectiveInstructions) payload.instructions = effectiveInstructions;
      // boost 与 guidance 互斥：官方写明 guidance_scale > 1 时 use_speaker_boost 会被忽略。
      // 有情绪时我们要的是"贴住 voice_id"，所以走 boost、不再传 guidance。
      if (boost === true) payload.voice_settings = { use_speaker_boost: true };
      else if (guidanceScale > 0) payload.voice_settings = { guidance_scale: guidanceScale };

      const allKeys = [runtime.apiKey, ...spareKeys].filter(Boolean);
      // 轮换顺序：先用当前 key，失败再按列表换下一个（最多把列表走两遍）
      const order = [];
      for (let i = 0; i <= allKeys.length; i += 1) {
        const idx = (Math.max(keyCursor, 0) + i) % allKeys.length;
        if (!order.includes(idx)) order.push(idx);
      }
      let response = null;
      let lastError = null;
      for (const idx of order) {
        const key = allKeys[idx];
        if (!key) continue;
        try {
          response = await breezeFetch(url, { apiKey: key, method: 'POST', body: payload, timeoutMs });
        } catch (error) {
          lastError = error;
          continue;
        }
        if (response.ok) { keyCursor = idx; runtime.apiKey = key; break; }
        let detail = '';
        try { detail = (await response.clone().text()).slice(0, 200); } catch { /* 忽略 */ }
        lastError = Object.assign(
          new Error(`Breeze 返回 ${response.status}${hintForStatus(response.status)}：${detail}`),
          { code: 'E_SAY_HTTP', status: response.status }
        );
        // 只有额度/权限类错误才换 key（400/422 是请求本身的问题，换 key 没用）
        if (![401, 402, 403, 429].includes(response.status)) break;
        if (allKeys.length > 1) console.warn(`[say] Key #${idx + 1} 不可用（${response.status}），换下一个`);
      }
      if (!response || !response.ok) throw lastError || Object.assign(new Error('Breeze 请求失败'), { code: 'E_SAY_HTTP' });

      const type = String(response.headers.get('content-type') || '');
      if (!/^audio\//i.test(type)) {
        const body = await response.text().catch(() => '');
        throw Object.assign(new Error(`Breeze 没返回音频（content-type=${type || '空'}）：${body.slice(0, 160)}`), { code: 'E_SAY_NOT_AUDIO' });
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 1000) throw Object.assign(new Error('Breeze 返回的音频太小'), { code: 'E_SAY_EMPTY_OUTPUT' });
      const ext = type.includes('wav') ? '.wav'
        : type.includes('mpeg') || type.includes('mp3') ? '.mp3'
          : type.includes('ogg') || type.includes('opus') ? '.opus' : '.bin';
      const target = String(output).replace(/\.[^./\\]+$/, '') + ext;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buffer);
      return { file: target, bytes: buffer.length, chars: clean.length, format: ext.slice(1), via: 'cloud' };
    },

    /** 拉音色列表（插件选音色用）。 */
    async listVoices() {
      if (!runtime.apiKey) throw Object.assign(new Error('还没配 Breeze API Key'), { code: 'E_SAY_NO_KEY' });
      const response = await breezeFetch(`${baseUrl}/v1/voices`, { apiKey: runtime.apiKey, timeoutMs: 30000 });
      if (!response.ok) {
        let detail = '';
        try { detail = (await response.text()).slice(0, 200); } catch { /* 忽略 */ }
        throw Object.assign(new Error(`拉音色失败 ${response.status}${hintForStatus(response.status)}：${detail}`), { code: 'E_SAY_HTTP' });
      }
      const data = await response.json().catch(() => ({}));
      const list = Array.isArray(data?.voices) ? data.voices : Array.isArray(data) ? data : [];
      return list
        .map((v) => ({
          id: String(v?.voice_id ?? ''),
          name: String(v?.name ?? ''),
          category: v?.category ? String(v.category) : '',
          labels: v?.labels && typeof v.labels === 'object' ? v.labels : {}
        }))
        .filter((v) => v.id);
    },

    /** 余额（60 秒缓存：状态刷新很频繁，别每次都打 Breeze）。 */
    async balance({ fresh = false } = {}) {
      if (!runtime.apiKey) return null;
      if (!fresh && balanceCache.value !== null && Date.now() - balanceCache.at < 60000) return balanceCache.value;
      try {
        const response = await breezeFetch(`${baseUrl}/v1/balance`, { apiKey: runtime.apiKey, timeoutMs: 20000 });
        if (!response.ok) return null;
        const data = await response.json().catch(() => null);
        const value = Number(data?.balance);
        balanceCache = { at: Date.now(), value: Number.isFinite(value) ? value : null };
        return balanceCache.value;
      } catch {
        return null;
      }
    },

    /** 在线状态：插件页「后端在线」用的就是它。 */
    async status({ fresh = false } = {}) {
      const hasKey = Boolean(runtime.apiKey);
      const hasVoice = Boolean(runtime.voiceId);
      const base = { engine: enabled ? 'breeze' : 'none', hasKey, hasVoice, voiceId: runtime.voiceId, model: modelId };
      if (!enabled) return { ...base, online: false, note: '网关没开说话功能（say.engine ≠ breeze）' };
      if (!hasKey) return { ...base, online: false, note: '还没填 Breeze API Key' };
      try {
        let online = onlineCache.value;
        // 把状态码一起缓存：否则缓存里只存了 false，命中缓存时会跳过 fetch、
        // 直接走到下面那句 return online: true —— 判活就会在"离线/在线"之间横跳。
        let status = onlineCache.status;
        if (online === null || fresh || Date.now() - onlineCache.at > 60000) {
          const response = await breezeFetch(`${baseUrl}/v1/models`, { apiKey: runtime.apiKey, timeoutMs: 15000 });
          online = response.ok;
          status = response.status;
          onlineCache = { at: Date.now(), value: online, status };
        }
        // 离线判断必须在缓存分支之外：命中缓存时也要走这里
        if (!online) {
          return { ...base, online: false, balance: null, note: `Breeze 返回 ${status ?? ''}${hintForStatus(status)}`.trim() };
        }
        const balance = await engine.balance({ fresh });
        return { ...base, online: true, balance, note: hasVoice ? '' : '还没选音色' };
      } catch (error) {
        return { ...base, online: false, balance: null, note: String(error?.message ?? error).slice(0, 160) };
      }
    }
  };

  return engine;
}

/** 24kHz 单声道 s16le 的裸 PCM 加个 WAV 头（不用 ffmpeg）。 */
function pcmToWav(pcm, sampleRate = 24000, channels = 1) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);                       // fmt 块长度
  header.writeUInt16LE(1, 20);                        // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  header.writeUInt16LE(channels * 2, 32);             // block align
  header.writeUInt16LE(16, 34);                       // 位深
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * 本地 Breeze（breeze_infer.api，multipart + 裸 PCM 流）。
 * 说话用不到"自定义音色 id"，而是「参考音频 + 文稿」（克隆）或纯「语气描述」（Voice Design）。
 */
function makeLocalEngine(say) {
  const base = String(say.localUrl || 'http://127.0.0.1:7860').replace(/\/+$/, '');
  const refAudio = String(say.refAudio || '').trim();
  const refText = String(say.refText || '').trim();
  const instruction = String(say.instructions || '').trim();
  const cfgScale = Number.isFinite(Number(say.cfgScale)) ? Number(say.cfgScale) : 0;
  const sampleRate = Number(say.localSampleRate) > 0 ? Number(say.localSampleRate) : 24000;
  const seed = Number.isFinite(Number(say.seed)) ? Number(say.seed) : 42;
  const maxChars = Math.max(20, Number(say.maxChars) || 800);
  const timeoutMs = Math.max(10000, Number(say.localTimeoutMs) || 180000);

  return {
    name: 'breeze-local',
    async convert({ text, output, seed: seedOverride, instructions: overrideInstructions }) {
      const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
      if (!clean) throw Object.assign(new Error('要读的文字是空的'), { code: 'E_SAY_EMPTY' });
      if (refAudio && !fs.existsSync(refAudio)) {
        throw Object.assign(new Error(`参考音频不存在：${refAudio}`), { code: 'E_SAY_NO_REF' });
      }

      // 情绪预设可以逐条覆盖「语气描述」；不传就用配置里那句
      const effectiveInstruction = overrideInstructions === undefined
        ? instruction
        : String(overrideInstructions ?? '').trim();

      // 参考克隆模板没有 negative prompt，带 cfg_scale>1 会 500
      // （ValueError: Template 'ref_clone_tata' does not define a negative prompt but cfg_scale=4.0）；
      // 只有"参考 + instruction"（Voice Direction）才允许 CFG。
      let effectiveCfg = cfgScale;
      if (refAudio && !effectiveInstruction && effectiveCfg > 1) effectiveCfg = 1;

      const form = new FormData();
      form.set('text', clean);
      if (effectiveInstruction) form.set('instruction', effectiveInstruction);
      if (effectiveCfg > 0) form.set('cfg_scale', String(effectiveCfg));
      form.set('seed', String(Number.isFinite(Number(seedOverride)) ? Number(seedOverride) : seed));
      if (refAudio) {
        const bytes = fs.readFileSync(refAudio);
        form.set('ref_audio', new Blob([bytes]), path.basename(refAudio));
        form.set('ref_text', refText);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetch(`${base}/v1/audio/speech`, { method: 'POST', body: form, signal: controller.signal });
      } catch (error) {
        const reason = error?.name === 'AbortError'
          ? `超时（${Math.round(timeoutMs / 1000)} 秒）`
          : String(error?.message ?? error);
        throw Object.assign(new Error(`连不上本地 Breeze（${base}）：${reason}`), { code: 'E_SAY_LOCAL_DOWN' });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        let detail = '';
        try { detail = (await response.text()).slice(0, 240); } catch { /* 忽略 */ }
        const hint = response.status === 503 ? '（模型还在加载）'
          : response.status === 409 ? '（上一次还在合成）' : '';
        throw Object.assign(new Error(`本地 Breeze 返回 ${response.status}${hint}：${detail}`), { code: 'E_SAY_LOCAL_HTTP' });
      }

      const raw = Buffer.from(await response.arrayBuffer());
      if (raw.length < 1000) throw Object.assign(new Error('本地 Breeze 返回的音频太小'), { code: 'E_SAY_EMPTY_OUTPUT' });
      // 服务端有时直接给 WAV，有时给裸 PCM；按 RIFF 头判断
      const wav = raw.subarray(0, 4).toString('ascii') === 'RIFF' ? raw : pcmToWav(raw, sampleRate, 1);
      const target = String(output).replace(/\.[^./\\]+$/, '') + '.wav';
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, wav);
      return { file: target, bytes: wav.length, chars: clean.length, format: 'wav', via: 'local' };
    },

    async status() {
      const baseInfo = { engine: 'breeze-local', url: base, hasRef: Boolean(refAudio), refAudio, model: 'breeze-tts-2' };
      try {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
        const data = await response.json().catch(() => ({}));
        // 503 + {"status":"loading"} = 进程在，但权重还没读进显存
        const loading = response.status === 503 || String(data?.status || '') === 'loading';
        return {
          ...baseInfo,
          online: response.ok && !loading,
          loading,
          hasKey: true,
          hasVoice: Boolean(refAudio) || Boolean(instruction),
          balance: null,
          note: loading ? '模型加载中' : response.ok ? '' : `本地服务返回 ${response.status}`
        };
      } catch (error) {
        return { ...baseInfo, online: false, loading: false, hasKey: true, hasVoice: Boolean(refAudio), balance: null,
          note: `本地服务没起来（${String(error?.message ?? error).slice(0, 80)}）` };
      }
    },

    async listVoices() {
      // 本地没有"音色库"：要么给参考音频克隆，要么用语气描述设计
      return [];
    },
    async balance() { return null; }
  };
}

export function createSayEngine(config) {
  const say = config.say || {};
  const engineName = String(say.engine || 'breeze').trim();

  // 「现在允许用本地模型吗」：由 app 注入（GPU 槽）。本地 TTS 要 8.2 GB，
  // 画图/唱歌正在跑的时候硬拉起来就是两个一起掉进共享内存 —— 这种情况宁可报错让宿主退回文字。
  let localGuard = null;
  const setLocalGuard = (fn) => { localGuard = typeof fn === 'function' ? fn : null; };
  const assertLocalAllowed = () => {
    if (localGuard && !localGuard()) {
      throw Object.assign(
        new Error('显卡正被画图/唱歌占着，本地 TTS 这次不上'),
        { code: 'E_SAY_LOCAL_BUSY' }
      );
    }
  };

  if (engineName === 'none') {
    return {
      name: 'none',
      setLocalGuard,
      async convert() { throw Object.assign(new Error('说话功能没开（say.engine = none）'), { code: 'E_SAY_OFF' }); },
      async status() { return { engine: 'none', online: false, note: '网关没开说话功能' }; },
      async listVoices() { return []; },
      async balance() { return null; },
      credentials: () => ({})
    };
  }

  // auto：优先云端（3-6 秒、音色绝对稳定、按字符扣额度），云端不可用再落本地（免费但要 8.2 GB 显存）
  if (engineName === 'auto') {
    const cloud = makeCloudEngine(say);
    const local = makeLocalEngine(say);
    return {
      name: 'auto',
      setLocalGuard,
      setCredentials: (...args) => cloud.setCredentials(...args),
      credentials: () => cloud.credentials(),
      async convert(args) {
        const hasKey = Boolean(cloud.credentials().apiKey);
        if (hasKey) {
          try {
            return await cloud.convert(args);
          } catch (error) {
            const code = String(error?.code || '');
            const status = Number(error?.status) || 0;
            // 额度不足/服务故障才落本地；Key 写错就直接报错（落本地反而掩盖问题）
            if (code === 'E_SAY_NET' || status >= 500 || status === 429 || status === 402 || status === 404) {
              console.warn(`[say] 云端不可用（${status || code}），回落本地：${String(error?.message ?? error).slice(0, 120)}`);
            } else {
              throw error;
            }
          }
        }
        assertLocalAllowed();
        return await local.convert(args);
      },
      async status(options) {
        const cloudStatus = await cloud.status(options);
        if (cloudStatus.online) return { ...cloudStatus, mode: 'cloud' };
        const localStatus = await local.status(options);
        return { ...cloudStatus, mode: 'local', localRunning: localStatus.online,
          note: cloudStatus.note ? `${cloudStatus.note}（已回落本地）` : '云端不可用，已回落本地' };
      },
      listVoices: (...args) => cloud.listVoices(...args),
      balance: (...args) => cloud.balance(...args)
    };
  }

  if (engineName === 'breeze-local') {
    const local = makeLocalEngine(say);
    const cloud = makeCloudEngine(say);   // 兜底：本地挂了就走云端（有 Key 才生效）
    return {
      name: 'breeze-local',
      setLocalGuard,
      setCredentials: (...args) => cloud.setCredentials(...args),
      credentials: () => cloud.credentials(),
      async convert(args) {
        try {
          assertLocalAllowed();
          return await local.convert(args);
        } catch (error) {
          const hasKey = Boolean(cloud.credentials().apiKey);
          if (!hasKey) throw error;
          console.warn(`[say] 本地 Breeze 失败，退回云端：${String(error?.message ?? error).slice(0, 140)}`);
          return await cloud.convert(args);
        }
      },
      async status(options) {
        const localStatus = await local.status();
        if (localStatus.online) return localStatus;
        const cloudStatus = await cloud.status(options);
        return { ...localStatus, cloudFallback: cloudStatus.online, balance: cloudStatus.balance ?? null,
          note: localStatus.note + (cloudStatus.online ? '（已退回云端）' : '') };
      },
      listVoices: (...args) => cloud.listVoices(...args),
      balance: (...args) => cloud.balance(...args)
    };
  }

  const engine = makeCloudEngine(say);
  engine.name = 'breeze';
  engine.setLocalGuard = setLocalGuard;   // 纯云端用不到本地模型，接口保持一致
  return engine;
}
