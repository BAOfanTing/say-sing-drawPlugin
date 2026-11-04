// 保命网：出图/换声后端挂了只该降级成 502，不能把网关带走
// （2026-11-04 实测：画图后端卡死后网关 unhandledRejection → exit(1)，说话一起哑了几秒）
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installCrashGuard } from '../gateway/lib/crash-guard.mjs';

const fakeProc = () => new EventEmitter();

test('未捕获的 Promise 拒绝：只记日志，进程不退出', () => {
  const proc = fakeProc();
  const lines = [];
  const uninstall = installCrashGuard({ proc, log: (m) => lines.push(m) });

  // 没有 handler 时 Node 会 exit(1)；装了之后应当只打一条日志
  proc.emit('unhandledRejection', new Error('画图后端卡死'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /未捕获的 Promise 拒绝/);
  assert.match(lines[0], /画图后端卡死/);

  uninstall();
});

test('未捕获的异常同样兜住（网关继续跑，等守护/人工处理）', () => {
  const proc = fakeProc();
  const lines = [];
  const uninstall = installCrashGuard({ proc, log: (m) => lines.push(m) });
  proc.emit('uncaughtException', new Error('boom'));
  assert.match(lines[0], /未捕获的异常/);
  uninstall();
});

test('长错误会被截断，别把整屏 stack 灌进日志', () => {
  const proc = fakeProc();
  const lines = [];
  const uninstall = installCrashGuard({ proc, log: (m) => lines.push(m) });
  proc.emit('unhandledRejection', new Error('x'.repeat(5000)));
  assert.ok(lines[0].length < 900, `日志太长：${lines[0].length}`);
  uninstall();
});

test('卸载后不再拦截（测试/热重载不留悬挂 handler）', () => {
  const proc = fakeProc();
  const lines = [];
  const uninstall = installCrashGuard({ proc, log: (m) => lines.push(m) });
  uninstall();
  assert.equal(proc.listenerCount('unhandledRejection'), 0);
  assert.equal(proc.listenerCount('uncaughtException'), 0);
  proc.emit('unhandledRejection', new Error('after uninstall'));
  assert.equal(lines.length, 0);
});
