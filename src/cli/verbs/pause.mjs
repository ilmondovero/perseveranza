import { gate, changeState, signal } from '../shared.mjs';

export function run({ cwd }) {
  const paths = gate(cwd);
  changeState(paths, (s) => { s.signals.paused = true; });
  signal(paths, 'pause');
  // read by the model too when it pauses through the tool: resuming is the user's
  console.log('perseveranza PAUSED: the hook will not intervene until the user resumes the loop (/pf resume in Claude Code, or the resume verb from a terminal).');
  return 0;
}
