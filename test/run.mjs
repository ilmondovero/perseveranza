#!/usr/bin/env node
// Test runner: collects test/**/*.test.mjs (optionally one level: unit|verbs|e2e|packaging)
// and hands the explicit file list to `node --test`. Explicit files behave the same on
// Node 20 and 22 (directory/glob handling differs between them) and keep the bench's
// own test.mjs files out of the suite.
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const levels = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const extra = process.argv.slice(2).filter((a) => a.startsWith('-'));

function collect(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collect(p));
    else if (/\.test\.mjs$/.test(name)) out.push(p);
  }
  return out.sort();
}

const dirs = levels.length ? levels.map((l) => join(ROOT, l)) : [join(ROOT, 'unit'), join(ROOT, 'verbs'), join(ROOT, 'e2e'), join(ROOT, 'packaging')];
const files = dirs.flatMap((d) => { try { return collect(d); } catch { return []; } });
if (!files.length) { console.error('no test files found'); process.exit(1); }
const r = spawnSync(process.execPath, ['--test', ...extra, ...files], { stdio: 'inherit', env: { ...process.env, OMC_LOOP_NO_NOTIFY: '1' } });
process.exit(r.status ?? 1);
