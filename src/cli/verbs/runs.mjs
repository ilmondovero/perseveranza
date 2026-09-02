import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { listRuns, readRun } from '../../shell/archive.mjs';
import { readJournal, renderHistory } from '../../shell/journal.mjs';
import { runsDir } from '../../shell/paths.mjs';
import { VerbError } from '../shared.mjs';

export function run({ argv, env }) {
  const sub = argv[0] || 'list';
  if (sub === 'list') {
    const runs = listRuns(env);
    if (!runs.length) { console.log(`No archived runs (${runsDir(env)}).`); return 0; }
    for (const r of runs.slice(0, 50)) {
      const s = r.summary || {};
      console.log(`  ${r.id.padEnd(48)} ${String(s.outcome || '?').padEnd(16)} it=${s.iterations ?? '?'} tok=${s.tokens ?? '?'}  ${s.task ? s.task.slice(0, 60) : ''}`);
    }
    if (runs.length > 50) console.log(`  ... ${runs.length - 50} more`);
    return 0;
  }
  if (sub === 'show') {
    const id = argv[1];
    if (!id) throw new VerbError('Usage: runs show <project/stamp | stamp>');
    const r = readRun(id, env);
    if (!r) throw new VerbError(`Run not found: ${id}`);
    console.log(`Run ${r.id}  (${r.dir})\n`);
    console.log(JSON.stringify(r.summary, null, 2));
    const gate = join(r.dir, 'omc-loop');
    const hist = renderHistory(readJournal(gate), argv.includes('--all') ? 0 : 25);
    if (hist) console.log(`\nJournal${argv.includes('--all') ? '' : ' (last 25)'}:\n${hist}`);
    const plan = join(gate, 'plan.md');
    if (existsSync(plan)) console.log(`\nPlan:\n${readFileSync(plan, 'utf8')}`);
    return 0;
  }
  throw new VerbError('Usage: runs [list | show <id> [--all]]');
}
