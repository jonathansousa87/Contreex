// Phase 4 end-to-end demo: full pipeline — implementer analyzes, two reviewers
// run in parallel (real concurrency, not sequential), implementer refines based
// on both. Real CLI calls throughout, one accumulating AEP document at the end.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOrchestrator } from '../src/orchestrator.mjs';
import { AgentManager } from '../src/agent-manager.mjs';
import { claudeAgent } from '../src/agents/claude-agent.mjs';
import { codexAgent } from '../src/agents/codex-agent.mjs';
import { agyAgent } from '../src/agents/agy-agent.mjs';

const projectDir = mkdtempSync(join(tmpdir(), 'contreex-phase4-'));
writeFileSync(join(projectDir, 'utils.js'), '// utils.js — add helpers here\nmodule.exports = {};\n');
console.log(`project: ${projectDir}`);

const roles = { implementer: claudeAgent, reviewer1: codexAgent, reviewer2: agyAgent };
const pipeline = [
  { role: 'implementer', action: 'analyze' },
  { parallel: [
    { role: 'reviewer1', action: 'review' },
    { role: 'reviewer2', action: 'review' },
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
console.log(`\ntotal wall time: ${Date.now() - startedAt}ms (reviewers ran in parallel)`);

console.log('\n=== final AEP document ===');
console.log(JSON.stringify(doc, null, 2));

console.log('\n=== document-level validation ===');
console.log(`valid: ${documentValid.valid}`);
if (!documentValid.valid) console.log(JSON.stringify(documentValid.errors, null, 2));

rmSync(projectDir, { recursive: true, force: true });
