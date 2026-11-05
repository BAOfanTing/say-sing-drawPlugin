// 网关主体：路由 + 「搜歌 → 下载音源 → 换声 → 转码」流水线。
// 不含 listen、不含定时器 —— 这两件事在 server.mjs 里，测试直接拿 createApp().handler。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createJobQueue } from './jobs.mjs';
import { createSource } from './sources.mjs';
import { createVoiceEngine } from './voice.mjs';
import { transcodeTo, probeSeconds, shiftPitch, concatAudio, runProcess, applyFilter } from './audio.mjs';
import { parseEmotionTag, resolveEmotionKey, emotionInstruction, emotionList } from './emotions.mjs';
import { createSayEngine } from './say.mjs';
import { createGpuSlot } from './gpu-slot.mjs';
import { createManagedModel } from './managed-model.mjs';
import { createLocalSay } from './local-say.mjs';
import { createSaySpeech } from './say-speech.mjs';
import { createDrawProxy } from './draw-proxy.mjs';

export const VERSION = '1.0.5';
const WEB_DIR = path.join(import.meta.dirname, '..', 'web');
const NETEASE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_BODY_BYTES = 8 * 1024;
// 出图请求要带参考图（宿主把聊天里那张图缩好、编成 data URI 塞在 body 里），8 KB 根本不够。
// 单独给画图一条宽松线：24 MB ≈ 一张 17 MB 的原图，够用了；再大就说明链路哪里不对。
const MAX_DRAW_BODY_BYTES = 24 * 1024 * 1024;
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const CONTENT_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg'
};

/**
 * 从"要说的话"里认出"唱歌请求"。
 * 宿主 send_voice 传给 /audio/speech 的 input 是模型自由写的文字，
 * 所以只认明确的开头（唱/点歌/sing…），认不出就当普通说话处理（本网关不支持）。
 */
/** 把歌名里的噪声去掉：括号说明、《》、" - 歌手"、"原唱：…" 这类。
 *  模型常写成「雨爱（原唱：杨丞琳）」，直接拿去搜网易云会搜不到。 */
