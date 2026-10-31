#!/usr/bin/env bash
# Turns remote access over Tailscale on or off. With it off the server is reachable only on the home network.
# Usage: deploy/vpn.sh on|off|status
set -euo pipefail

case "${1:-status}" in
  on) sudo tailscale up && tailscale ip -4 ;;
  off) sudo tailscale down && echo "VPN off: server reachable only on the local network" ;;
  status) tailscale status || true ;;
  *) echo "Usage: $0 on|off|status" >&2; exit 1 ;;
esac
