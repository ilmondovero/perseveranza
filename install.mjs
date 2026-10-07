#!/usr/bin/env node
// MANUAL installation of perseveranza (alternative to the marketplace, same plugin).
// Prefer the marketplace:  /plugin marketplace add https://github.com/ilmondovero/perseveranza
//                          /plugin install perseveranza@perseveranza
// NEVER both at once: two copies of the mod would drive the same loop.
//
// Since 3.0 perseveranza is a mod (a plugin with a hooks module, Claude Code 2.1.287 or later),
// and a manual install loads it the documented way for a plugin that is not installed from a
// marketplace: the directory in CLAUDE_CODE_PLUGIN_DIRS, in the "env" of ~/.claude/settings.json
// ("Plugin directories to load as --plugin-dir does ... Absolute paths separated by `:`, or `;`
// on Windows", mods reference). So:
//   1. copies the files listed in manifest.mjs into <claude dir>/perseveranza/ (a whole plugin
//      directory: .claude-plugin/plugin.json, hooks/, commands/, agents/, src/, packs/), with a
//      marker, .perseveranza-install.json, that lists every file it installed (size and sha256);
//      when the install there is already this one, file for file, it copies nothing;
//   2. adds that directory to env.CLAUDE_CODE_PLUGIN_DIRS in <claude dir>/settings.json,
//      keeping every other entry and every other key;
//   3. takes out what earlier manual installs (1.x, 2.x) left: their settings hooks (a hook whose
//      command runs exactly one of legacy.mjs LEGACY_SETTINGS_HOOK_SCRIPTS: one left behind would
//      drive the loop a second time) and the files they copied into <claude dir>/hooks, /agents
//      and /commands.
// It writes no settings hook.
//
// WHAT IT DELETES, and nothing else:
//   (a) a file its marker lists that is still exactly as it wrote it (size and sha256), and the
//       files Claude Code generates in a plugin directory it loads (.claude-plugin/types/, the
//       tsconfig.json that extends them) inside an install it recognizes;
//   (b) a file of an earlier manual install whose sha256 is EXACTLY the one of a file a past
//       release copied there (src/shell/legacy-hashes.mjs, computed from the git history by
//       scripts/legacy-hashes.mjs and checked against git by the tests);
//   (c) the leftovers of one of its own runs that was killed half way, recognized by the file it
//       wrote into them first (.perseveranza-staging.json: its pid, the time and a random nonce
//       that are also in the folder's name), and only when that process is gone (a folder of
//       such a run killed before its sentinel was written is empty: only that is removed).
// Everything else is only NAMED: "left alone ... remove it yourself". A file of yours with the
// name of an old one, an old file you changed, a folder named like a leftover: never deleted.
//
// What else it never does:
//   - replace a <claude dir>/perseveranza it does not recognize as its own install: its marker
//     (complete: every listed file there with its size and hash), or, for an install without a
//     marker (2.x, or one whose marker is gone), only files that are exact copies of a release.
//     A git checkout, a symlink or junction, the checkout this script runs from (by real path), a
//     marker that is not its own, a file it did not install or one changed since: refused,
//     nothing touched, and it says how to go on;
//   - leave settings.json pointing at a half copy: the new copy is built aside and verified, the
//     old one is renamed away, the new one renamed in, and only then settings.json is written;
//   - run twice at once on the same config dir: a lock (<claude dir>/.perseveranza-install.lock,
//     a directory made atomically, with the owner's pid) makes a second run wait, then give up
//     with what to do. A lock whose owner is gone is taken over;
//   - change settings.json other than by its one entry and the old hooks: read and checked before
//     anything is touched (not valid JSON, not the shape expected: refused, nothing changed), and
//     edited as text (patchSettings): the value of its entry is written, or the entry taken out,
//     and the old hooks taken out; every other byte stays (numbers as written, inline arrays,
//     spacing, escapes, keys written twice). The result must parse to exactly the settings
//     expected, else it is refused. Written only when something changes, atomically, with its
//     mode and BOM, through a symlink to the file it points at. A settings hook of 1.x/2.x goes
//     only while the script it runs is theirs (gone, or a copy of a release); one running a script
//     the user changed stays, and is named. The entry is compared by real path (an 8.3 name, a
//     junction, a subst drive are the same folder). The first time it changes a settings.json it
//     did not create, it keeps the original as settings.json.bak-perseveranza-3.0, never
//     overwritten (nor written through anything already at that name; the
//     settings.json.bak-perseveranza of 2.x is another file, untouched); one it created and that
//     holds only its entry is deleted by --uninstall;
//   - remove anything inside <claude dir>/hooks, /agents or /commands when that folder is a link
//     or a junction, or lies outside the config dir: it is named instead.
//
// Usage:  node install.mjs [--claude-dir <dir>]
//         node install.mjs --uninstall [--claude-dir <dir>]
// <claude dir>: --claude-dir, else CLAUDE_CONFIG_DIR, else ~/.claude.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync, openSync, closeSync, statSync, lstatSync, realpathSync, readdirSync, rmdirSync, unlinkSync, chmodSync, readlinkSync } from 'node:fs';
import { join, dirname, basename, resolve, delimiter, relative, sep as pathSep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir, hostname } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { ALL_FILES, COMMAND_FILES, CLI_ENTRY } from './manifest.mjs';
import { LEGACY_SETTINGS_HOOK_SCRIPTS, LEGACY_PLUGIN_HOOK_SCRIPTS, LEGACY_V1_CLI_FILE, LEGACY_HASHES } from './src/shell/legacy.mjs';
import { realPathOr } from './src/shell/paths.mjs';

export const PLUGIN_DIRS_VAR = 'CLAUDE_CODE_PLUGIN_DIRS';
export const INSTALL_DIRNAME = 'perseveranza';
export const BACKUP_SUFFIX = '.bak-perseveranza-3.0';
export const MARKER = '.perseveranza-install.json';
// the marker as it is being written (renamed to MARKER when complete)
const MARKER_TMP = MARKER + '.tmp';
// written first into every folder a run makes or renames away (see leftoverOf)
export const SENTINEL = '.perseveranza-staging.json';
export const LOCK_NAME = '.perseveranza-install.lock';
const LOCK_OWNER = 'owner.json';
export const PLUGIN_NAME = 'perseveranza';
const BOM = '\uFEFF';

