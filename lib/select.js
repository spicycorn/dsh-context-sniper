// dsh-context-sniper: token-budget-based lossless archival over a session surface.
//
// Archival is at single-message granularity: the surface is a sequence of priced
// nodes (each one a user message, assistant message, or tool result). We walk
// from the newest node backwards, accumulating tokens until the budget is met.
// Everything older than that cut point is archived verbatim to an independent
// JSON file (one per archival event) and replaced by one compact marker that
// points the model at the recall tool.
//
// A tool-pairing safety check ensures the cut never splits a tool-call from
// its result (which would corrupt the model's view of the conversation).

import { appendArchive } from './archive.js';

// ---------------------------------------------------------------------------
// Token-budget archival
// ---------------------------------------------------------------------------

/**
 * Find a tool-pairing-safe cut point at or before a given index.
 *
 * A "safe cut" at index `i` means: if we remove nodes [0..i-1] from the
 * surface, no open tool-call is left dangling (i.e. the number of tool-call
 * blocks in the removed prefix equals the number of tool results in it).
 *
 * @param session live DSH session.
 * @param nodes priced surface nodes in model-visible order (from tokenMeter).
 * @param desiredIndex the index where the token budget was met (we cut BEFORE this).
 * @returns the largest index ≤ desiredIndex that is a safe cut boundary.
 */
function findSafeCut(session, nodes, desiredIndex) {
  // Walk forward from the start, tracking open tool calls.
  // A cut at index i is safe when openToolCalls === 0 after processing nodes[0..i-1].
  let openToolCalls = 0;
  let lastSafe = 0; // 0 = "cut before the first node" (archive everything)
  const limit = Math.min(desiredIndex, nodes.length);

  for (let i = 0; i < limit; i++) {
    const event = session.events[nodes[i].seq];
    if (!event) continue;
    if (event.type === 'assistant/message') {
      const blocks = event.data?.message?.content;
      if (Array.isArray(blocks)) {
        openToolCalls += blocks.filter((b) => b.type === 'tool-call').length;
      }
    } else if (event.type === 'tool/result') {
      openToolCalls = Math.max(0, openToolCalls - 1);
    }
    if (openToolCalls === 0) {
      lastSafe = i + 1; // safe to cut after node i (i.e. archive nodes[0..i])
    }
  }
  return lastSafe;
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
 * Archive surface messages from oldest until the remaining surface fits within
 * the token budget.
 *
 * @param session live session whose surface is rewritten.
 * @param meter the tokenMeter service (must be available).
 * @param cfg resolved config.
 * @param budget maximum tokens to retain on the surface.
 * @param reason why the archival happened.
 * @returns `{ archived, fromSeq, toSeq, markerSeq, freedTokens }` or `null` when
 *          the surface already fits within the budget (nothing to archive).
 */
export async function archiveByTokenBudget(session, meter, cfg, budget, reason = 'timeout') {
  const measurement = meter.measure(session);
  const nodes = measurement.nodes; // [{ seq, tokens }] in surface order

  if (nodes.length === 0) return null;

  // Walk backwards from the newest node, accumulating tokens.
  // keepStart = the first index of the "keep" region (nodes[keepStart..end] are kept).
  // If keepStart === 0, the entire surface fits in the budget.
  let accumulated = 0;
  let keepStart = 0; // default: keep everything from the start
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (accumulated + nodes[i].tokens > budget && accumulated > 0) {
      // Adding this node would exceed the budget, and we already have some kept.
      // Stop here: nodes[i+1..end] are kept, nodes[0..i] are archived.
      break;
    }
    accumulated += nodes[i].tokens;
    keepStart = i;
  }

  // If the entire surface fits within budget, nothing to archive.
  if (keepStart === 0) return null;

  // Ensure the cut is tool-pairing safe (don't split a call/result pair).
  // We want to archive nodes[0..keepStart-1], so the cut is at keepStart.
  const safeCut = findSafeCut(session, nodes, keepStart);
  if (safeCut === 0) return null; // even the oldest node must stay

  // The range to archive: nodes[0] through nodes[safeCut - 1].
  const toArchive = nodes.slice(0, safeCut);
  const freedTokens = toArchive.reduce((sum, n) => sum + n.tokens, 0);

  // Build the archival record (verbatim messages).
  const messages = [];
  for (const node of toArchive) {
    const event = session.events[node.seq];
    if (!event) continue;
    const message = eventToMessage(event);
    if (message.text.trim() === '' && message.role !== 'tool') continue;
    messages.push(message);
  }
  if (messages.length === 0) return null;

  const fromSeq = toArchive[0].seq;
  const toSeq = toArchive[toArchive.length - 1].seq;

  const record = {
    fromSeq,
    toSeq,
    messageCount: messages.length,
    freedTokens,
    messages,
    budget,
    reason,
  };
  // Archive inside the DSH session directory (aligned with DSH's own storage).
  const entry = await appendArchive(cfg, session.header?.cwd, session.id, record);

  // Verify the surface hasn't changed during the file write.
  // If it has, the seqs we computed are stale — abort the replace.
  const currentSurface = session.surface.nodes;
  if (!currentSurface.includes(fromSeq) || !currentSurface.includes(toSeq)) {
    return null;
  }

  const marker = markerMessage(entry.archiveId, messages.length, freedTokens);
  const replacement = session.append('user/message', marker, {
    surfaceOp: { op: 'replace', start: fromSeq, end: toSeq },
    sourceEventSeqs: toArchive.map((n) => n.seq),
  });

  return {
    archived: messages.length,
    freedTokens,
    fromSeq,
    toSeq,
    markerSeq: replacement.seq,
    archiveId: entry.archiveId,
  };
}

