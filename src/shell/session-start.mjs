#!/usr/bin/env node
// The SessionStart hook: the one moment the plugin runs code that is NOT a Stop of the
// owner session. A loop lives only in the Stop hook, so when its session dies the state
// says "phase: review" forever and a new session opened in the same folder knows nothing.
// This hook turns that silence into a question: if .omc-loop/state.json belongs to another
// session it tells Claude who owns it, how long it has been silent and what to ask the
// user; the takeover itself stays explicit (`resume --takeover`). DORMANT otherwise.
// Must never throw and must answer fast: it runs at every startup, resume and compaction.
import { readFileSync, existsSync } from 'node:fs';
import { gatePaths, ROOT, loopCommand } from './paths.mjs';
import { loadState } from '../core/state.mjs';
import { sessionNotice, compactNotice, noticeKind, staleness, DEFAULT_STALE_MS } from '../core/staleness.mjs';
import { appendJournal, readJournalTail } from './journal.mjs';
import { loadPromptLayers } from './packs.mjs';
import { readLife } from './life.mjs';
import { parseTimeoutMs } from './util.mjs';

function main() {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  let evt = null;
  try { evt = raw ? JSON.parse(raw) : null; } catch { /* malformed event */ }
  const cwd = evt && typeof evt.cwd === 'string' && evt.cwd ? evt.cwd : process.cwd();
  const paths = gatePaths(cwd);
  if (!existsSync(paths.statePath)) return null;

  let state = null;
  try { state = loadState(JSON.parse(readFileSync(paths.statePath, 'utf8'))).state; } catch { /* unreadable */ }
  if (!state) return null; // the Stop hook archives a corrupt state; nothing to say here

  const sessionId = evt && typeof evt.session_id === 'string' ? evt.session_id : '';
  const source = evt && typeof evt.source === 'string' ? evt.source : '';
  const now = Date.now();
  const staleMs = parseTimeoutMs(process.env.OMC_LOOP_STALE_MS, DEFAULT_STALE_MS);
  const LOOP = loopCommand(ROOT);
  let planText = '';
  try { planText = readFileSync(paths.planPath, 'utf8'); } catch { /* no plan */ }

  const owner = state.owner.sessionId;
  if (owner && sessionId && owner === sessionId && source !== 'compact') return null;
  // the notices speak the language of the loop, like the injected instructions
  const packs = loadPromptLayers({ gateDir: paths.gateDir, env: process.env, lang: state.options.lang, root: ROOT });
  for (const err of packs.errors) appendJournal(paths.gateDir, { type: 'prompt-pack', source: err.source, error: err.error });
  if (owner && sessionId && owner === sessionId) {
    // the owner is back after a compaction: the phase instruction may be gone from context
    return compactNotice(state, { planText, LOOP, layers: packs.layers });
  }
  const lastTransition = readJournalTail(paths.gateDir).filter((j) => j.type === 'transition').pop();
  const { activity, transcriptAt } = readLife(paths.gateDir, state);
  const st = staleness(state, now, staleMs, activity, transcriptAt);
  const kind = noticeKind(state, now, staleMs, activity, transcriptAt);
  appendJournal(paths.gateDir, { type: 'session', event: 'seen', from: String(owner || state.owner.releasedFrom || '').slice(0, 8), to: sessionId.slice(0, 8), source, ageMs: st.ageMs, via: st.via, stale: st.stale, kind });
  return sessionNotice(state, { planText, now, staleMs, sessionId, LOOP, lastPrompt: lastTransition ? lastTransition.prompt : '', layers: packs.layers, activity, transcriptAt });
}

let text = null;
try { text = main(); }
catch (e) {
  try { appendJournal(gatePaths(process.cwd()).gateDir, { type: 'note', text: `session-start hook crashed: ${e && e.message}` }); } catch { /* nothing */ }
}
if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
process.exit(0);
