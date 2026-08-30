#!/usr/bin/env bash
# Run a two-node celld fleet on this machine, against any S3-compatible bucket.
#
#   ./scripts/local-fleet.sh up      build, deploy, start node-a and node-b
#   ./scripts/local-fleet.sh test    run the e2e and cross-node suites
#   ./scripts/local-fleet.sh down    stop both nodes
#   ./scripts/local-fleet.sh logs    tail both node logs
#
# This is the same shape as the exe.dev deployment, minus the network: both
# nodes talk to each other over loopback instead of an SSH tunnel. Point it at
# a real bucket (R2, S3, Tigris) or at a local MinIO — see README.md.
set -euo pipefail
cd "$(dirname "$0")/.."

RUN_DIR=${RUN_DIR:-.celld/local-fleet}
A_PORT=${A_PORT:-8080}
B_PORT=${B_PORT:-8090}
A_INTERNAL=${A_INTERNAL:-18081}
B_INTERNAL=${B_INTERNAL:-18082}

# Only `up` talks to the bucket; `test`, `down` and `logs` do not need it.
bucket_args=()
require_bucket() {
  : "${CELLD_BUCKET:?set CELLD_BUCKET, e.g. s3://celld-chat}"
  # S3_ENDPOINT and AWS_REGION are only meaningful for s3://; gs:// and az://
  # reject an endpoint and ignore the region.
  bucket_args=(--bucket "$CELLD_BUCKET")
  case "$CELLD_BUCKET" in
    gs://*|az://*) ;;
    *)
      [[ -n ${S3_ENDPOINT:-} ]] && bucket_args+=(--endpoint "$S3_ENDPOINT")
      bucket_args+=(--region "${AWS_REGION:-us-east-1}")
      ;;
  esac
}

# esbuild is a devDependency here, so point celld at the local copy rather
# than requiring a global install. Only `celld deploy` bundles; nodes adopt the
# already-bundled deployment from the bucket.
if [[ -z ${CELLD_ESBUILD:-} && -x node_modules/.bin/esbuild ]]; then
  export CELLD_ESBUILD="$PWD/node_modules/.bin/esbuild"
fi

need() { command -v "$1" >/dev/null || { echo "missing dependency: $1" >&2; exit 1; }; }

wait_healthy() { # url label
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 3 "$1/api/health" >/dev/null 2>&1; then
      echo "  $2 ready at $1"; return 0
    fi
    sleep 1
  done
  echo "  $2 did not become healthy; see $RUN_DIR/$2.log" >&2
  tail -20 "$RUN_DIR/$2.log" >&2 || true
  return 1
}

start_node() { # label publicPort internalPort
  local label=$1 port=$2 internal=$3
  mkdir -p "$RUN_DIR/watch-$label"
  # Each node's internal listener owns a fleet-unique port and advertises
  # exactly that address, so no node ever needs a port translation.
  CELLD_VAR_NODE_LABEL="$label" \
  CELLD_WATCH="$RUN_DIR/watch-$label" \
  CELLD_NODE="$label" \
  setsid celld "${bucket_args[@]}" \
    --listen "127.0.0.1:$port" \
    --internal-listen "127.0.0.1:$internal" \
    --advertise "127.0.0.1:$internal" \
    > "$RUN_DIR/$label.log" 2>&1 < /dev/null &
  echo $! > "$RUN_DIR/$label.pid"
}

stop_node() { # label
  local pidfile="$RUN_DIR/$1.pid"
  [[ -f $pidfile ]] || return 0
  local pid; pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true   # SIGTERM: celld hands its cells off
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
}

case "${1:-up}" in
  up)
    need celld; need node; need npm; need curl
    require_bucket
    mkdir -p "$RUN_DIR"
    echo "==> building"
    npm run build --silent

    echo "==> deploying to $CELLD_BUCKET"
    celld deploy . "${bucket_args[@]}"

    echo "==> starting nodes"
    stop_node node-a; stop_node node-b
    start_node node-a "$A_PORT" "$A_INTERNAL"
    start_node node-b "$B_PORT" "$B_INTERNAL"
    wait_healthy "http://127.0.0.1:$A_PORT" node-a
    wait_healthy "http://127.0.0.1:$B_PORT" node-b

    echo
    echo "  node-a  http://127.0.0.1:$A_PORT"
    echo "  node-b  http://127.0.0.1:$B_PORT"
    echo "  Open both. They are one fleet: the same room works from either."
    ;;
  test)
    need node
    echo "==> single-node behaviour (node-a)"
    node test/e2e.mjs "http://127.0.0.1:$A_PORT"
    echo
    echo "==> fleet behaviour (node-a + node-b)"
    node test/cross-node.mjs "http://127.0.0.1:$A_PORT" "http://127.0.0.1:$B_PORT"
    ;;
  down)
    stop_node node-a; stop_node node-b
    echo "stopped"
    ;;
  logs)
    tail -f "$RUN_DIR"/node-a.log "$RUN_DIR"/node-b.log
    ;;
  *)
    sed -n '2,12p' "$0"; exit 1
    ;;
esac
