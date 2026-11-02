// 换声：把"一段普通音频"变成"目标音色的歌声"。
//
// 这里刻意不做成"内置 RVC" —— 换声要用哪个模型、要不要先做人声分离（UVR）、用什么音高，
// 每个人都不一样，而且都是 GB 级依赖。所以只留一个**命令行接口**：
//
//   voice.command = "python infer_cli.py --in {input} --out {output} --pitch {pitch}"
//
// 支持两种传参方式，任选：
//   1) 花括号占位符：{input} {output} {pitch} {voice}（路径会被加引号，含空格也安全）
//   2) 环境变量：SING_INPUT / SING_OUTPUT / SING_PITCH / SING_VOICE
//
// 约定：跑完 output 必须存在且非空，否则算失败（不假装成功）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const quote = (value) => `"${String(value).replace(/"/g, '\\"')}"`;

function fillCommand(template, values) {
  // {maxSeconds} 是数字（不加引号），其余是路径/名字（加引号）
  return String(template)
    .replace(/\{maxSeconds\}/g, () => String(values.maxSeconds ?? 0))
    .replace(/\{segmentSeconds\}/g, () => String(values.segmentSeconds ?? 0))
    .replace(/\{(input|output|pitch|voice)\}/g, (_, key) => quote(values[key] ?? ''));
}

