import { normalize, canonicalizeReviewSeverities } from './normalize.mjs';
import { validateAepDocument, validateAepSection } from './validate.mjs';

export { normalize, validateAepDocument, validateAepSection };

/**
 * Full pipeline: raw CLI stdout -> normalized JSON string -> parsed object ->
 * schema-validated against one AEP section. Throws on parse failure (a
 * genuinely malformed response, distinct from a schema mismatch); schema
 * mismatches are returned, not thrown, so callers can decide whether to
 * retry the agent or fail the run.
 */
export function parseAndValidateSection(rawText, defName) {
  const jsonText = normalize(rawText);
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (e) {
    return { parsed: false, valid: false, errors: [{ path: '(root)', message: `JSON.parse failed: ${e.message}` }], data: null };
  }
  if (defName === 'review') data = canonicalizeReviewSeverities(data);
  const { valid, errors } = validateAepSection(defName, data);
  return { parsed: true, valid, errors, data };
}
