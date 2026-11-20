// Builds the phone app's web part into out/mobile and copies it into the Android project.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'out/mobile');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, 'mobile/src/app.ts')],
  outfile: join(out, 'app.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome100',
  minify: true,
  legalComments: 'none',
  tsconfig: join(root, 'mobile/tsconfig.json'),
  define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version) },
  logLevel: 'warning',
});
for (const f of ['index.html', 'app.css']) cpSync(join(root, 'mobile/src', f), join(out, f));
execFileSync(process.execPath, [join(root, 'scripts/copy-offline-mt.mjs'), out]);
const assets = join(root, 'android/app/src/main/assets/www');
rmSync(assets, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });
cpSync(out, assets, { recursive: true });
console.log(`mobile web → ${out} (+ android assets)`);
