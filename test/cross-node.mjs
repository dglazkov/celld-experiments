/**
 * Two-node fleet check.
 *
 * Usage: node test/cross-node.mjs <nodeAUrl> <nodeBUrl>
 *
 * A room is one cell, and exactly one node owns it at a time. A client that
 * connects to the other node must still land in the same room: that node
 * proxies the WebSocket to the owner. This asserts that — same owner reported
 * from both ends, different edges, and messages crossing between them.
 */
const [A, B] = [process.argv[2] ?? "http://127.0.0.1:8080", process.argv[3] ?? "http://127.0.0.1:8090"].map(
  (u) => u.replace(/\/$/, ""),
);
const ROOM = `x${Date.now().toString(36)}`;

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const waitFor = (sock, predicate, label, ms = 10000) =>
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

function connect(base, user, room = ROOM) {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/room/${room}/ws?user=${encodeURIComponent(user)}`);
  return { ws, welcome: waitFor(ws, (f) => f.t === "welcome", `welcome for ${user}`) };
}

try {
  const healthA = await fetch(`${A}/api/health`).then((r) => r.json());
  const healthB = await fetch(`${B}/api/health`).then((r) => r.json());
  check("the two nodes are distinct", healthA.edge !== healthB.edge, `${healthA.edge} / ${healthB.edge}`);

  // alice hits node A, bob hits node B, same room.
  const alice = connect(A, "alice");
  const aliceWelcome = await alice.welcome;
  const bob = connect(B, "bob");
  const bobWelcome = await bob.welcome;

  check("alice's edge is node A", aliceWelcome.edge === healthA.edge, aliceWelcome.edge);
  check("bob's edge is node B", bobWelcome.edge === healthB.edge, bobWelcome.edge);
  check(
    "both ends report the SAME owning node",
    aliceWelcome.owner === bobWelcome.owner,
    `${aliceWelcome.owner} vs ${bobWelcome.owner}`,
  );
  check(
    "at least one client is being proxied across nodes",
    aliceWelcome.edge !== aliceWelcome.owner || bobWelcome.edge !== bobWelcome.owner,
    `A: ${aliceWelcome.edge}->${aliceWelcome.owner}, B: ${bobWelcome.edge}->${bobWelcome.owner}`,
  );
  check("bob sees alice, who joined via the other node", bobWelcome.members.includes("alice"));

  // A message sent through node A must reach the client attached to node B.
  const crossing = waitFor(bob.ws, (f) => f.t === "msg", "message crossing A -> B");
  alice.ws.send(JSON.stringify({ t: "say", id: crypto.randomUUID(), text: "across the fleet" }));
  const got = await crossing;
  check("message crosses node A -> node B", got.msg.text === "across the fleet" && got.msg.user === "alice");

  const back = waitFor(alice.ws, (f) => f.t === "msg" && f.msg.user === "bob", "message crossing B -> A");
  bob.ws.send(JSON.stringify({ t: "say", id: crypto.randomUUID(), text: "and back again" }));
  await back;
  check("message crosses node B -> node A", true);

  // The cell's SQLite database is single: both nodes read the same history.
  const fromA = await fetch(`${A}/api/room/${ROOM}/history`).then((r) => r.json());
  const fromB = await fetch(`${B}/api/room/${ROOM}/history`).then((r) => r.json());
  check("both nodes read the same history", fromA.messages.length === 2 && fromB.messages.length === 2,
    `A=${fromA.messages.length} B=${fromB.messages.length}`);
  check("both nodes name the same owner", fromA.owner === fromB.owner, `${fromA.owner} / ${fromB.owner}`);

  // Different rooms can be owned by different nodes; check ownership spreads.
  const owners = new Set();
  for (let i = 0; i < 12; i++) {
    const base = i % 2 === 0 ? A : B;
    const r = await fetch(`${base}/api/room/${ROOM}-s${i}/history`).then((x) => x.json());
    owners.add(r.owner);
  }
  check("rooms are spread over both nodes", owners.size === 2, `owners seen: ${[...owners].join(", ")}`);

  for (const s of [alice.ws, bob.ws]) s.close();
} catch (err) {
  check(String(err && err.message ? err.message : err), false);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
