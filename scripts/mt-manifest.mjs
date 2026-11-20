// Writes src/browser/offline-mt/manifest.json: the Mozilla translation models we use, with sizes and
// SHA-256 of each (gzipped) file, so apps can verify downloads from our mirror or from Mozilla.
// Usage: node scripts/mt-manifest.mjs
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const PAIRS = ['zh-en', 'en-zh', 'es-en', 'en-es'];
const ROLE = { model: 'model', lexicalShortlist: 'lex', vocab: 'vocab', srcVocab: 'srcvocab', trgVocab: 'trgvocab' };
const reg = await (await fetch('https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json')).json();
const files = [];
for (const pair of PAIRS) {
  // Prefer the released build, else the first listed.
  const list = reg.models[pair];
  const m = list.find((x) => /Release/.test(x.releaseStatus ?? '')) ?? list[0];
  for (const [key, f] of Object.entries(m.files)) {
    const url = `${reg.baseUrl}/${f.path}`;
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    files.push({ pair, role: ROLE[key], name: `${pair}.${ROLE[key]}.gz`, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), upstream: url });
    console.log(pair, ROLE[key], buf.length);
  }
}
const out = { version: 1, mirror: 'https://github.com/Crhis-CP/meeting-interpreter/releases/download/mt-models-v1/', files };
writeFileSync(new URL('../src/browser/offline-mt/manifest.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
