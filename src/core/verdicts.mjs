// Verdict artifacts written by the review / verification agents.
//   .perseveranza/review.json : { "requestId": <string>, "blocking": <int>, "findings": [...] }
//   .perseveranza/verify.json : { "requestId": <string>, "pass": <bool>, "findings": [...] }
//   .perseveranza/verify-<lens>.json : the same, plus "lens" (a final verification by lenses)
// A malformed artifact is never "a pass": it becomes a MISSING outcome (which the machine
// treats as a failure after one reminder) and the discrepancy is journaled.
// When the declared verdict and the findings disagree, the STRICTER reading wins.

export const SEVERITIES = ['critical', 'warning', 'suggestion'];
// The scales judges reach for when they do not copy ours (seen in real runs: "medium"). A
// verdict right on the merits is not thrown away for a synonym; the mapping is noted. What
// stays unknown is still an error: a verdict read with doubt is not a verdict.
// Only a word that means "it blocks" becomes critical. "high" does not: on the common
// critical/high/medium/low scale it sits below critical, and a critical overrides the
// declared blocking/pass (stricter reading), so reading it as critical would turn a pass
// the judge declared into a fail. As a warning, the judge's own blocking/pass decides.
export const SEVERITY_ALIASES = {
  blocker: 'critical', blocking: 'critical', bloccante: 'critical', critico: 'critical', critica: 'critical',
  high: 'warning', major: 'warning', medium: 'warning', moderate: 'warning', important: 'warning',
  alta: 'warning', alto: 'warning', maggiore: 'warning', media: 'warning', medio: 'warning', avviso: 'warning', grave: 'warning',
  low: 'suggestion', minor: 'suggestion', info: 'suggestion', note: 'suggestion', nit: 'suggestion', nitpick: 'suggestion', trivial: 'suggestion', optional: 'suggestion',
  bassa: 'suggestion', basso: 'suggestion', minore: 'suggestion', suggerimento: 'suggestion',
};

// The aliases a judge uses for "serious" on a four-level scale (high/major and their Italian
// forms). Read as warning, so they do not overturn a declared pass; but under a declared
// pass:false they are the judge's own reason to reject, which a final verification by
// lenses must not lose (a lens with pass:false over plain warnings does not block).
export const STRONG_ALIASES = ['high', 'major', 'grave', 'alta', 'alto', 'maggiore'];

function parseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return { error: 'empty' };
  try { return { value: JSON.parse(text) }; } catch (e) { return { error: `invalid JSON: ${e.message}` }; }
}

function validateFindings(raw) {
  if (raw == null) return { findings: [], notes: [], strong: 0 };
  if (!Array.isArray(raw)) return { error: 'findings is not an array' };
  const findings = [];
  const mapped = new Map();
  let strong = 0;
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i];
    if (!f || typeof f !== 'object') return { error: `finding #${i} is not an object` };
    const declared = String(f.severity ?? '').trim().toLowerCase();
    const severity = SEVERITIES.includes(declared) ? declared : SEVERITY_ALIASES[declared];
    if (!severity) return { error: `finding #${i}: unknown severity "${f.severity}" (allowed: ${SEVERITIES.join(', ')})` };
    if (severity !== declared) mapped.set(declared, severity);
    if (STRONG_ALIASES.includes(declared)) strong += 1;
    findings.push({ severity, desc: String(f.desc ?? f.description ?? ''), file: f.file != null ? String(f.file) : null });
  }
  const notes = [...mapped].map(([from, to]) => `severity "${from}" read as ${to}`);
  return { findings, notes, strong };
}

// An empty id carries no claim about the request: read like an absent one (the machine then
// falls back to the file clock), not as a malformed verdict.
function validateRequestId(raw) {
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return { requestId: null };
  if (typeof raw !== 'string') return { error: 'requestId must be a string' };
  return { requestId: raw };
}

const criticalCount = (findings) => findings.filter((f) => f.severity === 'critical').length;