export function createVoiceEngine(config) {
  const engine = config.voice.engine;

  /** 不需要换声：直接把音源当成品（用于先跑通"点歌→发群"整条链路）。 */
  if (engine === 'none') {
    return {
      name: 'none',
      // 没有接换声模型，就不该报出任何"可用音色" —— 报一个假的比空列表更糟：
      // 使用者和模型都会以为能唱某个音色。
      voices: [],
      async convert({ input, output }) {
        fs.copyFileSync(input, output);
        return { engine: 'none', bytes: fs.statSync(output).size };
      }
    };
  }

  /**
   * 常驻换声客户端：一个 python 进程里模型只加载一次，之后每次请求只花 1-3 秒。
   * 之前每请求起一个进程，光加载模型就要 8-12 秒（说一句话 14 秒里 12 秒在加载）。
   *
   * 协议：stdin/stdout 各一行 JSON（见 sing-model/run.py 的 --serve）。
   * 空闲 serveIdleMs 后自动关掉，把显存还给系统；任何异常都退回"每次起进程"的老路。
   */
  function createResident(config) {
    const serveCommand = String(config.voice.serveCommand || '').trim();
    if (!serveCommand) return null;
    const idleMs = Math.max(60000, Number(config.voice.serveIdleMs) || 600000);

    let proc = null;
    let buffer = '';
    let nextId = 1;
    let idleTimer = null;
    const pending = new Map();   // id -> { resolve, reject, onProgress }

    const stop = (reason) => {
      if (!proc) return;
      const child = proc;
      proc = null;
      try { child.kill(); } catch { /* 忽略 */ }
      for (const [, entry] of pending) entry.reject(Object.assign(new Error(`常驻换声进程退出（${reason}）`), { code: 'E_SERVE_EXIT' }));
      pending.clear();
      console.log(`[voice] 常驻换声进程已关闭：${reason}`);
    };

    const touchIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop(`空闲 ${Math.round(idleMs / 60000)} 分钟`), idleMs);
      idleTimer.unref?.();
    };

    const ensure = () => {
      if (proc) return proc;
      // ffmpeg 在 %TEMP% 里写不出文件（实测 Permission denied），把子进程的 TEMP 指到仓库内
      const tmpForChild = path.join(config.dataDir || '.', 'tmp');
      try { fs.mkdirSync(tmpForChild, { recursive: true }); } catch { /* 忽略 */ }
      const child = spawn(serveCommand, {
        shell: true,
        windowsHide: true,
        env: { ...process.env, TEMP: tmpForChild, TMP: tmpForChild }
      });
      proc = child;
      child.stdout?.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          let message = null;
          try { message = JSON.parse(line); } catch { continue; }
          if (!message || message.id === undefined || message.id === null) continue;
          const entry = pending.get(message.id);
          if (!entry) continue;
          if (message.event) {
            try { entry.onProgress?.(message); } catch { /* 忽略 */ }
            continue;
          }
          pending.delete(message.id);
          if (message.ok) entry.resolve(message);
          else entry.reject(Object.assign(new Error(message.error || '常驻换声失败'), { code: 'E_SERVE' }));
        }
      });
      child.stderr?.on('data', (chunk) => {
        // run.py 的日志走 stderr，这里只留最后一点给报错用
        const text = chunk.toString('utf8').trim();
        if (text) console.log(`[voice] ${text.slice(-300)}`);
      });
      child.on('close', (code) => stop(`退出码 ${code}`));
      child.on('error', (error) => stop(`启动失败：${error.message}`));
      console.log('[voice] 常驻换声进程已启动（模型按音色缓存）');
      return child;
    };

    return {
      name: 'resident',
      async convert({ input, output, voice, maxSeconds = 0, onProgress = null }) {
        const child = ensure();
        const id = nextId++;
        const request = {
          id,
          input,
          output,
          voice: voice || config.voice.defaultVoice,
          pitch: Number(config.voice.pitch) || 0,
          maxSeconds: Math.max(0, Math.floor(Number(maxSeconds) || 0)),
          segmentSeconds: Math.max(0, Math.floor(Number(config.voice.segmentSeconds) || 0)),
          indexRate: 0.75,
          gpuFraction: Number(config.voice.gpuFraction) || 0,
          noSeparate: false
        };
        const done = new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject, onProgress });
        });
        touchIdle();
        child.stdin?.write(`${JSON.stringify(request)}\n`);
        try {
          return await done;
        } finally {
          pending.delete(id);
          touchIdle();
        }
      },
      shutdown: () => stop('手动关闭')
    };
  }

  const resident = createResident(config);

  // 一次性进程（老路，也是常驻失败时的兜底）
  const oneShot = ({ input, output, voice, maxSeconds = 0, onProgress = null, extra = '' }) => {
      const values = {
        input,
        output,
        pitch: String(config.voice.pitch),
        voice: voice || config.voice.defaultVoice,
        maxSeconds: String(Math.max(0, Math.floor(Number(maxSeconds) || 0))),
        segmentSeconds: String(Math.max(0, Math.floor(Number(config.voice.segmentSeconds ?? 75) || 0)))
      };
      const command = fillCommand(config.voice.command, values);
      const timeoutMs = config.voice.timeoutMs;
      return new Promise((resolve, reject) => {
        const child = spawn(command, {
          shell: true,
          windowsHide: true,
          env: {
            ...process.env,
            // 同上：%TEMP% 不可写，指向仓库内的 tmp
            TEMP: (() => { const d = path.join(config.dataDir || '.', 'tmp'); try { fs.mkdirSync(d, { recursive: true }); } catch { /* 忽略 */ } return d; })(),
            TMP: (() => { const d = path.join(config.dataDir || '.', 'tmp'); try { fs.mkdirSync(d, { recursive: true }); } catch { /* 忽略 */ } return d; })(),
            SING_INPUT: values.input,
            SING_OUTPUT: values.output,
            SING_PITCH: values.pitch,
            SING_VOICE: values.voice,
            SING_MAX_SECONDS: values.maxSeconds
          }
        });
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(Object.assign(new Error(`换声命令超时（${Math.round(timeoutMs / 1000)} 秒）`), { code: 'E_TIMEOUT' }));
        }, timeoutMs);
        child.stderr?.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          stderr += text.slice(-6000);
          // run.py 分段换声时会打印 [seg] 2/4 完成 —— 顺手转成进度，
          // 这样群里/控制台能看到正在唱第 2 段，而不是干等几分钟。
          if (typeof onProgress === 'function') {
            for (const line of text.split(/\r?\n/)) {
              const m = /\[seg\]\s*(\d+)\/(\d+)(.*)$/.exec(line.trim());
              if (m) {
                try { onProgress({ done: Number(m[1]), total: Number(m[2]), note: String(m[3] || '').trim() }); }
                catch { /* 进度回调出错不能影响换声 */ }
              }
            }
          }
        });
        child.stdout?.on('data', () => {});
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(Object.assign(new Error(`换声命令启动失败：${error.message}`), { code: 'E_SPAWN' }));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            reject(Object.assign(new Error(`换声命令退出码 ${code}：${stderr.split('\n').slice(-3).join(' ').slice(0, 400)}`), { code: 'E_PROCESS' }));
            return;
          }
          try {
            const stat = fs.statSync(output);
            if (!stat.size) throw new Error('换声命令没有产出文件（output 是空的）');
            resolve({ engine: 'command', bytes: stat.size });
          } catch (error) {
            reject(Object.assign(new Error(`换声命令跑完了但没有产物：${error?.message ?? error}`), { code: 'E_NO_OUTPUT' }));
          }
        });
      });
  };

  return {
    name: 'command',
    voices: [config.voice.defaultVoice].filter(Boolean),
    async convert({ input, output, voice, maxSeconds = 0, onProgress = null }) {
      // 常驻优先：省掉每次 8-12 秒的模型加载。任何失败都退回一次性进程。
      if (resident) {
        try {
          return await resident.convert({ input, output, voice, maxSeconds, onProgress });
        } catch (error) {
          console.warn(`[voice] 常驻换声失败，退回一次性进程：${String(error?.message ?? error).slice(0, 160)}`);
        }
      }
      return oneShot({ input, output, voice, maxSeconds, onProgress });
    },
    oneShot,
    shutdown: () => resident?.shutdown()
  };
}
