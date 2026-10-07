// A preload (node --import) for a process of the tests: at its VERB_ON_READ_AT-th read of
// state.json it first runs a CLI verb to the end (a concurrent writer landing at a known point).
//   VERB_ON_READ_AT   the read (1 = the first)
//   VERB_ON_READ      the verb and its words ("report pass", "pause")
//   VERB_ON_READ_CLI  the CLI; VERB_ON_READ_CWD its folder; VERB_ON_READ_VIA its PERSEVERANZA_VIA
//   VERB_ON_READ_LOG  a file that receives "<verb> -> <exit code> <output>"
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';

const original = fs.readFileSync;
const at = Number(process.env.VERB_ON_READ_AT || 0);
let reads = 0;
let done = false;
fs.readFileSync = function readFileSync(p, ...rest) {
  if (!done && typeof p === 'string' && /state\.json$/.test(p) && ++reads === at) {
    done = true;
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k === 'NODE_OPTIONS' || k.startsWith('VERB_ON_READ')) delete env[k];
    if (process.env.VERB_ON_READ_VIA) env.PERSEVERANZA_VIA = process.env.VERB_ON_READ_VIA;
    const r = spawnSync(process.execPath, [process.env.VERB_ON_READ_CLI, ...process.env.VERB_ON_READ.split(' ')], { cwd: process.env.VERB_ON_READ_CWD, env, encoding: 'utf8' });
    try { fs.appendFileSync(process.env.VERB_ON_READ_LOG, `${process.env.VERB_ON_READ} -> ${r.status} ${String(r.stdout || '').trim()}${String(r.stderr || '').trim()}\n`); } catch { /* no log */ }
  }
  return original.call(this, p, ...rest);
};
syncBuiltinESMExports();