// A path compared the way the file system would: absolute, '/' separators, no repeated or
// trailing '/', and case-blind on Windows.
export function normPath(p, platform = process.platform) {
  let s = resolve(String(p)).replaceAll('\\', '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (platform === 'win32') s = s.toLowerCase();
  return s;
}
export function sameDir(a, b, platform = process.platform) {
  return normPath(a, platform) === normPath(b, platform);
}
// symlinks resolved, a missing tail (the install directory before the first run) kept as
// written under its deepest existing ancestor: see realPathOr
const realOr = realPathOr;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const nonce = () => randomBytes(8).toString('hex');
const list = (xs, n = 5) => `${xs.slice(0, n).join(', ')}${xs.length > n ? `, ... (${xs.length} in all)` : ''}`;

// Is the process with this pid still running? (EPERM: it is, it belongs to someone else)
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ---------------------------------------------------------------- settings.json, pure parts

// The checks before anything is touched: the parsed settings, or why they are refused.
//   -> { settings, bom } | { error }
export function parseSettings(text) {
  const bom = text.startsWith(BOM);
  const body = bom ? text.slice(1) : text;
  if (body.trim() === '') return { settings: {}, bom };
  let s;
  try { s = JSON.parse(body); } catch (e) { return { error: `it is not valid JSON (${e.message}; comments are not JSON either)` }; }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { error: 'it is not a JSON object' };
  if ('env' in s && (!s.env || typeof s.env !== 'object' || Array.isArray(s.env))) return { error: '"env" is not an object' };
  if (s.env && PLUGIN_DIRS_VAR in s.env && typeof s.env[PLUGIN_DIRS_VAR] !== 'string') return { error: `"env.${PLUGIN_DIRS_VAR}" is not a string` };
  return { settings: s, bom };
}

// How the file is laid out, so what is added looks like the rest: { indent, eol, trailing }. The indentation is
// the one of its first indented line (spaces or tabs); a file on one line stays on one line; an
// empty file, or "{}", gets two spaces.
export function settingsFormat(body) {
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const trailing = body === '' || /\n$/.test(body);
  const t = body.trim();
  const m = /\n([ \t]+)\S/.exec(body);
  const indent = m ? m[1] : (t === '' || t === '{}' || t.includes('\n')) ? '  ' : '';
  return { indent, eol, trailing };
}
// ---- settings.json is edited as text: the one entry, and the old hooks, change; every other byte
// of the file stays as the user wrote it (numbers, escapes, spacing, inline arrays, keys written
// twice). The edit is checked by parsing the result: it must be exactly the settings expected.

// The spans of a JSON text already accepted by JSON.parse:
//   { type: 'object', start, end, members: [{ key, keyStart, keyEnd, value }] }
//   { type: 'array', start, end, items: [node] }   { type: 'value', start, end }
export function jsonSpans(text) {
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\r\n'.includes(text[i])) i++; };
  const str = () => { const s = i; i++; while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1; i++; return [s, i]; };
  const value = () => {
    ws();
    const s = i;
    if (text[i] === '{' || text[i] === '[') {
      const obj = text[i] === '{';
      i++;
      const list = [];
      ws();
      if (text[i] !== (obj ? '}' : ']')) {
        for (;;) {
          ws();
          if (obj) {
            const [ks, ke] = str();
            ws();
            i++; // :
            list.push({ key: JSON.parse(text.slice(ks, ke)), keyStart: ks, keyEnd: ke, value: value() });
          } else list.push(value());
          ws();
          if (text[i] === ',') { i++; continue; }
          break;
        }
      }
      i++; // } or ]
      return obj ? { type: 'object', start: s, end: i, members: list } : { type: 'array', start: s, end: i, items: list };
    }
    if (text[i] === '"') { str(); return { type: 'value', start: s, end: i }; }
    while (i < text.length && !',]} \t\r\n'.includes(text[i])) i++;
    return { type: 'value', start: s, end: i };
  };
  return value();
}
// the member JSON.parse keeps: the last one with that key
const memberOf = (obj, key) => (obj && obj.type === 'object' ? [...obj.members].reverse().find((m) => m.key === key) : null);
// the whitespace that opens the line pos is on
const lineIndent = (text, pos) => { const nl = text.lastIndexOf('\n', pos - 1); return /^[ \t]*/.exec(text.slice(nl + 1))[0]; };

// The edits that take out the members (object) or items (array) at the indices `gone` of node and,
// for an object, add [key, value text] after its last member: the separators around them go, the
// layout of the rest stays.
function listEdits(text, node, gone, fmt, add = null) {
  const list = node.type === 'object' ? node.members : node.items;
  const span = (k) => [node.type === 'object' ? list[k].keyStart : list[k].start, (node.type === 'object' ? list[k].value : list[k]).end];
  const edits = [];
  const kept = list.map((_, k) => k).filter((k) => !gone.has(k));
  const render = (sepWs, kv, indent) => `${JSON.stringify(add[0])}${kv}${add[1](sepWs, indent, kv)}`;
  if (!kept.length) {
    // nothing left of what was there: the inside is cleared (and the new member written alone)
    let inner = '';
    if (add) {
      const own = lineIndent(text, node.start);
      inner = fmt.indent ? `${fmt.eol}${own}${fmt.indent}${render(`${fmt.eol}${own}${fmt.indent}`, ': ', own + fmt.indent)}${fmt.eol}${own}` : render('', ':', '');
    }
    edits.push({ start: node.start + 1, end: node.end - 1, text: inner });
    return edits;
  }
  for (let k = 0; k < list.length; k++) {
    if (!gone.has(k)) continue;
    let b = k;
    while (b + 1 < list.length && gone.has(b + 1)) b++;
    // a run k..b: up to the next one kept, or back to the end of the one kept before it
    if (b + 1 < list.length) edits.push({ start: span(k)[0], end: span(b + 1)[0], text: '' });
    else edits.push({ start: span(k - 1)[1], end: span(b)[1], text: '' });
    k = b;
  }
  if (add) {
    // laid out like the first member: the whitespace before it, and around its colon
    const sepWs = text.slice(node.start + 1, span(0)[0]);
    const kv = text.slice(list[0].keyEnd, list[0].value.start);
    const indent = sepWs.includes('\n') ? sepWs.slice(sepWs.lastIndexOf('\n') + 1) : '';
    const at = span(kept[kept.length - 1])[1];
    edits.push({ start: at, end: at, text: `,${sepWs}${render(sepWs, kv, indent)}` });
  }
  return edits;
}

// An object { key: "value" } written the way the members around it are: on its own lines when
// they are (sepWs holds a line break), else on one line.
const objectText = (key, value, fmt) => (sepWs, indent, kv) => {
  const k = JSON.stringify(key);
  const v = JSON.stringify(value);
  if (!sepWs.includes('\n')) return `{${sepWs}${k}${kv}${v}${sepWs}}`;
  const eol = sepWs.includes('\r\n') ? '\r\n' : fmt.eol;
  return `{${eol}${indent}${fmt.indent || '  '}${k}${kv}${v}${eol}${indent}}`;
};

// A canonical text of a JSON value (keys sorted): what "the same settings" compares.
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// settings.json with the plugin dirs entry set (dirs: the new value; null: the key taken out, and
// "env" with it when nothing else is in it) and the hooks of plan (legacyHookPlan) taken out.
// expected: the settings object the result must parse to. -> the new body | { error }
export function patchSettings(body, { dirs, removeDirs = false, plan = null, expected }) {
  const blank = body.trim() === '';
  const text = blank ? '{}\n' : body;
  const fmt = settingsFormat(body);
  const root = jsonSpans(text);
  const edits = [];
  const rootGone = new Set();
  let rootAdd = null;
  // the entry
  const env = memberOf(root, 'env');
  if (dirs != null) {
    const cur = env && memberOf(env.value, PLUGIN_DIRS_VAR);
    if (cur) edits.push({ start: cur.value.start, end: cur.value.end, text: JSON.stringify(dirs) });
    else if (env) edits.push(...listEdits(text, env.value, new Set(), fmt, [PLUGIN_DIRS_VAR, () => JSON.stringify(dirs)]));
    else rootAdd = ['env', objectText(PLUGIN_DIRS_VAR, dirs, fmt)];
  } else if (removeDirs && env) {
    const members = env.value.members;
    const at = members.lastIndexOf(memberOf(env.value, PLUGIN_DIRS_VAR));
    if (at !== -1) {
      if (members.every((m, k) => k === at || m.key === PLUGIN_DIRS_VAR)) rootGone.add(root.members.lastIndexOf(env));
      else edits.push(...listEdits(text, env.value, new Set([at]), fmt));
    }
  }
  // the hooks
  if (plan && plan.events.length) {
    const hooks = memberOf(root, 'hooks');
    if (plan.all) rootGone.add(root.members.lastIndexOf(hooks));
    else {
      const goneEvents = new Set();
      for (const ev of plan.events) {
        const m = memberOf(hooks.value, ev.event);
        if (ev.all) { goneEvents.add(hooks.value.members.lastIndexOf(m)); continue; }
        const goneGroups = new Set();
        for (const g of ev.groups) {
          if (g.all) { goneGroups.add(g.index); continue; }
          const gh = memberOf(m.value.items[g.index], 'hooks');
          edits.push(...listEdits(text, gh.value, new Set(g.hooks), fmt));
        }
        if (goneGroups.size) edits.push(...listEdits(text, m.value, goneGroups, fmt));
      }
      if (goneEvents.size) edits.push(...listEdits(text, hooks.value, goneEvents, fmt));
    }
  }
  if (rootGone.size || rootAdd) edits.push(...listEdits(text, root, rootGone, fmt, rootAdd));
  // from the end, a removal before an insertion at the same place
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  let parsed;
  try { parsed = JSON.parse(out); } catch { parsed = undefined; }
  if (canon(parsed) !== canon(expected)) return { error: 'it cannot be edited without changing something else in it (a key it must change is written twice?)' };
  return out;
}

// Splits a command line the way a shell would split its words (quotes removed, nothing else
// interpreted): enough to see which file a hook runs.
function words(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
const INTERPRETER = /^(node|nodejs|pwsh|powershell|bash|sh)(\.exe)?$/i;

// Which script of an earlier install this settings hook command runs: a path relative to the
// config dir (one of LEGACY_SETTINGS_HOOK_SCRIPTS), 'plugin' (the plugin's own, through
// ${CLAUDE_PLUGIN_ROOT}), or null when it is not one of theirs. Only a command made of an
// interpreter, its flags, and exactly that script, nothing after it.
export function legacyHookScript(command, claudeDir, platform = process.platform) {
  if (typeof command !== 'string') return null;
  const w = words(command.trim());
  if (w.length < 1) return null;
  const script = w[w.length - 1];
  const head = w.slice(0, -1);
  if (head.length) {
    if (!INTERPRETER.test(basename(head[0].replaceAll('\\', '/')))) return null;
    if (!head.slice(1).every((x) => /^-/.test(x) || /^(bypass|unrestricted)$/i.test(x))) return null;
  }
  const plugin = /^\$\{CLAUDE_PLUGIN_ROOT\}[\\/]+(.+)$/.exec(script);
  if (plugin) return LEGACY_PLUGIN_HOOK_SCRIPTS.includes(plugin[1].replaceAll('\\', '/').replace(/\/{2,}/g, '/')) ? 'plugin' : null;
  if (!/^([A-Za-z]:)?[\\/]/.test(script)) return null; // a 1.x/2.x install wrote absolute paths
  const target = normPath(script, platform);
  return LEGACY_SETTINGS_HOOK_SCRIPTS.find((rel) => normPath(join(claudeDir, rel), platform) === target) || null;
}
export function isLegacyHookCommand(command, claudeDir, platform = process.platform) {
  return legacyHookScript(command, claudeDir, platform) !== null;
}

// The settings hooks of earlier manual installs to take out: those that run one of their scripts
// (legacyHookScript) and, for a script under the config dir, only while removable(rel) says that
// file is theirs (absent, or a copy of a release): a hook that runs a script the user changed
// stays, in kept. A matcher group left with no hook goes, an event left with no group goes, and
// "hooks" left empty goes: only when this removal emptied them (what the user had empty stays).
//   -> { events: [{ event, all, groups: [{ index, all, hooks: [i...] }] }], all, removed, kept: [command...] }
export function legacyHookPlan(settings, claudeDir, { platform = process.platform, removable = () => true } = {}) {
  const plan = { events: [], all: false, removed: 0, kept: [] };
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return plan;
  const names = Object.keys(hooks);
  for (const event of names) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const ev = { event, all: false, groups: [] };
    groups.forEach((g, index) => {
      if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) return;
      const gone = [];
      g.hooks.forEach((h, k) => {
        const rel = h ? legacyHookScript(h.command, claudeDir, platform) : null;
        if (!rel) return;
        if (rel === 'plugin' || removable(rel)) gone.push(k); else plan.kept.push(h.command);
      });
      if (gone.length) ev.groups.push({ index, all: gone.length === g.hooks.length, hooks: gone });
    });
    if (!ev.groups.length) continue;
    ev.all = ev.groups.length === groups.length && ev.groups.every((g) => g.all);
    plan.removed += ev.groups.reduce((n, g) => n + g.hooks.length, 0);
    plan.events.push(ev);
  }
  plan.all = plan.removed > 0 && plan.events.length === names.length && plan.events.every((e) => e.all);
  return plan;
}
// The plan applied to the settings object. -> the number of hooks removed
export function applyHookPlan(settings, plan) {
  for (const ev of plan.events) {
    if (ev.all) { delete settings.hooks[ev.event]; continue; }
    const groups = settings.hooks[ev.event];
    const goneGroups = new Set(ev.groups.filter((g) => g.all).map((g) => g.index));
    for (const g of ev.groups.filter((x) => !x.all)) {
      const drop = new Set(g.hooks);
      groups[g.index] = { ...groups[g.index], hooks: groups[g.index].hooks.filter((_, k) => !drop.has(k)) };
    }
    settings.hooks[ev.event] = groups.filter((_, k) => !goneGroups.has(k));
  }
  if (plan.all) delete settings.hooks;
  return plan.removed;
}
// Both at once (what the tests of the rules use). -> the number of hooks removed
export function stripLegacyHooks(settings, claudeDir, platform = process.platform, opts = {}) {
  return applyHookPlan(settings, legacyHookPlan(settings, claudeDir, { platform, ...opts }));
}

