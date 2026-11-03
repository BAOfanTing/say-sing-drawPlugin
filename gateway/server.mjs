#!/usr/bin/env node
// 网关入口：node server.mjs [--config config.json]
//
// 只监听 127.0.0.1 —— 对外暴露交给隧道（cloudflared / frp），不要把本进程直接挂公网。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { createApp, VERSION } from './lib/app.mjs';

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const configPath = argOf('config', path.join(import.meta.dirname, 'config.json'));
let config;
try {
  config = loadConfig(configPath);
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}

/** 扫码登录成功后把 Cookie 写回 config.json（只改 source.neteaseCookie，其余原样保留）。 */
function persistCookie(cookie) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    raw.source = { ...(raw.source || {}), neteaseCookie: String(cookie || '') };
    fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    console.log('[login] 网易云 Cookie 已写入 config.json');
  } catch (error) {
    console.warn(`[login] 写 config.json 失败：${error.message}（本次运行仍然生效）`);
  }
}

const app = createApp({ config, persistCookie });
const server = http.createServer((req, res) => { void app.handler(req, res); });

const pruneTimer = setInterval(() => {
  const removedFiles = app.pruneFiles();
  const removedJobs = app.queue.prune();
  if (removedFiles || removedJobs) console.log(`[prune] 清理 ${removedFiles} 个成品、${removedJobs} 条旧任务`);
}, 30 * 60 * 1000);
pruneTimer.unref?.();

/** 每天 0 点清掉"今天以前"的成品：群里昨天的点歌不该留到明天。 */
function scheduleMidnightPrune() {
  const nowMs = Date.now();
  const next = new Date(nowMs);
  next.setHours(24, 0, 5, 0);            // 明天 00:00:05（留 5 秒躲开整点抖动）
  const delay = Math.max(1000, next.getTime() - nowMs);
  const timer = setTimeout(() => {
    const result = app.pruneBeforeToday();
    const removedJobs = app.queue.prune();
    console.log(`[prune] 零点清理：${result.removed} 个成品（${Math.round(result.bytes / 1024)} KB）、${removedJobs} 条旧任务`);
    scheduleMidnightPrune();              // 递归排下一次
  }, delay);
  timer.unref?.();
  console.log(`  零点清理：${new Date(nowMs + delay).toLocaleString()}`);
  return timer;
}
scheduleMidnightPrune();

server.listen(config.port, config.host, () => {
  console.log(`点歌网关 v${VERSION} 已启动：http://${config.host}:${config.port}`);
  console.log(`  音源：${config.source.type}${config.source.type === 'local' ? `（${config.source.localDir}）` : ''}`);
  console.log(`  换声：${config.voice.engine}${config.voice.engine === 'none' ? '（直出原音，仅用于跑通链路）' : ''}`);
  console.log(`  转码：${config.transcode}`);
  console.log(`  鉴权：${config.token ? '已开启（Bearer token）' : '⚠ 未设置 token，任何能访问到本端口的人都能点歌'}`);
  console.log(`  数据：${config.dataDir}`);
  console.log('对外的 https 地址用隧道拿到后，填进 QQ Agent → 插件 → 点歌唱歌 → 网关地址。');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n收到 ${signal}，关闭网关`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref?.();
  });
}
