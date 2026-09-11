import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { env, telegramConfigured } from "./env";

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

/**
 * Resolve a Telegram message to a playable video document.
 * A fresh message fetch is also how expired file references recover:
 * every new stream request re-resolves the document.
 */
export async function resolveTelegramVideo(
  src: TelegramSource,
): Promise<{ message: Api.Message; size: number; mimeType: string }> {
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
  return { message, size: toNumber(doc.size), mimeType };
}

/**
 * Yields bytes for the inclusive byte range [start, end] with exact
 * length so it can back HTTP 206 responses (PRD 6.4 range-style access).
 */
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

  const client = await getTelegramClient();
  let yielded = 0;
  for await (const chunk of client.iterDownload(message, {
    offset: start,
    limit: wanted,
    requestSize: env.telegramChunkKb * 1024,
    signal,
  })) {
    if (signal?.aborted) return;
    const remaining = wanted - yielded;
    if (chunk.byteLength >= remaining) {
      yielded = wanted;
      yield chunk.subarray(0, remaining);
      return;
    }
    yielded += chunk.byteLength;
    yield chunk;
  }
  if (yielded < wanted) {
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