// Do two entries name the same folder? As strings (case-blind on Windows), or, when both exist,
// by their real paths: an 8.3 name, a junction, a subst drive, a symlink are the same folder.
export function samePlace(a, b, platform = process.platform) {
  if (sameDir(a, b, platform)) return true;
  try { return normPath(realpathSync.native(a), platform) === normPath(realpathSync.native(b), platform); } catch { return false; }
}

// The list in env.CLAUDE_CODE_PLUGIN_DIRS with this directory added (install) or taken out
// (uninstall, every entry that is that folder): the rest of the value is kept as written, its
// other entries, their order and their spacing. The key, and "env", go when the uninstall
// empties them. -> { changed, entries, value } (value: the new text, null when the key goes)
export function setPluginDir(settings, dir, { add, sep = delimiter, platform = process.platform, same = samePlace } = {}) {
  const env = settings.env && typeof settings.env === 'object' ? settings.env : null;
  const raw = env && typeof env[PLUGIN_DIRS_VAR] === 'string' ? env[PLUGIN_DIRS_VAR] : '';
  const parts = raw.split(sep);
  const ours = (x) => x.trim() !== '' && same(x.trim(), dir, platform);
  const entries = parts.map((x) => x.trim()).filter(Boolean);
  const present = parts.some(ours);
  // already there (install) or already gone (uninstall): the value is left exactly as it is
  if (add ? present : !present) return { changed: false, entries, value: raw };
  let value;
  if (add) value = raw.trim() === '' ? dir.replaceAll('\\', '/') : `${raw}${sep}${dir.replaceAll('\\', '/')}`;
  else {
    const left = parts.filter((x) => !ours(x));
    value = left.some((x) => x.trim() !== '') ? left.join(sep) : null;
  }
  if (value != null) {
    settings.env = { ...(env || {}), [PLUGIN_DIRS_VAR]: value };
  } else {
    delete env[PLUGIN_DIRS_VAR];
    if (Object.keys(env).length === 0) delete settings.env;
  }
  return { changed: true, entries: value == null ? [] : value.split(sep).map((x) => x.trim()).filter(Boolean), value };
}


// The marketplace copy of the plugin, enabled too: two mods would drive the loop.
export function marketplaceCopies(settings) {
  const e = settings.enabledPlugins;
  if (!e || typeof e !== 'object') return [];
  return Object.keys(e).filter((k) => /^perseveranza@/.test(k) && e[k] === true);
}

// ---------------------------------------------------------------- what earlier installs copied

const KNOWN = new Map(Object.entries(LEGACY_HASHES.files).map(([k, v]) => [k, new Set(v)]));
const KNOWN_COMMANDS = new Map(Object.entries(LEGACY_HASHES.commands).map(([k, v]) => [k, new Set(v)]));

