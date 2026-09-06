#!/usr/bin/env node
// The Stop hook. Thin by design: read the event, gather facts, ask the core what to do,
// execute the effects, print the decision. DORMANT until .omc-loop/state.json exists in
// the cwd. Must never throw and must finish within the hook deadline.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gatePaths, ROOT, loopCommand } from './paths.mjs';
import { loadState } from '../core/state.mjs';
import { step } from '../core/machine.mjs';
import { executeEffects } from './effects.mjs';
import { appendJournal } from './journal.mjs';
import { notify } from './notify.mjs';
import { archiveRun, archiveFailureNote } from './archive.mjs';
import { loadPromptLayers } from './packs.mjs';
import { workTreeFingerprint } from './git.mjs';
import { readTranscriptUsage } from './transcript.mjs';
import { parseTimeoutMs, boolEnv } from './util.mjs';
import { currentVersion, updateAvailable, maybeSpawnRefresh } from '../update.mjs';

const START = Date.now();
const TITLE = 'Claude Code - perseveranza';
const env = process.env;
// hooks.json declares 120 s; keep a margin so we always answer before Claude Code kills us
const DEADLINE = START + parseTimeoutMs(env.OMC_HOOK_TIMEOUT_MS, 120000) - 8000;

function main() {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  let evt = null;
  try { evt = raw ? JSON.parse(raw) : null; } catch { /* malformed event */ }
  const cwd = evt && typeof evt.cwd === 'string' && evt.cwd ? evt.cwd : process.cwd();
  const paths = gatePaths(cwd);

  // DORMANT: no gate, nothing to do
  if (!existsSync(paths.statePath)) return null;

  // KILL SWITCH: before any other check, needs no state, works from any session
  const killEnv = boolEnv(env.OMC_LOOP_KILL);
  const killFile = existsSync(paths.stopFile);
  if (killEnv || killFile) {
    const via = killFile ? 'STOP file' : 'OMC_LOOP_KILL';
    appendJournal(paths.gateDir, { type: 'kill', via });
    let state = null;
    try { state = loadState(JSON.parse(readFileSync(paths.statePath, 'utf8'))).state; } catch { /* unreadable */ }
    const archived = archiveRun(paths.gateDir, { projectName: paths.projectName, state, outcome: 'killed', env });
    notify(TITLE, archived.ok ? `Kill switch (${via}): loop disarmed - ${paths.projectName}` : archiveFailureNote(archived), { env });
    return null;
  }

  // STATE: v1 is migrated on the fly; garbage disarms cleanly (archived for forensics)
  let rawState = null;
  try { rawState = JSON.parse(readFileSync(paths.statePath, 'utf8')); } catch { /* corrupt */ }
  const loaded = loadState(rawState);
  if (!loaded.state) {
    appendJournal(paths.gateDir, { type: 'note', text: `state.json unreadable (${loaded.error}): disarming` });
    const archived = archiveRun(paths.gateDir, { projectName: paths.projectName, state: null, outcome: 'corrupt-state', env });
    notify(TITLE, archived.ok ? `state.json corrupt: loop disarmed - ${paths.projectName}` : archiveFailureNote(archived), { env });
    return null;
  }
  const holder = { state: loaded.state };
  if (loaded.migrated) appendJournal(paths.gateDir, { type: 'migrate', from: 1, to: 2 });
  const s = holder.state;

  // FACTS for the core
  const planExists = existsSync(paths.planPath);
  let planText = '';
  if (planExists) { try { planText = readFileSync(paths.planPath, 'utf8'); } catch { /* unreadable */ } }
  const readArtifact = (name) => {
    const p = join(paths.gateDir, name);
    if (!existsSync(p)) return null;
    try { return readFileSync(p, 'utf8'); } catch { return ''; }
  };
  const artifacts = {};
  if (s.phase === 'review') artifacts.review = readArtifact('review.json');
  if (s.phase === 'final-verify') artifacts.verify = readArtifact('verify.json');
  const packs = loadPromptLayers({ gateDir: paths.gateDir, env, lang: s.options.lang, root: ROOT });
  for (const err of packs.errors) appendJournal(paths.gateDir, { type: 'prompt-pack', source: err.source, error: err.error });
  // Revalidate a pending claim within the hook's remaining time.
  const fingerprint = s.signals.claimedDone && s.lastTest && s.lastTest.fingerprint ? workTreeFingerprint(cwd, { deadline: DEADLINE }) : null;
  const usage = evt && typeof evt.transcript_path === 'string' ? readTranscriptUsage(evt.transcript_path, s.armedAt) : null;
  maybeSpawnRefresh(env);
  const ctx = {
    LOOP: loopCommand(ROOT),
    projectName: paths.projectName,
    planText,
    planExists,
    artifacts,
    overrides: packs.layers,
    fingerprint,
    usage,
    version: currentVersion(ROOT),
    updateAvailable: updateAvailable(ROOT, env),
    takeoverMs: parseTimeoutMs(env.OMC_SESSION_TAKEOVER_MS, 6 * 60 * 60 * 1000),
  };
  const event = {
    sessionId: evt && typeof evt.session_id === 'string' ? evt.session_id : '',
    now: Date.now(),
    payloadKeys: evt && typeof evt === 'object' ? Object.keys(evt) : [],
    stopHookActive: !!(evt && evt.stop_hook_active === true),
  };

  const r = step(s, event, ctx);
  holder.state = r.state;
  return executeEffects(r.effects, { paths, holder, deadline: DEADLINE, processEnv: env });
}

let out = null;
try { out = main(); }
catch (e) {
  // never break Claude's stop: log what we can and let it stop
  try { appendJournal(gatePaths(process.cwd()).gateDir, { type: 'note', text: `hook crashed: ${e && e.message}` }); } catch { /* nothing */ }
}
if (out) process.stdout.write(JSON.stringify(out));
process.exit(0);
