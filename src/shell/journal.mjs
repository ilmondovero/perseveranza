// The run journal: .perseveranza/journal.jsonl, one JSON object per line, append-only.
// Never throws: a journal that cannot be written must not break the hook.
import { appendFileSync, readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { formatAge } from '../core/time.mjs';

export const JOURNAL_FILE = 'journal.jsonl';

// Who ran the verbs of this process: 'tool' (the mod's `perseveranza` tool) or 'command' (the
// /pf command), set once by the CLI from PERSEVERANZA_VIA; every line this process
// journals then carries it (`via`), unless the line says its own.
let processVia = null;
export const JOURNAL_VIAS = ['tool', 'command'];
export function setJournalVia(via) { processVia = JOURNAL_VIAS.includes(via) ? via : null; }

export function appendJournal(gateDir, entry) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...(processVia ? { via: processVia } : {}), ...entry });
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

// The last entries only, reading the tail of the file: a run's journal carries the findings
// of every verdict and can reach megabytes, which a hook that runs at every session start
// should not parse whole. The first (possibly partial) line of the window is dropped.
export function readJournalTail(gateDir, bytes = 64 * 1024) {
  const p = join(gateDir, JOURNAL_FILE);
  let fd = null;
  try {
    const size = statSync(p).size;
    const len = Math.min(size, bytes);
    fd = openSync(p, 'r');
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, size - len);
    let text = buf.subarray(0, n).toString('utf8');
    if (len < size) text = text.slice(text.indexOf('\n') + 1);
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a torn line at the window edge */ }
    }
    return out;
  } catch { return []; }
  finally { if (fd != null) { try { closeSync(fd); } catch { /* nothing */ } } }
}

const at19 = (v) => (v ? String(v).replace('T', ' ').slice(0, 19) : 'unknown');
// why a verdict file was set aside: the request it answers, or its clock
const staleWhy = (e) => (e.staleBy === 'requestId'
  ? `answers request ${e.requestId}, current request ${e.expectedRequestId}`
  : `written ${at19(e.writtenAt)}, requested ${at19(e.requestedAt)}${e.requestId ? '' : ', no request id'}`);

