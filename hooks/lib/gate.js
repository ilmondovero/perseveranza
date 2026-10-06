// The bridge and the gate, from the mod.
//
// Every read and write of the loop's files goes through the bridge, src/shell/mod-bridge.mjs,
// a Node helper run with $.process.run (one JSON request on stdin, one JSON answer on stdout).
// $.process.run is CLI only: the mod drives the loop in `claude` and `claude -p`, not in the
// desktop app or the VS Code extension. The exceptions, all small: the existence checks of
// the loop's state files ($.fs.exists: a project without a loop never pays for a node
// process), the owner read by a failed stop, and the fault marker (writeFault below).
//
// The flushes (activity, tokens) run one at a time through a serial queue: a slow flush and
// the next debounce never write side by side. A stop, a judge's check and the read-only
// operations do not wait behind them: the bridge is safe with overlapping calls (the inbox of
// the tokens, atomic state writes, see PIANO-MOD "Stato fase 1"), and a stop must not spend
// its hook's own time waiting for a heartbeat.

export const GATE = '.perseveranza';
// a fail-open hook that had to skip is journaled this many times per hook per process, then counted
export const MAX_SKIP_NOTES = 3;

// Where node and the bridge are: PERSEVERANZA_NODE (an absolute path, for a node that is not
// on the PATH), else `node`; the bridge inside this plugin's folder.
export async function setup(io, mod) {
  if (mod.bridge) return;
  let node = '';
  try { node = (await io.nodeEnv()) || ''; } catch { /* unset */ }
  mod.node = node.trim() || 'node';
  mod.bridge = `${String(io.root()).replace(/[\\/]+$/, '')}/src/shell/mod-bridge.mjs`;
}

// Is a loop armed in cwd? The bridge's own rule (stop-core's DORMANT check): `state.json` is
// there, or only its pending copy (a save cut short) and the run was not disarmed (no
// `state.disarmed.json`, no `state.disarmed.mark`). A `.perseveranza/` folder alone is NOT a
// loop: `~/.perseveranza` is perseveranza's own config and archive, and a project keeps the
// folder after a run. `unknown` is what to assume when the check itself fails: true where a
// wrong "no" would skip the loop's guard, false where a wrong "yes" would block a session.
export const STATE_FILES = { state: 'state.json', pending: 'state.json.pending', retained: 'state.disarmed.json', mark: 'state.disarmed.mark' };
export const FAULT_FILE = 'mod-fault.json';
export const gateFile = (cwd, name) => `${String(cwd).replace(/[\\/]+$/, '')}/${GATE}/${name}`;

export async function hasGate(io, cwd, unknown) {
  if (typeof cwd !== 'string' || !cwd) return unknown;
  try {
    if ((await io.exists(gateFile(cwd, STATE_FILES.state))) === true) return true;
    if ((await io.exists(gateFile(cwd, STATE_FILES.pending))) !== true) return false;
    return (await io.exists(gateFile(cwd, STATE_FILES.retained))) !== true && (await io.exists(gateFile(cwd, STATE_FILES.mark))) !== true;
  } catch { return unknown; }
}

// The owner session of the loop in cwd, read without the bridge (the one other read the mod
// does, for a .catch whose bridge failed): '' unclaimed, a session id, or null (unreadable).
export async function readOwner(io, cwd) {
  try {
    const s = JSON.parse(await io.read(gateFile(cwd, STATE_FILES.state)));
    const id = s && s.owner && typeof s.owner === 'object' ? s.owner.sessionId : null;
    return typeof id === 'string' ? id : '';
  } catch { return null; }
}

// A durable trace when the bridge cannot even journal (node unreachable): one small file of its
// own, .perseveranza/mod-fault.json, written with $.fs.write (never a file the shell writes).
// `status` shows it; the next stop that reaches the bridge journals it (mod-fault) and removes
// it; `arm` reports a leftover one. Never throws.
export async function writeFault(io, cwd, fault) {
  try { await io.write(gateFile(cwd, FAULT_FILE), JSON.stringify(fault)); return true; } catch { return false; }
}

// One request -> { answer } | { error } (no answer: the bridge did not start, timed out,
// crashed, or printed something that is not JSON). Never throws.
export async function call(io, mod, op, { cwd, event = {}, facts = {}, timeoutMs }) {
  try {
    await setup(io, mod);
    const r = await io.run([mod.node, mod.bridge], { cwd, stdin: JSON.stringify({ op, cwd, event, facts }), timeoutMs });
    let answer = null;
    try { answer = JSON.parse(String(r.stdout || '').trim()); } catch { /* below */ }
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
      return { error: `no answer from the bridge (exit ${r.exitCode}${r.stderr ? `: ${String(r.stderr).trim().slice(0, 200)}` : ''})` };
    }
    return { answer };
  } catch (e) {
    return { error: `no answer from the bridge: ${String((e && e.message) || e).slice(0, 200)}` };
  }
}

// The serial queue: task() starts once every task queued before it settled.
export function enqueue(mod, task) {
  const run = mod.tail.then(task, task);
  mod.tail = run.then(() => undefined, () => undefined);
  return run;
}

// A flush on its way, from its first step (before it takes anything out of memory) to its
// last: mod.inflight holds it, and a stop waits for what is there (stop.js).
export function track(mod, run) {
  const p = Promise.resolve().then(run);
  mod.inflight.add(p);
  const done = () => { mod.inflight.delete(p); };
  p.then(done, done);
  return p;
}

// A fail-open hook that could not do its job: a line in the debug log and, a few times per
// hook, in the journal (mod-hook-skipped). Never throws.
export async function skipped(io, mod, cwd, hook, error, session = '') {
  const n = (mod.skips[hook] || 0) + 1;
  mod.skips[hook] = n;
  try { await io.log(`perseveranza: ${hook} skipped (${error})`); } catch { /* best effort */ }
  if (n > MAX_SKIP_NOTES) return;
  await call(io, mod, 'journal', { cwd, event: { session_id: session }, facts: { lines: [{ type: 'mod-hook-skipped', hook, error: String(error).slice(0, 300), count: n }] }, timeoutMs: 5000 });
}
