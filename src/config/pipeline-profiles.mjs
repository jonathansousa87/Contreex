// Named pipeline presets (fast/standard/review/critical/enterprise/analysis-only)
// live as real YAML files at ~/.contreex/pipelines/<name>.yaml — see
// docs/examples/pipelines/ for the shipped templates. A project selects one
// via "pipelineProfile: <name>" anywhere in the config cascade (global,
// workspace, or .contreex-profile); resolveConfig() (src/config/load.mjs)
// applies it after the cascade merge, overriding whatever raw "pipeline:"
// array came through. Omitting pipelineProfile keeps today's behavior:
// whatever "pipeline:" the cascade resolved to, unchanged.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const PIPELINES_DIR = join(homedir(), '.contreex', 'pipelines');

export class UnknownPipelineProfileError extends Error {}

export function loadPipelineProfile(name) {
  const path = join(PIPELINES_DIR, `${name}.yaml`);
  if (!existsSync(path)) {
    throw new UnknownPipelineProfileError(`Pipeline profile '${name}' not found at ${path}. See docs/examples/pipelines/ for templates.`);
  }
  const doc = parseYaml(readFileSync(path, 'utf8'));
  if (!Array.isArray(doc?.pipeline)) {
    throw new UnknownPipelineProfileError(`${path} does not define a "pipeline:" array.`);
  }
  return doc.pipeline;
}
