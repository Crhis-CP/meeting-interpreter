// Runs after electron-builder has assembled the app, for every platform:
//  1. Locks the binary down with Electron fuses: it cannot be reused as a plain Node.js runtime,
//     started with a debugger / NODE_OPTIONS, or made to load app code from outside the archive.
//  2. macOS: signs the app ad hoc (no paid Apple developer certificate), so it runs on Apple
//     silicon and users confirm the first launch in System Settings › Privacy & Security.
// The order matters: flipping a fuse rewrites the Electron binary, so signing must come after it.
// (electron-builder's own `electronFuses` option flips them after this hook, i.e. after our
// signature, which left the app "damaged" on macOS.)
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const FUSES = {
  runAsNode: false,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  loadBrowserProcessSpecificV8Snapshot: false,
  grantFileProtocolExtraPrivileges: false,
};

exports.default = async function afterPack(context) {
  await context.packager.addElectronFuses(context, await context.packager.generateFuseConfig(FUSES));
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
};
