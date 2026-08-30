# celld chat

A distributed chat app: a Vite frontend, a [celld](https://celld.dev) backend,
running as a two-node fleet on [exe.dev](https://exe.dev) VMs.

Every chat room is one **cell** — a Durable Object with its own SQLite database,
served by exactly one node at a time. Any node can serve any room, so the node
that terminates your WebSocket is often not the node that owns the room. The
app shows you both, live, in the header:

```
# general                    ● live   node-b → node-a   alice
                                      ↑        ↑
                    the node you connected to  the node that owns this room
```

Open the two VM URLs side by side, join the same room from each, and messages
cross between the nodes while the badge shows the routing.

## How it fits together

```
  browser ──https──▶ vm-a.exe.xyz ──▶ celld node A ─┐
                     (exe.dev proxy)                │  peer traffic over an
                                                    │  SSH tunnel (loopback
  browser ──https──▶ vm-b.exe.xyz ──▶ celld node B ─┘  on both ends)
                     (exe.dev proxy)                │
                                                    ▼
                                        S3-compatible bucket
                                   (deployments, SQLite replicas,
                                    ownership records, node leases)
```

The bucket is the whole coordination layer. Nodes claim a cell with a
conditional write, so object storage — not a consensus protocol — decides who
owns what. There is no join command and no membership list: start another node
against the same bucket and it is part of the fleet.

| file | what it is |
| --- | --- |
| `worker/index.ts` | the Worker: routes `/api/*`, serves the Vite build from the `ASSETS` binding |
| `worker/index.ts` → `class Room` | one cell per room: SQLite history, hibernatable WebSockets, presence |
| `src/` | the Vite + React client, with reconnect and message dedupe |
| `wrangler.jsonc` | Durable Object binding, assets, migrations — read by `celld deploy` |
| `deploy/` | exe.dev fleet automation |
| `scripts/local-fleet.sh` | the same two-node shape, on your machine |
| `test/` | e2e and cross-node checks |

## Run it locally

The fast path needs nothing but the repo:

```bash
npm install
npm run dev          # Vite on :5173, `celld dev` on :9876
```

`celld dev` opens a local object store, deploys the app, and runs one node — no
bucket and no Docker. Vite proxies `/api` (WebSocket included) to it.

To exercise the real thing — two nodes, one bucket — you need an S3-compatible
store. Any of R2, S3, GCS, Azure Blob, or Tigris works; the store must support
conditional writes, which rules out B2, Hetzner, and DigitalOcean Spaces.
MinIO is fine for local testing:

```bash
# one-time: a local bucket
minio server /tmp/minio-data --address 127.0.0.1:9000 &
mc alias set local http://127.0.0.1:9000 minioadmin minioadmin
mc mb local/celld-chat

export CELLD_BUCKET=s3://celld-chat
export S3_ENDPOINT=http://127.0.0.1:9000
export AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin AWS_REGION=us-east-1

./scripts/local-fleet.sh up      # build, deploy, start node-a and node-b
./scripts/local-fleet.sh test    # e2e + cross-node checks
./scripts/local-fleet.sh down
```

`test` asserts the parts that matter: both nodes report the same owner for a
room, a message sent through node A reaches a client attached to node B, and
rooms spread across both nodes.

## Deploy to two exe.dev VMs

```bash
export CELLD_BUCKET=s3://my-celld-bucket
export S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com   # R2; omit for AWS
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=auto

./deploy/exe-up.sh
```

That creates `celld-a` and `celld-b` (override with `EXE_VMS="a b c"`, and it
handles more than two), installs celld on each, wires the peer mesh, deploys
the app to the bucket, and points the exe.dev proxy at the node. It is
idempotent — re-run it to roll out a new version.

```bash
./deploy/exe-status.sh            # health, tunnels, `celld diagnose`, room list
./deploy/exe-down.sh              # stop the services, keep the VMs
./deploy/exe-down.sh --destroy    # also delete the VMs
```

Both `https://celld-a.exe.xyz/` and `https://celld-b.exe.xyz/` serve the same
app. They are private to your exe.dev account by default; publish one with
`ssh exe.dev share set-public celld-a`.

### Why there is an SSH tunnel in here

celld nodes need to reach each other's **internal listener**, and that listener
must never be publicly reachable — it carries an unauthenticated operator API
that can inspect state, evict cells, and shut the node down. celld does not
terminate TLS on it either, so the private network is the security boundary.

exe.dev VMs [have no private network between them](https://exe.dev/docs/faq/cross-vm-networking.md).
So `exe-up.sh` builds the encrypted overlay celld's docs call for, out of the
one thing exe.dev already gives you: SSH.

- Each node's internal listener binds `127.0.0.1` on a **fleet-unique** port
  (18081, 18082, …) and advertises exactly that address. Because the port is
  unique per node, every peer can forward the same port number and the
  advertised address is valid from anywhere in the fleet — no translation.
- Each VM runs one `celld-peer@<vm>.service` per peer: an `ssh -N -L` tunnel
  with keepalives, restarted by systemd if it drops.
- Each VM generates its own SSH key, registered to your account scoped to the
  fleet's tag, so a node key cannot reach the rest of your account.
- The internal ports sit outside exe.dev's 3000–9999 proxy range on purpose,
  so nothing can reach them through the HTTPS proxy either.

If you already run [Tailscale](https://tailscale.com), use it instead: give
each node its tailnet IP for `CELLD_INTERNAL_ADDR`/`CELLD_ADVERTISE` and drop
the `celld-peer@` units.

### What each VM ends up with

```
/usr/local/bin/celld
/etc/celld/fleet.env          bucket creds, listeners, CELLD_VAR_NODE_LABEL  (0600)
/etc/celld/id_ed25519         this node's key for the peer tunnels
/etc/celld/peers/<vm>.env     PEER_HOST / PEER_PORT for one tunnel
/var/lib/celld                cell SQLite databases and the replication log
systemd: celld.service, celld-peer@<vm>.service
```

`celld.service` sets `TimeoutStopSec=180`. On SIGTERM celld hands each of its
cells to a peer and proves the data durable first; systemd must not SIGKILL it
mid-handoff. This is what makes a rolling deploy safe — stop one node, wait for
its replacement to report healthy, then move to the next.

## Operating it

**Ship a new version.** `celld deploy` uploads to the bucket; nodes poll
`deploy/current.json` every 30s and adopt it in place, with no restart and no
dropped connections.

```bash
npm run build && celld deploy . --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT"
```

**Add a third node.** Start celld against the same bucket with its own unique
internal port, and add a tunnel unit on every node. `EXE_VMS="celld-a celld-b
celld-c" ./deploy/exe-up.sh` does it.

**Losing a node is not an outage.** Ownership is a lease in the bucket, so a
node that dies releases its cells without anyone declaring it dead; a surviving
node picks them up with their SQLite database intact. Verified here by
`SIGKILL`-ing the owner of a room and reading the room back, complete, from the
other node.

**Durability.** With two or more nodes, `CELLD_DURABILITY=fleet` (the default)
acknowledges a write once a peer holds it on disk, then uploads to the bucket
in the background. A single node has no peer to send to, so every write waits
for the bucket — which is why two nodes are faster than one, not just more
available.

## Notes and limits

- Rooms match `[a-z0-9][a-z0-9-]{0,63}` and are used verbatim as cell names.
- A room keeps its last 500 messages; a client is sent the last 100 on connect.
- Messages carry a client-generated id and the room dedupes on it, so a resend
  after a reconnect or a node handoff cannot double-post.
- WebSockets are accepted with `state.acceptWebSocket()`, so celld can evict an
  idle room from memory while its clients stay connected. Nothing may be cached
  on `this` between events — presence is derived from the sockets themselves.
- Auth is a display name in `localStorage`. Real deployments should put
  [Login with exe](https://exe.dev/docs/login-with-exe.md) or your own identity
  in front of it.
- Cross-node WebSocket proxying means a client attached to node B holds a
  tunnel through node B to node A. Node B restarting drops that socket; the
  client reconnects and the room is unaffected.

## Reference

- celld docs — https://celld.dev/docs
- celld Cloudflare compatibility — https://celld.dev/docs/cloudflare-compat
- exe.dev docs — https://exe.dev/docs
- exe.dev CLI — `ssh exe.dev help`
