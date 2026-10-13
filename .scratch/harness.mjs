// End-to-end harness: load the host half with a stub cordis ctx, activate it,
// and drive the timeout-recovery + stats RPC paths with fake services.
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

// Start from a clean fixture so archive-file counts are deterministic.
await rm(join(process.env.DSH_HOME || '.', 'sessions'), { recursive: true, force: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------------------------------------------------------------------------
// Fake session
// ---------------------------------------------------------------------------
const SURFACE = [
  { seq: 0, tokens: 500, event: { type: 'system/message', data: { message: { content: [{ type: 'text', text: 'system prompt' }] } } } },
  { seq: 1, tokens: 9000, event: { type: 'user/message', data: { content: [{ type: 'text', text: 'first user message about widgets and design' }], source: { kind: 'user' } } } },
  { seq: 2, tokens: 9000, event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'first assistant reply about widgets' }] } } } },
  { seq: 3, tokens: 9000, event: { type: 'user/message', data: { content: [{ type: 'text', text: 'second user message' }], source: { kind: 'user' } } } },
  { seq: 4, tokens: 9000, event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'second assistant reply' }] } } } },
  { seq: 5, tokens: 1000, event: { type: 'user/message', data: { content: [{ type: 'text', text: 'latest user message' }], source: { kind: 'user' } } } },
];
const appends = [];
const session = {
  id: 'test-session-1',
  header: { cwd: 'C:\\projects\\demo' },
  surface: { nodes: SURFACE.map((n) => n.seq), replaceGeneration: 0, contentGeneration: 0 },
  eventAt: (seq) => SURFACE.find((n) => n.seq === seq)?.event,
  snapshotEvents: () => SURFACE.map((n) => ({ seq: n.seq, ...n.event })),
  append: (type, data, opts) => {
    appends.push({ type, data, opts });
    // mirror real validation: replace needs start/end on surface + full source coverage
    if (opts?.surfaceOp?.op === 'replace') {
      const { startSeq, endSeq } = opts.surfaceOp;
      const nodes = session.surface.nodes;
      const si = nodes.indexOf(startSeq), ei = nodes.indexOf(endSeq);
      if (si === -1 || ei === -1) throw new Error(`surface replace: seq not found`);
      if (si > ei) throw new Error(`surface replace: start seq ${startSeq} (index ${si}) is after end seq ${endSeq} (index ${ei})`);
      const shadowed = nodes.slice(si, ei + 1);
      const missing = shadowed.filter((s) => !(opts.sourceEventSeqs || []).includes(s));
      if (missing.length) throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}`);
      // real fold: splice shadowed nodes, bump generations
      const newSeq = 100 + appends.length;
      session.surface.nodes.splice(si, ei - si + 1, newSeq);
      session.surface.replaceGeneration += 1;
      session.surface.contentGeneration += 1;
    }
    return { seq: 100 + appends.length, type, data };
  },
};
const followups = [];
const agent = { session, followup: (m) => followups.push(m), options: { provider: 'strata', model: 'test-model' } };

const measurement = { surfaceTokens: SURFACE.reduce((s, n) => s + n.tokens, 0), nodes: SURFACE.map(({ seq, tokens }) => ({ seq, tokens })), baseline: 0 };

// ---------------------------------------------------------------------------
// Stub ctx
// ---------------------------------------------------------------------------
const logs = [];
const listeners = [];
const settingsPatches = [];
let rpcRoute = null;
const vol = (v) => ({ get: () => v, [Symbol.for('cosmokit.volatile.write')]: () => {} });
const ctx = {
  on(name, fn, opts) { listeners.push({ name, fn, opts }); return () => {}; },
  inject(deps, cb) { return cb ? cb(ctx) : ctx; },
  provide() {},
  extend() { return ctx; },
  effect(fn) { if (typeof fn === 'function') { try { fn(); } catch (e) { logs.push(['effect-error', String(e)]); } } },
  logger: {
    info: (m) => logs.push(['info', m]),
    warn: (m) => logs.push(['warn', m]),
    error: (m) => logs.push(['error', m]),
    debug: (m) => logs.push(['debug', m]),
  },
  tools: { register: (def) => { ctx._tools = (ctx._tools || []).concat(def); return () => {}; } },
  agents: { get: (id) => (id === session.id ? agent : undefined) },
  settings: { update: async (ns, patch) => { settingsPatches.push([ns, patch]); } },
  tokenMeter: {
    measure: () => measurement,
    estimateMessage: (m) => Math.max(1, Math.round(JSON.stringify(m?.content ?? '').length / 4)),
  },
  sessions: { get: (id) => (id === session.id ? session : undefined) },
  get(name) {
    if (name === 'llm') return { resolveModelInfo: async () => ({ context: { contextWindow: 128000 } }) };
    if (name === 'sessions') return ctx.sessions;
    return undefined;
  },
  connection: {
    admit: () => ({}),
  },
  webServer: {
    register: (route) => { rpcRoute = route; return () => {}; },
  },
};

// ---------------------------------------------------------------------------
// 1. Module load + apply
// ---------------------------------------------------------------------------
let mod;
try {
  mod = await import('../lib/index.js');
  check('module loads', true);
} catch (e) {
  check('module loads', false, String(e));
  process.exit(1);
}

const rawConfig = {
  surfaceTokenBudget: vol(12000),
  pressureRatio: 0,
  maxSearchHits: vol(8),
  hitMaxChars: vol(4000),
  archiveDir: 'context-sniper',
  verbose: true,
};
try {
  const r = mod.apply(ctx, rawConfig);
  check('apply() runs', true, r && typeof r === 'function' ? '(returned disposer)' : '');
} catch (e) {
  check('apply() runs', false, String(e));
  console.log(e?.stack);
  process.exit(1);
}

check('request-error listener registered', listeners.some((l) => l.name === 'agent/request-error'));
check('recall tool registered', (ctx._tools || []).some((t) => t.name === 'context_sniper_recall'));
check('rpc route registered', rpcRoute !== null && rpcRoute.kind === 'prefix' && rpcRoute.path === '/context-sniper', JSON.stringify(rpcRoute ? { kind: rpcRoute.kind, path: rpcRoute.path } : null));

// ---------------------------------------------------------------------------
// 2. Timeout recovery: fire agent/request-error with TIMEOUT
// ---------------------------------------------------------------------------
const reListener = listeners.find((l) => l.name === 'agent/request-error');
try {
  const action = await reListener.fn(
    { agent, turn: 1, step: 0, provider: 'strata', failure: { message: 'pi-ai stream idle timeout after 300000ms', code: 'TIMEOUT' }, signal: { aborted: false } },
    async () => ({ kind: 'NEXT_CALLED' }),
  );
  check('timeout → retry authorized', action?.kind === 'retry', JSON.stringify(action));
  check('prune + replace appended adjacent', appends.length === 2 && appends[0].type === 'compaction/prune' && appends[1].opts?.surfaceOp?.op === 'replace', JSON.stringify(appends.map(a => a.type)));
  if (appends.length === 2) {
    const prune = appends[0];
    const { startSeq, endSeq } = appends[1].opts.surfaceOp;
    const src = appends[1].opts.sourceEventSeqs;
    check('prune arms exact replaced range', prune.data?.shadowedRange?.start === 1 && prune.data?.shadowedRange?.end === 3 && prune.data?.shadowedTokenCount > 0, JSON.stringify(prune.data?.shadowedRange));
    // budget 12000 keeps seq5(1000)+seq4(9000)=10000; seq3 would exceed → archive 1..3
    check('replace range + sources consistent', startSeq === 1 && endSeq === 3 && JSON.stringify(src) === '[1,2,3]', `start=${startSeq} end=${endSeq} src=${JSON.stringify(src)}`);
    check('marker has id', typeof appends[1].data?.id === 'string' && appends[1].data.id.length > 0);
    check('replaceGeneration bumped', session.surface.replaceGeneration === 1, `gen=${session.surface.replaceGeneration}`);
  }
} catch (e) {
  check('timeout → retry authorized', false, String(e));
  console.log(e?.stack);
}

// archive file written under DSH_HOME?
async function findFiles(dir, out = []) {
  try {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) await findFiles(p, out);
      else out.push(p);
    }
  } catch {}
  return out;
}
const files = await findFiles(process.env.DSH_HOME || '.');
const archiveFiles = files.filter((f) => f.includes('context-sniper') && f.endsWith('.json'));
const freshArchive = archiveFiles.filter((f) => f.includes('test-session-1'));
check('archive file written under DSH_HOME', freshArchive.length >= 1, archiveFiles.join(', '));

// ---------------------------------------------------------------------------
// 3. RPC endpoints (prefix route, real client-request envelope)
// ---------------------------------------------------------------------------
async function callRpc(endpoint, payload, { badMethod = false, badEnvelope = false } = {}) {
  const body = badEnvelope
    ? Buffer.from(JSON.stringify({ nope: true }))
    : Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: badMethod ? 'other' : endpoint, payload }));
  const req = {
    url: `/context-sniper/${endpoint}`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () { yield body; },
  };
  let status = 0;
  let out = '';
  const res = {
    writeHead(s) { status = s; },
    end(data) { out = data ?? ''; },
  };
  await rpcRoute.handler(req, res);
  return { status, envelope: JSON.parse(out) };
}

if (rpcRoute) {
  const stats = await callRpc('stats', {});
  check('stats ok', stats.status === 200 && stats.envelope?.type === 'server-response' && stats.envelope?.rpcId === 'rpc-1' && stats.envelope?.result?.ok === true, JSON.stringify(stats).slice(0, 200));
  const state = await callRpc('get-state', {});
  check('get-state ok', state.envelope?.result?.ok === true, JSON.stringify(state.envelope?.result).slice(0, 160));
  const sstate = await callRpc('session-state', { sessionId: session.id });
  check('session-state ok', sstate.envelope?.result?.ok === true, JSON.stringify(sstate.envelope?.result).slice(0, 200));
  const unknown = await callRpc('nope', {});
  check('unknown endpoint rejected', unknown.envelope?.result?.ok === false);
  const badEnv = await callRpc('stats', {}, { badEnvelope: true });
  check('bad envelope rejected', badEnv.status === 200 && badEnv.envelope?.result?.ok === false && badEnv.envelope?.result?.error?.code === 'gateway/bad-request', JSON.stringify(badEnv).slice(0, 160));
  const mismatch = await callRpc('stats', {}, { badMethod: true });
  check('method mismatch rejected', mismatch.envelope?.result?.ok === false && mismatch.envelope?.result?.error?.code === 'gateway/bad-request');
}

// ---------------------------------------------------------------------------
// 4. Truncation auto-continue
// ---------------------------------------------------------------------------
const seListeners = listeners.filter((l) => l.name === 'session/event');
for (const l of seListeners) {
  await l.fn(session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'a'.repeat(3000) + ' cut off mid sentenc' }] }, usage: { inputTokens: 110000, outputTokens: 15000 } },
  });
}
await new Promise((r) => setTimeout(r, 50));
check('truncation → followup dispatched', followups.length === 1, `followups=${followups.length}`);

// ---------------------------------------------------------------------------
// 5. Recall tool execute
// ---------------------------------------------------------------------------
const tool = (ctx._tools || []).find((t) => t.name === 'context_sniper_recall');
if (tool) {
  try {
    const out = await tool.execute({ query: 'widgets' }, { agent });
    check('recall finds archived messages', out.hitCount > 0, JSON.stringify(out).slice(0, 200));
  } catch (e) {
    check('recall finds archived messages', false, String(e));
  }
}

console.log('\n--- logs ---');
for (const [lvl, m] of logs) console.log(`[${lvl}] ${m}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
