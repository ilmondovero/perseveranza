// classic.Stop: the loop's driver. The bridge runs the Stop logic of the settings hook
// (stop-core.mjs) with the facts only the mod sees: the background tasks of the Stop input,
// the tokens measured since the last flush, the loop mode. Its answer is a block (the next
// instruction) or nothing (let Claude stop).
//
// Fail-closed, within limits: when the bridge gives no usable answer the hook throws, and its
// .catch answers ONE recovery block, so a broken helper does not end a loop in silence:
//   - only where a loop is armed (state.json, see gate.js), never because a .perseveranza/
//     folder exists (~/.perseveranza is perseveranza's own home);
//   - only for the session that drives it (the owner read from state.json; if unreadable, a
//     session this mod has seen driving it), never for another session's loop;
//   - never with stop_hook_active already true (the last stop was blocked), so never an endless
//     block. The price, said plainly: after the first block of a user turn every stop arrives
//     with stop_hook_active true, so a bridge that fails in the middle of a loop lets Claude
//     stop at once and the watchdog takes over. That stop is never silent: the failure goes to
//     the journal (through the bridge), or, when the bridge cannot even journal (node
//     unreachable), to .perseveranza/mod-fault.json, which `status` shows and the next stop
//     journals; and to the line under the prompt.
import { STOP_TIMEOUT_MS, CATCH_TIMEOUT_MS, STOP_FLUSH_WAIT_MS, isObj, errText } from './core.js';
import { call, hasGate, readOwner, writeFault } from './gate.js';
import { takeUsage, giveBack, cancelUsageTimer } from './usage.js';
import { sendHello, loopModeOf } from './session.js';

export class BridgeFailure extends Error {}

// The bridge's answer -> { block } | null. Throws BridgeFailure when there is none (the
// .catch decides). The delta it carried: sent again only when the bridge says it surely
// did not queue it (usageDropped); never after no answer, never when unverified.
export function settleStop(mod, delta, r) {
  if (!r || !r.answer) throw new BridgeFailure(r && r.error ? r.error : 'no answer from the bridge');
  const a = r.answer;
  if (a.ok !== true) throw new BridgeFailure(`the bridge failed: ${String(a.error || 'unknown').slice(0, 200)}`);
  if (a.usageDropped && delta) giveBack(mod, delta);
  if (a.outcome !== 'dormant' && a.outcome !== 'foreign-session') mod.driving = true;
  const block = isObj(a.decision) && typeof a.decision.block === 'string' && a.decision.block.trim() ? a.decision.block : null;
  return block ? { block } : null;
}

// A token flush already on its way (its delta comes back to memory if the bridge drops it) is
// waited for, up to STOP_FLUSH_WAIT_MS, before the stop takes what is in memory: the stop that
// archives the run then counts it. Only when one is on its way: otherwise no wait at all.
export async function waitFlushes(io, mod) {
  if (!mod.inflight.size) return 'idle';
  const all = Promise.allSettled([...mod.inflight]).then(() => 'flushed');
  let sleep = null;
  try { sleep = Promise.resolve(io.sleep(STOP_FLUSH_WAIT_MS)).then(() => 'timeout', () => 'timeout'); } catch { /* no clock: the flush's own timeout bounds it */ }
  return Promise.race(sleep ? [all, sleep] : [all]);
}

export async function onStop(io, mod, e) {
  const cwd = isObj(e) && typeof e.cwd === 'string' && e.cwd ? e.cwd : await io.cwd();
  if (isObj(e) && typeof e.transcript_path === 'string' && e.transcript_path) mod.transcript = e.transcript_path;
  // DORMANT: no loop armed, no node process (a failed check calls the bridge, which knows)
  if (!(await hasGate(io, cwd, true))) return null;
  await waitFlushes(io, mod);
  cancelUsageTimer(mod);
  const delta = takeUsage(mod);
  const facts = {
    backgroundTasks: isObj(e) && Array.isArray(e.background_tasks) ? e.background_tasks : [],
    // the tool, when this process registered it (the bridge names it only if the run was armed for it)
    loopMode: loopModeOf(mod),
    // always a mod reading, even an empty one: the transcripts are never read under the mod
    usage: delta ? { byAgent: delta } : {},
  };
  const r = await call(io, mod, 'stop', { cwd, event: e, facts, timeoutMs: STOP_TIMEOUT_MS });
  const decision = settleStop(mod, delta, r);
  // the Claude Code version, once, in the journal of a live loop (status shows it)
  if (!mod.helloSent && r.answer.outcome !== 'dormant' && r.answer.outcome !== 'foreign-session') await sendHello(io, mod, cwd, isObj(e) ? e.session_id : '');
  return decision;
}

export function recoveryText(error, root, tool = false) {
  const cli = `node "${String(root || '<perseveranza root>').replace(/[\\/]+$/, '')}/src/cli/perseveranza.mjs"`;
  // the helper is down, so the tool (which runs the same node) may be too: the CLI is named either way
  const how = tool ? `Call the \`perseveranza\` tool with {"verb":"status"} (if it fails too, run \`${cli} status\`)` : `Run \`${cli} status\``;
  return `perseveranza (mod): the Stop hook could not reach its helper (${error}). The loop is still armed. ${how} to see the current phase and its instruction, then carry on with that phase. If this happens again at the next stop, the loop lets you stop and the watchdog takes over.`;
}

// The .catch of classic.Stop -> { block } | null (see the head of this file).
export async function onStopFailed(io, mod, e, error) {
  const cwd = isObj(e) && typeof e.cwd === 'string' && e.cwd ? e.cwd : '';
  // a wrong "yes" here would block a session that has no loop: unknown counts as no
  if (!(await hasGate(io, cwd, false))) return null;
  const session = isObj(e) && typeof e.session_id === 'string' ? e.session_id : '';
  const owner = await readOwner(io, cwd);
  const ours = owner === '' || (owner !== null && owner === session) || (owner === null && mod.driving === true);
  const why = errText(error);
  try { await io.log(`perseveranza: the Stop hook could not reach its helper (${why})`); } catch { /* best effort */ }
  if (!ours) return null; // another session's loop: not this session's to resume, nor to report
  const active = isObj(e) && e.stop_hook_active === true;
  const recovery = !active;
  let now = 0;
  try { now = await io.now(); } catch { /* 0 */ }
  const r = await call(io, mod, 'journal', { cwd, event: { session_id: session }, facts: { lines: [{ type: 'mod-hook-skipped', hook: 'classic.Stop', error: why, recovery }] }, timeoutMs: CATCH_TIMEOUT_MS });
  const journaled = !!(r.answer && r.answer.ok === true && r.answer.journaled > 0);
  if (!journaled) await writeFault(io, cwd, { at: now, hook: 'classic.Stop', error: why, session, stopHookActive: active, recovery });
  try { await io.status(`perseveranza: the Stop hook could not reach its helper (${why})${recovery ? '' : '; the loop was left at this stop (the watchdog takes over)'}`); } catch { /* best effort */ }
  if (!recovery) return null;
  let root = '';
  try { root = io.root(); } catch { /* the text says where without it */ }
  return { block: recoveryText(why, root, loopModeOf(mod) === 'tool') };
}
