import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "../../../../../lib/db";
import { roomMembers, rooms, videos } from "../../../../../db/schema";
import { createWsTicket } from "../../../../../lib/auth";
import { getSessionUser, unauthorized } from "../../../../../lib/session";
import { rateLimit, rateLimitedResponse } from "../../../../../lib/rate-limit";

/**
 * REST join: validates room/existence/capacity (PRD 16.4) and writes the
 * membership row. The browser then opens the WebSocket for live state.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ code: string }> },
): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { code } = await context.params;

  const rl = rateLimit(`room-join:${user.userId}`, 20, 60_000);
  if (!rl.ok) return rateLimitedResponse(rl.retryAfterSeconds);

  const rows = await db
    .select({ room: rooms, video: videos })
    .from(rooms)
    .innerJoin(videos, eq(rooms.videoId, videos.id))
    .where(eq(rooms.inviteCode, code))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return NextResponse.json(
      { error: "This watch room could not be found." },
      { status: 404 },
    );
  }
  if (row.room.status === "ended" || row.room.expiresAt.getTime() <= Date.now()) {
    return NextResponse.json(
      { error: "This watch room has expired." },
      { status: 410 },
    );
  }

  const members = await db
    .select({ userId: roomMembers.userId, role: roomMembers.role })
    .from(roomMembers)
    .where(eq(roomMembers.roomId, row.room.id));

  if (members.some((m) => m.userId === user.userId)) {
    const existingRole = members.find((m) => m.userId === user.userId)!.role;
    return NextResponse.json({
      ok: true,
      role: existingRole,
      ticket: createWsTicket(user.userId, code),
    });
  }
  if (members.length >= 2) {
    return NextResponse.json(
      { error: "This room already has two participants." },
      { status: 409 },
    );
  }

  await db.insert(roomMembers).values({ roomId: row.room.id, userId: user.userId, role: "guest" });
  return NextResponse.json({
    ok: true,
    role: "guest",
    ticket: createWsTicket(user.userId, code),
  });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ code: string }> },
): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { code } = await context.params;

  const [room] = await db
    .select()
    .from(rooms)
    .where(eq(rooms.inviteCode, code))
    .limit(1);
  if (!room) {
    return NextResponse.json(
      { error: "This watch room could not be found." },
      { status: 404 },
    );
  }
  const memberRows = await db
    .select({
      role: roomMembers.role,
      userId: roomMembers.userId,
    })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, user.userId)))
    .limit(1);

  return NextResponse.json({
    inviteCode: room.inviteCode,
    title: room.title,
    status: room.status,
    isMember: memberRows.length > 0,
    role: memberRows[0]?.role ?? null,
    expiresAt: room.expiresAt.toISOString(),
  });
}
