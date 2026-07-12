// Phase 3 end-to-end demo: real Agent Manager, real worktree isolation, real
// CLI calls. Proves three things at once:
//   1. Two different plugins (claude, codex) run through the same manager,
//      each getting AEP-validated output.
//   2. Worktree isolation actually isolates — the reviewer is told to write a
//      "fix" file; we confirm it never reaches the real project directory.
//   3. Agent state is observable after each run.

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync as readFileSyncU } from 'node:fs';
import { AgentManager } from '../src/agent-manager.mjs';
import { claudeAgent } from '../src/agents/claude-agent.mjs';
import { codexAgent } from '../src/agents/codex-agent.mjs';

const schema = JSON.parse(readFileSyncU(new URL('../schema/aep.v1.schema.json', import.meta.url), 'utf8'));
const analysisSchema = { type: 'object', ...schema.$defs.analysis };

const projectDir = mkdtempSync(join(tmpdir(), 'contreex-phase3-'));
writeFileSync(join(projectDir, 'utils.js'), '// utils.js — add helpers here\nmodule.exports = {};\n');
console.log(`project: ${projectDir}`);

const manager = new AgentManager({ maxRetries: 1 });

console.log('\n--- implementer (claude) ---');
const analysis = await manager.run(claudeAgent, {
  projectDir,
  role: 'implementer',
  prompt:
    'You are the implementer. Analyze this task and reply with ONLY a JSON object (no prose): add isPalindrome(str) to utils.js, case-insensitive, ignore spaces. Task context: a starter utils.js already exists in the current directory.',
  defName: 'analysis',
  jsonSchema: analysisSchema,
  timeout: 60_000,
});
console.log(`state: ${analysis.state} | attempts: ${analysis.attempts} | valid: ${analysis.ok}`);
console.log('worktree:', analysis.cwd);
if (!analysis.ok) console.log('errors:', analysis.validationErrors ?? analysis.error);

console.log('\n--- reviewer (codex) — deliberately asked to also write a file, to stress-test isolation ---');
const review = await manager.run(codexAgent, {
  projectDir,
  role: 'reviewer',
  prompt:
    'You are a reviewer. Look at utils.js in the current directory. Also write your own suggested fixed.js file with an isPalindrome implementation in the current directory, then reply with ONLY a JSON object (no prose, no markdown fences) with keys "verdict" (one of APPROVE, CHANGES_NEEDED, BLOCKED) and "findings" (array of {severity, summary}) reviewing the current utils.js.',
  defName: 'review',
  timeout: 60_000,
});
console.log(`state: ${review.state} | attempts: ${review.attempts} | valid: ${review.ok}`);
console.log('worktree:', review.cwd);
if (!review.ok) console.log('errors:', review.validationErrors ?? review.error);
else console.log('data:', JSON.stringify(review.data, null, 2));

console.log('\n--- isolation check ---');
const mainUtilsUntouched = readFileSync(join(projectDir, 'utils.js'), 'utf8').includes('add helpers here');
const reviewerWroteInOwnWorktree = existsSync(join(review.cwd, 'fixed.js'));
console.log(`main project utils.js untouched: ${mainUtilsUntouched}`);
console.log(`reviewer's own worktree has fixed.js (if it wrote at all, contained there): ${reviewerWroteInOwnWorktree}`);
console.log(`fixed.js leaked into main project: ${existsSync(join(projectDir, 'fixed.js'))}`);

console.log('\n--- final agent states ---');
console.log(`claude: ${manager.getState('claude')}`);
console.log(`codex: ${manager.getState('codex')}`);

rmSync(projectDir, { recursive: true, force: true });
