import { gate, changeState, signal } from '../shared.mjs';

export function run({ cwd }) {
  const paths = gate(cwd);
  changeState(paths, (s) => { s.signals.claimedDone = true; });
  signal(paths, 'claim-done');
  console.log('Completion declared: at the next Stop the adversarial FINAL VERIFICATION starts (after a one-off cleanup pass).');
  return 0;
}
