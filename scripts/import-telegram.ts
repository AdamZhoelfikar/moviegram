import { env } from "../lib/env";
import { setImportChannel } from "../lib/sync-host";
import { importChannelVideos } from "../server/importer";

/**
 * Imports video documents from a private Telegram channel into the library
 * (channel → message references → database).
 * Only references + metadata are stored, never the file itself.
 *
 * Usage: npm run import:telegram -- @mychannel | -100xxxxxxxxxx
 * The sync host also runs this on a timer (see server/ws.ts), so this command
 * is only needed for a one-off manual import.
 */
async function main(): Promise<void> {
  const channel = process.argv[2] ?? env.telegramImportChannel;
  if (!channel) {
    console.error("Usage: npm run import:telegram -- @channelusername | -100xxxxxxxxxx");
    process.exit(1);
  }

  const result = await importChannelVideos(channel);
  // Remember the channel so the sync host's automatic scan keeps working after
  // this one-off command (see server/ws.ts).
  await setImportChannel(channel).catch(() => undefined);
  for (const title of result.titles) {
    console.log(`+ ${title}`);
  }
  console.log(`Done. Inserted ${result.inserted}, skipped ${result.skipped} already-imported.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