// Is buf, found at key (a path under the config dir: 'hooks/x.mjs', 'agents/pf-x.md',
// 'perseveranza/<rel>'), byte for byte a file a past release copied there?
export function isLegacyCopy(key, buf) {
  const set = KNOWN.get(key);
  return !!set && set.has(sha256(buf));
}

// Is this text of <claude dir>/commands/perseveranza.md the one an earlier installer wrote? Each
// one wrote the plugin's command verbatim, or with a path of that install in place of
// ${CLAUDE_PLUGIN_ROOT}/scripts/<1.x CLI> (1.x) or ${CLAUDE_PLUGIN_ROOT} (2.x): that path is put
// back, and the result must be exactly a command of a release (sha256).
export function isOldCommand(text, claudeDir, platform = process.platform) {
  if (typeof text !== 'string') return false;
  const c = resolve(claudeDir).replaceAll('\\', '/').replace(/\/+$/, '');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const swap = (from, to) => text.replace(new RegExp(esc(from), platform === 'win32' ? 'gi' : 'g'), () => to);
  const forms = [['verbatim', text]];
  const v1 = swap(`${c}/hooks/${LEGACY_V1_CLI_FILE}`, `\${CLAUDE_PLUGIN_ROOT}/scripts/${LEGACY_V1_CLI_FILE}`);
  if (v1 !== text) forms.push(['v1-cli', v1]);
  const v2 = swap(`${c}/${INSTALL_DIRNAME}`, '${CLAUDE_PLUGIN_ROOT}');
  if (v2 !== text) forms.push(['v2-root', v2]);
  return forms.some(([form, t]) => KNOWN_COMMANDS.get(form)?.has(sha256(Buffer.from(t, 'utf8'))));
}

// What earlier installs left in <claude dir>/hooks, /agents and /commands:
//   { remove: [path] exact copies of a release, keep: [path] the same names, other contents }
export function legacyLeftovers(claudeDir, platform = process.platform) {
  const remove = [];
  const keep = [];
  // a folder (hooks, agents, commands) that is a link or a junction, or whose real path leaves the
  // config dir: what is in it belongs somewhere else (a dotfiles repository): nothing removed there
  const links = [];
  const outside = new Map();
  const realClaude = (() => { try { return normPath(realpathSync.native(claudeDir), platform); } catch { return normPath(claudeDir, platform); } })();
  const elsewhere = (sub) => {
    if (outside.has(sub)) return outside.get(sub);
    const dir = join(claudeDir, sub);
    let target = null;
    try {
      const st = lstatSync(dir);
      const real = normPath(realpathSync.native(dir), platform);
      if (st.isSymbolicLink() || !real.startsWith(`${realClaude}/`)) target = realpathSync.native(dir);
    } catch { /* absent */ }
    if (target) links.push({ dir, target });
    outside.set(sub, !!target);
    return !!target;
  };
  const look = (p, isOld) => {
    if (elsewhere(relative(claudeDir, dirname(p)))) return;
    let st;
    try { st = lstatSync(p); } catch { return; }
    let old = false;
    if (st.isFile()) { try { old = isOld(readFileSync(p)); } catch { /* unreadable: kept */ } }
    (old ? remove : keep).push(p);
  };
  for (const key of KNOWN.keys()) {
    if (!/^(hooks|agents)\/[^/]+$/.test(key)) continue;
    look(join(claudeDir, ...key.split('/')), (buf) => isLegacyCopy(key, buf));
  }
  for (const cmd of COMMAND_FILES) look(join(claudeDir, 'commands', basename(cmd)), (buf) => isOldCommand(buf.toString('utf8'), claudeDir, platform));
  return { remove, keep, links };
}

// ---------------------------------------------------------------- the install directory

// Files Claude Code itself writes into a plugin directory it loads (the type declarations, and a
// tsconfig.json at the root that extends them): removed with an install it recognizes.
export function isGenerated(rel, dir) {
  if (rel.startsWith('.claude-plugin/types/')) return true;
  if (rel !== 'tsconfig.json') return false;
  try { return JSON.parse(readFileSync(join(dir, rel), 'utf8')).extends === './.claude-plugin/types/tsconfig.json'; } catch { return false; }
}
// The files this installer writes beside the plugin's while it works (removed with the folder).
const isWorkFile = (rel) => rel === SENTINEL || rel === MARKER_TMP;

// Every file under dir (relative, '/'), symlinks included as files, never followed.
function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p); else out.push(relative(dir, p).split(pathSep).join('/'));
    }
  };
  walk(dir);
  return out;
}

const fileHash = (p) => { try { const st = lstatSync(p); return st.isFile() ? sha256(readFileSync(p)) : null; } catch { return null; } };

// The marker of an install directory: { plugin, version, settings?, files: [[rel, size, sha256]...] } | null
export function readMarker(dir) {
  try {
    const m = JSON.parse(readFileSync(join(dir, MARKER), 'utf8'));
    if (!m || m.plugin !== PLUGIN_NAME || !Array.isArray(m.files) || !m.files.length) return null;
    if (!m.files.every((f) => Array.isArray(f) && typeof f[0] === 'string' && Number.isInteger(f[1]) && /^[0-9a-f]{64}$/.test(f[2]) && !f[0].split('/').includes('..') && !/^([A-Za-z]:|\/)/.test(f[0]))) return null;
    return m;
  } catch { return null; }
}

// Is the file at dir/rel the one the marker lists (size and hash)?
function intact(dir, [rel, size, hash]) {
  try {
    const p = join(dir, rel);
    const st = lstatSync(p);
    return st.isFile() && st.size === size && sha256(readFileSync(p)) === hash;
  } catch { return false; }
}

// The hashes of this checkout's files (a folder without a marker may hold them: accepted too).
let srcHashes = null;
function sourceHash(src, rel) {
  if (!src || !ALL_FILES.includes(rel)) return null;
  if (!srcHashes) srcHashes = new Map();
  if (!srcHashes.has(rel)) srcHashes.set(rel, fileHash(join(src, rel)));
  return srcHashes.get(rel);
}

// What a directory at the install path is, before anything touches it:
//   { kind: 'none' } nothing there
//   { kind: 'ours', marker, foreign: [...] } our install (foreign: files it did not install, or
//      changed since: never removed)
//   { kind: 'legacy', known: Map<rel, sha256> } no marker, and every file in it an exact copy of
//      a file of a release (2.x, or this one): replaceable
//   { kind: 'refuse', why, unknown? } anything else: never touched
export function inspectInstall(dir, src) {
  let st;
  try { st = lstatSync(dir); } catch { return { kind: 'none' }; }
  if (st.isSymbolicLink()) return { kind: 'refuse', why: 'it is a symbolic link or a junction (it points somewhere else, which is not removed or replaced)' };
  if (!st.isDirectory()) return { kind: 'refuse', why: 'it is not a directory' };
  if (src && normPath(realOr(dir)) === normPath(realOr(src))) return { kind: 'refuse', why: 'it is the checkout this installer runs from' };
  if (existsSync(join(dir, '.git'))) return { kind: 'refuse', why: 'it is a git repository (a checkout, not an install)' };
  let files;
  try { files = listFiles(dir); } catch (e) { return { kind: 'refuse', why: `it cannot be read (${e.code || e.message})` }; }
  const hasMarker = files.includes(MARKER);
  const marker = hasMarker ? readMarker(dir) : null;
  if (hasMarker && !marker) return { kind: 'refuse', why: `its ${MARKER} is not one this installer wrote (unreadable, corrupt, or another plugin's)` };
  if (marker) {
    const listed = new Map(marker.files.map((f) => [f[0], f]));
    const foreign = files.filter((rel) => rel !== MARKER && !isWorkFile(rel) && !isGenerated(rel, dir) && !(listed.has(rel) && intact(dir, listed.get(rel))));
    return { kind: 'ours', marker, foreign };
  }
  // no marker: replaceable only when every file is byte for byte one a release put there
  const known = new Map();
  const unknown = [];
  const generated = [];
  for (const rel of files) {
    if (isWorkFile(rel)) continue;
    if (isGenerated(rel, dir)) { generated.push(rel); continue; }
    const h = fileHash(join(dir, rel));
    if (h && (KNOWN.get(`${INSTALL_DIRNAME}/${rel}`)?.has(h) || h === sourceHash(src, rel))) known.set(rel, h);
    else unknown.push(rel);
  }
  if (unknown.length) {
    return { kind: 'refuse', unknown, why: `it has no install marker and holds files that are not an exact copy of a perseveranza release, so they may be yours: ${list(unknown)}` };
  }
  if (generated.length && !known.size) return { kind: 'refuse', unknown: generated, why: `it has no install marker and holds no file of a release (only ${list(generated)})` };
  return { kind: 'legacy', known };
}

