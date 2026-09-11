import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "../../lib/db";
import { series, videos } from "../../db/schema";
import { getSessionUser } from "../../lib/session";
import { formatTime } from "../../lib/sync";
import CreateRoomButton from "../../components/home/CreateRoomButton";
import NameGate from "../../components/auth/NameGate";

export default async function LibraryPage(): Promise<React.ReactElement> {
  const user = await getSessionUser();
  if (!user) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-6">
        <Link href="/" className="text-sm text-muted">
          ← Home
        </Link>
        <h1 className="text-2xl font-bold">Sign in to browse the library</h1>
        <div className="rounded-xl border border-line bg-surface p-4">
          <NameGate />
        </div>
      </main>
    );
  }

  const rows = await db
    .select({
      id: videos.id,
      title: videos.title,
      description: videos.description,
      thumbnail: videos.thumbnail,
      durationSeconds: videos.durationSeconds,
      year: videos.year,
      genre: videos.genre,
      season: videos.season,
      episode: videos.episode,
      seriesTitle: series.title,
      subtitleUrl: videos.subtitleUrl,
    })
    .from(videos)
    .leftJoin(series, eq(videos.seriesId, series.id))
    .orderBy(desc(videos.createdAt))
    .limit(100);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-6 py-6">
      <header className="mb-8 flex items-center justify-between">
        <div className="flex items-baseline gap-4">
          <Link href="/" className="text-lg font-bold tracking-tight">
            Movie<span className="text-accent">gram</span>
          </Link>
          <h1 className="text-sm uppercase tracking-widest text-muted">
            Library
          </h1>
        </div>
        <span className="text-sm text-muted">{user.displayName}</span>
      </header>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line p-12 text-center text-muted">
          <p className="font-medium">No videos yet</p>
          <p className="mt-2 text-sm">
            Upload a video to your private Telegram channel, then import it:{" "}
            <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-foreground">
              npm run import:telegram
            </code>
            . Demo content:{" "}
            <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-foreground">
              npm run db:seed
            </code>
          </p>
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((video) => (
            <article
              key={video.id}
              className="group flex flex-col overflow-hidden rounded-xl border border-line bg-surface transition hover:border-accent-dim"
            >
              <div className="relative flex aspect-video items-center justify-center bg-gradient-to-br from-surface-2 via-[#1a1626] to-[#101018]">
                {video.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={video.thumbnail}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="text-4xl opacity-40">🎬</span>
                )}
                <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-xs">
                  {formatTime(video.durationSeconds)}
                </span>
              </div>
              <div className="flex flex-1 flex-col gap-2 p-4">
                <h2 className="font-semibold leading-tight">{video.title}</h2>
                <p className="text-xs text-muted">
                  {[
                    video.year,
                    video.genre,
                    video.seriesTitle
                      ? `S${video.season ?? 1}E${video.episode ?? 1} · ${video.seriesTitle}`
                      : null,
                    video.subtitleUrl ? "CC" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </p>
                {video.description && (
                  <p className="line-clamp-2 text-sm text-muted">
                    {video.description}
                  </p>
                )}
                <div className="mt-auto pt-2">
                  <CreateRoomButton videoId={video.id} label="Watch" />
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
