// Formats an AEP document into a terminal report. Design principle
// (ROADMAP.md item 7): reads like a consolidated report from a team of
// architects, not a chat transcript with an AI. Default output hides the
// raw reviewer debate; --verbose/--show-reviews exposes it. No number here
// is ever decorative — everything printed comes from a real field on `doc`.

const RULE = '═'.repeat(60);
const THIN = '─'.repeat(60);

function section(title) {
  return `\n${THIN}\n ${title}\n${THIN}`;
}

function formatFindings(findings) {
  if (!findings?.length) return [];
  return findings.map((f) => `    [${f.severity}] ${f.summary}`);
}

/**
 * @param {object} doc - the AEP document
 * @param {{valid: boolean, errors: object[]}} documentValid
 * @param {{verbose?: boolean}} [opts]
 */
export function formatReport(doc, documentValid, { verbose = false } = {}) {
  const lines = [];
  lines.push(RULE, ' CONTREEX — RELATÓRIO', RULE);
  lines.push(`\nObjetivo: ${doc.request.objective}`);

  if (doc.analysis) {
    lines.push(section('ANÁLISE'));
    lines.push(doc.analysis.problem);
    if (doc.analysis.rootCause) lines.push(`\nCausa raiz: ${doc.analysis.rootCause}`);
    if (doc.analysis.risks?.length) {
      lines.push('\nRiscos:');
      for (const r of doc.analysis.risks) lines.push(`  - ${r}`);
    }
    if (doc.analysis.clarifyingQuestions?.length) {
      lines.push('\nPerguntas de esclarecimento antes de um plano confiável:');
      for (const q of doc.analysis.clarifyingQuestions) lines.push(`  - ${q}`);
    }
    if (typeof doc.analysis.confidence === 'number') lines.push(`\nConfiança do implementer: ${doc.analysis.confidence}`);
  }

  if (doc.plan) {
    lines.push(section(`PLANO (${doc.plan.steps.length} etapa(s))`));
    for (const step of doc.plan.steps) lines.push(`  ${step.id}. ${step.description}`);
    if (doc.plan.filesToModify?.length) lines.push(`\nArquivos: ${doc.plan.filesToModify.join(', ')}`);
  }

  const reviewEntries = Object.entries(doc.reviews ?? {});
  if (reviewEntries.length) {
    lines.push(section('CONSENSO'));
    for (const [role, review] of reviewEntries) {
      const mark = review.verdict === 'APPROVE' ? '✓' : review.verdict === 'BLOCKED' ? '✗' : '△';
      lines.push(`  ${mark} ${role}: ${review.verdict}${review.findings?.length ? ` (${review.findings.length} observação(ões))` : ''}`);
      if (verbose) lines.push(...formatFindings(review.findings));
    }
  }

  if (doc.refinement) {
    const accepted = doc.refinement.acceptedChanges ?? [];
    const rejected = doc.refinement.rejectedChanges ?? [];
    if (accepted.length || rejected.length) {
      lines.push(section('DIVERGÊNCIAS RESOLVIDAS PELO IMPLEMENTER'));
      for (const a of accepted) lines.push(`  ✓ aceito: ${a}`);
      for (const r of rejected) lines.push(`  ✗ rejeitado: ${r.suggestion}${verbose ? ` — ${r.reason}` : ''}`);
      if (!verbose && rejected.length) lines.push('\n  (motivo de cada rejeição: use --verbose)');
    }
  }

  lines.push(`\n${RULE}`);
  lines.push(` Documento válido: ${documentValid.valid}`);
  lines.push(RULE);
  if (!documentValid.valid) lines.push('\nErros de validação:', JSON.stringify(documentValid.errors, null, 2));

  return lines.join('\n');
}
