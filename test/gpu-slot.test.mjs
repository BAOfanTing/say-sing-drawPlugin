// GPU 槽的单元测试：只验证"互斥、先到先得、出错不卡队列、观测值正确"。
// 不起真模型，全靠 now() 注入与 sleep 0。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGpuSlot } from '../gateway/lib/gpu-slot.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('同一时刻只有一个持有者：第二个要等第一个跑完', async () => {
  const gpu = createGpuSlot();
  const log = [];
  let releaseFirst;
  const first = gpu.run('sing', async () => {
    log.push('sing:start');
    await new Promise((resolve) => { releaseFirst = resolve; });
    log.push('sing:end');
    return 'sing-result';
  });
  await tick();
  assert.equal(gpu.owner(), 'sing');
  assert.equal(gpu.busy(), true);

  let drawEntered = false;
  const second = gpu.run('draw', async () => {
    drawEntered = true;
    log.push('draw:start');
    return 'draw-result';
  });
  await tick();
  assert.equal(drawEntered, false, 'sing 还在跑，draw 不能进');
  assert.equal(gpu.waiting(), 1);

  releaseFirst();
  assert.equal(await first, 'sing-result');
  assert.equal(await second, 'draw-result');
  assert.deepEqual(log, ['sing:start', 'sing:end', 'draw:start']);
  assert.equal(gpu.owner(), '');
  assert.equal(gpu.busy(), false);
});

test('先到先得：三个排队按提交顺序执行', async () => {
  const gpu = createGpuSlot();
  const order = [];
  const slow = (name) => gpu.run(name, async () => {
    order.push(name);
    await new Promise((resolve) => setTimeout(resolve, 1));
  });
  await Promise.all([slow('a'), slow('b'), slow('c')]);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('前一个抛错不会卡住后面的人', async () => {
  const gpu = createGpuSlot();
  const bad = gpu.run('sing', async () => { throw Object.assign(new Error('boom'), { code: 'E_BOOM' }); });
  const good = gpu.run('draw', async () => 'ok');
  await assert.rejects(bad, (error) => error.code === 'E_BOOM');
  assert.equal(await good, 'ok');
  assert.equal(gpu.owner(), '');
});

test('等待时长被记下来（给 /health 和日志用）', async () => {
  let clock = 1000;
  const gpu = createGpuSlot({ now: () => clock });
  const waits = [];
  const gpu2 = createGpuSlot({ now: () => clock, onWait: (info) => waits.push(info) });
  // 用 gpu2 测 onWait：第一个跑 500ms（手动推进时钟），第二个在等待
  const first = gpu2.run('draw', async () => {
    clock += 500;
    return 1;
  });
  const second = gpu2.run('say', async () => 2);
  await Promise.all([first, second]);
  assert.equal(waits.length, 1);
  assert.equal(waits[0].kind, 'say');
  assert.ok(waits[0].waitedMs >= 500, `应记录到等待时长，实际 ${waits[0].waitedMs}`);
  assert.ok(gpu2.stats().maxWaitMs >= 500);
  assert.equal(gpu.owner(), '');
});

test('非函数参数直接报错（别让空槽静默跑飞）', async () => {
  const gpu = createGpuSlot();
  await assert.rejects(gpu.run('draw', null), /需要一个函数/);
  assert.equal(gpu.busy(), false);
});
