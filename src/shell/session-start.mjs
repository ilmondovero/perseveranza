#!/usr/bin/env node
// The SessionStart hook (since 3.0 registered by nobody: the mod asks the bridge for the same
// notice; it stays for a settings hook wired by hand and the tests): the one moment the plugin runs code that is NOT a Stop of the
// owner session. A loop lives only in the Stop hook, so when its session dies the state
// says "phase: review" forever and a new session opened in the same folder knows nothing.
// This hook turns that silence into a question: if .perseveranza/state.json belongs to another
// session it tells Claude who owns it, how long it has been silent and what to ask the
// user; the takeover itself stays explicit (`resume --takeover`). DORMANT otherwise.
// Must never throw and must answer fast: it runs at every startup, resume and compaction.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gatePaths, ROOT, loopCommand } from './paths.mjs';
import { loadState } from '../core/state.mjs';
import { loopVar, userVar, effectiveLoopMode } from '../core/prompts.mjs';
import { sessionNotice, compactNotice, noticeKind, staleness, DEFAULT_STALE_MS } from '../core/staleness.mjs';
import { appendJournal, readJournalTail } from './journal.mjs';
import { loadPromptLayers } from './packs.mjs';
import { readLife } from './life.mjs';
import { parseTimeoutMs } from './util.mjs';

// The notice for a session starting (startup, resume, clear, compact) in a folder whose loop
// it does not own, or for the owner after a compaction: the text, or null (nothing to say).
// evt: the SessionStart input (session_id, cwd, source). Used by this hook and by the mod's
// bridge (op 'session-start'), so both say the same thing. opts.loopMode: 'tool' when the mod
// asks (its tool is registered); the notice names the tool only if the run was armed for it.
export function sessionStartContext(evt, env = process.env, opts = {}) {
  const cwd = evt && typeof evt.cwd === 'string' && evt.cwd ? evt.cwd : process.cwd();
  const paths = gatePaths(cwd);
  if (!existsSync(paths.statePath)) return null;

  let state = null;
  try { state = loadState(JSON.parse(readFileSync(paths.statePath, 'utf8'))).state; } catch { /* unreadable */ }
  if (!state) return null; // the Stop hook archives a corrupt state; nothing to say here

  const sessionId = evt && typeof evt.session_id === 'string' ? evt.session_id : '';
  const source = evt && typeof evt.source === 'string' ? evt.source : '';
  const now = Date.now();
  const staleMs = parseTimeoutMs(env.PERSEVERANZA_STALE_MS, DEFAULT_STALE_MS);
  let planText = '';
  try { planText = readFileSync(paths.planPath, 'utf8'); } catch { /* no plan */ }

  const owner = state.owner.sessionId;
  if (owner && sessionId && owner === sessionId && source !== 'compact') return null;
  // the notices speak the language of the loop, like the injected instructions
  const packs = loadPromptLayers({ gateDir: paths.gateDir, env, lang: state.options.lang, root: ROOT });
  for (const err of packs.errors) appendJournal(paths.gateDir, { type: 'prompt-pack', source: err.source, error: err.error });
  const mode = effectiveLoopMode(state.options.loopMode, opts && opts.loopMode);
  const LOOP = loopVar(mode, loopCommand(ROOT), packs.layers);
  const USER = userVar(mode, loopCommand(ROOT), packs.layers);
  if (owner && sessionId && owner === sessionId) {
    // the owner is back after a compaction: the phase instruction may be gone from context
    return compactNotice(state, { planText, LOOP, USER, layers: packs.layers });
  }
  const lastTransition = readJournalTail(paths.gateDir).filter((j) => j.type === 'transition').pop();
  const { activity, transcriptAt } = readLife(paths.gateDir, state);
  const st = staleness(state, now, staleMs, activity, transcriptAt);
  const kind = noticeKind(state, now, staleMs, activity, transcriptAt);
  appendJournal(paths.gateDir, { type: 'session', event: 'seen', from: String(owner || state.owner.releasedFrom || '').slice(0, 8), to: sessionId.slice(0, 8), source, ageMs: st.ageMs, via: st.via, stale: st.stale, kind });
  return sessionNotice(state, { planText, now, staleMs, sessionId, LOOP, USER, lastPrompt: lastTransition ? lastTransition.prompt : '', layers: packs.layers, activity, transcriptAt });
}

function main() {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  let evt = null;
  try { evt = raw ? JSON.parse(raw) : null; } catch { /* malformed event */ }
  return sessionStartContext(evt, process.env);
}

function isMainModule() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] || '.')).href; }
  catch { return false; }
}

if (isMainModule()) {
  let text = null;
  try { text = main(); }
  catch (e) {
    try { appendJournal(gatePaths(process.cwd()).gateDir, { type: 'note', text: `session-start hook crashed: ${e && e.message}` }); } catch { /* nothing */ }
  }
  if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
  process.exit(0);
}
