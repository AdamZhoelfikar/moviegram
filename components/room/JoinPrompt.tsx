"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import NameGate from "../auth/NameGate";

export default function JoinPrompt({
  inviteCode,
  needsName,
  needsJoin,
  roomTitle,
  videoTitle,
  full,
  displayName,
}: {
  inviteCode: string;
  needsName: boolean;
  needsJoin?: boolean;
  roomTitle: string;
  videoTitle: string;
  full: boolean;
  displayName?: string;
}): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/rooms/${inviteCode}/join`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not join this room.");
        return;
      }
      router.refresh();
    } catch {
      setError("Connection problem. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-6 px-6">
      <div className="text-center">
        <p className="text-xs uppercase tracking-[0.3em] text-accent">Watch room</p>
        <h1 className="mt-2 text-2xl font-bold">{roomTitle}</h1>
        <p className="mt-1 text-sm text-muted">Now playing: {videoTitle}</p>
        {displayName && (
          <p className="mt-1 text-sm text-muted">Signed in as {displayName}</p>
        )}
      </div>

      {full && (
        <div className="w-full rounded-xl border border-bad/40 bg-bad/10 p-4 text-center text-sm">
          This room already has two participants.
        </div>
      )}

      {needsName && (
        <div className="w-full rounded-xl border border-line bg-surface p-4">
          <NameGate />
        </div>
      )}

      {needsJoin && !full && (
        <div className="flex w-full flex-col items-center gap-3">
          <button
            type="button"
            onClick={join}
            disabled={busy}
            className="w-full rounded-lg bg-accent px-6 py-3 text-sm font-semibold text-black transition hover:bg-accent-dim disabled:opacity-50"
          >
            {busy ? "Joining..." : "Join room"}
          </button>
          {error && <p className="text-sm text-bad">{error}</p>}
        </div>
      )}

      <Link href="/" className="text-sm text-muted underline-offset-4 hover:underline">
        Back to home
      </Link>
    </main>
  );
}
