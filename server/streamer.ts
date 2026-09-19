import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "stream";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import { videos } from "../db/schema";
import { verifyGrant } from "../lib/auth";
import { parseRange } from "../lib/range";
import { rateLimit } from "../lib/rate-limit";
import {
  readTelegramRange,
  telegramVideoInfo,
  TelegramFileUnavailableError,
  TelegramNotConfiguredError,
} from "../lib/telegram";

/**
 * Video delivery served by the sync-server host instead of Vercel.
 *
 * Why here: Telegram allows exactly one live connection per session, and
 * serverless instances are neither single nor long-lived — streaming from
 * Vercel invalidates the session and burns function duration (300 s timeouts
 * observed). This process already keeps the single MTProto client warm, sits
 * closer to the Telegram DC, and costs no Vercel bandwidth.
 *
 * Route: GET|HEAD /stream/:videoId?grant=<signed>
 */

const TEXT = { "content-type": "text/plain; charset=utf-8" } as const;

function fail(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { ...TEXT, "cache-control": "no-store" });
  res.end(message);
}

export async function handleStreamRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const match = /^\/stream\/([^/]+)$/.exec(url.pathname);
  if (!match) return false;

  const method = req.method ?? "GET";
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers": "range",
      "access-control-max-age": "86400",
    });
    res.end();
    return true;
  }
  if (method !== "GET" && method !== "HEAD") {
    fail(res, 405, "Method not allowed.");
    return true;
  }

  const videoId = decodeURIComponent(match[1]);
  const grant = url.searchParams.get("grant");
  if (!verifyGrant(videoId, grant)) {
    fail(res, 403, "Access expired. Rejoin the room.");
    return true;
  }

  const rl = rateLimit(`stream:${videoId}:${grant?.slice(-12) ?? "?"}`, 2400, 60_000);
  if (!rl.ok) {
    res.writeHead(429, { ...TEXT, "retry-after": String(rl.retryAfterSeconds || 1) });
    res.end("Too many streaming requests.");
    return true;
  }

  const [video] = await db.select().from(videos).where(eq(videos.id, videoId)).limit(1);
  if (!video) {
    fail(res, 404, "This video is currently unavailable.");
    return true;
  }

  if (video.sourceType === "url") {
    if (!video.url) {
      fail(res, 404, "This video is currently unavailable.");
      return true;
    }
    if (method === "HEAD") {
      res.writeHead(200, { "cache-control": "no-store" });
      res.end();
      return true;
    }
    res.writeHead(302, { location: video.url, "cache-control": "no-store" });
    res.end();
    return true;
  }

  if (!video.telegramChatId || video.telegramMessageId == null) {
    fail(res, 404, "This video has no Telegram source.");
    return true;
  }
  const source = { chatId: video.telegramChatId, messageId: video.telegramMessageId };

  // Headers come from the stored row: zero Telegram RPCs just to answer a
  // probe. Only legacy rows without a stored size pay for a resolve.
  let size = video.fileSizeBytes ?? 0;
  let mimeType = video.mimeType ?? "video/mp4";
  if (!size || size <= 0) {
    try {
      const info = await telegramVideoInfo(source);
      size = info.size;
      mimeType = info.mimeType;
    } catch (err) {
      console.error("[stream] resolve failed:", err);
      fail(
        res,
        err instanceof TelegramNotConfiguredError ? 503 : 502,
        "Video source temporarily unavailable. Please try again.",
      );
      return true;
    }
  }

  const range = parseRange(req.headers.range ?? null, size);
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;

  const headers: Record<string, string> = {
    "content-type": mimeType,
    "accept-ranges": "bytes",
    "content-length": String(end - start + 1),
    // Immutable Telegram document behind a signed grant: the browser may keep
    // what it downloaded, so seeks back do not re-fetch from Telegram.
    "cache-control": "private, max-age=3600, immutable",
    // The app is served from a different origin (Vercel) than the bytes
    // (sync host). Range requests are CORS-safelisted, but exposing these
    // headers keeps canvas/subtitle consumers working.
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "content-length, content-range, accept-ranges",
    ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
  };

  if (method === "HEAD") {
    res.writeHead(range ? 206 : 200, headers);
    res.end();
    return true;
  }

  const controller = new AbortController();
  req.on("close", () => controller.abort());
  res.writeHead(range ? 206 : 200, headers);

  try {
    const body = Readable.from(
      readTelegramRange(source, start, end, size, controller.signal),
    );
    body.on("error", (err) => {
      if (!controller.signal.aborted) console.error("[stream] body error:", err);
      res.destroy();
    });
    body.pipe(res);
  } catch (err) {
    console.error("[stream] failed:", err);
    if (!(err instanceof TelegramFileUnavailableError)) {
      console.error("[stream] unexpected", err);
    }
    res.destroy();
  }
  return true;
}
