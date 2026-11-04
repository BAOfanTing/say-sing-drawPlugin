// 保命网：一个出图/换声后端出问题，不该把整个网关带走。
//
// 背景（2026-11-04 实测）：画图后端启动后卡死（进程还在、/health 不应答），
// 网关的重试路径里冒出一个没人接的 Promise 拒绝，Node 默认行为 = 直接 exit(1)，
// 于是"说话、翻唱、点歌"一起哑掉几秒（外面虽有守护重启，但正在跑的请求全废）。
//
// 这里的取舍：**记录并继续跑**，而不是崩。理由和网关自己的设计一致——
// 单个能力失败应当降级成 502 / 一句"唱不了"，不该影响其它能力。
// 真的需要崩的情况（比如端口被占、配置读不出来）在启动阶段就 exit 了，不靠这里。

/**
 * @param {object} [deps]
 * @param {NodeJS.Process|EventEmitter} [deps.proc] 默认 process（测试里可注入假的）
 * @param {(msg: string) => void} [deps.log]
 * @returns {() => void} 卸载函数（测试用）
 */
export function installCrashGuard({ proc = process, log = (msg) => console.error(msg) } = {}) {
  if (!proc || typeof proc.on !== 'function') return () => {};

  const onRejection = (reason) => {
    const detail = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    log(`[fatal] 未捕获的 Promise 拒绝（网关继续运行）：${String(detail).slice(0, 800)}`);
  };

  const onException = (error) => {
    const detail = error instanceof Error ? (error.stack || error.message) : String(error);
    log(`[fatal] 未捕获的异常（网关继续运行）：${String(detail).slice(0, 800)}`);
  };

  proc.on('unhandledRejection', onRejection);
  proc.on('uncaughtException', onException);

  return () => {
    if (typeof proc.off === 'function') {
      proc.off('unhandledRejection', onRejection);
      proc.off('uncaughtException', onException);
    } else if (typeof proc.removeListener === 'function') {
      proc.removeListener('unhandledRejection', onRejection);
      proc.removeListener('uncaughtException', onException);
    }
  };
}
