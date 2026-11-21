#!/bin/bash
# CI on macOS: puts the fixed signing certificate (secrets MI_MAC_CERT_P12 / MI_MAC_CERT_PASSWORD,
# made with scripts/make-mac-cert.sh) into a temporary keychain and tells build/after-pack.cjs to
# sign with it (MI_MAC_SIGN_IDENTITY, MI_MAC_KEYCHAIN in $GITHUB_ENV). Without the secrets the app
# is signed ad hoc, as before. A configured certificate that cannot be used fails the build.
set -euo pipefail
if [ -z "${MI_MAC_CERT_P12:-}" ]; then
  echo "No fixed certificate configured: the app is signed ad hoc (macOS asks for permissions again after each update)."
  exit 0
fi
KC="${RUNNER_TEMP:-/tmp}/mi-signing.keychain-db"
KCPW="$(openssl rand -hex 16)"
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT
# (security picks the format from the file name: it must end in .p12)
P12="$TMPD/cert.p12"
printf '%s' "$MI_MAC_CERT_P12" | base64 --decode > "$P12"
security delete-keychain "$KC" 2>/dev/null || true
security create-keychain -p "$KCPW" "$KC"
security set-keychain-settings -lut 21600 "$KC"
security unlock-keychain -p "$KCPW" "$KC"
security import "$P12" -k "$KC" -f pkcs12 -P "${MI_MAC_CERT_PASSWORD:-}" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KCPW" "$KC" >/dev/null
# shellcheck disable=SC2046
security list-keychains -d user -s "$KC" $(security list-keychains -d user | tr -d '"')
# Self-signed, so not "valid" in the trust sense (no -v): codesign signs with it all the same.
ID="$(security find-identity -p codesigning "$KC" | awk '/MeetingInterpreter/ { print $2; exit }')"
if [ -z "$ID" ]; then
  echo "The certificate in MI_MAC_CERT_P12 has no code-signing identity:" >&2
  security find-identity -p codesigning "$KC" >&2
  exit 1
fi
echo "Signing with the fixed certificate $ID"
{
  echo "MI_MAC_SIGN_IDENTITY=$ID"
  echo "MI_MAC_KEYCHAIN=$KC"
} >> "${GITHUB_ENV:-/dev/stdout}"
