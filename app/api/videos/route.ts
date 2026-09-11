import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "../../../lib/db";
import { series, videos } from "../../../db/schema";
import { getSessionUser, unauthorized } from "../../../lib/session";

/**
 * Public-ish video metadata listing (PRD 6.2).
 * Telegram identifiers are stripped — the browser never learns them (PRD 16.1).
 */
export async function GET(): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return unauthorized();

  const rows = await db
    .select({
      id: videos.id,
      title: videos.title,
      description: videos.description,
      thumbnail: videos.thumbnail,
      durationSeconds: videos.durationSeconds,
      year: videos.year,
      genre: videos.genre,
      season: videos.season,
      episode: videos.episode,
      seriesId: videos.seriesId,
      seriesTitle: series.title,
    })
    .from(videos)
    .leftJoin(series, eq(videos.seriesId, series.id))
    .orderBy(desc(videos.createdAt))
    .limit(100);

  return NextResponse.json({ videos: rows });
}
