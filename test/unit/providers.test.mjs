import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { askProvider } from '../../src/providers/registry.mjs';

test('isolated CLI invocations use fresh empty directories and clean up all exit paths', async () => {
  const seen = new Set();
  for (const id of ['grok', 'cursor', 'claude']) {
    for (const mode of ['success', 'failure', 'timeout', 'throw']) {
      let cwd;
      let wasEmpty = false;
      const result = await askProvider(id, 'a prompt with "quotes" & shell syntax', {
        spawn: (_cmd, argsOrOpts, opts) => {
          cwd = (opts || argsOrOpts).cwd;
          wasEmpty = cwd !== tmpdir() && existsSync(cwd) && readdirSync(cwd).length === 0;
          if (wasEmpty) writeFileSync(join(cwd, 'provider-output.txt'), 'temporary output');
          if (mode === 'throw') throw new Error('spawn failed');
          if (mode === 'timeout') return { status: null, error: new Error('ETIMEDOUT') };
          return { status: mode === 'success' ? 0 : 1, stdout: 'answer', stderr: '' };
        },
      });
      assert.ok(wasEmpty, `${id}/${mode}: dedicated empty directory`);
      assert.ok(!seen.has(cwd), 'each invocation must use a different directory');
      seen.add(cwd);
      assert.equal(existsSync(cwd), false, `${id}/${mode}: cleanup`);
      assert.equal(result.ok, mode === 'success');
    }
  }
});
