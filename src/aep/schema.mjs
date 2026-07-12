import { readFileSync } from 'node:fs';

// Single load point for the raw AEP schema JSON — validate.mjs and any
// action that needs to build an ad-hoc schema from a $def both import this
// instead of each reading the file themselves.
export const aepSchema = JSON.parse(readFileSync(new URL('../../schema/aep.v1.schema.json', import.meta.url), 'utf8'));
