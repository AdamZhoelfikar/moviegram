import { eq } from "drizzle-orm";
import { db } from "../../../../lib/db";
import { videos } from "../../../../db/schema";
import { verifyGrant } from "../../../../lib/auth";
import { rateLimit } from "../../../../lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Thin asset redirector — deliberately does NOT touch Telegram.
 *
 * Telegram permits one live MTProto connection per session, and Vercel runs
 * many short-lived instances, so any Telegram work here would invalidate the
 * session the sync server holds (observed: "Concurrent usage of the current
 * session ... invalidated"). Movie bytes are served by the sync-server host
 * instead (server/streamer.ts); keeping teleproto out of this route also
 * removes ~2 MB from every Vercel function bundle.
 *
 * `url` sources (demo/local media) still redirect so the browser fetches them
 * directly from their origin.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ videoId: string }> },
): Promise<Response> {
  const { videoId } = await context.params;
  const url = new URL(request.url);

  if (!verifyGrant(videoId, url.searchParams.get("grant"))) {
    return new Response("Access expired. Rejoin the room.", { status: 403 });
  }
  const rl = rateLimit(`stream:${videoId}`, 120, 60_000);
  if (!rl.ok) {
    return new Response("Too many requests.", { status: 429 });
  }

  const [video] = await db.select().from(videos).where(eq(videos.id, videoId)).limit(1);
  if (!video) {
    return new Response("This video is currently unavailable.", { status: 404 });
  }

  if (video.sourceType === "url") {
    if (!video.url) {
      return new Response("This video is currently unavailable.", { status: 404 });
    }
    return new Response(null, {
      status: 302,
      headers: { location: video.url, "cache-control": "no-store" },
    });
  }

  return new Response("Video is served by the sync server.", { status: 409 });
}

export async function HEAD(
  request: Request,
  context: { params: Promise<{ videoId: string }> },
): Promise<Response> {
  const response = await GET(request, context);
  return new Response(null, { status: response.status, headers: response.headers });
}
