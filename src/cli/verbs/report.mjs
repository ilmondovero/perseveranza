import { gate, changeState, signal, VerbError } from '../shared.mjs';

export function run({ argv, cwd }) {
  const value = argv[0];
  if (!['pass', 'fail'].includes(value)) throw new VerbError('Usage: report pass|fail');
  const paths = gate(cwd);
  const s = changeState(paths, (st) => { st.signals.lastReport = value; });
  signal(paths, 'report', value);
  console.log(`Outcome recorded: ${value} (current phase: ${s.phase}).`);
  return 0;
}
