import { gate, changeState, signal, VerbError } from '../shared.mjs';
import { COMPLEXITIES } from '../../core/state.mjs';

export function run({ argv, cwd }) {
  const value = argv[0];
  if (!COMPLEXITIES.includes(value)) throw new VerbError('Usage: complexity low|medium|high');
  const paths = gate(cwd);
  changeState(paths, (s) => { s.complexity = value; });
  signal(paths, 'complexity', value);
  console.log(`Complexity recorded: ${value} (routes the review, verification and implementation models).`);
  return 0;
}
