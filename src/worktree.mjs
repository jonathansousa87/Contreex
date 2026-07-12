// Git worktree isolation for the Agent Manager. Every agent invocation — implementer
// or reviewer — runs in its own worktree, never the real working tree. A reviewer
// that ignores its permission flags and writes anyway only touches its own disposable
// worktree; only the implementer's worktree is ever merged back to main. This is the
// universal backstop validated against claw-orchestrator's and ccswarm's prior art —
// it does not depend on any single CLI's permission model being trustworthy.

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from './exec.mjs';

const VALID_ROLE_NAME = /^[a-zA-Z0-9_-]+$/;
const GIT_TIMEOUT_MS = 15_000;

async function git(projectDir, args, opts = {}) {
  const r = await exec('git', ['-C', projectDir, ...args], { timeout: GIT_TIMEOUT_MS, ...opts });
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r;
}

export async function ensureRepoReady(projectDir) {
  if (!existsSync(projectDir)) mkdirSync(projectDir, { recursive: true });

  const isGit = await exec('git', ['-C', projectDir, 'rev-parse', '--git-dir'], { timeout: GIT_TIMEOUT_MS });
  if (!isGit.ok) await git(projectDir, ['init']);

  await git(projectDir, ['config', '--local', 'user.email', 'contreex@localhost']);
  await git(projectDir, ['config', '--local', 'user.name', 'Contreex']);

  const hasCommit = await exec('git', ['-C', projectDir, 'rev-parse', 'HEAD'], { timeout: GIT_TIMEOUT_MS });
  if (!hasCommit.ok) {
    await git(projectDir, ['add', '-A']);
    await git(projectDir, ['commit', '--allow-empty', '-m', 'contreex: initial']);
  }
}

/**
 * Creates (or reuses, hard-resetting if dirty) an isolated worktree for one
 * role. Returns the absolute path the agent should be invoked with as cwd.
 */
export async function createWorktree(projectDir, roleName) {
  if (!VALID_ROLE_NAME.test(roleName)) {
    throw new Error(`Invalid role name '${roleName}': must match ${VALID_ROLE_NAME}`);
  }

  await ensureRepoReady(projectDir);

  const wtDir = join(projectDir, '.worktrees', roleName);
  const branch = `contreex/${roleName}`;

  if (existsSync(wtDir)) {
    const valid = await exec('git', ['-C', wtDir, 'rev-parse', '--git-dir'], { timeout: GIT_TIMEOUT_MS });
    if (valid.ok) {
      const dirty = await exec('git', ['-C', wtDir, 'status', '--porcelain'], { timeout: GIT_TIMEOUT_MS });
      if (dirty.stdout.trim().length > 0) {
        // Leftover writes from a previous reviewer run — exactly what worktree
        // isolation exists to make safe to discard.
        await git(wtDir, ['reset', '--hard', 'HEAD']);
        await git(wtDir, ['clean', '-fd']);
      }
      return wtDir;
    }
  }

  const branchExists = await exec('git', ['-C', projectDir, 'rev-parse', '--verify', branch], { timeout: GIT_TIMEOUT_MS });
  if (branchExists.ok) {
    await git(projectDir, ['worktree', 'add', wtDir, branch]);
  } else {
    await git(projectDir, ['worktree', 'add', '-b', branch, wtDir]);
  }
  return wtDir;
}

export async function removeWorktree(projectDir, roleName) {
  const wtDir = join(projectDir, '.worktrees', roleName);
  await exec('git', ['-C', projectDir, 'worktree', 'remove', '--force', wtDir], { timeout: GIT_TIMEOUT_MS });
}
