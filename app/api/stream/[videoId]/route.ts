import { eq } from "drizzle-orm";
import { db } from "../../../../lib/db";
import { videos } from "../../../../db/schema";
import { verifyGrant } from "../../../../lib/auth";
import { parseRange } from "../../../../lib/range";
import { rateLimit } from "../../../../lib/rate-limit";
import {
  readTelegramRange,
  telegramVideoInfo,
  TelegramFileUnavailableError,
  TelegramNotConfiguredError,
} from "../../../../lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Range-style video delivery (PRD 6.4).
 *
 * - `url` sources redirect so the browser talks to the origin directly —
 *   Vercel never proxies those bytes (PRD 15).
 * - `telegram` sources are streamed from MTProto in chunks and re-exposed
 *   with correct byte-range semantics, so <video> can start, seek and
 *   buffer without ever downloading the whole file (POC B).
 *
 * Access requires a short-lived signed grant (PRD 16.6) — no permanent
 * public movie URLs.
 */

async function handle(
  request: Request,
  params: { videoId: string },
  method: "GET" | "HEAD",
): Promise<Response> {
  const url = new URL(request.url);
  const { videoId } = params;

  if (!verifyGrant(videoId, url.searchParams.get("grant"))) {
    return new Response("Access expired. Rejoin the room.", { status: 403 });
  }
  const rl = rateLimit(`stream:${videoId}:${url.searchParams.get("grant")?.slice(-12) ?? "?"}`, 1200, 60_000);
  if (!rl.ok) {
    return new Response("Too many streaming requests.", { status: 429 });
  }

  const [video] = await db.select().from(videos).where(eq(videos.id, videoId)).limit(1);
  if (!video) {
    return new Response("This video is currently unavailable.", { status: 404 });
  }

  if (video.sourceType === "url") {
    if (!video.url) {
      return new Response("This video is currently unavailable.", { status: 404 });
    }
    if (method === "HEAD") {
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 302, headers: { location: video.url } });
  }

  if (!video.telegramChatId || video.telegramMessageId == null) {
    return new Response("This video has no Telegram source.", { status: 404 });
  }
  const source = { chatId: video.telegramChatId, messageId: video.telegramMessageId };

  let size: number;
  let mimeType: string;
  try {
    const info = await telegramVideoInfo(source);
    size = info.size;
    mimeType = info.mimeType;
  } catch (err) {
    if (err instanceof TelegramNotConfiguredError) {
      return new Response("Video source temporarily unavailable. Please try again.", {
        status: 503,
      });
    }
    if (err instanceof TelegramFileUnavailableError) {
      return new Response(err.message, { status: 502 });
    }
    return new Response("Video source temporarily unavailable. Please try again.", {
      status: 502,
    });
  }

  const range = parseRange(request.headers.get("range"), size);
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;

  const baseHeaders: Record<string, string> = {
    "content-type": mimeType,
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
  };

  if (method === "HEAD") {
    return new Response(null, {
      status: range ? 206 : 200,
      headers: {
        ...baseHeaders,
        "content-length": String(end - start + 1),
        ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
      },
    });
  }

  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    start(readController) {
      (async () => {
        try {
          for await (const chunk of readTelegramRange(source, start, end, size, controller.signal)) {
            if (controller.signal.aborted) break;
            readController.enqueue(chunk);
          }
          readController.close();
        } catch (err) {
          readController.error(err);
        }
      })();
    },
    cancel() {
      controller.abort();
    },
  });

  return new Response(stream, {
    status: range ? 206 : 200,
    headers: {
      ...baseHeaders,
      "content-length": String(end - start + 1),
      ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
    },
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ videoId: string }> },
): Promise<Response> {
  return handle(request, await context.params, "GET");
}

export async function HEAD(
  request: Request,
  context: { params: Promise<{ videoId: string }> },
): Promise<Response> {
  return handle(request, await context.params, "HEAD");
}