// Removes the files of an install and every directory left empty; never anything else: what the
// marker lists and is still as written (any listed file, with trustListed: a copy being built,
// whose files may be half written), or for a folder without a marker the files whose hash was
// recognized; what Claude Code generated and this installer's work files. The marker goes last:
// a removal cut short still leaves a folder recognizably ours. unlink is a parameter for the
// tests. -> the files left
export function removeInstall(dir, info, { trustListed = false, unlink = unlinkSync } = {}) {
  let files = [];
  try { files = listFiles(dir); } catch { return []; }
  const listed = info.kind === 'ours' ? new Map(info.marker.files.map((f) => [f[0], f])) : new Map();
  const mine = (rel) => {
    if (isWorkFile(rel) || isGenerated(rel, dir)) return true;
    if (info.kind === 'ours') return rel === MARKER || (listed.has(rel) && (trustListed || intact(dir, listed.get(rel))));
    if (info.kind === 'legacy') return info.known.has(rel) && fileHash(join(dir, rel)) === info.known.get(rel);
    return false;
  };
  const doomed = files.filter(mine);
  // the empty directories, deepest first
  const prune = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (lstatSync(p).isDirectory()) prune(p);
    }
    if (d !== dir && readdirSync(d).length === 0) rmdirSync(d);
  };
  // the marker, then the sentinel, last, after the directories they leave empty: a removal cut
  // short leaves a folder that is still recognizably ours (a leftover of a run is recognized by
  // its sentinel, its files by the marker)
  const last = [MARKER, SENTINEL];
  let failed = 0;
  for (const rel of doomed.filter((x) => !last.includes(x))) {
    try { unlink(join(dir, rel)); } catch { failed++; /* left, reported below */ }
  }
  try { prune(dir); } catch { /* best effort */ }
  // a file of ours that could not be removed: the marker and the sentinel stay, so the next run
  // still knows the folder and finishes the removal
  if (!failed) {
    for (const rel of last.filter((x) => doomed.includes(x))) {
      // the sentinel only once the marker is gone
      try { unlink(join(dir, rel)); } catch { break; }
    }
  }
  let left = [];
  try { left = listFiles(dir); } catch { return []; }
  if (!left.length) { try { rmdirSync(dir); } catch { /* reported by the caller if it matters */ } }
  return left;
}

// The marker for the files of this checkout: [[rel, size, sha256]...]
function plannedFiles(src) {
  return ALL_FILES.map((rel) => { const buf = readFileSync(join(src, rel)); return [rel, buf.length, sha256(buf)]; });
}
const sameFiles = (a, b) => a.length === b.length && JSON.stringify([...a].sort((x, y) => (x[0] < y[0] ? -1 : 1))) === JSON.stringify([...b].sort((x, y) => (x[0] < y[0] ? -1 : 1)));

// ---- the folders a run makes beside the install: <install>.tmp-<ms>-<pid>-<nonce> (a copy being
// built) and <install>.old-<ms>-<pid>-<nonce> (the previous copy, renamed away). The first thing
// written into each is SENTINEL, with the same kind, time, pid and nonce: a folder is a leftover
// of a run only when its name and its sentinel agree and that process is gone.
const LEFTOVER_RE = new RegExp(`^${INSTALL_DIRNAME}\\.(tmp|old)-(\\d+)-(\\d+)-([0-9a-f]{16})$`);
export function workDir(installDir, kind) {
  const s = { installer: PLUGIN_NAME, kind, at: Date.now(), pid: process.pid, nonce: nonce() };
  return { path: `${installDir}.${kind}-${s.at}-${s.pid}-${s.nonce}`, sentinel: s };
}
function writeSentinel(dir, s) { writeFileSync(join(dir, SENTINEL), JSON.stringify(s)); }
function dropSentinel(dir) { try { unlinkSync(join(dir, SENTINEL)); } catch { /* not there */ } }
// -> { kind, at } when claudeDir/name is a leftover of a run of this installer, else { why }
export function leftoverOf(claudeDir, name, isAlive = alive) {
  const m = LEFTOVER_RE.exec(name);
  if (!m) return { why: 'its name is not one this installer gives' };
  let s = null;
  try { s = JSON.parse(readFileSync(join(claudeDir, name, SENTINEL), 'utf8')); } catch { /* none */ }
  // a run killed between making the folder and writing its sentinel (or after removing it, while
  // it removed the empty directories) leaves no file in it: such a folder holds nothing to lose,
  // so its name and a dead pid are enough to remove it
  if (!s) {
    let empty = false;
    // (or killed while writing the sentinel: that file alone, empty or cut short)
    try { empty = lstatSync(join(claudeDir, name)).isDirectory() && listFiles(join(claudeDir, name)).every((rel) => rel === SENTINEL); } catch { /* not a folder */ }
    if (empty && !isAlive(Number(m[3]))) return { kind: m[1], at: Number(m[2]), empty: true };
  }
  if (!s || s.installer !== PLUGIN_NAME || s.kind !== m[1] || String(s.at) !== m[2] || String(s.pid) !== m[3] || s.nonce !== m[4]) return { why: `it holds no ${SENTINEL} of this installer matching its name` };
  if (isAlive(s.pid)) return { why: `the run that made it (pid ${s.pid}) is still going` };
  return { kind: m[1], at: Number(m[2]) };
}

