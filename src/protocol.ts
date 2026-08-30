/** Frames exchanged with the Room cell. Mirrors worker/index.ts. */

export interface Message {
  seq: number;
  id: string;
  ts: number;
  user: string;
  text: string;
}

export type ServerFrame =
  | {
      t: "welcome";
      room: string;
      you: string;
      edge: string;
      owner: string;
      history: Message[];
      members: string[];
    }
  | { t: "msg"; msg: Message }
  | { t: "presence"; members: string[]; joined?: string; left?: string }
  | { t: "ack"; id: string }
  | { t: "pong"; owner: string }
  | { t: "error"; message: string };

export type ClientFrame =
  | { t: "say"; id: string; text: string }
  | { t: "ping" };

export type Status = "connecting" | "online" | "offline";

/** Which fleet node terminated the socket, and which one owns the room cell. */
export interface Placement {
  edge: string;
  owner: string;
}
