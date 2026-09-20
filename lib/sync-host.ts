import { eq } from "drizzle-orm";
import { db } from "./db";
import { settings } from "../db/schema";

export const SYNC_HOST_KEY = "sync_host_url";
const SYNC_HOST_OWNER_KEY = "sync_host_owner";
export const IMPORT_CHANNEL_KEY = "import_channel";
export const IMPORT_LAST_SCAN_KEY = "import_last_scan";

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

async function upsert(key: string, value: string): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: new Date() },
    });
}

/**
 * Claim the sync-host slot. Multiple hosts may run at once (laptop + a cloud
 * box during migration): only the current owner writes, so the app never sees
 * the URL flap. If the owner stops heartbeating, a standby takes over after
 * the staleness window — free failover.
 *
 * @returns true when this host is the active one.
 */
export async function publishSyncHost(url: string, hostId: string): Promise<boolean> {
  const [owner] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, SYNC_HOST_OWNER_KEY))
    .limit(1);
  const ownerFresh = owner && Date.now() - owner.updatedAt.getTime() < STALE_AFTER_MS;
  if (ownerFresh && owner.value !== hostId) return false;

  const normalized = url.replace(/\/+$/, "");
  await upsert(SYNC_HOST_OWNER_KEY, hostId);
  await upsert(SYNC_HOST_KEY, normalized);
  return true;
}

/**
 * The Telegram channel the sync host scans for new uploads. Remembered in the
 * database so a one-off manual import (or the first scan) configures the
 * automatic import for good.
 */
export async function getImportChannel(): Promise<string | null> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, IMPORT_CHANNEL_KEY))
    .limit(1);
  return row?.value ?? null;
}

export async function setImportChannel(channel: string): Promise<void> {
  await upsert(IMPORT_CHANNEL_KEY, channel.trim());
}

/** Records that the automatic library scan ran, so it is observable. */
export async function recordImportScan(
  inserted: number,
  skipped = 0,
  error?: string,
): Promise<void> {
  const stamp = new Date().toISOString();
  await upsert(
    IMPORT_LAST_SCAN_KEY,
    `${stamp}|${inserted}|${skipped}|${error ? error.slice(0, 200) : ""}`,
  );
}

export async function getImportLastScan(): Promise<{
  at: Date;
  inserted: number;
  skipped: number;
  error: string | null;
} | null> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, IMPORT_LAST_SCAN_KEY))
    .limit(1);
  if (!row) return null;
  const [iso, inserted, skipped, error] = row.value.split("|");
  return {
    at: new Date(iso),
    inserted: Number(inserted) || 0,
    skipped: Number(skipped) || 0,
    error: error || null,
  };
}
