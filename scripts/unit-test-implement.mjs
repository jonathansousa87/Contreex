import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentManager } from '../src/agent-manager.mjs';
import { runOrchestrator } from '../src/orchestrator.mjs';
import { resolveAction } from '../src/actions/registry.mjs';
import { ContextEngine } from '../src/context-engine.mjs';
import { formatReport } from '../src/report.mjs';

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
  return mkdtempSync(join(tmpdir(), 'contreex-implement-test-'));
}

await check('implement action is registered and self-contained (no cache, longer timeout)', () => {
  const action = resolveAction('implement');
  assert.equal(action.role, 'implementer');
  assert.equal(action.cache, false);
  assert.equal(action.timeout, 120_000);
  assert.equal(action.defName, 'implementation');
});

await check('implement action base instruction asks for real writes, not just JSON', () => {
  const action = resolveAction('implement');
  const instruction = action.baseInstruction({});
  assert.ok(/implement the change now/i.test(instruction));
  assert.ok(/create or edit/i.test(instruction));
});

await check('implement action merge sets doc.implementation', () => {
  const action = resolveAction('implement');
  const doc = {};
  action.merge(doc, { status: 'completed', filesChanged: [{ path: 'utils.js', diffSummary: 'added helper' }] });
  assert.equal(doc.implementation.status, 'completed');
  assert.equal(doc.implementation.filesChanged[0].path, 'utils.js');
});

await check('ContextEngine feeds the plan and refinement into the implement step', () => {
  const ce = new ContextEngine();
  const doc = {
    request: { objective: 'x' },
    plan: { steps: [{ id: '1', description: 'add isPalindrome' }] },
    refinement: { acceptedChanges: ['add a test'], rejectedChanges: [] },
  };
  const context = ce.gather({ action: 'implement', doc, projectDir: '/nonexistent' });
  assert.ok(context.some((c) => c.includes('Plan to implement')));
  assert.ok(context.some((c) => c.includes('Refinement')));
});

await check('runOrchestrator returns the implementer worktree path only after a successful implement step', async () => {
  const dir = scratchDir();
  const roles = {
    implementer: fakePlugin('fake-impl', '{"status":"completed","filesChanged":[{"path":"utils.js","diffSummary":"added isPalindrome"}],"commands":[]}'),
  };
  const pipeline = [{ role: 'implementer', action: 'implement' }];

  const manager = new AgentManager({ eventBus: new EventEmitter() });
  const { doc, documentValid, implementWorktree } = await runOrchestrator({ projectDir: dir, objective: 'test', pipeline, roles, manager });
  rmSync(dir, { recursive: true, force: true });

  assert.equal(documentValid.valid, true);
  assert.equal(doc.implementation.status, 'completed');
  assert.ok(implementWorktree, 'implementWorktree was not returned');
  assert.ok(implementWorktree.includes('fake-impl-implementer'));
});

await check('runOrchestrator does not return an implementer worktree when no implement step ran', async () => {
  const dir = scratchDir();
  const roles = { implementer: fakePlugin('fake-impl', '{"analysis":{"problem":"x"}}') };
  const pipeline = [{ role: 'implementer', action: 'analyze' }];

  const manager = new AgentManager({ eventBus: new EventEmitter() });
  const { implementWorktree } = await runOrchestrator({ projectDir: dir, objective: 'test', pipeline, roles, manager });
  rmSync(dir, { recursive: true, force: true });

  assert.equal(implementWorktree, null);
});

await check('runOrchestrator does not return a worktree when the implement step fails validation', async () => {
  const dir = scratchDir();
  const roles = { implementer: fakePlugin('fake-impl', '{"status":"not-a-valid-enum-value"}') };
  const pipeline = [{ role: 'implementer', action: 'implement' }];

  const manager = new AgentManager({ eventBus: new EventEmitter() });
  const { doc, implementWorktree } = await runOrchestrator({ projectDir: dir, objective: 'test', pipeline, roles, manager });
  rmSync(dir, { recursive: true, force: true });

  assert.equal(doc.implementation, undefined);
  assert.equal(implementWorktree, null);
});

await check('report renders the implementation section with status, files and commands', () => {
  const doc = {
    request: { objective: 'Add isPalindrome' },
    implementation: {
      status: 'completed',
      filesChanged: [{ path: 'utils.js', diffSummary: 'added isPalindrome helper' }],
      commands: ['node --check utils.js'],
    },
  };
  const report = formatReport(doc, { valid: true, errors: [] });
  assert.ok(report.includes('IMPLEMENTAÇÃO'));
  assert.ok(report.includes('utils.js — added isPalindrome helper'));
  assert.ok(report.includes('$ node --check utils.js'));
});

await check('report shows the real diff summary and worktree path, with manual-merge guidance', () => {
  const doc = { request: { objective: 'x' }, implementation: { status: 'completed' } };
  const report = formatReport(doc, { valid: true, errors: [] }, {
    diffSummary: { totalFiles: 1, insertions: 3, deletions: 0 },
    worktreePath: '/tmp/some-project/.worktrees/fake-impl-implementer',
  });
  assert.ok(report.includes('1 arquivo(s), +3/-0'));
  assert.ok(report.includes('/tmp/some-project/.worktrees/fake-impl-implementer'));
  assert.ok(report.includes('Nada foi aplicado ao projeto real'));
  assert.ok(report.includes('git merge'));
});

await check('report omits the implementation section entirely when no implement step ran', () => {
  const doc = { request: { objective: 'x' }, analysis: { problem: 'y' } };
  const report = formatReport(doc, { valid: true, errors: [] });
  assert.ok(!report.includes('IMPLEMENTAÇÃO'));
});

console.log(`\n${passed} passed`);
if (process.exitCode) console.log('SOME TESTS FAILED');
