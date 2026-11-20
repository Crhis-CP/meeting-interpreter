#!/usr/bin/env bash
# Downloads the latest GitHub release and runs the end-to-end tests against the files people
# actually download: the Linux AppImage (desktop app), the Chrome extension zip, and the APK.
# Usage: CHROMIUM_PATH=... xvfb-run -a bash scripts/smoke-release.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=Crhis-CP/meeting-interpreter
DIR=$(mktemp -d)
TAG=$(gh api "repos/$REPO/releases/latest" -q .tag_name)
VER=${TAG#v}
echo "== latest release: $TAG"
for url in $(gh api "repos/$REPO/releases/latest" -q '.assets[].browser_download_url' | grep -E '\.AppImage$|chrome-.*\.zip$|\.apk$'); do
  curl -sSfL --retry 3 -o "$DIR/$(basename "$url")" "$url"
done
ls -la "$DIR"

echo "== extension $VER"
unzip -q -o "$DIR"/meeting-interpreter-chrome-*.zip -d "$DIR/ext"
grep -q "\"version\": \"$VER\"" "$DIR/ext/manifest.json" && echo "manifest version $VER ok"
MI_EXTENSION_DIR="$DIR/ext" npx playwright test e2e/extension.spec.ts --trace off

echo "== desktop app (AppImage) $VER"
chmod +x "$DIR"/*.AppImage
(cd "$DIR" && ./*.AppImage --appimage-extract >/dev/null)
# Released builds refuse debugger arguments (Electron fuse); Playwright drives the app through
# one, so allow it on this extracted test copy only. Every other fuse stays as shipped.
npx @electron/fuses read --app "$DIR/squashfs-root/meeting-interpreter"
npx @electron/fuses write --app "$DIR/squashfs-root/meeting-interpreter" EnableNodeCliInspectArguments=on >/dev/null
MI_APP_EXECUTABLE="$DIR/squashfs-root/meeting-interpreter" npx playwright test e2e/app.spec.ts e2e/room.spec.ts --trace off

echo "== android $VER"
if [ -n "${ANDROID_HOME:-}" ]; then
  BT=$(ls -d "$ANDROID_HOME"/build-tools/* | tail -1)
  "$BT/aapt2" dump badging "$DIR"/*.apk | grep -E "^package:" | tee /dev/stderr | grep -q "versionName='$VER'"
  "$BT/apksigner" verify "$DIR"/*.apk && echo "apk signature ok"
fi
echo "== all release checks passed for $TAG"
