#!/usr/bin/env bash
# Creates a private certificate authority (once) and a server certificate signed by it.
# Usage: deploy/make-certs.sh <out-dir> <name-or-ip>...
#   e.g. deploy/make-certs.sh /etc/passholder/tls passholder.local 192.168.1.50 100.101.102.103
# Install <out-dir>/ca.crt on your devices; keep ca.key off the Pi if you can.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <out-dir> <name-or-ip>..." >&2
  exit 1
fi

out="$1"
shift
mkdir -p "$out"
cd "$out"

if [ ! -f ca.key ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout ca.key -out ca.crt -days 3650 -subj "/CN=PassHolder local CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
  chmod 600 ca.key
fi

san=""
for name in "$@"; do
  if [[ "$name" =~ ^[0-9.]+$ || "$name" == *:* ]]; then entry="IP:$name"; else entry="DNS:$name"; fi
  san="${san:+$san,}$entry"
done

openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout server.key -out server.csr -subj "/CN=$1"
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 825 \
  -extfile <(printf "subjectAltName=%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n" "$san")
rm server.csr
chmod 600 server.key

echo
echo "Server certificate for: $san"
echo "CA fingerprint (compare on each device when you install ca.crt):"
openssl x509 -in ca.crt -noout -fingerprint -sha256
echo "Server certificate fingerprint (compare in the Android app when pairing):"
openssl x509 -in server.crt -noout -fingerprint -sha256
