#!/usr/bin/env bash
# Runs the end-to-end tests, including real AI translation, against the app electron-builder has
# just packaged on this computer (release/*-unpacked or release/mac*/*.app), before it is published.
# Needs MI_AI_MODEL (see scripts/dev/fetch-ai-model.mts). On Linux, run it under xvfb-run.
# Usage: MI_AI_MODEL=... bash scripts/test-packaged.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${MI_AI_MODEL:?set MI_AI_MODEL to the Hy-MT2-1.8B model file}"
TMP=$(mktemp -d)
case "$(uname -s)" in
  Darwin)
    # The app as shipped must carry a valid signature: a broken one makes macOS call it
    # "damaged" and refuse to open it (fuses flipped after signing did exactly that in 0.8.1).
    codesign --verify --deep --strict --verbose=2 "$(ls -d release/mac*/*.app | head -1)"
    # Signed with the fixed certificate: macOS ties permissions to that certificate, not to this
    # one build (otherwise every update asks for the microphone again).
    if [ -n "${MI_MAC_SIGN_IDENTITY:-}" ]; then
      codesign --display --requirements - "$(ls -d release/mac*/*.app | head -1)" 2>&1 | grep -q 'certificate leaf' \
        || { echo "the app is not signed with the fixed certificate"; exit 1; }
    fi
    cp -R "$(ls -d release/mac*/*.app | head -1)" "$TMP/"
    APP=$(ls -d "$TMP"/*.app)
    FUSE_TARGET="$APP"
    EXE="$APP/Contents/MacOS/$(basename "$APP" .app)"
    ;;
  MINGW* | MSYS* | CYGWIN*)
    cp -R release/win-unpacked "$TMP/app"
    FUSE_TARGET=$(ls "$TMP"/app/*.exe | grep -v -i uninstall | head -1)
    EXE="$FUSE_TARGET"
    ;;
  *)
    cp -R release/linux-unpacked "$TMP/app"
    FUSE_TARGET="$TMP/app/meeting-interpreter"
    EXE="$FUSE_TARGET"
    ;;
esac
echo "== packaged app: $EXE"
# Released builds refuse debugger arguments (Electron fuse); Playwright drives the app through one,
# so allow it on this test copy only. Every other fuse stays as shipped.
npx @electron/fuses read --app "$FUSE_TARGET"
npx @electron/fuses write --app "$FUSE_TARGET" EnableNodeCliInspectArguments=on >/dev/null
# macOS refuses to run a binary whose signature no longer matches: sign the test copy again (ad hoc).
if [ "$(uname -s)" = Darwin ]; then codesign --force --deep --sign - "$APP"; fi
MI_APP_EXECUTABLE="$EXE" npx playwright test e2e/local-ai.spec.ts e2e/app.spec.ts --trace off
# 彻底卸载, rehearsed on the installed app (what it would remove, incl. the app itself; nothing is deleted).
MI_APP_EXECUTABLE="$EXE" npx playwright test e2e/storage.spec.ts -g rehearsal --trace off
echo "== the packaged app works"
