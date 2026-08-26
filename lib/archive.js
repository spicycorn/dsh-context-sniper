// dsh-context-sniper: durable, lossless archive store.
//
// Storage layout — ALIGNED with the DSH session directory:
//   `<sessionRoot>/<projectKey(cwd)>/<encodeSegment(sessionId)>/<archiveDir>/<archiveId>.json`
//
// where:
//   - `<sessionRoot>` is `dshHomePath('sessions')` (the same root DSH's
//     `dsh-session-persistence-jsonl` backend uses for `session.jsonl.zstd`).
//   - `<projectKey(cwd)>` and `<encodeSegment(sessionId)>` are computed with
//     the EXACT same algorithms DSH uses (replicated below) so the archive
//     lands inside the very directory that owns the session log.
//   - `<archiveDir>` (default `context-sniper`) is a SUBDIRECTORY of the
//     session dir. DSH's session enumeration only treats directories that
//     contain a `session.jsonl[.zstd]` file as sessions, so this subdirectory
//     is invisible to DSH's listing and never interferes with its storage.
//
// One file per event keeps individual files small and bounded, avoiding the
// unbounded-growth problem of a single JSONL per session.
//
// The store is deliberately dependency-light: plain `node:fs/promises`.
// Search is a deterministic keyword scan — no external index, no server, works offline.

import { writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

// ---------------------------------------------------------------------------
// Path encoding — replicated verbatim from @deepseek-ai/dsh-session-persistence-jsonl
// so the archive directory is byte-for-byte identical to DSH's session dir.
// ---------------------------------------------------------------------------

/**
 * Escape one path segment, mirroring DSH's `encodeSegment`.
 * Safe code units stay literal; every other unit (including `~`) becomes
 * `~XXXX`. `.` and `..` are special-cased to prevent traversal.
 */
function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '_empty';
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/**
 * Build the readable project directory key, mirroring DSH's `projectKey`.
 * Filesystem separators and drive separators become `-`; unsafe code units use
 * the same `~XXXX` escape. The key is bounded to 251 chars and wrapped in `--`.
 */
function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return '--root--';
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/**
 * Resolve the DSH session DIRECTORY for a session (the dir that owns
 * `session.jsonl.zstd`). This is the directory the archive is placed inside.
 *
 * @param cwd the session's working directory (`session.header.cwd`).
 * @param sessionId the session id (`session.id`).
 * @returns the absolute session directory path.
 */
export function dshSessionDir(cwd, sessionId) {
  const root = dshHomePath('sessions');
  const project = projectKey(cwd);
  const encoded = encodeSegment(sessionId);
  return join(root, project, encoded);
}

/** Derive a filesystem-safe project name from a session's working directory. */
export function projectNameFromCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return '_default';
  const segments = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  const name = segments[segments.length - 1] || '_default';
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Resolve the archive DIRECTORY for one session (inside the DSH session dir). */
function sessionArchiveDir(cfg, cwd, sessionId) {
  const sessionDir = dshSessionDir(cwd, sessionId);
  return join(sessionDir, cfg.archiveDir);
}

/** Resolve the archive directory path (exported for settings panel display). */
export function resolveArchivePath(cfg, cwd, sessionId) {
  return sessionArchiveDir(cfg, cwd, sessionId);
}

/**
 * Write one archival record as an independent JSON file.
 * @param cfg resolved config.
 * @param cwd the session's working directory (`session.header.cwd`).
 * @param sessionId owning session id.
 * @param record archival record (already a plain JSON object).
 * @returns the archived record with a minted `archiveId` when absent.
 */
export async function appendArchive(cfg, cwd, sessionId, record) {
  const archiveId = record.archiveId ?? randomUUID();
  const dir = sessionArchiveDir(cfg, cwd, sessionId);
  const entry = {
    archiveId,
    sessionId,
    archivedAt: Date.now(),
    ...record,
  };
  await mkdir(dir, { recursive: true });
  // archiveId is a UUID (hex + dashes) — already filesystem-safe.
  const path = join(dir, `${archiveId}.json`);
  await writeFile(path, JSON.stringify(entry), 'utf8');
  return entry;
}

/**
 * Read every archival record for a session (all JSON files in the archive dir).
 * Missing directory yields `[]`. Records are returned in `archivedAt` order.
 * @param cfg resolved config.
 * @param cwd the session's working directory.
 * @param sessionId owning session id.
 * @returns the records in chronological order.
 */
export async function readArchive(cfg, cwd, sessionId) {
  const dir = sessionArchiveDir(cfg, cwd, sessionId);
  let files;
  try {
    files = await readdir(dir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(dir, file), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') records.push(parsed);
    } catch {
      // A corrupt file (writer crashed mid-write) must not poison the read.
    }
  }
  records.sort((a, b) => (a.archivedAt ?? 0) - (b.archivedAt ?? 0));
  return records;
}

/**
 * Count the archived messages (and records) for a session.
 * @param cfg resolved config.
 * @param cwd the session's working directory.
 * @param sessionId owning session id.
 * @returns `{ records, messages }`.
 */
export async function countArchive(cfg, cwd, sessionId) {
  const records = await readArchive(cfg, cwd, sessionId);
  let messages = 0;
  for (const record of records) {
    const list = Array.isArray(record.messages) ? record.messages : [];
    messages += list.length;
  }
  return { records: records.length, messages };
}

/**
 * Extract a plain-text projection of one message for search and display.
 * @param message an archived message (`{role, text?, content?...}`).
 * @returns the searchable text.
 */
function messageText(message) {
  if (typeof message.text === 'string') return message.text;
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((block) => {
        if (typeof block?.text === 'string') return block.text;
        if (typeof block?.content === 'string') return block.content;
        if (Array.isArray(block?.content)) return block.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join(' ');
        return '';
      })
      .join(' ');
  }
  return '';
}

