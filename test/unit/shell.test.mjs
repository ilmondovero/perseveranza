import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTranscriptUsage } from '../../src/shell/transcript.mjs';
import { parseTimeoutMs, summarizeExternalOpinions, boolEnv } from '../../src/shell/util.mjs';
import { appendJournal, readJournal, renderHistory, formatEntry } from '../../src/shell/journal.mjs';
import { loadPromptLayers } from '../../src/shell/packs.mjs';
import { buildSummary } from '../../src/shell/archive.mjs';
import { detectAvailable, providerModels, askTimeoutMs, PROVIDERS, askProvider } from '../../src/providers/registry.mjs';
import { effectiveEnv, disabledProviders, detectLang, disableProvider, enableProvider, providerTimeoutOverride } from '../../src/providers/config.mjs';
import { cmpSemver } from '../../src/update.mjs';
import { mk } from '../helpers/core.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'prs-unit-'));

test('transcript usage: sums assistant usage after the arm time, null when nothing found', () => {
  const lines = [
    JSON.stringify({ type: 'assistant', timestamp: '2020-01-01T00:00:00Z', message: { usage: { input_tokens: 5, output_tokens: 5 } } }),
    JSON.stringify({ type: 'assistant', timestamp: '2030-01-01T00:00:00Z', message: { usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 } } }),
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1, output_tokens: 1 } } }), // no timestamp: counted
    'garbage',
    JSON.stringify({ type: 'user', message: { content: 'x' } }),
  ].join('\n');
  const u = parseTranscriptUsage(lines, '2025-01-01T00:00:00Z');
  assert.deepEqual(u, { inputTokens: 11, outputTokens: 21, cacheReadTokens: 7, cacheCreationTokens: 3 });
  assert.deepEqual(parseTranscriptUsage(lines, null).inputTokens, 16);
  assert.equal(parseTranscriptUsage('', null), null);
  assert.equal(parseTranscriptUsage('{"type":"user"}', null), null);
});

test('util: parseTimeoutMs, boolEnv, summarizeExternalOpinions', () => {
  assert.equal(parseTimeoutMs('5000', 100), 5000);
  assert.equal(parseTimeoutMs('abc', 100), 100);
  assert.equal(parseTimeoutMs('-4', 100), 100);
  assert.equal(parseTimeoutMs('10', 100), 1000);
  assert.equal(boolEnv('yes'), true);
  assert.equal(boolEnv('0'), false);
  const s = summarizeExternalOpinions([{ label: 'a', text: '- status: ok\n' }, { label: 'b', text: '- status: ERROR\n' }, { label: 'c', text: '- esito: ok\n' }]);
  assert.deepEqual(s, { attempted: 3, ok: 2, failed: ['b'] });
});

test('journal: append/read round trip, unparseable lines survive, history rendering', () => {
  const d = tmp();
  appendJournal(d, { type: 'fire', session: 'abc', payloadKeys: ['a'] });
  appendJournal(d, { type: 'transition', from: 'plan', to: 'implement', outcome: 'ready', iteration: 1 });
  writeFileSync(join(d, 'journal.jsonl'), 'not json\n', { flag: 'a' });
  const entries = readJournal(d);
  assert.equal(entries.length, 3);
  assert.equal(entries[2].type, 'unparseable');
  const h = renderHistory(entries);
  assert.ok(h.includes('fire session=abc'));
  assert.ok(h.includes('plan -> implement | ready'));
  assert.equal(renderHistory(entries, 1).split('\n').length, 1);
  assert.ok(formatEntry({ ts: null, type: 'done', iterations: 3, tokens: 10 }).includes('DONE after 3'));
  assert.equal(readJournal(join(d, 'missing')).length, 0);
});

test('packs: precedence env > project > lang, broken layers reported not thrown', () => {
  const d = tmp();
  const root = tmp();
  mkdirSync(join(root, 'packs'));
  writeFileSync(join(root, 'packs', 'it.json'), JSON.stringify({ prompts: { cleanup: 'IT', 'plan-write': 'IT-PLAN' } }));
  const gateDir = join(d, '.omc-loop');
  mkdirSync(gateDir);
  writeFileSync(join(gateDir, 'prompts.json'), JSON.stringify({ prompts: { cleanup: 'PROJECT' } }));
  const envPack = join(d, 'env.json');
  writeFileSync(envPack, JSON.stringify({ prompts: { cleanup: 'ENV' } }));
  const r = loadPromptLayers({ gateDir, env: { OMC_PROMPT_PACK: envPack }, lang: 'it', root });
  assert.deepEqual(r.layers.map((l) => l.cleanup), ['ENV', 'PROJECT', 'IT']);
  assert.equal(r.layers[2]['plan-write'], 'IT-PLAN');
  writeFileSync(join(gateDir, 'prompts.json'), '{');
  const b = loadPromptLayers({ gateDir, env: {}, lang: 'en', root });
  assert.equal(b.layers.length, 0);
  assert.equal(b.errors.length, 1);
  assert.equal(loadPromptLayers({ gateDir: join(d, 'nope'), env: {}, lang: 'xx', root }).layers.length, 0);
});

