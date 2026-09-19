import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "../../../lib/db";
import { roomMembers, rooms, videos } from "../../../db/schema";
import { getSessionUser } from "../../../lib/session";
import { getSyncHost } from "../../../lib/sync-host";
import RoomClient from "../../../components/room/RoomClient";
import JoinPrompt from "../../../components/room/JoinPrompt";

function roomExpired(expiresAt: Date): boolean {
  return expiresAt.getTime() <= Date.now();
}

export default async function RoomPage({
  params,
}: {
  params: Promise<{ code: string }>;
}): Promise<React.ReactElement> {
  const { code } = await params;
  const user = await getSessionUser();

  // One round trip: room + video + roster (left join fans out one row per
  // member). Two sequential Neon queries used to cost ~2x the latency here.
  const rows = await db
    .select({
      room: rooms,
      video: videos,
      memberUserId: roomMembers.userId,
      memberRole: roomMembers.role,
    })
    .from(rooms)
    .innerJoin(videos, eq(rooms.videoId, videos.id))
    .leftJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
    .where(eq(rooms.inviteCode, code));

  const row = rows[0];

  if (!row) {
    return (
      <MessageShell
        title="Room not found"
        body="This watch room could not be found. Check the invite link."
      />
    );
  }
  if (row.room.status === "ended" || roomExpired(row.room.expiresAt)) {
    return (
      <MessageShell
        title="Room expired"
        body="This watch room has expired. Ask the host to start a new one."
      />
    );
  }

  const memberRows = rows
    .filter((r): r is typeof r & { memberUserId: string } => r.memberUserId != null)
    .map((r) => ({ userId: r.memberUserId, role: r.memberRole }));

  if (!user) {
    return (
      <JoinPrompt
        inviteCode={row.room.inviteCode}
        needsName
        needsJoin={false}
        roomTitle={row.room.title}
        videoTitle={row.video.title}
        full={memberRows.length >= 2}
      />
    );
  }

  const membership = memberRows.find((m) => m.userId === user.userId);
  if (!membership) {
    return (
      <JoinPrompt
        inviteCode={row.room.inviteCode}
        needsName={false}
        needsJoin
        roomTitle={row.room.title}
        videoTitle={row.video.title}
        full={memberRows.length >= 2}
        displayName={user.displayName}
      />
    );
  }

  // Discover the live sync host (laptop, VPS, rotated tunnel URL) at request
  // time — the app never needs rebuilding when the host moves.
  const syncHost = await getSyncHost().catch(() => null);

  return (
    <RoomClient
      inviteCode={row.room.inviteCode}
      roomTitle={row.room.title}
      videoTitle={row.video.title}
      isHost={membership.role === "host"}
      displayName={user.displayName}
      wsUrl={syncHost?.url ?? null}
      syncOnline={syncHost ? syncHost.online : true}
    />
  );
}

function MessageShell({ title, body }: { title: string; body: string }): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-4xl">🎬</p>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-sm text-muted">{body}</p>
      <Link
        href="/"
        className="rounded-lg border border-line px-4 py-2 text-sm transition hover:border-accent"
      >
        Back to home
      </Link>
    </main>
  );
}
