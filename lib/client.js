window.__ModuleLoader__.load({
	id: "dsh-context-sniper",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		console.log('[context-sniper] factory started');
		let react;
		try {
			react = require("react");
			console.log('[context-sniper] react loaded:', typeof react);
		} catch (e) {
			console.error('[context-sniper] failed to load react:', e);
			throw e;
		}

		const name = 'dsh-context-sniper';
		const inject = ['slots'];

		function Panel(props) {
			const { close } = props;
			console.log('[context-sniper] Panel rendered');
			return react.createElement('div', { style: { padding: '16px', fontFamily: 'sans-serif' } },
				react.createElement('h2', null, '上下文狙击手'),
				react.createElement('p', null, '设置面板加载成功。'),
				react.createElement('p', null, 'close: ', String(typeof close)),
			);
		}

		function apply(ctx) {
			console.log('[context-sniper] apply called, slots:', typeof ctx.slots);
			if (typeof ctx.slots?.inject !== 'function') {
				console.error('[context-sniper] ctx.slots.inject is not a function');
				return;
			}
			ctx.slots.inject('settings.section', () => {
				console.log('[context-sniper] settings.section slot is ready, registering...');
				const dispose = ctx.slots.register(
					{ name: 'settings.section', id: 'context-sniper', order: 25, label: '上下文狙击手' },
					(props) => react.createElement(Panel, { close: props?.close }),
				);
				console.log('[context-sniper] registered, dispose:', typeof dispose);
				if (typeof dispose === 'function') return dispose;
			});
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
