// dsh-context-sniper — browser half.
//
// Registers one Settings section ("Context Sniper") that:
//   * reads/writes the host plugin config LIVE through `ctx.configForms`
//     (the shared settings mirror — revision-fenced, no manual save round-trip),
//   * shows live archive statistics from the host `/context-sniper/stats` RPC,
//   * renders with Harness theme tokens only (`--dsw-alias-*`), so it follows
//     light/dark and any future palette without changes,
//   * routes every visible string through the Client locale service
//     (namespace `settings.contextSniper`, zh + en).
//
// The section only mounts while the Host actually serves the
// `dsh-context-sniper` settings namespace (`configForms.whileServed`), so a
// deployment without the host half shows no trace of the page.
//
// DSH 0.2.0-rc.1+ contract used here:
//   * `ctx.configForms.get(entryId)` → { getSnapshot, subscribe, set, unset }
//   * `ctx.configForms.whileServed([ns], register)`
//   * `ctx.locale.register(ns, { zh, en })` + `ctx.locale.bind(ns)`
//   * `settings.section` slot; the renderer injects `t` from the declared
//     `locale` namespace (PropsLocale), the rest arrives via `inject`.
//   * `ctx.connection.rpc.call('/context-sniper', '<endpoint>', payload)`
//     → { ok: true, value } | { ok: false, error: { code, message } }.
//     (A dedicated Connection channel — the host's Typert gateway owns the
//     single shared `/api` interceptor, so plugins mount their own prefix.)

