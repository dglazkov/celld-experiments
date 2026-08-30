#!/usr/bin/env bash
# Show what the exe.dev fleet is doing: node health, peer tunnels, and the
# fleet view from inside a node.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC2206  # word splitting is how EXE_VMS names several VMs
VMS=(${EXE_VMS:-celld-a celld-b})
PUBLIC_PORT=${PUBLIC_PORT:-8080}
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)

say()   { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
on_vm() { local vm=$1; shift; ssh "${SSH_OPTS[@]}" "$vm.exe.xyz" "$@"; }
as_root() {
  local vm=$1; shift
  on_vm "$vm" "if [ \$(id -u) -eq 0 ]; then $*; else sudo -n $*; fi"
}

for vm in "${VMS[@]}"; do
  say "$vm"
  as_root "$vm" "systemctl is-active celld 'celld-peer@*' --no-pager" 2>/dev/null || true
  on_vm "$vm" "curl -fsS --max-time 5 http://127.0.0.1:$PUBLIC_PORT/api/health" 2>/dev/null ||
    echo "  health check failed"
  echo
done

say "fleet (probed from ${VMS[0]}, where the peer tunnels live)"
as_root "${VMS[0]}" \
  "set -a; . /etc/celld/fleet.env; set +a;
   unset CELLD_INTERNAL_ADDR CELLD_ADVERTISE;
   CELLD_ADDR=127.0.0.1:0 /usr/local/bin/celld diagnose --read-only --bucket \"\$CELLD_BUCKET\"" ||
  echo "  diagnose failed"

say "rooms in the bucket"
as_root "${VMS[0]}" \
  "set -a; . /etc/celld/fleet.env; set +a;
   /usr/local/bin/celld cell list Room --bucket \"\$CELLD_BUCKET\"" ||
  echo "  no rooms yet"
