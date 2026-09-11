import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { env } from "./env";

function sign(payload: string): string {
  return createHmac("sha256", env.sessionSecret).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Stateless session token: base64url(JSON payload).hmac
 * Keeps user identity out of the browser's reach for forgery (PRD 16).
 */
export type SessionPayload = { userId: string; displayName: string };

export function createSessionToken(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifySessionToken(token: string | undefined | null): SessionPayload | null {
  if (!token) return null;
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!safeEqual(sig, sign(body))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof parsed?.userId === "string" && typeof parsed?.displayName === "string") {
      return parsed as SessionPayload;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Short-lived signed grant for one streamable resource (PRD 16.6).
 * Format: resourceId.expiry.sig — never a permanent public URL.
 */
export function createGrant(resourceId: string, ttlHours: number = env.streamTokenTtlHours): string {
  const exp = Date.now() + ttlHours * 3600_000;
  const payload = `${resourceId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyGrant(resourceId: string, grant: string | null | undefined): boolean {
  if (!grant) return false;
  const parts = grant.split(".");
  if (parts.length !== 3) return false;
  const [id, expRaw, sig] = parts;
  if (id !== resourceId) return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  return safeEqual(sig, sign(`${id}.${expRaw}`));
}

export function randomId(bytes = 5): string {
  return randomBytes(bytes).toString("base64url").replace(/[-_]/g, "").slice(0, bytes + 2);
}

/**
 * Short-lived WebSocket credential. The browser cannot read the httpOnly
 * session cookie, so joining over REST hands back this ticket which the
 * sync server verifies on connect.
 */
export type WsTicket = { userId: string; code: string; exp: number };

export function createWsTicket(userId: string, code: string, ttlMs = 12 * 3_600_000): string {
  const payload: WsTicket = { userId, code: code.toLowerCase(), exp: Date.now() + ttlMs };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyWsTicket(token: string | null | undefined): WsTicket | null {
  if (!token) return null;
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!safeEqual(sig, sign(body))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as WsTicket;
    if (
      typeof parsed?.userId === "string" &&
      typeof parsed?.code === "string" &&
      typeof parsed?.exp === "number" &&
      parsed.exp > Date.now()
    ) {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function generateInviteCode(length = 8): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const buf = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}
