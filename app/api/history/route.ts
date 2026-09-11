import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "../../../lib/db";
import { videos, watchHistory } from "../../../db/schema";
import { getSessionUser, unauthorized } from "../../../lib/session";
import { rateLimit, rateLimitedResponse } from "../../../lib/rate-limit";

/** Watch history (PRD 6.26): upsert progress per user/video; list for "Continue watching". */
export async function POST(request: Request): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const rl = rateLimit(`history:${user.userId}`, 60, 60_000);
  if (!rl.ok) return rateLimitedResponse(rl.retryAfterSeconds);

  let body: { videoId?: unknown; position?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const videoId = String(body.videoId ?? "");
  const position = Number(body.position ?? 0);
  if (!Number.isFinite(position) || position < 0) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const [video] = await db.select({ id: videos.id }).from(videos).where(eq(videos.id, videoId)).limit(1);
  if (!video) {
    return NextResponse.json({ error: "This video is currently unavailable." }, { status: 404 });
  }

  await db
    .insert(watchHistory)
    .values({ userId: user.userId, videoId, positionSeconds: position, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [watchHistory.userId, watchHistory.videoId],
      set: { positionSeconds: position, updatedAt: new Date() },
    });
  return NextResponse.json({ ok: true });
}

export async function GET(): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const rows = await db
    .select({
      videoId: watchHistory.videoId,
      title: videos.title,
      thumbnail: videos.thumbnail,
      durationSeconds: videos.durationSeconds,
      positionSeconds: watchHistory.positionSeconds,
      updatedAt: watchHistory.updatedAt,
    })
    .from(watchHistory)
    .innerJoin(videos, eq(watchHistory.videoId, videos.id))
    .where(eq(watchHistory.userId, user.userId))
    .orderBy(desc(watchHistory.updatedAt))
    .limit(20);
  return NextResponse.json({ history: rows });
}
