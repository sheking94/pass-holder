#!/usr/bin/env bash
# Creates a private certificate authority (once) and a server certificate signed by it.
# Run it on your computer (Ubuntu), NOT on the Raspberry Pi: the CA key must never be on the server.
#
# Usage: deploy/make-certs.sh <ca-dir> <out-dir> <name-or-ip>...
#   e.g. deploy/make-certs.sh ~/passholder-ca ~/passholder-tls passholder.local 192.168.1.50 100.101.102.103
#
#   <ca-dir>   keeps ca.key (secret) and ca.crt. Created on the first run, reused later for renewals.
#   <out-dir>  gets server.crt, server.key and a copy of ca.crt: copy these three to the Pi.
#
# The CA can only vouch for names under .local and for private addresses (home network, Tailscale,
# localhost): a stolen ca.key cannot be used to fake your bank's site. Chrome checks this limit
# (X.509 nameConstraints). Other names: set PASSHOLDER_CA_DNS before the FIRST run, e.g.
#   PASSHOLDER_CA_DNS="local tail1234.ts.net" deploy/make-certs.sh ...
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "Usage: $0 <ca-dir> <out-dir> <name-or-ip>..." >&2
  exit 1
fi

if grep -qs "Raspberry Pi" /proc/device-tree/model; then
  echo "This looks like the Raspberry Pi. Create the certificates on your computer and copy only" >&2
  echo "server.crt, server.key and ca.crt to the Pi (docs/INSTALACJA.md, part 1.5)." >&2
  exit 1
fi

ca_dir="$1"
out="$2"
shift 2
if [ "$(realpath -m "$ca_dir")" = "$(realpath -m "$out")" ]; then
  echo "<ca-dir> and <out-dir> must differ: <out-dir> goes to the Pi, ca.key must not." >&2
  exit 1
fi

# Private IPv4 ranges (RFC 1918), Tailscale's 100.64.0.0/10, loopback, and IPv6 unique local fc00::/7
# (Tailscale's IPv6 addresses are in it).
constraints="nameConstraints=critical"
for dns in ${PASSHOLDER_CA_DNS:-local}; do constraints="$constraints,permitted;DNS:$dns"; done
for ip in 10.0.0.0/255.0.0.0 172.16.0.0/255.240.0.0 192.168.0.0/255.255.0.0 100.64.0.0/255.192.0.0 \
  127.0.0.0/255.0.0.0 fc00::/fe00::; do
  constraints="$constraints,permitted;IP:$ip"
done

mkdir -p "$ca_dir" "$out"
chmod 700 "$ca_dir"

if [ ! -f "$ca_dir/ca.key" ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout "$ca_dir/ca.key" -out "$ca_dir/ca.crt" -days 3650 -subj "/CN=PassHolder local CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "$constraints"
  chmod 600 "$ca_dir/ca.key"
elif ! openssl x509 -in "$ca_dir/ca.crt" -noout -ext nameConstraints 2>/dev/null | grep -q Permitted; then
  echo "$ca_dir/ca.crt was made by an older version of this script, without name limits." >&2
  echo "Use a new, empty <ca-dir>, import the new ca.crt in Chrome and remove the old one" >&2
  echo "(docs/INSTALACJA.md, part 1.5, \"Przejście na nowe CA\")." >&2
  exit 1
fi

san=""
for name in "$@"; do
  if [[ "$name" =~ ^[0-9.]+$ || "$name" == *:* ]]; then entry="IP:$name"; else entry="DNS:$name"; fi
  san="${san:+$san,}$entry"
done

openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout "$out/server.key" -out "$out/server.csr" -subj "/CN=$1"
openssl x509 -req -in "$out/server.csr" -CA "$ca_dir/ca.crt" -CAkey "$ca_dir/ca.key" -CAcreateserial \
  -out "$out/server.crt" -days 825 \
  -extfile <(printf "subjectAltName=%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n" "$san")
rm "$out/server.csr"
chmod 600 "$out/server.key"
cp "$ca_dir/ca.crt" "$out/ca.crt"

# openssl applies the same name limits as Chrome: a name outside them would be rejected by the browser.
if ! openssl verify -CAfile "$ca_dir/ca.crt" "$out/server.crt" >/dev/null 2>&1; then
  rm -f "$out/server.crt" "$out/server.key"
  echo "One of the names ($san) is outside what the CA may vouch for (.local names and private" >&2
  echo "addresses). Use such a name, or set PASSHOLDER_CA_DNS and start with a new <ca-dir>." >&2
  exit 1
fi

echo
echo "Server certificate for: $san"
echo "Copy to the Pi: $out/server.crt $out/server.key $out/ca.crt (never $ca_dir/ca.key)"
echo "CA fingerprint (compare on each device when you install ca.crt):"
openssl x509 -in "$ca_dir/ca.crt" -noout -fingerprint -sha256
echo "Server certificate fingerprint (compare in the Android app when pairing):"
openssl x509 -in "$out/server.crt" -noout -fingerprint -sha256
