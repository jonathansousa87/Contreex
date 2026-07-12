import assert from 'node:assert/strict';
import { Semaphore } from '../src/concurrency.mjs';
import { AgentManager } from '../src/agent-manager.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   - ${name}`);
  } catch (e) {
    console.log(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

check('Semaphore rejects a non-positive limit', () => {
  assert.throws(() => new Semaphore(0));
  assert.throws(() => new Semaphore(-1));
});

await check('Semaphore never lets more than `limit` tasks run concurrently', async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let maxActive = 0;
  const task = () =>
    sem.run(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(20);
      active--;
    });

  await Promise.all([task(), task(), task(), task(), task()]); // 5 tasks, limit 2
  assert.equal(maxActive <= 2, true, `maxActive was ${maxActive}, expected <= 2`);
});

await check('Semaphore(1) fully serializes tasks', async () => {
  const sem = new Semaphore(1);
  const order = [];
  const task = (id) =>
    sem.run(async () => {
      order.push(`start-${id}`);
      await sleep(10);
      order.push(`end-${id}`);
    });

  await Promise.all([task(1), task(2), task(3)]);
  // With limit 1, each task's end must come before the next task's start.
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
});

await check('all tasks eventually complete even when queued behind the limit', async () => {
  const sem = new Semaphore(2);
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => sem.run(async () => n * 2)));
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12]);
});

await check('AgentManager actually uses its semaphore to gate concurrent plugin.execute() calls', async () => {
  const sem = new Semaphore(2);
  const manager = new AgentManager({ maxRetries: 0, semaphore: sem });
  let active = 0;
  let maxActive = 0;

  const fakePlugin = {
    name: 'fake',
    execute: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(20);
      active--;
      return { ok: true, raw: '{"verdict":"APPROVE","findings":[]}', meta: {} };
    },
  };

  const dirs = [1, 2, 3, 4, 5].map(() => mkdtempSync(join(tmpdir(), 'contreex-concurrency-test-')));
  await Promise.all(
    dirs.map((dir, i) =>
      manager.run(fakePlugin, {
        projectDir: dir,
        role: 'reviewer',
        prompt: `concurrency test ${i}-${Date.now()}-${Math.random()}`,
        defName: 'review',
        cache: false,
      }),
    ),
  );
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });

  assert.equal(maxActive <= 2, true, `maxActive was ${maxActive}, expected <= 2`);
});

console.log(`\n${passed} passed`);
if (process.exitCode) console.log('SOME TESTS FAILED');
