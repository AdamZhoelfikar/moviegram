import { createInterface } from "readline";
import { createStringSession } from "../lib/telegram";
import { env } from "../lib/env";

/**
 * Mints the TELEGRAM_SESSION string for .env.local.
 * Run once: `npm run telegram:login -- <phone>` (api_id/api_hash from env).
 * The session is a server-side secret — never commit it (PRD 6.3 Security).
 */
async function main(): Promise<void> {
  const phone = process.argv[2] ?? process.env.TELEGRAM_PHONE ?? "";
  if (!phone) {
    console.error("Usage: npm run telegram:login -- +62xxxxxxxxxx");
    process.exit(1);
  }
  if (env.telegramApiId <= 0 || !env.telegramApiHash) {
    console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH first (https://my.telegram.org).");
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const session = await createStringSession(phone, () =>
    new Promise<string>((resolve) => {
      rl.question("Code from Telegram: ", (answer) => resolve(answer.trim()));
    }),
  );
  rl.close();
  console.log("\nAdd this to .env.local:\n");
  console.log(`TELEGRAM_SESSION=${session}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
