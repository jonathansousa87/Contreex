// Cascading config loader: Global (~/.contreex/config.yaml) -> Workspace
// (~/.contreex/workspaces/<profile>.yaml) -> Project (.contreex-profile).
//
// Profile selection is NEVER silent. If no .contreex-profile is found walking
// up from the start directory, or if it doesn't name a profile, this throws —
// deliberately, so a personal project can never accidentally inherit a
// corporate workspace's MCP servers/credentials/roles just because some
// default happened to be "corporate". This was an explicit design decision,
// not an oversight: see the project's architecture doc, "workspaces" section.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const PROFILE_FILENAME = '.contreex-profile';
const GLOBAL_CONFIG_PATH = join(homedir(), '.contreex', 'config.yaml');
const WORKSPACES_DIR = join(homedir(), '.contreex', 'workspaces');

export class NoProfileError extends Error {}
export class UnknownWorkspaceError extends Error {}

function loadYamlIfExists(path) {
  if (!existsSync(path)) return null;
  return parseYaml(readFileSync(path, 'utf8')) ?? {};
}

/** Walks up from startDir looking for .contreex-profile, like git looks for .git. */
export function findProjectProfile(startDir = process.cwd()) {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, PROFILE_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

// Plain objects deep-merge key by key; arrays and primitives are replaced
// wholesale by the more specific layer — no implicit array concatenation,
// which would make it unclear what a project actually ends up with.
function deepMerge(base, override) {
  if (override === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base) || typeof override !== 'object' || override === null || Array.isArray(override)) {
    return override;
  }
  const merged = { ...base };
  for (const key of Object.keys(override)) {
    merged[key] = deepMerge(base[key], override[key]);
  }
  return merged;
}

/**
 * Resolves the full cascade for a given starting directory. Throws
 * NoProfileError / UnknownWorkspaceError rather than falling back to a
 * default — the caller must handle those explicitly (e.g. prompt the user
 * to run `contreex init`).
 */
export function resolveConfig(startDir = process.cwd()) {
  const profilePath = findProjectProfile(startDir);
  if (!profilePath) {
    throw new NoProfileError(
      `No ${PROFILE_FILENAME} found from '${startDir}' up to the filesystem root. Contreex never assumes a default workspace — create one explicitly (e.g. "profile: home") before running.`,
    );
  }

  const projectConfig = loadYamlIfExists(profilePath) ?? {};
  const profileName = projectConfig.profile;
  if (!profileName) {
    throw new NoProfileError(`${profilePath} exists but does not set "profile: <name>".`);
  }

  const workspacePath = join(WORKSPACES_DIR, `${profileName}.yaml`);
  const workspaceConfig = loadYamlIfExists(workspacePath);
  if (workspaceConfig === null) {
    throw new UnknownWorkspaceError(`Profile '${profileName}' (from ${profilePath}) has no matching workspace file at ${workspacePath}.`);
  }

  const globalConfig = loadYamlIfExists(GLOBAL_CONFIG_PATH) ?? {};

  const merged = deepMerge(deepMerge(globalConfig, workspaceConfig), projectConfig);

  return {
    profile: profileName,
    projectRoot: dirname(profilePath),
    sources: { global: GLOBAL_CONFIG_PATH, workspace: workspacePath, project: profilePath },
    config: merged,
  };
}
