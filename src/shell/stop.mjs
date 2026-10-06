#!/usr/bin/env node
// The Stop hook. Thin by design: read the event, hand it to the Stop logic (stop-core.mjs),
// print the decision. Since 3.0 nothing registers it (the mod runs the same logic through
// mod-bridge.mjs, and install.mjs writes no settings hook): it stays for a settings hook wired
// by hand, the bench's dry run and the tests. DORMANT until .perseveranza/state.json exists in the cwd. Must never throw
// and must finish within the hook deadline.
import { readFileSync } from 'node:fs';
import { gatePaths } from './paths.mjs';
import { runStopFromFacts } from './stop-core.mjs';
import { appendJournal } from './journal.mjs';

const START = Date.now();

function main() {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  let evt = null;
  try { evt = raw ? JSON.parse(raw) : null; } catch { /* malformed event */ }
  return runStopFromFacts({ evt, env: process.env, start: START }).output;
}

let out = null;
try { out = main(); }
catch (e) {
  // never break Claude's stop: log what we can and let it stop
  try { appendJournal(gatePaths(process.cwd()).gateDir, { type: 'note', text: `hook crashed: ${e && e.message}` }); } catch { /* nothing */ }
}
if (out) process.stdout.write(JSON.stringify(out));
process.exit(0);
