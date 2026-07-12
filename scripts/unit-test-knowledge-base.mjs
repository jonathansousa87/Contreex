import assert from 'node:assert/strict';
import { addEntry, listEntries, queryKnowledgeBase } from '../src/knowledge-base.mjs';
import { ContextEngine } from '../src/context-engine.mjs';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   - ${name}`);
  } catch (e) {
    console.log(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// Use a unique tag per test run so repeated runs (and the real ~/.contreex/
// knowledge-base.jsonl accumulating across sessions) never cross-contaminate
// assertions — same lesson learned the hard way in unit-test-event-bus.mjs.
const NONCE = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

check('addEntry rejects empty text', () => {
  assert.throws(() => addEntry({ text: '' }));
  assert.throws(() => addEntry({ text: '   ' }));
});

check('addEntry persists and listEntries returns it', () => {
  const entry = addEntry({ text: `Codex tends to miss async concurrency bugs [${NONCE}]`, tags: [NONCE, 'codex', 'concurrency'] });
  assert.ok(entry.id);
  assert.ok(entry.addedAt);
  const all = listEntries();
  assert.ok(all.some((e) => e.id === entry.id));
});

check('queryKnowledgeBase finds a relevant entry by keyword overlap, ignores irrelevant ones', () => {
  // Deliberately no NONCE in these two — sharing a nonce token between the
  // query and an unrelated entry's tags would itself create false overlap.
  // Distinctive topic words (retriesparamxyz / dockernetworkxyz) are enough
  // to avoid cross-run false matches without that risk.
  addEntry({ text: 'Claude ignores the retriesparamxyz under load', tags: ['claude', 'retriesparamxyz'] });
  addEntry({ text: 'Totally unrelated lesson about dockernetworkxyz', tags: ['dockernetworkxyz'] });

  const results = queryKnowledgeBase('investigating retriesparamxyz behavior');
  assert.ok(results.some((r) => r.includes('retriesparamxyz')));
  assert.ok(!results.some((r) => r.includes('dockernetworkxyz')));
});

check('ContextEngine.gather() for analyze includes matching Knowledge Base entries', () => {
  const marker = `unique-marker-${NONCE}`;
  addEntry({ text: `Special lesson about ${marker}`, tags: [marker] });

  const ce = new ContextEngine();
  const doc = { request: { objective: `Please consider ${marker} before proceeding` } };
  const context = ce.gather({ action: 'analyze', doc, projectDir: null });
  assert.ok(context.some((c) => c.includes('Knowledge Base') && c.includes(marker)));
});

check('ContextEngine.gather() for review also includes matching Knowledge Base entries', () => {
  const marker = `review-marker-${NONCE}`;
  addEntry({ text: `Reviewer lesson about ${marker}`, tags: [marker] });

  const ce = new ContextEngine();
  const doc = { request: { objective: `Task involving ${marker}` }, plan: { steps: [{ id: '1', description: 'x' }] } };
  const context = ce.gather({ action: 'review', doc, projectDir: null });
  assert.ok(context.some((c) => c.includes('Knowledge Base') && c.includes(marker)));
});

check('gather() with a custom knowledgeLookup never calls the real file-backed one (dependency injection works)', () => {
  let called = false;
  const ce = new ContextEngine({ knowledgeLookup: () => { called = true; return ['injected lesson']; } });
  const context = ce.gather({ action: 'analyze', doc: { request: { objective: 'x' } }, projectDir: null });
  assert.equal(called, true);
  assert.ok(context.some((c) => c.includes('injected lesson')));
});

check('regression: a real short task objective matches a prose lesson mentioning the same term (found via a live run, not hypothetical)', () => {
  // "Add isPalindrome(str) to utils.js" vs a prose KB entry mentioning
  // "isPalindrome" scored 0.167 with the original 0.2 threshold — a false
  // miss caught by actually running this against a real objective, not by
  // guessing the threshold was fine.
  addEntry({ text: `When adding isPalindromeXyzTest-style helpers, always confirm the punctuation rule first [${NONCE}]`, tags: [NONCE] });
  const results = queryKnowledgeBase(`Add isPalindromeXyzTest(str) to utils.js [${NONCE}]`);
  assert.ok(results.some((r) => r.includes('isPalindromeXyzTest')));
});

console.log(`\n${passed} passed`);
if (process.exitCode) console.log('SOME TESTS FAILED');
