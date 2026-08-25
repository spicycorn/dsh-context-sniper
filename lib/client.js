window.__ModuleLoader__.load({
	id: "dsh-context-sniper",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { createElement, useState, useEffect, useCallback } = React;

		const name = 'dsh-context-sniper';
		const inject = ['slots', 'connection'];

		// RPC helper: our host registers at path '/context-sniper'
		function rpcCall(rpc, method, args) {
			return rpc.call('/context-sniper', method, args);
		}

		function SettingsPanel(props) {
			const { close, rpc } = props;
			const [state, setState] = useState(null);
			const [error, setError] = useState(null);
			const [saving, setSaving] = useState(false);
			const [saved, setSaved] = useState(false);
			const [keepRounds, setKeepRounds] = useState('20');

			useEffect(() => {
				if (!rpc) return;
				let cancelled = false;
				rpcCall(rpc, 'get-state', {}).then((res) => {
					if (cancelled) return;
					if (res && res.ok) {
						setState(res.value);
						setKeepRounds(String(res.value.keepRounds));
						setError(null);
					} else {
						setError((res && res.error && res.error.message) || '加载失败');
					}
				}).catch((err) => {
					if (cancelled) return;
					setError(err && err.message ? err.message : String(err));
				});
				return () => { cancelled = true; };
			}, [rpc]);

			const handleSave = useCallback(() => {
				const value = parseInt(keepRounds, 10);
				if (!Number.isInteger(value) || value < 1) {
					setError('keepRounds 必须是正整数 (≥ 1)');
					return;
				}
				setSaving(true);
				setSaved(false);
				rpcCall(rpc, 'set-keep-rounds', { keepRounds: value }).then((res) => {
					if (res && res.ok) {
						setSaved(true);
						setError(null);
						setState((prev) => prev ? Object.assign({}, prev, { keepRounds: value }) : prev);
						setTimeout(() => setSaved(false), 2500);
					} else {
						setError((res && res.error && res.error.message) || '保存失败');
					}
					setSaving(false);
				}).catch((err) => {
					setError(err && err.message ? err.message : String(err));
					setSaving(false);
				});
			}, [keepRounds, rpc]);

			const labelStyle = { display: 'block', marginBottom: '6px', fontWeight: 500, fontSize: '13px' };
			const inputStyle = {
				width: '100px', padding: '6px 10px',
				border: '1px solid #d9d9d9', borderRadius: '6px',
				fontSize: '14px', boxSizing: 'border-box',
			};
			const rowStyle = { display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '13px' };

			return createElement('div', { style: { padding: '24px 28px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', fontSize: '14px', lineHeight: 1.6, maxWidth: '520px' } },
				// Title
				createElement('h2', { style: { margin: '0 0 4px 0', fontSize: '18px', fontWeight: 600 } }, '上下文狙击手'),
				createElement('p', { style: { color: '#888', margin: '0 0 24px 0', fontSize: '13px' } },
					'当上下文窗口溢出时，自动将较早的对话轮次归档到磁盘，仅保留最近的 N 轮在模型侧。',
				),

				// Error (if no state loaded)
				(error && !state) ? createElement('p', { style: { color: '#ff4d4f', padding: '12px', background: '#fff2f0', borderRadius: '6px', border: '1px solid #ffccc7' } },
					'无法加载配置: ' + error,
				) : null,

				// keepRounds field
				createElement('div', { style: { marginBottom: '20px' } },
					createElement('label', { style: labelStyle }, '保留轮数 (keepRounds)'),
					createElement('input', {
						type: 'number',
						min: 1,
						step: 1,
						value: keepRounds,
						onChange: (e) => setKeepRounds(e.target.value),
						onKeyDown: (e) => { if (e.key === 'Enter') handleSave(); },
						style: inputStyle,
					}),
					createElement('p', { style: { color: '#aaa', fontSize: '12px', margin: '6px 0 0 0' } },
						'上下文溢出时，模型侧仅保留最近 N 轮对话，其余归档到磁盘可检索。',
					),
				),

				// Read-only info
				state ? createElement('div', { style: { marginBottom: '24px', padding: '12px 16px', background: '#fafafa', borderRadius: '8px', border: '1px solid #f0f0f0' } },
					createElement('div', { style: rowStyle },
						createElement('span', { style: { color: '#666' } }, '默认保留轮数'),
						createElement('span', { style: { fontWeight: 500 } }, String(state.defaultKeepRounds)),
					),
					createElement('div', { style: rowStyle },
						createElement('span', { style: { color: '#666' } }, '最大搜索命中数'),
						createElement('span', { style: { fontWeight: 500 } }, String(state.maxSearchHits)),
					),
					createElement('div', { style: rowStyle },
						createElement('span', { style: { color: '#666' } }, '归档目录'),
						createElement('span', { style: { fontWeight: 500, fontFamily: 'monospace', fontSize: '12px' } }, state.archiveDir),
					),
				) : null,

				// Actions
				createElement('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
					createElement('button', {
						onClick: handleSave,
						disabled: saving || !rpc,
						style: {
							padding: '8px 20px',
							background: saving ? '#b0b0b0' : '#4a90d9',
							color: '#fff', border: 'none', borderRadius: '6px',
							fontSize: '14px', cursor: saving ? 'not-allowed' : 'pointer',
							transition: 'background 0.2s',
						},
					}, saving ? '保存中…' : '保存'),
					saved ? createElement('span', { style: { color: '#52c41a', fontSize: '13px' } }, '✓ 已保存') : null,
					(error && state) ? createElement('span', { style: { color: '#ff4d4f', fontSize: '13px' } }, error) : null,
				),
			);
		}

		function apply(ctx) {
			const connection = ctx.get('connection');
			const rpc = connection && connection.rpc;

			const injected = () => ({ rpc: rpc });

			ctx.slots.inject('settings.section', () => {
				const dispose = ctx.slots.register(
					{ name: 'settings.section', id: 'context-sniper', order: 25, label: '上下文狙击手', inject: injected },
					(props) => createElement(SettingsPanel, { close: props.close, rpc: props.rpc }),
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
