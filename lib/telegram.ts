import bigInt from "big-integer";
import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { env, telegramConfigured } from "./env";
import { alignToChunk } from "./range";

/**
 * Telegram MTProto streaming layer (PRD 6.3/6.4, POC B).
 *
 * Large files are downloaded from Telegram in chunks via teleproto's
 * `iterDownload` (upload.getFile under the hood, with offset + limit),
 * which is what makes HTTP byte-range serving and seeking possible
 * without downloading the whole movie.
 *
 * Credentials/session live only on the server, read from env vars
 * (PRD 6.3 Security, 16.1). Never exposed to the browser.
 */

let clientPromise: Promise<TelegramClient> | null = null;

export class TelegramNotConfiguredError extends Error {
  constructor() {
    super("Telegram integration is not configured on this server.");
    this.name = "TelegramNotConfiguredError";
  }
}

export class TelegramFileUnavailableError extends Error {
  constructor(
    message = "Video source temporarily unavailable. Please try again.",
  ) {
    super(message);
    this.name = "TelegramFileUnavailableError";
  }
}

export type TelegramSource = {
  chatId: string;
  messageId: number;
};

export async function getTelegramClient(): Promise<TelegramClient> {
  if (!telegramConfigured()) throw new TelegramNotConfiguredError();
  if (!clientPromise) {
    clientPromise = (async () => {
      const client = new TelegramClient(
        new StringSession(env.telegramSession),
        env.telegramApiId,
        env.telegramApiHash,
        { connectionRetries: 3 },
      );
      await client.connect();
      return client;
    })();
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }
  return clientPromise;
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  return Number(v ?? 0);
}

type ResolvedVideo = { message: Api.Message; size: number; mimeType: string };

/**
 * Resolve a Telegram message to a playable video document.
 * Resolves are cached briefly because browsers fire many overlapping range
 * requests per playback, and every resolve is extra MTProto RPC that can tip
 * the account into FLOOD_WAIT. Expired file references invalidate the entry
 * (see readTelegramRange), so the next request re-resolves the document.
 */
const RESOLVE_TTL_MS = 60_000;
const resolveCache = new Map<string, { at: number; value: ResolvedVideo }>();

export async function resolveTelegramVideo(
  src: TelegramSource,
): Promise<ResolvedVideo> {
  const key = `${src.chatId}:${src.messageId}`;
  const hit = resolveCache.get(key);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.value;

  const client = await getTelegramClient();
  const entity = await client.getEntity(src.chatId);
  const messages = await client.getMessages(entity, { ids: [src.messageId] });
  const message = messages[0];
  const media = message?.media;
  if (
    !(media instanceof Api.MessageMediaDocument) ||
    !(media.document instanceof Api.Document)
  ) {
    throw new TelegramFileUnavailableError("This video is currently unavailable.");
  }
  const doc = media.document;
  const mimeType = doc.mimeType ?? "video/mp4";
  if (!mimeType.startsWith("video/") && mimeType !== "application/octet-stream") {
    throw new TelegramFileUnavailableError("This video is currently unavailable.");
  }
  const value = { message, size: toNumber(doc.size), mimeType };
  resolveCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * In-process LRU of downloaded 512 KB chunks, keyed by file + offset.
 * Chrome's byte-range behaviour (probe, abort, overlapping re-requests,
 * rewind seeks) otherwise re-fetches the same chunks from Telegram and
 * trips upload.getFile FLOOD_WAIT penalties, which stall the stream and
 * show as a black player. Telegram documents are immutable, so cache
 * entries never go stale; process restart is the only eviction.
 */
const chunkCache = new Map<string, Uint8Array>();
const CHUNK_CACHE_LIMIT_BYTES = 64 * 1024 * 1024;
let chunkCacheBytes = 0;

function cachedChunk(key: string): Uint8Array | undefined {
  const hit = chunkCache.get(key);
  if (hit) {
    chunkCache.delete(key);
    chunkCache.set(key, hit);
  }
  return hit;
}

function rememberChunk(key: string, bytes: Uint8Array): void {
  if (chunkCache.has(key)) return;
  chunkCache.set(key, bytes);
  chunkCacheBytes += bytes.byteLength;
  while (chunkCacheBytes > CHUNK_CACHE_LIMIT_BYTES) {
    const oldest = chunkCache.entries().next();
    if (oldest.done) break;
    chunkCache.delete(oldest.value[0]);
    chunkCacheBytes -= oldest.value[1].byteLength;
  }
}

/**
 * Yields bytes for the inclusive byte range [start, end] with exact
 * length so it can back HTTP 206 responses (PRD 6.4 range-style access).
 *
 * MTProto requires each upload.getFile offset to be a multiple of the
 * request limit, so ranges start at the enclosing chunk boundary and the
 * leading remainder is discarded. Requests are pipelined (a sliding window
 * of `chunkConcurrency` in-flight chunks, yielded in offset order) because
 * a sequential chunk loop is RTT-bound — measured ~220 KB/s sequential vs
 * multiple MB/s pipelined, which is what makes 1080p playback viable.
 */
