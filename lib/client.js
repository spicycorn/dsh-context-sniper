window.__ModuleLoader__.load({
	id: "dsh-context-sniper",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region client-api (inlined)
		const CONTEXT_SNIPER_RPC_CHANNEL = '/context-sniper';
		const CONTEXT_SNIPER_ENDPOINTS = Object.freeze({
			getState: 'get-state',
			setKeepRounds: 'set-keep-rounds',
			sessionState: 'session-state',
		});
		//#endregion
		//#region client
		const name = 'dsh-context-sniper';
		const inject = ['slots'];

		function formatTokens(n) {
			if (n === null || n === undefined || !Number.isFinite(n)) return '—';
			if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
			if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
			return String(n);
		}

		function Panel(props) {
			const { call, useSessions, close } = props;

			const [config, setConfig] = react.useState(null);
			const [sessionState, setSessionState] = react.useState(null);
			const [draft, setDraft] = react.useState('');
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);

			// useSessions is a standard prop of settings.section
			const listState = typeof useSessions === 'function' ? useSessions() : null;
			const sessionId = listState?.current ?? null;

			// Live pressure feed from the session projection
			let pressure = null;
			if (listState?.byId && sessionId) {
				const row = listState.byId[sessionId];
				pressure = row?.projectionValues?.contextPressure ?? null;
			}
			const windowTokens = pressure?.contextWindow ?? null;
			const projected = pressure?.projectedTokens ?? pressure?.pressureTokens ?? null;
			const pct = windowTokens && projected != null ? Math.min(100, Math.max(0, (projected / windowTokens) * 100)) : null;

			// Load config on mount
			react.useEffect(() => {
				let alive = true;
				call(CONTEXT_SNIPER_ENDPOINTS.getState, {})
					.then((res) => { if (alive && res?.ok) { setConfig(res.value); setDraft(String(res.value?.keepRounds ?? '')); } })
					.catch(() => {});
				return () => { alive = false; };
			}, [call]);

			// Load session archive state
			react.useEffect(() => {
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

			return react.createElement('div', { className: 'csniper' },
				// ── title ──
				react.createElement('h3', null, '上下文狙击手'),
				react.createElement('p', { className: 'csniper-desc' },
					'对话超出上下文窗口时，自动把较早的轮次完整归档到本地文件，模型可用检索工具随时找回。',
				),

				// ── context usage bar ──
				react.createElement('div', { className: 'csniper-block' },
					react.createElement('div', { className: 'csniper-label' },
						react.createElement('span', null, '上下文占用'),
						react.createElement('span', { className: 'csniper-value' },
							projected != null && windowTokens ? `${formatTokens(projected)} / ${formatTokens(windowTokens)}`
								: (sessionId ? '等待用量报告…' : '无活动会话'),
						),
					),
					react.createElement('div', { className: `csniper-bar csniper-bar-${tone}`, role: 'progressbar',
						'aria-valuenow': pct ?? undefined, 'aria-valuemin': 0, 'aria-valuemax': 100 },
						pct !== null ? react.createElement('div', { className: 'csniper-bar-fill', style: { width: `${pct}%` } }) : null,
					),
					react.createElement('p', { className: 'csniper-hint' }, '当前会话的 token 占用比例。接近 100% 时触发归档。'),
				),

				// ── keep rounds ──
				react.createElement('div', { className: 'csniper-block' },
					react.createElement('div', { className: 'csniper-label' },
						react.createElement('span', null, '保留轮数 N'),
						react.createElement('span', { className: 'csniper-value' },
							config ? `当前 ${config.keepRounds}（默认 ${config.defaultKeepRounds}）` : '…',
						),
					),
					react.createElement('p', { className: 'csniper-hint' },
						'溢出时保留最近 N 轮在模型上下文中，更早的轮次被完整归档。N 越大模型"记得"越多，但留给新内容的空间越少。',
					),
					react.createElement('div', { className: 'csniper-inputrow' },
						react.createElement('input', {
							className: 'csniper-input',
							type: 'number', min: 1, step: 1,
							value: draft,
							placeholder: 'N',
							'aria-label': '保留轮数',
							onChange: (e) => setDraft(e.target.value),
							onKeyDown: (e) => { if (e.key === 'Enter') applyKeepRounds(); },
						}),
						react.createElement('button', {
							className: 'csniper-btn',
							type: 'button',
							disabled: busy,
							onClick: applyKeepRounds,
						}, '应用'),
					),
				),

				// ── archive state ──
				react.createElement('div', { className: 'csniper-block' },
					react.createElement('div', { className: 'csniper-label' },
						react.createElement('span', null, '归档状态'),
						react.createElement('span', { className: 'csniper-value' },
							sessionState
								? `${sessionState.archiveRecords} 批 / ${sessionState.archiveMessages} 条消息`
								: (sessionId ? (busy ? '统计中…' : '本会话暂无归档') : '无活动会话'),
						),
					),
					sessionState?.archivePath
						? react.createElement('p', { className: 'csniper-hint csniper-path' }, sessionState.archivePath)
						: null,
					sessionState?.rounds != null
						? react.createElement('p', { className: 'csniper-hint' }, `当前表面 ${sessionState.rounds} 轮。`)
						: null,
					react.createElement('p', { className: 'csniper-hint' }, '归档文件存储在本地，按会话隔离，不会上传。'),
				),

				// ── recall hint ──
				react.createElement('div', { className: 'csniper-block' },
					react.createElement('div', { className: 'csniper-label' },
						react.createElement('span', null, '检索'),
					),
					react.createElement('p', { className: 'csniper-hint' },
						'被归档的内容不会丢失。模型在需要时调用 context_sniper_recall 工具，按关键词检索并返回原文片段。',
					),
				),

				error ? react.createElement('p', { className: 'csniper-error' }, error) : null,
			);
		}

		const PANEL_CSS = `
.csniper{font-size:14px;line-height:1.6;display:flex;flex-direction:column;gap:14px}
.csniper h3{margin:0;font-size:15px;font-weight:600}
.csniper-desc{margin:0;color:var(--color-text-secondary,#888);font-size:13px}
.csniper-block{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border:1px solid var(--color-border,#333);border-radius:8px}
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
.csniper-input{flex:0 0 90px;padding:5px 8px;border-radius:6px;border:1px solid var(--color-border,#444);background:var(--color-bg-subtle,#1b1b1b);color:inherit;font-size:13px}
.csniper-btn{padding:5px 14px;border-radius:6px;border:1px solid var(--color-border,#444);background:var(--color-bg-subtle,#2a2a2a);color:inherit;cursor:pointer;font-size:13px}
.csniper-btn:disabled{opacity:.6;cursor:default}
.csniper-hint{margin:0;color:var(--color-text-secondary,#888);font-size:12px;line-height:1.5}
.csniper-path{font-family:ui-monospace,monospace;word-break:break-all}
.csniper-error{margin:0;color:#f85149;font-size:12px}
`;

		function apply(ctx) {
			const styles = ctx.get('styles');
			try {
				if (styles?.insert) styles.insert(PANEL_CSS);
			} catch { /* styling is best-effort */ }

			const connection = ctx.get('connection');
			const rpc = connection?.rpc;
			const call = (endpoint, payload) => {
				if (!rpc?.call) {
					return Promise.resolve({ ok: false, error: { code: 'unavailable', message: 'host connection unavailable' } });
				}
				return Promise.resolve(rpc.call(CONTEXT_SNIPER_RPC_CHANNEL, endpoint, payload));
			};

			ctx.slots.inject('settings.section', () => {
				const dispose = ctx.slots.register(
					{ name: 'settings.section', id: 'context-sniper', order: 25, label: () => '上下文狙击手' },
					(props) => react.createElement(Panel, {
						call,
						useSessions: props?.useSessions,
						close: props?.close,
					}),
				);
				if (typeof dispose === 'function') return dispose;
			});
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
