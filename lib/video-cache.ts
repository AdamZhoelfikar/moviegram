import { unstable_cache } from "next/cache";
import { desc, eq } from "drizzle-orm";
import { db } from "./db";
import { series, videos } from "../db/schema";

export type VideoListItem = {
  id: string;
  title: string;
  description: string | null;
  thumbnail: string | null;
  durationSeconds: number | null;
  year: number | null;
  genre: string | null;
  season: number | null;
  episode: number | null;
  seriesId: string | null;
  seriesTitle: string | null;
  subtitleUrl: string | null;
};

/**
 * The library listing is identical for every viewer and changes only when
 * someone imports, so it is cached for a minute instead of hitting Postgres
 * on every page view and API call. Vercel functions are billed per invocation
 * and Neon per query — this removes one round trip from both `/library` and
 * `/api/videos`.
 */
async function queryVideoList(): Promise<VideoListItem[]> {
  return db
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
      subtitleUrl: videos.subtitleUrl,
    })
    .from(videos)
    .leftJoin(series, eq(videos.seriesId, series.id))
    .orderBy(desc(videos.createdAt))
    .limit(100);
}

export const listVideos = unstable_cache(queryVideoList, ["video-list"], {
  revalidate: 60,
  tags: ["videos"],
});
