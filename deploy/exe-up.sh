#!/usr/bin/env bash
# Bring up the celld chat fleet on exe.dev VMs (two by default).
#
#   export CELLD_BUCKET=s3://my-celld-bucket
#   export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=auto
#   export S3_ENDPOINT=https://ACCOUNT.r2.cloudflarestorage.com   # R2/Tigris/MinIO
#   ./deploy/exe-up.sh
#
# Re-running is safe: existing VMs are reused, and every step is idempotent.
#
# What it builds
#   - one exe.dev VM per node, tagged so the node keys stay scoped to them
#   - celld on each, public listener on $PUBLIC_PORT behind the exe.dev proxy
#   - an SSH tunnel mesh for the internal (peer) listener, because exe.dev VMs
#     have no private network to each other:
#     https://exe.dev/docs/faq/cross-vm-networking.md
#   - the app deployed once to the bucket; both nodes adopt it from there
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC2206  # word splitting is how EXE_VMS names several VMs
VMS=(${EXE_VMS:-celld-a celld-b})
TAG=${EXE_TAG:-celld-chat}
PUBLIC_PORT=${PUBLIC_PORT:-8080}
INTERNAL_BASE=${INTERNAL_BASE:-18081}   # deliberately outside exe.dev's 3000-9999 proxy range
VM_CPU=${VM_CPU:-2}
VM_MEMORY=${VM_MEMORY:-8GB}
VM_DISK=${VM_DISK:-20GB}

SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
step() { printf '    %s\n' "$*"; }
die()  { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight --

command -v ssh   >/dev/null || die "ssh is required"
command -v node  >/dev/null || die "node is required"
command -v celld >/dev/null || die "celld is required: curl -fsSL https://celld.dev/install.sh | sh"

[[ -n ${CELLD_BUCKET:-} ]] || die "set CELLD_BUCKET (e.g. s3://my-bucket). See https://celld.dev/docs"
(( ${#VMS[@]} >= 1 )) || die "EXE_VMS is empty"

case "$CELLD_BUCKET" in
  gs://*|az://*) ;;
  *) [[ -n ${AWS_ACCESS_KEY_ID:-} && -n ${AWS_SECRET_ACCESS_KEY:-} ]] ||
       die "set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for an s3:// bucket" ;;
esac

# esbuild is a devDependency; only `celld deploy` needs it.
if [[ -z ${CELLD_ESBUILD:-} && -x node_modules/.bin/esbuild ]]; then
  export CELLD_ESBUILD="$PWD/node_modules/.bin/esbuild"
fi

bucket_args=(--bucket "$CELLD_BUCKET")
case "$CELLD_BUCKET" in
  gs://*|az://*) ;;
  *)
    [[ -n ${S3_ENDPOINT:-} ]] && bucket_args+=(--endpoint "$S3_ENDPOINT")
    bucket_args+=(--region "${AWS_REGION:-us-east-1}")
    ;;
esac

exe()   { ssh "${SSH_OPTS[@]}" exe.dev "$@"; }
on_vm() { local vm=$1; shift; ssh "${SSH_OPTS[@]}" "$vm.exe.xyz" "$@"; }
# exe.dev images vary: some log you in as root, some as a sudoer. Never let
# sudo prompt, because BatchMode SSH has no terminal to prompt on.
as_root() {
  local vm=$1; shift
  # ssh joins its arguments into one command string, so callers pass a command
  # string too. \$(id -u) stays literal for the remote shell to evaluate.
  on_vm "$vm" "if [ \$(id -u) -eq 0 ]; then $*; else sudo -n $*; fi"
}

internal_port() { echo $(( INTERNAL_BASE + $1 )); }

# --------------------------------------------------------------------- VMs --

say "checking the exe.dev account"
exe whoami >/dev/null || die "cannot reach exe.dev. Try 'ssh exe.dev' once interactively first."

existing=$(exe ls --json 2>/dev/null || echo '[]')
have_vm() {
  node -e '
    const want = process.argv[1];
    let data;
    try { data = JSON.parse(process.argv[2]); } catch { process.exit(1); }
    const list = Array.isArray(data) ? data : (data.vms ?? data.items ?? []);
    const names = list.map((v) => (typeof v === "string" ? v : v.name ?? v.Name ?? ""));
    process.exit(names.includes(want) ? 0 : 1);
  ' "$1" "$existing"
}

say "provisioning ${#VMS[@]} VM(s)"
for vm in "${VMS[@]}"; do
  if have_vm "$vm"; then
    step "$vm already exists"
  else
    step "creating $vm"
    exe new --name="$vm" --tag="$TAG" --cpu="$VM_CPU" --memory="$VM_MEMORY" --disk="$VM_DISK" \
            --comment="celld chat node" --no-email >/dev/null
  fi
done

say "waiting for SSH on each VM"
for vm in "${VMS[@]}"; do
  for attempt in $(seq 1 40); do
    if on_vm "$vm" true 2>/dev/null; then step "$vm is up"; break; fi
    (( attempt == 40 )) && die "$vm never accepted SSH"
    sleep 5
  done
done

# --------------------------------------------------------------- bootstrap --

say "installing celld on each VM"
declare -A PUBKEY
for vm in "${VMS[@]}"; do
  step "$vm"
  out=$(as_root "$vm" "bash -s" < deploy/vm-bootstrap.sh)
  key=$(printf '%s\n' "$out" | sed -n 's/^PUBKEY://p' | tail -1)
  [[ -n $key ]] || { printf '%s\n' "$out" >&2; die "$vm did not report a public key"; }
  PUBKEY[$vm]=$key
done

say "registering node keys with exe.dev (scoped to tag '$TAG')"
for vm in "${VMS[@]}"; do
  # Scoping to the tag means a node key can only reach fleet VMs, not the
  # whole account. Adding a key that is already present is a no-op.
  if exe ssh-key add --tag="$TAG" "${PUBKEY[$vm]}" >/dev/null 2>&1; then
    step "added key for $vm"
  else
    step "key for $vm already registered (or add failed; check 'ssh exe.dev ssh-key list')"
  fi
done

# ------------------------------------------------------------------- config --

say "writing fleet configuration"
for i in "${!VMS[@]}"; do
  vm=${VMS[$i]}
  port=$(internal_port "$i")

  # Every node's internal listener owns a fleet-unique port and advertises
  # exactly that address. Each peer forwards the same port number over SSH, so
  # no node ever needs a port translation and the advertised address is valid
  # from anywhere in the fleet.
  {
    echo "CELLD_BUCKET=$CELLD_BUCKET"
    [[ -n ${S3_ENDPOINT:-} ]]           && echo "S3_ENDPOINT=$S3_ENDPOINT"
    [[ -n ${AWS_REGION:-} ]]            && echo "AWS_REGION=$AWS_REGION"
    [[ -n ${AWS_ACCESS_KEY_ID:-} ]]     && echo "AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID"
    [[ -n ${AWS_SECRET_ACCESS_KEY:-} ]] && echo "AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY"
    [[ -n ${AWS_SESSION_TOKEN:-} ]]     && echo "AWS_SESSION_TOKEN=$AWS_SESSION_TOKEN"
    [[ -n ${AZURE_STORAGE_ACCOUNT_NAME:-} ]] && echo "AZURE_STORAGE_ACCOUNT_NAME=$AZURE_STORAGE_ACCOUNT_NAME"
    [[ -n ${AZURE_STORAGE_ACCOUNT_KEY:-} ]]  && echo "AZURE_STORAGE_ACCOUNT_KEY=$AZURE_STORAGE_ACCOUNT_KEY"
    echo "CELLD_ADDR=0.0.0.0:$PUBLIC_PORT"
    echo "CELLD_INTERNAL_ADDR=127.0.0.1:$port"
    echo "CELLD_ADVERTISE=127.0.0.1:$port"
    echo "CELLD_WATCH=/var/lib/celld"
    echo "CELLD_NODE=$vm"
    # Surfaced in the UI as the node that served you / owns your room.
    echo "CELLD_VAR_NODE_LABEL=$vm"
    # The exe.dev proxy terminates TLS and sets X-Forwarded-Proto/Host.
    echo "CELLD_TRUST_FORWARDED_HEADERS=1"
  } | as_root "$vm" "install -m 0600 /dev/stdin /etc/celld/fleet.env"

  # One tunnel unit per peer.
  peers=""
  for j in "${!VMS[@]}"; do
    (( j == i )) && continue
    peer=${VMS[$j]}
    peer_port=$(internal_port "$j")
    printf 'PEER_HOST=%s.exe.xyz\nPEER_PORT=%s\n' "$peer" "$peer_port" |
      as_root "$vm" "install -m 0644 /dev/stdin /etc/celld/peers/$peer.env"
    peers+="celld-peer@$peer.service "
  done

  as_root "$vm" "systemctl enable $peers >/dev/null 2>&1; systemctl restart $peers"
  step "$vm: internal 127.0.0.1:$port, tunnels to ${peers:-none}"
done

# ------------------------------------------------------------------- deploy --

say "building and deploying the application"
npm run build --silent
celld deploy . "${bucket_args[@]}"

say "starting nodes"
for vm in "${VMS[@]}"; do
  as_root "$vm" "systemctl enable celld >/dev/null 2>&1; systemctl restart celld"
  step "$vm started"
done

say "pointing the exe.dev proxy at port $PUBLIC_PORT"
for vm in "${VMS[@]}"; do
  exe share port "$vm" "$PUBLIC_PORT" >/dev/null && step "$vm -> :$PUBLIC_PORT"
done

# -------------------------------------------------------------------- check --

say "waiting for both nodes to serve"
for vm in "${VMS[@]}"; do
  ok=false
  for _ in $(seq 1 30); do
    if on_vm "$vm" "curl -fsS --max-time 3 http://127.0.0.1:$PUBLIC_PORT/api/health" >/dev/null 2>&1; then
      ok=true; break
    fi
    sleep 3
  done
  if $ok; then
    step "$vm healthy"
  else
    step "$vm NOT healthy — run: ssh $vm.exe.xyz sudo journalctl -u celld -n 50"
    step "  (a peer tunnel problem shows up as: journalctl -u 'celld-peer@*')"
  fi
done

say "fleet"
# diagnose must run ON a node: it probes each peer at that peer's advertised
# address, and those addresses only resolve through the tunnels on a VM. It
# also binds a throwaway listener, so keep it off the node's public port.
as_root "${VMS[0]}" \
  "set -a; . /etc/celld/fleet.env; set +a;
   unset CELLD_INTERNAL_ADDR CELLD_ADVERTISE;
   CELLD_ADDR=127.0.0.1:0 /usr/local/bin/celld diagnose --bucket \"\$CELLD_BUCKET\"" \
  || step "diagnose failed; the fleet may still be fine"

say "ready"
for vm in "${VMS[@]}"; do
  echo "    https://$vm.exe.xyz/"
done
cat <<EOF

    Both URLs are the same fleet. Open them in two browsers, join the same
    room, and the header shows which node served you and which node owns the
    room's cell.

    The proxy is private by default; publish one with:
      ssh exe.dev share set-public ${VMS[0]}
EOF
