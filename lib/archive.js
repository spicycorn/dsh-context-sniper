// dsh-context-sniper: durable, lossless archive store.
//
// Each archival event is one JSON file under the harness home:
//   `<home>/<archiveDir>/<sessionId>/<archiveId>.json`
//
// One file per event keeps individual files small and bounded, avoiding the
// unbounded-growth problem of a single JSONL per session.
//
// The store is deliberately dependency-light: plain `node:fs/promises`.
// Search is a deterministic keyword scan — no external index, no server, works offline.

import { writeFile, mkdir, readFile, stat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

/** Derive a filesystem-safe project name from a session's working directory. */
export function projectNameFromCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return '_default';
  const segments = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  const name = segments[segments.length - 1] || '_default';
  return sanitize(name);
}

/** Resolve the archive DIRECTORY for one session. */
function sessionArchiveDir(cfg, sessionId, projectName) {
  const base = projectName ? `${cfg.archiveDir}/${sanitize(projectName)}` : cfg.archiveDir;
  return dshHomePath(base, sanitize(sessionId));
}

/** Resolve the archive FILE path for one archival event. */
function archiveFilePath(cfg, sessionId, archiveId, projectName) {
  return join(sessionArchiveDir(cfg, sessionId, projectName), `${sanitize(archiveId)}.json`);
}

/** Resolve the archive directory path (exported for settings panel display). */
export function resolveArchivePath(cfg, sessionId, projectName) {
  return sessionArchiveDir(cfg, sessionId, projectName);
}

function sanitize(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Write one archival record as an independent JSON file.
 * @param cfg resolved config.
 * @param sessionId owning session id.
 * @param record archival record (already a plain JSON object).
 * @returns the archived record with a minted `archiveId` when absent.
 */
export async function appendArchive(cfg, sessionId, record, projectName) {
  const archiveId = record.archiveId ?? randomUUID();
  const dir = sessionArchiveDir(cfg, sessionId, projectName);
  const entry = {
    archiveId,
    sessionId,
    archivedAt: Date.now(),
    ...record,
  };
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sanitize(archiveId)}.json`);
  await writeFile(path, JSON.stringify(entry), 'utf8');
  return entry;
}

/**
 * Read every archival record for a session (all JSON files in the session dir).
 * Missing directory yields `[]`. Records are returned in `archivedAt` order.
 * @param cfg resolved config.
 * @param sessionId owning session id.
 * @returns the records in chronological order.
 */
export async function readArchive(cfg, sessionId, projectName) {
  const dir = sessionArchiveDir(cfg, sessionId, projectName);
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
 * @param sessionId owning session id.
 * @returns `{ records, messages }`.
 */
export async function countArchive(cfg, sessionId, projectName) {
  const records = await readArchive(cfg, sessionId, projectName);
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
export async function searchArchive(cfg, sessionId, query, opts = {}, projectName) {
  const maxHits = opts.maxHits ?? cfg.maxSearchHits;
  const hitMaxChars = opts.hitMaxChars ?? cfg.hitMaxChars;
  const q = String(query ?? '').trim().toLowerCase();
  if (q.length === 0) return { query: '', hits: [] };
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { query: q, hits: [] };

  const records = await readArchive(cfg, sessionId, projectName);
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
 * @param sessionId owning session id.
 */
export async function hasArchive(cfg, sessionId, projectName) {
  const dir = sessionArchiveDir(cfg, sessionId, projectName);
  try {
    const entries = await readdir(dir);
    return entries.some((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
}
