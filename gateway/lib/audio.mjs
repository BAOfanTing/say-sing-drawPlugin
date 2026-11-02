// ffmpeg / ffprobe 包装：没有 ffmpeg 就如实降级（不假装成功）。
// 全部走 spawn + 参数数组，不经 shell —— 文件名里有空格或引号也不会被解释成命令。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let ffmpegPath = null;
let probed = false;

export function runProcess(command, args, { timeoutMs = 300000, env = null } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { env: { ...process.env, ...(env || {}) }, windowsHide: true });
    } catch (error) {
      reject(Object.assign(new Error(`无法启动 ${command}：${error.message}`), { code: 'E_SPAWN' }));
      return;
    }
    let stderr = '';
    let stdout = '';
    const timer = setTimeout(() => {
      // Windows 上 child.kill 只杀直接子进程；run.py 的孙进程会活下来霸占 GPU。
      // 这里用 taskkill /T 把整棵树收掉（2026-10-29 踩过：孤儿进程空转 9 小时）。
      if (process.platform === 'win32' && child.pid) {
        try { spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }); } catch { /* 忽略 */ }
      }
      child.kill('SIGKILL');
      reject(Object.assign(new Error(`${command} 超时（${Math.round(timeoutMs / 1000)} 秒）`), { code: 'E_TIMEOUT' }));
    }, timeoutMs);
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8').slice(-8000); });
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8').slice(-8000); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`无法启动 ${command}：${error.message}`), { code: 'E_SPAWN' }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ code, stderr, stdout });
      // 把完整 stderr 也挂在错误上：ffmpeg -i 的关键信息（Duration）在开头，
      // 只看消息里那 3 行会被截掉（probeSeconds 的兜底解析要用）。
      else reject(Object.assign(
        new Error(`${command} 退出码 ${code}：${stderr.split('\n').slice(-3).join(' ').slice(0, 400)}`),
        { code: 'E_PROCESS', stderr, stdout }
      ));
    });
  });
}

/** ffmpeg 的候选位置：环境变量 → 仓库自带的 sing-model/bin → PATH。
 *
 * 为什么不能只试 'ffmpeg'：手动起网关时 PATH 里通常没有 ffmpeg，
 * 结果转码静默跳过、把 6.87MB 的 wav 直接发给宿主，被 4MB 上限拒收（2026-10-29 实际踩过）。
 */
function ffmpegCandidates() {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const list = [];
  if (process.env.FFMPEG_PATH) list.push(process.env.FFMPEG_PATH);
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));   // gateway/lib
    const repo = path.resolve(here, '..', '..');
    list.push(path.join(repo, 'sing-model', 'bin', `ffmpeg${exe}`));
  } catch { /* 拿不到路径就跳过 */ }
  list.push('ffmpeg');
  return list;
}

/** 同一个目录里找 ffprobe（换名字即可）。 */
function siblingProbe(ffmpegBin) {
  if (!ffmpegBin || ffmpegBin === 'ffmpeg') return 'ffprobe';
  return ffmpegBin.replace(/ffmpeg(\.exe)?$/i, (m, ext) => `ffprobe${ext || ''}`);
}

/** 只探测一次：ffmpeg 在不在。 */
export async function detectFfmpeg() {
  if (probed) return ffmpegPath;
  probed = true;
  for (const candidate of ffmpegCandidates()) {
    try {
      await runProcess(candidate, ['-version'], { timeoutMs: 8000 });
      ffmpegPath = candidate;
      return ffmpegPath;
    } catch { /* 换下一个 */ }
  }
  ffmpegPath = '';
  return ffmpegPath;
}

/**
 * 时长（秒）；拿不到就返回 0（调用方按"不知道"处理，不编造数字）。
 *
 * 优先 ffprobe；没有 ffprobe 时退回解析 `ffmpeg -i` 输出里的 `Duration:` 行 ——
 * 我们分发的包里只有 ffmpeg.exe，缺 ffprobe 时以前会一直返回 0，
 * 宿主那边就会按字数估算，出现"说 6 秒、实际 2 秒"的偏差。
 */
