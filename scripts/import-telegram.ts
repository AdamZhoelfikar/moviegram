import { randomUUID } from "crypto";
import { Api } from "teleproto";
import { and, eq } from "drizzle-orm";
import { db } from "../lib/db";
import { videos } from "../db/schema";
import { getTelegramClient } from "../lib/telegram";
import { env } from "../lib/env";

/**
 * Imports video documents from a private Telegram channel into the library
 * (PRD 6.3 workflow: channel → message references → database).
 * Only references + metadata are stored, never the file itself.
 *
 * Usage: TELEGRAM_IMPORT_CHANNEL=@mychannel npm run import:telegram
 */

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  return Number(v ?? 0);
}

async function main(): Promise<void> {
  const channel = process.argv[2] ?? env.telegramImportChannel;
  if (!channel) {
    console.error("Usage: npm run import:telegram -- @channelusername | -100xxxxxxxxxx");
    process.exit(1);
  }

  const client = await getTelegramClient();
  const entity = await client.getEntity(channel);
  const chatId =
    entity instanceof Api.Channel ? `-100${entity.id}` : String((entity as Api.Chat).id);

  let inserted = 0;
  let skipped = 0;
  for await (const message of client.iterMessages(entity, { limit: 200 })) {
    const media = message.media;
    if (!(media instanceof Api.MessageMediaDocument) || !(media.document instanceof Api.Document)) {
      continue;
    }
    const doc = media.document;
    const isVideo = doc.mimeType?.startsWith("video/");
    if (!isVideo) continue;

    const [existing] = await db
      .select({ id: videos.id })
      .from(videos)
      .where(
        and(
          eq(videos.telegramChatId, chatId),
          eq(videos.telegramMessageId, message.id),
        ),
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
    console.log(`+ ${title} (msg ${message.id})`);
  }

  console.log(`Done. Inserted ${inserted}, skipped ${skipped} already-imported.`);
  await client.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