test('archive summary aggregates the journal', () => {
  const s = mk({ counters: { iterations: 7 }, usage: { inputTokens: 10, outputTokens: 5 } });
  const j = [
    { ts: 't', type: 'test', exitCode: 0, iteration: 3 },
    { ts: 't', type: 'verdict', artifact: 'review.json', blocking: 0 },
    { ts: 't', type: 'ask', provider: 'codex', slot: 'plan', ok: false },
    { ts: 't', type: 'transition' },
  ];
  const sum = buildSummary(s, j, 'done');
  assert.equal(sum.outcome, 'done');
  assert.equal(sum.iterations, 7);
  assert.equal(sum.tokens, 15);
  assert.equal(sum.tests.length, 1);
  assert.equal(sum.verdicts[0].blocking, 0);
  assert.equal(sum.externalOpinions[0].provider, 'codex');
  assert.equal(sum.transitions, 1);
  assert.equal(buildSummary(null, [], 'killed').task, '');
});

test('providers: registry, detection, models, timeouts', () => {
  const has = (n) => ['codex', 'claude', 'cursor-agent'].includes(n);
  assert.deepEqual(detectAvailable({ has, env: {}, platform: 'linux' }), ['codex', 'cursor', 'claude']);
  assert.deepEqual(detectAvailable({ has, env: { OLLAMA_API_KEY: 'k' }, platform: 'linux', disabled: ['codex'] }), ['cursor', 'claude', 'ollama-cloud']);
  assert.deepEqual(providerModels('ollama-cloud', { OLLAMA_MODEL: 'a, b,,' }), ['a', 'b']);
  assert.deepEqual(providerModels('ollama-cloud', { OLLAMA_MODEL: ' , ' }), ['glm-5.2']);
  assert.deepEqual(providerModels('codex'), [null]);
  assert.equal(PROVIDERS['ollama-cloud'].host({ OLLAMA_HOST: 'https://x/' }), 'https://x');
  assert.equal(askTimeoutMs({}), 180000);
  assert.equal(askTimeoutMs({ OMC_ASK_TIMEOUT_MS: '5000' }), 5000);
  assert.equal(askTimeoutMs({ OMC_ASK_TIMEOUT_MS: '5000' }, 7), 7);
  const hostile = 'a" ; rm -rf / ; $(x) %PATH% `y`';
  assert.deepEqual(PROVIDERS.grok.argv(hostile)[2], hostile);
  assert.deepEqual(PROVIDERS.cursor.argv(hostile).at(-1), hostile);
  for (const id of ['grok', 'cursor', 'claude']) assert.ok(PROVIDERS[id].cwd().length > 0);
});

test('askProvider: unknown provider, injected spawn for CLI transport, ollama host validation', async () => {
  assert.equal((await askProvider('nope', 'x')).ok, false);
  const calls = [];
  const spawn = (cmd, argsOrOpts, opts) => { calls.push({ cmd, argsOrOpts, opts }); return { status: 0, stdout: 'OK', stderr: '' }; };
  const r = await askProvider('codex', 'hello', { spawn, env: {} });
  assert.equal(r.ok, true);
  assert.equal(calls[0].cmd, 'codex exec --skip-git-repo-check');
  assert.equal(calls[0].argsOrOpts.input, 'hello');
  const r2 = await askProvider('grok', 'p', { spawn, env: {} });
  assert.equal(r2.ok, true);
  assert.deepEqual(calls[1].argsOrOpts, ['-p', 'p', '--always-approve']);
  const fail = await askProvider('codex', 'x', { spawn: () => ({ error: new Error('ENOENT') }), env: {} });
  assert.equal(fail.ok, false);
  assert.ok(fail.output.includes('cannot run codex'));
  const bad = await askProvider('ollama-cloud', 'x', { env: { OLLAMA_API_KEY: 'k', OLLAMA_HOST: 'ftp://x' } });
  assert.equal(bad.ok, false);
  assert.ok(bad.output.includes('not a valid http(s)'));
  assert.equal((await askProvider('ollama-cloud', 'x', { env: {} })).ok, false);
});

test('config: effectiveEnv precedence, denylist with reasons, timeouts, language', () => {
  const home = tmp();
  const env = { PERSEVERANZA_HOME: home, OLLAMA_MODEL: 'from-env' };
  writeFileSync(join(home, 'config.json'), JSON.stringify({ ollama: { apiKey: 'k', model: 'from-file' }, lang: 'it', providers: { timeouts: { codex: 12345 } } }));
  const e = effectiveEnv(env);
  assert.equal(e.OLLAMA_API_KEY, 'k');
  assert.equal(e.OLLAMA_MODEL, 'from-env');
  assert.equal(detectLang(env), 'it');
  assert.equal(detectLang({ PERSEVERANZA_HOME: home, PERSEVERANZA_LANG: 'de' }), 'de');
  assert.equal(detectLang({ PERSEVERANZA_HOME: tmp(), LANG: 'fr_FR', LC_ALL: 'fr_FR' }), 'it', 'locale never decides');
  assert.equal(detectLang({ PERSEVERANZA_HOME: tmp() }), 'it');
  assert.equal(providerTimeoutOverride('codex', env), 12345);
  assert.equal(providerTimeoutOverride('agy', env), null);
  disableProvider('codex', 'probe failed', env);
  assert.deepEqual(disabledProviders(env), ['codex']);
  enableProvider('codex', env);
  assert.deepEqual(disabledProviders(env), []);
  assert.equal(effectiveEnv({ PERSEVERANZA_HOME: home }).OLLAMA_MODEL, 'from-file');
});

test('update: cmpSemver is numeric', () => {
  assert.ok(cmpSemver('1.10.0', '1.9.0') > 0);
  assert.ok(cmpSemver('2.0.0', '1.19.0') > 0);
  assert.equal(cmpSemver('1.2.3', '1.2.3'), 0);
});
