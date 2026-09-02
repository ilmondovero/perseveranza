import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { gate } from '../shared.mjs';
import { readJournal, renderHistory } from '../../shell/journal.mjs';

export function run({ argv, cwd }) {
  const { values } = parseArgs({ args: argv, options: { tail: { type: 'string' }, json: { type: 'boolean' } }, strict: false });
  const paths = gate(cwd);
  if (!existsSync(paths.gateDir)) { console.log('perseveranza is NOT armed in this project (no journal).'); return 1; }
  const entries = readJournal(paths.gateDir);
  const tail = values.tail ? Math.max(1, parseInt(values.tail, 10) || 0) : 0;
  if (values.json) { console.log(JSON.stringify(tail ? entries.slice(-tail) : entries, null, 2)); return 0; }
  console.log(renderHistory(entries, tail) || '(empty journal)');
  return 0;
}
