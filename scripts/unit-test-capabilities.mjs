import assert from 'node:assert/strict';
import { AGENT_REGISTRY } from '../src/agents/registry.mjs';

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

const EXPECTED_FIELDS = [
  'headless',
  'supportsJson',
  'supportsMcp',
  'supportsImages',
  'supportsToolCalling',
  'supportsStreaming',
  'supportsPatch',
  'supportsReadOnly',
  'supportsSandbox',
];

for (const [name, plugin] of Object.entries(AGENT_REGISTRY)) {
  check(`${name} plugin's capabilities() has every expected field (boolean or null, never undefined)`, () => {
    const caps = plugin.capabilities();
    for (const field of EXPECTED_FIELDS) {
      assert.ok(field in caps, `missing field '${field}'`);
      const value = caps[field];
      assert.ok(typeof value === 'boolean' || value === null, `field '${field}' is ${typeof value}, expected boolean or null`);
    }
  });
}

check('claude and codex both confirm real MCP support (--mcp-config / mcp subcommands)', () => {
  assert.equal(AGENT_REGISTRY.claude.capabilities().supportsMcp, true);
  assert.equal(AGENT_REGISTRY.codex.capabilities().supportsMcp, true);
});

check('agy confirms no MCP support found (absence checked, not assumed)', () => {
  assert.equal(AGENT_REGISTRY.agy.capabilities().supportsMcp, false);
});

check('agy and mimo both confirm supportsReadOnly: false — the real Phase 0 finding that motivated worktree isolation', () => {
  assert.equal(AGENT_REGISTRY.agy.capabilities().supportsReadOnly, false);
  assert.equal(AGENT_REGISTRY.mimo.capabilities().supportsReadOnly, false);
});

check('claude and codex both confirm supportsReadOnly: true — the modes that actually work (dontAsk / --sandbox read-only)', () => {
  assert.equal(AGENT_REGISTRY.claude.capabilities().supportsReadOnly, true);
  assert.equal(AGENT_REGISTRY.codex.capabilities().supportsReadOnly, true);
});

console.log(`\n${passed} passed`);
if (process.exitCode) console.log('SOME TESTS FAILED');
