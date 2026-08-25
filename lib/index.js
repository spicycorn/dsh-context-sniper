// dsh-context-sniper — host half.
//
// A lossless context-saver for long DSH conversations. When the model request
// overflows the provider's context window (the "已重试模型请求 / 上下文输出已满"
// situation), this plugin:
//
//   1. keeps only the newest N rounds in the model surface,
//   2. archives the older rounds VERBATIM to a durable per-session file,
//   3. rewrites the surface with one compact marker pointing the model at the
//      recall tool,
//   4. authorizes the retry.
//
// If it cannot free enough (or the surface is already minimal) it falls
// through to the built-in dsh-compaction-basic summarizer as the safety net.
//
// The single user-facing knob is `keepRounds` (N). It is editable at runtime
// through the settings panel, and also through the DSH settings document.

import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { resolveConfig, ARCHIVE_MARKER_PLUGIN } from './config.js';
import { groupRounds, archiveRounds } from './select.js';
import { searchArchive, countArchive, hasArchive, resolveArchivePath } from './archive.js';

const SETTINGS_NS = settingsNamespace('dsh-context-sniper');

const name = 'dsh-context-sniper';
// `tools` is the one hard dependency: without it the recall tool cannot exist.
// Everything else (settings, sessionProjections, connection, tokenMeter) is
// optional and read with ctx.get / ctx.inject so the plugin degrades cleanly.
const inject = ['tools'];

