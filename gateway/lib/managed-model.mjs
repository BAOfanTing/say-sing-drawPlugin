// 「按需加载的本地模型」的通用壳：拉起 → 等就绪 → 闲置回收 → 需要时杀掉。
//
// 之前这套流程在网关里写了三遍，而且每个都不一样：
//   · 本地 Breeze TTS：spawn python + 自己轮询 /health + 自己的闲置计时
//   · 画图服务：spawn 一条命令 + 自己轮询 /health + 进程自己闲置退出
//   · 换声常驻：spawn 子进程 + stdin/stdout 协议 + 自己的闲置计时
// 第四个模型进来就要抄第四份。这里把"共同的形状"收成一个壳：
//
//   调用方只需要给三件事实：
//     health(): 现在算不算就绪（异步，抛错算不就绪）
//     start():  怎么拉起来（同步/异步都行；返回 false 表示放弃）
//     stop():   怎么收掉（可选；不给就只清闲置计时）
//   其余（并发去重、等就绪的轮询、闲置计时、就绪前后的一致性）都在这里。
//
// 注意：它只负责**单个模型**的生命周期，不负责"谁能用显卡"——那是 gpu-slot 的事。
export function createManagedModel({
  name = 'model',
  health,
  start,
  stop = null,
  idleMs = 0,
  startTimeoutMs = 180000,
  pollMs = 1000,
  now = () => Date.now(),
  log = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  isDead = null            // 可选：进程是否已经自己退了（早退要尽快报失败，别干等）
} = {}) {
  if (typeof health !== 'function') throw new Error('createManagedModel 需要 health()');
  if (typeof start !== 'function') throw new Error('createManagedModel 需要 start()');

  let inflight = null;         // 正在拉起的那次（并发请求合并成一次）
  let idleTimer = null;
  let stoppedReason = '';
  const stats = { starts: 0, stops: 0, failures: 0, lastError: '' };

  const cancelIdle = () => {
    if (idleTimer) { clearTimer(idleTimer); idleTimer = null; }
  };

  /** 就绪判定：抛错一律算"没就绪"（网络抖动不该把调用方打断）。 */
  const healthy = async () => {
    try {
      return Boolean(await health());
    } catch {
      return false;
    }
  };

  const ensure = async ({ force = false } = {}) => {
    if (!force && await healthy()) { cancelIdle(); return true; }
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        stats.starts += 1;
        const started = await start();
        if (started === false) {
          stats.failures += 1;
          stats.lastError = 'start() 返回 false';
          log(`[${name}] 启动被拒绝（没配启动命令？）`);
          return false;
        }
        const deadline = now() + Math.max(0, Number(startTimeoutMs) || 0);
        while (now() < deadline) {
          await new Promise((resolve) => setTimer(resolve, pollMs));
          if (await healthy()) { cancelIdle(); return true; }
          if (isDead && isDead()) {
            stats.failures += 1;
            stats.lastError = '进程启动即退出';
            log(`[${name}] 启动后立刻退出`);
            return false;
          }
        }
        stats.failures += 1;
        stats.lastError = `等就绪超时（${startTimeoutMs}ms）`;
        log(`[${name}] 等就绪超时（${Math.round(startTimeoutMs / 1000)}s）`);
        return false;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  /** 收掉：停闲置计时 → 调 stop() → 等它真的不通了（显存释放有延迟）。 */
  const shutdown = async (reason = '') => {
    cancelIdle();
    if (typeof stop !== 'function') return;
    stats.stops += 1;
    stoppedReason = String(reason || '');
    try {
      await stop(stoppedReason);
    } catch (error) {
      log(`[${name}] 停止失败：${String(error?.message ?? error).slice(0, 160)}`);
    }
  };

  /** 有活动就把闲置计时推到 idleMs 之后；idleMs<=0 表示永不自动回收。 */
  const armIdle = () => {
    cancelIdle();
    const ms = Number(idleMs) || 0;
    if (ms <= 0) return;
    idleTimer = setTimer(() => {
      idleTimer = null;
      log(`[${name}] 闲置 ${Math.round(ms / 1000)} 秒，回收显存`);
      void shutdown(`闲置 ${Math.round(ms / 1000)} 秒`);
    }, ms);
    idleTimer?.unref?.();
  };

  return {
    name,
    ensure,
    healthy,
    armIdle,
    cancelIdle,
    shutdown,
    status: () => ({
      name,
      idleMs: Number(idleMs) || 0,
      starting: Boolean(inflight),
      idleArmed: Boolean(idleTimer),
      lastStop: stoppedReason,
      ...stats
    })
  };
}
