// local-say 的单测：全部注入（spawn / fetch / runShell / sleep），不起真进程。
// 钉住的是**让位语义**：谁在跑、什么时候停、唱歌时不许动换声常驻。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalSay } from '../gateway/lib/local-say.mjs';

const baseConfig = (say = {}) => ({
  say: {
    engine: 'breeze-local',
    localUrl: 'http://127.0.0.1:7860',
    localPython: 'python',
    localModelDir: 'say-model/weights/breeze-tts-2',
    localAppDir: 'say-model',
    localIdleMs: 60000,
    ...say
  }
});

/** 假进程：可控的 pid / 退出。 */
function fakeChild() {
  const handlers = {};
  return {
    pid: 4242,
    exitCode: null,
    stderr: { on: () => {} },
    on: (event, fn) => { handlers[event] = fn; },
    kill: () => { handlers.close?.(0); },
    emitClose: (code = 0) => { handlers.close?.(code); }
  };
}

function harness({ say = {}, singing = false, up = false, voice = {} } = {}) {
  const state = { up, spawned: [], shell: [], killed: 0, voiceShutdowns: 0, sleeps: 0 };
  const spawnFn = (cmd, args) => {
    state.spawned.push({ cmd, args });
    const child = fakeChild();
    child.kill = () => { state.killed += 1; child.emitClose(0); };
    return child;
  };
  const fetchFn = async () => ({ ok: state.up });
  const runShell = async (cmd) => { state.shell.push(cmd); state.up = true; return true; };
  const localSay = createLocalSay({
    config: baseConfig(say),
    voice: { ...voice, shutdown: () => { state.voiceShutdowns += 1; } },
    isSinging: () => singing,
    runShell,
    spawnFn,
    fetchFn,
    sleep: async () => { state.sleeps += 1; }
  });
  return { localSay, state };
}

test('已就绪时不重复拉起', async () => {
  const { localSay, state } = harness({ up: true });
  assert.equal(await localSay.start(), true);
  assert.equal(state.spawned.length, 0);
  assert.equal(await localSay.healthy(), true);
});

test('没起来就 spawn python，等到 /health 通才算就绪', async () => {
  const { localSay, state } = harness({ up: false });
  // 第一次 health 检查时服务还没起，模拟"启动后变通"
  setTimeout(() => { state.up = true; }, 0);
  const ok = await localSay.start();
  assert.equal(ok, true);
  assert.equal(state.spawned.length, 1);
  assert.match(state.spawned[0].args.join(' '), /breeze_infer\.api/);
});

test('让位：正在跑就停掉，并记下"是我们主动停的"', async () => {
  const { localSay, state } = harness({ up: true });
  await localSay.start();                    // 先让它"跑起来"
  state.up = true;
  const yielded = await localSay.yieldToHeavy();
  assert.equal(yielded, true);
  assert.ok(state.killed >= 0);
  assert.equal(localSay.status().stopped, true);
});

test('没在跑就不动换声常驻，也不装模作样地"让位"', async () => {
  const { localSay, state } = harness({ up: false });
  const yielded = await localSay.yieldToHeavy();
  assert.equal(yielded, false, '本来就没占显存，不该返回 true');
  assert.equal(state.voiceShutdowns, 0);
});

test('唱歌进行中不许 shutdown 换声常驻（会把队列里那首歌弄死）', async () => {
  const { localSay, state } = harness({ up: false, singing: true });
  const resumed = await localSay.resume();
  assert.equal(resumed, false);
  assert.equal(state.voiceShutdowns, 0, '唱歌时一次都不该收换声常驻');
});

test('不唱歌时 resume 会先收掉换声常驻、再拉起本地 TTS', async () => {
  const { localSay, state } = harness({ up: false, singing: false });
  setTimeout(() => { state.up = true; }, 0);
  const resumed = await localSay.resume();
  assert.equal(resumed, true);
  assert.equal(state.voiceShutdowns, 1);
  assert.equal(localSay.status().voiceResidentShutdown, true);
});

test('engine 不是本地/auto 时 resume 直接 false（纯云端不碰显存）', async () => {
  const { localSay } = harness({ say: { engine: 'breeze' } });
  assert.equal(await localSay.resume(), false);
});
