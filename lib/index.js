// dsh-context-sniper — host half.
//
// A lossless context-saver for long DSH conversations. When the model request
// times out (local model prefill too slow) or overflows the context window,
// this plugin:
//
//   1. keeps the newest messages (up to `surfaceTokenBudget` tokens) in the
//      model surface,
//   2. archives older messages VERBATIM to durable per-event JSON files under
//      a per-session directory,
//   3. rewrites the surface with one compact marker pointing the model at the
//      recall tool,
//   4. authorizes the retry.
//
// If it cannot free enough (or the surface is already minimal) it falls
// through to the built-in dsh-compaction-basic summarizer as the safety net.
//
// The single user-facing knob is `surfaceTokenBudget` (default 32K). It is
// editable at runtime through the settings panel and the DSH settings document.

import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { resolveConfig, ARCHIVE_MARKER_PLUGIN } from './config.js';
import { archiveByTokenBudget, groupRounds } from './select.js';
import { searchArchive, countArchive, hasArchive, resolveArchivePath } from './archive.js';

const SETTINGS_NS = settingsNamespace('dsh-context-sniper');

const name = 'dsh-context-sniper';
// Hard dependencies: without these the plugin cannot function.
// - tools: register the recall tool
// - tokenMeter: measure surface tokens for budget-based archival
// - agents: access live agent instances for auto-continue (followup)
const inject = ['tools', 'tokenMeter', 'agents'];

