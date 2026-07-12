import assert from 'node:assert/strict';
import { parseAndValidateSection, validateAepDocument } from '../src/aep/index.mjs';

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

// 1. plain JSON, no fences
check('plain JSON analysis parses and validates', () => {
  const raw = '{"problem":"login is slow","confidence":0.8}';
  const r = parseAndValidateSection(raw, 'analysis');
  assert.equal(r.parsed, true);
  assert.equal(r.valid, true);
});

// 2. markdown-fenced JSON with surrounding prose (realistic CLI output)
check('fenced JSON with prose around it', () => {
  const raw = 'Sure, here is the analysis:\n```json\n{"problem":"N+1 query in UserService"}\n```\nLet me know if you need more.';
  const r = parseAndValidateSection(raw, 'analysis');
  assert.equal(r.parsed, true);
  assert.equal(r.valid, true);
  assert.equal(r.data.problem, 'N+1 query in UserService');
});

// 3. nested braces inside string values must not break extraction
check('braces inside string values do not break extraction', () => {
  const raw = '{"problem":"config uses {{mustache}} templates and it breaks parsing"}';
  const r = parseAndValidateSection(raw, 'analysis');
  assert.equal(r.parsed, true);
  assert.equal(r.valid, true);
});

// 4. schema violation is reported, not thrown
check('missing required field is a validation error, not a crash', () => {
  const raw = '{"confidence":0.5}'; // missing required "problem"
  const r = parseAndValidateSection(raw, 'analysis');
  assert.equal(r.parsed, true);
  assert.equal(r.valid, false);
  assert.ok(r.errors.length > 0);
});

// 5. garbage input is a parse error, not a crash
check('non-JSON garbage is a parse error, not a crash', () => {
  const raw = 'I refuse to produce JSON today.';
  const r = parseAndValidateSection(raw, 'analysis');
  assert.equal(r.parsed, false);
  assert.equal(r.valid, false);
});

// 6. a review section validates against its own $def
check('review section validates independently', () => {
  const raw = '{"verdict":"CHANGES_NEEDED","findings":[{"severity":"high","summary":"missing null check"}]}';
  const r = parseAndValidateSection(raw, 'review');
  assert.equal(r.valid, true);
});

// 7. a full multi-section AEP document validates as a whole
check('full document with protocol + analysis + plan + reviews validates', () => {
  const doc = {
    protocol: { name: 'Agent Exchange Protocol', version: '1.0.0' },
    metadata: { requestId: 'REQ-1', role: 'implementer' },
    request: { objective: 'add isPalindrome helper' },
    analysis: { problem: 'no palindrome helper exists' },
    plan: { steps: [{ id: 's1', description: 'add function to utils.js' }] },
    reviews: {
      codex: { verdict: 'APPROVE' },
      agy: { verdict: 'CHANGES_NEEDED', findings: [{ severity: 'low', summary: 'add a test' }] },
    },
  };
  const { valid, errors } = validateAepDocument(doc);
  assert.equal(valid, true, JSON.stringify(errors));
});

// 8. reviewer writing outside its own reviews.<role> key must fail (immutability contract)
check('unknown top-level key is rejected (additionalProperties: false)', () => {
  const doc = {
    protocol: { name: 'Agent Exchange Protocol', version: '1.0.0' },
    sneakyField: 'a reviewer trying to write outside its lane',
  };
  const { valid, errors } = validateAepDocument(doc);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.message.includes('additional properties')));
});

// 9. severity synonyms (e.g. mimo's "major") get canonicalized before validation
check('severity synonym "major" is canonicalized to "high" and validates', () => {
  const raw = '{"verdict":"BLOCKED","findings":[{"severity":"major","summary":"utils.js missing"}]}';
  const r = parseAndValidateSection(raw, 'review');
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.data.findings[0].severity, 'high');
});

console.log(`\n${passed} passed`);
if (process.exitCode) console.log('SOME TESTS FAILED');