/**
 * Build the compact replacement message the model sees in place of archived content.
 * It must be short (it stays in context) and must tell the model how to get the
 * content back.
 *
 * IMPORTANT — the `id` field is MANDATORY. DSH's session load boundary
 * (`assertMessageEventShape` in `@deepseek-ai/dsh-session`) rejects any
 * `user/message` whose `data.id` is not a non-empty string, throwing
 * "session event at seq N lacks an identified message" and making the whole
 * session unloadable. DSH's own `createUserMessage` always mints
 * `id: MessageId(crypto.randomUUID())`. We use the archive id (a UUID) as the
 * message id so the marker round-trips losslessly through persistence.
 * Omitting `id` (as earlier plugin versions did) is the root cause of the
 * `SessionPersistenceCorruptionError` the user saw on load.
 */
export function markerMessage(archiveId, messageCount, freedTokens) {
  // Guarantee a non-empty id even if a caller passes something odd.
  const id = typeof archiveId === 'string' && archiveId.length > 0
    ? archiveId
    : `context-sniper-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const text = [
    `<context-sniper-archive id="${id}">`,
    `${messageCount} earlier message(s) (~${freedTokens} tokens) were archived to free context for the model. Their full text is preserved and searchable.`,
    `To use any of it, call the context_sniper_recall tool with a keyword query; it returns the matching archived messages verbatim.`,
    `Do not assume their content; retrieve it before relying on it.`,
    `</context-sniper-archive>`,
  ].join('\n');
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'context-sniper', archiveId: id },
  };
}

// ---------------------------------------------------------------------------
// Round grouping (retained for statistics / settings panel display)
// ---------------------------------------------------------------------------

const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);

/**
 * Group the current surface into ordered rounds (one per turn).
 * Used for display in the settings panel, not for archival decisions.
 * @param session a live DSH session.
 * @returns `{ rounds: [{ turn, surfaceNodes: number[] }] }` in turn order.
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
    const turn = openTurn ?? 0;
    let bucket = byTurn.get(turn);
    if (bucket === undefined) {
      bucket = { turn, surfaceNodes: [] };
      byTurn.set(turn, bucket);
    }
    bucket.surfaceNodes.push(event.seq);
  }

  const rounds = [...byTurn.values()].sort((a, b) => a.turn - b.turn);
  return { rounds };
}
