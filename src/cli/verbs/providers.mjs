import { PROVIDERS, PROVIDER_IDS, detectAvailable, hasBinary, checkProvider, modelLabel } from '../../providers/registry.mjs';
import { effectiveEnv, disabledProviders, disableProvider, enableProvider, loadConfig, providerTimeoutOverride, lastChecks, recordCheck } from '../../providers/config.mjs';
import { VerbError } from '../shared.mjs';

// providers [list] | providers check [id...] [--keep] | providers enable <id>
export async function run({ argv, env }) {
  const sub = argv[0] || 'list';
  const provEnv = effectiveEnv(env);
  const disabled = disabledProviders(env);
  const reasons = (loadConfig(env).providers || {}).disabledReasons || {};
  const checks = lastChecks(env);
  if (sub === 'list') {
    const available = detectAvailable({ has: hasBinary, env: provEnv, platform: process.platform, disabled: [] });
    for (const id of PROVIDER_IDS) {
      const p = PROVIDERS[id];
      const det = available.includes(id);
      const dis = disabled.includes(id);
      const why = dis && reasons[id] ? ` (${reasons[id].reason}, ${reasons[id].at.slice(0, 10)})` : '';
      const t = providerTimeoutOverride(id, env);
      // For the http transport the configured models are the thing worth checking at a glance.
      const ms = p.transport === 'http' ? `  models: ${p.models(provEnv).map(modelLabel).join(', ')}` : '';
      const c = checks[id];
      const probe = !det || dis ? '' : c ? `  last check: ${c.ok ? 'ok' : 'FAILED'} ${String(c.at).slice(0, 10)}` : '  never probed';
      console.log(`  ${id.padEnd(13)} ${p.transport.padEnd(4)} ${dis ? 'DISABLED' : det ? 'detected' : 'absent'}${why}${probe}${t ? `  timeout ${t}ms` : ''}${ms}`);
    }
    console.log('\nUse `providers check` to probe the detected ones; a dead provider is disabled in the config with the reason. "detected" means installed, not reachable: only a check tells.');
    return 0;
  }
  if (sub === 'enable') {
    const id = argv[1];
    if (!id || !PROVIDERS[id]) throw new VerbError(`Usage: providers enable <${PROVIDER_IDS.join('|')}>`);
    enableProvider(id, env);
    console.log(`${id} re-enabled.`);
    return 0;
  }
  if (sub === 'check') {
    const keep = argv.includes('--keep');
    const wanted = argv.slice(1).filter((a) => !a.startsWith('-'));
    const ids = wanted.length ? wanted : detectAvailable({ has: hasBinary, env: provEnv, platform: process.platform, disabled });
    if (!ids.length) { console.log('No provider detected (or all disabled). Nothing to check.'); return 0; }
    let failures = 0;
    for (const id of ids) {
      if (!PROVIDERS[id]) { console.log(`  ${id}: unknown provider`); failures++; continue; }
      process.stdout.write(`  ${id.padEnd(13)} probing... `);
      const r = await checkProvider(id, { env: provEnv, timeoutMs: providerTimeoutOverride(id, env) || 60000 });
      console.log(r.ok ? `ok (${r.ms} ms)` : `ERROR (${r.ms} ms): ${r.output.split('\n')[0]}`);
      recordCheck(id, { ok: r.ok, ms: r.ms, error: r.output.split('\n')[0] }, env);
      if (!r.ok) {
        failures++;
        if (!keep) { disableProvider(id, r.output.split('\n')[0] || 'probe failed', env); console.log(`    -> disabled in the config (providers enable ${id} to undo)`); }
      } else if (disabled.includes(id)) {
        enableProvider(id, env);
        console.log('    -> was disabled, re-enabled');
      }
    }
    return failures ? 1 : 0;
  }
  throw new VerbError('Usage: providers [list | check [id...] [--keep] | enable <id>]');
}
