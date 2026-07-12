import assert from 'node:assert/strict';
import { decide, strategies } from '../src/consensus.mjs';
import { validateAepSection } from '../src/aep/validate.mjs';

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

const ALL_APPROVE = { reviews: { r1: { verdict: 'APPROVE' }, r2: { verdict: 'APPROVE' } } };
const SPLIT = { reviews: { r1: { verdict: 'APPROVE' }, r2: { verdict: 'CHANGES_NEEDED' } } };
const ONE_BLOCKED = { reviews: { r1: { verdict: 'APPROVE' }, r2: { verdict: 'BLOCKED' } } };
const MAJORITY_APPROVE = { reviews: { r1: { verdict: 'APPROVE' }, r2: { verdict: 'APPROVE' }, r3: { verdict: 'CHANGES_NEEDED' } } };

check('unanimity: APPROVE only when every reviewer approves', () => {
  assert.equal(strategies.unanimity(ALL_APPROVE).verdict, 'APPROVE');
  assert.equal(strategies.unanimity(SPLIT).verdict, 'CHANGES_NEEDED');
});

check('unanimity: any BLOCKED wins over everything else', () => {
  assert.equal(strategies.unanimity(ONE_BLOCKED).verdict, 'BLOCKED');
});

check('majority: APPROVE with >50% even if not unanimous', () => {
  assert.equal(strategies.majority(SPLIT).verdict, 'CHANGES_NEEDED'); // 1/2 is not >50%
  assert.equal(strategies.majority(MAJORITY_APPROVE).verdict, 'APPROVE'); // 2/3 is >50%
});

check('implementerDecides never computes an independent verdict', () => {
  assert.equal(strategies.implementerDecides(ALL_APPROVE).verdict, null);
});

check('weighted: agents with no Decision Memory history get neutral (equal) weight', () => {
  // With no history for either agent, weighted should behave like unanimity/majority here.
  const result = strategies.weighted(ALL_APPROVE);
  assert.equal(result.verdict, 'APPROVE');
});

check('corporatePolicy defaults to unanimity, and can be pointed at another strategy', () => {
  assert.equal(strategies.corporatePolicy(SPLIT).verdict, 'CHANGES_NEEDED'); // default = unanimity
  assert.equal(strategies.corporatePolicy(MAJORITY_APPROVE, { policy: 'majority' }).verdict, 'APPROVE');
});

check('decide() throws a clear error for an unknown strategy name', () => {
  assert.throws(() => decide(ALL_APPROVE, 'doesNotExist'), /Unknown consensus strategy/);
});

check('decide() output validates against the AEP "consensus" schema section', () => {
  const result = decide(ALL_APPROVE, 'unanimity');
  const { valid, errors } = validateAepSection('consensus', result);
  assert.ok(valid, JSON.stringify(errors));
});

check('a null verdict (implementerDecides) still validates against the schema', () => {
  const result = decide(ALL_APPROVE, 'implementerDecides');
  const { valid, errors } = validateAepSection('consensus', result);
  assert.ok(valid, JSON.stringify(errors));
});

check('no reviews at all is handled without crashing (CHANGES_NEEDED, not an exception)', () => {
  assert.equal(strategies.unanimity({ reviews: {} }).verdict, 'CHANGES_NEEDED');
  assert.equal(strategies.majority({ reviews: {} }).verdict, 'CHANGES_NEEDED');
});

console.log(`\n${passed} passed`);
if (process.exitCode) console.log('SOME TESTS FAILED');
