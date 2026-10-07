#!/usr/bin/env bash
# Firma il manifesto con la chiave privata Ed25519 (PEM) della variabile SOUNDTRACK_SIGNING_KEY.
#
#   SOUNDTRACK_SIGNING_KEY=... bash scripts/sign.sh <cartella>/soundtrack.json
#
# Scrive <manifesto>.sig: la firma grezza (64 byte) dei byte esatti del manifesto.
# La chiave passa solo da un file temporaneo con permessi 600, cancellato appena firmato e
# comunque all'uscita; non viene mai stampata (niente `set -x` qui).
set -euo pipefail

manifesto="${1:?usage: sign.sh <soundtrack.json>}"
firma="${manifesto}.sig"
rm -f "$firma"

if [ -z "${SOUNDTRACK_SIGNING_KEY:-}" ]; then
  echo "::error::The secret SOUNDTRACK_SIGNING_KEY is missing: nothing was signed or published." >&2
  exit 1
fi
case "$SOUNDTRACK_SIGNING_KEY" in
  *"-----BEGIN PRIVATE KEY-----"*) ;;
  *)
    echo "::error::SOUNDTRACK_SIGNING_KEY is not a PEM private key (expected the content of the file made by openssl genpkey -algorithm ed25519): nothing was signed or published." >&2
    exit 1
    ;;
esac
if [ ! -s "$manifesto" ]; then
  echo "::error::$manifesto not found: nothing was signed or published." >&2
  exit 1
fi

umask 077
chiave="$(mktemp)"
trap 'rm -f "$chiave"' EXIT
printf '%s\n' "$SOUNDTRACK_SIGNING_KEY" > "$chiave"
unset SOUNDTRACK_SIGNING_KEY

if ! openssl pkeyutl -sign -rawin -inkey "$chiave" -in "$manifesto" -out "$firma" 2>/dev/null; then
  rm -f "$chiave" "$firma"
  echo "::error::openssl could not sign with SOUNDTRACK_SIGNING_KEY (is it an Ed25519 key?): nothing was signed or published." >&2
  exit 1
fi
rm -f "$chiave"

dimensione="$(wc -c < "$firma" | tr -d ' ')"
if [ "$dimensione" != "64" ]; then
  rm -f "$firma"
  echo "::error::The signature is $dimensione bytes instead of 64 (not an Ed25519 key?): nothing was published." >&2
  exit 1
fi
echo "signed $(basename "$manifesto") (64-byte Ed25519 signature)"
