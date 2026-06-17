// Rendering compatto del progresso del ciclo, CONDIVISO tra:
//  - l'header iniettato nell'istruzione (loop-drive.mjs), in testo semplice;
//  - la statusline (statusline.mjs), con colori ANSI e marker.
// Nessuna dipendenza.

const PHASE_LABEL = {
  plan: 'plan', implement: 'impl', review: 'rev',
  cleanup: 'clean', 'final-verify': 'verify', 'git-finish': 'git',
};
// colore ANSI per fase (usato solo con opts.color)
const PHASE_COLOR = {
  plan: 36, implement: 36, review: 33, cleanup: 36, 'final-verify': 34, 'git-finish': 35,
};

function stepCounts(planText) {
  const done = (planText.match(/^[ \t]*-[ \t]*\[[xX]\]/gm) || []).length;
  const open = (planText.match(/^[ \t]*-[ \t]*\[[ \t]*\]/gm) || []).length;
  const total = done + open;
  return total ? { done, total } : null;
}
function bar(done, total, w = 5) {
  const f = Math.max(0, Math.min(w, Math.round((done / total) * w)));
  return '▰'.repeat(f) + '▱'.repeat(w - f);
}

// state: oggetto di .omc-loop/state.json ; planText: contenuto di plan.md (o '')
// opts: { color?: bool, marker?: bool }
export function renderProgress(state = {}, planText = '', opts = {}) {
  const paint = opts.color ? (code, s) => `\x1b[${code}m${s}\x1b[0m` : (_c, s) => s;
  const phase = state.phase || 'plan';
  const label = PHASE_LABEL[phase] || phase;
  const parts = [];

  if (state.paused) {
    const why = phase === 'git-finish' ? 'git: chiusura non confermata' : `PAUSA ${label}`;
    parts.push(paint('38;5;208', `⏸ ${why}`));
  } else {
    parts.push(paint(PHASE_COLOR[phase] || 36, `▸${label}`));
    const c = stepCounts(planText);
    if (c) parts.push(`${bar(c.done, c.total)} ${c.done}/${c.total}`);
  }
  parts.push(`it${Number(state.iterations) || 0}/${Number(state.max) || 0}`);
  if (Number(state.retries) > 0) parts.push(paint(33, `↻${state.retries}/${state.maxRetries || 3}`));
  if (Number(state.finalFails) > 0) parts.push(paint(31, `✗${state.finalFails}/${state.maxRetries || 3}`));

  const body = parts.join(' · ');
  return opts.marker ? `${paint('1;35', '⟳ PRS')} ${body}` : body;
}