/**
 * Keyword search across a session's archive.
 *
 * A query is split into whitespace-delimited terms; a message matches when it
 * contains EVERY term (case-insensitive). Hits are ranked by term density and
 * returned newest-first.
 *
 * @param cfg resolved config.
 * @param sessionId owning session id.
 * @param query the user/model query string.
 * @param opts `{ maxHits, hitMaxChars }` limits.
 * @returns `{ query, hits: [{ archiveId, turn, role, name?, snippet, archivedAt }] }`.
 */
export async function searchArchive(cfg, cwd, sessionId, query, opts = {}) {
  const maxHits = opts.maxHits ?? cfg.maxSearchHits;
  const hitMaxChars = opts.hitMaxChars ?? cfg.hitMaxChars;
  const q = String(query ?? '').trim().toLowerCase();
  if (q.length === 0) return { query: '', hits: [] };
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { query: q, hits: [] };

  const records = await readArchive(cfg, cwd, sessionId);
  const hits = [];
  for (const record of records) {
    const messages = Array.isArray(record.messages) ? record.messages : [];
    for (const message of messages) {
      const text = messageText(message).toLowerCase();
      if (text.length === 0) continue;
      const matched = terms.every((term) => text.includes(term));
      if (!matched) continue;
      // Density: how often the rarer term appears, normalized by length.
      let density = 0;
      for (const term of terms) {
        let idx = 0;
        let count = 0;
        while ((idx = text.indexOf(term, idx)) !== -1) {
          count++;
          idx += term.length;
        }
        density += count / Math.max(term.length, 1);
      }
      const rawText = messageText(message);
      const snippet = rawText.length > hitMaxChars ? `${rawText.slice(0, hitMaxChars)}…` : rawText;
      hits.push({
        archiveId: record.archiveId,
        archivedAt: record.archivedAt,
        fromSeq: record.fromSeq,
        toSeq: record.toSeq,
        ...(Number.isInteger(message.turn) ? { turn: message.turn } : {}),
        role: message.role ?? 'unknown',
        ...(message.name ? { name: message.name } : {}),
        score: density,
        snippet,
      });
    }
  }
  hits.sort((a, b) => (b.score - a.score) || (b.archivedAt - a.archivedAt));
  return { query: q, hits: hits.slice(0, maxHits) };
}

/**
 * Whether a session has any archived content yet.
 * @param cfg resolved config.
 * @param cwd the session's working directory.
 * @param sessionId owning session id.
 */
export async function hasArchive(cfg, cwd, sessionId) {
  const dir = sessionArchiveDir(cfg, cwd, sessionId);
  try {
    const entries = await readdir(dir);
    return entries.some((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
}
