#!/usr/bin/env node
// Resolver STABILE per la statusline di perseveranza. Viene copiato da `hud on` in
// ~/.perseveranza/statusline-hud.mjs e referenziato da settings.json: cosi' il path nella
// configurazione NON cambia quando il plugin si aggiorna (la cache del plugin e' versionata,
// es. .../perseveranza/1.10.0/...). Qui troviamo la statusline.mjs della versione piu'
// recente installata (o il clone del marketplace) e la eseguiamo: lei compone con la base.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const cfgDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const candidates = [];

const cacheBase = join(cfgDir, 'plugins', 'cache', 'perseveranza', 'perseveranza');
if (existsSync(cacheBase)) {
  // versioni in ordine decrescente (numeric: 1.10.0 > 1.9.0)
  const versions = readdirSync(cacheBase).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) candidates.push(join(cacheBase, v, 'scripts', 'statusline.mjs'));
}
candidates.push(join(cfgDir, 'plugins', 'marketplaces', 'perseveranza', 'scripts', 'statusline.mjs'));

const target = candidates.find(existsSync);
if (target) {
  await import(pathToFileURL(target).href); // esegue statusline.mjs (legge stdin, scrive l'output)
}
// se nessuna statusline trovata (plugin assente): nessun output. Disattiva con `hud off`.
