#!/usr/bin/env node
// perseveranza statusline. Shows the loop progress ONLY when armed in the cwd, and
// COMPOSES with the pre-existing "base" statusline (captured by `hud on`) instead of
// replacing it. Dormant outside an armed project: prints only the base output.
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../providers/config.mjs';
import { renderProgress } from './render.mjs';
import { loadState } from '../core/state.mjs';
import { gatePaths, ROOT } from '../shell/paths.mjs';
import { maybeSpawnRefresh, updateAvailable, currentVersion } from '../update.mjs';
import { parseTimeoutMs } from '../shell/util.mjs';

let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
let sess = {};
try { sess = raw ? JSON.parse(raw) : {}; } catch { /* malformed */ }
const cwd = sess.cwd || sess.workspace?.current_dir || sess.workspace?.cwd || process.cwd();

const base = loadConfig().statusline?.base || '';
let baseOut = '';
if (base) {
  const baseTimeout = parseTimeoutMs(process.env.OMC_STATUSLINE_BASE_TIMEOUT_MS, 5000);
  let r = {};
  try { r = spawnSync(base, { shell: true, input: raw, encoding: 'utf8', timeout: baseTimeout, killSignal: 'SIGKILL' }); }
  catch { /* a broken base must never blank the whole statusline */ }
  baseOut = (r.stdout || '').replace(/\r?\n+$/, '');
}

let seg = '';
const paths = gatePaths(cwd);
if (existsSync(paths.statePath)) {
  try {
    const s = loadState(JSON.parse(readFileSync(paths.statePath, 'utf8'))).state;
    if (s) {
      const planText = existsSync(paths.planPath) ? readFileSync(paths.planPath, 'utf8') : '';
      seg = renderProgress(s, planText, { color: true, marker: true, version: currentVersion(ROOT) });
      maybeSpawnRefresh(process.env);
      const upd = updateAvailable(ROOT, process.env);
      if (upd) seg += ` \x1b[1;33m⬆v${upd}\x1b[0m`;
    }
  } catch { /* unreadable state: no segment */ }
}

const out = seg && baseOut ? `${seg} │ ${baseOut}` : (seg || baseOut);
process.stdout.write(out);
