// Token usage from the Claude Code session transcript (JSONL), best-effort.
// The Stop payload carries `transcript_path`; assistant entries carry `message.usage`.
// Entries before `sinceIso` (the arm time) are skipped when they have a timestamp.
// Returns null when the file is missing/unreadable or holds no usage at all, so the
// budget silently falls back to iterations.
import { readFileSync, existsSync } from 'node:fs';

export function parseTranscriptUsage(text, sinceIso = null) {
  const since = sinceIso ? Date.parse(sinceIso) : NaN;
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  let found = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const u = e && e.message && e.message.usage;
    if (!u || typeof u !== 'object') continue;
    if (e.type && e.type !== 'assistant') continue;
    if (Number.isFinite(since) && e.timestamp) {
      const t = Date.parse(e.timestamp);
      if (Number.isFinite(t) && t < since) continue;
    }
    found += 1;
    totals.inputTokens += Number(u.input_tokens) || 0;
    totals.outputTokens += Number(u.output_tokens) || 0;
    totals.cacheReadTokens += Number(u.cache_read_input_tokens) || 0;
    totals.cacheCreationTokens += Number(u.cache_creation_input_tokens) || 0;
  }
  return found ? totals : null;
}

export function readTranscriptUsage(path, sinceIso = null) {
  try {
    if (!path || !existsSync(path)) return null;
    return parseTranscriptUsage(readFileSync(path, 'utf8'), sinceIso);
  } catch { return null; }
}
