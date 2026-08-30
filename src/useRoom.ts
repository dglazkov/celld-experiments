import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientFrame, Message, Placement, ServerFrame, Status } from "./protocol";

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const PING_INTERVAL_MS = 25_000;

function socketUrl(room: string, user: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/room/${encodeURIComponent(room)}/ws?user=${encodeURIComponent(user)}`;
}

/** A message the client has sent but the room has not acknowledged yet. */
interface Pending {
  id: string;
  text: string;
}

export interface RoomState {
  status: Status;
  messages: Message[];
  pending: Pending[];
  members: string[];
  placement: Placement | null;
  error: string | null;
  send: (text: string) => void;
}

/**
 * Holds one WebSocket to a room cell, and reconnects with backoff.
 *
 * A reconnect can land on a different fleet node than the last one, and the
 * room's own cell may have been handed off to a third node in between. Neither
 * is visible here beyond the `placement` the room reports: the cell keeps its
 * SQLite database across the move, so history and presence just continue.
 */
export function useRoom(room: string, user: string): RoomState {
  const [status, setStatus] = useState<Status>("connecting");
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [members, setMembers] = useState<string[]>([]);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const socket = useRef<WebSocket | null>(null);
  const outbox = useRef<Pending[]>([]);
  const attempt = useRef(0);
  const closed = useRef(false);

  // Keep the live socket in a ref so `send` never has to be re-created and the
  // effect below never has to re-run when a message arrives.
  const flush = useCallback(() => {
    const ws = socket.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    for (const item of outbox.current) {
      const frame: ClientFrame = { t: "say", id: item.id, text: item.text };
      ws.send(JSON.stringify(frame));
    }
  }, []);

  useEffect(() => {
    if (!room || !user) return;

    closed.current = false;
    attempt.current = 0;
    let ping: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed.current) return;
      setStatus(attempt.current === 0 ? "connecting" : "offline");

      const ws = new WebSocket(socketUrl(room, user));
      socket.current = ws;

      ws.onopen = () => {
        attempt.current = 0;
        setStatus("online");
        setError(null);
        // Re-send anything the previous socket never got acknowledged. The room
        // dedupes on the message id, so a resend after a node handoff is safe.
        flush();
        ping = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ t: "ping" } satisfies ClientFrame));
          }
        }, PING_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(event.data as string);
        } catch {
          return;
        }

        switch (frame.t) {
          case "welcome":
            setPlacement({ edge: frame.edge, owner: frame.owner });
            setMembers(frame.members);
            setMessages(frame.history);
            break;
          case "msg":
            setMessages((prev) =>
              prev.some((m) => m.id === frame.msg.id) ? prev : [...prev, frame.msg],
            );
            break;
          case "presence":
            setMembers(frame.members);
            break;
          case "ack":
            outbox.current = outbox.current.filter((p) => p.id !== frame.id);
            setPending([...outbox.current]);
            break;
          case "pong":
            setPlacement((prev) => (prev ? { ...prev, owner: frame.owner } : prev));
            break;
          case "error":
            setError(frame.message);
            break;
        }
      };

      const reconnect = () => {
        clearInterval(ping);
        if (closed.current) return;
        setStatus("offline");
        const wait = Math.min(RECONNECT_BASE_MS * 2 ** attempt.current, RECONNECT_MAX_MS);
        attempt.current += 1;
        retry = setTimeout(connect, wait + Math.random() * 250);
      };

      ws.onclose = reconnect;
      ws.onerror = () => ws.close();
    };

    connect();

    return () => {
      closed.current = true;
      clearInterval(ping);
      clearTimeout(retry);
      socket.current?.close();
      socket.current = null;
    };
  }, [room, user, flush]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const item: Pending = { id: crypto.randomUUID(), text: trimmed };
      outbox.current = [...outbox.current, item];
      setPending([...outbox.current]);
      flush();
    },
    [flush],
  );

  return { status, messages, pending, members, placement, error, send };
}
