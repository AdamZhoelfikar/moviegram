function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Public origin of this sync host. Explicit PUBLIC_WS_URL wins; on Render the
 * platform injects RENDER_EXTERNAL_URL, so a deploy needs no manual URL entry.
 */
function publicOrigin(): string {
  if (process.env.PUBLIC_WS_URL) return process.env.PUBLIC_WS_URL;
  const render = process.env.RENDER_EXTERNAL_URL;
  if (render) return render.replace(/^http/, "ws");
  return "";
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
  // Managed hosts (Render, Railway, Cloud Run…) assign the port via PORT.
  wsPort: num("PORT", num("WS_PORT", 3001)),
  roomTtlHours: num("ROOM_TTL_HOURS", 168),
  streamTokenTtlHours: num("STREAM_TOKEN_TTL_HOURS", 12),
  // Public base URL of the sync-server host (e.g. https://xxx.trycloudflare.com).
  // When set, video bytes are served from there instead of Vercel functions.
  publicStreamBase: process.env.PUBLIC_STREAM_BASE ?? "",
  // The sync host's own public origin (wss://… or https://…). Published to the
  // settings table so the app discovers the host at runtime.
  publicWsUrl: publicOrigin(),
  telegramApiId: num("TELEGRAM_API_ID", 0),
  telegramApiHash: process.env.TELEGRAM_API_HASH ?? "",
  telegramSession: process.env.TELEGRAM_SESSION ?? "",
  telegramImportChannel: process.env.TELEGRAM_IMPORT_CHANNEL ?? "",
  // Minutes between automatic library scans on the sync host (0 disables).
  importScanMinutes: num("IMPORT_SCAN_MINUTES", 15),
  telegramChunkKb: num("TELEGRAM_CHUNK_KB", 512),
};

export function telegramConfigured(): boolean {
  return (
    env.telegramApiId > 0 &&
    env.telegramApiHash.length > 0 &&
    env.telegramSession.length > 0
  );
}
