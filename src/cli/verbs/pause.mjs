import { gate, changeState, signal } from '../shared.mjs';

export function run({ cwd }) {
  const paths = gate(cwd);
  changeState(paths, (s) => { s.signals.paused = true; });
  signal(paths, 'pause');
  console.log('perseveranza PAUSED: the hook will not intervene until you run resume.');
  return 0;
}
