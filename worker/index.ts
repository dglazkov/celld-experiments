/// <reference types="@cloudflare/workers-types" />
/**
 * celld chat — Worker entrypoint.
 *
 * Every chat room is one cell (a Durable Object): its own SQLite database and
 * its own single thread. Any node in the fleet can serve any room; celld routes
 * a request to whichever node currently owns that room's cell. So the node that
 * terminates the WebSocket (the "edge") is often not the node that owns the
 * room, and the client shows both.
 */

export interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  NODE_LABEL: string;
}

/** Room names are used verbatim as cell names, so keep them short and boring. */
const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, edge: env.NODE_LABEL });
    }

    // /api/room/:name/(ws|history)
    const match = /^\/api\/room\/([^/]+)\/(ws|history)$/.exec(url.pathname);
    if (match) {
      const room = decodeURIComponent(match[1]).toLowerCase();
      if (!ROOM_RE.test(room)) {
        return badRequest("room must match [a-z0-9][a-z0-9-]{0,63}");
      }

      // idFromName is deterministic across the fleet: the same room name always
      // resolves to the same cell, whichever node the request landed on.
      const stub = env.ROOM.get(env.ROOM.idFromName(room));

      // Pass the edge node's identity along so the room can report both ends.
      const headers = new Headers(request.headers);
      headers.set("X-Edge-Node", env.NODE_LABEL);
      headers.set("X-Room-Name", room);

      return stub.fetch(new Request(request, { headers }));
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

/** What a client stores on its socket, so presence survives hibernation. */
interface Attachment {
  user: string;
  joinedAt: number;
}

interface StoredMessage {
  seq: number;
  id: string;
  ts: number;
  user: string;
  text: string;
  // SqlStorage row types must be indexable.
  [column: string]: SqlStorageValue;
}

const HISTORY_LIMIT = 100;
const RETAIN_MESSAGES = 500;
const MAX_TEXT_BYTES = 4096;
const MAX_USER_LEN = 32;

export class Room implements DurableObject {
  private sql: SqlStorage;

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    this.sql = state.storage.sql;
    // The constructor runs again after every hibernation and on every cold
    // start, so schema setup has to be idempotent.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq  INTEGER PRIMARY KEY AUTOINCREMENT,
        id   TEXT    NOT NULL,
        ts   INTEGER NOT NULL,
        user TEXT    NOT NULL,
        text TEXT    NOT NULL
      );
    `);
    this.sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS messages_id ON messages (id);`,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const room = request.headers.get("X-Room-Name") ?? "unknown";
    const edge = request.headers.get("X-Edge-Node") ?? "unknown";

    if (url.pathname.endsWith("/history")) {
      return Response.json({
        room,
        edge,
        owner: this.env.NODE_LABEL,
        messages: this.history(),
      });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("websocket upgrade required", { status: 426 });
    }

    const user = sanitizeUser(url.searchParams.get("user"));
    if (!user) return badRequest("user is required");

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // acceptWebSocket (rather than server.accept) makes the socket
    // hibernatable: celld can evict this cell from memory and the client stays
    // connected. Nothing may live in `this` between events.
    this.state.acceptWebSocket(server);
    const attachment: Attachment = { user, joinedAt: Date.now() };
    server.serializeAttachment(attachment);

    server.send(
      JSON.stringify({
        t: "welcome",
        room,
        you: user,
        edge,
        owner: this.env.NODE_LABEL,
        history: this.history(),
        members: this.members(),
      }),
    );
    this.broadcast({ t: "presence", members: this.members(), joined: user }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string") return;

    const who = this.who(ws);
    if (!who) {
      ws.close(1011, "unknown session");
      return;
    }

    let frame: { t?: string; text?: string; id?: string };
    try {
      frame = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ t: "error", message: "malformed frame" }));
      return;
    }

    if (frame.t === "ping") {
      ws.send(JSON.stringify({ t: "pong", owner: this.env.NODE_LABEL }));
      return;
    }

    if (frame.t !== "say") return;

    const text = (frame.text ?? "").trim();
    if (!text) return;
    if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) {
      ws.send(JSON.stringify({ t: "error", message: "message too long" }));
      return;
    }

    const id = typeof frame.id === "string" && frame.id ? frame.id.slice(0, 64) : crypto.randomUUID();
    const ts = Date.now();

    // Storage operations never interleave inside a cell, so this read-modify-
    // write needs no lock. The unique index makes a client retry idempotent.
    const rows = this.sql
      .exec<StoredMessage>(
        `INSERT INTO messages (id, ts, user, text) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING
         RETURNING seq, id, ts, user, text;`,
        id,
        ts,
        who.user,
        text,
      )
      .toArray();

    if (rows.length === 0) {
      // Duplicate id: the sender already has this message. Ack it and stop.
      ws.send(JSON.stringify({ t: "ack", id }));
      return;
    }

    this.trim();
    ws.send(JSON.stringify({ t: "ack", id }));
    this.broadcast({ t: "msg", msg: rows[0] });
  }

  async webSocketClose(ws: WebSocket) {
    this.departed(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.departed(ws);
  }

  private departed(ws: WebSocket) {
    const who = this.who(ws);
    // getWebSockets() still includes the closing socket during this event, so
    // exclude it from the member list we publish.
    const members = this.members(ws);
    this.broadcast({ t: "presence", members, left: who?.user }, ws);
  }

  private who(ws: WebSocket): Attachment | null {
    const raw = ws.deserializeAttachment();
    return raw && typeof raw === "object" ? (raw as Attachment) : null;
  }

  private members(exclude?: WebSocket): string[] {
    const names = new Set<string>();
    for (const ws of this.state.getWebSockets()) {
      if (ws === exclude) continue;
      const who = this.who(ws);
      if (who) names.add(who.user);
    }
    return [...names].sort();
  }

  private history(): StoredMessage[] {
    return this.sql
      .exec<StoredMessage>(
        `SELECT seq, id, ts, user, text FROM messages
         ORDER BY seq DESC LIMIT ?;`,
        HISTORY_LIMIT,
      )
      .toArray()
      .reverse();
  }

  private trim() {
    this.sql.exec(
      `DELETE FROM messages
       WHERE seq <= (SELECT MAX(seq) FROM messages) - ?;`,
      RETAIN_MESSAGES,
    );
  }

  private broadcast(payload: unknown, exclude?: WebSocket) {
    const body = JSON.stringify(payload);
    for (const ws of this.state.getWebSockets()) {
      if (ws === exclude) continue;
      try {
        ws.send(body);
      } catch {
        // The socket is gone; its close event will publish the presence change.
      }
    }
  }
}

function sanitizeUser(raw: string | null): string | null {
  if (!raw) return null;
  const user = raw.trim().replace(/\s+/g, " ").slice(0, MAX_USER_LEN);
  return user.length > 0 ? user : null;
}
