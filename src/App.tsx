import { useEffect, useMemo, useRef, useState } from "react";
import { useRoom } from "./useRoom";
import type { Status } from "./protocol";

const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEFAULT_ROOM = "general";

function roomFromHash(): string {
  const raw = decodeURIComponent(location.hash.replace(/^#\/?/, "")).toLowerCase();
  return ROOM_RE.test(raw) ? raw : DEFAULT_ROOM;
}

const STATUS_LABEL: Record<Status, string> = {
  connecting: "connecting",
  online: "live",
  offline: "reconnecting",
};

export default function App() {
  const [user, setUser] = useState(() => localStorage.getItem("celld-chat:user") ?? "");
  const [room, setRoom] = useState(roomFromHash);

  useEffect(() => {
    const sync = () => setRoom(roomFromHash());
    addEventListener("hashchange", sync);
    return () => removeEventListener("hashchange", sync);
  }, []);

  if (!user) return <NamePrompt onPick={setUser} />;
  return <Chat room={room} user={user} onSignOut={() => setUser("")} />;
}

function NamePrompt({ onPick }: { onPick: (name: string) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <main className="gate">
      <form
        className="gate-card"
        onSubmit={(e) => {
          e.preventDefault();
          const name = draft.trim().slice(0, 32);
          if (!name) return;
          localStorage.setItem("celld-chat:user", name);
          onPick(name);
        }}
      >
        <h1>celld chat</h1>
        <p>Every room is one cell: its own SQLite database, served by one node of the fleet.</p>
        <input
          autoFocus
          value={draft}
          maxLength={32}
          placeholder="pick a display name"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" disabled={!draft.trim()}>
          Join
        </button>
      </form>
    </main>
  );
}

function Chat({
  room,
  user,
  onSignOut,
}: {
  room: string;
  user: string;
  onSignOut: () => void;
}) {
  const { status, messages, pending, members, placement, error, send } = useRoom(room, user);
  const [draft, setDraft] = useState("");
  const log = useRef<HTMLDivElement>(null);

  // Stick to the bottom unless the reader has scrolled up to look at history.
  useEffect(() => {
    const el = log.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  const rows = useMemo(
    () => [
      ...messages.map((m) => ({ ...m, key: m.id, unsent: false })),
      ...pending.map((p) => ({
        key: p.id,
        id: p.id,
        seq: Number.MAX_SAFE_INTEGER,
        ts: Date.now(),
        user,
        text: p.text,
        unsent: true,
      })),
    ],
    [messages, pending, user],
  );

  return (
    <div className="app">
      <header>
        <div className="room">
          <span className="hash">#</span>
          <input
            className="room-input"
            value={room}
            spellCheck={false}
            onChange={(e) => {
              const next = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
              location.hash = `/${next}`;
            }}
          />
        </div>
        <div className="meta">
          <span className={`status status-${status}`}>{STATUS_LABEL[status]}</span>
          {placement && (
            <span className="placement" title="edge node → node that owns this room's cell">
              {placement.edge} <span className="arrow">→</span> {placement.owner}
            </span>
          )}
          <button className="linkish" onClick={onSignOut}>
            {user}
          </button>
        </div>
      </header>

      {error && <div className="banner">{error}</div>}

      <div className="body">
        <div className="log" ref={log}>
          {rows.length === 0 && <p className="empty">No messages yet. Say something.</p>}
          {rows.map((m, i) => {
            const prev = rows[i - 1];
            const grouped = prev?.user === m.user && m.ts - prev.ts < 5 * 60_000;
            return (
              <article key={m.key} className={`msg${m.unsent ? " unsent" : ""}${grouped ? " grouped" : ""}`}>
                {!grouped && (
                  <div className="msg-head">
                    <span className="who">{m.user}</span>
                    <time>{new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                  </div>
                )}
                <div className="text">{m.text}</div>
              </article>
            );
          })}
        </div>

        <aside>
          <h2>In the room</h2>
          <ul>
            {members.map((m) => (
              <li key={m} className={m === user ? "me" : undefined}>
                {m}
              </li>
            ))}
          </ul>
          {members.length === 0 && <p className="empty">nobody yet</p>}
        </aside>
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
          setDraft("");
        }}
      >
        <input
          value={draft}
          maxLength={2000}
          placeholder={`Message #${room}`}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
