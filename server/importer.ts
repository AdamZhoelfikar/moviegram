import { randomUUID } from "crypto";
import { Api, type TelegramClient } from "teleproto";
import { and, eq } from "drizzle-orm";
import { db } from "../lib/db";
import { videos } from "../db/schema";
import { getTelegramClient } from "../lib/telegram";

/**
 * Imports video documents from a Telegram channel into the library
 * (channel → message references → database). Only references + metadata are
 * stored, never the file itself.
 *
 * Shared by the CLI (scripts/import-telegram.ts) and the sync host's periodic
 * scan, so a new upload appears in the library without anyone running a
 * command. Runs inside the single Telegram-owning process on purpose — a second
 * process using the same session would invalidate the auth key.
 */

export type ImportResult = {
  chatId: string;
  inserted: number;
  skipped: number;
  titles: string[];
};

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  return Number(v ?? 0);
}

export async function importChannelVideos(
  channel: string,
  opts: { limit?: number; client?: TelegramClient } = {},
): Promise<ImportResult> {
  const limit = opts.limit ?? 200;
  const client = opts.client ?? (await getTelegramClient());
  const entity = await client.getEntity(channel);
  const chatId =
    entity instanceof Api.Channel ? `-100${entity.id}` : String((entity as Api.Chat).id);

  let inserted = 0;
  let skipped = 0;
  const titles: string[] = [];

  for await (const message of client.iterMessages(entity, { limit })) {
    const media = message.media;
    if (!(media instanceof Api.MessageMediaDocument) || !(media.document instanceof Api.Document)) {
      continue;
    }
    const doc = media.document;
    if (!doc.mimeType?.startsWith("video/")) continue;

    const [existing] = await db
      .select({ id: videos.id })
      .from(videos)
      .where(
        and(eq(videos.telegramChatId, chatId), eq(videos.telegramMessageId, message.id)),
      )
      .limit(1);
    if (existing) {
      skipped += 1;
      continue;
    }

    let title = message.text?.split("\n")[0]?.slice(0, 120) ?? "";
    let durationSeconds: number | null = null;
    for (const attr of doc.attributes) {
      if (attr instanceof Api.DocumentAttributeFilename) {
        if (!title) title = attr.fileName.replace(/\.[a-z0-9]+$/i, "");
      }
      if (attr instanceof Api.DocumentAttributeVideo) {
        durationSeconds = toNumber(attr.duration) || null;
      }
    }
    if (!title) title = `Telegram video ${message.id}`;

    await db.insert(videos).values({
      id: randomUUID(),
      title,
      description: message.text?.slice(0, 2000) ?? null,
      durationSeconds,
      sourceType: "telegram",
      telegramChatId: chatId,
      telegramMessageId: message.id,
      telegramFileId: String(doc.id),
      mimeType: doc.mimeType ?? "video/mp4",
      fileSizeBytes: toNumber(doc.size),
    });
    inserted += 1;
    titles.push(title);
  }

  return { chatId, inserted, skipped, titles };
}
