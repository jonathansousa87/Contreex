// Phase 2 end-to-end demo: a real headless Claude Code call producing an
// "analysis" section, validated through the same Normalizer + Validator
// every future agent adapter will use — not a hand-crafted fixture.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from '../src/exec.mjs';
import { parseAndValidateSection } from '../src/aep/index.mjs';

const schema = JSON.parse(readFileSync(new URL('../schema/aep.v1.schema.json', import.meta.url), 'utf8'));
// claude --json-schema needs a fully self-contained schema, not a $ref to an
// external $id — inline the "analysis" $def directly rather than referencing it.
const analysisSchema = { type: 'object', ...schema.$defs.analysis };

const TASK = 'Add a function isPalindrome(str) to a JavaScript utils file that returns true if str reads the same forwards and backwards (case-insensitive, ignore spaces).';

const prompt = `You are the "implementer" role in a multi-agent pipeline. Analyze this task and reply with ONLY a JSON object (no markdown fences, no prose) describing your analysis. Task: ${TASK}`;

const cwd = mkdtempSync(join(tmpdir(), 'contreex-demo-'));
console.log(`sandbox: ${cwd}`);
console.log('invoking claude (native --json-schema as first layer)...');

const result = await exec(
  'claude',
  ['-p', prompt, '--permission-mode', 'dontAsk', '--output-format', 'json', '--json-schema', JSON.stringify(analysisSchema)],
  { cwd, timeout: 60_000 },
);

rmSync(cwd, { recursive: true, force: true });

if (!result.ok) {
  console.error('claude invocation failed:', result.timedOut ? 'TIMED OUT' : `exit ${result.code}`);
  console.error(result.stderr.slice(0, 500));
  process.exit(1);
}

// --output-format json wraps the turn; the model's raw reply is in "result".
const outer = JSON.parse(result.stdout);
const rawModelReply = outer.result;
console.log('\nraw model reply (pre-normalize):');
console.log(rawModelReply);

const { parsed, valid, errors, data } = parseAndValidateSection(rawModelReply, 'analysis');

console.log('\n=== Normalizer + Validator result ===');
console.log(`parsed: ${parsed} | valid against AEP "analysis" schema: ${valid}`);
if (!valid) console.log('errors:', JSON.stringify(errors, null, 2));
else console.log('data:', JSON.stringify(data, null, 2));

console.log(`\nnative --json-schema agreement: ${valid ? 'CONFIRMED — Claude Code\'s own schema flag and our independent Validator agree' : 'DISAGREEMENT — investigate'}`);
