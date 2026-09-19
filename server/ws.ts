import { createServer } from "http";
import { WebSocketServer, type WebSocket } from "ws";
import { env } from "../lib/env";
import { verifyWsTicket } from "../lib/auth";
import { rateLimit } from "../lib/rate-limit";
import { CHAT_MAX_LENGTH, type ClientEvent, type ServerEvent } from "../lib/protocol";
import { handleStreamRequest } from "./streamer";
import {
  allLiveRoomCodes,
  flushLiveRooms,
  liveRoomByCode,
  loadRoom,
  nextEpisodeVideoId,
  persistPlayback,
  roomState,
  saveChatMessage,
  streamDescriptorFor,
  switchRoomVideo,
  sweepExpiredRooms,
  touchMembership,
} from "./room-registry";

/**
 * Standalone realtime sync server (PRD 6.17).
 * One authoritative room state per room; every event is re-broadcast with
 * server wall-clock so clients can compute expected positions (PRD 11.1).
 *
 * Vercel cannot host long-lived sockets, so this process is deployed
 * separately (Dockerfile.ws) — see README "Deployment topology".
 */

type SocketContext = {
  code: string;
  userId: string;
  displayName: string;
};

const wss = new WebSocketServer({
  server: createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://internal");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    // Video bytes are served from this host (see server/streamer.ts) so the
    // Vercel functions never proxy movie traffic.
    void handleStreamRequest(req, res, url)
      .then((handled) => {
        if (handled) return;
        res.writeHead(404);
        res.end();
      })
      .catch((err) => {
        console.error("[ws] http handler error:", err);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  }).listen(env.wsPort),
});

