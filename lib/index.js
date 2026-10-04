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
//
// DSH 0.2.0-rc.1: settings are schema-driven. The plugin exports a `Config`
// schemastery object; fields marked `.volatile()` are live-editable through
// the settings service. The plugin reads volatile values with `config.field.get()`
// at the time of use — no manual register/watch/unregister lifecycle.

import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { resolveConfig, ARCHIVE_MARKER_PLUGIN } from './config.js';
import { archiveByTokenBudget, groupRounds } from './select.js';
import { searchArchive, countArchive, hasArchive, resolveArchivePath } from './archive.js';

// ---------------------------------------------------------------------------
// Config schema — exported for the settings service to discover.
// Fields marked `.volatile()` are live-editable at runtime through the
// settings UI; the plugin reads them with `.get()` at the point of use.
// ---------------------------------------------------------------------------
export const Config = z.object({
  surfaceTokenBudget: z.number().step(1).min(1024).max(1048576).default(32768).volatile(),
  pressureRatio: z.number().min(0).max(0.999).default(0),
  maxSearchHits: z.number().step(1).min(1).max(64).default(8).volatile(),
  hitMaxChars: z.number().step(1).min(200).max(20000).default(4000).volatile(),
  archiveDir: z.string().default('context-sniper'),
  verbose: z.boolean().default(false),
});

const name = 'dsh-context-sniper';
// Hard dependencies: without these the plugin cannot function.
// - tools: register the recall tool
// - tokenMeter: measure surface tokens for budget-based archival
// - agents: access live agent instances for auto-continue (followup)
// - settings: persist settings changes through the profile patch
const inject = ['tools', 'tokenMeter', 'agents', 'settings'];

export { name, inject };

export function apply(ctx, rawConfig = {}) {
  const cfg = resolveConfig(rawConfig);
  const meter = ctx.tokenMeter;

  // ---------------------------------------------------------------------------
  // Core archival: archive oldest messages until surface ≤ budget.
  // Returns a result object when something was archived, or `null` when the
  // surface already fits (nothing to archive).
  // ---------------------------------------------------------------------------
  async function tryArchiveByBudget(session, reason) {
    const budget = rawConfig.surfaceTokenBudget.get();
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
        const context = info?.context;
        contextWindow = typeof context === 'number'
          ? context
          : (context && typeof context.contextWindow === 'number' ? context.contextWindow : 0);
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
        id: `context-sniper-continue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
  // ---------------------------------------------------------------------------
  if (cfg.pressureRatio > 0) {
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (signal?.aborted) return next();
      try {
        const measurement = meter.measure(agent.session);
        const budget = rawConfig.surfaceTokenBudget.get();
        const threshold = Math.floor(budget * cfg.pressureRatio);
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
        maxHits: rawConfig.maxSearchHits.get(),
        hitMaxChars: rawConfig.hitMaxChars.get(),
      });
      const { messages } = await countArchive(cfg, cwd, session.id);
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
  // Client RPC: the settings panel reads state and writes budget through this
  // loopback channel. Uses `connection.rpc.handle()` for clean registration.
  // ---------------------------------------------------------------------------
  const CHANNEL = '/context-sniper';

  async function handleRpcEndpoint(endpoint, payload = {}) {
    if (endpoint === 'get-state') {
      return {
        ok: true,
        value: {
          surfaceTokenBudget: rawConfig.surfaceTokenBudget.get(),
          defaultBudget: cfg.surfaceTokenBudget,
          maxSearchHits: rawConfig.maxSearchHits.get(),
          hitMaxChars: rawConfig.hitMaxChars.get(),
          archiveDir: cfg.archiveDir,
        },
      };
    }
    if (endpoint === 'set-budget') {
      const value = Number(payload?.budget);
      if (!Number.isInteger(value) || value < 1024) {
        return { ok: false, error: { code: 'bad-request', message: 'budget must be an integer ≥ 1024' } };
      }
      try {
        await ctx.settings.update(name, { surfaceTokenBudget: value });
        return { ok: true, value: { surfaceTokenBudget: value } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.warn(`context-sniper: budget save failed (${message})`);
        return { ok: false, error: { code: 'persistence', message: `预算保存失败：${message}` } };
      }
    }
    if (endpoint === 'set-search') {
      const updates = {};
      if (payload?.maxSearchHits !== undefined) {
        const v = Number(payload.maxSearchHits);
        if (!Number.isInteger(v) || v < 1 || v > 64) {
          return { ok: false, error: { code: 'bad-request', message: 'maxSearchHits must be an integer 1–64' } };
        }
        updates.maxSearchHits = v;
      }
      if (payload?.hitMaxChars !== undefined) {
        const v = Number(payload.hitMaxChars);
        if (!Number.isInteger(v) || v < 200 || v > 20000) {
          return { ok: false, error: { code: 'bad-request', message: 'hitMaxChars must be an integer 200–20000' } };
        }
        updates.hitMaxChars = v;
      }
      if (Object.keys(updates).length === 0) {
        return { ok: false, error: { code: 'bad-request', message: 'no fields to update' } };
      }
      try {
        await ctx.settings.update(name, updates);
        return { ok: true, value: { maxSearchHits: rawConfig.maxSearchHits.get(), hitMaxChars: rawConfig.hitMaxChars.get() } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.warn(`context-sniper: search params save failed (${message})`);
        return { ok: false, error: { code: 'persistence', message: `检索参数保存失败：${message}` } };
      }
    }
    if (endpoint === 'session-state') {
      const sid = String(payload?.sessionId ?? '');
      if (!sid) return { ok: false, error: { code: 'bad-request', message: 'sessionId required' } };
      const sessions = ctx.get?.('sessions');
      const session = sessions?.get?.(sid);
      const cwd = session?.header?.cwd;
      const { records, messages } = await countArchive(cfg, cwd, sid);
      const value = {
        sessionId: sid,
        cwd: cwd ?? null,
        archiveRecords: records,
        archiveMessages: messages,
        archivePath: resolveArchivePath(cfg, cwd, sid),
        surfaceTokenBudget: rawConfig.surfaceTokenBudget.get(),
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
  }

  ctx.inject(['webServer', 'connection'], (wctx) => {
    wctx.connection.rpc.handle(CHANNEL, (endpoint, payload) => handleRpcEndpoint(endpoint, payload));
    ctx.logger.info('context-sniper: RPC route /context-sniper registered via connection.rpc');
  });

  // ---------------------------------------------------------------------------
  // A small service face for other plugins / tests.
  // ---------------------------------------------------------------------------
  ctx.provide('contextSniper', {
    plugin: ARCHIVE_MARKER_PLUGIN,
    surfaceTokenBudget: () => rawConfig.surfaceTokenBudget.get(),
    setSurfaceTokenBudget: (value) => {
      if (Number.isInteger(value) && value >= 1024) return ctx.settings.update(name, { surfaceTokenBudget: value });
    },
    archiveFor: async (cwd, sessionId) => countArchive(cfg, cwd, sessionId),
  });
}