export { name, inject };

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config);

  // Live, hot-reloadable value of keepRounds. Seeded from the composition
  // config; moved by the settings service (if present) and the client RPC.
  const live = { keepRounds: cfg.keepRounds };

  // ---------------------------------------------------------------------------
  // Core archival: keep the newest N rounds, archive the rest, rewrite surface.
  // Returns `{ archived, ... }` when something was moved out, or `null` when
  // there was nothing safe to archive (the caller then falls through).
  // ---------------------------------------------------------------------------
  async function tryArchive(session, keepRounds, reason) {
    const { rounds } = groupRounds(session);
    if (rounds.length <= 1) return null; // nothing older to move

    const target = Math.max(1, Math.floor(keepRounds));
    const keep = rounds.slice(-target);
    const toArchive = rounds.slice(0, rounds.length - keep.length);

    // Never archive the round currently being worked on, and never leave the
    // model with fewer than one round.
    const lastRound = rounds[rounds.length - 1];
    const safeToArchive = toArchive.filter((r) => r.turn !== lastRound.turn);
    if (safeToArchive.length === 0) return null;

    const result = await archiveRounds(session, cfg, safeToArchive, keepRounds, reason);
    if (result && cfg.verbose) {
      ctx.logger.info(
        `context-sniper (${reason}): archived ${result.roundTurns.length} round(s) / ${result.archived} message(s) ` +
        `(seqs ${result.fromSeq}-${result.toSeq}), kept ${keep.length} round(s)`,
      );
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Overflow recovery: the primary trigger.
  //
  // `prepend: true` makes this listener the outermost wrapper of the waterfall,
  // so it acts before the built-in compaction. If it frees context it returns a
  // terminal `{ kind: "retry" }` (compaction never runs); otherwise it calls
  // next() and lets the lossy summarizer handle the remainder.
  // ---------------------------------------------------------------------------
  ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
    const code = failure?.code;
    if (code !== 'CONTEXT_WINDOW_EXCEEDED' || signal?.aborted) return next();
    try {
      const result = await tryArchive(agent.session, live.keepRounds, 'context-overflow');
      if (result) return { kind: 'retry' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.warn(`context-sniper: archival failed (${message}); deferring to compaction`);
    }
    return next();
  }, { prepend: true });

  // ---------------------------------------------------------------------------
  // Optional proactive pressure path. Off by default (pressureRatio: 0). When
  // enabled, archive a step early once measured pressure crosses the fraction of
  // the routed context window, avoiding the hard provider failure entirely.
  // ---------------------------------------------------------------------------
  if (cfg.pressureRatio > 0) {
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (signal?.aborted) return next();
      const meter = ctx.get('tokenMeter');
      if (meter === undefined) return next();
      try {
        const measured = meter.measure(agent.session);
        const llm = ctx.get('llm');
        const route = agent?.options ?? {};
        let windowTokens = 0;
        if (llm && route.provider && route.model) {
          try {
            const info = await llm.resolveModelInfo(route.provider, route.model);
            windowTokens = info?.context ?? 0;
          } catch { windowTokens = 0; }
        }
        const threshold = windowTokens > 0 ? Math.floor(windowTokens * cfg.pressureRatio) : 0;
        if (threshold > 0 && measured.totalTokens >= threshold) {
          await tryArchive(agent.session, live.keepRounds, 'pressure');
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
      'Search the dsh-context-sniper archive of earlier conversation rounds that were ' +
      'moved out of context to free the window. Use it whenever you need facts, decisions, ' +
      'file contents, or instructions from earlier in THIS session that are no longer visible ' +
      'in the current context. Provide a short keyword query; matching archived messages are ' +
      'returned verbatim, newest first. If the result is empty, the content was never ' +
      'archived (or the query does not match) — try a different term or ask the user.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'One or more keywords to search for in the archived rounds (case-insensitive).',
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
      if (!(await hasArchive(cfg, session.id))) {
        return {
          query: String(args.query),
          hitCount: 0,
          archiveMessages: 0,
          hits: [],
          note: 'No archived rounds yet for this session.',
        };
      }
      const { hits } = await searchArchive(cfg, session.id, String(args.query), {
        maxHits: cfg.maxSearchHits,
        hitMaxChars: cfg.hitMaxChars,
      });
      const { messages } = await countArchive(cfg, session.id);
      return {
        query: String(args.query),
        hitCount: hits.length,
        archiveMessages: messages,
        hits,
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
  // Settings: durable, hot-reloadable keepRounds. Registered under the DSH
  // settings service so it survives restarts and is hand-editable. Optional —
  // if the settings service is absent the live value simply stays at the
  // composition default and the client RPC still works for the session.
  // ---------------------------------------------------------------------------
  const settings = ctx.get('settings');
  let scope = null;
  if (settings !== undefined && typeof settings.register === 'function') {
    try {
      const schema = z.object({
        keepRounds: z.number().step(1).min(1).default(cfg.keepRounds),
      });
      scope = settings.register(SETTINGS_NS, schema, { base: { keepRounds: cfg.keepRounds } });
      const current = settings.get(SETTINGS_NS);
      if (current && Number.isInteger(current.keepRounds)) live.keepRounds = current.keepRounds;
      scope.watch((next) => {
        if (next && Number.isInteger(next.keepRounds)) live.keepRounds = next.keepRounds;
      });
    } catch (error) {
      ctx.logger.warn(`context-sniper: settings registration skipped (${error?.message ?? error})`);
    }
  }

  // ---------------------------------------------------------------------------
  // Client RPC: the settings panel reads state and writes keepRounds through
  // this loopback channel. Uses ctx.inject so the route is registered AFTER the
  // connection service is available (activation-order safe).
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
              keepRounds: live.keepRounds,
              defaultKeepRounds: cfg.keepRounds,
              maxSearchHits: cfg.maxSearchHits,
              archiveDir: cfg.archiveDir,
            },
          };
        }
        if (endpoint === 'set-keep-rounds') {
          const value = Number(payload?.keepRounds);
          if (!Number.isInteger(value) || value < 1) {
            return { ok: false, error: { code: 'bad-request', message: 'keepRounds must be a positive integer' } };
          }
          live.keepRounds = value;
          if (scope && typeof scope.update === 'function') {
            try { await scope.update({ keepRounds: value }); }
            catch (error) { rpcCtx.logger.warn(`context-sniper: settings update failed (${error?.message ?? error})`); }
          }
          return { ok: true, value: { keepRounds: value } };
        }
        if (endpoint === 'session-state') {
          const sid = String(payload?.sessionId ?? '');
          if (!sid) return { ok: false, error: { code: 'bad-request', message: 'sessionId required' } };
          const { records, messages } = await countArchive(cfg, sid);
          const value = {
            sessionId: sid,
            archiveRecords: records,
            archiveMessages: messages,
            archivePath: resolveArchivePath(cfg, sid),
            keepRounds: live.keepRounds,
            pressureTokens: null,
            contextWindow: null,
          };
          const session = rpcCtx.get?.('sessions')?.get?.(sid);
          const meter = rpcCtx.get?.('tokenMeter');
          if (session && meter && typeof meter.measure === 'function') {
            try {
              const measured = meter.measure(session);
              value.pressureTokens = measured.totalTokens;
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
    keepRounds: () => live.keepRounds,
    setKeepRounds: (value) => {
      if (Number.isInteger(value) && value >= 1) live.keepRounds = value;
    },
    archiveFor: async (sessionId) => countArchive(cfg, sessionId),
  });
}
