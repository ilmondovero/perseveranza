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

// Rimuove i fenced code block, cosi' i checkbox dentro esempi di codice NON
// vengono conteggiati. Scansione riga-per-riga con toggle: i marker ``` / ~~~
// contano SOLO a inizio riga (CommonMark, <=3 spazi). Un fence aperto non chiuso
// esclude fino a EOF; un backtick/tilde INLINE non e' un fence e non divora nulla.
function stripCodeFences(text) {
  let fence = null;            // marker di apertura corrente (es. '```' o '~~~'), o null
  const out = [];
  // togli un eventuale BOM (U+FEFF) iniziale: la regex ^[ \t]*[-*+] non lo considera uno spazio,
  // quindi senza questo un checkbox sulla 1a riga preceduto dal BOM non verrebbe contato.
  const s = String(text);
  const body = s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
  for (const line of body.split('\n')) {
    const m = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (fence) {
      // chiusura: stesso tipo di marker, lunghezza >= apertura
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;                // riga dentro il fence (apertura/chiusura/contenuto): esclusa
    }
    if (m) { fence = m[1]; continue; } // apertura del fence
    out.push(line);
  }
  return out.join('\n');
}

// Conteggio dei checkbox del piano, robusto rispetto alle varianti Markdown:
//  - marker di lista -, * o + ;  - indentazione iniziale ;
//  - spazi/tab opzionali dentro la casella (es. "- [x ]", "* [ ]", "+ [x]").
// I code block vengono tolti prima di contare.
export function countOpenSteps(planText) {
  return (stripCodeFences(planText).match(/^[ \t]*[-*+][ \t]*\[[ \t]*\]/gm) || []).length;
}
export function countDoneSteps(planText) {
  return (stripCodeFences(planText).match(/^[ \t]*[-*+][ \t]*\[[ \t]*[xX][ \t]*\]/gm) || []).length;
}

function stepCounts(planText) {
  const done = countDoneSteps(planText);
  const open = countOpenSteps(planText);
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
  const marker = opts.version ? `⟳ PRS v${opts.version}` : '⟳ PRS';
  return opts.marker ? `${paint('1;35', marker)} ${body}` : body;
}
