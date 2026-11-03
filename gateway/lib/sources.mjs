// 音源：把"歌名"变成"一段可下载的音频"。两种实现：
//
//   netease —— 网易云（默认）。中文曲库最全。搜索免登录；**取音频需要登录态**
//              （`source.neteaseCookie`，可用网关的 /login 扫码页拿到），
//              否则 VIP 曲只给 30 秒试听片段。
//   local   —— 你自己的音频目录（自录、自购、自己分离好的干声都行）。
//
// 刻意不接 Apple 的 30 秒试听段：它只有 30 秒，会让"点歌"变成"发 30 秒片段"，
// 用户很容易误以为是我们限制了时长（2026-10-29 实际踩过这个坑）。
import fs from 'node:fs';
import path from 'node:path';

const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.opus', '.aac']);

/** 文件名 → 便于搜的键（去扩展名、小写、压缩空白）。 */
const searchKey = (name) => name.replace(/\.[^.]+$/, '').replace(/[\s_]+/g, ' ').toLowerCase();

/**
 * 给搜索结果打分，避免"点《孤勇者》却唱了《孤獨患者》"这种事。
 * 规则很朴素：标题里出现查询词的给高分，歌手命中的再给点分；同分保持接口原顺序。
 */
export function scoreCandidate(item, query) {
  const tokens = searchKey(query).split(' ').filter((t) => t.length >= 1);
  if (!tokens.length) return 0;
  const title = searchKey(String(item?.title ?? ''));
  const artist = searchKey(String(item?.artist ?? ''));
  let score = 0;
  for (const token of tokens) {
    if (title === token) score += 5;
    else if (title.includes(token)) score += 3;
    else if (artist.includes(token)) score += 2;
  }
  if (tokens.length > 1 && tokens.every((t) => title.includes(t))) score += 2;
  return score;
}

function rankByScore(items, query) {
  return items
    .map((item, index) => ({ item, index, score: scoreCandidate(item, query) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((entry) => entry.item);
}

function assertSafeRelPath(rel) {
  const text = String(rel ?? '');
  if (!text || text.includes('..') || /[\\/]/.test(text)) throw new Error('local 音源只接受目录内的文件名（不含路径分隔符）');
  return text;
}

export function createNeteaseSource({ limit = 5, cookie = '', fetchFn = fetch } = {}) {
  // Cookie 可以在运行中更新（扫码登录成功后），所以不放常量
  let currentCookie = cookie;
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const baseHeaders = { 'user-agent': UA, referer: 'https://music.163.com/', accept: '*/*' };
  const headers = () => (currentCookie ? { ...baseHeaders, cookie: currentCookie } : baseHeaders);

  const search = async (keyword, { limit: limitOverride } = {}) => {
    const count = Math.min(20, Math.max(1, Number(limitOverride) || limit));
    const url = new URL('https://music.163.com/api/search/get/web');
    url.searchParams.set('s', keyword);
    url.searchParams.set('type', '1');
    url.searchParams.set('offset', '0');
    url.searchParams.set('limit', String(count));
    const response = await fetchFn(url, { headers: baseHeaders });
    if (!response.ok) throw new Error(`网易云搜索失败：HTTP ${response.status}`);
    const data = await response.json();
    const songs = Array.isArray(data?.result?.songs) ? data.result.songs : [];
    return rankByScore(
      songs.map((song) => ({
        id: String(song.id ?? ''),
        title: String(song.name ?? ''),
        artist: Array.isArray(song.artists)
          ? song.artists.map((a) => String(a?.name ?? '')).filter(Boolean).join(' / ')
          : '',
        durationSec: Math.round((Number(song.duration) || 0) / 1000),
        source: 'netease',
        // fee > 0 表示需要 VIP；只在错误提示里用（有 Cookie 的账号也可能放得出来）
        vip: Number(song.fee) > 0
      })),
      keyword
    ).slice(0, count);
  };

  /** 取网易云直链。没登录态时 VIP 曲会拿到 404/HTML（表现为"没有可播地址"）。 */
  const prepare = async (item, { tmpDir }) => {
    const id = String(item?.id ?? '').trim();
    if (!id) throw new Error('这条搜索结果没有 id，无法取音频');

    const outer = `https://music.163.com/song/media/outer/url?id=${encodeURIComponent(id)}.mp3`;
    const response = await fetchFn(outer, { headers: headers(), redirect: 'follow' });
    const type = String(response.headers.get('content-type') || '');
    if (!response.ok || !/^audio\//i.test(type)) {
      const why = item?.vip ? '这首歌在网易云需要 VIP' : '网易云没有给可播地址';
      throw new Error(
        `${why}（HTTP ${response.status}，${type || '无 content-type'}）。`
        + '二选一：① 网关打开 /login 用网易云 App 扫码登录（有 VIP 就能取原唱）；② 换一首免费的。'
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 4096) throw new Error('取到的音频太小，可能被拦了');
    const extByType = {
      'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/mp4': '.m4a',
      'audio/x-m4a': '.m4a', 'audio/wav': '.wav', 'audio/flac': '.flac'
    };
    const ext = extByType[type.split(';')[0].trim().toLowerCase()] || '.mp3';
    fs.mkdirSync(tmpDir, { recursive: true });
    const file = path.join(tmpDir, `src-${Date.now()}${ext}`);
    fs.writeFileSync(file, buffer);
    return { file, ext: ext.replace('.', ''), bytes: buffer.length, kind: 'netease' };
  };

  /** 扫码登录成功后由上层调用：立即生效，并可持久化到 config.json。 */
  const setCookie = (value) => { currentCookie = String(value || '').trim(); };

  return { type: 'netease', search, prepare, setCookie, getCookie: () => currentCookie,
    hasCookie: () => Boolean(currentCookie) };
}

export function createLocalSource({ dir, limit = 5 } = {}) {
  const list = () => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && AUDIO_EXT.has(path.extname(entry.name).toLowerCase()))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      throw new Error(`读不到本地音频目录 ${dir}：${error?.message ?? error}`);
    }
  };

  const search = async (keyword, { limit: limitOverride } = {}) => {
    const needle = searchKey(String(keyword ?? ''));
    const count = Math.min(20, Math.max(1, Number(limitOverride) || limit));
    const files = list();
    const matched = needle ? files.filter((name) => searchKey(name).includes(needle)) : files;
    return matched.slice(0, count).map((name) => ({
      id: name,
      title: name.replace(/\.[^.]+$/, ''),
      artist: '',
      durationSec: 0,
      source: 'local'
    }));
  };

  const prepare = async (item, { tmpDir }) => {
    const name = assertSafeRelPath(item?.id ?? item?.title);
    const source = path.join(dir, name);
    if (!source.startsWith(path.resolve(dir))) throw new Error('local 音源路径越界');
    if (!fs.existsSync(source)) throw new Error(`本地音频不见了：${name}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const file = path.join(tmpDir, `src-${Date.now()}${path.extname(name).toLowerCase()}`);
    fs.copyFileSync(source, file);
    return { file, ext: path.extname(file).replace('.', ''), bytes: fs.statSync(file).size, kind: 'local' };
  };

  return { type: 'local', search, prepare };
}

export function createSource(config) {
  if (config.source.type === 'local') {
    return createLocalSource({ dir: config.source.localDir, limit: config.source.limit });
  }
  return createNeteaseSource({ limit: config.source.limit, cookie: config.source.neteaseCookie });
}
