// One of two watchdogs racing for the same restore (a test of src/shell/watchdog.mjs): decide()
// then, at a common instant, restore() with a fake launch that appends this process's pid.
//   node restore-racer.mjs <gateDir> <startAt ms> <launches file>
import { appendFileSync } from 'node:fs';
import { decide, restore } from '../../src/shell/watchdog.mjs';

const [gateDir, startAt, out] = process.argv.slice(2);
const d = decide(gateDir, { staleMs: 1000, pid: process.pid });
while (Date.now() < Number(startAt)) { /* the barrier: both start the restore together */ }
const r = d.action === 'alert'
  ? restore(gateDir, d, process.env, {
    processInfo: () => ({ alive: false }),
    killTree: () => true,
    launchRestore: () => { appendFileSync(out, `${process.pid}\n`); return { ok: true, how: 'fake' }; },
  })
  : { attempted: false, why: `decide: ${d.action}` };
appendFileSync(`${out}.why`, `${process.pid} ${JSON.stringify(r)}\n`);
