// Builds the Chrome extension into out/extension and zips it into release/.
// Usage: node scripts/build-extension.mjs [--zip]
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const src = join(root, 'extension/src');
const out = join(root, 'out/extension');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  platform: 'browser',
  target: 'chrome116',
  tsconfig: join(root, 'extension/tsconfig.json'),
  legalComments: 'none',
  minify: true,
  sourcemap: false,
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
};

// Extension pages and the service worker: ES modules (the speech SDK loads lazily as its own chunk).
await build({
  ...common,
  entryPoints: ['background', 'offscreen', 'popup', 'options'].map((n) => join(src, `${n}.ts`)),
  outdir: out,
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
});
// Content scripts must be classic scripts.
for (const n of ['page-mic', 'bridge']) {
  await build({ ...common, entryPoints: [join(src, `${n}.ts`)], outfile: join(out, `${n}.js`), format: 'iife' });
}

for (const f of ['popup.html', 'options.html', 'offscreen.html']) cpSync(join(src, f), join(out, f));
cpSync(join(root, 'extension/public'), out, { recursive: true });
execFileSync(process.execPath, [join(root, 'scripts/copy-offline-mt.mjs'), out]);
const manifest = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8'));
manifest.version = version;
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`extension ${version} → ${out}`);

if (process.argv.includes('--zip')) {
  const dir = join(root, 'release');
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, `meeting-interpreter-chrome-${version}.zip`);
  rmSync(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: out });
  console.log(`zipped → ${zip}`);
}
