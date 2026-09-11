import { randomUUID } from "crypto";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { env } from "../lib/env";
import { messages, roomMembers, rooms, users, videos } from "../db/schema";
import { createGrant } from "../lib/auth";
import type { WebSocket } from "ws";
import type {
  ChatMessageDto,
  PresenceUser,
  RoomStateMessage,
  StreamDescriptor,
} from "../lib/protocol";

/**
 * Authoritative live room state, held in the sync-server process but
 * persisted to PostgreSQL so restarts recover the correct timeline
 * (PRD 6.10/6.16/10 — the in-memory map is a cache, never the truth).
 */

type LiveRoom = {
  roomId: string;
  inviteCode: string;
  title: string;
  hostUserId: string;
  videoId: string;
  videoTitle: string;
  durationSeconds: number | null;
  playing: boolean;
  positionSeconds: number;
  playbackRate: number;
  serverTsMs: number;
  expiresAtMs: number;
  status: "active" | "ended";
  members: Map<string, PresenceUser & { socket?: WebSocket | null }>;
  dirty: boolean;
};

const liveRooms = new Map<string, LiveRoom>();

export function liveRoomByCode(code: string): LiveRoom | undefined {
  return liveRooms.get(code.toLowerCase());
}

export function allLiveRoomCodes(): string[] {
  return [...liveRooms.values()]
    .filter((room) => room.status === "active")
    .map((room) => room.inviteCode);
}

function stateOf(room: LiveRoom): RoomStateMessage {
  return {
    roomId: room.roomId,
    title: room.title,
    videoId: room.videoId,
    videoTitle: room.videoTitle,
    durationSeconds: room.durationSeconds,
    playing: room.playing,
    positionSeconds: room.positionSeconds,
    playbackRate: room.playbackRate,
    serverTsMs: room.serverTsMs,
    hostUserId: room.hostUserId,
    participants: [...room.members.values()].map((m) => ({
      userId: m.userId,
      displayName: m.displayName,
      role: m.role,
      connected: Boolean(m.socket && m.socket.readyState === 1),
    })),
    expiresAtMs: room.expiresAtMs,
  };
}

export function roomState(room: LiveRoom): RoomStateMessage {
  return stateOf(room);
}

export function roomMembersOf(room: LiveRoom): PresenceUser[] {
  return [...room.members.values()].map((m) => ({
    userId: m.userId,
    displayName: m.displayName,
    role: m.role,
    connected: Boolean(m.socket && m.socket.readyState === 1),
  }));
}

export async function streamDescriptorFor(room: LiveRoom): Promise<StreamDescriptor> {
  const [video] = await db
    .select()
    .from(videos)
    .where(eq(videos.id, room.videoId))
    .limit(1);
  if (!video) {
    throw new Error(`Video ${room.videoId} not found`);
  }
  if (video.sourceType === "url" && video.url) {
    return {
      kind: "url",
      videoId: video.id,
      url: video.url,
      subtitlePath: video.subtitleUrl ?? undefined,
    };
  }
  const grant = createGrant(video.id, env.streamTokenTtlHours);
  return {
    kind: "telegram",
    videoId: video.id,
    path: `/api/stream/${video.id}?grant=${encodeURIComponent(grant)}`,
    subtitlePath: video.subtitleUrl ?? undefined,
  };
}

/**
 * Load (or hydrate) the live room for an invite code.
 * Expired/missing rooms return null with a reason for a precise error.
 */
export async function loadRoom(
  inviteCode: string,
): Promise<{ room?: LiveRoom; error?: "not_found" | "room_expired" | "room_ended" }> {
  const key = inviteCode.toLowerCase();
  const cached = liveRooms.get(key);
  if (cached) {
    if (cached.status === "ended") return { error: "room_ended", room: cached };
    if (cached.expiresAtMs <= Date.now()) {
      await finalizeExpiredRoom(cached);
      return { error: "room_expired", room: cached };
    }
    // REST joins happen in the Next.js process, so membership can change
    // without this server knowing. Re-sync the roster on every connect.
    const fresh = await db
      .select({
        userId: roomMembers.userId,
        role: roomMembers.role,
        displayName: users.displayName,
      })
      .from(roomMembers)
      .innerJoin(users, eq(roomMembers.userId, users.id))
      .where(eq(roomMembers.roomId, cached.roomId));
    for (const m of fresh) {
      if (!cached.members.has(m.userId)) {
        cached.members.set(m.userId, {
          userId: m.userId,
          displayName: m.displayName,
          role: m.role ?? "guest",
          connected: false,
          socket: null,
        });
      }
    }
    return { room: cached };
  }

  const rows = await db
    .select({
      room: rooms,
      video: videos,
    })
    .from(rooms)
    .innerJoin(videos, eq(rooms.videoId, videos.id))
    .where(eq(rooms.inviteCode, inviteCode))
    .limit(1);
  const row = rows[0];
  if (!row) return { error: "not_found" };
  if (row.room.status === "ended") return { error: "room_ended" };
  if (row.room.expiresAt.getTime() <= Date.now()) {
    await db.update(rooms).set({ status: "ended" }).where(eq(rooms.id, row.room.id));
    return { error: "room_expired" };
  }

  const memberRows = await db
    .select({
      userId: roomMembers.userId,
      role: roomMembers.role,
      displayName: users.displayName,
    })
    .from(roomMembers)
    .innerJoin(users, eq(roomMembers.userId, users.id))
    .where(eq(roomMembers.roomId, row.room.id));

  // Recover the timeline the room would be at right now, using the DB clock
  // so the app server and the sync server never disagree about elapsed time.
  const [computed] = await db
    .select({
      position: sql<number>`case when ${rooms.playing} then
        ${rooms.positionSeconds} + extract(epoch from (now() - ${rooms.serverTime})) * ${rooms.playbackRate}
      else ${rooms.positionSeconds} end`,
      dbNow: sql<number>`extract(epoch from now()) * 1000`,
    })
    .from(rooms)
    .where(eq(rooms.id, row.room.id));

  const room: LiveRoom = {
    roomId: row.room.id,
    inviteCode: row.room.inviteCode,
    title: row.room.title,
    hostUserId: row.room.hostId,
    videoId: row.video.id,
    videoTitle: row.video.title,
    durationSeconds: row.video.durationSeconds,
    playing: row.room.playing,
    positionSeconds: Number(computed?.position ?? row.room.positionSeconds),
    playbackRate: row.room.playbackRate,
    serverTsMs: Number(computed?.dbNow ?? Date.now()),
    expiresAtMs: row.room.expiresAt.getTime(),
    status: "active",
    members: new Map(
      memberRows.map((m) => [
        m.userId,
        {
          userId: m.userId,
          displayName: m.displayName,
          role: m.role ?? "guest",
          connected: false,
          socket: null,
        },
      ]),
    ),
    dirty: false,
  };
  if (row.video.durationSeconds != null) {
    room.positionSeconds = Math.min(room.positionSeconds, row.video.durationSeconds);
  }
  liveRooms.set(key, room);
  return { room };
}