// Builds the copy aside (the sentinel, then the marker, then the files: a copy cut short is
// recognizable), then checks every file against the marker as read back from the disk: a copy
// that does not match is never swapped in. copy is a parameter for the tests. -> the staging dir
export function buildStaging(src, staging, { version = '', settings, sentinel } = {}, copy = copyFileSync) {
  mkdirSync(staging);
  if (sentinel) writeSentinel(staging, sentinel);
  const files = plannedFiles(src);
  const marker = { plugin: PLUGIN_NAME, version, installedAt: new Date().toISOString(), ...(settings ? { settings } : {}), files };
  writeFileSync(join(staging, MARKER_TMP), JSON.stringify(marker, null, 1));
  renameSync(join(staging, MARKER_TMP), join(staging, MARKER));
  for (const [rel] of files) {
    const dest = join(staging, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copy(join(src, rel), dest);
  }
  const written = readMarker(staging);
  if (!written || !sameFiles(written.files, files)) throw new Error('the marker written does not list the files of the checkout');
  const bad = written.files.filter((f) => !intact(staging, f));
  if (bad.length) throw new Error(`the copy does not match the checkout: ${list(bad.map((f) => f[0]), 3)}`);
  return staging;
}

// The new copy in place of the old one: the old one renamed away (its sentinel written first),
// the new one renamed in; if the second rename fails the old one goes back (else the next run
// restores it). rename is a parameter for the tests. Throws what the failed rename threw.
export function swapIn({ installDir, staging, oldAway, hadOld, oldSentinel }, rename = renameSync) {
  if (hadOld) {
    if (oldSentinel) writeSentinel(installDir, oldSentinel);
    try { rename(installDir, oldAway); } catch (e) { if (oldSentinel) dropSentinel(installDir); throw e; }
  }
  try { rename(staging, installDir); } catch (e) {
    if (hadOld) { try { rename(oldAway, installDir); if (oldSentinel) dropSentinel(installDir); } catch { /* the next run restores it */ } }
    throw e;
  }
  dropSentinel(installDir);
}

// The leftovers of a run killed half way (see leftoverOf). If the install itself is missing, the
// newest old copy that is complete goes back in place (settings.json may list it); the other
// leftovers lose what this installer wrote into them. A settings.json being written when the run
// was killed (its temporary file, named with that run's pid and nonce) goes too. Whatever is not
// recognizably a leftover of this installer is only named. -> lines to print
export function recoverLeftovers(claudeDir, installDir, src, { settingsFiles = [join(claudeDir, 'settings.json')], isAlive = alive } = {}) {
  const notes = [];
  for (const f of new Set(settingsFiles)) {
    const d = dirname(f);
    let names = [];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
      const m = /^(.+)\.tmp-perseveranza-(\d+)-[0-9a-f]{16}$/.exec(n);
      if (!m || m[1] !== basename(f) || isAlive(Number(m[2]))) continue;
      try { if (lstatSync(join(d, n)).isFile()) { unlinkSync(join(d, n)); notes.push(`Removed the leftover ${join(d, n)} (a settings.json being written by a run that was killed).`); } } catch { /* the next run */ }
    }
  }
  let names = [];
  try { names = readdirSync(claudeDir); } catch { return notes; }
  const candidates = names.filter((n) => n.startsWith(`${INSTALL_DIRNAME}.tmp-`) || n.startsWith(`${INSTALL_DIRNAME}.old-`));
  const ours = [];
  for (const n of candidates) {
    const r = leftoverOf(claudeDir, n, isAlive);
    if (r.why) notes.push(`Left alone: ${join(claudeDir, n)} (${r.why}). If it is a copy you no longer need, remove it yourself.`);
    else ours.push({ n, ...r });
  }
  ours.sort((a, b) => b.at - a.at); // newest first
  if (!existsSync(installDir)) {
    for (const o of ours.filter((x) => x.kind === 'old')) {
      const p = join(claudeDir, o.n);
      const info = inspectInstall(p, src);
      const complete = (info.kind === 'ours' && !info.foreign.length && info.marker.files.every((f) => intact(p, f))) || (info.kind === 'legacy' && info.known.size > 0);
      if (!complete) continue;
      try { renameSync(p, installDir); dropSentinel(installDir); o.restored = true; notes.push(`Restored ${installDir} from ${o.n} (a run was interrupted).`); break; } catch { /* left as is */ }
    }
  }
  for (const o of ours) {
    if (o.restored) continue;
    const p = join(claudeDir, o.n);
    if (o.empty) {
      // only directories in it, or a sentinel never completed: removeInstall takes that file
      // (a work file of this installer) and prunes the directories, then the folder
      const rest = removeInstall(p, { kind: 'legacy', known: new Map() });
      notes.push(rest.length || existsSync(p) ? `Left ${p}: it is not empty any more.` : `Removed the empty leftover ${p}.`);
      continue;
    }
    const info = inspectInstall(p, src);
    if (info.kind !== 'ours' && info.kind !== 'legacy') { notes.push(`Left alone: ${p} (${info.why}).`); continue; }
    const rest = removeInstall(p, info, { trustListed: o.kind === 'tmp' });
    notes.push(rest.length ? `Left ${p}: it holds files this installer did not write, or changed since (${list(rest, 3)}); remove it yourself.` : `Removed the leftover ${p}.`);
  }
  return notes;
}

// ---------------------------------------------------------------- the lock

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// The owner of a lock, or null when it has none or one that is not a valid owner (unreadable,
// not JSON, too large, a pid or a time that is not a number): such a lock is treated like one
// whose owner was never written, stale once it is a few seconds old.
function readOwner(lock) {
  try {
    const p = join(lock, LOCK_OWNER);
    if (statSync(p).size > 4096) return null;
    const o = JSON.parse(readFileSync(p, 'utf8'));
    if (!o || typeof o !== 'object' || !Number.isInteger(o.pid) || o.pid <= 0 || !Number.isFinite(o.at) || o.at > Date.now() + 86400000 || typeof o.nonce !== 'string') return null;
    return o;
  } catch { return null; }
}
// Is the lock held by nobody any more? Its owner's process is gone (on this machine); or, since a
// pid can be reused, it is older than staleMs (a run takes seconds); or it never got its owner
// file (a run killed between the two steps) and is older than a few seconds.
function lockStale(lock, owner, { staleMs, isAlive }) {
  let age = 0;
  try { age = Date.now() - statSync(lock).mtimeMs; } catch { return false; }
  if (!owner) return age > 3000;
  if (typeof owner.at === 'number' && Date.now() - owner.at > staleMs) return true;
  if (owner.host && owner.host !== hostname()) return false;
  return !isAlive(owner.pid);
}

// Takes <claude dir>/.perseveranza-install.lock: a directory, made atomically (mkdir fails when it
// is there), with owner.json { pid, host, at, nonce }. A held lock is waited for (waitMs), then
// the run gives up saying what to do; a stale one is renamed away (only if it is still the one
// found stale) and removed. -> release(), which removes it only while it is still this run's.
export function acquireLock(claudeDir, { waitMs = 10000, pollMs = 100, staleMs = 5 * 60 * 1000, isAlive = alive } = {}) {
  const lock = join(claudeDir, LOCK_NAME);
  const me = { pid: process.pid, host: hostname(), at: Date.now(), nonce: nonce() };
  const deadline = Date.now() + waitMs;
  for (;;) {
    let made = false;
    try { mkdirSync(lock); made = true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (made) {
      try { writeFileSync(join(lock, LOCK_OWNER), JSON.stringify({ ...me, at: Date.now() })); } catch (e) { try { rmdirSync(lock); } catch { /* stale later */ } throw e; }
      // a stale lock a run renamed away and was killed before removing: nothing but its owner file
      for (const n of (() => { try { return readdirSync(claudeDir); } catch { return []; } })()) {
        if (!/^\.perseveranza-install\.lock\.stale-[0-9a-f]{16}$/.test(n)) continue;
        try {
          const p = join(claudeDir, n);
          const inside = readdirSync(p);
          if (!inside.every((f) => f === LOCK_OWNER)) continue;
          if (inside.length) unlinkSync(join(p, LOCK_OWNER));
          rmdirSync(p);
        } catch { /* left: harmless */ }
      }
      return () => {
        const o = readOwner(lock);
        if (!o || o.nonce !== me.nonce) return;
        try { unlinkSync(join(lock, LOCK_OWNER)); rmdirSync(lock); } catch { /* taken over as stale by the next run */ }
      };
    }
    const owner = readOwner(lock);
    if (lockStale(lock, owner, { staleMs, isAlive })) {
      const away = `${lock}.stale-${me.nonce}`;
      let moved = false;
      try { renameSync(lock, away); moved = true; } catch { /* someone else took it: try again */ }
      if (moved) {
        const o = readOwner(away);
        if ((o && o.nonce) !== (owner && owner.nonce)) {
          // not the one found stale: a run took it meanwhile, it goes back
          try { renameSync(away, lock); } catch { /* that run has already made a new one */ }
        } else {
          try { unlinkSync(join(away, LOCK_OWNER)); } catch { /* none */ }
          try { rmdirSync(away); } catch { /* left: harmless, never read */ }
        }
        continue;
      }
      // not moved (another run took it first, or the system holds it): wait like for a held one
    }
    if (Date.now() >= deadline) {
      const since = (() => { try { return `, since ${new Date(owner.at).toISOString()}`; } catch { return ''; } })();
      const who = owner ? `pid ${owner.pid}${typeof owner.host === 'string' ? ` on ${owner.host}` : ''}${since}` : 'a run that has not written its owner yet, or an owner file that is not valid';
      const err = new Error(`another install.mjs is running on ${claudeDir} (${who}). Wait for it to finish and run install.mjs again; if no install is running, remove ${lock} yourself.`);
      err.code = 'ELOCKED';
      throw err;
    }
    sleep(pollMs);
  }
}

// ---------------------------------------------------------------- settings.json

// The file settings.json really is: through a symlink (dotfiles), the file it points at.
// A link to a file that does not exist answers that file's path (never the link itself, which
// a write would replace with a plain file).
export function settingsTarget(settingsPath) {
  let link = false;
  try { link = lstatSync(settingsPath).isSymbolicLink(); } catch { /* absent: itself */ }
  if (!link) return settingsPath;
  try { return realpathSync(settingsPath); } catch { /* dangling */ }
  try { return resolve(dirname(settingsPath), readlinkSync(settingsPath)); } catch { return `${settingsPath} (an unreadable link)`; }
}

// Writes text over target atomically (a temporary file in the same folder, named with this
// run's pid and a nonce, renamed over it), keeping the mode the file had. The fs functions are a
// parameter for the tests.
export function writeAtomic(target, text, mode, fs = { writeFileSync, chmodSync, renameSync, unlinkSync }) {
  const tmp = `${target}.tmp-perseveranza-${process.pid}-${nonce()}`;
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx', ...(mode == null ? {} : { mode }) });
    if (mode != null) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* not made */ }
    throw e;
  }
}

