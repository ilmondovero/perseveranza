// Time formatting shared by the core and the shell. Pure, dependency-free, so that the
// journal can print an age without pulling the prompt table in.

// The largest instant Date can represent (ECMAScript: ±8.64e15 ms from the epoch).
const MAX_DATE_MS = 8.64e15;

export function formatAge(ms) {
  const t = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  const d = Math.floor(t / 86400);
  const h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(t)}s`;
}

// "2026-09-06 11:10 UTC"; '?' for anything that is not a plausible instant (a hand-edited
// state.json must not crash `status`).
export function formatAt(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_DATE_MS) return '?';
  return `${new Date(n).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}
