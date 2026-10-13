// Timeline probe: find timeout finishes and events around the archive time.
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const file = process.argv[2];
const buf = readFileSync(file);
const M = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const st = [];
for (let i = 0; ; ) { const j = buf.indexOf(M, i); if (j < 0) break; st.push(j); i = j + 4; }
let raw = '';
for (let k = 0; k < st.length; k++) {
  try { raw += zstdDecompressSync(buf.subarray(st[k], k + 1 < st.length ? st[k + 1] : buf.length)).toString('utf8'); } catch {}
}
const evs = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

console.log('--- TIMEOUT finishes ---');
for (const e of evs) {
  const s = e.data?.stream;
  if (Array.isArray(s)) {
    for (const c of s) {
      if (c.chunk?.type === 'finish' && c.chunk?.reason?.kind === 'error') {
        console.log('seq', e.seq, e.type, new Date(c.time).toISOString(), c.chunk.reason.failure.code, String(c.chunk.reason.failure.message).slice(0, 60));
      }
    }
  }
}
console.log('--- event shape sample ---');
console.log(JSON.stringify(evs[5]).slice(0, 300));
console.log('--- events 2026-10-13T01:20-01:35Z (by any time field) ---');
for (const e of evs) {
  const cands = [e.time, e.data?.stream?.[0]?.time, e.data?.stream?.find?.((s) => s.time)?.time];
  const t = cands.map((x) => (typeof x === 'number' ? x : Date.parse(x))).find((x) => Number.isFinite(x));
  if (t !== undefined && t >= Date.parse('2026-10-13T01:20:00Z') && t <= Date.parse('2026-10-13T01:35:00Z')) {
    console.log(e.seq, e.type, new Date(t).toISOString(), JSON.stringify(e.data).slice(0, 110));
  }
}
