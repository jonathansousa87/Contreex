// Real demo: analyze -> parallel review -> consensus (local, no LLM cost) -> refine.
// Proves the "local" action path works inside a real orchestrator run, not
// just in isolation.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOrchestrator } from '../src/orchestrator.mjs';
import { AgentManager } from '../src/agent-manager.mjs';
import { claudeAgent } from '../src/agents/claude-agent.mjs';
import { codexAgent } from '../src/agents/codex-agent.mjs';

const dir = mkdtempSync(join(tmpdir(), 'contreex-consensus-demo-'));
writeFileSync(join(dir, 'utils.js'), '// utils.js\nmodule.exports = {};\n');

const roles = { implementer: claudeAgent, reviewer1: codexAgent };
const pipeline = [
  { role: 'implementer', action: 'analyze' },
  { parallel: [{ role: 'reviewer1', action: 'review' }] },
  { action: 'consensus', strategy: 'majority' }, // no role — local computation, no agent call
  { role: 'implementer', action: 'refine' },
];

const { doc, documentValid } = await runOrchestrator({
  projectDir: dir,
  objective: 'Add isPalindrome(str) to utils.js',
  pipeline,
  roles,
  manager: new AgentManager({ maxRetries: 1 }),
});
rmSync(dir, { recursive: true, force: true });

console.log('consensus:', JSON.stringify(doc.consensus, null, 2));
console.log('document valid:', documentValid.valid);
console.log('logs:');
for (const l of doc.logs) console.log(`  [${l.level}] ${l.message}`);
