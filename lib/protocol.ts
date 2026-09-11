// Shared WebSocket protocol between the browser and the sync server (PRD 6.17).
// Keep messages lightweight — video bytes never travel over this socket.

export type PresenceUser = {
  userId: string;
  displayName: string;
  role: "host" | "guest";
  connected: boolean;
};

export type RoomStateMessage = {
  roomId: string;
  title: string;
  videoId: string;
  videoTitle: string;
  durationSeconds: number | null;
  playing: boolean;
  /** Authoritative position in seconds, measured at serverTsMs. */
  positionSeconds: number;
  playbackRate: number;
  /** Server wall-clock (ms since epoch) when positionSeconds was true. */
  serverTsMs: number;
  hostUserId: string;
  participants: PresenceUser[];
  expiresAtMs: number;
};

export type StreamDescriptor =
  | { kind: "url"; videoId: string; url: string; subtitlePath?: string }
  | { kind: "telegram"; videoId: string; path: string; subtitlePath?: string };

export type ChatMessageDto = {
  id: string;
  userId: string;
  displayName: string;
  body: string;
  videoTimestamp: number | null;
  createdAt: number;
};

export type ClientEvent =
  | { type: "ping"; t0: number }
  | { type: "play"; position: number; rate?: number }
  | { type: "pause"; position: number }
  | { type: "seek"; position: number }
  | { type: "sync" }
  | { type: "ended" }
  | { type: "change_video"; videoId: string }
  | { type: "chat"; body: string; videoTimestamp?: number }
  | { type: "reaction"; emoji: string }
  | { type: "leave" };

export type ServerEvent =
  | { type: "pong"; t0: number; serverTsMs: number }
  | { type: "joined"; state: RoomStateMessage; stream: StreamDescriptor }
  | { type: "state"; state: RoomStateMessage }
  | { type: "stream"; stream: StreamDescriptor }
  | { type: "chat_message"; message: ChatMessageDto }
  | { type: "reaction"; emoji: string; displayName: string }
  | { type: "room_ended"; reason: string }
  | {
      type: "error";
      code:
        | "room_full"
        | "room_expired"
        | "not_found"
        | "forbidden"
        | "rate_limited"
        | "video_unavailable"
        | "telegram_error";
      message: string;
    };

export const REACTION_EMOJIS = ["❤️", "😂", "😭", "😱", "🔥", "💀"] as const;
export const CHAT_MAX_LENGTH = 500;
