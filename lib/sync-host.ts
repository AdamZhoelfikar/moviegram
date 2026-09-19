import { eq } from "drizzle-orm";
import { db } from "./db";
import { settings } from "../db/schema";

export const SYNC_HOST_KEY = "sync_host_url";

/** A host that has not heartbeat within this window is treated as offline. */
const STALE_AFTER_MS = 90_000;

export type SyncHost = {
  url: string;
  online: boolean;
  ageMs: number;
};

/**
 * The sync server publishes its public URL to Postgres and heartbeats it
 * (server/ws.ts). Reading it at request time means a laptop reboot, a new VPS
 * or a rotated tunnel URL is picked up automatically — no Vercel rebuild.
 */
export async function getSyncHost(): Promise<SyncHost | null> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, SYNC_HOST_KEY))
    .limit(1);
  if (!row) return null;
  const ageMs = Date.now() - row.updatedAt.getTime();
  return { url: row.value, online: ageMs < STALE_AFTER_MS, ageMs };
}

export async function publishSyncHost(url: string): Promise<void> {
  const normalized = url.replace(/\/+$/, "");
  await db
    .insert(settings)
    .values({ key: SYNC_HOST_KEY, value: normalized, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: normalized, updatedAt: new Date() },
    });
}
