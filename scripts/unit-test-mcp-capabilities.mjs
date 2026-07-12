import assert from 'node:assert/strict';
import { resolveCapabilities, writeMcpConfigForCapabilities } from '../src/mcp-gateway.mjs';

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

const CORPORATE_MAP = { git: 'corporate', issueTracker: 'jira', docs: 'confluence' };

check('resolveCapabilities maps known capabilities to their server names', () => {
  const { serverNames, unavailable } = resolveCapabilities(['git', 'issueTracker'], CORPORATE_MAP);
  assert.deepEqual(serverNames.sort(), ['corporate', 'jira']);
  assert.deepEqual(unavailable, []);
});

check('an unmapped capability is reported unavailable, not thrown', () => {
  const { serverNames, unavailable } = resolveCapabilities(['git', 'ciPipeline'], CORPORATE_MAP);
  assert.deepEqual(serverNames, ['corporate']);
  assert.deepEqual(unavailable, ['ciPipeline']);
});

check('a workspace with no capability map at all (e.g. home) degrades gracefully — everything unavailable, no crash', () => {
  const { serverNames, unavailable } = resolveCapabilities(['git', 'issueTracker'], {});
  assert.deepEqual(serverNames, []);
  assert.deepEqual(unavailable, ['git', 'issueTracker']);
});

check('empty capability request resolves to nothing, cleanly', () => {
  const { serverNames, unavailable } = resolveCapabilities([], CORPORATE_MAP);
  assert.deepEqual(serverNames, []);
  assert.deepEqual(unavailable, []);
});

check('writeMcpConfigForCapabilities resolves a capability through to a real, defined server', () => {
  // "corporate.json" is a real (placeholder) definition shipped since Phase 6 —
  // "git" maps to "corporate" in CORPORATE_MAP, and that server IS defined.
  const result = writeMcpConfigForCapabilities(['git'], CORPORATE_MAP);
  assert.deepEqual(result.unavailableCapabilities, []); // "git" itself was mapped fine
  assert.deepEqual(result.missing, []); // and the underlying server has a definition file
  assert.ok(result.serverNames.includes('corporate'));
});

check('writeMcpConfigForCapabilities reports an unmapped capability without touching the filesystem lookup for it', () => {
  const result = writeMcpConfigForCapabilities(['ciPipeline'], CORPORATE_MAP);
  assert.deepEqual(result.unavailableCapabilities, ['ciPipeline']);
  assert.deepEqual(result.serverNames, []);
});

console.log(`\n${passed} passed`);
if (process.exitCode) console.log('SOME TESTS FAILED');
