import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentManager } from '../src/agent-manager.mjs';
import { runOrchestrator } from '../src/orchestrator.mjs';
import { ContextEngine } from '../src/context-engine.mjs';
import { resolveAction } from '../src/actions/registry.mjs';

// refine's baseInstruction() ignores doc entirely (only ContextEngine-supplied
// context varies its prompt) — unlike 'review', its cache key has no natural
// per-test uniqueness from the objective text, so identical reviewer feedback
// text across separate runs of this file can collide with a stale disk cache
// entry from an earlier run. Clear it up front, same as the knowledge-base
// tests do for their own file-backed state.
rmSync(join(homedir(), '.contreex', 'cache'), { recursive: true, force: true });

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

// Returns a fresh raw JSON string from `queue` on each call, in order —
// unlike the single-fixed-reply fake plugin used elsewhere, the consensus
// loop calls the same role multiple times across rounds with different
// expected replies each time.
function queuedPlugin(name, queue) {
  let i = 0;
  return {
    name,
    execute: async () => {
      const raw = queue[Math.min(i, queue.length - 1)];
      i++;
      return { ok: true, raw, meta: { ms: 1 } };
    },
  };
}

function scratchDir() {
  return mkdtempSync(join(tmpdir(), 'contreex-consensus-loop-test-'));
}

await check('unanimous APPROVE on round 1 stops the loop immediately, refine never runs', async () => {
  const dir = scratchDir();
  let refineCalls = 0;
  const roles = {
    reviewer1: queuedPlugin('rev1', ['{"verdict":"APPROVE","findings":[]}']),
    reviewer2: queuedPlugin('rev2', ['{"verdict":"APPROVE","findings":[]}']),
    implementer: {
      name: 'impl',
      execute: async () => {
        refineCalls++;
        return { ok: true, raw: '{"acceptedChanges":[],"rejectedChanges":[]}', meta: { ms: 1 } };
      },
    },
  };
  const pipeline = [
    { loop: { maxRounds: 3, reviewers: [{ role: 'reviewer1', action: 'review' }, { role: 'reviewer2', action: 'review' }] } },
  ];
  const manager = new AgentManager({ eventBus: new EventEmitter() });
  const { doc } = await runOrchestrator({ projectDir: dir, objective: `test unanimous ${Date.now()}-${Math.random()}`, pipeline, roles, manager });
  rmSync(dir, { recursive: true, force: true });

  assert.equal(refineCalls, 0);
  assert.equal(doc.consensus.rounds, 1);
  assert.equal(doc.consensus.maxRounds, 3);
  assert.equal(doc.consensus.stopReason, 'unanimous reviewer approval');
  assert.equal(doc.refinement, undefined);
});

await check('non-unanimous round triggers refine; chiefEngineerOverride stops the loop early', async () => {
  const dir = scratchDir();
  const roles = {
    reviewer1: queuedPlugin('rev1', ['{"verdict":"CHANGES_NEEDED","findings":[{"severity":"low","summary":"nitpick"}]}']),
    reviewer2: queuedPlugin('rev2', ['{"verdict":"APPROVE","findings":[]}']),
    implementer: queuedPlugin('impl', [
      '{"acceptedChanges":[],"rejectedChanges":[{"suggestion":"nitpick","reason":"not a real issue"}],"chiefEngineerOverride":true,"overrideRationale":"the nitpick does not affect correctness"}',
    ]),
  };
  const pipeline = [
    { loop: { maxRounds: 3, reviewers: [{ role: 'reviewer1', action: 'review' }, { role: 'reviewer2', action: 'review' }] } },
  ];
  const manager = new AgentManager({ eventBus: new EventEmitter() });
  const { doc } = await runOrchestrator({ projectDir: dir, objective: `test override ${Date.now()}-${Math.random()}`, pipeline, roles, manager });
  rmSync(dir, { recursive: true, force: true });

  assert.equal(doc.consensus.rounds, 1);
  assert.equal(doc.consensus.stopReason, 'chief engineer override');
  assert.equal(doc.refinement.chiefEngineerOverride, true);
  assert.equal(doc.refinement.overrideRationale, 'the nitpick does not affect correctness');
});

