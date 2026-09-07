// Verdict artifacts written by the review / verification agents.
//   .omc-loop/review.json : { "blocking": <int>, "findings": [ {severity, desc, file?} ] }
//   .omc-loop/verify.json : { "pass": <bool>,   "findings": [ {severity, desc, file?} ] }
// A malformed artifact is never "a pass": it becomes a MISSING outcome (which the machine
// treats as a failure after one reminder) and the discrepancy is journaled.
// When the declared verdict and the findings disagree, the STRICTER reading wins.

export const SEVERITIES = ['critical', 'warning', 'suggestion'];

function parseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return { error: 'empty' };
  try { return { value: JSON.parse(text) }; } catch (e) { return { error: `invalid JSON: ${e.message}` }; }
}

function validateFindings(raw) {
  if (raw == null) return { findings: [] };
  if (!Array.isArray(raw)) return { error: 'findings is not an array' };
  const findings = [];
  for (let i = 0; i < raw.length; i++) {
    const f = raw[i];
    if (!f || typeof f !== 'object') return { error: `finding #${i} is not an object` };
    const severity = String(f.severity ?? '').toLowerCase();
    if (!SEVERITIES.includes(severity)) return { error: `finding #${i}: unknown severity "${f.severity}" (allowed: ${SEVERITIES.join(', ')})` };
    findings.push({ severity, desc: String(f.desc ?? f.description ?? ''), file: f.file != null ? String(f.file) : null });
  }
  return { findings };
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
  const notes = [];
  const crit = criticalCount(f.findings);
  let effective = blocking;
  if (crit > blocking) {
    effective = crit;
    notes.push(`blocking=${blocking} but ${crit} critical finding(s): the stricter count wins`);
  }
  return { ok: true, blocking: effective, declaredBlocking: blocking, findings: f.findings, notes };
}

// .omc-loop/reconcile.json, written by a restored session after a read-only inspection:
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
  const notes = [];
  let pass = v.pass;
  const crit = criticalCount(f.findings);
  if (pass && crit > 0) {
    pass = false;
    notes.push(`pass=true but ${crit} critical finding(s): the stricter reading wins`);
  }
  return { ok: true, pass, declaredPass: v.pass, findings: f.findings, notes };
}
