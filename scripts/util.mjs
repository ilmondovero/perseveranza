// Utility pure condivise (zero dipendenze). Estratte per essere unit-testabili in isolamento
// (loop-drive.mjs e statusline.mjs hanno side-effect al load e non sono importabili nei test).

// true se il path (di una riga `git status --porcelain`) sta sotto .omc-loop/ (stato del loop).
// Match per PREFISSO, de-quotando i path che git quota.
export function underLoop(p) {
  const q = String(p).trim().replace(/^"|"$/g, '');
  return q === '.omc-loop' || q.startsWith('.omc-loop/');
}

// true se il working tree ha modifiche tracciate OLTRE .omc-loop/ (dato lo stdout di
// `git status --porcelain`). Gestisce i rename `XY old -> new` (entrambi i lati).
export function dirtyBeyondLoop(porcelainStdout) {
  return String(porcelainStdout)
    .split('\n').filter((l) => l.trim())
    .some((l) => {
      const body = l.slice(3); // togli "XY " (2 char di stato + spazio)
      const paths = body.includes(' -> ') ? body.split(' -> ') : [body];
      return paths.some((p) => !underLoop(p));
    });
}

// parsing robusto di un timeout in ms da una variabile d'ambiente: non-intero/negativo/NaN -> def;
// altrimenti l'intero, con floor minimo. (Evita ERR_OUT_OF_RANGE in spawnSync({timeout}).)
export function parseTimeoutMs(envValue, def, floor = 1000) {
  const n = Math.trunc(Number(envValue));
  return Number.isFinite(n) && n > 0 ? Math.max(floor, n) : def;
}

// Riassume i pareri esterni di uno slot a partire dagli artefatti external-<slot>-*.md
// scritti dal verbo `ask` (riga "- esito: ok|ERRORE"). Input: [{label, text}] (pura,
// testabile). Serve al gate finale per sapere se la falsificazione esterna e' davvero
// avvenuta o se il gate poggia sulla sola verifica interna.
export function summarizeExternalOpinions(arts) {
  const failed = [];
  let ok = 0;
  for (const a of Array.isArray(arts) ? arts : []) {
    if (/^-\s*esito:\s*ok\s*$/m.test(String(a.text))) ok += 1;
    else failed.push(String(a.label));
  }
  return { attempted: Array.isArray(arts) ? arts.length : 0, ok, failed };
}
