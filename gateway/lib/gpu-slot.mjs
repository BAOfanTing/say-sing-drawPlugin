// GPU 槽：把"吃显存的活"串行化。
//
// 背景：这台机器上有三个租户抢同一张 10 GB 卡 —— 换声（整首峰值约 9 GB）、本地 Breeze TTS（8.2 GB）、
// 画图（7.24 GB）。两两都不能共存，所以"谁先跑、谁等谁"必须是**一条规则**，而不是每个调用点
// 各写一遍成对检查：那套 O(n²) 协调每加一个新负载就要回头改所有旧负载，漏一条边就是两个一起
// 掉进 Windows 共享内存（实测从 90 秒变 13 分钟）。
//
// 这里只做一件事：同一时刻只允许一个租户持有槽位，其余排队（先到先得，不抢占）。
// 谁需要"把别的租户的显存腾出来"（比如唱歌/画图前停本地 TTS）仍然由调用方自己决定，
// 那属于业务语义；本模块只保证互斥。
//
// 用法：
//   const gpu = createGpuSlot({ now });
//   const png = await gpu.run('draw', async () => { … });
//   gpu.owner()   // '' | 'sing' | 'say' | 'draw'  （给 /health 和"要不要退回云端"用）
//   gpu.busy()    // 有没有人在跑
export function createGpuSlot({ now = () => Date.now(), onWait = null } = {}) {
  let tail = Promise.resolve();
  let owner = '';
  let queued = 0;
  const stats = { runs: 0, maxWaitMs: 0, lastWaitMs: 0 };

  /**
   * 在槽位上跑 fn。kind 只用于观测/日志（'sing' | 'say' | 'draw' | 任意字符串）。
   * 返回 fn 的值；fn 抛错则原样抛出（不影响后续排队者）。
   */
  const run = async (kind, fn) => {
    if (typeof fn !== 'function') throw new Error('gpu.run(kind, fn) 需要一个函数');
    const label = String(kind || 'task');
    const startedAt = now();
    queued += 1;
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    try {
      await previous;                       // 排队：等前一个释放
      queued -= 1;
      const waitedMs = Math.max(0, now() - startedAt);
      stats.runs += 1;
      stats.lastWaitMs = waitedMs;
      if (waitedMs > stats.maxWaitMs) stats.maxWaitMs = waitedMs;
      if (waitedMs > 0 && typeof onWait === 'function') {
        try { onWait({ kind: label, waitedMs }); } catch { /* 观测回调出错不能影响正事 */ }
      }
      owner = label;
      try {
        return await fn();
      } finally {
        owner = '';
      }
    } finally {
      release();
      // 排队中途被别处 release 掉（正常不会发生）时，别把计数漏掉
      if (queued < 0) queued = 0;
    }
  };

  return {
    run,
    owner: () => owner,
    busy: () => owner !== '',
    waiting: () => queued,
    stats: () => ({ ...stats })
  };
}
