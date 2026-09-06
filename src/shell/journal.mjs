// The run journal: .omc-loop/journal.jsonl, one JSON object per line, append-only.
// Never throws: a journal that cannot be written must not break the hook.
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const JOURNAL_FILE = 'journal.jsonl';

export function appendJournal(gateDir, entry) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    appendFileSync(join(gateDir, JOURNAL_FILE), `${line}\n`);
    return true;
  } catch { return false; }
}

export function readJournal(gateDir) {
  const p = join(gateDir, JOURNAL_FILE);
  if (!existsSync(p)) return [];
  let text = '';
  try { text = readFileSync(p, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { out.push({ ts: null, type: 'unparseable', raw: line.slice(0, 200) }); }
  }
  return out;
}

// One human-readable line per entry (the `history` verb).
export function formatEntry(e) {
  const ts = e.ts ? e.ts.replace('T', ' ').slice(0, 19) : '????-??-?? ??:??:??';
  const it = Number.isFinite(e.iteration) ? ` it${String(e.iteration).padStart(2)}` : '';
  switch (e.type) {
    case 'fire': return `${ts} | fire session=${e.session || '-'} sha=${e.stopHookActive ? 1 : 0} keys=${(e.payloadKeys || []).join(',')}`;
    case 'transition': return `${ts} |${it} ${e.from} -> ${e.to} | ${e.outcome}${e.report && e.report !== 'none' ? ` report=${e.report}` : ''}${e.verdictSrc ? ` (${e.verdictSrc})` : ''}${e.claimed ? ' claim-done' : ''}${e.testProof ? ` test-proof=${e.testProof}` : ''}${e.paused ? ` PAUSED: ${e.why}` : ''}`;
    case 'verdict': return `${ts} | verdict ${e.artifact}: ${e.error ? `ERROR ${e.error} -> ${e.treatedAs}` : (e.artifact === 'review.json' ? `blocking=${e.blocking}` : `pass=${e.pass}`)}${e.notes && e.notes.length ? ` (${e.notes.join('; ')})` : ''}${e.savedAs ? ` -> ${e.savedAs}` : ''}`;
    case 'test': return `${ts} | test exit=${e.exitCode} it${e.iteration} ${e.cmd}${e.reused ? ` (green reused${e.docsOnly ? ', only docs changed' : ''}, not rerun)` : ''}${e.failed && e.failed.length ? ` failed: ${e.failed.join(', ')}` : ''}${e.flaky ? ` FLAKY: ${e.flaky}` : ''}`;
    case 'ask': return `${ts} | ask ${e.provider}${e.model ? `/${e.model}` : ''} slot=${e.slot} ${e.ok ? 'ok' : 'ERROR'}`;
    case 'usage': return `${ts} | usage ${e.spent} tokens (+${e.delta})`;
    case 'budget': return e.adaptive ? `${ts} | budget adaptive: ${e.steps} steps -> max ${e.maxIterations}` : `${ts} | budget ${e.reason}: ${e.detail}`;
    case 'session': return `${ts} | session ${e.event} ${e.from ? `${e.from} -> ` : ''}${e.to}`;
    case 'git': return `${ts} | git ${e.ran === false ? 'skipped (not a repo)' : e.confirmed ? `confirmed${e.pushSkipped ? ' (local commit, --no-push)' : ''}` : `NOT confirmed: ${e.why}`}`;
    case 'external-gate': return `${ts} | external gate: ${e.note}`;
    case 'baseline-dirty': return `${ts} | baseline dirty: ${e.count} file(s) ${(e.files || []).join(', ')}`;
    case 'done': return `${ts} | DONE after ${e.iterations} iterations, ${e.tokens} tokens`;
    case 'kill': return `${ts} | KILL via ${e.via}`;
    case 'prompt-pack': return `${ts} | prompt pack ${e.source}: ${e.error || 'loaded'}`;
    case 'migrate': return `${ts} | state migrated from v${e.from} to v${e.to}`;
    case 'archive': return `${ts} | archived to ${e.dir}`;
    case 'signal': return `${ts} | ${e.verb}${e.value ? ` ${e.value}` : ''}`;
    case 'note': return `${ts} | ${e.text}`;
    default: return `${ts} | ${e.type}${e.raw ? ` ${e.raw}` : ''}`;
  }
}

export function renderHistory(entries, tail = 0) {
  const list = tail > 0 ? entries.slice(-tail) : entries;
  return list.map(formatEntry).join('\n');
}
