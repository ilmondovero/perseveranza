// Preload for the bridge in the tests of the real-time subagent wait: a file lands DURING the
// wait, at its LAND_AT_POLL-th poll (after LAND_AT_POLL real sleeps), whatever the machine's
// load. A writer started beside the bridge with a timer could land before the bridge even began
// (a loaded machine is slow to start node), and the stop then read it without waiting: the wait
// was never tested.
//   LAND_FILE     the file to write (a verdict, or the activity record of the subagent's return)
//   LAND_TEXT     its content; "__NOW__" in it becomes the time of the landing (ms)
//   LAND_TRIGGER  the verdict file whose clock the wait polls (default LAND_FILE)
//   LAND_AT_POLL  the poll of the wait at which it lands (default 3)
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const stat = fs.statSync;
const target = process.env.LAND_FILE;
const trigger = process.env.LAND_TRIGGER || target;
const at = Number(process.env.LAND_AT_POLL || 3);
let polls = 0;
let landed = false;
if (target) {
  fs.statSync = function (p, ...rest) {
    // the wait reads the verdict clocks once before its first sleep (poll 0), then once per poll
    if (!landed && String(p) === trigger && new Error().stack.includes('waitForSubagent')) {
      if (polls === at) { fs.writeFileSync(target, String(process.env.LAND_TEXT || '').replaceAll('"__NOW__"', String(Date.now()))); landed = true; }
      polls += 1;
    }
    return stat.call(this, p, ...rest);
  };
  syncBuiltinESMExports();
}
