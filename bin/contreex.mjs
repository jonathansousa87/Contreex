#!/usr/bin/env node
// CLI shell. Talks to the user in whatever language the resolved config says
// (default: English, no translation) via the Language Engine, which sits at
// the very edges of the request/response path — everything between
// languageEngine.toInternal() and languageEngine.toOutput() operates in
// plain internal-language English, same as before this file existed.

import { resolveConfig, NoProfileError, UnknownWorkspaceError } from '../src/config/load.mjs';
import { resolveRoles } from '../src/agents/registry.mjs';
import { runOrchestrator } from '../src/orchestrator.mjs';
import { LanguageEngine } from '../src/language/engine.mjs';
import { classifyIntent, profileForIntent } from '../src/intent-analyzer.mjs';
import { loadPipelineProfile, UnknownPipelineProfileError } from '../src/config/pipeline-profiles.mjs';
import { openRouterOptimizer } from '../src/language/prompt-optimizer.mjs';

const DEFAULT_LANGUAGE = { input: 'en-US', internal: 'en-US', output: 'en-US' };

function printUsage() {
  console.log(`Usage: contreex "<objective>" [options]

Options:
  --dir <path>   Project directory to run in (default: current directory)
  --json         Also print the full AEP document as JSON
  -h, --help     Show this help

Requires a .contreex-profile file in the target directory or one of its
parents (like .git). See docs/examples/contreex-profile.yaml for a template.

The objective's language is read from the resolved config's "language"
section (default: English, no translation). Set "language.input: pt-BR" to
write objectives in Portuguese — see docs/examples/global-config.yaml.

Unless "pipelineProfile:" is set explicitly in your config, the pipeline is
chosen automatically based on what you actually asked for — an
analysis-only request never turns into an unrequested implementation. See
docs/examples/pipelines/ for the available profiles.

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

function buildSummary(doc, documentValid) {
  const lines = ['=== Summary ==='];
  if (doc.analysis) lines.push(`Problem: ${doc.analysis.problem}`);
  if (doc.analysis?.clarifyingQuestions?.length) {
    lines.push('Clarifying questions before a confident plan is possible:');
    for (const q of doc.analysis.clarifyingQuestions) lines.push(`  - ${q}`);
  }
  if (doc.plan) lines.push(`Plan: ${doc.plan.steps.length} step(s)`);

  const reviews = Object.entries(doc.reviews ?? {});
  if (reviews.length) {
    lines.push('Reviews:');
    for (const [role, review] of reviews) {
      const findings = review.findings?.length ? ` (${review.findings.length} finding(s))` : '';
      lines.push(`  - ${role}: ${review.verdict}${findings}`);
    }
  }

  if (doc.refinement) {
    lines.push(`Refinement: ${doc.refinement.acceptedChanges?.length ?? 0} accepted, ${doc.refinement.rejectedChanges?.length ?? 0} rejected`);
  }

  lines.push('', `Document valid: ${documentValid.valid}`);
  if (!documentValid.valid) lines.push('Validation errors:', JSON.stringify(documentValid.errors, null, 2));

  return lines.join('\n');
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

  // An explicit "pipelineProfile:" anywhere in the config cascade always
  // wins — auto-classification only kicks in when nothing was configured.
  // Runs on the raw, untranslated objective: the keyword fallback works in
  // whatever language the user typed, no network call needed by default.
  let pipeline = resolved.config.pipeline;
  if (!resolved.config.pipelineProfile) {
    const { intent, method } = await classifyIntent(args.objective, { optimizer: openRouterOptimizer });
    const profile = profileForIntent(intent);
    console.log(`intent: ${intent} (${method}) -> pipeline profile: ${profile}`);
    try {
      pipeline = loadPipelineProfile(profile);
    } catch (e) {
      if (!(e instanceof UnknownPipelineProfileError)) throw e;
      console.error(`contreex: ${e.message} — falling back to the configured pipeline.`);
    }
  }

  const language = { ...DEFAULT_LANGUAGE, ...(resolved.config.language ?? {}) };
  const translating = language.input !== language.internal;

  console.log(`profile: ${resolved.profile} | roles: ${JSON.stringify(resolved.config.roles)}`);
  if (translating) console.log(`language: ${language.input} -> ${language.internal} -> ${language.output}`);

  const languageEngine = translating
    ? new LanguageEngine(language.translationProvider ? { translationProvider: language.translationProvider } : {})
    : null;

  let objective = args.objective;
  if (translating) {
    objective = await languageEngine.toInternal(args.objective, language);
    console.log(`\nOriginal (${language.input}): ${args.objective}`);
    console.log(`Internal (${language.internal}): ${objective}`);
  }

  console.log(`\nRunning pipeline for: "${objective}"`);

  const roles = resolveRoles(resolved.config.roles);
  const { doc, documentValid } = await runOrchestrator({
    projectDir: resolved.projectRoot,
    objective,
    pipeline,
    roles,
    language: translating ? language : undefined,
  });

  let summary = buildSummary(doc, documentValid);
  if (translating && language.internal !== language.output) {
    summary = await languageEngine.toOutput(summary, language);
  }
  console.log(`\n${summary}`);

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
