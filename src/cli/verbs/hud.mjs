import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { claudeDir, home, ROOT } from '../../shell/paths.mjs';
import { loadConfig, saveConfig } from '../../providers/config.mjs';

// Enables/disables the perseveranza statusline by COMPOSING it with the existing one:
// the base command is saved and restored, never replaced destructively.
// settings.json points at a STABLE wrapper (~/.perseveranza/statusline-hud.mjs) so the path
// survives plugin updates (the plugin cache is versioned); the wrapper resolves the newest
// installed statusline.mjs.
export function run({ argv, env }) {
  const sub = (argv[0] || 'status').toLowerCase();
  const cdir = claudeDir(env);
  const settingsPath = join(cdir, 'settings.json');
  const wrapper = join(home(env), 'statusline-hud.mjs');
  const resolverSrc = join(ROOT, 'src', 'hud', 'resolver.mjs');
  const ourCmd = `node "${wrapper.replace(/\\/g, '/')}"`;
  const isOurs = (cmd) => typeof cmd === 'string' && /statusline(-hud)?\.mjs|hud\/(statusline|resolver)\.mjs/.test(cmd);
  const readSettings = () => { try { return JSON.parse(readFileSync(settingsPath, 'utf8')) || {}; } catch { return {}; } };

  if (sub === 'on') {
    const st = readSettings();
    const cur = st.statusLine && st.statusLine.command;
    if (!isOurs(cur)) {
      const cfg = loadConfig(env);
      cfg.statusline = { ...(cfg.statusline || {}), base: cur || '' };
      saveConfig(cfg, env);
    }
    mkdirSync(dirname(wrapper), { recursive: true });
    copyFileSync(resolverSrc, wrapper);
    st.statusLine = { type: 'command', command: ourCmd };
    mkdirSync(cdir, { recursive: true });
    if (existsSync(settingsPath)) writeFileSync(`${settingsPath}.bak-perseveranza-hud`, readFileSync(settingsPath));
    writeFileSync(settingsPath, JSON.stringify(st, null, 2));
    console.log(`perseveranza HUD ON. Base statusline preserved: ${loadConfig(env).statusline?.base || '(none)'}`);
    console.log('Restart Claude Code to see it. Disable with: hud off');
    return 0;
  }
  if (sub === 'off') {
    const st = readSettings();
    const base = loadConfig(env).statusline?.base || '';
    if (base) st.statusLine = { type: 'command', command: base }; else delete st.statusLine;
    mkdirSync(cdir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(st, null, 2));
    try { rmSync(wrapper, { force: true }); } catch { /* already gone */ }
    const cfg = loadConfig(env);
    if (cfg.statusline) { delete cfg.statusline.base; if (!Object.keys(cfg.statusline).length) delete cfg.statusline; saveConfig(cfg, env); }
    console.log(`perseveranza HUD OFF. Statusline restored: ${base || '(none)'}`);
    return 0;
  }
  const cur = readSettings().statusLine?.command || '(none)';
  console.log(`Current statusline: ${cur}`);
  console.log(`perseveranza HUD:   ${isOurs(cur) ? 'ON' : 'off'}`);
  console.log(`Saved base:         ${loadConfig(env).statusline?.base || '(none)'}`);
  console.log(`Wrapper:            ${wrapper}`);
  console.log('Usage: hud on | off | status');
  return 0;
}
