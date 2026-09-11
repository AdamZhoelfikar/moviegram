import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { sql } from "drizzle-orm";
import { db } from "../../../../lib/db";
import { users } from "../../../../db/schema";
import { createSessionToken, randomId } from "../../../../lib/auth";
import { SESSION_COOKIE } from "../../../../lib/session";
import { rateLimit, rateLimitedResponse } from "../../../../lib/rate-limit";

export async function POST(request: Request): Promise<Response> {
  const ip = request.headers.get("x-forwarded-for") ?? "local";
  const rl = rateLimit(`login:${ip}`, 10, 60_000);
  if (!rl.ok) return rateLimitedResponse(rl.retryAfterSeconds);

  let body: { displayName?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const displayName = String(body.displayName ?? "").trim();
  if (displayName.length < 2 || displayName.length > 32) {
    return NextResponse.json(
      { error: "Display name must be 2-32 characters." },
      { status: 400 },
    );
  }

  const existing = await db
    .select()
    .from(users)
    .where(sql`lower(${users.displayName}) = lower(${displayName})`)
    .limit(1);
  let user = existing[0];
  if (!user) {
    const slug = displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24) || "watcher";
    const inserted = await db
      .insert(users)
      .values({
        username: `${slug}-${randomId(4)}`,
        displayName,
      })
      .returning();
    user = inserted[0];
  }

  const token = createSessionToken({ userId: user.id, displayName: user.displayName });
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return NextResponse.json({
    user: { id: user.id, displayName: user.displayName },
  });
}
