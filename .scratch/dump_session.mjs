// Dump a compact digest of a DSH session.v4.jsonl.zstd file.
// Usage: node dump_session.mjs <path.zstd> [--grep <pattern>] [--full]
import { readFileSync, writeFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const [,, file, ...rest] = process.argv;
if (!file) { console.error('need file'); process.exit(1); }
const grepIdx = rest.indexOf('--grep');
const pattern = grepIdx >= 0 ? rest[grepIdx + 1] : null;
const full = rest.includes('--full');

// DSH appends one zstd frame per flush — split on magic 28B52FFD and concat.
const buf = readFileSync(file);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const starts = [];
for (let i = 0; ; ) {
  const j = buf.indexOf(MAGIC, i);
  if (j < 0) break;
  starts.push(j);
  i = j + 4;
}
let raw = '';
for (let k = 0; k < starts.length; k++) {
  const seg = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length);
  try { raw += zstdDecompressSync(seg).toString('utf8'); } catch (e) { raw += `\n<frame ${k} failed: ${e.message}>\n`; }
}
const lines = raw.split('\n').filter(Boolean);
const out = [];
for (let i = 0; i < lines.length; i++) {
  let ev;
  try { ev = JSON.parse(lines[i]); } catch { out.push(`#${i} <corrupt line>`); continue; }
  const t = ev.type;
  const d = ev.data ?? {};
  let desc = '';
  if (t === 'user/message') {
    const c = Array.isArray(d.content) ? d.content.map(b => b?.text ?? (b?.type === 'tool-call' ? `[tool-call ${b.name}]` : b?.type === 'tool-result' ? `[tool-result]` : '')).join(' ') : String(d.content ?? '');
    desc = `user(${d.source?.kind ?? '?'}) ${JSON.stringify(c.slice(0, full ? 100000 : 400))}`;
  } else if (t === 'assistant/message') {
    const c = Array.isArray(d.message?.content) ? d.message.content.map(b => b?.type === 'text' ? b.text : b?.type === 'tool-call' ? `[tool-call ${b.name} ${JSON.stringify(b.args ?? {}).slice(0, full ? 5000 : 160)}]` : b?.type === 'tool-result' ? `[tool-result ${JSON.stringify(b.content ?? '').slice(0, full ? 5000 : 200)}]` : `[${b?.type}]`).join(' | ') : '';
    desc = `assistant ${JSON.stringify(c.slice(0, full ? 100000 : 600))}${d.error ? ` ERROR=${JSON.stringify(d.error)}` : ''}${d.interrupted ? ' [interrupted]' : ''}`;
  } else if (t === 'tool/result') {
    const m = d.message ?? {};
    const c = Array.isArray(m.content) ? m.content.map(b => b?.text ?? b?.content ?? '').join(' ') : JSON.stringify(m).slice(0, 300);
    desc = `tool-result ${JSON.stringify(String(c).slice(0, full ? 20000 : 300))}`;
  } else if (t === 'system/message') {
    desc = 'system';
  } else if (t === 'turn/start' || t === 'turn/end') {
    desc = `${t} turn=${d.turn}`;
  } else {
    desc = `${t} ${JSON.stringify(d).slice(0, full ? 20000 : 200)}`;
  }
  const line = `#${ev.seq ?? i} ${t} ${desc}`;
  if (pattern) {
    if (new RegExp(pattern, 'i').test(line)) out.push(line);
  } else {
    out.push(line);
  }
}
const outPath = new URL('./session_digest.txt', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
writeFileSync(outPath, out.join('\n'), 'utf8');
console.log(`events=${lines.length} kept=${out.length} -> ${outPath}`);