window.__ModuleLoader__.load({
  id: 'dsh-context-sniper',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');
    var h = React.createElement;
    var useState = React.useState;
    var useCallback = React.useCallback;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var useSyncExternalStore = React.useSyncExternalStore;

    /** Host loader entry id == settings namespace == bundle row id. */
    var ENTRY_ID = 'dsh-context-sniper';
    /** Locale namespace owned by this plugin. */
    var NS = 'settings.contextSniper';
    /** RPC channel mounted by the host half (dedicated Connection prefix). */
    var RPC_CHANNEL = '/context-sniper';

    var inject = ['slots', 'locale', 'connection', 'configForms'];

    // -------------------------------------------------------------------------
    // Dictionaries (flat keys; zh and en carry identical key sets).
    // -------------------------------------------------------------------------
    var zh = {
      nav: '上下文狙击手',
      title: '上下文狙击手',
      intro: '本地大模型超时 / 截断 / 溢出的无损恢复：按 Token 预算把更早的消息原文归档到磁盘，模型侧只留一条可检索的标记。',
      featTimeout: '超时恢复：拦截 TIMEOUT / TRANSPORT → 按预算归档 → 立即重试',
      featOverflow: '溢出恢复：CONTEXT_WINDOW_EXCEEDED → 归档 → 重试；腾不出空间时交给内置压缩兜底',
      featTruncation: '截断继续：检测输出截断 → 腾出空间 → 自动“请继续”（每轮最多 3 次）',
      featRecall: '无损检索：context_sniper_recall 按关键词取回原文（按项目目录隔离）',
      configTitle: '参数',
      budgetLabel: '表面 Token 预算',
      budgetHint: '归档后模型侧保留最近内容的目标上限；更早的消息全部归档。这是唯一影响裁剪行为的参数。',
      hitsLabel: '最大命中数',
      hitsHint: '每次 context_sniper_recall 查询返回的最大消息条数（1–64）。',
      charsLabel: '单条最大字符',
      charsHint: '每条命中包含的最大字符数（200–20000）。',
      saved: '已保存',
      saveFailed: '保存失败',
      invalidNumber: '请输入 {min}–{max} 之间的整数',
      reset: '恢复默认',
      resetTitle: '清除覆盖，回退到组合层默认值',
      readOnly: '当前连接不接受配置写入（浏览器会话为只读模式）。',
      configUnavailable: '正在等待宿主配置…',
      statsTitle: '归档状态',
      statsRefresh: '刷新',
      statsLoading: '统计加载中…',
      statsError: '统计加载失败',
      statSessions: '归档会话',
      statRecords: '归档批次',
      statMessages: '归档消息',
      statFreed: '累计释放 Token',
      statLast: '最近归档',
      recentTitle: '最近归档',
      recentEmpty: '还没有归档记录 —— 发生超时 / 溢出 / 截断时会自动归档。',
      reasonTimeout: '超时',
      reasonOverflow: '上下文溢出',
      reasonTruncation: '输出截断',
      reasonPressure: '主动压力',
      reasonUnknown: '未知',
      never: '从未',
    };
    var en = {
      nav: 'Context Sniper',
      title: 'Context Sniper',
      intro: 'Lossless recovery from local-model timeouts, truncation and overflow: older messages are archived verbatim to disk under a token budget, leaving one recallable marker on the model surface.',
      featTimeout: 'Timeout recovery: intercepts TIMEOUT / TRANSPORT → archives to budget → retries immediately',
      featOverflow: 'Overflow recovery: CONTEXT_WINDOW_EXCEEDED → archive → retry; built-in compaction stays the safety net',
      featTruncation: 'Truncation continue: detects cut output → frees space → auto “please continue” (max 3 per turn)',
      featRecall: 'Lossless recall: context_sniper_recall retrieves verbatim text, isolated per project directory',
      configTitle: 'Settings',
      budgetLabel: 'Surface token budget',
      budgetHint: 'Target cap for what stays on the model surface after an archive; everything older is archived. The only knob that shapes trimming.',
      hitsLabel: 'Max search hits',
      hitsHint: 'Maximum archived messages one context_sniper_recall query returns (1–64).',
      charsLabel: 'Max chars per hit',
      charsHint: 'Maximum characters of each archived message included in a hit (200–20000).',
      saved: 'Saved',
      saveFailed: 'Save failed',
      invalidNumber: 'Enter an integer between {min} and {max}',
      reset: 'Reset',
      resetTitle: 'Clear the override and fall back to the composition default',
      readOnly: 'This connection does not accept config writes (read-only browser session).',
      configUnavailable: 'Waiting for the host configuration…',
      statsTitle: 'Archive status',
      statsRefresh: 'Refresh',
      statsLoading: 'Loading statistics…',
      statsError: 'Failed to load statistics',
      statSessions: 'Sessions',
      statRecords: 'Batches',
      statMessages: 'Messages',
      statFreed: 'Tokens freed',
      statLast: 'Last archive',
      recentTitle: 'Recent archives',
      recentEmpty: 'Nothing archived yet — archives happen on timeout / overflow / truncation.',
      reasonTimeout: 'Timeout',
      reasonOverflow: 'Overflow',
      reasonTruncation: 'Truncation',
      reasonPressure: 'Pressure',
      reasonUnknown: 'Unknown',
      never: 'Never',
    };

    // -------------------------------------------------------------------------
    // Styles — theme tokens only, own class prefix, removed on dispose.
    // -------------------------------------------------------------------------
    var CSS = [
      '.csn-panel{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px;font-size:14px;line-height:1.55}',
      '.csn-head{display:flex;align-items:baseline;gap:10px}',
      '.csn-title{margin:0;font-size:18px;font-weight:600}',
      '.csn-version{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.csn-intro{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary)}',
      '.csn-card{background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;padding:14px 16px;display:flex;flex-direction:column;gap:12px}',
      '.csn-card-title{margin:0;font-size:15px;font-weight:600}',
      '.csn-feat{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);display:flex;gap:8px;align-items:baseline}',
      '.csn-feat:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:none;position:relative;top:-1px}',
      '.csn-field{display:flex;flex-direction:column;gap:4px}',
      '.csn-field-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.csn-label{font-size:13px;font-weight:500}',
      '.csn-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.csn-input{width:120px;padding:6px 10px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;box-sizing:border-box}',
      '.csn-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.csn-input:disabled{opacity:0.5}',
      '.csn-btn{font:inherit;font-size:12.5px;padding:5px 12px;border-radius:6px;border:0.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.csn-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}',
      '.csn-btn:disabled{opacity:0.5;cursor:default}',
      '.csn-status{font-size:12.5px}',
      '.csn-status-ok{color:var(--dsw-alias-state-success-primary)}',
      '.csn-status-err{color:var(--dsw-alias-state-error-primary)}',
      '.csn-notice{font-size:12.5px;color:var(--dsw-alias-state-warn-primary)}',
      '.csn-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}',
      '.csn-stat{background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:10px 12px;display:flex;flex-direction:column;gap:2px}',
      '.csn-stat-value{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.csn-stat-caption{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.csn-recent{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}',
      '.csn-recent-row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-top:0.5px solid var(--dsw-alias-border-l1);font-size:12.5px;color:var(--dsw-alias-label-secondary)}',
      '.csn-recent-main{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}',
      '.csn-recent-reason{color:var(--dsw-alias-label-secondary)}',
      '.csn-head-actions{margin-left:auto;display:flex;align-items:center;gap:8px}',
    ].join('\n');

    function installStyles() {
      var tag = document.createElement('style');
      tag.dataset.plugin = ENTRY_ID;
      tag.dataset.pluginCss = ENTRY_ID + '.css';
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return function () { tag.remove(); };
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    function rpcCall(rpc, method, args) {
      return rpc.call(RPC_CHANNEL, method, args || {});
    }

    function unwrapResult(res) {
      if (res && res.ok === true) return { ok: true, value: res.value };
      var message = (res && res.error && res.error.message) || 'rpc failure';
      return { ok: false, error: message };
    }

    function formatNumber(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
      return n.toLocaleString();
    }

    function formatTime(ts) {
      if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return null;
      try { return new Date(ts).toLocaleString(); } catch (_e) { return String(ts); }
    }

    function projectLabel(project) {
      if (typeof project !== 'string' || project.length === 0) return '—';
      return project.replace(/^--/, '').replace(/--$/, '') || project;
    }

    var REASON_KEYS = {
      'timeout': 'reasonTimeout',
      'context-overflow': 'reasonOverflow',
      'output-truncation': 'reasonTruncation',
      'pressure': 'reasonPressure',
    };

    // -------------------------------------------------------------------------
    // Config card — live over the shared settings mirror (configForms).
    // -------------------------------------------------------------------------
    function NumberField(props) {
      var label = props.label;
      var hint = props.hint;
      var value = props.value; // committed number from the mirror (or undefined)
      var min = props.min;
      var max = props.max;
      var step = props.step;
      var disabled = props.disabled;
      var overridden = props.overridden;
      var t = props.t;
      var onCommit = props.onCommit;
      var onReset = props.onReset;

      var _edit = useState(null);
      var draft = _edit[0];
      var setDraft = _edit[1];
      var _status = useState(null);
      var status = _status[0]; // 'saved' | 'error' | null
      var setStatus = _status[1];
      var statusTimer = useRef(null);

      useEffect(function () {
        return function () { if (statusTimer.current) clearTimeout(statusTimer.current); };
      }, []);

      var flash = useCallback(function (kind) {
        setStatus(kind);
        if (statusTimer.current) clearTimeout(statusTimer.current);
        statusTimer.current = setTimeout(function () { setStatus(null); }, 2500);
      }, []);

      var shown = draft !== null ? draft : (value === undefined ? '' : String(value));

      var commit = useCallback(function () {
        if (draft === null) return;
        var trimmed = String(draft).trim();
        var parsed = Number(trimmed);
        setDraft(null);
        if (trimmed === '' || !Number.isInteger(parsed) || parsed < min || parsed > max) {
          flash('error');
          return;
        }
        if (value !== undefined && parsed === value) { flash('saved'); return; }
        Promise.resolve(onCommit(parsed)).then(function (ok) {
          flash(ok ? 'saved' : 'failed');
        }, function () { flash('failed'); });
      }, [draft, min, max, value, onCommit, flash]);

      var invalid = draft !== null && (String(draft).trim() === '' || !Number.isInteger(Number(draft)) || Number(draft) < min || Number(draft) > max);

      return h('div', { className: 'csn-field' },
        h('div', { className: 'csn-field-row' },
          h('label', { className: 'csn-label' }, label),
          h('input', {
            className: 'csn-input',
            type: 'number', min: min, max: max, step: step,
            value: shown,
            disabled: disabled,
            onChange: function (e) { setDraft(e.target.value); },
            onBlur: commit,
            onKeyDown: function (e) { if (e.key === 'Enter') { e.target.blur(); } },
          }),
          overridden && !disabled ? h('button', {
            type: 'button', className: 'csn-btn', title: t('resetTitle'), onClick: function () { Promise.resolve(onReset()); },
          }, t('reset')) : null,
          status === 'saved' ? h('span', { className: 'csn-status csn-status-ok' }, t('saved')) : null,
          status === 'error' ? h('span', { className: 'csn-status csn-status-err' }, t('invalidNumber', { min: min, max: max })) : null,
          status === 'failed' ? h('span', { className: 'csn-status csn-status-err' }, t('saveFailed')) : null,
        ),
        invalid ? h('p', { className: 'csn-status csn-status-err', style: { margin: 0 } }, t('invalidNumber', { min: min, max: max })) : null,
        hint ? h('p', { className: 'csn-hint' }, hint) : null,
      );
    }

    function ConfigCard(props) {
      var form = props.form;
      var t = props.t;
      // ConfigForm exposes prototype methods — bind before handing them to
      // useSyncExternalStore (bare references would lose `this`).
      var subscribe = useCallback(function (listener) { return form.subscribe(listener); }, [form]);
      var getSnapshot = useCallback(function () { return form.getSnapshot(); }, [form]);
      var snap = useSyncExternalStore(subscribe, getSnapshot);

      var setField = useCallback(function (field, value) {
        return form.set(field, value);
      }, [form]);
      var unsetField = useCallback(function (field) {
        return form.unset(field);
      }, [form]);

      if (snap.status === 'loading') return h('div', { className: 'csn-card' }, h('p', { className: 'csn-hint' }, t('configUnavailable')));

      var value = snap.value || {};
      var user = (snap.user && typeof snap.user === 'object') ? snap.user : {};
      var writable = snap.status === 'ready' && snap.writable !== false;

      return h('div', { className: 'csn-card' },
        h('h3', { className: 'csn-card-title' }, t('configTitle')),
        !writable ? h('p', { className: 'csn-notice' }, t('readOnly')) : null,
        h(NumberField, {
          label: t('budgetLabel'), hint: t('budgetHint'), t: t,
          value: value.surfaceTokenBudget, min: 1024, max: 1048576, step: 1024,
          disabled: !writable, overridden: user.surfaceTokenBudget !== undefined,
          onCommit: function (v) { return setField('surfaceTokenBudget', v); },
          onReset: function () { return unsetField('surfaceTokenBudget'); },
        }),
        h(NumberField, {
          label: t('hitsLabel'), hint: t('hitsHint'), t: t,
          value: value.maxSearchHits, min: 1, max: 64, step: 1,
          disabled: !writable, overridden: user.maxSearchHits !== undefined,
          onCommit: function (v) { return setField('maxSearchHits', v); },
          onReset: function () { return unsetField('maxSearchHits'); },
        }),
        h(NumberField, {
          label: t('charsLabel'), hint: t('charsHint'), t: t,
          value: value.hitMaxChars, min: 200, max: 20000, step: 100,
          disabled: !writable, overridden: user.hitMaxChars !== undefined,
          onCommit: function (v) { return setField('hitMaxChars', v); },
          onReset: function () { return unsetField('hitMaxChars'); },
        }),
      );
    }

    // -------------------------------------------------------------------------
    // Stats card — live archive statistics over the host RPC.
    // -------------------------------------------------------------------------
    function StatsCard(props) {
      var rpc = props.rpc;
      var t = props.t;
      var _state = useState({ phase: 'loading', data: null, error: null });
      var state = _state[0];
      var setState = _state[1];
      var alive = useRef(true);

      useEffect(function () {
        alive.current = true;
        return function () { alive.current = false; };
      }, []);

      var load = useCallback(function () {
        setState(function (s) { return { phase: 'loading', data: s.data, error: null }; });
        rpcCall(rpc, 'stats', {}).then(function (res) {
          if (!alive.current) return;
          var out = unwrapResult(res);
          if (out.ok) setState({ phase: 'ready', data: out.value, error: null });
          else setState({ phase: 'error', data: null, error: out.error });
        }, function (err) {
          if (!alive.current) return;
          setState({ phase: 'error', data: null, error: (err && err.message) || String(err) });
        });
      }, [rpc]);

      useEffect(function () { load(); }, [load]);

      var data = state.data;
      var recent = (data && Array.isArray(data.recent)) ? data.recent : [];
      var last = formatTime(data && data.lastArchivedAt);

      return h('div', { className: 'csn-card' },
        h('div', { style: { display: 'flex', alignItems: 'center' } },
          h('h3', { className: 'csn-card-title', style: { margin: 0 } }, t('statsTitle')),
          h('div', { className: 'csn-head-actions' },
            state.phase === 'error' && state.data === null ? h('span', { className: 'csn-status csn-status-err', title: state.error || '' }, t('statsError')) : null,
            h('button', { type: 'button', className: 'csn-btn', onClick: load, disabled: state.phase === 'loading' }, t('statsRefresh')),
          ),
        ),
        data === null && state.phase !== 'error' ? h('p', { className: 'csn-hint' }, t('statsLoading')) : null,
        data ? h('div', { className: 'csn-grid' },
          h('div', { className: 'csn-stat' }, h('span', { className: 'csn-stat-value' }, formatNumber(data.sessions)), h('span', { className: 'csn-stat-caption' }, t('statSessions'))),
          h('div', { className: 'csn-stat' }, h('span', { className: 'csn-stat-value' }, formatNumber(data.records)), h('span', { className: 'csn-stat-caption' }, t('statRecords'))),
          h('div', { className: 'csn-stat' }, h('span', { className: 'csn-stat-value' }, formatNumber(data.messages)), h('span', { className: 'csn-stat-caption' }, t('statMessages'))),
          h('div', { className: 'csn-stat' }, h('span', { className: 'csn-stat-value' }, formatNumber(data.freedTokens)), h('span', { className: 'csn-stat-caption' }, t('statFreed'))),
        ) : null,
        data ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { className: 'csn-stat-caption' }, t('statLast') + ' — ' + (last || t('never'))),
          h('h4', { className: 'csn-card-title', style: { fontSize: 13, margin: '4px 0 0 0' } }, t('recentTitle')),
          recent.length === 0 ? h('p', { className: 'csn-hint' }, t('recentEmpty')) : h('ul', { className: 'csn-recent' },
            recent.map(function (row, i) {
              var when = formatTime(row.archivedAt);
              var reasonKey = REASON_KEYS[row.reason] || 'reasonUnknown';
              return h('li', { key: (row.sessionId || 'r') + '-' + i, className: 'csn-recent-row' },
                h('span', { className: 'csn-recent-main', title: row.sessionId || '' },
                  projectLabel(row.project), ' · ', formatNumber(row.messageCount), ' msg · ~', formatNumber(row.freedTokens), ' tok'),
                h('span', { className: 'csn-recent-reason' }, t(reasonKey), when ? ' · ' + when : ''),
              );
            }),
          ),
        ) : null,
      );
    }

    // -------------------------------------------------------------------------
    // Section root.
    // -------------------------------------------------------------------------
    function SettingsPanel(props) {
      var rpc = props.rpc;
      var form = props.form;
      var version = props.version;
      var t = props.t;

      return h('div', { className: 'csn-panel' },
        h('div', { className: 'csn-head' },
          h('h2', { className: 'csn-title' }, t('title')),
          version ? h('span', { className: 'csn-version' }, 'v' + version) : null,
        ),
        h('p', { className: 'csn-intro' }, t('intro')),
        h('div', { className: 'csn-card' },
          h('p', { className: 'csn-feat' }, t('featTimeout')),
          h('p', { className: 'csn-feat' }, t('featOverflow')),
          h('p', { className: 'csn-feat' }, t('featTruncation')),
          h('p', { className: 'csn-feat' }, t('featRecall')),
        ),
        h(ConfigCard, { form: form, t: t }),
        h(StatsCard, { rpc: rpc, t: t }),
      );
    }

    // -------------------------------------------------------------------------
    // Activation.
    // -------------------------------------------------------------------------
    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, 'context-sniper: dictionaries');
      ctx.effect(installStyles, 'context-sniper: styles');

      var form = ctx.configForms.get(ENTRY_ID);
      var rpc = ctx.connection.rpc;

      // Read the host plugin version once for the header chip.
      var versionRef = { current: null };
      var versionListeners = new Set();
      rpcCall(rpc, 'get-state', {}).then(function (res) {
        var out = unwrapResult(res);
        if (out.ok && out.value && typeof out.value.version === 'string') {
          versionRef.current = out.value.version;
          versionListeners.forEach(function (fn) { fn(); });
        }
      }, function () { /* version chip is cosmetic */ });

      function useVersion() {
        var _v = useState(versionRef.current);
        var setV = _v[1];
        useEffect(function () {
          versionListeners.add(setV);
          setV(versionRef.current);
          return function () { versionListeners.delete(setV); };
        }, []);
        return _v[0];
      }

      function VersionedPanel(props) {
        return h(SettingsPanel, Object.assign({}, props, { version: useVersion() }));
      }

      // Mount the section only while the Host serves our settings namespace.
      ctx.effect(function () {
        return ctx.configForms.whileServed([ENTRY_ID], function () {
          return ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section',
              id: 'context-sniper',
              order: 25,
              label: function () { return t('nav'); },
              locale: NS,
              inject: function () { return { rpc: rpc, form: form }; },
            }, VersionedPanel);
          });
        });
      }, 'context-sniper: settings section');
    }

    exports.name = ENTRY_ID;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
