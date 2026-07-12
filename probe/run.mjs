import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agents } from './agents.mjs';
import { exec } from '../src/exec.mjs';

function sandbox() {
  return mkdtempSync(join(tmpdir(), 'contreex-probe-'));
}

async function testAgent(agent) {
  const r = { name: agent.name };
  console.log(`\n=== ${agent.name} ===`);

  // 1. version / installed
  const v = await exec(agent.cmd, agent.versionArgs, { timeout: 15_000 });
  r.installed = v.ok;
  r.version = v.stdout.trim() || null;
  console.log(`installed: ${r.installed} (${r.version ?? 'n/a'})`);
  if (!r.installed) return r;

  // 2. headless + JSON
  const cwdA = sandbox();
  const jsonRun = await exec(agent.cmd, agent.headlessArgs(agent.jsonPromptFor, cwdA), { cwd: cwdA });
  r.headless = !jsonRun.timedOut;
  if (!jsonRun.ok) r.headlessDebug = (jsonRun.stdout + jsonRun.stderr).slice(0, 400);
  try {
    const parsed = agent.extractJson(jsonRun.stdout);
    r.json = parsed && typeof parsed === 'object';
    r.jsonSample = JSON.stringify(parsed).slice(0, 200);
  } catch (e) {
    r.json = false;
    r.jsonError = String(e.message ?? e).slice(0, 200);
    if (!r.headlessDebug) r.headlessDebug = (jsonRun.stdout + jsonRun.stderr).slice(0, 400);
  }
  console.log(`headless: ${r.headless} | json: ${r.json}${r.jsonError ? ` (${r.jsonError})` : ''}`);
  rmSync(cwdA, { recursive: true, force: true });

  // 3. exit code — success case
  const cwdB = sandbox();
  const plainRun = await exec(agent.cmd, agent.plainArgs(agent.plainPromptFor, cwdB), { cwd: cwdB });
  r.exitCodeSuccess = plainRun.ok && plainRun.code === 0;
  if (!r.exitCodeSuccess) r.exitCodeSuccessDebug = (plainRun.stdout + plainRun.stderr).slice(0, 400);
  rmSync(cwdB, { recursive: true, force: true });

  // 3b. exit code — failure case (bad flag)
  const badRun = await exec(agent.cmd, agent.badArgs, { cwd: sandbox(), timeout: 15_000 });
  r.exitCodeFailure = !badRun.ok && badRun.code !== 0 && !badRun.timedOut;
  console.log(`exit code — success: ${r.exitCodeSuccess}, failure: ${r.exitCodeFailure} (code=${badRun.code})`);

  // 4. external timeout enforcement
  const cwdC = sandbox();
  const tRun = await exec(agent.cmd, agent.plainArgs(agent.plainPromptFor, cwdC), { cwd: cwdC, timeout: 3_000 });
  r.timeoutEnforced = tRun.timedOut && tRun.ms < 8_000;
  console.log(`timeout kill works: ${r.timeoutEnforced} (${tRun.ms}ms)`);
  rmSync(cwdC, { recursive: true, force: true });

  // 4b. native timeout flag, if the CLI advertises one
  if (agent.nativeTimeoutArgs) {
    const cwdD = sandbox();
    const ntRun = await exec(agent.cmd, agent.nativeTimeoutArgs(agent.plainPromptFor), {
      cwd: cwdD,
      timeout: 20_000, // generous Node-level backstop; we're checking the CLI's own limit
    });
    r.nativeTimeoutMs = ntRun.ms;
    r.nativeTimeoutRespected = ntRun.ms < 8_000;
    console.log(`native --print-timeout respected: ${r.nativeTimeoutRespected} (${ntRun.ms}ms)`);
    rmSync(cwdD, { recursive: true, force: true });
  }

  // 5. tool control — allow write
  const allowDir = sandbox();
  const allowRun = await exec(agent.cmd, agent.allowWriteArgs('probe.txt', allowDir), { cwd: allowDir });
  r.writeAllowed = existsSync(join(allowDir, 'probe.txt'));
  if (!r.writeAllowed) r.writeAllowedDebug = (allowRun.stdout + allowRun.stderr).slice(0, 300);
  rmSync(allowDir, { recursive: true, force: true });

  // 5b. tool control — deny write
  const denyDir = sandbox();
  const denyRun = await exec(agent.cmd, agent.denyWriteArgs('probe.txt', denyDir), { cwd: denyDir });
  r.writeBlockedWhenDenied = !existsSync(join(denyDir, 'probe.txt'));
  if (!r.writeBlockedWhenDenied) r.writeBlockedDebug = (denyRun.stdout + denyRun.stderr).slice(0, 300);
  rmSync(denyDir, { recursive: true, force: true });

  console.log(`tool control — allow works: ${r.writeAllowed}, deny enforced: ${r.writeBlockedWhenDenied}`);

  return r;
}

const report = [];
for (const agent of agents) {
  report.push(await testAgent(agent));
}

mkdirSync(new URL('../reports', import.meta.url), { recursive: true });
const outPath = new URL('../reports/phase0-capabilities.json', import.meta.url);
writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2));

console.log('\n\n=== capability table ===');
console.table(
  report.map((r) => ({
    agent: r.name,
    installed: r.installed ?? false,
    headless: r.headless ?? '-',
    json: r.json ?? '-',
    exitOk: r.exitCodeSuccess ?? '-',
    exitFail: r.exitCodeFailure ?? '-',
    timeoutKill: r.timeoutEnforced ?? '-',
    nativeTimeout: r.nativeTimeoutRespected ?? '-',
    writeAllow: r.writeAllowed ?? '-',
    writeDeny: r.writeBlockedWhenDenied ?? '-',
  })),
);
console.log(`\nfull report: reports/phase0-capabilities.json`);