export { name, inject };

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config);
  const meter = ctx.tokenMeter;

  // Live, hot-reloadable value of surfaceTokenBudget. Seeded from the
  // composition config; moved by the settings service and the client RPC.
  const live = { surfaceTokenBudget: cfg.surfaceTokenBudget };

  // ---------------------------------------------------------------------------
  // Core archival: archive oldest messages until surface ≤ budget.
  // Returns a result object when something was archived, or `null` when the
  // surface already fits (nothing to archive).
  // ---------------------------------------------------------------------------
  async function tryArchiveByBudget(session, reason) {
    const budget = live.surfaceTokenBudget;
    const result = await archiveByTokenBudget(session, meter, cfg, budget, reason);
    if (result && cfg.verbose) {
      ctx.logger.info(
        `context-sniper (${reason}): archived ${result.archived} message(s), freed ~${result.freedTokens} tokens`,
      );
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Overflow & timeout recovery: the primary reactive triggers.
  //
  // `prepend: true` makes this listener the outermost wrapper of the waterfall,
  // so it acts before the built-in compaction. If it frees context it returns a
  // terminal `{ kind: "retry" }` (compaction never runs); otherwise it calls
  // next() and lets the lossy summarizer handle the remainder.
  //
  // Handles:
  //   - CONTEXT_WINDOW_EXCEEDED: input exceeds model window
  //   - TIMEOUT / ABORTED / TRANSPORT: local model too slow, request timed out
  //     (archiving reduces input → faster prefill → less timeout risk)
  // ---------------------------------------------------------------------------
  const TIMEOUT_CODES = new Set(['TIMEOUT', 'ABORTED', 'TRANSPORT']);
  ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
    const code = failure?.code;
    const isOverflow = code === 'CONTEXT_WINDOW_EXCEEDED';
    const isTimeout = TIMEOUT_CODES.has(code);
    if (!isOverflow && !isTimeout) return next();
    // ABORTED with signal.aborted = user cancelled — do not retry
    if (code === 'ABORTED' && signal?.aborted) return next();
    const reason = isOverflow ? 'context-overflow' : 'timeout';
    try {
      const result = await tryArchiveByBudget(agent.session, reason);
      if (result) {
        ctx.logger.info(`context-sniper: ${reason} recovery — archived ${result.archived} msg(s), retrying with smaller input`);
        return { kind: 'retry' };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.warn(`context-sniper: archival failed (${message}); deferring`);
    }
    return next();
  }, { prepend: true });

  // ---------------------------------------------------------------------------
  // Output truncation detection + auto-continue.
  //
  // When the model's output hits max_tokens, DSH treats it as a normal
  // completion (finish.kind === "max-tokens") — no error event fires. The
  // response is simply incomplete. The correct sequence:
  //   1. detect truncation (via TokenUsage vs context window)
  //   2. archive old messages (free context space for output)
  //   3. agent.followup("请继续…") → new turn with larger output room
  //
  // A per-session counter prevents infinite loops (max 3 auto-continues).
  // ---------------------------------------------------------------------------
  const MAX_AUTO_CONTINUE = 3;
  const continueCounts = new Map(); // sessionId → count

  /** Check if an assistant message looks truncated. */
  function detectTruncation(eventData, contextWindow) {
    const usage = eventData?.usage;
    if (usage && typeof usage.outputTokens === 'number' && usage.outputTokens > 0) {
      const total = (usage.inputTokens ?? 0) + usage.outputTokens;
      if (contextWindow > 0 && total >= contextWindow * 0.8) return true;
    }
    // Fallback heuristic: no usage reported, but message is long and ends abruptly
    if (!usage) {
      const message = eventData?.message;
      const blocks = message?.content;
      if (!Array.isArray(blocks) || blocks.length === 0) return false;
      const lastText = [...blocks].reverse().find((b) => b.type === 'text');
      if (!lastText || !lastText.text || lastText.text.length < 2000) return false;
      const tail = lastText.text.slice(-80);
      const endsProperly = /[.!?。！？\n`]\s*$/.test(tail);
      if (!endsProperly) return true;
    }
    return false;
  }

  ctx.on('session/event', async (session, event) => {
    if (event.type !== 'assistant/message') return;
    if (event.data?.interrupted) return;
    const blocks = event.data?.message?.content;
    if (Array.isArray(blocks) && blocks.some((b) => b.type === 'tool-call')) return;

    const count = continueCounts.get(session.id) ?? 0;
    if (count >= MAX_AUTO_CONTINUE) return;

    // Resolve context window dynamically
    const llm = ctx.get('llm');
    const agent = ctx.agents?.get?.(session.id);
    const route = agent?.options ?? {};
    let contextWindow = 0;
    if (llm && route.provider && route.model) {
      try {
        const info = await llm.resolveModelInfo(route.provider, route.model);
        contextWindow = info?.context ?? 0;
      } catch { contextWindow = 0; }
    }
    if (contextWindow === 0) return;

    if (!detectTruncation(event.data, contextWindow)) return;

    continueCounts.set(session.id, count + 1);
    ctx.logger.info(
      `context-sniper: output truncation detected (attempt ${count + 1}/${MAX_AUTO_CONTINUE}), ` +
      `archiving to free output space`,
    );
    try {
      await tryArchiveByBudget(session, 'output-truncation');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.warn(`context-sniper: pre-continue archival failed (${message})`);
    }
    const live_agent = ctx.agents?.get?.(session.id);
    if (live_agent && typeof live_agent.followup === 'function') {
      const msg = {
        role: 'user',
        content: [{ type: 'text', text: '请继续完成上一步未完成的输出。' }],
        source: { kind: 'plugin', plugin: 'context-sniper' },
      };
      try {
        live_agent.followup(msg);
        ctx.logger.info('context-sniper: auto-continue dispatched');
      } catch (error) {
        ctx.logger.warn(`context-sniper: auto-continue failed (${error?.message ?? error})`);
      }
    }
  });

  // Reset auto-continue budget when a REAL user message arrives
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message') return;
    const source = event.data?.source;
    if (source?.kind === 'user' || source?.kind === 'model') {
      const count = continueCounts.get(session.id);
      if (count !== void 0) continueCounts.delete(session.id);
    }
  });

  // ---------------------------------------------------------------------------
  // Optional proactive pressure path. Off by default (pressureRatio: 0).
  // When enabled, archive early once surface tokens cross the fraction of the
  // budget, avoiding the hard timeout entirely.
  // ---------------------------------------------------------------------------
  if (cfg.pressureRatio > 0) {
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (signal?.aborted) return next();
      try {
        const measurement = meter.measure(agent.session);
        const threshold = Math.floor(live.surfaceTokenBudget * cfg.pressureRatio);
        if (threshold > 0 && measurement.surfaceTokens >= threshold) {
          await tryArchiveByBudget(agent.session, 'pressure');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.warn(`context-sniper: proactive check failed (${message}); continuing`);
      }
      return next();
    }, { prepend: true });
  }

  // ---------------------------------------------------------------------------
  // Recall tool: the model's door back into the archive.
  // ---------------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'context_sniper_recall',
    description:
      'Search the dsh-context-sniper archive of earlier conversation messages that were ' +
      'moved out of context to free the window. Use it whenever you need facts, decisions, ' +
      'file contents, or instructions from earlier in THIS session that are no longer visible ' +
      'in the current context. Provide a short keyword query; matching archived messages are ' +
      'returned verbatim, newest first. If the result is empty, the content was never ' +
      'archived (or the query does not match) — try a different term or ask the user.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'One or more keywords to search for in the archived messages (case-insensitive).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          hitCount: { type: 'integer', required: true },
          archiveMessages: { type: 'integer', required: true },
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                role: { type: 'string', required: true },
                name: { type: 'string' },
                turn: { type: 'integer' },
                snippet: { type: 'string', required: true },
                archivedAt: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.hitCount === 0
            ? `context_sniper_recall: no archived messages matched "${value.query}".`
            : `context_sniper_recall: ${value.hitCount} archived message(s) matched "${value.query}" (of ${value.archiveMessages} archived).`,
        },
      ],
    },
    async execute(args, exec) {
      const session = exec?.agent?.session;
      if (session === undefined) {
        throw new Error('context_sniper_recall requires an owning agent session');
      }
      const cwd = session.header?.cwd;
      if (!(await hasArchive(cfg, cwd, session.id))) {
        return {
          query: String(args.query),
          hitCount: 0,
          archiveMessages: 0,
          hits: [],
        };
      }
      const { hits } = await searchArchive(cfg, cwd, session.id, String(args.query), {
        maxHits: cfg.maxSearchHits,
        hitMaxChars: cfg.hitMaxChars,
      });
      const { messages } = await countArchive(cfg, cwd, session.id);
      // Project hits to the tool schema (strip internal fields like archiveId, fromSeq, toSeq, score).
      const projected = hits.map((h) => ({
        role: h.role,
        ...(h.name ? { name: h.name } : {}),
        ...(Number.isInteger(h.turn) ? { turn: h.turn } : {}),
        snippet: h.snippet,
        archivedAt: h.archivedAt,
      }));
      return {
        query: String(args.query),
        hitCount: projected.length,
        archiveMessages: messages,
        hits: projected,
      };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Recall archived context',
      kind: 'other',
      rawInput: { query: args.query },
    }),
  }));

  // ---------------------------------------------------------------------------
  // Settings: durable, hot-reloadable surfaceTokenBudget.
  // ---------------------------------------------------------------------------
  const settings = ctx.get('settings');
  let scope = null;
  if (settings !== undefined && typeof settings.register === 'function') {
    try {
      const schema = z.object({
        surfaceTokenBudget: z.number().step(1024).min(1024).default(cfg.surfaceTokenBudget),
      });
      scope = settings.register(SETTINGS_NS, schema, { base: { surfaceTokenBudget: cfg.surfaceTokenBudget } });
      const current = settings.get(SETTINGS_NS);
      if (current && Number.isInteger(current.surfaceTokenBudget)) {
        live.surfaceTokenBudget = current.surfaceTokenBudget;
      }
      scope.watch((next) => {
        if (next && Number.isInteger(next.surfaceTokenBudget)) {
          live.surfaceTokenBudget = next.surfaceTokenBudget;
        }
      });
    } catch (error) {
      ctx.logger.warn(`context-sniper: settings registration skipped (${error?.message ?? error})`);
    }
  }

  // ---------------------------------------------------------------------------
  // Client RPC: the settings panel reads state and writes budget through
  // this loopback channel.
  // ---------------------------------------------------------------------------
  ctx.inject(['connection'], (rpcCtx) => {
    const connection = rpcCtx.connection;
    if (!connection?.rpc?.handle) {
      rpcCtx.logger.warn('context-sniper: connection service present but rpc.handle is unavailable — RPC route not registered');
      return;
    }
    connection.rpc.handle('/context-sniper', async (endpoint, payload = {}) => {
      if (endpoint === 'get-state') {
        return {
          ok: true,
          value: {
            surfaceTokenBudget: live.surfaceTokenBudget,
            defaultBudget: cfg.surfaceTokenBudget,
            maxSearchHits: cfg.maxSearchHits,
            archiveDir: cfg.archiveDir,
          },
        };
      }
      if (endpoint === 'set-budget') {
        const value = Number(payload?.budget);
        if (!Number.isInteger(value) || value < 1024) {
          return { ok: false, error: { code: 'bad-request', message: 'budget must be an integer ≥ 1024' } };
        }
        live.surfaceTokenBudget = value;
        if (scope && typeof scope.update === 'function') {
          try { await scope.update({ surfaceTokenBudget: value }); }
          catch (error) { rpcCtx.logger.warn(`context-sniper: settings update failed (${error?.message ?? error})`); }
        }
        return { ok: true, value: { surfaceTokenBudget: value } };
      }
      if (endpoint === 'session-state') {
        const sid = String(payload?.sessionId ?? '');
        if (!sid) return { ok: false, error: { code: 'bad-request', message: 'sessionId required' } };
        const session = rpcCtx.get?.('sessions')?.get?.(sid);
        const cwd = session?.header?.cwd;
        const { records, messages } = await countArchive(cfg, cwd, sid);
        const value = {
          sessionId: sid,
          cwd: cwd ?? null,
          archiveRecords: records,
          archiveMessages: messages,
          archivePath: resolveArchivePath(cfg, cwd, sid),
          surfaceTokenBudget: live.surfaceTokenBudget,
        };
        if (session) {
          try {
            const measured = meter.measure(session);
            value.surfaceTokens = measured.surfaceTokens;
            value.rounds = groupRounds(session).rounds.length;
          } catch { /* measurement is best-effort */ }
        }
        return { ok: true, value };
      }
      return { ok: false, error: { code: 'bad-request', message: `Unknown endpoint: ${endpoint}` } };
    }, { authority: 'loopback' });
    rpcCtx.logger.info('context-sniper: RPC route /context-sniper registered');
  });

  // ---------------------------------------------------------------------------
  // A small service face for other plugins / tests.
  // ---------------------------------------------------------------------------
  ctx.provide('contextSniper', {
    plugin: ARCHIVE_MARKER_PLUGIN,
    surfaceTokenBudget: () => live.surfaceTokenBudget,
    setSurfaceTokenBudget: (value) => {
      if (Number.isInteger(value) && value >= 1024) live.surfaceTokenBudget = value;
    },
    archiveFor: async (cwd, sessionId) => countArchive(cfg, cwd, sessionId),
  });
}
