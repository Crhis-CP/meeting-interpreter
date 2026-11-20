// Copies the offline translation engine (worker + Mozilla's wasm and glue) next to a build's pages.
// Usage: node scripts/copy-offline-mt.mjs <dir> [<dir>…]   (default: src/renderer/public)
import { fileURLToPath } from 'node:url';
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const dirs = process.argv.slice(2).length ? process.argv.slice(2) : [join(root, 'src/renderer/public')];
for (const d of dirs) {
  const out = join(d, 'offline-mt');
  mkdirSync(out, { recursive: true });
  cpSync(join(root, 'src/browser/offline-mt/worker.js'), join(out, 'worker.js'));
  for (const f of ['bergamot-translator.js', 'bergamot-translator.wasm']) cpSync(join(root, 'third_party/bergamot', f), join(out, f));
}