export function simplifySong(song) {
  return String(song ?? '')
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .replace(/[《》〈〉]/g, ' ')
    .replace(/\s*[-–—~]\s*[^-–—~]{1,20}$/, ' ')
    .replace(/^(?:原唱|翻唱|cover|演唱)\s*[:：]\s*/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractSongRequest(input, { bareTitle = false } = {}) {
  const text = String(input ?? '').trim();
  const clean = (raw) => String(raw ?? '')
    .replace(/[《》"“”'‘’]/g, '')
    .replace(/^(?:一首|首)\s*/, '')
    .replace(/[。！？!?,，\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // ① 开头就是指令：唱：X / 唱一首X / 点歌 X / sing: X
  const head = /^(?:sing|点歌|唱一首|来一首|来首|唱)\s*[:：]?\s*(.+)$/i.exec(text);
  if (head) {
    const song = clean(head[1]);
    if (song && song.length <= 60) return song;
  }

  // ② 指令夹在句中（模型常写"好的，我来唱：起风了"）：取触发词之后的短尾巴。
  //
  // 触发词必须是"明确要求唱歌"的说法，孤零零一个「唱」不行 ——
  // 否则「我会唱歌」「我超爱唱歌的」「你想听我唱歌吗」会被抓成「歌」「歌的」「歌吗」并开唱。
  const tail = /(?:唱一首|唱首|来一首|来首|点歌)\s*[:：]?\s*([^，。！？!?\n]{1,30})$/.exec(text)
    || /唱\s*[:：]\s*([^，。！？!?\n]{1,30})$/.exec(text);
  if (tail) {
    const song = clean(tail[1]);
    if (song && song.length <= 30) return song;
  }

  // ③ 兜底：只有显式打开（intent.bareTitle）才把"裸短词"当歌名。
  //
  // 为什么默认关：这条规则会把模型的口头禅当成歌名 —— 宿主 send_voice 是"说话"通道，
  // 模型回一句「好的」「嗯嗯」「收到」全都命中，网关就去搜《好的》并开唱。
  // 唱错歌的代价（群里冒出一段莫名其妙的歌）比"该唱没唱"大得多，所以默认偏向说话。
  // 纯触发词（"唱""点歌"）永远不算歌名。
  if (bareTitle) {
    const bareTrigger = /^(?:sing|点歌|唱一首|来一首|来首|唱)$/i;
    if (text.length <= 20 && !bareTrigger.test(text) && !/[，。！？!?,;；\n]/.test(text) && !/\s/.test(text)) return text;
  }

  return '';
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

async function readRawBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  const human = maxBytes >= 1024 * 1024 ? `${Math.round(maxBytes / 1024 / 1024 * 10) / 10} MB` : `${Math.round(maxBytes / 1024)} KB`;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error(`请求体过大（上限 ${human}）`), { code: 'E_TOO_BIG' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8') || '{}';
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('请求体太大'), { code: 'E_TOO_BIG' });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'E_ARGS' });
  }
}

export function createApp({
  config,
  source = createSource(config),
  voice = createVoiceEngine(config),
  say = createSayEngine(config),
  persistCookie = null,
  gpu = null,
  now = () => Date.now()
}) {
  const filesDir = path.join(config.dataDir, 'files');
  const tmpDir = path.join(config.dataDir, 'tmp');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  // 三个吃显存的租户（换声 / 本地 TTS / 画图）共用这一个槽位：同一时刻只允许一个在跑。
  // 以前是"每个调用点各自成对检查"，画图上线后漏了两条边（画图中点歌、画图中说话），
  // 两边一起挤 10 GB 卡 → 掉进共享内存。这里塌缩成一条规则：重活串行。
  const gpuSlot = gpu || createGpuSlot({
    now,
    onWait: ({ kind, waitedMs }) => {
      if (waitedMs >= 2000) console.log(`[gpu] ${kind} 排队等了 ${(waitedMs / 1000).toFixed(1)} 秒`);
    }
  });
  // 本地 TTS 只允许在"自己拿着槽位"或"卡上没人"的时候启动：
  // 否则 auto 模式的云端兜底会在画图/唱歌进行中把 8.2 GB 拉起来。
  if (typeof say.setLocalGuard === 'function') {
    say.setLocalGuard(() => {
      const owner = gpuSlot.owner();
      return !owner || owner === 'say';
    });
  }

  /** 一条点歌任务的完整流水线。任何一步失败都抛错，任务状态落 failed（绝不给出半成品）。 */
  async function runSingJob(job, { progress }) {
    const payload = job.payload || {};
    const song = String(payload.song ?? '').trim();
    // payload.maxSeconds === 0 表示「唱完整首」：不裁剪，只受 config.maxSeconds 兜底保护。
    const requested = Number(payload.maxSeconds);
    const maxSeconds = requested === 0
      ? Number(config.maxSeconds) || 0
      : Math.min(config.maxSeconds, Math.max(5, requested || config.maxSeconds));
    const wantedVoice = String(payload.voice ?? '').trim() || config.voice.defaultVoice;

    progress(0.05, '搜歌');
    // 原样搜不到就换简化后的歌名再搜一次（"雨爱（原唱：杨丞琳）" → "雨爱"）
    const queries = [...new Set([song, simplifySong(song)].filter(Boolean))];
    let items = [];
    for (const query of queries) {
      items = await source.search(query, { limit: config.source.limit });
      if (items.length) break;
    }
    if (!items.length) throw new Error(`没搜到「${song}」，换个关键词或者把歌手一起写上`);
    // 原唱常常受版权限制（网易云 VIP 曲拿不到直链），但同一首歌通常有免费翻唱版。
    // 所以按相关度依次尝试，直到有一个能取到音频 —— 取到的不是第一条时如实说明。
    const wanted = (payload.itemId && items.find((entry) => String(entry.id) === String(payload.itemId))) || null;
    const candidates = wanted ? [wanted, ...items.filter((entry) => entry !== wanted)] : items;
    let item = null;
    let prepared = null;
    let lastError = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      progress(0.1, `取音源：${candidate.title}`);
      try {
        // 依次试候选：第一条常是 VIP 原唱（没登录态取不到），后面往往有完整翻唱版。
        prepared = await source.prepare(candidate, { tmpDir });
        item = candidate;
        break;
      } catch (error) {
        lastError = error;
        progress(0.1, `这条取不到（${String(error?.message ?? error).slice(0, 40)}），换下一条`);
      }
    }
    if (!prepared || !item) throw lastError || new Error('所有搜索结果都取不到音频');
    job.title = String(item.title ?? song);
    // 群里看到的「演唱者」是机器人自己（config.outputArtist，默认「小鲸鱼」），
    // 不是原唱；原唱信息留给 note / sourceArtist，用于"原唱受限，改用翻唱版"这类说明。
    job.sourceArtist = String(item.artist ?? '');
    job.artist = String(config.outputArtist || item.artist || '');
    let note = '';
    if (candidates[0] && item !== candidates[0]) {
      note = `原唱源受限，改用可播放版本：${job.title} - ${job.sourceArtist || job.artist}`;
      console.log(`[sing] ${note}`);
    }

    progress(0.35, '换声');
    // engine=none 时输出就是输入本身：扩展名必须跟着音源走（网易云可能给 m4a/mp3），
    // 否则会造出"m4a 字节 + .wav 后缀"的文件，播放器与 QQ 都会不认。
    const voiceExt = config.voice.engine === 'none'
      ? (prepared.ext || config.voice.outputExt)
      : config.voice.outputExt;
    const rawOut = path.join(tmpDir, `voice-${job.jobId}.${voiceExt}`);
    await voice.convert({
      input: prepared.file,
      output: rawOut,
      voice: wantedVoice,
      maxSeconds,
      // 分段换声时 run.py 会逐段报进度：进度条走 0.6→0.8，消息里写第几段
      onProgress: ({ done, total, note }) => {
        const ratio = total > 0 ? Math.min(1, done / total) : 0;
        // 只把段号写进进度消息，note 里是段文件名，对使用者没意义
        progress(0.6 + 0.2 * ratio, `换声 ${done}/${total} 段`);
      }
    });

    progress(0.8, '转码');
    const targetExt = config.transcode === 'auto' ? 'mp3' : (prepared.ext || voiceExt);
    const finalName = `out-${job.jobId}.${targetExt}`;
    const finalPath = path.join(filesDir, finalName);
    let usedTarget = targetExt;
    if (config.transcode === 'auto') {
      const ok = await transcodeTo(rawOut, finalPath, { maxSeconds, ext: 'mp3' });
      if (!ok) {
        // 没装 ffmpeg：如实发原文件，而不是假装转码成功
        usedTarget = voiceExt;
        fs.copyFileSync(rawOut, path.join(filesDir, `out-${job.jobId}.${voiceExt}`));
      }
    } else {
      fs.copyFileSync(rawOut, path.join(filesDir, `out-${job.jobId}.${voiceExt}`));
      usedTarget = voiceExt;
    }

    const outPath = path.join(filesDir, `out-${job.jobId}.${usedTarget}`);
    const probedSec = Math.round(await probeSeconds(outPath)) || 0;
    // 探不到时长时用请求时长兜底：报 0 会让宿主退回"按字数估"，又说成 1 秒
    const seconds = probedSec > 0 ? Math.min(maxSeconds, probedSec) : maxSeconds;
    const bytes = fs.statSync(outPath).size;

    // 中间文件用完就删；成品留在 files/ 给插件下载（TTL 清理见 pruneFiles）
    for (const temp of [prepared.file, rawOut]) {
      try { fs.rmSync(temp, { force: true }); } catch { /* 清理失败不影响结果 */ }
    }

    progress(0.95, '收尾');
    return {
      audioUrl: `/files/out-${job.jobId}.${usedTarget}`,
      bytes,
      seconds,
      engine: voice.name,
      title: job.title,
      artist: job.artist,
      note
    };
  }

  // 插件设置里改的「语音条秒数」会通过 /admin/voice-seconds 推上来（插件不参与语音条那条链路，
  // 只能这样把值交给网关）。它落在 state 文件里，网关重启后依然生效 ——
  // 否则重启一次就退回 config 默认值，表现是"插件设了 240 却只唱 90"。
  const runtimeStateFile = path.join(config.dataDir ? path.resolve(config.dataDir) : filesDir, 'runtime.json');
  let runtimeVoiceSeconds = null;   // null = 没设过（用 config 默认）；0 = 整首

  /** 把运行期设置写回 state 文件（插件推上来的值要能扛住重启）。 */
  const saveRuntimeState = () => {
    try {
      fs.mkdirSync(path.dirname(runtimeStateFile), { recursive: true });
      const payload = { voiceSeconds: runtimeVoiceSeconds };
      // 网易云登录态也落这里（runtime.json），不再回写人编辑的 config.json：
      // 人机共写一个文件，扫码回写和手改配置撞在一起必然丢一边。
      if (typeof source.getCookie === 'function') {
        const cookie = String(source.getCookie() || '');
        if (cookie) payload.neteaseCookie = cookie;
      }
      const creds = typeof say.credentials === 'function' ? say.credentials() : {};
      if (creds.apiKey) payload.sayKey = creds.apiKey;
      if (creds.voiceId) payload.sayVoiceId = creds.voiceId;
      fs.writeFileSync(runtimeStateFile, JSON.stringify(payload, null, 2));
    } catch (error) {
      console.warn(`[state] 保存失败：${String(error?.message ?? error)}`);
    }
  };

  try {
    if (fs.existsSync(runtimeStateFile)) {
      const saved = JSON.parse(fs.readFileSync(runtimeStateFile, 'utf8'));
      const savedSeconds = Number(saved?.voiceSeconds);
      if (Number.isFinite(savedSeconds) && savedSeconds >= 0) {
        runtimeVoiceSeconds = savedSeconds;
        console.log(`  语音条时长（来自上次设置）：${savedSeconds === 0 ? '整首' : `${savedSeconds} 秒`}`);
      }
      if (saved?.neteaseCookie && typeof source.setCookie === 'function') {
        source.setCookie(String(saved.neteaseCookie));
        console.log('  网易云登录态：已从 runtime.json 恢复');
      }
      if (saved?.sayKey || saved?.sayVoiceId) {
        if (typeof say.setCredentials === 'function') {
          say.setCredentials({ apiKey: saved.sayKey, voiceId: saved.sayVoiceId });
          console.log('  说话（Breeze）：已载入上次保存的 Key/音色');
        }
      }
    }
  } catch { /* 状态文件坏了就当没有 */ }

  // 正在跑的歌（串行队列，最多 1 个）。说话侧靠它判断"能不能动换声常驻进程"。
  let activeSingJobs = 0;

  const queue = createJobQueue({
    // 唱歌前先把本地 TTS 的显存让出来，然后**占住 GPU 槽**跑完整首歌：
    // 这样画图请求不会在歌曲中途插进来（两个一起挤 10 GB 卡只会都变慢十倍）。
    runner: async (job, ctx) => {
      activeSingJobs += 1;
      try {
        return await gpuSlot.run('sing', async () => {
          await yieldLocalSay();
          return await runSingJob(job, ctx);
        });
      } finally {
        activeSingJobs = Math.max(0, activeSingJobs - 1);
      }
    },
    ttlMs: config.filesTtlHours * 3600 * 1000,
    now
  });

  const tokenOk = (req) => {
    if (!config.token) return true;
    const header = String(req.headers.authorization || '');
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(config.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  /** 等一个任务跑完（给 /audio/speech 用：宿主那条路是同步要音频的）。 */
  const waitForJob = async (jobId, timeoutMs) => {
    const deadline = now() + Math.max(5000, Number(timeoutMs) || 120000);
    for (;;) {
      const job = queue.get(jobId);
      if (!job) return { state: 'failed', error: '任务不存在（可能已被清理）' };
      if (job.state === 'done' || job.state === 'failed') {
        return { state: job.state, error: job.error, audioUrl: job.audioUrl };
      }
      if (now() >= deadline) return { state: 'failed', error: '等太久：换声没在预期时间内完成' };
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };

  /** 清掉过期的成品文件：磁盘是使用者自己的，不能靠人记得删。 */
  const pruneFiles = () => {
    const cutoff = now() - config.filesTtlHours * 3600 * 1000;
    let removed = 0;
    for (const name of fs.readdirSync(filesDir)) {
      const file = path.join(filesDir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) { fs.rmSync(file, { force: true }); removed += 1; }
      } catch { /* 并发删除/权限问题跳过 */ }
    }
    return removed;
  };

  /**
   * 清掉「今天以前」的成品（每天 0 点由 server.mjs 的定时器调用，插件也能触发）。
   * 按本地零点算：群里昨天的点歌不该留到明天。
   */
  // ── 网易云扫码登录 ────────────────────────────────────────────────
  // 用网易云自己的二维码登录接口（unikey + 轮询），不经过任何第三方；
  // 二维码在 /login 页面本地渲染，登录 key 不会离开本机。
  const loginSessions = new Map();

  /** 清掉 10 分钟前生成的登录会话（unikey 只在扫码期间有意义）。 */
  function pruneLoginSessions() {
    const cutoff = now() - 10 * 60 * 1000;
    for (const [key, value] of loginSessions) {
      if (Number(value?.createdAt) < cutoff) loginSessions.delete(key);
    }
  }

  async function startNeteaseLogin() {
    pruneLoginSessions();
    const response = await fetch('https://music.163.com/api/login/qrcode/unikey?type=1', {
      headers: { 'user-agent': NETEASE_UA, referer: 'https://music.163.com/' },
      signal: AbortSignal.timeout(8000)          // 网易云卡住时不能把请求挂死
    });
    const data = await response.json().catch(() => ({}));
    if (Number(data.code) !== 200 || !data.unikey) throw new Error(`申请二维码失败（code=${data.code}）`);
    loginSessions.set(String(data.unikey), { createdAt: now() });
    console.log('[login] 已生成网易云登录二维码');
    return {
      key: String(data.unikey),
      loginUrl: `https://music.163.com/login?codekey=${encodeURIComponent(String(data.unikey))}`
    };
  }

  async function pollNeteaseLogin(key) {
    const response = await fetch(
      `https://music.163.com/api/login/qrcode/client/login?key=${encodeURIComponent(key)}&type=1`,
      {
        headers: { 'user-agent': NETEASE_UA, referer: 'https://music.163.com/' },
        signal: AbortSignal.timeout(8000)
      }
    );
    const data = await response.json().catch(() => ({}));
    const code = Number(data.code);
    if (code === 800) { loginSessions.delete(key); return { state: 'expired' }; }
    if (code === 801) return { state: 'waiting' };
    if (code === 802) return { state: 'scanned' };
    if (code === 803) {
      const raw = (typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [])
        .map((line) => String(line).split(';')[0].trim())
        .filter(Boolean);
      const cookie = raw.join('; ');
      if (!/MUSIC_U=/.test(cookie)) return { state: 'failed', message: '登录成功但没拿到 MUSIC_U，请重试' };
      if (typeof source.setCookie === 'function') source.setCookie(cookie);
      if (typeof persistCookie === 'function') persistCookie(cookie);
      loginSessions.delete(key);
      console.log('[login] 网易云登录成功，Cookie 已写入配置');
      return { state: 'ok', cookieKeys: raw.map((kv) => kv.split('=')[0]) };
    }
    loginSessions.delete(key);
    return { state: 'failed', message: `未预期的状态码 ${code}` };
  }

  const pruneBeforeToday = () => {
    // 按"文件年龄"删：按自然日零点会让 23:59 唱完的歌在 00:01 被删，
    // 而插件可能正好那时来下载（404）。默认只删 8 小时前的成品。
    const minAgeHours = Math.max(1, Number(config.filesPruneMinAgeHours) || 8);
    const cutoff = now() - minAgeHours * 3600 * 1000;
    let removed = 0;
    let bytes = 0;
    for (const name of fs.readdirSync(filesDir)) {
      const file = path.join(filesDir, name);
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(file, { force: true });
          removed += 1;
          bytes += stat.size;
        }
      } catch { /* 并发删除/权限问题跳过 */ }
    }
    return { removed, bytes };
  };

  // ── 本地 TTS（进程生命周期 + 让位策略都在 lib/local-say.mjs）────────
  // runShell 先定义：localSay 的 start/stop 要用它跑用户给的命令
  const runShell = (command, timeoutMs = 120000) => new Promise((resolve) => {
    const child = spawn(command, { shell: true, windowsHide: true });
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        try { spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }); } catch { /* 忽略 */ }
      }
      try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
  });

  const localSay = createLocalSay({
    config,
    voice,
    isSinging: () => activeSingJobs > 0,
    runShell,
    now
  });

  // 旧名字保留成薄封装：调用点（yield/resume/handleSay）不用改
  const localHealthOk = () => localSay.healthy();
  const startLocalSay = () => localSay.start();
  const stopLocalSay = () => localSay.stop();
  const clearLocalIdle = () => localSay.cancelIdle();
  const armLocalIdle = () => localSay.armIdle();
  const yieldLocalSay = () => localSay.yieldToHeavy();
  const resumeLocalSay = () => localSay.resume();

  /**
   * 音高归一：测出这句话的中位基频，用 rubberband 拉到 say.pitchTarget。
   * 同一个音色每次生成会飘 ±25 Hz（约 1 个半音），听感像换了个人 —— 拉齐之后稳定得多。
   * 返回归一后的文件路径（失败则原样返回）。
   */
  /** 测一段音频的中位基频（用 say-model/f0.py）；测不到返回 0。 */
  const measurePitch = async (file) => {
    const python = String(config.say.localPython || '').trim();
    const script = config.say.localAppDir ? path.join(config.say.localAppDir, 'f0.py') : '';
    if (!python || !script || !fs.existsSync(script)) return 0;
    try {
      const result = await runProcess(python, [script, file], { timeoutMs: 60000 });
      const value = Number.parseFloat(String(result?.stdout || result?.stderr || '').trim());
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch (error) {
      const value = Number.parseFloat(String(error?.stdout || error?.stderr || '').trim());
      return Number.isFinite(value) && value > 0 ? value : 0;
    }
  };

  /**
   * 音区守门：本地模型对不同文本会随机落在高/低音区（实测同一句换个 seed
   * 就能从 266 Hz 跳到 380 Hz，而 MFCC 相似度仍有 0.98——换的是音区不是嗓子）。
   * 所以合成后测一次基频，落在 [registerMin, registerMax] 之外就换个 seed 重来，
   * 不碰音频本身，也就没有变调痕迹。
   */
  const synthesizeInRegister = async (text, output, baseSeed = 42, voiceOptions = {}) => {
    const min = Number(config.say.registerMin) || 0;
    const max = Number(config.say.registerMax) || 0;
    const retries = Number(config.say.registerRetries) || 0;
    let spoke = await say.convert({ text, output, seed: baseSeed, ...voiceOptions });
    // 云端音色本来就稳定，不需要守门（守门每轮要跑一次 python 测基频，会把 3 秒拖成 20 秒）
    if (spoke.via === 'cloud') return spoke;
    if (min <= 0 || max <= 0 || retries <= 0) return spoke;
    // 只对短音频重试：长文本不管怎么换 seed 都会落在低音区，
    // 重试只会把 80 秒拖成 230 秒（2026-11-01 实测）
    const retryMaxSeconds = Number(config.say.registerRetryMaxSeconds) || 12;
    const seconds = await probeSeconds(spoke.file);
    if (seconds > retryMaxSeconds) {
      console.log(`[say] 音频 ${seconds.toFixed(1)} 秒 > ${retryMaxSeconds}，跳过音区重试`);
      return spoke;
    }
    let pitch = await measurePitch(spoke.file);
    for (let attempt = 1; attempt <= retries && pitch > 0 && (pitch < min || pitch > max); attempt += 1) {
      const nextSeed = baseSeed + attempt * 13;
      console.log(`[say] 音区 ${pitch.toFixed(0)} Hz 不在 ${min}-${max}，换 seed=${nextSeed} 重试（${attempt}/${retries}）`);
      try { fs.rmSync(spoke.file, { force: true }); } catch { /* 忽略 */ }
      spoke = await say.convert({ text, output, seed: nextSeed, ...voiceOptions });
      pitch = await measurePitch(spoke.file);
    }
    if (pitch > 0) console.log(`[say] 音区 ${pitch.toFixed(0)} Hz`);
    return spoke;
  };

  const pitchNormalize = async (file) => {
    const target = Number(config.say.pitchTarget) || 0;
    if (target <= 0) return file;
    const measured = await measurePitch(file);
    if (!Number.isFinite(measured) || measured <= 0) return file;
    const ratio = target / measured;
    const semitones = 12 * Math.log2(ratio);
    const maxShift = Number(config.say.pitchMaxShift) || 3;
    if (!Number.isFinite(semitones) || Math.abs(semitones) < 0.15 || Math.abs(semitones) > maxShift) {
      return file;                                  // 本来就接近，或差得离谱（宁可不改）
    }
    const out = file.replace(/\.(wav|mp3|opus)$/i, `-pitch.${/mp3$/i.test(file) ? 'mp3' : 'wav'}`);
    const ok = await shiftPitch(file, out, ratio, { ext: /mp3$/i.test(out) ? 'mp3' : 'wav' });
    if (!ok || !fs.existsSync(out)) return file;
    console.log(`[say] 音高归一：${measured.toFixed(1)} Hz → ${target} Hz（${semitones > 0 ? '+' : ''}${semitones.toFixed(2)} 半音）`);
    try { fs.rmSync(file, { force: true }); } catch { /* 忽略 */ }
    return out;
  };

  /**
   * 把一段话切成适合单次合成的句子。
   *
   * 为什么切：Breeze 一次生成多句长文本时，音高会句间漂移（实测 12 秒回复里
   * 340→396→380→340 Hz），整段一次音高归一救不了段内漂移。切句后逐句归一就齐了。
   */
  const splitSayText = (text, maxChars) => {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) return [];
    // 先按句末标点切，再把过长的句子按逗号补切
    const rough = clean.split(/(?<=[。！？!?…；;\n])/).map((x) => x.trim()).filter(Boolean);
    // 把短句按 maxChars 打包，减少合成次数（每段都要跑一次模型，很贵）
    const out = [];
    let buffer = '';
    const flush = () => { if (buffer.trim()) { out.push(buffer.trim()); buffer = ''; } };
    for (const piece of rough) {
      if (buffer && (buffer.length + piece.length) > maxChars) flush();
      if (piece.length > maxChars) {
        flush();
        let rest = piece;
        while (rest.length > maxChars) {
          let idx = -1;
          for (let i = 0; i <= Math.min(maxChars, rest.length - 1); i += 1) {
            if ('，,、'.includes(rest[i])) idx = i;
          }
          const at = idx > 0 ? idx + 1 : Math.min(maxChars, rest.length);
          out.push(rest.slice(0, at).trim());
          rest = rest.slice(at).trim();
        }
        if (rest) out.push(rest);
      } else {
        buffer += piece;
      }
    }
    flush();
    return out.length ? out : [clean];
  };

  /**
   * 把一段话读成语音条（不走 GPU 队列：云端 TTS 几秒就完，没必要排队）。
   * Breeze 直接返回 mp3，不再做任何转码 —— 少一道工序就少一个失败点。
   *
   * 情绪（options.emotion / 文字开头的【生气】标记）在这一层解析：
   * 剥掉标记 → 该条换「表演指令」+ 开 use_speaker_boost → 合成后套 ffmpeg 加工。
   * 没有情绪时走的是原路径，一个字节都不变（向后兼容）。
   */

  // 出图服务是"懒加载 + 闲置 300 秒退出"的：闲置后进程会没，下一次请求必须有人把它拉起来。
  // 以前靠一个每 5 分钟跑一次的看门狗兜，副作用是**每分钟级别的窗口闪一下**，还在跟闲置退出互相打架。
  // 现在改成按需拉起：连不上就先起进程，等 /health 通了再转发。
  // 出图代理：按需拉起 + GPU 槽 + 转发抗抖，整段在 lib/draw-proxy.mjs 里
  const drawProxy = createDrawProxy({
    config,
    gpu: gpuSlot,
    yieldLocalSay: () => yieldLocalSay()
  });

  // 说话合成流水线（情绪/切句/音区/音高/后期）在 lib/say-speech.mjs，这里只注入依赖
  const saySpeech = createSaySpeech({
    config,
    say,
    gpu: gpuSlot,
    resumeLocalSay,
    pitchNormalize,
    synthesizeInRegister,
    splitSayText,
    concatAudio,
    probeSeconds,
    applyFilter,
    parseEmotionTag,
    resolveEmotionKey,
    emotionInstruction,
    now,
    log: (m) => console.log(m)
  });

  /** 路由层薄封装：合成在 say-speech.mjs，这里只管回包与清理。 */
  async function handleSay(req, res, text, options = {}) {
    const out = await saySpeech.synthesize(text, { ...options, tmpDir });
    try {
      res.writeHead(200, {
        'content-type': out.contentType,
        'content-length': out.buffer.length,
        'x-audio-seconds': String(out.seconds),
        ...(out.wasTruncated ? { 'x-truncated': '1', 'x-max-chars': String(out.sayMaxChars) } : {})
      });
      res.end(out.buffer);
    } finally {
      out.cleanup();
      armLocalIdle();                                 // 说完开始闲置倒计时
    }
  }

  const handler = async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      sendJson(res, 400, { ok: false, message: '请求地址不合法' });
      return;
    }
    const { pathname } = url;

    // 访问日志：只记"谁打了哪个口、什么结果、多快"。
    // 没有这条，宿主那边报"语音合成失败"时根本看不出是我们拒了、超时了还是压根没收到。
    const startedAt = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - startedAt;
      const status = res.statusCode;
      const flag = status >= 400 ? '✗' : '·';
      console.log(`[req] ${flag} ${req.method} ${pathname} → ${status} (${ms}ms)`);
    });
    // 客户端（宿主/隧道）中途断开时，往已关闭的 socket 写会抛 EPIPE；
    // 没有 'error' 监听器的话 Node 会把它升级成未捕获异常、**整个网关退出**（15:50 真实发生过）。
    res.on('error', (error) => {
      console.warn(`[req] 响应流出错（调用方多半已断开）：${String(error?.message ?? error).slice(0, 120)}`);
    });

    // /health 免鉴权：只暴露"在不在、什么引擎"，方便排查隧道通不通
    // ── 画图：透传到本地出图服务（draw/ 里的 Python 服务）────────────────
    // 宿主控制台的「图片生成 → 服务地址」可以直接指向本网关，也可以指向 draw 服务本身；
    // 走网关的好处是能拿到统一的 GPU 仲裁（唱歌/说话在跑时排队），并复用网关令牌。
    if ((pathname === '/v1/images/generations' || pathname === '/images/generations') && req.method === 'POST') {
      // 出图服务可能没起、可能卡在共享内存里、也可能把连接直接掐了 —— 这些都必须就地变成 502，
      // 不能变成未捕获拒绝（那会让整个网关退出，连唱歌/说话一起哑掉）。
      // 拉起/占槽/重试的细节在 lib/draw-proxy.mjs，这里只管收发。
      try {
        // 画图请求可能带参考图（data URI），用宽松的那条上限
        const raw = await readRawBody(req, MAX_DRAW_BODY_BYTES);
        const out = await drawProxy.forward(raw);
        res.writeHead(out.status, {
          'content-type': out.contentType || 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(out.body)
        });
        res.end(out.body);
        return;
      } catch (error) {
        // 请求体太大是**调用方**的问题（参考图没缩），别报成后端挂了
        if (error?.code === 'E_TOO_BIG') {
          const message = `参考图太大：${String(error?.message ?? error).slice(0, 120)}（宿主那把图缩小一点，或者调小参考图长边）`;
          console.error(`[draw] ✗ ${message}`);
          if (!res.headersSent && !res.writableEnded) sendJson(res, 413, { error: { message } });
          else res.destroy();
          return;
        }
        const message = `画图后端不可用：${String(error?.message ?? error).slice(0, 200)}`;
        console.error(`[draw] ✗ ${message}`);
        if (res.headersSent || res.writableEnded) {
          res.destroy();
        } else {
          sendJson(res, 502, { error: { message } });
        }
        return;
      }
    }

    if (pathname === '/health') {
      const voiceConfigured = voice.name !== 'none';
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        engine: voice.name,
        say: say.name,
        voiceConfigured,
        // 没接换声模型就报空列表：不把"根本不存在的音色"说成可用
        voices: voiceConfigured ? voice.voices : [],
        // 换声是否常驻：0 = 按需（每首歌起进程、跑完即退），正数 = 常驻且闲置这么久自退
        voiceResidentMs: Number(voice.residentIdleMs) || 0,
        // 谁现在占着 GPU、还有几个在排队（三个租户共享一个槽位，见 gpu-slot.mjs）
        gpu: { owner: gpuSlot.owner(), waiting: gpuSlot.waiting(), ...gpuSlot.stats() },
        models: { localSay: localSay.status(), draw: drawProxy.status() },
        source: source.type,
        neteaseCookie: typeof source.hasCookie === 'function' ? source.hasCookie() : Boolean(config.source.neteaseCookie),
        voiceSeconds: runtimeVoiceSeconds ?? (config.voiceMessageDefaultSeconds ?? 90),
        voiceFullSong: runtimeVoiceSeconds === 0,
        // 三个上限都报出来：设置被夹回去时能一眼看出是哪一道闸
        voiceMaxSeconds: Math.max(5, Number(config.voiceMessageMaxSeconds) || 300),
        jobMaxSeconds: Number(config.maxSeconds) || 300,
        transcode: config.transcode,
        jobs: queue.size(),
        now: now()
      });
      return;
    }

    // ── OpenAI 风格的模型清单（给 aurabot 这类宿主用）──────────────────
    // 宿主的「语音」页要填一个 model 名字，面板也想知道有哪些音色可用；
    // 这里把网关实际能提供的报出去，省得用户去猜 / 抄文档。只读，不碰 GPU。
    if (pathname === '/v1/models' && req.method === 'GET') {
      // 这个口在统一鉴权之前（和 /health 挨着），所以自己先查一次令牌，别成了免鉴权后门
      if (!tokenOk(req)) {
        sendJson(res, 401, { ok: false, message: '令牌不对：请求头要带 Authorization: Bearer <token>' });
        return;
      }
      const models = [];
      if (say.name !== 'none') {
        models.push({
          id: String(config.say?.model || config.say?.breezeModel || 'breeze-tts-2'),
          object: 'model',
          owned_by: 'say-sing-draw',
          kind: 'tts'
        });
      }
      if (voice.name !== 'none') {
        models.push({
          id: `sing:${config.voice?.defaultVoice || voice.name}`,
          object: 'model',
          owned_by: 'say-sing-draw',
          kind: 'sing'
        });
      }
      const draw = drawProxy.status();
      if (draw && (draw.url || draw.configured)) models.push({ id: 'draw', object: 'model', owned_by: 'say-sing-draw', kind: 'draw' });
      let voices = [];
      try {
        voices = say.name !== 'none' && typeof say.listVoices === 'function' ? await say.listVoices() : [];
      } catch {
        voices = [];
      }
      sendJson(res, 200, {
        object: 'list',
        data: models,
        // 非标准扩展：音色清单（OpenAI 没有这个概念，宿主面板可以拿来当下拉框）
        voices: (Array.isArray(voices) ? voices : []).map((v) => (typeof v === 'string' ? { id: v, name: v } : v)),
        singVoices: voice.name !== 'none' ? voice.voices : []
      });
      return;
    }

    // ── 网易云扫码登录（拿 Cookie，只存本机）──────────────────────────
    // 页面是静态的，不需要鉴权；它调的 /login/* 只认请求头（x-gateway-token / Bearer），
    // 页面自己把令牌放在 # 片段里读，不发给服务器。
    if (pathname === '/login' && req.method === 'GET') {
      const file = path.join(WEB_DIR, 'login.html');
      if (!fs.existsSync(file)) { sendJson(res, 500, { ok: false, message: '缺少 login.html' }); return; }
      const html = fs.readFileSync(file);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length });
      res.end(html);
      return;
    }
    if (pathname === '/login/qrcode.js' && req.method === 'GET') {
      const file = path.join(WEB_DIR, 'qrcode.js');
      if (!fs.existsSync(file)) { sendJson(res, 404, { ok: false, message: '缺少 qrcode.js' }); return; }
      const js = fs.readFileSync(file);
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'content-length': js.length });
      res.end(js);
      return;
    }
    if (pathname.startsWith('/login/')) {
      // 只认两种请求头：x-gateway-token（页面 JS）与 Authorization: Bearer（插件调用）
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      // 不再接受 ?token=：URL 查询参数会留在浏览器历史、隧道日志和 Referer 里
      const given = String(req.headers['x-gateway-token'] || bearer || '').trim();
      const expected = String(config.token || '').trim();
      if (expected && given !== expected) {
        sendJson(res, 401, { ok: false, message: '令牌不对：请用 /login#token=<网关令牌> 打开（令牌在 # 后面，不会发给服务器）' });
        return;
      }
      // ⚠️ 这段在全局 try 之外（令牌校验之前）：必须自己接住异常。
      // 否则一次网易云接口抖动就是未捕获的 Promise 拒绝，整个网关进程会直接退出（实测崩过）。
      try {
        if (pathname === '/login/start' && req.method === 'POST') {
          const started = await startNeteaseLogin();
          sendJson(res, 200, { ok: true, ...started });
          return;
        }
        if (pathname === '/login/status' && req.method === 'GET') {
          const key = String(url.searchParams.get('key') || '').trim();
          if (!key) { sendJson(res, 400, { ok: false, message: '缺少 key' }); return; }
          sendJson(res, 200, await pollNeteaseLogin(key));
          return;
        }
        if (pathname === '/login/logout' && req.method === 'POST') {
          if (typeof source.setCookie === 'function') source.setCookie('');
          if (typeof persistCookie === 'function') persistCookie('');
          loginSessions.clear();
          console.log('[login] 已清除网易云登录态');
          sendJson(res, 200, { ok: true });
          return;
        }
      } catch (error) {
        console.error(`[login] 失败：${error?.message ?? error}`);
        sendJson(res, 502, { ok: false, message: `网易云接口失败：${String(error?.message ?? error).slice(0, 120)}` });
        return;
      }
      sendJson(res, 404, { ok: false, message: `没有这个接口：${req.method} ${pathname}` });
      return;
    }

    if (!tokenOk(req)) {
      sendJson(res, 401, { ok: false, message: '令牌不对：请求头要带 Authorization: Bearer <token>' });
      return;
    }

    try {
      if (pathname === '/search' && req.method === 'GET') {
        const keyword = String(url.searchParams.get('q') || '').trim();
        if (!keyword) throw Object.assign(new Error('缺少 q 参数（搜什么）'), { code: 'E_ARGS' });
        const items = await source.search(keyword, { limit: config.source.limit });
        sendJson(res, 200, { ok: true, items });
        return;
      }

      /**
       * OpenAI 兼容的 /v1/audio/speech —— 给宿主自带的「发语音(send_voice)」用。
       *
       * 宿主那条路是：文字 → POST /audio/speech → 音频字节 → record 段（QQ 语音条）。
       * 所以我们在这里接住"唱歌"意图：识别到就现唱现返回，宿主会把歌声当成语音条发出去。
       * 这条路的好处是**不用给宿主加能力**，也不用发群文件。
       */
      if ((pathname === '/v1/audio/speech' || pathname === '/audio/speech') && req.method === 'POST') {
        const body = await readJsonBody(req);
        const input = String(body.input ?? body.text ?? '').trim();
        if (!input) throw Object.assign(new Error('缺少 input（要唱的歌名或要说的话）'), { code: 'E_ARGS' });
        const song = extractSongRequest(input, { bareTitle: config.intent?.bareTitle === true });
        if (!song) {
          // 不是点歌 → 说话（TTS）。宿主 send_voice 指向本网关后，机器人"想说话"也会打到这里，
          // 以前一律回"只会唱歌"，宿主只好退回文字；现在直接读出来发语音条。
          if (say.name === 'none') {
            throw Object.assign(new Error(
              '这个网关既没接换声唱歌、也没开 TTS（config.say.engine = none）。'
              + '想让机器人说话请把 say.engine 设成 breeze（并在插件里填 API Key）；想让它唱，就用「唱：歌名」的格式调用。'
            ), { code: 'E_NOT_TTS' });
          }
          // emotion / tone 是可选的情绪通道：宿主或调用方想指定语气时传
          await handleSay(req, res, input, { emotion: body.emotion ?? body.tone ?? '' });
          return;
        }
        // 语音条能有多长，取决于协议端与服务端策略，不是固定 60 秒：
        // 用 config.voiceMessageMaxSeconds 自己试（默认 120）。被拒就调小。
        const cap = Math.max(5, Number(config.voiceMessageMaxSeconds) || 300);
        // 0 有特殊含义：唱完整首（不裁剪）。其余按秒数夹紧。
        const asked = body.maxSeconds === undefined ? null : Number(body.maxSeconds);
        const wanted = asked ?? (runtimeVoiceSeconds ?? config.voiceMessageDefaultSeconds ?? 90);
        const maxSeconds = wanted === 0 ? 0 : Math.min(cap, Math.max(5, wanted));
        const job = queue.create({
          song,
          voice: String(body.voice ?? '').trim(),
          maxSeconds,
          itemId: ''
        });
        // 截止时间 = 演唱时长（秒→毫秒）+ 5 分钟余量（分离/加载/转码都算进去）
        // maxSeconds === 0 表示整首：这时预算要用 config.maxSeconds，否则 Math.min(…,0) 会把
        // 等待时间压成 0 + 5 分钟，4 分钟的歌必然超时（2026-10-29 实测 301 秒被掐）。
        const budgetSeconds = maxSeconds > 0
          ? Math.min(config.maxSeconds, maxSeconds)
          : Math.max(60, Number(config.maxSeconds) || 300);
        const finished = await waitForJob(job.jobId, budgetSeconds * 1000 + 300000);
        if (finished.state !== 'done') {
          sendJson(res, 500, { ok: false, message: finished.error || '唱失败了' });
          return;
        }
        let name = path.basename(finished.audioUrl);
        let file = path.join(filesDir, name);
        let buffer = fs.readFileSync(file);
        // 语音条通道有两条硬约束：宿主只收 ≤4MB，而且它按 response_format 当压缩音频用。
        // 所以这里不直接把成品甩出去 —— 不是 mp3 或超过 3.5MB，就现转一份（96k，仍大就 64k）。
        if (!/\.mp3$/i.test(name) || buffer.length > 3.5 * 1024 * 1024) {
          const converted = path.join(tmpDir, `voice-send-${job.jobId}.mp3`);
          // transcodeTo 的契约是"失败返回 false、不抛"（见 audio.mjs），这里直接看返回值
          let ok = await transcodeTo(file, converted, { ext: 'mp3' });
          // 逐级降码率：96k → 64k → 48k。宿主只收 4MB，10 分钟的歌 64k 也会超。
          for (const bitrate of ['64k', '48k']) {
            if (!ok || !fs.existsSync(converted) || fs.statSync(converted).size <= 3.5 * 1024 * 1024) break;
            console.log(`[voice] 成品仍超过 3.5MB，降到 ${bitrate} 再试`);
            ok = await transcodeTo(file, converted, { ext: 'mp3', bitrate });
          }
          if (ok && fs.existsSync(converted)) {
            name = path.basename(converted);
            file = converted;
            buffer = fs.readFileSync(file);
            console.log(`[voice] 已转码为 mp3（${Math.round(buffer.length / 1024)} KB）供语音条发送`);
          } else if (buffer.length > 3.5 * 1024 * 1024) {
            // 真的超限又转不了：如实失败，不要把注定被宿主拒收的东西发出去
            throw Object.assign(
              new Error(`成品 ${Math.round(buffer.length / 1024 / 1024 * 10) / 10}MB 超过宿主 4MB 上限，且没有可用的 ffmpeg 转码`),
              { code: 'E_TOO_LARGE' });
          } else {
            // 没超限：原样发送（格式不是 mp3 但宿主能收），不因为转码失败就整单失败
            console.log(`[voice] 转码不可用，按原格式发送（${Math.round(buffer.length / 1024)} KB）`);
          }
        }
        // 真实时长放在响应头里：宿主默认是"按字数估"（唱：夜曲 = 4 字 → 1 秒），
        // 会把 90 秒的语音说成 1 秒。宿主愿意读这个头就能显示对（见 docs/PATCHES.md）。
        const finishedJob = queue.get(job.jobId);
        const audioSeconds = Math.max(0, Math.round(Number(finishedJob?.seconds) || 0));
        res.writeHead(200, {
          'content-type': CONTENT_TYPES[path.extname(name).toLowerCase()] || 'audio/mpeg',
          'content-length': buffer.length,
          'x-audio-seconds': String(audioSeconds)
        });
        res.end(buffer);
        return;
      }

      // 定时清理入口（插件 schedule / 手动 curl 都能调）：删掉"今天以前"的成品
      if (pathname === '/admin/prune' && req.method === 'POST') {
        const result = pruneBeforeToday();
        console.log(`[prune] 清理 ${result.removed} 个昨日成品（${Math.round(result.bytes / 1024)} KB）`);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      // ── 说话（Breeze）──────────────────────────────────────
      // 插件页要显示「后端在线」+ 音色列表 + 余额，所以这三个口都给插件用（Bearer 鉴权）。
      if (pathname === '/say/status' && req.method === 'GET') {
        const fresh = url.searchParams.get('fresh') === '1';
        const status = await say.status({ fresh });
        // 本地模型闲置退出后进程不在，但"能服务"——不该让插件显示成离线。
        // 只要配置齐（python + 权重目录都在），就算 idle 也报在线，附一句说明。
        let { online, note } = status;
        const localRunning = localSay.running();
        if (config.say.engine === 'breeze-local' && !localRunning) {
          const canStart = Boolean(config.say.localPython && config.say.localModelDir)
            && fs.existsSync(config.say.localModelDir);
          if (canStart) {
            online = true;
            note = note && note.includes('本地服务没起来')
              ? '闲置中，说话时自动加载'
              : (note || '闲置中，说话时自动加载');
          }
        }
        sendJson(res, 200, {
          ok: true,
          ...status,
          online,
          note,
          localRunning,
          idleMs: Number(config.say.localIdleMs) || 0,
          // 情绪通道：插件页/排错时能直接看出"哪些标记可用"
          emotionTag: config.say.emotionTag !== false,
          emotions: emotionList(config.say.emotions).map((e) => e.id)
        });
        return;
      }

      if (pathname === '/say/voices' && req.method === 'GET') {
        try {
          const items = await say.listVoices();
          sendJson(res, 200, { ok: true, items });
        } catch (error) {
          sendJson(res, 502, { ok: false, message: String(error?.message ?? error).slice(0, 240) });
        }
        return;
      }

      // 插件把设置里的 Breeze Key / 音色推上来（幂等）。带 replace:true 时完整覆盖、空值=清除；
// 插件永远带 replace —— 它把自己当作唯一真相源。
      if (pathname === '/say/config' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (typeof say.setCredentials === 'function') {
          say.setCredentials({
            apiKey: body.apiKey,
            voiceId: body.voiceId,
            // replace: true → 完整覆盖（空值=清除）；否则只更新非空项
            replace: body.replace === true
          });
        }
        saveRuntimeState();
        const creds = typeof say.credentials === 'function' ? say.credentials() : {};
        console.log(`[say] 配置已更新：key=${creds.apiKey ? '已设置' : '空'} 音色=${creds.voiceId || '空'}`);
        sendJson(res, 200, { ok: true, hasKey: Boolean(creds.apiKey), voiceId: creds.voiceId || '' });
        return;
      }

      // 插件把设置里的「语音条秒数」推上来（幂等，随便多调几次没关系）
      if (pathname === '/admin/voice-seconds' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const cap = Math.max(5, Number(config.voiceMessageMaxSeconds) || 300);
        const raw = Math.floor(Number(body.seconds) || 0);
        // 0 = 整首；其余夹在 5..cap
        const seconds = raw === 0 ? 0 : Math.min(cap, Math.max(5, raw));
        runtimeVoiceSeconds = seconds;
        saveRuntimeState();
        console.log(`[admin] 语音条默认时长设为 ${seconds === 0 ? '整首（不裁剪）' : `${seconds} 秒`}`);
        sendJson(res, 200, { ok: true, seconds, cap });
        return;
      }

      if (pathname === '/sing' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const song = String(body.song ?? '').trim();
        if (!song) throw Object.assign(new Error('缺少 song 参数（歌名）'), { code: 'E_ARGS' });
        if (song.length > 60) throw Object.assign(new Error('歌名过长（≤60 字）'), { code: 'E_ARGS' });
        const job = queue.create({
          song,
          voice: String(body.voice ?? '').trim(),
          maxSeconds: Number(body.maxSeconds) || config.maxSeconds,
          itemId: body.id === undefined ? '' : String(body.id)
        });
        sendJson(res, 202, { ok: true, jobId: job.jobId, state: job.state, engine: voice.name });
        return;
      }

      const jobMatch = /^\/jobs\/([A-Za-z0-9]{1,64})$/.exec(pathname);
      if (jobMatch && req.method === 'GET') {
        const job = queue.get(jobMatch[1]);
        if (!job) { sendJson(res, 404, { ok: false, message: '没有这个任务（可能已过期）' }); return; }
        sendJson(res, 200, queue.view(job));
        return;
      }

      const fileMatch = /^\/files\/([^/]+)$/.exec(pathname);
      if (fileMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        const name = decodeURIComponent(fileMatch[1]);
        if (!FILE_NAME_RE.test(name)) { sendJson(res, 400, { ok: false, message: '文件名不合法' }); return; }
        const file = path.join(filesDir, name);
        if (!fs.existsSync(file)) { sendJson(res, 404, { ok: false, message: '文件不在了（可能已被清理）' }); return; }
        const stat = fs.statSync(file);
        res.writeHead(200, {
          'content-type': CONTENT_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream',
          'content-length': stat.size,
          'cache-control': 'no-store'
        });
        if (req.method === 'HEAD') { res.end(); return; }
        fs.createReadStream(file).pipe(res);
        return;
      }

      sendJson(res, 404, { ok: false, message: `没有这个接口：${req.method} ${pathname}` });
    } catch (error) {
      const code = String(error?.code ?? '');
      const status = (code === 'E_ARGS' || code === 'E_NOT_TTS') ? 400 : code === 'E_TOO_BIG' ? 413 : 500;
      sendJson(res, status, { ok: false, message: String(error?.message ?? error) });
    }
  };

  return { handler, queue, filesDir, tmpDir, pruneFiles, pruneBeforeToday, say, gpu: gpuSlot, draw: drawProxy, localSay };
}
