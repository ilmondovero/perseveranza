import { existsSync } from 'node:fs';
import { loadConfig, effectiveEnv, disabledProviders, detectLang } from '../../providers/config.mjs';
import { PROVIDERS } from '../../providers/registry.mjs';
import { configPath, home, runsDir } from '../../shell/paths.mjs';

// Shows the effective local configuration WITHOUT ever printing the key.
export function run({ env }) {
  const cfg = loadConfig(env);
  const e = effectiveEnv(env);
  const keySrc = env.OLLAMA_API_KEY ? 'environment variable' : (cfg.ollama && cfg.ollama.apiKey) ? 'config file' : null;
  console.log(`Home:                 ${home(env)}`);
  console.log(`Config file:          ${configPath(env)} ${existsSync(configPath(env)) ? '(present)' : '(absent)'}`);
  console.log(`Runs archive:         ${runsDir(env)}`);
  console.log(`Instruction language: ${detectLang(env)} (PERSEVERANZA_LANG > config "lang" > default it)`);
  console.log(`OLLAMA_API_KEY:       ${e.OLLAMA_API_KEY ? `set (from ${keySrc})` : 'NOT set'}`);
  console.log(`ollama-cloud models:  ${PROVIDERS['ollama-cloud'].models(e).join(', ')}`);
  console.log(`ollama-cloud host:    ${PROVIDERS['ollama-cloud'].host(e)}`);
  console.log(`Disabled providers:   ${disabledProviders(env).join(', ') || 'none'}`);
  console.log('');
  console.log('Example config file:');
  console.log('  { "lang": "it",');
  console.log('    "ollama": { "apiKey": "<your key>", "model": "glm-5.2,kimi-k2.7-code" },');
  console.log('    "providers": { "disabled": ["codex"], "timeouts": { "ollama-cloud": 300000 } } }');
  return 0;
}