// The original settings.json, kept once: never written over, nor through, anything already at
// that name (a file, a folder, a link, even a dangling one). -> the path written, or null
export function backupOnce(backup, original, mode) {
  try { lstatSync(backup); return null; } catch (e) { if (e.code !== 'ENOENT') return null; }
  try { writeFileSync(backup, original, { flag: 'wx', ...(mode == null ? {} : { mode }) }); return backup; } catch (e) { if (e.code === 'EEXIST') return null; throw e; }
}

// ---------------------------------------------------------------- the run

function main(argv) {
  const src = dirname(fileURLToPath(import.meta.url));
  const known = new Set(['--uninstall', '--claude-dir', '--help', '-h']);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--claude-dir') { i++; continue; }
    if (!known.has(argv[i])) { console.error(`ERROR: unknown argument "${argv[i]}". Usage: node install.mjs [--claude-dir <dir>] [--uninstall]`); return 2; }
  }
  if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: node install.mjs [--claude-dir <dir>] [--uninstall]'); return 0; }
  let claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const dirFlag = argv.indexOf('--claude-dir');
  if (dirFlag !== -1) {
    if (!argv[dirFlag + 1]) { console.error('ERROR: --claude-dir needs a directory.'); return 2; }
    claudeDir = argv[dirFlag + 1];
  }
  claudeDir = resolve(claudeDir);
  const uninstall = argv.includes('--uninstall');
  if (uninstall && !existsSync(claudeDir)) { console.log(`Nothing to uninstall: ${claudeDir} does not exist.`); return 0; }
  // the copy never lands inside the sources it is made from (checked before anything is made)
  const installDir = join(claudeDir, INSTALL_DIRNAME);
  if (!uninstall && normPath(realOr(installDir)).startsWith(normPath(realOr(src)) + '/')) {
    console.error(`ERROR: the install directory ${installDir} is inside this checkout: run install.mjs from another copy, or load this one directly (claude --plugin-dir "${src}").\nNothing was changed.`);
    return 1;
  }
  let release;
  try {
    mkdirSync(claudeDir, { recursive: true });
    release = acquireLock(claudeDir);
  } catch (e) {
    console.error(`ERROR: ${e.code === 'ELOCKED' ? e.message : `the install lock in ${claudeDir} could not be taken (${e.code || e.message})`}\nNothing was changed.`);
    return 1;
  }
  try {
    return run({ src, claudeDir, uninstall });
  } catch (e) {
    console.error(`ERROR: ${e.message}${e.code && !String(e.message).includes(e.code) ? ` (${e.code})` : ''}`);
    return 1;
  } finally {
    release();
  }
}