// One human-readable line per entry (the `history` verb).
export function formatEntry(e) {
  const ts = e.ts ? e.ts.replace('T', ' ').slice(0, 19) : '????-??-?? ??:??:??';
  const it = Number.isFinite(e.iteration) ? ` it${String(e.iteration).padStart(2)}` : '';
  switch (e.type) {
    case 'fire': return `${ts} | fire session=${e.session || '-'} sha=${e.stopHookActive ? 1 : 0} keys=${(e.payloadKeys || []).join(',')}`;
    case 'transition': return `${ts} |${it} ${e.from} -> ${e.to} | ${e.outcome}${e.report && e.report !== 'none' ? ` report=${e.report}` : ''}${e.verdictSrc ? ` (${e.verdictSrc})` : ''}${e.claimed ? ' claim-done' : ''}${e.testProof ? ` test-proof=${e.testProof}` : ''}${e.gate ? ` gate=${e.gate}` : ''}${e.paused ? ` PAUSED: ${e.why}` : ''}`;
    case 'verdict': return `${ts} | verdict ${e.artifact}: ${e.unexpected ? `NOT ASKED (${e.why}) -> ${e.treatedAs}` : e.stale ? `STALE (${staleWhy(e)}) -> ${e.treatedAs}` : e.error ? `ERROR ${e.error} -> ${e.treatedAs}` : (e.artifact === 'review.json' ? `blocking=${e.blocking}` : `pass=${e.pass}`)}${e.notes && e.notes.length ? ` (${e.notes.join('; ')})` : ''}${e.savedAs ? ` -> ${e.savedAs}` : ''}`;
    case 'lenses': return `${ts} | lenses ${e.result}: expected ${(e.expected || []).join(',')}; arrived ${(e.arrived || []).join(',') || 'none'}${e.missing && e.missing.length ? `; missing ${e.missing.join(',')}` : ''}${e.critical && Object.values(e.critical).some((n) => n > 0) ? `; critical ${Object.entries(e.critical).filter(([, n]) => n > 0).map(([l, n]) => `${l}=${n}`).join(',')}` : ''}${e.softFails && e.softFails.length ? `; pass:false without critical read as pass: ${e.softFails.join(',')}` : ''}${e.fallback ? ' (lens-fallback: verify.json covers the round)' : ''}`;
    case 'lens-fallback': return `${ts} | lens-fallback: ${e.why}`;
    case 'test': return `${ts} | test exit=${e.exitCode} it${e.iteration} ${e.cmd}${e.reused ? ` (green reused${e.docsOnly ? ', only docs changed' : ''}, not rerun)` : ''}${e.failed && e.failed.length ? ` failed: ${e.failed.join(', ')}` : ''}${e.flaky ? ` FLAKY: ${e.flaky}` : ''}`;
    case 'advisor-hint': return `${ts} |${it} advisor ${e.slot}: ${e.reason === 'off' ? 'off, no hint' : `hint issued (${e.reason === 'fallback' ? 'fallback if no external model answers' : 'no external model'}${e.model ? `, model ${e.model}` : ''})`}${e.via ? ` via ${e.via}` : ''}`;
    case 'ask': return `${ts} | ask ${e.provider}${e.model ? `/${e.model}` : ''} slot=${e.slot} ${e.ok ? 'ok' : 'ERROR'}`;
    case 'usage': return `${ts} | usage ${e.spent} tokens (${e.delta < 0 ? '' : '+'}${e.delta})${e.subagents != null ? `, subagents ${e.subagents} in ${e.subagentFiles} transcript(s)` : e.source === 'transcript' ? ', main transcript only' : ''}${e.partial ? ', PARTIAL (hook out of time)' : ''}`;
    case 'budget': return e.adaptive ? `${ts} | budget adaptive: ${e.steps} steps -> max ${e.maxIterations}` : `${ts} | budget ${e.reason}: ${e.detail}`;
    case 'session': return `${ts} | session ${e.event} ${e.from ? `${e.from} -> ` : ''}${e.to || ''}${e.ageMs != null ? ` (silent for ${formatAge(e.ageMs)})` : ''}`.trimEnd();
    case 'activity': return `${ts} | ${e.event === 'delegate' ? `delegated to ${e.agent}` : e.event === 'subagent-stop' ? `subagent ${e.agent} finished` : e.event === 'refused' ? `REFUSED ${e.tool} (${e.why})` : `activity ${e.tool || ''}`}`;
    case 'reconcile': return `${ts} | reconcile: ${e.ok ? `${e.disposition}${e.running && e.running.length ? `, running: ${e.running.join('; ')}` : ''} -> ${e.outcome}${e.summary ? ` (${e.summary})` : ''}` : `${e.error || 'missing'} -> ${e.outcome}`}${e.why ? `: ${e.why}` : ''}`;
    // the watchdog's own events (no silence measured): it stopped watching, retired a restore sentinel
    case 'watchdog': if (e.silentMs == null) return `${ts} | WATCHDOG ${e.action === 'restore-abandoned' ? 'restore abandoned (counted)' : e.action === 'sentinel-retired' ? 'restore sentinel retired' : e.action || 'event'}: ${e.why || ''}`.trimEnd();
      return `${ts} | WATCHDOG${e.action === 'restored' ? ' (killed and restored)' : ''}: silent for ${formatAge(e.silentMs)} (last ${e.via} ${String(e.seenAt || '').replace('T', ' ').slice(0, 19)}, phase ${e.phase})${e.activity && Array.isArray(e.activity.pending) && e.activity.pending.length ? ` — ${e.activity.pending.map((d) => d.agent).join(', ')} delegated and not back` : ''}${e.notified ? ', notified' : ', notification off'}`;
    case 'gap': return `${ts} | GAP: no sign of life for ${formatAge(e.ms)} (since ${String(e.since || '').replace('T', ' ').slice(0, 19)})${e.paused ? ' while paused' : ''}`;
    case 'git': return `${ts} | git ${e.ran === false ? 'skipped (not a repo)' : e.confirmed ? `confirmed${e.pushSkipped ? ' (local commit, --no-push)' : ''}` : `NOT confirmed: ${e.why}`}`;
    case 'external-gate': return `${ts} | external gate: ${e.note}`;
    case 'baseline-dirty': return `${ts} | baseline dirty: ${e.count} file(s) ${(e.files || []).join(', ')}`;
    case 'done': return `${ts} | DONE after ${e.iterations} iterations, ${e.tokens} tokens`;
    case 'kill': return `${ts} | KILL via ${e.via}`;
    case 'prompt-pack': return `${ts} | prompt pack ${e.source}: ${e.error || 'loaded'}`;
    case 'migrate': return `${ts} | state migrated from v${e.from} to v${e.to}`;
    case 'archive': return `${ts} | archived to ${e.dir}`;
    case 'signal': return `${ts} | ${e.verb}${e.value ? ` ${e.value}` : ''}`;
    case 'outcome-dropped-paused': return `${ts} | outcome dropped, the loop is paused (${e.by}): ${(e.fields || []).join(', ')} ${JSON.stringify(e.values || {})}`;
    case 'note': return `${ts} | ${e.text}`;
    case 'mod-fault': return `${ts} | MOD FAULT: ${e.unreadable ? 'a marker that cannot be read' : `${e.hook || 'classic.Stop'} could not reach its helper${e.error ? ` (${e.error})` : ''}${e.at ? ` at ${String(e.at).replace('T', ' ').slice(0, 19)}` : ''}, ${e.recovery ? 'recovery asked' : 'the session was let stop'}`}`;
    default: return `${ts} | ${e.type}${e.raw ? ` ${e.raw}` : ''}`;
  }
}

export function renderHistory(entries, tail = 0) {
  const list = tail > 0 ? entries.slice(-tail) : entries;
  return list.map(formatEntry).join('\n');
}
