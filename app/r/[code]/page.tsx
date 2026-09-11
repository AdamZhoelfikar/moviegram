import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "../../../lib/db";
import { roomMembers, rooms, videos } from "../../../db/schema";
import { getSessionUser } from "../../../lib/session";
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

  const rows = await db
    .select({ room: rooms, video: videos })
    .from(rooms)
    .innerJoin(videos, eq(rooms.videoId, videos.id))
    .where(eq(rooms.inviteCode, code))
    .limit(1);
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

  const memberRows = await db
    .select({ userId: roomMembers.userId, role: roomMembers.role })
    .from(roomMembers)
    .where(eq(roomMembers.roomId, row.room.id));

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

  return (
    <RoomClient
      inviteCode={row.room.inviteCode}
      roomTitle={row.room.title}
      videoTitle={row.video.title}
      isHost={membership.role === "host"}
      displayName={user.displayName}
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
