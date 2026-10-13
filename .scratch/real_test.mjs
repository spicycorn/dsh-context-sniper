// Reproduction against the REAL dsh-session: does archiveByTokenBudget's
// surface replace commit, and does the resulting log survive reload + the
// token-meter fold? Run:
//   $env:DSH_HOME="C:\projects\dsh_plugins\dsh-context-sniper\.scratch\home"
//   node --import ./.scratch/register.mjs .scratch/real_test.mjs
import { Session, foldSurface, deriveEventMessage } from '@deepseek-ai/dsh-session';
import { resolveConfig } from '../lib/config.js';
import { archiveByTokenBudget } from '../lib/select.js';

const cfg = resolveConfig({});

function estimate(msg) {
  const text = JSON.stringify(msg.content ?? '');
  return Math.max(1, Math.round(text.length / 4));
}

const meter = {
  measure(s) {
    const nodes = [...s.surface.nodes].map((seq) => {
      const ev = s.eventAt(seq);
      const msg = deriveEventMessage(ev);
      return { seq, tokens: msg ? estimate(msg) : 0 };
    });
    return { nodes, surfaceTokens: nodes.reduce((t, n) => t + n.tokens, 0) };
  },
  estimateMessage: (m) => estimate(m),
};

function buildSession() {
  const session = Session.create('session-repro-0001');
  session.append('system/message',
    { message: { role: 'system', content: [{ type: 'text', text: 'You are a helpful agent.' }] } },
    { surfaceOp: 'append' });
  session.append('turn/start', { turn: 1 });
  session.append('user/message',
    { id: 'u1', role: 'user', content: [{ type: 'text', text: 'first user question ' + 'x'.repeat(4000) }], source: { kind: 'user' } },
    { surfaceOp: 'append' });
  session.append('assistant/message',
    { message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'pwsh', input: { command: 'ls' } }] } },
    { surfaceOp: 'append' });
  session.append('tool/result',
    { message: { role: 'tool', content: [{ type: 'text', text: 'tool output ' + 'y'.repeat(4000) }], source: { kind: 'tool', callId: 'call-1' } } },
    { surfaceOp: 'append' });
  // A developer/message with a tool-addition, like the real session had.
  session.append('request/header', { header: { tools: [{ name: 'context_sniper_recall', description: 'd', parameters: {} }] } });
  session.append('developer/message',
    { message: { role: 'developer', content: [{ type: 'tool-addition', toolName: 'context_sniper_recall' }] }, headerSeq: 5 },
    { surfaceOp: 'append' });
  session.append('assistant/message',
    { message: { role: 'assistant', content: [{ type: 'text', text: 'answer one ' + 'z'.repeat(4000) }] } },
    { surfaceOp: 'append' });
  session.append('turn/end', { turn: 1 });
  session.append('turn/start', { turn: 2 });
  session.append('user/message',
    { id: 'u2', role: 'user', content: [{ type: 'text', text: 'second question ' + 'w'.repeat(4000) }], source: { kind: 'user' } },
    { surfaceOp: 'append' });
  session.append('assistant/message',
    { message: { role: 'assistant', content: [{ type: 'text', text: 'answer two ' + 'v'.repeat(4000) }] } },
    { surfaceOp: 'append' });
  return session;
}

let failures = 0;
function check(label, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------
console.log('=== 1. archiveByTokenBudget against real Session ===');
const session = buildSession();
const before = [...session.surface.nodes];
console.log('surface before:', before.join(','));
let result, error;
try {
  result = await archiveByTokenBudget(session, meter, cfg, 3000, 'timeout');
} catch (e) {
  error = e;
}
if (error) {
  console.log('THREW:', error?.message);
  check('archive does not throw', false);
} else {
  console.log('result:', JSON.stringify(result));
  check('archived something', result && result.archived > 0);
  const after = [...session.surface.nodes];
  console.log('surface after:', after.join(','));
  check('marker on surface', after.includes(result.markerSeq));
  check('archived seqs gone', !after.includes(result.fromSeq) && !after.includes(result.toSeq));
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. log survives reload (foldSurface replay) ===');
try {
  const folded = foldSurface(session.log);
  check('reload replay ok', true);
  if (result) check('reloaded surface matches', JSON.stringify([...folded.nodes]) === JSON.stringify([...session.surface.nodes]));
} catch (e) {
  check('reload replay ok', false, e?.message);
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. token-meter pressure fold shrinks surface total ===');
// Mirror of foldSurfaceProjection (dsh-token-meter/lib/index.js:302).
function foldPressure(events) {
  let surfaceTokens = 0;
  let claim;
  for (const event of events) {
    if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
      claim = { start: event.data.shadowedRange.start, end: event.data.shadowedRange.end, tokens: event.data.shadowedTokenCount };
      continue;
    }
    const isSurface = ['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'].includes(event.type);
    if (!isSurface) continue;
    const msg = deriveEventMessage(event);
    const tokens = msg ? estimate(msg) : 0;
    const op = event.surfaceOp;
    if (op === 'append') { surfaceTokens += tokens; claim = undefined; continue; }
    if (claim === undefined) { claim = undefined; continue; } // zero-delta drift
    if (claim.start !== op.startSeq || claim.end !== op.endSeq) throw new Error(`claim mismatch ${claim.start}-${claim.end} vs ${op.startSeq}-${op.endSeq}`);
    surfaceTokens += tokens - claim.tokens;
    claim = undefined;
  }
  return surfaceTokens;
}
const total = foldPressure(session.log);
const kept = [...session.surface.nodes].reduce((t, seq) => {
  const msg = deriveEventMessage(session.eventAt(seq));
  return t + (msg ? estimate(msg) : 0);
}, 0);
console.log(`folded surfaceTokens=${total}, actual kept=${kept}`);
check('pressure fold tracks real surface (no drift)', total === kept, total === kept ? '' : `drift ${total - kept}`);

// ---------------------------------------------------------------------------
console.log('\n=== 4. second archival round (double prune+replace) ===');
try {
  const r2 = await archiveByTokenBudget(session, meter, cfg, 1000, 'timeout');
  console.log('round 2:', JSON.stringify(r2));
  if (r2) {
    const after2 = [...session.surface.nodes];
    console.log('surface after r2:', after2.join(','));
    const total2 = foldPressure(session.log);
    const kept2 = after2.reduce((t, seq) => {
      const msg = deriveEventMessage(session.eventAt(seq));
      return t + (msg ? estimate(msg) : 0);
    }, 0);
    console.log(`folded=${total2}, kept=${kept2}`);
    check('round 2 no drift', total2 === kept2, `drift ${total2 - kept2}`);
    const folded2 = foldSurface(session.log);
    check('reload after 2 rounds ok', JSON.stringify([...folded2.nodes]) === JSON.stringify(after2));
  } else {
    check('round 2 archived something', false, 'returned null');
  }
} catch (e) {
  check('round 2 does not throw', false, e?.message);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;

