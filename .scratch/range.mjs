// Dump seq/type/time for a seq range.
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
const file = process.argv[2];
const from = Number(process.argv[3]);
const to = Number(process.argv[4]);
const buf = readFileSync(file);
const M = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const st = [];
for (let i = 0; ; ) { const j = buf.indexOf(M, i); if (j < 0) break; st.push(j); i = j + 4; }
let raw = '';
for (let k = 0; k < st.length; k++) {
  try { raw += zstdDecompressSync(buf.subarray(st[k], k + 1 < st.length ? st[k + 1] : buf.length)).toString('utf8'); } catch {}
}
const evs = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
for (const e of evs) {
  if (e.seq >= from && e.seq <= to) {
    console.log(e.seq, e.type, e.time ? new Date(e.time).toISOString() : '', JSON.stringify(e.data).slice(0, 90));
  }
}
