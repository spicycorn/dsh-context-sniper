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

		function rpcCall(rpc, method, args) {
			return rpc.call('/context-sniper', method, args);
		}

		function SettingsPanel(props) {
			const { close, rpc } = props;
			const [state, setState] = useState(null);
			const [error, setError] = useState(null);
			const [saving, setSaving] = useState(false);
			const [saved, setSaved] = useState(false);
			const [budget, setBudget] = useState('32768');

			useEffect(() => {
				if (!rpc) return;
				let cancelled = false;
				rpcCall(rpc, 'get-state', {}).then((res) => {
					if (cancelled) return;
					if (res && res.ok) {
						setState(res.value);
						setBudget(String(res.value.surfaceTokenBudget));
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
				const value = parseInt(budget, 10);
				if (!Number.isInteger(value) || value < 1024) {
					setError('Token 预算必须是 ≥ 1024 的整数');
					return;
				}
				setSaving(true);
				setSaved(false);
				rpcCall(rpc, 'set-budget', { budget: value }).then((res) => {
					if (res && res.ok) {
						setSaved(true);
						setError(null);
						setState((prev) => prev ? Object.assign({}, prev, { surfaceTokenBudget: value }) : prev);
						setTimeout(() => setSaved(false), 2500);
					} else {
						setError((res && res.error && res.error.message) || '保存失败');
					}
					setSaving(false);
				}).catch((err) => {
					setError(err && err.message ? err.message : String(err));
					setSaving(false);
				});
			}, [budget, rpc]);

			const labelStyle = { display: 'block', marginBottom: '6px', fontWeight: 500, fontSize: '13px' };
			const inputStyle = { width: '110px', padding: '6px 10px', border: '1px solid #d9d9d9', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' };
			const rowStyle = { display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '13px' };
			const featStyle = { fontSize: '12px', color: '#666', margin: '0 0 2px 0', padding: '3px 0' };

			return createElement('div', { style: { padding: '24px 28px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', fontSize: '14px', lineHeight: 1.6, maxWidth: '520px' } },
				// Title + version
				createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '4px' } },
					createElement('h2', { style: { margin: '0', fontSize: '18px', fontWeight: 600 } }, '上下文狙击手'),
					createElement('span', { style: { fontSize: '12px', color: '#aaa' } }, 'v0.5.0'),
				),
				createElement('p', { style: { color: '#888', margin: '0 0 16px 0', fontSize: '13px' } },
					'本地大模型超时/截断自动恢复 + 按项目隔离的无损上下文归档检索。',
				),
				// Features
				createElement('div', { style: { marginBottom: '20px', padding: '10px 14px', background: '#f6f8fa', borderRadius: '8px', border: '1px solid #e8e8e8' } },
					createElement('p', { style: featStyle }, '✓ 超时恢复：拦截 TIMEOUT → 按 Token 预算归档 → 立即重试'),
					createElement('p', { style: featStyle }, '✓ 截断继续：检测截断 → 腾空间 → 自动"请继续"（≤3次）'),
					createElement('p', { style: featStyle }, '✓ 溢出恢复：CONTEXT_WINDOW_EXCEEDED → 归档 → 重试'),
					createElement('p', { style: featStyle }, '✓ 项目隔离：归档按项目目录分存，互不干扰'),
				createElement('p', { style: Object.assign({}, featStyle, { marginBottom: '0' }) }, '✓ 无损检索：context_sniper_recall 搜索已归档内容'),
				),
				// Error
				(error && !state) ? createElement('p', { style: { color: '#ff4d4f', padding: '12px', background: '#fff2f0', borderRadius: '6px', border: '1px solid #ffccc7', marginBottom: '16px' } },
					'无法加载配置: ' + error,
				) : null,
				// Token budget
				createElement('div', { style: { marginBottom: '20px' } },
					createElement('label', { style: labelStyle }, '表面 Token 预算'),
					createElement('input', {
						type: 'number', min: 1024, step: 1024, value: budget,
						onChange: (e) => setBudget(e.target.value),
						onKeyDown: (e) => { if (e.key === 'Enter') handleSave(); },
						style: inputStyle,
					}),
					createElement('p', { style: { color: '#aaa', fontSize: '12px', margin: '6px 0 0 0' } },
						'归档时模型侧保留最近内容至约 N tokens，更早的消息存入磁盘可检索。',
					),
				),
				// Read-only info
				state ? createElement('div', { style: { marginBottom: '24px', padding: '12px 16px', background: '#fafafa', borderRadius: '8px', border: '1px solid #f0f0f0' } },
					createElement('div', { style: rowStyle },
						createElement('span', { style: { color: '#666' } }, '默认 Token 预算'),
						createElement('span', { style: { fontWeight: 500 } }, String(state.defaultBudget)),
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
						style: { padding: '8px 20px', background: saving ? '#b0b0b0' : '#4a90d9', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '14px', cursor: saving ? 'not-allowed' : 'pointer', transition: 'background 0.2s' },
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
