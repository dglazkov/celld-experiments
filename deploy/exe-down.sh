#!/usr/bin/env bash
# Stop the fleet. By default this only stops the services, so the VMs and their
# disks survive; the cells themselves live in the bucket either way.
#
#   ./deploy/exe-down.sh            stop celld and the peer tunnels
#   ./deploy/exe-down.sh --destroy  also delete the VMs
#
# Stopping is a graceful drain: celld hands each cell to a peer before it exits,
# so stopping one node keeps the app up on the other.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC2206  # word splitting is how EXE_VMS names several VMs
VMS=(${EXE_VMS:-celld-a celld-b})
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
DESTROY=false
[[ ${1:-} == --destroy ]] && DESTROY=true

say()   { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
exe()   { ssh "${SSH_OPTS[@]}" exe.dev "$@"; }
on_vm() { local vm=$1; shift; ssh "${SSH_OPTS[@]}" "$vm.exe.xyz" "$@"; }
as_root() {
  local vm=$1; shift
  on_vm "$vm" "if [ \$(id -u) -eq 0 ]; then $*; else sudo -n $*; fi"
}

say "stopping nodes one at a time"
for vm in "${VMS[@]}"; do
  # One at a time, so each node has a live peer to hand its cells to.
  as_root "$vm" "systemctl stop celld 'celld-peer@*'" 2>/dev/null ||
    echo "  could not stop services on $vm"
  echo "    $vm stopped"
done

if $DESTROY; then
  say "deleting VMs"
  for vm in "${VMS[@]}"; do
    exe rm "$vm" && echo "    $vm deleted"
  done
  cat <<'EOF'

    The bucket still holds every room's database and the deployment. Delete
    the bucket contents yourself if you want the data gone.
EOF
else
  say "VMs are still running; bring the fleet back with ./deploy/exe-up.sh"
fi
