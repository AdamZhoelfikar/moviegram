import { randomUUID } from "crypto";
import { db } from "../lib/db";
import { series, users, videos } from "../db/schema";

/**
 * Seeds POC-A demo content: videos whose bytes live in public/media,
 * so strict sync can be validated without any Telegram credentials.
 * Safe to run repeatedly (upserts by id).
 */
async function main(): Promise<void> {
  const [host] = await db
    .insert(users)
    .values({ username: "demo-host", displayName: "Adam" })
    .onConflictDoNothing()
    .returning();
  void host;

  await db
    .insert(series)
    .values({ id: "bunny-adventures", title: "Big Buck Bunny Adventures" })
    .onConflictDoNothing();

  const demoId = randomUUID().slice(0, 8);
  const values = [
    {
      id: "demo-sync-clock",
      title: "Sync Clock (2 min)",
      description:
        "Synthetic 120-second clip with a burned-in timestamp — built for sync QA, seeking and long-playback checks. Generate it with: ffmpeg -f lavfi -i \"testsrc2=duration=120:size=640x360:rate=25\" -f lavfi -i \"sine=frequency=520:duration=120\" -vf \"drawtext=text='%{pts\\:hms}':fontsize=40:fontcolor=white:box=1:boxcolor=black@0.6:x=10:y=10\" -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -c:a aac -shortest -movflags +faststart public/media/sync-clock.mp4",
      durationSeconds: 120,
      year: null,
      genre: null,
      sourceType: "url" as const,
      url: "/media/sync-clock.mp4",
      mimeType: "video/mp4",
    },
    {
      id: `demo-bbb-${demoId}`,
      title: "Big Buck Bunny",
      description:
        "The classic open-movie Blender Foundation release — perfect 10-second loop for sync testing.",
      durationSeconds: 10,
      year: 2008,
      genre: "Animation",
      sourceType: "url" as const,
      url: "/media/big-buck-bunny.mp4",
      mimeType: "video/mp4",
    },
    {
      id: `demo-ep1-${demoId}`,
      title: "Bunny Adventures — S1E1",
      description: "Episode 1 of the demo series (auto next episode test).",
      durationSeconds: 10,
      year: 2008,
      genre: "Animation",
      sourceType: "url" as const,
      url: "/media/big-buck-bunny.mp4",
      mimeType: "video/mp4",
      seriesId: "bunny-adventures",
      season: 1,
      episode: 1,
    },
    {
      id: `demo-ep2-${demoId}`,
      title: "Bunny Adventures — S1E2",
      description: "Episode 2 of the demo series.",
      durationSeconds: 10,
      year: 2008,
      genre: "Animation",
      sourceType: "url" as const,
      url: "/media/big-buck-bunny.mp4",
      mimeType: "video/mp4",
      seriesId: "bunny-adventures",
      season: 1,
      episode: 2,
    },
    {
      id: `demo-tg-${demoId}`,
      title: "Telegram-sourced movie (needs setup)",
      description:
        "Placeholder showing a Telegram-backed row. Fill telegram_chat_id / telegram_message_id (or run npm run import:telegram) and configure MTProto credentials to stream it.",
      durationSeconds: null,
      year: null,
      genre: null,
      sourceType: "telegram" as const,
      telegramChatId: null,
      telegramMessageId: null,
      mimeType: "video/mp4",
    },
  ];

  for (const value of values) {
    await db
      .insert(videos)
      .values(value)
      .onConflictDoUpdate({ target: videos.id, set: value });
  }

  console.log(`Seeded ${values.length} demo videos.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