await check('no consensus and no override by maxRounds stops with a clear stopReason, decision left to the user', async () => {
  const dir = scratchDir();
  const roles = {
    reviewer1: queuedPlugin('rev1', [
      '{"verdict":"CHANGES_NEEDED","findings":[{"severity":"medium","summary":"missing null check"}]}',
      '{"verdict":"CHANGES_NEEDED","findings":[{"severity":"low","summary":"still missing a test for the empty-string case"}]}',
    ]),
    reviewer2: queuedPlugin('rev2', ['{"verdict":"APPROVE","findings":[]}', '{"verdict":"APPROVE","findings":[]}']),
    implementer: queuedPlugin('impl', [
      '{"acceptedChanges":["fix X"],"rejectedChanges":[]}',
      '{"acceptedChanges":["fix Y"],"rejectedChanges":[]}',
    ]),
  };
  const pipeline = [
    { loop: { maxRounds: 2, reviewers: [{ role: 'reviewer1', action: 'review' }, { role: 'reviewer2', action: 'review' }] } },
  ];
  const manager = new AgentManager({ eventBus: new EventEmitter() });
  const { doc } = await runOrchestrator({ projectDir: dir, objective: `test maxrounds ${Date.now()}-${Math.random()}`, pipeline, roles, manager });
  rmSync(dir, { recursive: true, force: true });

  assert.equal(doc.consensus.rounds, 2);
  assert.equal(doc.consensus.maxRounds, 2);
  assert.equal(doc.consensus.stopReason, 'max rounds reached without consensus');
  assert.equal(doc.refinement.acceptedChanges[0], 'fix Y'); // last round's refinement is what's kept
});

await check('refine updatedPlan propagates to doc.plan, visible to the next round of reviewers', async () => {
  const dir = scratchDir();
  const roles = {
    reviewer1: queuedPlugin('rev1', ['{"verdict":"CHANGES_NEEDED","findings":[]}', '{"verdict":"APPROVE","findings":[]}']),
    reviewer2: queuedPlugin('rev2', ['{"verdict":"APPROVE","findings":[]}', '{"verdict":"APPROVE","findings":[]}']),
    implementer: queuedPlugin('impl', [
      '{"acceptedChanges":["add error handling"],"rejectedChanges":[],"updatedPlan":{"steps":[{"id":"1","description":"add error handling to parse()"}]}}',
    ]),
  };
  const pipeline = [
    { loop: { maxRounds: 3, reviewers: [{ role: 'reviewer1', action: 'review' }, { role: 'reviewer2', action: 'review' }] } },
  ];
  const manager = new AgentManager({ eventBus: new EventEmitter() });
  const { doc } = await runOrchestrator({ projectDir: dir, objective: `test updatedplan ${Date.now()}-${Math.random()}`, pipeline, roles, manager });
  rmSync(dir, { recursive: true, force: true });

  assert.equal(doc.plan.steps[0].description, 'add error handling to parse()');
  assert.equal(doc.consensus.rounds, 2);
});

await check('ContextEngine includes prior refinement in round-2 review context', () => {
  const ce = new ContextEngine();
  const doc = {
    request: { objective: 'x' },
    plan: { steps: [{ id: '1', description: 'do the thing' }] },
    refinement: { acceptedChanges: ['add a test'], rejectedChanges: [] },
  };
  const context = ce.gather({ action: 'review', doc, projectDir: '/nonexistent' });
  assert.ok(context.some((c) => c.includes("Implementer's prior refinement round")));
  assert.ok(context.some((c) => c.includes('add a test')));
});

await check('ContextEngine does not fabricate a refinement line on round 1 (no doc.refinement yet)', () => {
  const ce = new ContextEngine();
  const doc = { request: { objective: 'x' }, plan: { steps: [{ id: '1', description: 'do the thing' }] } };
  const context = ce.gather({ action: 'review', doc, projectDir: '/nonexistent' });
  assert.ok(!context.some((c) => c.includes('prior refinement round')));
});

await check('review action instructs reviewers to give opinion only, never modify files', () => {
  const action = resolveAction('review');
  const instruction = action.baseInstruction({ request: { objective: 'x' } });
  assert.ok(/never create, edit, or modify/i.test(instruction));
});

await check('refine action explains chiefEngineerOverride semantics and requires a rationale to use it', () => {
  const action = resolveAction('refine');
  const instruction = action.baseInstruction();
  assert.ok(/chiefEngineerOverride/.test(instruction));
  assert.ok(/overrideRationale/.test(instruction));
});

console.log(`\n${passed} passed`);
if (process.exitCode) console.log('SOME TESTS FAILED');
