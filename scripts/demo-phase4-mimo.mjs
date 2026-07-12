// Same pipeline as demo-phase4.mjs, but with a third reviewer (mimo) added —
// zero changes to orchestrator.mjs or agent-manager.mjs required. This is the
// actual test of "roles, not vendors": swapping/adding a provider is a config
// change (the `roles` map below), not a code change.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOrchestrator } from '../src/orchestrator.mjs';
import { AgentManager } from '../src/agent-manager.mjs';
import { claudeAgent } from '../src/agents/claude-agent.mjs';
import { codexAgent } from '../src/agents/codex-agent.mjs';
import { agyAgent } from '../src/agents/agy-agent.mjs';
import { mimoAgent } from '../src/agents/mimo-agent.mjs';

const projectDir = mkdtempSync(join(tmpdir(), 'contreex-phase4-mimo-'));
writeFileSync(join(projectDir, 'utils.js'), '// utils.js — add helpers here\nmodule.exports = {};\n');
console.log(`project: ${projectDir}`);

const roles = { implementer: claudeAgent, reviewer1: codexAgent, reviewer2: agyAgent, reviewer3: mimoAgent };
const pipeline = [
  { role: 'implementer', action: 'analyze' },
  { parallel: [
    { role: 'reviewer1', action: 'review' },
    { role: 'reviewer2', action: 'review' },
    { role: 'reviewer3', action: 'review' },
  ] },
  { role: 'implementer', action: 'refine' },
];

const startedAt = Date.now();
const { doc, documentValid } = await runOrchestrator({
  projectDir,
  objective: 'Add isPalindrome(str) to utils.js — case-insensitive, ignore spaces.',
  pipeline,
  roles,
  manager: new AgentManager({ maxRetries: 1 }),
});
console.log(`\ntotal wall time: ${Date.now() - startedAt}ms (3 reviewers ran in parallel)`);

console.log('\n=== reviews collected ===');
console.log(JSON.stringify(doc.reviews, null, 2));

console.log('\n=== logs ===');
for (const l of doc.logs) console.log(`[${l.level}] ${l.message}`);

console.log('\n=== document-level validation ===');
console.log(`valid: ${documentValid.valid}`);
if (!documentValid.valid) console.log(JSON.stringify(documentValid.errors, null, 2));

rmSync(projectDir, { recursive: true, force: true });
