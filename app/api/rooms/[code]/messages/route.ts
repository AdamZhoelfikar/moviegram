import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../../../../lib/db";
import { messages, roomMembers, rooms, users } from "../../../../../db/schema";
import { getSessionUser, unauthorized } from "../../../../../lib/session";

export async function GET(
  _request: Request,
  context: { params: Promise<{ code: string }> },
): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const { code } = await context.params;

  const [room] = await db.select().from(rooms).where(eq(rooms.inviteCode, code)).limit(1);
  if (!room) {
    return NextResponse.json(
      { error: "This watch room could not be found." },
      { status: 404 },
    );
  }
  const membership = await db
    .select({ userId: roomMembers.userId })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, user.userId)))
    .limit(1);
  if (membership.length === 0) {
    return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  }

  const rows = await db
    .select({
      id: messages.id,
      userId: messages.userId,
      body: messages.body,
      videoTimestamp: messages.videoTimestamp,
      createdAt: messages.createdAt,
      displayName: users.displayName,
    })
    .from(messages)
    .innerJoin(users, eq(messages.userId, users.id))
    .where(eq(messages.roomId, room.id))
    .orderBy(asc(messages.createdAt))
    .limit(200);

  return NextResponse.json({
    messages: rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      displayName: r.displayName,
      body: r.body,
      videoTimestamp: r.videoTimestamp,
      createdAt: r.createdAt.getTime(),
    })),
  });
}
