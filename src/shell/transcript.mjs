// Token usage from the Claude Code session transcripts (JSONL), best-effort.
// The Stop payload carries `transcript_path`; assistant entries carry `message.usage`.
// Entries before `sinceIso` (the arm time) are skipped when they have a timestamp.
// One API message is written as several lines (one per content block), all with the same
// `message.id`: input and cache repeat on every line and the output grows up to the last
// one. Each message counts once, with the usage of its last line.
// Returns null when the file is missing/unreadable or holds no usage at all, so the
// budget silently falls back to iterations.
//
// Subagents (reviewers, verifiers, executors) write their own transcripts next to the
// session's: <dir>/<session>.jsonl -> <dir>/<session>/subagents/agent-*.jsonl, each with an
// agent-*.meta.json naming the agent type. They are about half of what a run spends, so the
// budget counts them too. The layout is Claude Code's, not a documented contract: when the
// folder is not there the reading is the main transcript alone, as before, and says so.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { writeAtomic } from './activity.mjs';

const KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'];
const zero = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
const add = (a, b) => { for (const k of KEYS) a[k] += Number(b && b[k]) || 0; return a; };
// the agent kinds kept apart in the breakdown; the rest is summed under "other"
export const MAX_AGENT_KEYS = 12;

// { skipSidechain }: lines a subagent wrote into the main transcript (older layouts) are
// already counted from its own file when that file is read.
export function parseTranscriptUsage(text, sinceIso = null, { skipSidechain = false } = {}) {
  const since = sinceIso ? Date.parse(sinceIso) : NaN;
  const byMessage = new Map();
  const totals = zero();
  let found = 0;
  for (const line of String(text).split('\n')) {
    if (!line.includes('"usage"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const u = e && e.message && e.message.usage;
    if (!u || typeof u !== 'object') continue;
    if (e.type && e.type !== 'assistant') continue;
    if (skipSidechain && e.isSidechain === true) continue;
    if (Number.isFinite(since) && e.timestamp) {
      const t = Date.parse(e.timestamp);
      if (Number.isFinite(t) && t < since) continue;
    }
    const row = {
      inputTokens: Number(u.input_tokens) || 0,
      outputTokens: Number(u.output_tokens) || 0,
      cacheReadTokens: Number(u.cache_read_input_tokens) || 0,
      cacheCreationTokens: Number(u.cache_creation_input_tokens) || 0,
    };
    found += 1;
    const id = typeof e.message.id === 'string' && e.message.id ? e.message.id : null;
    if (id) byMessage.set(id, row); else add(totals, row);
  }
  for (const row of byMessage.values()) add(totals, row);
  return found ? totals : null;
}

export function readTranscriptUsage(path, sinceIso = null, opts = {}) {
  try {
    if (!path || !existsSync(path)) return null;
    return parseTranscriptUsage(readFileSync(path, 'utf8'), sinceIso, opts);
  } catch { return null; }
}

export function subagentsDir(transcriptPath) {
  return join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), 'subagents');
}

function agentTypeOf(file) {
  try {
    const meta = JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    const t = meta && typeof meta.agentType === 'string' ? meta.agentType.trim().slice(0, 80) : '';
    // "main" and "other" are the breakdown's own rows
    return !t ? 'subagent' : t === 'main' || t === 'other' ? `agent:${t}` : t;
  } catch { return 'subagent'; }
}

// -> { files, text }: text is the file as read, so an unchanged cache is not rewritten (the
// gate folder may be synced: every write is an upload, and a file held open delays archive).
function readCache(cachePath, transcriptPath) {
  if (!cachePath) return { files: {}, text: null };
  let text = null;
  try {
    text = readFileSync(cachePath, 'utf8');
    const c = JSON.parse(text);
    return { files: c && typeof c === 'object' && c.transcript === transcriptPath && c.files && typeof c.files === 'object' ? c.files : {}, text };
  } catch { return { files: {}, text }; }
}

// The top agent kinds by spend, the rest folded into "other": a bounded record for state.json.
export function capAgents(byAgent, max = MAX_AGENT_KEYS) {
  const spend = (v) => v.inputTokens + v.outputTokens;
  const rest = Object.entries(byAgent).filter(([k]) => k !== 'main').sort((a, b) => spend(b[1]) - spend(a[1]));
  const out = Object.create(null); // agent kinds are names from a file: no prototype to write into
  out.main = add(zero(), byAgent.main);
  const kept = rest.length <= max - 1 ? rest.length : max - 2; // room for main, and for other when it is needed
  rest.forEach(([k, v], i) => { const key = i < kept ? k : 'other'; out[key] = add(out[key] || zero(), v); });
  return out;
}

// Main transcript + subagent transcripts of the same session, from the arm time on.
// -> { ...totals, source, byAgent, subagents: { files, ...totals }, partial } | null
// cachePath: per-file results keyed by (size, mtime, arm time), so a finished subagent is
// read once in the run, not at every stop. deadline: the hook's time budget; a file not
// read in time keeps its last cached value, and the reading is marked partial.
export function readSessionUsage(transcriptPath, sinceIso = null, { cachePath = null, deadline = Infinity, now = Date.now } = {}) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  const dir = subagentsDir(transcriptPath);
  let files = [];
  try { files = existsSync(dir) ? readdirSync(dir).filter((f) => /^agent-.*\.jsonl$/.test(f)).sort() : null; } catch { files = null; }
  const main = readTranscriptUsage(transcriptPath, sinceIso, { skipSidechain: files != null });
  if (files == null) return main ? { ...main, source: 'transcript', byAgent: { main: { ...main } }, subagents: null, partial: false } : null;

  const since = sinceIso ? Date.parse(sinceIso) : NaN;
  const { files: cache, text: cacheText } = readCache(cachePath, transcriptPath);
  const nextCache = Object.create(null);
  const byAgent = Object.create(null);
  byAgent.main = main ? { ...main } : zero();
  const subs = zero();
  let counted = 0;
  let partial = false;
  for (const name of files) {
    const file = join(dir, name);
    let st;
    try { st = statSync(file); } catch { continue; }
    // written for the last time before the arm: a subagent of an earlier run
    if (Number.isFinite(since) && st.mtimeMs < since) continue;
    const c = Object.hasOwn(cache, name) ? cache[name] : null;
    const hit = c && typeof c === 'object' && c.usage && typeof c.usage === 'object' && typeof c.agent === 'string' ? c : null;
    let entry = hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.since === sinceIso ? hit : null;
    if (!entry && now() < deadline) {
      const usage = readTranscriptUsage(file, sinceIso);
      entry = { size: st.size, mtimeMs: st.mtimeMs, since: sinceIso, agent: agentTypeOf(file), usage: usage || zero() };
    }
    if (!entry) {
      partial = true;
      if (!hit || hit.since !== sinceIso) continue;
      entry = hit; // out of time: the last value read, a lower bound
    }
    nextCache[name] = entry;
    const u = entry.usage;
    if (!KEYS.some((k) => u[k])) continue;
    counted += 1;
    add(subs, u);
    byAgent[entry.agent] = add(byAgent[entry.agent] || zero(), u);
  }
  const nextText = JSON.stringify({ transcript: transcriptPath, files: nextCache });
  if (cachePath && nextText !== cacheText) writeAtomic(cachePath, nextText);
  if (!main && !counted) return null;
  const totals = add(add(zero(), main), subs);
  return { ...totals, source: 'transcript+subagents', byAgent: { ...capAgents(byAgent) }, subagents: { files: counted, ...subs }, partial };
}
