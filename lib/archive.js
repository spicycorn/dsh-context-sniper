// dsh-context-sniper: durable, lossless archive store.
//
// Each archival event is one JSONL record under the harness home
// (`<home>/<archiveDir>/<sessionId>.jsonl`). The record carries the verbatim
// messages that left the model surface, so nothing is ever summarized away.
//
// The store is deliberately dependency-light: plain `node:fs/promises`, one
// append-only file per session. Search is a deterministic keyword scan — no
// external index, no server, works offline.

import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
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

/** Resolve the archive file path for one session (optionally under a project subdirectory). */
export function resolveArchivePath(cfg, sessionId, projectName) {
  const base = projectName ? `${cfg.archiveDir}/${sanitize(projectName)}` : cfg.archiveDir;
  return dshHomePath(base, `${sanitize(sessionId)}.jsonl`);
}

function sanitize(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Append one archival record to the session's archive file.
 * @param cfg resolved config.
 * @param sessionId owning session id.
 * @param record archival record (already a plain JSON object).
 * @returns the archived record with a minted `archiveId` when absent.
 */
export async function appendArchive(cfg, sessionId, record, projectName) {
  const path = resolveArchivePath(cfg, sessionId, projectName);
  const entry = {
    archiveId: record.archiveId ?? randomUUID(),
    sessionId,
    archivedAt: Date.now(),
    ...record,
  };
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

/**
 * Read every archival record for a session. Missing file yields `[]`.
 * @param cfg resolved config.
 * @param sessionId owning session id.
 * @returns the records in append order.
 */
export async function readArchive(cfg, sessionId, projectName) {
  const path = resolveArchivePath(cfg, sessionId, projectName);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A torn trailing line (writer crashed mid-append) must not poison the read.
    }
  }
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
  try {
    const s = await stat(resolveArchivePath(cfg, sessionId, projectName));
    return s.size > 0;
  } catch {
    return false;
  }
}
