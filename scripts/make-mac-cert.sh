#!/bin/bash
# Makes the fixed self-signed certificate the Mac app is signed with, so macOS keeps the
# microphone and screen-recording permissions when the app is updated (an ad-hoc signature is
# different in every version, and macOS forgets the permissions each time).
#
# Run it once on your Mac:
#   bash make-mac-cert.sh
# It copies the certificate (base64) to the clipboard and prints its password. Put both in the
# repository's Settings › Secrets and variables › Actions as MI_MAC_CERT_P12 and
# MI_MAC_CERT_PASSWORD. The private key exists only in those secrets: nothing is written to disk
# outside a temporary folder that is deleted at the end.
#
# CI uses `--ci` to make a throwaway certificate and test the whole signing path with it.
set -euo pipefail
NAME="MeetingInterpreter Self-Signed"
DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT
# macOS's own openssl (LibreSSL) writes .p12 files that the keychain tools import everywhere.
OPENSSL=/usr/bin/openssl
[ -x "$OPENSSL" ] || OPENSSL=openssl
cat > "$DIR/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF
"$OPENSSL" req -x509 -newkey rsa:2048 -sha256 -days 7300 -nodes -config "$DIR/cert.cnf" -keyout "$DIR/key.pem" -out "$DIR/cert.pem" 2>/dev/null
PASS="$("$OPENSSL" rand -hex 16)"
"$OPENSSL" pkcs12 -export -inkey "$DIR/key.pem" -in "$DIR/cert.pem" -name "$NAME" -out "$DIR/cert.p12" -passout "pass:$PASS"
B64="$(base64 < "$DIR/cert.p12" | tr -d '\n')"

if [ "${1:-}" = "--ci" ]; then
  echo "MI_MAC_CERT_P12=$B64"
  echo "MI_MAC_CERT_PASSWORD=$PASS"
  exit 0
fi

printf '%s' "$B64" | pbcopy
cat <<EOF

证书已生成，并已复制到剪贴板。请到 GitHub 仓库 › Settings › Secrets and variables › Actions › New repository secret，添加两个：

  1. 名称 MI_MAC_CERT_P12      值：直接粘贴（剪贴板里就是）
  2. 名称 MI_MAC_CERT_PASSWORD 值：$PASS

添加好以后，这个窗口和剪贴板里的内容都不用保留。以后每一版 Mac 安装包都用这张证书签名。
EOF
