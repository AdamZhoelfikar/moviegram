import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "../lib/db";
import { videos, watchHistory } from "../db/schema";
import { getSessionUser } from "../lib/session";
import { formatTime } from "../lib/sync";
import CreateRoomButton from "../components/home/CreateRoomButton";
import JoinRoomForm from "../components/home/JoinRoomForm";
import NameGate from "../components/auth/NameGate";

export default async function Home(): Promise<React.ReactElement> {
  const user = await getSessionUser();
  let continueWatching: {
    videoId: string;
    title: string;
    positionSeconds: number;
    durationSeconds: number | null;
  }[] = [];
  if (user) {
    continueWatching = await db
      .select({
        videoId: watchHistory.videoId,
        title: videos.title,
        positionSeconds: watchHistory.positionSeconds,
        durationSeconds: videos.durationSeconds,
      })
      .from(watchHistory)
      .innerJoin(videos, eq(watchHistory.videoId, videos.id))
      .where(eq(watchHistory.userId, user.userId))
      .orderBy(desc(watchHistory.updatedAt))
      .limit(3);
  }

  return (
    <main className="flex flex-1 flex-col">
      <header className="flex items-center justify-between px-6 py-4 md:px-10">
        <Link href="/" className="text-lg font-bold tracking-tight">
          Movie<span className="text-accent">gram</span>
        </Link>
        <nav className="flex items-center gap-6 text-sm text-muted">
          <Link href="/" className="text-foreground">
            Home
          </Link>
          <Link href="/library" className="transition hover:text-foreground">
            Library
          </Link>
          {user ? (
            <span className="rounded-full border border-line px-3 py-1 text-foreground">
              {user.displayName}
            </span>
          ) : null}
        </nav>
      </header>

      <section className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-16 text-center">
        <div className="space-y-4">
          <p className="text-xs font-semibold uppercase tracking-[0.35em] text-accent">
            Private watch parties
          </p>
          <h1 className="text-5xl font-bold tracking-tight md:text-6xl">
            Watch together.
          </h1>
          <p className="mx-auto max-w-md text-lg text-muted">
            One room. One timeline. You and one friend, the same movie, the
            exact same second.
          </p>
        </div>

        <div className="flex flex-col items-center gap-6">
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/library"
              className="rounded-lg bg-accent px-6 py-3 text-sm font-semibold text-black transition hover:bg-accent-dim"
            >
              Create Watch Room
            </Link>
            <JoinRoomForm />
          </div>
          {!user && (
            <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-4 text-left">
              <NameGate />
            </div>
          )}
        </div>
      </section>

      {continueWatching.length > 0 && (
        <section className="border-t border-line px-6 py-8 md:px-10">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-muted">
            Continue watching
          </h2>
          <div className="grid gap-4 md:grid-cols-3">
            {continueWatching.map((item) => (
              <div
                key={item.videoId}
                className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4"
              >
                <p className="truncate font-medium">{item.title}</p>
                <div className="h-1 w-full overflow-hidden rounded bg-surface-2">
                  <div
                    className="h-full bg-accent"
                    style={{
                      width: `${Math.min(
                        100,
                        item.durationSeconds
                          ? (item.positionSeconds / item.durationSeconds) * 100
                          : 0,
                      )}%`,
                    }}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted">
                    {formatTime(item.positionSeconds)} watched
                  </span>
                  <CreateRoomButton
                    videoId={item.videoId}
                    label="Resume room"
                    className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold transition hover:border-accent"
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <footer className="px-6 py-6 text-center text-xs text-muted md:px-10">
        Movies are better together. Private by design — only people with your
        invite link can join.
      </footer>
    </main>
  );
}
