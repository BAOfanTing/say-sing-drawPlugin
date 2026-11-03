// ManagedModel 的单元测试：只测"生命周期壳"本身，不碰真进程。
// 关注点：并发去重、等就绪轮询、启动失败/早退、闲置回收、health 抛错不算就绪。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedModel } from '../gateway/lib/managed-model.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('已经在跑就不会重复拉起（并发 ensure 合并成一次）', async () => {
  let starts = 0;
  let up = false;
  const model = createManagedModel({
    name: 'demo',
    health: async () => up,
    start: async () => { starts += 1; up = true; },
    pollMs: 5,
    startTimeoutMs: 200
  });
  const results = await Promise.all([model.ensure(), model.ensure(), model.ensure()]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(starts, 1, '三个并发请求只该拉起一次');
  assert.equal(await model.healthy(), true);
});

test('启动后要等 health 通了才算就绪；早退就尽早报失败', async () => {
  let polls = 0;
  let dead = false;
  const model = createManagedModel({
    name: 'demo',
    health: async () => { polls += 1; return polls >= 3; },
    start: async () => true,
    isDead: () => dead,
    pollMs: 5,
    startTimeoutMs: 500
  });
  assert.equal(await model.ensure(), true);
  assert.ok(polls >= 3, `应该轮询到就绪，实际 ${polls}`);

  const deadModel = createManagedModel({
    name: 'dead',
    health: async () => false,
    start: async () => true,
    isDead: () => dead,
    pollMs: 5,
    startTimeoutMs: 500
  });
  dead = true;
  assert.equal(await deadModel.ensure(), false);
});

test('start() 返回 false（没配启动命令）就是失败，不空转', async () => {
  const model = createManagedModel({
    name: 'x',
    health: async () => false,
    start: async () => false,
    pollMs: 5,
    startTimeoutMs: 100
  });
  assert.equal(await model.ensure(), false);
  assert.equal(model.status().failures, 1);
});

test('health 抛错算"没就绪"，不会把调用方打断', async () => {
  const model = createManagedModel({
    name: 'x',
    health: async () => { throw new Error('ECONNREFUSED'); },
    start: async () => true,
    pollMs: 5,
    startTimeoutMs: 30
  });
  assert.equal(await model.healthy(), false);
  assert.equal(await model.ensure(), false);
});

test('闲置到点自动 shutdown，再活动时重置计时', async () => {
  const calls = [];
  const due = [];
  const model = createManagedModel({
    name: 'idle',
    health: async () => true,
    start: async () => true,
    stop: async (reason) => { calls.push(reason); },
    idleMs: 50,
    setTimer: (fn, ms) => { const id = { fn, ms, cleared: false }; due.push(id); return id; },
    clearTimer: (id) => { if (id) id.cleared = true; }
  });
  model.armIdle();
  model.armIdle();                       // 重置：前一个计时器应被取消
  assert.equal(due.length, 2);
  assert.equal(due[0].cleared, true);
  assert.equal(due[1].cleared, false);
  const live = due[1];
  assert.equal(live.ms, 50);
  live.fn();                             // 触发闲置
  await sleep(0);
  assert.deepEqual(calls, ['闲置 0 秒']);   // 50ms → Math.round(0.05)=0
  assert.equal(model.status().idleArmed, false);
});

test('idleMs=0 表示永不自动回收（常驻）', async () => {
  const due = [];
  const model = createManagedModel({
    name: 'sticky',
    health: async () => true,
    start: async () => true,
    idleMs: 0,
    setTimer: (fn, ms) => { const id = { fn, ms }; due.push(id); return id; },
    clearTimer: () => {}
  });
  model.armIdle();
  assert.equal(due.length, 0);
});

test('shutdown 会先取消闲置计时再收进程', async () => {
  const order = [];
  const model = createManagedModel({
    name: 'stop',
    health: async () => true,
    start: async () => true,
    stop: async () => { order.push('stop'); },
    idleMs: 1000,
    setTimer: (fn, ms) => ({ fn, ms }),
    clearTimer: () => order.push('clear')
  });
  model.armIdle();
  await model.shutdown('让位给画图');
  assert.deepEqual(order, ['clear', 'stop']);
  assert.equal(model.status().lastStop, '让位给画图');
});
