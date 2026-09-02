#!/usr/bin/env node
// STABLE resolver for the perseveranza statusline. `hud on` copies it to
// ~/.perseveranza/statusline-hud.mjs and points settings.json at it, so the configured path
// does not change when the plugin updates (the plugin cache is versioned). It finds the newest
// installed statusline.mjs (plugin cache, marketplace clone, or manual install) and runs it.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const cfgDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const candidates = [];
const cacheBase = join(cfgDir, 'plugins', 'cache', 'perseveranza', 'perseveranza');
if (existsSync(cacheBase)) {
  const versions = readdirSync(cacheBase).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) candidates.push(join(cacheBase, v, 'src', 'hud', 'statusline.mjs'));
}
candidates.push(join(cfgDir, 'plugins', 'marketplaces', 'perseveranza', 'src', 'hud', 'statusline.mjs'));
candidates.push(join(cfgDir, 'perseveranza', 'src', 'hud', 'statusline.mjs')); // manual install

const target = candidates.find(existsSync);
if (target) await import(pathToFileURL(target).href);
