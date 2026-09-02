import { existsSync, readFileSync } from 'node:fs';
import { gate } from '../shared.mjs';
import { TRANSITIONS, outcomesFor, toMarkdown } from '../../core/transitions.mjs';
import { loadState } from '../../core/state.mjs';

function table(rows) {
  const w = [0, 0, 0];
  for (const r of rows) {
    w[0] = Math.max(w[0], (r.phase === '*' ? 'any' : r.phase).length);
    w[1] = Math.max(w[1], r.outcome.length);
    w[2] = Math.max(w[2], (r.next === '=' ? 'unchanged' : r.next).length);
  }
  return rows.map((r) => {
    const p = (r.phase === '*' ? 'any' : r.phase).padEnd(w[0]);
    const o = r.outcome.padEnd(w[1]);
    const n = (r.next === '=' ? 'unchanged' : r.next).padEnd(w[2]);
    return `  ${p}  ${o}  -> ${n}  ${r.prompt ? `[${r.prompt}]` : ''}${r.note ? ` ${r.note}` : ''}`;
  }).join('\n');
}

export function run({ argv, cwd }) {
  if (argv.includes('--markdown')) { console.log(toMarkdown()); return 0; }
  const paths = gate(cwd);
  if (existsSync(paths.statePath)) {
    try {
      const s = loadState(JSON.parse(readFileSync(paths.statePath, 'utf8'))).state;
      if (s) {
        console.log(`Current phase: ${s.phase}${s.signals.paused ? ' (paused)' : ''}. Possible outcomes from here:\n`);
        console.log(table(outcomesFor(s.phase)));
        console.log('');
      }
    } catch { /* unreadable: print the full table only */ }
  }
  console.log('Full transition table (phase, outcome -> next phase [prompt key] note):\n');
  console.log(table(TRANSITIONS));
  return 0;
}
