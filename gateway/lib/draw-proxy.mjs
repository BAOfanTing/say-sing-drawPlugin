// 出图代理：把「宿主 ← 网关 ← 本地出图服务」这一段收成一个模块。
//
// 它负责三件事，彼此耦合很紧，散在 app.mjs 里会跟点歌流水线互相干扰：
//   1. 出图服务是「按需加载、闲置自退」的 —— 连不上就先拉起来（ManagedModel）
//   2. 三个吃显存的租户共用一个 GPU 槽 —— 转发整段要在槽里，且先把本地 TTS 请走
//   3. 转发本身要抗抖：连不上/被掐断要重试一次，失败只能回 502，绝不能把网关带崩
//
// app.mjs 只保留路由：读 body → proxy.forward(raw) → 原样回写状态码与响应体。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createManagedModel } from './managed-model.mjs';

/**
 * @param {object} deps
 * @param {object} deps.config        需要 config.draw（url/token/timeoutMs/startCommand/startTimeoutMs）
 * @param {object} deps.gpu           createGpuSlot() 出来的槽位
 * @param {Function} deps.yieldLocalSay  转发前"把本地 TTS 的显存交出来"
 * @param {Function} [deps.fetchFn]  注入 fetch（测试用）
 * @param {Function} [deps.spawnFn]  注入 spawn（测试用）
 * @param {Function} [deps.now]
 */
export function createDrawProxy({
  config,
  gpu,
  yieldLocalSay = async () => {},
  fetchFn = fetch,
  spawnFn = spawn,
  now = () => Date.now(),
  log = (msg) => console.log(msg)
}) {
  const drawConfig = config?.draw || {};
  const baseUrl = String(drawConfig.url || '').replace(/\/$/, '');
  const target = baseUrl ? `${baseUrl}/v1/images/generations` : '';
  const token = String(drawConfig.token || '');
  const timeoutMs = Number(drawConfig.timeoutMs) || 600000;

  const model = createManagedModel({
    name: 'draw',
    // 出图服务自己会闲置退出，这里不再重复计时
    idleMs: Number(drawConfig.idleMs) || 0,
    startTimeoutMs: Number(drawConfig.startTimeoutMs) || 180000,
    pollMs: 2000,
    now,
    log,
    health: async () => {
      if (!baseUrl) return false;
      const response = await fetchFn(`${baseUrl}/health`, { signal: AbortSignal.timeout(2500) });
      return response.ok;
    },
    start: async () => {
      const command = String(drawConfig.startCommand || '').trim();
      if (!command) {
        log('[draw] 后端没起，且没配 draw.startCommand —— 只能靠你自己手动启动');
        return false;
      }
      log('[draw] 后端没起，按需启动…');
      const child = spawnFn(command, {
        shell: true,
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          TEMP: path.join(config.dataDir || '.', 'tmp'),
          TMP: path.join(config.dataDir || '.', 'tmp')
        }
      });
      child.unref?.();
      return true;
    }
  });

  const headersOf = () => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    return headers;
  };

  const post = (raw) => fetchFn(target, {
    method: 'POST',
    headers: headersOf(),
    body: raw,
    signal: AbortSignal.timeout(timeoutMs)
  });

  /** 转发一次出图请求。返回 { status, body, contentType }；失败抛错（路由层统一转 502）。 */
  const forward = async (raw) => {
    if (!baseUrl) {
      throw Object.assign(new Error('画图后端没配置（draw.url），见 docs/DRAW.md'), { code: 'E_DRAW_OFF' });
    }
    return gpu.run('draw', async () => {
      // ① 先把本地 TTS 的显存交出来（8.2 GB，和画图不可能共存）
      await yieldLocalSay();
      // ② 出图服务闲置会退出：连不上就先拉起来
      await model.ensure();
      // ③ 转发；被掐断（比如刚启动就 OOM）再试一次
      let response;
      try {
        response = await post(raw);
      } catch (error) {
        log(`[draw] 首次转发失败（${String(error?.message ?? error).slice(0, 80)}），重试一次`);
        await model.ensure({ force: true });
        response = await post(raw);
      }
      const body = await response.text();
      log(`[draw] → ${target} ${response.status}`);
      return {
        status: response.status,
        body,
        contentType: response.headers.get('content-type')
      };
    });
  };

  return {
    forward,
    ensure: (opts) => model.ensure(opts),
    healthy: () => model.healthy(),
    status: () => ({ ...model.status(), url: baseUrl, timeoutMs })
  };
}
