// Phase 7 demo: run two related tasks through the real pipeline. The second
// run should find the first in memory (real token-overlap similarity, not a
// fixture) and get it injected into the implementer's prompt. Then print
// aggregated per-agent stats built from the recorded runs.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOrchestrator } from '../src/orchestrator.mjs';
import { AgentManager } from '../src/agent-manager.mjs';
import { claudeAgent } from '../src/agents/claude-agent.mjs';
import { codexAgent } from '../src/agents/codex-agent.mjs';
import { agentStats } from '../src/memory/stats.mjs';

const roles = { implementer: claudeAgent, reviewer1: codexAgent };
const pipeline = [
  { role: 'implementer', action: 'analyze' },
  { parallel: [{ role: 'reviewer1', action: 'review' }] },
  { role: 'implementer', action: 'refine' },
];

async function runTask(objective) {
  const dir = mkdtempSync(join(tmpdir(), 'contreex-phase7-'));
  writeFileSync(join(dir, 'utils.js'), '// utils.js\nmodule.exports = {};\n');
  const { doc, documentValid, priorRunsUsed } = await runOrchestrator({
    projectDir: dir,
    objective,
    pipeline,
    roles,
    manager: new AgentManager({ maxRetries: 1 }),
  });
  rmSync(dir, { recursive: true, force: true });
  return { doc, documentValid, priorRunsUsed };
}

console.log('=== run 1: isPalindrome ===');
const run1 = await runTask('Add isPalindrome(str) to utils.js — case-insensitive, ignore spaces.');
console.log(`valid: ${run1.documentValid.valid} | prior runs found: ${run1.priorRunsUsed.length} (expected 0, memory was empty)`);

console.log('\n=== run 2: isAnagram (related task) ===');
const run2 = await runTask('Add isAnagram(str1, str2) to utils.js — case-insensitive, ignore spaces, returns true if the strings are anagrams of each other.');
console.log(`valid: ${run2.documentValid.valid} | prior runs found: ${run2.priorRunsUsed.length} (expected >=1 — should surface run 1)`);
if (run2.priorRunsUsed.length) {
  console.log(`matched objective: "${run2.priorRunsUsed[0].objective}" (similarity: ${run2.priorRunsUsed[0].similarity})`);
}

console.log('\n=== aggregated agent stats (from ~/.contreex/memory/runs.jsonl) ===');
console.log(JSON.stringify(agentStats(), null, 2));