function run({ src, claudeDir, uninstall }) {
  const installDir = join(claudeDir, INSTALL_DIRNAME);
  const settingsPath = join(claudeDir, 'settings.json');
  const fail = (why) => { console.error(`ERROR: ${why}\nNothing was changed.`); return 1; };
  const target = settingsTarget(settingsPath);

  // --- what a run killed half way left (the run holds the lock: no other one is going) ---
  for (const line of recoverLeftovers(claudeDir, installDir, src, { settingsFiles: [settingsPath, target] })) console.log(line);

  // --- the install directory: ours, or never touched ---
  const info = inspectInstall(installDir, src);
  if (info.kind === 'refuse') {
    return fail(`${installDir} is not a perseveranza install this installer can ${uninstall ? 'remove' : 'replace'}: ${info.why}. Move it elsewhere first (to use a checkout directly: claude --plugin-dir "<checkout>"), then run install.mjs again.`);
  }
  if (!uninstall && info.foreign && info.foreign.length) {
    return fail(`${installDir} holds files this installer did not write, or changed since (${list(info.foreign)}). Move them out of it, then run install.mjs again.`);
  }

  // --- the settings, read and checked before anything is touched ---
  const had = existsSync(target);
  let settings = {};
  let bom = false;
  let mode = null;
  let original = null;
  let body = '';
  if (had) {
    try {
      const st = statSync(target);
      if (st.isDirectory()) return fail(`${settingsPath} is a directory, not a file.`);
      mode = st.mode & 0o7777;
      original = readFileSync(target);
    } catch (e) { return fail(`${settingsPath} cannot be read (${e.code || e.message}).`); }
    const text = original.toString('utf8');
    const p = parseSettings(text);
    if (p.error) return fail(`${settingsPath}: ${p.error}. Fix it and run install.mjs again.`);
    settings = p.settings;
    bom = p.bom;
    body = bom ? text.slice(1) : text;
    // writable? (a read-only file would fail after the copy)
    try { closeSync(openSync(target, 'r+')); } catch (e) { return fail(`${settingsPath} cannot be written (${e.code || e.message}).`); }
  } else if (target !== settingsPath) {
    return fail(`${settingsPath} is a symbolic link to ${target}, which does not exist.`);
  }
  // A settings hook of 1.x/2.x goes only while the script it runs is theirs: gone already, a copy
  // of a release, or a file of the install this run recognizes. One that runs a script the user
  // changed stays, and is named.
  const removable = (rel) => {
    const p = join(claudeDir, ...rel.split('/'));
    let buf;
    try { if (!lstatSync(p).isFile()) return false; buf = readFileSync(p); } catch (e) { return e.code === 'ENOENT'; }
    if (isLegacyCopy(rel, buf)) return true;
    const inInstall = rel.startsWith(`${INSTALL_DIRNAME}/`) ? rel.slice(INSTALL_DIRNAME.length + 1) : null;
    if (inInstall == null) return false;
    if (info.kind === 'legacy') return info.known.has(inInstall);
    return info.kind === 'ours' && info.marker.files.some((f) => f[0] === inInstall) && !info.foreign.includes(inInstall);
  };

  const before = JSON.stringify(settings);
  const plugin = setPluginDir(settings, installDir, { add: !uninstall });
  const plan = legacyHookPlan(settings, claudeDir, { removable });
  const hooksRemoved = applyHookPlan(settings, plan);
  const changed = JSON.stringify(settings) !== before;
  // the new text: the old one with only these changes (checked: it parses to exactly settings)
  let newBody = null;
  if (changed) {
    newBody = patchSettings(body, { dirs: plugin.changed && plugin.value != null ? plugin.value : null, removeDirs: plugin.changed && plugin.value == null, plan, expected: settings });
    if (typeof newBody !== 'string') return fail(`${settingsPath}: ${newBody.error}. Fix it and run install.mjs again${uninstall ? '' : `, or add ${installDir.replaceAll('\\', '/')} to env.${PLUGIN_DIRS_VAR} yourself`}.`);
  }
  // did settings.json exist before the first install? (the marker remembers; a reinstall keeps it)
  const origin = !had ? 'created' : (info.kind === 'ours' && info.marker.settings) || 'existed';

  const writeSettings = () => {
    if (!changed) return;
    if (uninstall && origin === 'created' && target === settingsPath && Object.keys(settings).length === 0) {
      unlinkSync(target);
      console.log(`Removed ${settingsPath}: the install created it and it held only its entry.`);
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    if (had && origin !== 'created') {
      const b = backupOnce(settingsPath + BACKUP_SUFFIX, original, mode);
      if (b) console.log(`Backup of settings.json as it was before perseveranza 3.0 changed it: ${b} (kept, never overwritten)`);
    }
    writeAtomic(target, (bom ? BOM : '') + newBody, mode);
  };
  const sayKeptHooks = () => {
    if (!plan.kept.length) return;
    console.log('Left alone: these settings hooks run a script of perseveranza 1.x/2.x that is not exactly the one it installed (changed since, or yours). If they are leftovers, remove them yourself (/hooks lists them); left in place, they drive the loop a second time:');
    for (const c of plan.kept) console.log(`  ${c}`);
  };
  // what 1.x and 2.x copied outside the install directory: exact copies go, the rest is named
  const cleanLegacy = () => {
    const { remove, keep, links } = legacyLeftovers(claudeDir);
    for (const l of links) console.log(`Left alone: ${l.dir} is a link to ${l.target}: nothing in it is removed (remove the old copies there yourself, if any).`);
    for (const p of remove) {
      try { unlinkSync(p); console.log(`Removed a file of an earlier install (an exact copy of a release): ${p}`); } catch (e) { keep.push(`${p} (${e.code || e.message})`); }
    }
    if (keep.length) {
      console.log('Left alone: these have the name of a file an earlier perseveranza install copied, but not exactly its content (changed since, or yours). If they are leftovers, remove them yourself:');
      for (const p of keep) console.log(`  ${p}`);
    }
  };

  if (uninstall) {
    // the settings first: if they cannot be written, the files stay and the mod keeps loading
    try { writeSettings(); } catch (e) { return fail(`${settingsPath} could not be written (${e.code || e.message}).`); }
    if (plugin.changed) console.log(`Removed from ${PLUGIN_DIRS_VAR} in settings.json: ${installDir}`);
    if (hooksRemoved) console.log(`Removed ${hooksRemoved} settings hook(s) of perseveranza 1.x/2.x from settings.json.`);
    sayKeptHooks();
    const now = inspectInstall(installDir, src);
    if (now.kind === 'ours' || now.kind === 'legacy') {
      let dir = installDir;
      // nothing of the user's inside: renamed away first, so the directory is gone at once
      if (!(now.foreign && now.foreign.length)) {
        const away = workDir(installDir, 'old');
        try { writeSentinel(installDir, away.sentinel); renameSync(installDir, away.path); dir = away.path; } catch { dropSentinel(installDir); }
      }
      const left = removeInstall(dir, now);
      if (left.includes(MARKER) || left.includes(SENTINEL)) {
        console.error(`ERROR: some files of ${dir} could not be removed (${list(left)}). settings.json no longer loads it; run node install.mjs --uninstall again to finish.`);
        return 1;
      }
      if (left.length) console.log(`Removed the files it installed from ${dir}; kept the ones it did not write, or changed since: ${list(left)}. Remove them yourself if you do not need them (a later install refuses a folder that holds them).`);
      else console.log(`Removed: ${installDir}`);
    }
    cleanLegacy();
    console.log('Uninstalled. Restart Claude Code.');
    return 0;
  }

  // --- 1. the plugin directory: built and verified aside, then swapped in ---
  let version = '';
  try { version = JSON.parse(readFileSync(join(src, '.claude-plugin', 'plugin.json'), 'utf8')).version || ''; } catch { /* unknown */ }
  let planned;
  try { planned = plannedFiles(src); } catch (e) {
    console.error(`ERROR: the plugin could not be copied to ${installDir} (a file of this checkout cannot be read: ${e.code || e.message}). settings.json was not changed.`);
    return 1;
  }
  const same = info.kind === 'ours' && !info.foreign.length && info.marker.settings === origin
    && sameFiles(info.marker.files, planned) && listFiles(installDir).every((rel) => rel === MARKER || isGenerated(rel, installDir) || info.marker.files.some((f) => f[0] === rel));
  if (same) {
    console.log(`Already installed and identical: ${installDir} (nothing copied).`);
  } else {
    const staging = workDir(installDir, 'tmp');
    const oldAway = workDir(installDir, 'old');
    try {
      buildStaging(src, staging.path, { version, settings: origin, sentinel: staging.sentinel });
      swapIn({ installDir, staging: staging.path, oldAway: oldAway.path, hadOld: info.kind !== 'none', oldSentinel: oldAway.sentinel });
    } catch (e) {
      try { if (existsSync(staging.path)) { const i = inspectInstall(staging.path, src); if (i.kind === 'ours' || i.kind === 'legacy') removeInstall(staging.path, i, { trustListed: true }); } } catch { /* the next run removes it */ }
      console.error(`ERROR: the plugin could not be copied to ${installDir} (${e.code || e.message}). settings.json was not changed.`);
      return 1;
    }
    console.log(`Plugin copied to ${installDir}.`);
    // --- the previous copy (only what it held of an install goes) ---
    if (info.kind !== 'none' && existsSync(oldAway.path)) {
      const i = inspectInstall(oldAway.path, src);
      const left = i.kind === 'ours' || i.kind === 'legacy' ? removeInstall(oldAway.path, i) : ['?'];
      if (left.length) console.log(`Kept ${oldAway.path}: it holds files this installer did not write (${list(left, 3)}); remove it yourself.`);
    }
  }
  // --- 2. the settings, only now that the copy is complete ---
  try { writeSettings(); } catch (e) {
    console.error(`ERROR: ${settingsPath} could not be written (${e.code || e.message}): the plugin is copied but not loaded. Add ${installDir} to env.${PLUGIN_DIRS_VAR} yourself, or run install.mjs again.`);
    return 1;
  }
  // --- what older installs left ---
  cleanLegacy();
  if (plugin.changed) console.log(`Added to ${PLUGIN_DIRS_VAR} in settings.json: ${installDir.replaceAll('\\', '/')}`);
  else console.log(`settings.json already loads it (${PLUGIN_DIRS_VAR}).`);
  if (hooksRemoved) console.log(`Removed ${hooksRemoved} settings hook(s) of perseveranza 1.x/2.x from settings.json (3.0 is a mod: it registers none).`);
  sayKeptHooks();
  console.log('');
  console.log(`Installed. Restart Claude Code (the CLI, 2.1.287 or later) and use: /perseveranza <task>   or   /pf status`);
  console.log(`  (shell verbs: node "${join(installDir, CLI_ENTRY).replaceAll('\\', '/')}" ...)`);
  console.log('  `claude -p ... --setting-sources project` reads no user settings, so it does not load the mod: add --plugin-dir there.');
  const copies = marketplaceCopies(settings);
  if (copies.length) console.log(`WARNING: ${copies.join(', ')} is enabled too: two copies of the mod would drive the same loop. Uninstall one (claude plugin uninstall ${copies[0]}, or node install.mjs --uninstall).`);
  return 0;
}

// Run as a script? Node loads the main module by its real path, so argv[1] is compared through
// realpath too: `node install.mjs` from a path with a symlink in it (macOS /var, a linked
// checkout) is still a run, never a silent exit 0 that changed nothing.
function isMainModule() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] || '.')).href; } catch { return false; }
}
if (process.argv[1] && isMainModule()) process.exitCode = main(process.argv.slice(2));
