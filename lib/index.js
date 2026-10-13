// dsh-context-sniper — host half.
//
// A lossless context-saver for long DSH conversations. When the model request
// times out (local model prefill too slow), overflows the context window, or
// a turn ends at the output-token cap — the UI banner "已达到输出 token 上限"
// is driven host-side by a `turn/end` event with `reason.kind === 'max-tokens'`
// — this plugin:
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

import { createRequire } from 'node:module';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { resolveConfig, ARCHIVE_MARKER_PLUGIN } from './config.js';
import { archiveByTokenBudget, groupRounds } from './select.js';
import { searchArchive, countArchive, hasArchive, resolveArchivePath, scanGlobalStats } from './archive.js';

const require_ = createRequire(import.meta.url);
/** Own package version, surfaced to the settings panel header chip. */
const PLUGIN_VERSION = (() => {
  try {
    return require_('../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

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
    // A cancelled request must never be retried, whatever the failure code is
    // (mirrors how dsh-compaction-basic treats `signal.aborted` as terminal).
    if (signal?.aborted) return next();
    const code = failure?.code;
    const isOverflow = code === 'CONTEXT_WINDOW_EXCEEDED';
    const isTimeout = TIMEOUT_CODES.has(code);
    if (!isOverflow && !isTimeout) return next();
    const reason = isOverflow ? 'context-overflow' : 'timeout';
    // Only authorize the retry when the replacement actually COMMITTED:
    // retrying against an unchanged surface just burns another timeout.
    // (dsh-compaction-basic gates its retry on the same counter.)
    const generation = agent.session.surface?.replaceGeneration ?? 0;
    try {
      const result = await tryArchiveByBudget(agent.session, reason);
      if (result && (agent.session.surface?.replaceGeneration ?? 0) > generation) {
        ctx.logger.info(`context-sniper: ${reason} recovery — archived ${result.archived} msg(s), retrying with smaller input`);
        return { kind: 'retry' };
      }
      if (result) {
        ctx.logger.warn(`context-sniper: ${reason} archival wrote no surface change; deferring to compaction`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail = cfg.verbose && error instanceof Error && error.stack ? `\n${error.stack}` : '';
      ctx.logger.warn(`context-sniper: archival failed (${message})${detail}; deferring`);
    }
    return next();
  }, { prepend: true });

  // ---------------------------------------------------------------------------
  // Output truncation detection + auto-continue.
  //
  // Two triggers cover the same failure (the model hit its output cap):
  //
  //  1. `max-tokens` (authoritative): the agent loop closes the turn with
  //     `turn/end { reason: { kind: 'max-tokens' } }` as soon as any step's
  //     stream finished at the output-token ceiling (TurnEndReasonMap in
  //     @deepseek-ai/dsh-session). This is EXACTLY the event the chat UI
  //     renders as "已达到输出 token 上限 / Output token limit reached" —
  //     dsh-client-ui-chat's turn-max-tokens notice matches on the same
  //     event type + reason — so reacting here means reacting at the very
  //     moment the banner appears.
  //  2. `output-truncation` (heuristic): a usage / ending-style guess on the
  //     closing assistant message, for providers that truncate without
  //     reporting the finish reason.
  //
  // Both triggers share one per-turn claim (`truncationTurns`) so a single
  // truncated turn is archived and continued at most once, whichever fires
  // first. The trim itself always runs; the auto-continue is capped by
  // `MAX_AUTO_CONTINUE`.
  // ---------------------------------------------------------------------------
  const MAX_AUTO_CONTINUE = 3;
  const continueCounts = new Map(); // sessionId → count
  const truncationTurns = new Map(); // sessionId → last turn claimed by a truncation trigger

  /** Claim (session, turn) for truncation handling; false when already claimed. */
  function claimTruncationTurn(sessionId, turn) {
    if (!Number.isInteger(turn)) return true; // no usable turn number: nothing to dedup against
    if (truncationTurns.get(sessionId) === turn) return false;
    truncationTurns.set(sessionId, turn);
    return true;
  }

  /** Queue the "please continue" followup on the live agent (budget checked by caller). */
  function dispatchAutoContinue(session) {
    const live_agent = ctx.agents?.get?.(session.id);
    if (!live_agent || typeof live_agent.followup !== 'function') return;
    // `source.kind` must NOT be 'user' — the reset listener below treats a
    // user-sourced message as real user input and clears the continue
    // counter, which would let the auto-continue loop run unbounded.
    // It must also NOT be the retired 'plugin' kind: session-format v4 rejects
    // it at persistence-encode time ("format v4 message requires a
    // producer-owned source kind"), which poisons every later flush of the
    // live session. Producers own a kind (goal, schedule, …); ours is
    // 'context-sniper', shared with the archive marker in select.js.
    const msg = {
      id: `context-sniper-continue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      content: [{ type: 'text', text: '请继续完成上一步未完成的输出。' }],
      source: { kind: 'context-sniper', purpose: 'auto-continue' },
    };
    try {
      live_agent.followup(msg);
      ctx.logger.info('context-sniper: auto-continue dispatched');
    } catch (error) {
      ctx.logger.warn(`context-sniper: auto-continue failed (${error?.message ?? error})`);
    }
  }

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

    // The authoritative turn/end trigger may already have handled this turn.
    const turn = event.data?.turn;
    if (Number.isInteger(turn) && truncationTurns.get(session.id) === turn) return;

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

    // Claim the turn. The async context-window resolution above opened a
    // window where the authoritative turn/end trigger could have claimed
    // this same turn first — re-check before acting.
    if (!claimTruncationTurn(session.id, turn)) return;

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
    dispatchAutoContinue(session);
  });

  // ---------------------------------------------------------------------------
  // Authoritative output-cap trigger. Fires at the exact moment the chat UI
  // shows "已达到输出 token 上限": that banner is rendered from this very
  // `turn/end` event (`reason.kind === 'max-tokens'`), emitted by
  // dsh-agent-loop when a step's stream finished at the output-token cap.
  // Trim to the surface budget, then auto-continue within the shared budget.
  // ---------------------------------------------------------------------------
  ctx.on('session/event', async (session, event) => {
    if (event.type !== 'turn/end') return;
    if (event.data?.reason?.kind !== 'max-tokens') return;
    // One archive + continue per turn, shared with the heuristic trigger.
    if (!claimTruncationTurn(session.id, event.data?.turn)) return;
    const count = continueCounts.get(session.id) ?? 0;
    ctx.logger.info(
      `context-sniper: output token cap reached (turn ${event.data?.turn}, ` +
      `attempt ${Math.min(count + 1, MAX_AUTO_CONTINUE)}/${MAX_AUTO_CONTINUE}) — archiving to free context`,
    );
    try {
      await tryArchiveByBudget(session, 'max-tokens');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.warn(`context-sniper: max-tokens archival failed (${message})`);
    }
    // The trim runs even when the continue budget is spent; only the
    // followup is capped.
    if (count >= MAX_AUTO_CONTINUE) return;
    continueCounts.set(session.id, count + 1);
    dispatchAutoContinue(session);
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

  // Drop per-session bookkeeping when the session goes away (no Map leak).
  ctx.on('session/disposed', (session) => {
    continueCounts.delete(session.id);
    truncationTurns.delete(session.id);
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
      kind: 'search',
      rawInput: { query: args.query },
    }),
  }));

  // ---------------------------------------------------------------------------
  // Client RPC: the settings panel reads state and writes budget through a
  // dedicated `/context-sniper` channel.
  //
  // Why a direct prefix route instead of the Connection helpers:
  //  * `rpc.intercept('/api', …)` — the host's Typert gateway registers the
  //    single shared `/api` interceptor at startup; dsh-client-connection
  //    allows exactly ONE interceptor per channel and throws on a second
  //    registration, which silently killed our endpoints (the settings panel
  //    showed "统计加载失败" / stats load failed on every call).
  //  * `rpc.handle(channel, …)` — resolves `webServer` from the Connection
  //    service's OWN ctx, where webServer is a sibling rather than an
  //    ancestor, so the route never mounts (the v0.8.0 HTTP 405).
  // Registering the prefix route on the injected webServer is the established
  // plugin pattern (dshmarket, dsh-better-sidebar); we answer the identical
  // `client-request` envelope the browser's `connection.rpc.call` emits,
  // behind the same admission gate the Connection channels apply.
  // ---------------------------------------------------------------------------

  async function handleRpcEndpoint(endpoint, payload = {}) {
    if (endpoint === 'get-state') {
      return {
        ok: true,
        value: {
          version: PLUGIN_VERSION,
          surfaceTokenBudget: rawConfig.surfaceTokenBudget.get(),
          defaultBudget: cfg.surfaceTokenBudget,
          maxSearchHits: rawConfig.maxSearchHits.get(),
          hitMaxChars: rawConfig.hitMaxChars.get(),
          pressureRatio: cfg.pressureRatio,
          verbose: cfg.verbose,
          archiveDir: cfg.archiveDir,
        },
      };
    }
    if (endpoint === 'stats') {
      try {
        const stats = await scanGlobalStats(cfg);
        return { ok: true, value: stats };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.warn(`context-sniper: stats scan failed (${message})`);
        return { ok: false, error: { code: 'scan-failed', message, details: {} } };
      }
    }
    if (endpoint === 'set-budget') {
      const value = Number(payload?.budget);
      if (!Number.isInteger(value) || value < 1024) {
        return { ok: false, error: { code: 'bad-request', message: 'budget must be an integer ≥ 1024', details: {} } };
      }
      try {
        await ctx.settings.update(name, { surfaceTokenBudget: value });
        return { ok: true, value: { surfaceTokenBudget: value } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.warn(`context-sniper: budget save failed (${message})`);
        return { ok: false, error: { code: 'persistence', message: `预算保存失败：${message}`, details: {} } };
      }
    }
    if (endpoint === 'set-search') {
      const updates = {};
      if (payload?.maxSearchHits !== undefined) {
        const v = Number(payload.maxSearchHits);
        if (!Number.isInteger(v) || v < 1 || v > 64) {
          return { ok: false, error: { code: 'bad-request', message: 'maxSearchHits must be an integer 1–64', details: {} } };
        }
        updates.maxSearchHits = v;
      }
      if (payload?.hitMaxChars !== undefined) {
        const v = Number(payload.hitMaxChars);
        if (!Number.isInteger(v) || v < 200 || v > 20000) {
          return { ok: false, error: { code: 'bad-request', message: 'hitMaxChars must be an integer 200–20000', details: {} } };
        }
        updates.hitMaxChars = v;
      }
      if (Object.keys(updates).length === 0) {
        return { ok: false, error: { code: 'bad-request', message: 'no fields to update', details: {} } };
      }
      try {
        await ctx.settings.update(name, updates);
        return { ok: true, value: { maxSearchHits: rawConfig.maxSearchHits.get(), hitMaxChars: rawConfig.hitMaxChars.get() } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.warn(`context-sniper: search params save failed (${message})`);
        return { ok: false, error: { code: 'persistence', message: `检索参数保存失败：${message}`, details: {} } };
      }
    }
    if (endpoint === 'session-state') {
      const sid = String(payload?.sessionId ?? '');
      if (!sid) return { ok: false, error: { code: 'bad-request', message: 'sessionId required', details: {} } };
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
    return { ok: false, error: { code: 'bad-request', message: `Unknown endpoint: ${endpoint}`, details: {} } };
  }

  const RPC_CHANNEL = '/context-sniper';
  const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/;
  ctx.inject(['connection', 'webServer'], (webCtx) => {
    const connection = webCtx.connection;

    async function readJsonBody(req) {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) return { error: 413 };
        chunks.push(chunk);
      }
      try {
        return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
      } catch {
        return { error: 400 };
      }
    }

    function json(res, status, payload) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    }

    async function handleRpcRoute(req, res) {
      // Same admission gate the Connection channels apply (Host/Origin fence
      // + browser auth). Fail closed if the host exposes no gate.
      try {
        const admission = connection.admit?.(req);
        if (admission && 'rejection' in admission) {
          res.writeHead(admission.rejection);
          res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
          return;
        }
      } catch {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }

      const pathname = (req.url ?? '').split('?')[0];
      const endpoint = pathname.startsWith(`${RPC_CHANNEL}/`) ? pathname.slice(RPC_CHANNEL.length + 1) : undefined;
      if (req.method !== 'POST' || !endpoint || !ENDPOINT_SEGMENT.test(endpoint)) {
        json(res, 404, { error: 'not found' });
        return;
      }
      const contentType = String(req.headers['content-type'] ?? '');
      if (contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        json(res, 415, { error: 'content type must be application/json' });
        return;
      }
      const parsed = await readJsonBody(req);
      if (parsed.error) {
        json(res, parsed.error, { error: parsed.error === 400 ? 'body is not JSON' : 'body too large' });
        return;
      }
      const message = parsed.body;
      const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : '';
      if (message?.type !== 'client-request' || typeof message.rpcId !== 'string' || typeof message.method !== 'string') {
        json(res, 200, { type: 'server-response', rpcId, result: { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: [] } } } });
        return;
      }
      if (message.method !== endpoint) {
        json(res, 200, { type: 'server-response', rpcId, result: { ok: false, error: { code: 'gateway/bad-request', message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`, details: { issues: [] } } } });
        return;
      }
      let result;
      try {
        result = await handleRpcEndpoint(endpoint, message.payload ?? {});
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        ctx.logger.warn(`context-sniper: rpc ${endpoint} failed (${detail})`);
        result = { ok: false, error: { code: 'internal', message: detail, details: {} } };
      }
      json(res, 200, { type: 'server-response', rpcId, result });
    }

    // The route disposer rides this inject fiber: unloading the plugin
    // removes the route instead of leaving a dangling handler.
    return webCtx.webServer.register({ kind: 'prefix', path: RPC_CHANNEL, handler: handleRpcRoute });
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
