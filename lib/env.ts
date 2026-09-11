function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function secret(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw && raw.length > 0) return raw;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${name} must be set in production`);
  }
  return fallback;
}

export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://wp:wp@localhost:5432/wp",
  sessionSecret: secret("SESSION_SECRET", "dev-secret-change-me"),
  wsPort: num("WS_PORT", 3001),
  roomTtlHours: num("ROOM_TTL_HOURS", 168),
  streamTokenTtlHours: num("STREAM_TOKEN_TTL_HOURS", 12),
  telegramApiId: num("TELEGRAM_API_ID", 0),
  telegramApiHash: process.env.TELEGRAM_API_HASH ?? "",
  telegramSession: process.env.TELEGRAM_SESSION ?? "",
  telegramImportChannel: process.env.TELEGRAM_IMPORT_CHANNEL ?? "",
  telegramChunkKb: num("TELEGRAM_CHUNK_KB", 512),
};

export function telegramConfigured(): boolean {
  return (
    env.telegramApiId > 0 &&
    env.telegramApiHash.length > 0 &&
    env.telegramSession.length > 0
  );
}
