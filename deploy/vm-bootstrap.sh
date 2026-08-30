#!/usr/bin/env bash
# Runs on an exe.dev VM as root. Installs celld and the systemd units, and
# makes sure the node has an SSH key of its own for the peer tunnels.
#
# It configures nothing fleet-specific: exe-up.sh writes /etc/celld/fleet.env
# and /etc/celld/peers/*.env afterwards, then starts the units. Re-running this
# script is safe.
set -euo pipefail

CELLD_VERSION=${CELLD_VERSION:-}
KEY=/etc/celld/id_ed25519

echo "==> installing packages"
export DEBIAN_FRONTEND=noninteractive
if ! command -v ssh >/dev/null || ! command -v curl >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq openssh-client curl ca-certificates >/dev/null
fi

echo "==> installing celld"
# The installer drops the binary in ~/.local/bin; systemd wants a stable path.
CELLD_VERSION="$CELLD_VERSION" sh -c 'curl -fsSL https://celld.dev/install.sh | sh' >/dev/null
install -m 0755 "$HOME/.local/bin/celld" /usr/local/bin/celld
/usr/local/bin/celld --version

echo "==> preparing /etc/celld"
mkdir -p /etc/celld/peers /var/lib/celld
chmod 0700 /etc/celld
# Cell databases and the replication log live here, so keep it off /tmp.
chown root:root /var/lib/celld

if [[ ! -f $KEY ]]; then
  # This key lets the node open its peer tunnels to the other VMs. exe-up.sh
  # registers the public half with the exe.dev account, scoped to the fleet tag.
  ssh-keygen -t ed25519 -N "" -C "celld-node-$(hostname)" -f "$KEY" >/dev/null
  chmod 0600 "$KEY"
fi

echo "==> writing systemd units"
cat > /etc/systemd/system/celld.service <<'UNIT'
[Unit]
Description=celld node
Documentation=https://celld.dev/docs
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/celld/fleet.env
ExecStart=/usr/local/bin/celld
Restart=always
RestartSec=5
KillSignal=SIGTERM
# celld hands its cells to a peer on SIGTERM and bounds that work with
# CELLD_SHUTDOWN_TOTAL_MS (40s by default). systemd must not SIGKILL first.
TimeoutStopSec=180
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/celld-peer@.service <<'UNIT'
[Unit]
Description=celld peer tunnel to %i
Documentation=https://exe.dev/docs/faq/cross-vm-networking.md
After=network-online.target
Wants=network-online.target
# celld tolerates an unreachable peer, so the node does not wait on the tunnel.
Before=celld.service

[Service]
Type=simple
EnvironmentFile=/etc/celld/peers/%i.env
# exe.dev VMs have no private network between them, and celld's internal
# listener carries an unauthenticated operator API, so peer traffic rides an
# SSH tunnel and the listener itself never leaves loopback.
ExecStart=/usr/bin/ssh -N \
  -i /etc/celld/id_ed25519 \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=accept-new \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -L 127.0.0.1:${PEER_PORT}:127.0.0.1:${PEER_PORT} \
  ${PEER_HOST}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
echo "==> bootstrap complete"
echo "PUBKEY:$(cat "$KEY.pub")"
