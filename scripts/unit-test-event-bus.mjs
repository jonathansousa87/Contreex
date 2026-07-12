import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentManager } from '../src/agent-manager.mjs';
import { EVENTS } from '../src/event-bus.mjs';
import { runOrchestrator } from '../src/orchestrator.mjs';

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

function fakePlugin(name, raw) {
  return { name, execute: async () => ({ ok: true, raw, meta: { ms: 1 } }) };
}

function scratchDir() {
  return mkdtempSync(join(tmpdir(), 'contreex-eventbus-test-'));
}

await check('AgentManager emits BeforeAgentRun and AfterAgentRun with eventMeta merged in', async () => {
  const bus = new EventEmitter();
  const seen = [];
  bus.on(EVENTS.BEFORE_AGENT_RUN, (p) => seen.push(['before', p]));
  bus.on(EVENTS.AFTER_AGENT_RUN, (p) => seen.push(['after', p]));

  const manager = new AgentManager({ eventBus: bus });
  const dir = scratchDir();
  const result = await manager.run(fakePlugin('fake', '{"verdict":"APPROVE","findings":[]}'), {
    projectDir: dir,
    role: 'reviewer',
    prompt: 'x',
    defName: 'review',
    eventMeta: { action: 'review' },
    cache: false,
  });
  rmSync(dir, { recursive: true, force: true });

  assert.equal(result.ok, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[0][0], 'before');
  assert.equal(seen[0][1].action, 'review');
  assert.equal(seen[1][0], 'after');
  assert.equal(seen[1][1].ok, true);
  assert.equal(seen[1][1].action, 'review');
});

await check('a cache hit still emits AfterAgentRun, marked cached', async () => {
  const bus = new EventEmitter();
  const afterEvents = [];
  bus.on(EVENTS.AFTER_AGENT_RUN, (p) => afterEvents.push(p));

  const manager = new AgentManager({ eventBus: bus });
  const dir = scratchDir();
  // Cache persists across test runs at ~/.contreex/cache/ — a fixed prompt
  // string would hit a stale cache entry from a previous run of this exact
  // test and falsely appear cached on the very first call. Unique per run.
  const opts = { projectDir: dir, role: 'reviewer', prompt: `same prompt every time ${Date.now()}-${Math.random()}`, defName: 'review', eventMeta: { action: 'review' } };
  await manager.run(fakePlugin('fake', '{"verdict":"APPROVE","findings":[]}'), opts);
  await manager.run(fakePlugin('fake', '{"verdict":"APPROVE","findings":[]}'), opts);
  rmSync(dir, { recursive: true, force: true });

  assert.equal(afterEvents.length, 2);
  assert.equal(afterEvents[0].cached, undefined);
  assert.equal(afterEvents[1].cached, true);
});

await check('runOrchestrator builds doc.logs entirely from AgentManager events, no direct pushes', async () => {
  const dir = scratchDir();
  writeFileSync(join(dir, 'utils.js'), '// utils.js\n');

  const roles = {
    implementer: fakePlugin('fake-impl', '{"analysis":{"problem":"needs a helper"},"plan":{"steps":[{"id":"1","description":"add it"}]}}'),
    reviewer1: fakePlugin('fake-rev', '{"verdict":"APPROVE","findings":[]}'),
  };
  const pipeline = [
    { role: 'implementer', action: 'analyze' },
    { parallel: [{ role: 'reviewer1', action: 'review' }] },
  ];

  const bus = new EventEmitter();
  let pipelineFinished = null;
  bus.on(EVENTS.PIPELINE_FINISHED, (p) => (pipelineFinished = p));

  const manager = new AgentManager({ eventBus: bus });
  const { doc, documentValid } = await runOrchestrator({ projectDir: dir, objective: 'test objective', pipeline, roles, manager });
  rmSync(dir, { recursive: true, force: true });

  assert.equal(documentValid.valid, true);
  assert.equal(doc.logs.length, 2); // one per step: analyze, review
  assert.ok(doc.logs[0].message.includes("action 'analyze'"));
  assert.ok(doc.logs[1].message.includes("action 'review'"));
  assert.ok(pipelineFinished, 'PipelineFinished never fired');
  assert.equal(pipelineFinished.valid, true);
});

await check('refine emits ReviewAccepted/ReviewRejected per item', async () => {
  const dir = scratchDir();
  const roles = {
    implementer: fakePlugin(
      'fake-impl',
      '{"acceptedChanges":["add a test"],"rejectedChanges":[{"suggestion":"rename function","reason":"out of scope"}]}',
    ),
  };
  const pipeline = [{ role: 'implementer', action: 'refine' }];

  const bus = new EventEmitter();
  const accepted = [];
  const rejected = [];
  bus.on(EVENTS.REVIEW_ACCEPTED, (p) => accepted.push(p));
  bus.on(EVENTS.REVIEW_REJECTED, (p) => rejected.push(p));

  const manager = new AgentManager({ eventBus: bus });
  // pre-seed doc.plan/doc.reviews isn't needed here since we bypass runOrchestrator's
  // own doc construction by calling it directly — refine's baseInstruction only reads doc.request.
  await runOrchestrator({ projectDir: dir, objective: 'test', pipeline, roles, manager });
  rmSync(dir, { recursive: true, force: true });

  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].suggestion, 'add a test');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].suggestion, 'rename function');
});

console.log(`\n${passed} passed`);
if (process.exitCode) console.log('SOME TESTS FAILED');