export async function probeSeconds(file) {
  const bin = (await detectFfmpeg()) || 'ffmpeg';

  // 1) ffprobe（最准）
  try {
    const { stderr } = await runProcess(siblingProbe(bin), [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file
    ], { timeoutMs: 20000 });
    const seconds = Number.parseFloat(String(stderr).trim());
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  } catch { /* 没 ffprobe，往下走 */ }

  // 2) ffmpeg -i 的 stderr（注意：不给输出文件时 ffmpeg 退出码是 1，这里要容忍）
  try {
    const result = await runProcess(bin, ['-hide_banner', '-i', file], { timeoutMs: 20000 });
    const text = String(result?.stderr || '');
    const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
    if (match) {
      const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      if (Number.isFinite(seconds) && seconds > 0) return seconds;
    }
  } catch (error) {
    // runProcess 在非零退出码时会 reject，但 stderr 已经带在错误里
    const text = String(error?.stderr || error?.message || '');
    const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
    if (match) {
      const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      if (Number.isFinite(seconds) && seconds > 0) return seconds;
    }
  }
  return 0;
}

/**
 * 裁到 maxSeconds 并转成目标格式。ffmpeg 不可用时原样返回 false，
 * 让上层决定"发原文件"还是"报错"，而不是偷偷给出一个坏文件。
 */
export async function transcodeTo(input, output, { maxSeconds = 0, ext = 'mp3', bitrate = '96k' } = {}) {
  const bin = await detectFfmpeg();
  if (!bin) return false;
  const args = ['-y', '-i', input];
  if (maxSeconds > 0) args.push('-t', String(Math.floor(maxSeconds)));
  if (ext === 'mp3') args.push('-vn', '-ac', '1', '-ar', '32000', '-b:a', bitrate);
  args.push(output);
  await runProcess(bin, args, { timeoutMs: 120000 });
  return true;
}

/**
 * 只改音高、不改速度（rubberband）。
 *
 * 用来做"音高归一"：同一个音色每次合成的基频会飘 ±25 Hz（约 1 个半音），
 * 听感上就像换了个人。把每句都拉到同一个目标基频，一致性会好很多。
 */
export async function shiftPitch(input, output, ratio, { ext = 'mp3', bitrate = '96k' } = {}) {
  const bin = await detectFfmpeg();
  if (!bin) return false;
  // formant=preserved 很关键：默认是 shifted，会把共振峰跟着音高一起移，
  // 听感上就像换了个人（2026-10-31 实测：四句话被移调 2-3 个半音后音色各异）。
  const args = ['-y', '-i', input, '-af',
    `rubberband=pitch=${Number(ratio).toFixed(4)}:formant=preserved:pitchq=quality`];
  if (ext === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', bitrate);
  args.push(output);
  try {
    await runProcess(bin, args, { timeoutMs: 120000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 套一条 ffmpeg 滤镜链（情绪加工用：提速/压缩/EQ/限幅）。
 *
 * 为什么不合成时就解决：`instructions` 改的是"发声方式"，而响度、硬度和节奏
 * 这些"后期味道"用 ffmpeg 做更可控、且**完全不碰音色**（实测音色相似度 0.986，
 * 合成时传 speed 反而是 0.944）。滤镜串由 emotions.mjs 的预设给，这里只负责跑。
 *
 * ffmpeg 不可用或滤镜非法时返回 false —— 上层照常发未加工的音频，别把语音整单搞死。
 */
export async function applyFilter(input, output, filter, { ext = 'mp3', bitrate = '128k' } = {}) {
  const chain = String(filter ?? '').trim();
  if (!chain) return false;
  const bin = await detectFfmpeg();
  if (!bin) return false;
  const args = ['-y', '-i', input, '-af', chain];
  if (ext === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', bitrate);
  else args.push('-c:a', 'pcm_s16le');
  args.push(output);
  try {
    await runProcess(bin, args, { timeoutMs: 120000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 把多段音频首尾相接成一段（各段格式可以不同：wav/mp3 混着也行）。
 *
 * 为什么要分段再拼：Breeze 一次生成多句长文本时，音高会句间漂移
 * （实测 12 秒回复里 340→396→380→340 Hz，差 2.5 个半音），
 * 整段做一次音高归一救不了段内漂移；切句逐段归一才拉得齐。
 */
export async function concatAudio(files, output, { ext = 'wav' } = {}) {
  const bin = await detectFfmpeg();
  if (!bin || files.length === 0) return false;
  if (files.length === 1) {
    try { fs.copyFileSync(files[0], output); return true; } catch { return false; }
  }
  const args = ['-y'];
  for (const file of files) args.push('-i', file);
  const filter = `${files.map((_, i) => `[${i}:a]`).join('')}concat=n=${files.length}:v=0:a=1[out]`;
  args.push('-filter_complex', filter, '-map', '[out]');
  if (ext === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', '96k');
  else args.push('-c:a', 'pcm_s16le', '-ar', '24000', '-ac', '1');
  args.push(output);
  try {
    await runProcess(bin, args, { timeoutMs: 180000 });
    return true;
  } catch {
    return false;
  }
}
