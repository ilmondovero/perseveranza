// Small pure helpers used by the shell and the CLI.

// Robust ms parsing from an env var: non-integer/negative/NaN -> def; else the integer, floored.
// (Avoids ERR_OUT_OF_RANGE in spawnSync({ timeout }).)
export function parseTimeoutMs(envValue, def, floor = 1000) {
  const n = Math.trunc(Number(envValue));
  return Number.isFinite(n) && n > 0 ? Math.max(floor, n) : def;
}

export function boolEnv(v) {
  return /^(1|true|yes|on)$/i.test(String(v ?? ''));
}

// Summarise the external opinions of one slot from the external-<slot>-*.md artifacts
// written by `ask` (line "- status: ok|ERROR"). Input: [{label, text}].
export function summarizeExternalOpinions(arts) {
  const failed = [];
  let ok = 0;
  for (const a of Array.isArray(arts) ? arts : []) {
    if (/^-\s*(status|esito):\s*ok\s*$/mi.test(String(a.text))) ok += 1;
    else failed.push(String(a.label));
  }
  return { attempted: Array.isArray(arts) ? arts.length : 0, ok, failed };
}

export const nowIso = () => new Date().toISOString();
export const shortTs = () => nowIso().replace('T', ' ').slice(0, 19);
