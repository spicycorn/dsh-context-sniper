// dsh-context-sniper — client half.
//
// Registers one Settings section ("Context Sniper") with:
//   • a live token progress bar (from the token-meter's contextPressure feed),
//   • the current retained-rounds (N) and an input to change it,
//   • the archive record/message count for the active session,
//   • a "recall" hint pointing at the context_sniper_recall tool.
//
// All host communication goes through the loopback RPC channel declared in
// client-api.js. The panel degrades gracefully when a feed or the connection
// is unavailable.

import { CONTEXT_SNIPER_RPC_CHANNEL, CONTEXT_SNIPER_ENDPOINTS } from './client-api.js';

const name = 'dsh-context-sniper';
const inject = ['slots'];

function formatTokens(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function Panel(props) {
  const { call, useSessions, ctx } = props;

  const [config, setConfig] = React.useState(null);
  const [sessionState, setSessionState] = React.useState(null);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);

  // The useSessions standard hook is the reactive feed: list + current selection.
  const listState = typeof useSessions === 'function' ? useSessions() : null;
  const sessionId = listState?.current ?? (ctx?.sessions?.list?.current);

  // Live pressure feed (token-meter projection), read off the session summary.
  let pressure = null;
  if (listState?.byId && sessionId) {
    const row = listState.byId[sessionId];
    pressure = row?.projectionValues?.contextPressure ?? null;
  }
  const windowTokens = pressure?.contextWindow ?? null;
  const projected = pressure?.projectedTokens ?? pressure?.pressureTokens ?? null;
  const pct = windowTokens && projected != null ? Math.min(100, Math.max(0, (projected / windowTokens) * 100)) : null;

  React.useEffect(() => {
    let alive = true;
    call(CONTEXT_SNIPER_ENDPOINTS.getState, {})
      .then((res) => { if (alive && res?.ok) { setConfig(res.value); setDraft(String(res.value?.keepRounds ?? '')); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [call]);

  React.useEffect(() => {
    let alive = true;
    setError(null);
    if (!sessionId) { setSessionState(null); return; }
    setBusy(true);
    call(CONTEXT_SNIPER_ENDPOINTS.sessionState, { sessionId })
      .then((res) => { if (alive && res?.ok) setSessionState(res.value); else if (alive) setSessionState(null); })
      .catch(() => { if (alive) setSessionState(null); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [call, sessionId]);

  function applyKeepRounds() {
    const value = Number(draft);
    if (!Number.isInteger(value) || value < 1) { setError('保留轮数必须是 ≥1 的整数'); return; }
    setBusy(true);
    setError(null);
    call(CONTEXT_SNIPER_ENDPOINTS.setKeepRounds, { keepRounds: value })
      .then((res) => {
        if (res?.ok) {
          if (config) setConfig({ ...config, keepRounds: value });
        } else {
          setError(res?.error?.message ?? '保存失败');
        }
      })
      .catch((e) => setError(e?.message ?? String(e)))
      .finally(() => setBusy(false));
  }

  const tone = pct === null ? 'unknown' : pct >= 85 ? 'high' : pct >= 60 ? 'mid' : 'low';

  return React.createElement('div', { className: 'csniper' },
    React.createElement('h3', null, 'Context Sniper · 上下文狙击手'),
    React.createElement('p', { className: 'csniper-desc' },
      '当上下文溢出时，自动归档较早的对话轮次（保留最近 N 轮），被归档的内容可被 context_sniper_recall 工具检索回来。',
    ),

    // ── token progress ──
    React.createElement('div', { className: 'csniper-block' },
      React.createElement('div', { className: 'csniper-label' },
        React.createElement('span', null, '上下文占用 · context'),
        React.createElement('span', { className: 'csniper-value' },
          projected != null && windowTokens ? `${formatTokens(projected)} / ${formatTokens(windowTokens)} tokens`
            : (sessionId ? '等待 provider 报告用量…' : '尚无活动会话'),
        ),
      ),
      React.createElement('div', { className: `csniper-bar csniper-bar-${tone}`, role: 'progressbar',
        'aria-valuenow': pct ?? undefined, 'aria-valuemin': 0, 'aria-valuemax': 100 },
        pct !== null ? React.createElement('div', { className: 'csniper-bar-fill', style: { width: `${pct}%` } }) : null,
      ),
    ),

    // ── retained rounds (N) ──
    React.createElement('div', { className: 'csniper-block' },
      React.createElement('div', { className: 'csniper-label' },
        React.createElement('span', null, '保留轮数 · keep rounds'),
        React.createElement('span', { className: 'csniper-value' },
          config ? `当前 ${config.keepRounds} 轮（默认 ${config.defaultKeepRounds}）` : '…',
        ),
      ),
      React.createElement('div', { className: 'csniper-inputrow' },
        React.createElement('input', {
          className: 'csniper-input',
          type: 'number', min: 1, step: 1,
          value: draft,
          placeholder: 'N',
          'aria-label': '保留轮数',
          onChange: (e) => setDraft(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') applyKeepRounds(); },
        }),
        React.createElement('button', {
          className: 'csniper-btn',
          type: 'button',
          disabled: busy,
          onClick: applyKeepRounds,
        }, '应用'),
      ),
      React.createElement('p', { className: 'csniper-hint' }, '溢出时只保留最近 N 轮；更早的轮次被完整归档。'),
    ),

    // ── archive state for the active session ──
    React.createElement('div', { className: 'csniper-block' },
      React.createElement('div', { className: 'csniper-label' },
        React.createElement('span', null, '归档 · archive'),
        React.createElement('span', { className: 'csniper-value' },
          sessionState
            ? `${sessionState.archiveRecords} 批 / ${sessionState.archiveMessages} 条消息`
            : (sessionId ? (busy ? '统计中…' : '本会话暂无归档') : '尚无活动会话'),
        ),
      ),
      sessionState?.archivePath
        ? React.createElement('p', { className: 'csniper-hint csniper-path' }, sessionState.archivePath)
        : null,
      sessionState?.rounds != null
        ? React.createElement('p', { className: 'csniper-hint' }, `当前表面共 ${sessionState.rounds} 轮。`)
        : null,
    ),

    // ── recall hint ──
    React.createElement('div', { className: 'csniper-block' },
      React.createElement('p', { className: 'csniper-hint' },
        '需要被归档的内容时，模型可用 context_sniper_recall 工具按关键词检索；返回匹配的消息原文。',
      ),
    ),

    error ? React.createElement('p', { className: 'csniper-error' }, error) : null,
  );
}

const PANEL_CSS = `
.csniper{font-size:14px;line-height:1.5;display:flex;flex-direction:column;gap:14px}
.csniper h3{margin:0;font-size:15px;font-weight:600}
.csniper-desc{margin:0;color:var(--color-text-secondary,#888);font-size:13px}
.csniper-block{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--color-border,#333);border-radius:8px}
.csniper-label{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.csniper-label>span:first-child{font-weight:500}
.csniper-value{color:var(--color-text-secondary,#999);font-size:12px;font-variant-numeric:tabular-nums}
.csniper-bar{height:8px;border-radius:999px;background:var(--color-bg-subtle,#222);overflow:hidden}
.csniper-bar-fill{height:100%;border-radius:999px;transition:width .3s ease}
.csniper-bar-low .csniper-bar-fill{background:#3fb950}
.csniper-bar-mid .csniper-bar-fill{background:#d29922}
.csniper-bar-high .csniper-bar-fill{background:#f85149}
.csniper-bar-unknown .csniper-bar-fill{background:#666}
.csniper-inputrow{display:flex;gap:8px;align-items:center}
.csniper-input{flex:0 0 90px;padding:5px 8px;border-radius:6px;border:1px solid var(--color-border,#444);background:var(--color-bg-subtle,#1b1b1b);color:inherit}
.csniper-btn{padding:5px 14px;border-radius:6px;border:1px solid var(--color-border,#444);background:var(--color-bg-subtle,#2a2a2a);color:inherit;cursor:pointer}
.csniper-btn:disabled{opacity:.6;cursor:default}
.csniper-hint{margin:0;color:var(--color-text-secondary,#888);font-size:12px}
.csniper-path{font-family:ui-monospace,monospace;word-break:break-all}
.csniper-error{margin:0;color:#f85149;font-size:12px}
`;

function apply(ctx) {
  // Package-owned styles (cleaned up with the client run when the host provides it).
  try {
    if (ctx?.styles?.insert) ctx.styles.insert(PANEL_CSS);
  } catch { /* styling is best-effort */ }

  // Loopback RPC to this plugin's host half.
  const rpc = ctx?.connection?.rpc;
  const call = (endpoint, payload) => {
    if (!rpc?.call) {
      return Promise.resolve({ ok: false, error: { code: 'unavailable', message: 'host connection unavailable' } });
    }
    return Promise.resolve(rpc.call(CONTEXT_SNIPER_RPC_CHANNEL, endpoint, payload));
  };

  ctx.slots.inject('settings.section', () => {
    const dispose = ctx.slots.register(
      { name: 'settings.section', id: 'context-sniper', order: 25, label: () => 'Context Sniper' },
      (props) => React.createElement(Panel, {
        call,
        ctx,
        useSessions: props?.useSessions,
        close: props?.close,
      }),
    );
    if (typeof dispose === 'function') return dispose;
  });
}

export { name, inject, apply };