const CHUNK_WINDOW = 6;

export async function* readTelegramRange(
  src: TelegramSource,
  start: number,
  end: number,
  totalSize: number,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const { message } = await resolveTelegramVideo(src);
  const wanted = Math.max(0, Math.min(end, totalSize - 1) - start + 1);
  if (wanted === 0) return;

  const chunk = env.telegramChunkKb * 1024;
  const { offset: alignedStart, skip: initialSkip } = alignToChunk(start, chunk);
  const last = start + wanted - 1;
  const firstChunk = alignedStart / chunk;
  const lastChunk = Math.floor(last / chunk);

  const client = await getTelegramClient();
  const media = message.media as Api.MessageMediaDocument;
  if (!(media.document instanceof Api.Document)) {
    throw new TelegramFileUnavailableError();
  }
  const doc = media.document;
  const location = new Api.InputDocumentFileLocation({
    id: doc.id,
    accessHash: doc.accessHash,
    fileReference: doc.fileReference,
    thumbSize: "",
  });
  let dcId: number | undefined = doc.dcId || undefined;

  const requestChunk = (index: number): Promise<Uint8Array | null> =>
    (async () => {
      const cacheKey = `${String(doc.id)}:${index}`;
      const cached = cachedChunk(cacheKey);
      if (cached) return cached;
      for (;;) {
        try {
          const result = await client.invoke(
            new Api.upload.GetFile({
              location,
              offset: bigInt(index * chunk),
              limit: chunk,
              precise: true,
            }),
            dcId,
          );
          if (result instanceof Api.upload.FileCdnRedirect) {
            throw new TelegramFileUnavailableError();
          }
          const bytes = result.bytes as Uint8Array;
          if (bytes.byteLength === chunk) rememberChunk(cacheKey, bytes);
          return bytes;
        } catch (err) {
          const rpc = err as { errorMessage?: string; newDc?: number };
          if (
            typeof rpc.errorMessage === "string" &&
            rpc.errorMessage.startsWith("FILE_MIGRATE_") &&
            typeof rpc.newDc === "number"
          ) {
            dcId = rpc.newDc;
            continue;
          }
          if (
            typeof rpc.errorMessage === "string" &&
            rpc.errorMessage.startsWith("FILE_REFERENCE_EXPIRED")
          ) {
            // Drop the cached message so the next request re-resolves it.
            resolveCache.delete(`${src.chatId}:${src.messageId}`);
          }
          throw err instanceof TelegramFileUnavailableError
            ? err
            : new TelegramFileUnavailableError();
        }
      }
    })();

  const inflight = new Map<number, Promise<Uint8Array | null>>();
  const keepWarm = () => {
    while (!signal?.aborted && next <= lastChunk && inflight.size < CHUNK_WINDOW) {
      const p = requestChunk(next);
      p.catch(() => undefined); // avoid unhandled rejections if we bail early
      inflight.set(next, p);
      next += 1;
    }
  };
  let next = firstChunk;
  keepWarm();

  let remaining = wanted;
  let skip = initialSkip;
  for (let index = firstChunk; index <= lastChunk; index += 1) {
    if (signal?.aborted) return;
    const pending = inflight.get(index);
    inflight.delete(index);
    keepWarm();
    const bytes = await pending;
    if (!bytes) break;
    let data = bytes;
    if (skip > 0) {
      const drop = Math.min(skip, data.byteLength);
      skip -= drop;
      data = data.subarray(drop);
    }
    if (data.byteLength >= remaining) {
      yield data.subarray(0, remaining);
      return;
    }
    if (data.byteLength > 0) {
      remaining -= data.byteLength;
      yield data;
    }
    if (bytes.byteLength < chunk) break; // hit EOF
  }
  if (remaining > 0) {
    throw new TelegramFileUnavailableError();
  }
}

/** Total file size + mime for Content-Range / Content-Type headers. */
export async function telegramVideoInfo(
  src: TelegramSource,
): Promise<{ size: number; mimeType: string }> {
  const { size, mimeType } = await resolveTelegramVideo(src);
  return { size, mimeType };
}

/**
 * Interactive login to mint TELEGRAM_SESSION (StringSession) for .env.local.
 * Run from scripts/telegram-login.ts — credentials come from env only.
 */
export async function createStringSession(
  phone: string,
  phoneCode: () => Promise<string>,
): Promise<string> {
  if (env.telegramApiId <= 0 || !env.telegramApiHash) {
    throw new Error("TELEGRAM_API_ID and TELEGRAM_API_HASH must be set first.");
  }
  const client = new TelegramClient(
    new StringSession(""),
    env.telegramApiId,
    env.telegramApiHash,
    { connectionRetries: 3 },
  );
  await client.start({
    phoneNumber: async () => phone,
    password: async () => process.env.TELEGRAM_PASSWORD ?? "",
    phoneCode,
    onError: (err: unknown) => console.error(err),
  });
  return (client.session as StringSession).save();
}
