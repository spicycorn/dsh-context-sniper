// dsh-context-sniper: round selection and lossless archival over a session surface.
//
// A "round" is one DSH turn (a `turn/start` … `turn/end` span): the user's
// message plus the assistant's responses and tool results it produced. When the
// context overflows we keep the newest N rounds in the model surface and move
// the older rounds out — verbatim — into the archive, replacing them with one
// compact marker that points the model at the recall tool.

import { appendArchive } from './archive.js';

const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);

/**
 * Group the current surface into ordered rounds (one per turn).
 * @param session a live DSH session.
 * @returns `{ rounds: [{ turn, surfaceNodes: number[], turnClosed: boolean }] }` in turn order.
 */
export function groupRounds(session) {
  const events = session.events;
  const surfaceSet = new Set(session.surface.nodes);
  const byTurn = new Map();
  let openTurn = null;

  for (const event of events) {
    if (event.type === 'turn/start') {
      openTurn = event.data.turn;
      continue;
    }
    if (event.type === 'turn/end') {
      openTurn = null;
      continue;
    }
    if (!SURFACE_EVENT_TYPES.has(event.type) || !surfaceSet.has(event.seq)) continue;
    // Surface nodes always belong to the turn open at their log position.
    const turn = openTurn ?? 0;
    let bucket = byTurn.get(turn);
    if (bucket === undefined) {
      bucket = { turn, surfaceNodes: [] };
      byTurn.set(turn, bucket);
    }
    bucket.surfaceNodes.push(event.seq);
  }

  const rounds = [...byTurn.values()].sort((a, b) => a.turn - b.turn);
  const lastTurn = rounds.length > 0 ? rounds[rounds.length - 1].turn : 0;
  for (const round of rounds) round.turnClosed = round.turn < lastTurn || openTurn === null;
  return { rounds };
}

/**
 * Derive a plain-text projection of one surface event's message.
 * @param event a surface event.
 * @returns `{ role, text, name? }`.
 */
export function eventToMessage(event) {
  const data = event.data;
  if (event.type === 'user/message') {
    const source = data?.source;
    const role = source?.kind === 'tool' ? 'tool' : source?.kind === 'plugin' ? 'plugin' : 'user';
    return { role, text: contentText(data?.content), ...(source?.callId ? { name: String(source.callId) } : {}) };
  }
  if (event.type === 'assistant/message') {
    return { role: 'assistant', text: contentText(data?.message?.content) };
  }
  if (event.type === 'tool/result') {
    const message = data?.message;
    const callId = message?.source?.callId ?? message?.content?.[0]?.toolCallId ?? null;
    return { role: 'tool', text: contentText(message?.content), ...(callId ? { name: String(callId) } : {}) };
  }
  return { role: 'unknown', text: '' };
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block?.text === 'string') return block.text;
      if (typeof block?.content === 'string') return block.content;
      if (Array.isArray(block?.content)) {
        return block.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join(' ');
      }
      return '';
    })
    .join(' ');
}

/**
 * Build the archival record for a set of rounds and apply the surface rewrite.
 *
 * @param session live session whose surface is rewritten.
 * @param cfg resolved config.
 * @param roundsToArchive the rounds to move out of the surface (oldest first).
 * @param keepRounds the N that was applied (for the marker + record).
 * @param reason why the archival happened (`'context-overflow'` or `'pressure'`).
 * @returns `{ archived, fromSeq, toSeq, markerSeq, roundTurns }`.
 */
export async function archiveRounds(session, cfg, roundsToArchive, keepRounds, reason = 'context-overflow') {
  const messages = [];
  const roundTurns = [];
  for (const round of roundsToArchive) {
    roundTurns.push(round.turn);
    for (const seq of round.surfaceNodes) {
      const event = session.events[seq];
      if (!event) continue;
      const message = eventToMessage(event);
      if (message.text.trim() === '' && message.role !== 'tool') continue;
      messages.push({ turn: round.turn, ...message });
    }
  }
  if (messages.length === 0) return null;

  const shadowedSeqs = roundsToArchive.flatMap((round) => round.surfaceNodes);
  const fromSeq = shadowedSeqs[0];
  const toSeq = shadowedSeqs[shadowedSeqs.length - 1];

  const record = {
    fromSeq,
    toSeq,
    rounds: roundTurns,
    messages,
    keepRounds,
    reason,
  };
  const entry = await appendArchive(cfg, session.id, record);

  const marker = markerMessage(entry.archiveId, roundTurns.length, messages.length);
  const replacement = session.append('user/message', marker, {
    surfaceOp: { op: 'replace', start: fromSeq, end: toSeq },
    sourceEventSeqs: [...shadowedSeqs],
  });

  return {
    archived: messages.length,
    roundTurns,
    fromSeq,
    toSeq,
    markerSeq: replacement.seq,
    archiveId: entry.archiveId,
    archivePath: null,
  };
}

/**
 * Build the compact replacement message the model sees in place of archived rounds.
 * It must be short (it stays in context) and must tell the model how to get the
 * content back.
 */
export function markerMessage(archiveId, roundCount, messageCount) {
  const text = [
    `<context-sniper-archive id="${archiveId}">`,
    `The ${roundCount} oldest round(s) (${messageCount} messages) of this conversation were archived to free context. Their full text is preserved and searchable.`,
    `To use any of it, call the context_sniper_recall tool with a keyword query; it returns the matching archived messages verbatim.`,
    `Do not assume their content; retrieve it before relying on it.`,
    `</context-sniper-archive>`,
  ].join('\n');
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'context-sniper', archiveId },
  };
}
