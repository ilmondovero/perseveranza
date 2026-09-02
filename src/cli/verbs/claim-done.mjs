import { gate, requireState, saveState, signal } from '../shared.mjs';

export function run({ cwd }) {
  const paths = gate(cwd);
  const s = requireState(paths);
  s.signals.claimedDone = true;
  saveState(paths, s);
  signal(paths, 'claim-done');
  console.log('Completion declared: at the next Stop the adversarial FINAL VERIFICATION starts (after a one-off cleanup pass).');
  return 0;
}
