import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { aepSchema as schema } from './schema.mjs';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const validateDoc = ajv.compile(schema);

// One compiled validator per named $def, so an agent that only produces a
// single section (e.g. a reviewer producing just "review") can be checked
// without needing a full AEP document wrapper.
const sectionValidators = new Map();
function sectionValidator(defName) {
  if (!sectionValidators.has(defName)) {
    sectionValidators.set(defName, ajv.compile({ $ref: `${schema.$id}#/$defs/${defName}` }));
  }
  return sectionValidators.get(defName);
}

export function validateAepDocument(doc) {
  const valid = validateDoc(doc);
  return { valid, errors: valid ? [] : summarize(validateDoc.errors) };
}

export function validateAepSection(defName, data) {
  const fn = sectionValidator(defName);
  const valid = fn(data);
  return { valid, errors: valid ? [] : summarize(fn.errors) };
}

function summarize(errors) {
  return (errors ?? []).map((e) => ({ path: e.instancePath || '(root)', message: e.message, params: e.params }));
}
