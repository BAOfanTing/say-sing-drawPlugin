// 纯函数层：不碰 stdin/stdout、不发请求 —— 方便单测，也让 index.mjs 只剩协议接线。
// 契约见 docs/PROTOCOL.md（网关）与宿主仓库 docs/PLUGINS.md（插件协议）。

export const DEFAULTS = Object.freeze({
  gatewayUrl: '',
  defaultVoice: '',
  // 语音条（宿主 send_voice 通道）唱多久：插件会把改这个值推给网关
  voiceSeconds: 120,
  allowInsecureHttp: false,
  pollIntervalMs: 2000
});

const clampInt = (value, min, max, fallback) => {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** 去掉尾部斜杠：网关地址是 "https://x.trycloudflare.com/"，拼路径时不能出现 "//"。 */
export function joinUrl(base, pathname) {
  const head = String(base ?? '').trim().replace(/\/+$/, '');
  const tail = String(pathname ?? '').replace(/^\/+/, '');
  if (!head) return '';
  return tail ? `${head}/${tail}` : head;
}

/**
 * 校验并规范化网关地址。
 * 默认只收 https：插件进程拿到的 token 会随每次请求发出去，明文 http 等于把 token 送给链路中间人。
 * 局域网自建（如 http://192.168.1.5:8899）需要显式打开 allowInsecureHttp —— 而且宿主的
 * cap.http.request 强制 allowPrivate:false，内网地址本来就发不出去。
 */
export function normalizeGatewayUrl(raw, { allowInsecureHttp = false } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('没有配置网关地址：控制台 → 插件 → 点歌唱歌 → 「网关地址」');
  let url;
  try { url = new URL(text); } catch { throw new Error(`网关地址不是合法 URL：${text}`); }
  if (url.protocol !== 'https:' && !(allowInsecureHttp && url.protocol === 'http:')) {
    throw new Error('网关地址必须是 https://（要临时用 http 请在插件设置里打开「允许 HTTP」）');
  }
  if (url.protocol === 'http:' && isPrivateHost(url.hostname)) {
    throw new Error('宿主禁止插件访问内网/本机地址：http 只在公网域名下有意义，本机网关请用隧道暴露成 https');
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

/** 与宿主 cap.http 的内网判定保持一致的最小集（只用于给出可读的报错，不是安全边界）。 */
export function isPrivateHost(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    return false;
  }
  if (host === '::1' || host === '[::1]' || host.startsWith('fe80:') || host.startsWith('fd') || host.startsWith('fc')) return true;
  return false;
}

/** 插件设置（宿主 plugins.settings.sing）→ 收敛后的结构；非法值一律退回默认而不是抛错。 */
export function normalizeSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    gatewayUrl: String(input.gatewayUrl ?? DEFAULTS.gatewayUrl).trim(),
    defaultVoice: String(input.defaultVoice ?? DEFAULTS.defaultVoice).trim(),
    // 0 = 唱完整首（网关会分段换声，每段留在显存安全区）；其余 5..600 秒
    voiceSeconds: Number(input.voiceSeconds) === 0 ? 0 : clampInt(input.voiceSeconds, 5, 600, DEFAULTS.voiceSeconds),
    allowInsecureHttp: input.allowInsecureHttp === true,
    pollIntervalMs: clampInt(input.pollIntervalMs, 1000, 10000, DEFAULTS.pollIntervalMs),
    breezeEmail: String(input.breezeEmail ?? '').trim(),
    breezeAutoClaim: input.breezeAutoClaim !== false,
  };
}

/** 点歌名：只做最小清洗（宿主已经过 sanitizeUserText），空/超长在这里拦住并给出人话。 */
export function normalizeSongName(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('要唱哪首歌？把歌名告诉我（可以带歌手，例如「孤勇者 陈奕迅」）');
  if (text.length > 60) throw new Error(`歌名太长（${text.length} 字），60 字以内更容易搜到`);
  return text;
}

/** 音色：留空表示用网关默认音色。 */
export function normalizeVoice(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(text)) throw new Error('音色名只能用字母/数字/点/下划线/连字符（≤40 位）');
  return text;
}

/** 请求头：Bearer token 只在配置了才带。 */
export function authHeaders(token) {
  const value = String(token ?? '').trim();
  return value ? { authorization: `Bearer ${value}` } : {};
}

/** 秒 → "1分03秒"，给模型和用户看的短句。 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!total) return '';
  const min = Math.floor(total / 60);
  const sec = total % 60;
  if (!min) return `${sec} 秒`;
  return sec ? `${min} 分 ${sec} 秒` : `${min} 分`;
}


/** 把宿主能力调用抛出的错误转成"模型能据此行动"的短句。 */
export function describeError(error) {
  const code = String(error?.code ?? '').trim();
  const message = String(error?.message ?? error ?? '').trim() || '未知错误';
  const hint = {
    E_DOMAIN: '（网关域名不在插件白名单里？把网关地址填成宿主允许的公网 https 域名）',
    E_TOO_BIG: '（音频超过宿主 80MB 上限，把 maxSeconds 调小）',
    E_NO_SENDER: '（宿主当前没有可用的发送队列）',
    E_MEDIA_TOOL: '（宿主调 ffmpeg 失败，检查服务器上装了没有）'
  }[code] || '';
  return `${message}${hint}`;
}