// -> { ok: true, blocking, findings, notes: [] } | { ok: false, error }
export function parseReviewVerdict(text) {
  const p = parseJson(text);
  if (p.error) return { ok: false, error: p.error };
  const v = p.value;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'not an object' };
  const blocking = v.blocking;
  if (!Number.isInteger(blocking) || blocking < 0) return { ok: false, error: `blocking must be a non-negative integer (got ${JSON.stringify(v.blocking)})` };
  const f = validateFindings(v.findings);
  if (f.error) return { ok: false, error: f.error };
  const req = validateRequestId(v.requestId);
  if (req.error) return { ok: false, error: req.error };
  const notes = [...f.notes];
  const crit = criticalCount(f.findings);
  let effective = blocking;
  if (crit > blocking) {
    effective = crit;
    notes.push(`blocking=${blocking} but ${crit} critical finding(s): the stricter count wins`);
  }
  return { ok: true, blocking: effective, declaredBlocking: blocking, findings: f.findings, requestId: req.requestId, notes };
}

// .perseveranza/reconcile.json, written by a restored session after a read-only inspection:
//   { "disposition": "complete"|"partial"|"uncertain", "running": [...], "next": "implement"|"review", "summary": "..." }
// -> { ok: true, disposition, running, next, summary, notes } | { ok: false, error }
export const DISPOSITIONS = ['complete', 'partial', 'uncertain'];
export function parseReconcile(text) {
  const p = parseJson(text);
  if (p.error) return { ok: false, error: p.error };
  const v = p.value;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'not an object' };
  const disposition = typeof v.disposition === 'string' ? v.disposition.trim().toLowerCase() : '';
  if (!DISPOSITIONS.includes(disposition)) return { ok: false, error: `disposition must be one of ${DISPOSITIONS.join(', ')} (got ${JSON.stringify(v.disposition)})` };
  if (v.running != null && !Array.isArray(v.running)) return { ok: false, error: 'running is not an array' };
  const running = (v.running || []).map((r) => String(r).slice(0, 200)).filter(Boolean);
  const notes = [];
  let next = typeof v.next === 'string' ? v.next.trim().toLowerCase() : '';
  if (next && next !== 'implement' && next !== 'review') return { ok: false, error: `next must be implement or review (got ${JSON.stringify(v.next)})` };
  if (!next) next = disposition === 'complete' ? 'review' : 'implement';
  if (disposition === 'complete' && next === 'implement') notes.push('complete but next=implement: implementing again what is complete');
  if (disposition === 'partial' && next === 'review') { notes.push('partial but next=review: a partial step is continued, not reviewed'); next = 'implement'; }
  return { ok: true, disposition, running, next, summary: typeof v.summary === 'string' ? v.summary.slice(0, 500) : '', notes };
}

// -> { ok: true, pass, findings, notes: [] } | { ok: false, error }
export function parseVerifyVerdict(text) {
  const p = parseJson(text);
  if (p.error) return { ok: false, error: p.error };
  const v = p.value;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'not an object' };
  if (typeof v.pass !== 'boolean') return { ok: false, error: `pass must be a boolean (got ${JSON.stringify(v.pass)})` };
  const f = validateFindings(v.findings);
  if (f.error) return { ok: false, error: f.error };
  const req = validateRequestId(v.requestId);
  if (req.error) return { ok: false, error: req.error };
  const notes = [...f.notes];
  let pass = v.pass;
  const crit = criticalCount(f.findings);
  if (pass && crit > 0) {
    pass = false;
    notes.push(`pass=true but ${crit} critical finding(s): the stricter reading wins`);
  }
  // the lens a verifier says it judged (the file name decides; a mismatch is only noted)
  const lens = typeof v.lens === 'string' && v.lens.trim() ? v.lens.trim().toLowerCase().slice(0, 40) : null;
  return { ok: true, pass, declaredPass: v.pass, findings: f.findings, requestId: req.requestId, lens, notes, strongWarnings: f.strong };
}
