// 本地 Breeze TTS 的生命周期 + 「把显存让出来」的策略。
//
// 为什么单独一个模块：这块和点歌流水线共享**只有一处**（"唱歌进行中不能动换声常驻"），
// 其余全是自洽的（起进程、等就绪、闲置回收、让位/恢复）。原来它和说话合成、点歌流水线
// 挤在同一个 1100 行闭包里，改本地模型参数得先读完搜歌换声那 300 行。
//
// 显存账（RTX 3080 10 GB）：
//   · 本地 Breeze eager 约 8.2-8.4 GB
//   · 换声常驻约 2.4 GB（现在默认按需，不再常驻）
//   · 出图 7.24 GB
// 三者两两不能共存，所以这里提供 yield()（停掉自己，把卡让给重活）和 resume()（需要时拉起来）。
import { spawn } from 'node:child_process';
import { createManagedModel } from './managed-model.mjs';

/**
 * @param {object} deps
 * @param {object} deps.config            需要 config.say（localUrl/localPython/localModelDir/localAppDir/
 *                                        localStartCmd/localStopCmd/localIdleMs）
 * @param {object} deps.voice             换声引擎（有 shutdown() 就用来"收掉常驻腾显存"）
 * @param {Function} deps.isSinging       () => 是否正在唱歌（唱歌时不许动换声常驻）
 * @param {Function} deps.runShell        执行 shell 命令（超时返回 false，不抛）
 * @param {Function} [deps.spawnFn]
 * @param {Function} [deps.fetchFn]
 * @param {Function} [deps.now]
 * @param {Function} [deps.log]
 */
export function createLocalSay({
  config,
  voice = {},
  isSinging = () => false,
  runShell,
  spawnFn = spawn,
  fetchFn = fetch,
  now = () => Date.now(),
  log = (msg) => console.log(msg),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  if (typeof runShell !== 'function') throw new Error('createLocalSay 需要 runShell()');
  const say = config?.say || {};

  let child = null;
  let alive = false;                 // start() 之后进程是否还活着（给 ManagedModel 判"早退"）
  let stopped = false;               // 上一次是我们主动停的（决定 resume 要不要真的拉起）
  let shutdownVoiceDone = false;

  const port = (() => {
    try { return new URL(say.localUrl || 'http://127.0.0.1:7860').port || '7860'; } catch { return '7860'; }
  })();

  const healthRaw = async () => {
    const response = await fetchFn(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  };

  const model = createManagedModel({
    name: 'local-say',
    idleMs: Number(say.localIdleMs) || 0,
    startTimeoutMs: 240000,
    pollMs: 1000,
    now,
    log,
    health: healthRaw,
    isDead: () => alive === false,
    /** 只负责"拉起来"；等就绪的轮询由 ManagedModel 统一做。 */
    start: async () => {
      const python = String(say.localPython || '').trim();
      const modelDir = String(say.localModelDir || '').trim();
      if (!python || !modelDir) {
        // 没配内置管理就退回用户给的命令
        if (!say.localStartCmd) return false;
        const ok = await runShell(say.localStartCmd, 240000);
        alive = ok;
        return ok;
      }
      // say-model 根目录（PYTHONPATH 要它）：优先用显式配置，否则从 .../weights/<名字> 反推
      const root = String(say.localAppDir || '').trim()
        || modelDir.replace(/[\\/]weights[\\/].*$/i, '');
      log(`[say] 启动本地 Breeze：${python}（端口 ${port}）`);
      child = spawnFn(python, ['-m', 'breeze_infer.api', modelDir, '--host', '127.0.0.1', '--port', port], {
        cwd: root,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONPATH: root,
          PYTHONIOENCODING: 'utf-8',
          TORCHINDUCTOR_USE_STATIC_CUDA_LAUNCHER: '0'
        }
      });
      alive = true;
      child.stderr?.on('data', (chunk) => {
        const text = chunk.toString('utf8').trim();
        if (text) log(`[say-local] ${text.slice(-300)}`);
      });
      child.on('close', (code) => {
        log(`[say] 本地 Breeze 进程退出（code=${code}）`);
        child = null;
        alive = false;
      });
      return true;
    },
    stop: async () => {
      alive = false;
      if (child && child.pid) {
        if (process.platform === 'win32') {
          try { spawnFn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }); } catch { /* 忽略 */ }
        }
        try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
        child = null;
      }
      if (say.localStopCmd) await runShell(say.localStopCmd, 60000);
      // 等显存真的释放（torch 退出到驱动回收有延迟）
      for (let i = 0; i < 10; i += 1) {
        if (!(await healthRaw())) break;
        await sleep(500);
      }
    }
  });

  const healthy = () => model.healthy();
  const running = () => Boolean(child && child.exitCode === null);

  /** 唱歌/画图前调用：把本地 TTS 停掉，把显存让出来。
   *
   * 这里以前有个坑：`if (config.say.engine !== 'breeze-local') return` ——
   * 配 `auto` 时等于永远空转，可 auto 落本地后 TTS 一样会驻留 8.2 GB。
   * 现在按"实际上在不在跑"判断。
   */
  const yieldToHeavy = async () => {
    if (running()) {
      log('[say] 有重活要占显存，先停掉本地 TTS');
      await model.shutdown('让位给重活');
      stopped = true;
      return true;
    }
    if (!(await healthy())) return false;         // 端口没开 = 本来就没占显存
    if (say.localStopCmd) {
      log('[say] 本地 TTS 还占着端口，停掉它');
      await model.shutdown('让位给重活');
    }
    stopped = true;
    return true;
  };

  /** 说话前调用：确保本地 TTS 在跑（已就绪就只做一次健康检查，几毫秒）。 */
  const resume = async () => {
    if (!['breeze-local', 'auto'].includes(say.engine)) return false;
    if (running()) return true;
    if (!stopped && (await healthy())) return true;
    // 正在唱歌时绝对不能 shutdown 换声常驻 —— 那会把队列里这首歌直接弄死。
    // 交给调用方退回云端（auto）或稍后重试（breeze-local）。
    if (isSinging()) {
      log('[say] 唱歌进行中，暂不动换声常驻进程');
      return false;
    }
    // 换声常驻闲着也占 2.4 GB；本地 TTS 要 8.2 GB，10 GB 卡上会顶到颠簸
    // （实测挤在一起时一句要 435 秒）。所以先把换声常驻收掉，下次唱歌它会自己重启。
    if (!shutdownVoiceDone && typeof voice.shutdown === 'function') {
      try {
        voice.shutdown();
        log('[say] 已收掉换声常驻进程，把显存让给本地 TTS');
        await sleep(3000);
      } catch { /* 忽略 */ }
      shutdownVoiceDone = true;
    }
    log('[say] 说话要用本地 TTS，正在加载模型…');
    const ok = await model.ensure();
    stopped = !ok;
    if (!ok) log('[say] 本地 TTS 没拉起来，将退回云端（如果配了 Key）');
    return ok;
  };

  return {
    model,
    healthy,
    running,
    yieldToHeavy,
    resume,
    // 薄封装：app.mjs 里的调用点不用改
    start: () => model.ensure(),
    stop: () => model.shutdown('让位或闲置'),
    cancelIdle: () => model.cancelIdle(),
    armIdle: () => model.armIdle(),
    status: () => ({ ...model.status(), port, stopped, voiceResidentShutdown: shutdownVoiceDone })
  };
}
