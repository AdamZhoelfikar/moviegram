import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "../../../lib/db";
import { roomMembers, rooms, videos } from "../../../db/schema";
import { generateInviteCode } from "../../../lib/auth";
import { env } from "../../../lib/env";
import { getSessionUser, unauthorized } from "../../../lib/session";
import { rateLimit, rateLimitedResponse } from "../../../lib/rate-limit";

export async function POST(request: Request): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return unauthorized();

  const rl = rateLimit(`room-create:${user.userId}`, 10, 60_000);
  if (!rl.ok) return rateLimitedResponse(rl.retryAfterSeconds);

  let body: { videoId?: unknown; title?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const videoId = String(body.videoId ?? "");
  const title = String(body.title ?? "").trim().slice(0, 80) || "Watch Party";

  const [video] = await db.select().from(videos).where(eq(videos.id, videoId)).limit(1);
  if (!video) {
    return NextResponse.json(
      { error: "This video is currently unavailable." },
      { status: 400 },
    );
  }

  // Invite codes are random, non-sequential, hard to guess (PRD 16.2).
  let inviteCode = generateInviteCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.inviteCode, inviteCode))
      .limit(1);
    if (clash.length === 0) break;
    inviteCode = generateInviteCode();
  }

  const expiresAt = new Date(Date.now() + env.roomTtlHours * 3_600_000);
  const [room] = await db
    .insert(rooms)
    .values({
      inviteCode,
      title,
      hostId: user.userId,
      videoId,
      expiresAt,
    })
    .returning();
  await db.insert(roomMembers).values({ roomId: room.id, userId: user.userId, role: "host" });

  return NextResponse.json({
    inviteCode: room.inviteCode,
    roomId: room.id,
    url: `/r/${room.inviteCode}`,
  });
}

export async function GET(): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const rows = await db
    .select({
      id: rooms.id,
      inviteCode: rooms.inviteCode,
      title: rooms.title,
      status: rooms.status,
      createdAt: rooms.createdAt,
      expiresAt: rooms.expiresAt,
      videoTitle: videos.title,
    })
    .from(rooms)
    .innerJoin(roomMembers, and(eq(roomMembers.roomId, rooms.id), eq(roomMembers.userId, user.userId)))
    .innerJoin(videos, eq(rooms.videoId, videos.id))
    .where(eq(rooms.status, "active"))
    .orderBy(rooms.createdAt)
    .limit(20);
  return NextResponse.json({ rooms: rows });
}
