import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { project, cli } from '../helpers/cli.mjs';

function fixture(settings) {
  const p = project();
  p.env.CLAUDE_CONFIG_DIR = join(p.home, 'claude');
  mkdirSync(p.env.CLAUDE_CONFIG_DIR);
  const file = join(p.env.CLAUDE_CONFIG_DIR, 'settings.json');
  if (settings !== undefined) writeFileSync(file, JSON.stringify(settings, null, 2));
  return { p, file };
}

test('hud off without hud on preserves foreign settings byte for byte and creates no files', () => {
  for (const command of ['echo custom', 'node "/another/statusline.mjs"', 'node "/another/statusline-hud.mjs"']) {
    const { p, file } = fixture({ statusLine: { type: 'command', command }, other: 1 });
    const before = readFileSync(file, 'utf8');
    assert.equal(cli(p, 'hud', 'off').code, 0);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(existsSync(join(p.home, 'config.json')), false);
  }
  const { p, file } = fixture();
  assert.equal(cli(p, 'hud', 'off').code, 0);
  assert.equal(existsSync(file), false);
});

test('hud preserves the complete original statusline and repeated off is harmless', () => {
  const original = { statusLine: { type: 'command', command: 'node "/another/statusline.mjs"', padding: 2 }, other: 1 };
  const { p, file } = fixture(original);
  assert.equal(cli(p, 'hud', 'on').code, 0);
  assert.equal(cli(p, 'hud', 'on').code, 0);
  assert.equal(cli(p, 'hud', 'off').code, 0);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), original);
  const restored = readFileSync(file, 'utf8');
  assert.equal(cli(p, 'hud', 'off').code, 0);
  assert.equal(readFileSync(file, 'utf8'), restored);
});

test('hud off preserves a replacement installed by the user after hud on', () => {
  const { p, file } = fixture({ statusLine: { type: 'command', command: 'echo original' } });
  assert.equal(cli(p, 'hud', 'on').code, 0);
  const replacement = '{"statusLine":{"type":"command","command":"echo replacement"},"custom":true}';
  writeFileSync(file, replacement);
  assert.equal(cli(p, 'hud', 'off').code, 0);
  assert.equal(readFileSync(file, 'utf8'), replacement);
});

test('hud refuses to overwrite malformed settings', () => {
  const { p, file } = fixture({});
  writeFileSync(file, '{broken');
  for (const mode of ['on', 'off']) {
    assert.equal(cli(p, 'hud', mode).code, 1);
    assert.equal(readFileSync(file, 'utf8'), '{broken');
  }
});
