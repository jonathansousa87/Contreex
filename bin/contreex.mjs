#!/usr/bin/env node
// Minimal CLI shell — deliberately thin. Its only job is to give the tool a
// real terminal entry/exit point. No Language Engine yet (see ROADMAP.md #2):
// today the objective must be written in English. This exists so that
// component has somewhere real to plug into, not to be a finished product.

import { resolveConfig, NoProfileError, UnknownWorkspaceError } from '../src/config/load.mjs';
import { resolveRoles } from '../src/agents/registry.mjs';
import { runOrchestrator } from '../src/orchestrator.mjs';

function printUsage() {
  console.log(`Usage: contreex "<objective>" [options]

Options:
  --dir <path>   Project directory to run in (default: current directory)
  --json         Also print the full AEP document as JSON
  -h, --help     Show this help

Requires a .contreex-profile file in the target directory or one of its
parents (like .git). See docs/examples/contreex-profile.yaml for a template.

Example:
  contreex "Add isPalindrome(str) to utils.js"`);
}

function parseArgs(argv) {
  const args = { objective: null, dir: process.cwd(), json: false, help: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--dir') args.dir = argv[++i];
    else rest.push(a);
  }
  args.objective = rest.join(' ').trim() || null;
  return args;
}

function printSummary(doc, documentValid) {
  console.log('\n=== Summary ===');
  if (doc.analysis) console.log(`Problem: ${doc.analysis.problem}`);
  if (doc.plan) console.log(`Plan: ${doc.plan.steps.length} step(s)`);

  const reviews = Object.entries(doc.reviews ?? {});
  if (reviews.length) {
    console.log('Reviews:');
    for (const [role, review] of reviews) {
      const findings = review.findings?.length ? ` (${review.findings.length} finding(s))` : '';
      console.log(`  - ${role}: ${review.verdict}${findings}`);
    }
  }

  if (doc.refinement) {
    console.log(`Refinement: ${doc.refinement.acceptedChanges?.length ?? 0} accepted, ${doc.refinement.rejectedChanges?.length ?? 0} rejected`);
  }

  console.log(`\nDocument valid: ${documentValid.valid}`);
  if (!documentValid.valid) console.log('Validation errors:', JSON.stringify(documentValid.errors, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.objective) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  let resolved;
  try {
    resolved = resolveConfig(args.dir);
  } catch (e) {
    if (e instanceof NoProfileError || e instanceof UnknownWorkspaceError) {
      console.error(`contreex: ${e.message}`);
      console.error('\nSee docs/examples/contreex-profile.yaml for a template.');
      process.exit(1);
    }
    throw e;
  }

  console.log(`profile: ${resolved.profile} | roles: ${JSON.stringify(resolved.config.roles)}`);
  console.log(`\nRunning pipeline for: "${args.objective}"`);

  const roles = resolveRoles(resolved.config.roles);
  const { doc, documentValid } = await runOrchestrator({
    projectDir: resolved.projectRoot,
    objective: args.objective,
    pipeline: resolved.config.pipeline,
    roles,
  });

  printSummary(doc, documentValid);

  if (args.json) {
    console.log('\n--- AEP document ---');
    console.log(JSON.stringify(doc, null, 2));
  }

  process.exit(documentValid.valid ? 0 : 1);
}

main().catch((err) => {
  console.error('contreex: unexpected error —', err.message);
  process.exit(1);
});
