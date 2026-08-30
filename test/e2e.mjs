/**
 * End-to-end check against a running celld node.
 *
 * Usage: node test/e2e.mjs [baseUrl]
 * Exercises the static assets, the health route, a two-client WebSocket
 * conversation, presence, message dedupe, and history replay after reconnect.
 */
const BASE = (process.argv[2] ?? "http://127.0.0.1:9876").replace(/\/$/, "");
const WS_BASE = BASE.replace(/^http/, "ws");
const ROOM = `t${Date.now().toString(36)}`;

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const waitFor = (sock, predicate, label, ms = 5000) =>
  new Promise((resolve, reject) => {
    const seen = [];
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${label}; saw ${JSON.stringify(seen)}`)),
      ms,
    );
    const onMessage = (event) => {
      const frame = JSON.parse(event.data);
      seen.push(frame.t);
      if (predicate(frame)) {
        clearTimeout(timer);
        sock.removeEventListener("message", onMessage);
        resolve(frame);
      }
    };
    sock.addEventListener("message", onMessage);
  });

function connect(user) {
  const ws = new WebSocket(`${WS_BASE}/api/room/${ROOM}/ws?user=${encodeURIComponent(user)}`);
  const welcome = waitFor(ws, (f) => f.t === "welcome", `welcome for ${user}`);
  return { ws, welcome };
}

try {
  // --- HTTP surface -------------------------------------------------------
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  check("GET /api/health", health.ok === true, `edge=${health.edge}`);

  const index = await fetch(`${BASE}/`);
  const html = await index.text();
  check("GET / serves the Vite build", index.ok && html.includes('<div id="root">'));

  const spa = await fetch(`${BASE}/deep/link`);
  check("SPA fallback on an unknown path", spa.ok);

  const missing = await fetch(`${BASE}/api/nope`);
  check("unknown /api route 404s", missing.status === 404);

  const badRoom = await fetch(`${BASE}/api/room/NOT_VALID/history`);
  check("invalid room name rejected", badRoom.status === 400);

  // --- two clients in one room -------------------------------------------
  const alice = connect("alice");
  const aliceWelcome = await alice.welcome;
  check("alice gets a welcome", aliceWelcome.room === ROOM && aliceWelcome.you === "alice");
  check(
    "welcome names both nodes",
    typeof aliceWelcome.edge === "string" && typeof aliceWelcome.owner === "string",
    `${aliceWelcome.edge} -> ${aliceWelcome.owner}`,
  );
  check("history starts empty", aliceWelcome.history.length === 0);

  const alicePresence = waitFor(alice.ws, (f) => f.t === "presence" && f.joined === "bob", "join");
  const bob = connect("bob");
  const bobWelcome = await bob.welcome;
  check("bob sees alice already present", bobWelcome.members.includes("alice"));
  const joined = await alicePresence;
  check("alice is told bob joined", joined.members.sort().join(",") === "alice,bob");

  // --- messaging ----------------------------------------------------------
  const bobGetsIt = waitFor(bob.ws, (f) => f.t === "msg", "broadcast to bob");
  const aliceAck = waitFor(alice.ws, (f) => f.t === "ack", "ack to alice");
  const id = crypto.randomUUID();
  alice.ws.send(JSON.stringify({ t: "say", id, text: "hello from alice" }));

  const delivered = await bobGetsIt;
  check("bob receives alice's message", delivered.msg.text === "hello from alice" && delivered.msg.user === "alice");
  const ack = await aliceAck;
  check("alice is acked with her own id", ack.id === id);

  // A resend of the same id must not create a second message.
  const dupAck = waitFor(alice.ws, (f) => f.t === "ack" && f.id === id, "dedupe ack");
  alice.ws.send(JSON.stringify({ t: "say", id, text: "hello from alice" }));
  await dupAck;

  const bobReply = waitFor(alice.ws, (f) => f.t === "msg" && f.msg.user === "bob", "bob's reply");
  bob.ws.send(JSON.stringify({ t: "say", id: crypto.randomUUID(), text: "hi alice" }));
  await bobReply;

  // --- durability: history survives a fresh connection --------------------
  const carol = connect("carol");
  const carolWelcome = await carol.welcome;
  check(
    "history replays for a new client",
    carolWelcome.history.length === 2,
    `got ${carolWelcome.history.length} messages`,
  );
  check(
    "history is in order and deduped",
    carolWelcome.history.map((m) => m.text).join(" | ") === "hello from alice | hi alice",
    carolWelcome.history.map((m) => m.text).join(" | "),
  );

  // --- the same room from a plain HTTP read -------------------------------
  const viaHttp = await fetch(`${BASE}/api/room/${ROOM}/history`).then((r) => r.json());
  check("history route agrees with the socket", viaHttp.messages.length === 2);
  check("history route reports the owning node", typeof viaHttp.owner === "string", viaHttp.owner);

  // --- a different room is a different cell -------------------------------
  const other = await fetch(`${BASE}/api/room/${ROOM}-b/history`).then((r) => r.json());
  check("a second room has its own database", other.messages.length === 0);

  // --- presence on leave --------------------------------------------------
  const leaveSeen = waitFor(alice.ws, (f) => f.t === "presence" && f.left === "bob", "leave");
  bob.ws.close();
  const left = await leaveSeen;
  check("presence drops a departed member", !left.members.includes("bob"), left.members.join(","));

  for (const s of [alice.ws, carol.ws]) s.close();
} catch (err) {
  check(String(err && err.message ? err.message : err), false);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