function send(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

function broadcast(code: string, event: ServerEvent, except?: WebSocket): void {
  const room = liveRoomByCode(code);
  if (!room) return;
  for (const member of room.members.values()) {
    if (member.socket && member.socket !== except) {
      send(member.socket, event);
    }
  }
}

function clientError(
  socket: WebSocket,
  code: Extract<ServerEvent, { type: "error" }>["code"],
  message: string,
): void {
  send(socket, { type: "error", code, message });
}

wss.on("connection", async (socket, request) => {
  const url = new URL(request.url ?? "", "http://internal");
  const inviteCode = url.searchParams.get("code") ?? "";

  const ticket = verifyWsTicket(url.searchParams.get("token"));
  if (!ticket || ticket.code !== inviteCode.toLowerCase()) {
    clientError(socket, "forbidden", "Sign in to join this watch room.");
    socket.close();
    return;
  }

  const loaded = await loadRoom(inviteCode);
  if (loaded.error === "not_found") {
    clientError(socket, "not_found", "This watch room could not be found.");
    socket.close();
    return;
  }
  const room = loaded.room;
  if (!room || loaded.error === "room_expired") {
    clientError(socket, "room_expired", "This watch room has expired.");
    socket.close();
    return;
  }
  if (room.status === "ended" || loaded.error === "room_ended") {
    send(socket, { type: "room_ended", reason: "This watch room has ended." });
    socket.close();
    return;
  }

  const member = room.members.get(ticket.userId);
  if (!member) {
    if (room.members.size >= 2) {
      clientError(socket, "room_full", "This room already has two participants.");
      socket.close();
      return;
    }
    clientError(socket, "forbidden", "Join the room first.");
    socket.close();
    return;
  }

  if (member.socket && member.socket !== socket && member.socket.readyState === 1) {
    member.socket.close();
  }
  member.socket = socket;
  socket.__ctx = { code: room.inviteCode, userId: member.userId, displayName: member.displayName } satisfies SocketContext;
  await touchMembership(room.roomId, member.userId).catch(() => undefined);

  try {
    const stream = await streamDescriptorFor(room);
    send(socket, { type: "joined", state: roomState(room), stream });
  } catch {
    send(socket, { type: "joined", state: roomState(room), stream: { kind: "telegram", videoId: room.videoId, path: `/api/stream/${room.videoId}` } });
  }
  broadcast(room.inviteCode, { type: "state", state: roomState(room) }, socket);

  socket.on("message", async (raw) => {
    let event: ClientEvent;
    try {
      const parsed: unknown = JSON.parse(String(raw));
      // `null`/`123`/"x" are valid JSON but not client events. Without this
      // guard `event.type` throws inside an async handler, which becomes an
      // unhandled rejection and takes the whole sync server down.
      if (typeof parsed !== "object" || parsed === null) return;
      event = parsed as ClientEvent;
    } catch {
      return;
    }
    const ctx = socket.__ctx;
    if (!ctx) return;
    const live = liveRoomByCode(ctx.code);
    if (!live || live.status === "ended") return;
    const isHost = ctx.userId === live.hostUserId;

    switch (event.type) {
      case "ping": {
        send(socket, { type: "pong", t0: event.t0, serverTsMs: Date.now() });
        return;
      }
      case "play":
      case "pause":
      case "seek": {
        if (!isHost) {
          clientError(socket, "forbidden", "Only the host can control playback.");
          return;
        }
        const position = Math.max(0, Number(event.position) || 0);
        live.serverTsMs = Date.now();
        if (event.type === "play") {
          live.playing = true;
          live.positionSeconds = position;
          if (typeof event.rate === "number" && event.rate > 0) {
            live.playbackRate = Math.min(Math.max(event.rate, 0.25), 4);
          }
        } else if (event.type === "pause") {
          live.playing = false;
          live.positionSeconds = position;
        } else {
          live.positionSeconds = position;
        }
        await persistPlayback(live).catch(() => undefined);
        broadcast(ctx.code, { type: "state", state: roomState(live) });
        return;
      }
      case "sync": {
        send(socket, { type: "state", state: roomState(live) });
        return;
      }
      case "ended": {
        if (!isHost) {
          clientError(socket, "forbidden", "Only the host can control playback.");
          return;
        }
        live.playing = false;
        if (live.durationSeconds != null) {
          live.positionSeconds = live.durationSeconds;
        }
        live.serverTsMs = Date.now();
        await persistPlayback(live).catch(() => undefined);
        const nextId = await nextEpisodeVideoId(live).catch(() => null);
        if (nextId && (await switchRoomVideo(live, nextId))) {
          const stream = await streamDescriptorFor(live).catch(() => null);
          broadcast(ctx.code, { type: "state", state: roomState(live) });
          if (stream) broadcast(ctx.code, { type: "stream", stream });
        } else {
          broadcast(ctx.code, { type: "state", state: roomState(live) });
        }
        return;
      }
      case "change_video": {
        if (!isHost) {
          clientError(socket, "forbidden", "Only the host can change the video.");
          return;
        }
        const ok = await switchRoomVideo(live, String(event.videoId));
        if (!ok) {
          clientError(socket, "video_unavailable", "This video is currently unavailable.");
          return;
        }
        const stream = await streamDescriptorFor(live).catch(() => null);
        broadcast(ctx.code, { type: "state", state: roomState(live) });
        if (stream) broadcast(ctx.code, { type: "stream", stream });
        return;
      }
      case "chat": {
        const rl = rateLimit(`chat:${ctx.code}:${ctx.userId}`, 6, 10_000);
        if (!rl.ok) {
          clientError(socket, "rate_limited", "You are sending messages too quickly.");
          return;
        }
        const body = String(event.body ?? "").trim().slice(0, CHAT_MAX_LENGTH);
        if (body.length === 0) return;
        const ts =
          typeof event.videoTimestamp === "number"
            ? Math.max(0, event.videoTimestamp)
            : null;
        try {
          const saved = await saveChatMessage(live.roomId, ctx.userId, body, ts);
          broadcast(ctx.code, { type: "chat_message", message: saved });
        } catch {
          clientError(socket, "telegram_error", "Message could not be saved.");
        }
        return;
      }
      case "reaction": {
        const rl = rateLimit(`reaction:${ctx.code}:${ctx.userId}`, 12, 5_000);
        if (!rl.ok) return;
        const emoji = String(event.emoji ?? "").slice(0, 8);
        if (emoji.length === 0) return;
        broadcast(ctx.code, { type: "reaction", emoji, displayName: ctx.displayName });
        return;
      }
      case "leave": {
        socket.close();
        return;
      }
    }
  });

  socket.on("close", () => {
    const ctx = socket.__ctx;
    if (!ctx) return;
    const live = liveRoomByCode(ctx.code);
    const member = live?.members.get(ctx.userId);
    if (live && member && member.socket === socket) {
      member.socket = null;
      broadcast(ctx.code, { type: "state", state: roomState(live) });
    }
  });
});

declare module "ws" {
  interface WebSocket {
    __ctx?: SocketContext;
  }
}

// Keep live rooms periodically persisted + clients re-anchored, and
// expire rooms without anyone touching them (PRD 6.29, 10).
setInterval(() => {
  flushLiveRooms().catch(() => undefined);
}, 10_000).unref();

setInterval(() => {
  for (const code of allLiveRoomCodes()) {
    broadcast(code, { type: "state", state: stateOfCode(code) });
  }
}, 5_000).unref();

setInterval(() => {
  sweepExpiredRooms()
    .then((expired) => {
      for (const room of expired) {
        // sweepExpiredRooms() already removed the room from the live map, so
        // broadcast() would find nothing — talk to the members we still hold.
        const ended: ServerEvent = {
          type: "room_ended",
          reason: "This watch room has expired.",
        };
        for (const member of room.members.values()) {
          if (!member.socket) continue;
          send(member.socket, ended);
          member.socket.close();
        }
      }
    })
    .catch(() => undefined);
}, 60_000).unref();

function stateOfCode(code: string) {
  const room = liveRoomByCode(code);
  return room ? roomState(room) : (undefined as never);
}

// A throw inside an async socket handler would otherwise become an unhandled
// rejection and kill the process for every room at once. Log it, stay up.
process.on("unhandledRejection", (reason) => {
  console.error("[ws] unhandled rejection (kept alive):", reason);
});

const closing = () => {
  flushLiveRooms()
    .catch(() => undefined)
    .finally(() => process.exit(0));
};
process.on("SIGTERM", closing);
process.on("SIGINT", closing);

console.log(`[ws] sync server listening on :${env.wsPort}`);
