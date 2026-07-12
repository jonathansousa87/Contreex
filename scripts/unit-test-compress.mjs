import assert from 'node:assert/strict';
import { condenseDiff } from '../src/compress.mjs';

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

const SAMPLE_DIFF = `diff --git a/utils.js b/utils.js
index 0bc454b..a292d74 100644
--- a/utils.js
+++ b/utils.js
@@ -1,3 +1,3 @@
 // utils.js
-function add(a, b) { return a + b; }
+function add(a, b) { return a + b; } // addition
 module.exports = { add };
`;

check('strips diff metadata headers (diff --git, index, ---, +++, @@)', () => {
  const condensed = condenseDiff(SAMPLE_DIFF);
  assert.ok(!condensed.includes('diff --git'));
  assert.ok(!condensed.includes('index 0bc454b'));
  assert.ok(!condensed.includes('@@ -1,3'));
});

check('never drops a real +/- change line — the actual correctness guarantee', () => {
  const condensed = condenseDiff(SAMPLE_DIFF);
  assert.ok(condensed.includes('-function add(a, b) { return a + b; }'));
  assert.ok(condensed.includes('+function add(a, b) { return a + b; } // addition'));
});

check('a large synthetic diff (200 changed lines) keeps every single line — unlike RTK real default, which truncates at 100/hunk', () => {
  const lines = ['diff --git a/big.js b/big.js', '--- a/big.js', '+++ b/big.js', '@@ -1,150 +1,150 @@'];
  for (let i = 0; i < 100; i++) lines.push(`-line${i}`);
  for (let i = 0; i < 100; i++) lines.push(`+line${i}v2`);
  const raw = lines.join('\n');
  const condensed = condenseDiff(raw);
  for (let i = 0; i < 100; i++) {
    assert.ok(condensed.includes(`-line${i}`), `missing -line${i}`);
    assert.ok(condensed.includes(`+line${i}v2`), `missing +line${i}v2`);
  }
});

check('never worse than the original — falls back to raw if condensing found nothing to strip', () => {
  const noHeaders = '+just one added line';
  assert.equal(condenseDiff(noHeaders), noHeaders);
});

check('an empty diff (no changes) returns the (empty) original, not garbage', () => {
  assert.equal(condenseDiff(''), '');
});

console.log(`\n${passed} passed`);
if (process.exitCode) console.log('SOME TESTS FAILED');
