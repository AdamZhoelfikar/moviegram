import { NextResponse } from "next/server";
import { getSessionUser, unauthorized } from "../../../lib/session";
import { listVideos } from "../../../lib/video-cache";

/**
 * Public-ish video metadata listing (PRD 6.2).
 * Telegram identifiers are stripped — the browser never learns them (PRD 16.1).
 */
export async function GET(): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return unauthorized();

  const rows = await listVideos();
  return NextResponse.json({ videos: rows });
}