/** Persist authoritative playback state to PostgreSQL. */
export async function persistPlayback(room: LiveRoom): Promise<void> {
  await db
    .update(rooms)
    .set({
      playing: room.playing,
      positionSeconds: room.positionSeconds,
      playbackRate: room.playbackRate,
      serverTime: new Date(),
    })
    .where(eq(rooms.id, room.roomId));
  room.dirty = false;
}

/** Flush every live room that is currently playing so a restart keeps time. */
export async function flushLiveRooms(): Promise<void> {
  const now = Date.now();
  for (const room of liveRooms.values()) {
    if (room.status === "ended") continue;
    if (room.playing) {
      room.positionSeconds =
        room.positionSeconds + ((now - room.serverTsMs) / 1000) * room.playbackRate;
      room.serverTsMs = now;
    }
    await persistPlayback(room).catch(() => undefined);
  }
}

async function finalizeExpiredRoom(room: LiveRoom): Promise<void> {
  room.status = "ended";
  await db
    .update(rooms)
    .set({ status: "ended", playing: false })
    .where(eq(rooms.id, room.roomId))
    .catch(() => undefined);
}

export async function sweepExpiredRooms(): Promise<LiveRoom[]> {
  const now = Date.now();
  const expiredLive: LiveRoom[] = [];
  for (const room of [...liveRooms.values()]) {
    if (room.status === "active" && room.expiresAtMs <= now) {
      await finalizeExpiredRoom(room);
      liveRooms.delete(room.inviteCode.toLowerCase());
      expiredLive.push(room);
    }
  }
  await db
    .update(rooms)
    .set({ status: "ended", playing: false })
    .where(and(eq(rooms.status, "active"), lt(rooms.expiresAt, new Date())))
    .catch(() => undefined);
  return expiredLive;
}

export async function setRoomEnded(roomId: string): Promise<void> {
  await db.update(rooms).set({ status: "ended", playing: false }).where(eq(rooms.id, roomId));
}

export async function switchRoomVideo(room: LiveRoom, videoId: string): Promise<boolean> {
  const [video] = await db.select().from(videos).where(eq(videos.id, videoId)).limit(1);
  if (!video) return false;
  room.videoId = video.id;
  room.videoTitle = video.title;
  room.durationSeconds = video.durationSeconds;
  room.playing = false;
  room.positionSeconds = 0;
  room.playbackRate = 1;
  room.serverTsMs = Date.now();
  await db
    .update(rooms)
    .set({
      videoId: video.id,
      playing: false,
      positionSeconds: 0,
      playbackRate: 1,
      serverTime: new Date(),
    })
    .where(eq(rooms.id, room.roomId));
  return true;
}

/** Auto-next-episode for series content (PRD 6.24, minimal). */
export async function nextEpisodeVideoId(room: LiveRoom): Promise<string | null> {
  const [current] = await db
    .select()
    .from(videos)
    .where(eq(videos.id, room.videoId))
    .limit(1);
  if (!current?.seriesId || current.episode == null) return null;
  const [next] = await db
    .select({ id: videos.id })
    .from(videos)
    .where(
      and(
        eq(videos.seriesId, current.seriesId),
        sql`${videos.episode} = ${current.episode} + 1`,
        current.season != null ? eq(videos.season, current.season) : isNull(videos.season),
      ),
    )
    .limit(1);
  return next?.id ?? null;
}

export async function saveChatMessage(
  roomId: string,
  userId: string,
  body: string,
  videoTimestamp: number | null,
): Promise<ChatMessageDto> {
  const displayName =
    (await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .then((r) => r[0]?.displayName)) ?? "Unknown";
  const id = randomUUID();
  const createdAt = new Date();
  await db.insert(messages).values({
    id,
    roomId,
    userId,
    body,
    videoTimestamp,
    createdAt,
  });
  await db
    .update(roomMembers)
    .set({ lastSeenAt: createdAt })
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)));
  return { id, userId, displayName, body, videoTimestamp, createdAt: createdAt.getTime() };
}

export async function touchMembership(roomId: string, userId: string): Promise<void> {
  await db
    .update(roomMembers)
    .set({ lastSeenAt: new Date() })
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)));
}
