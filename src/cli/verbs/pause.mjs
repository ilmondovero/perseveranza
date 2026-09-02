import { gate, requireState, saveState, signal } from '../shared.mjs';

export function run({ cwd }) {
  const paths = gate(cwd);
  const s = requireState(paths);
  s.signals.paused = true;
  saveState(paths, s);
  signal(paths, 'pause');
  console.log('perseveranza PAUSED: the hook will not intervene until you run resume.');
  return 0;
}
