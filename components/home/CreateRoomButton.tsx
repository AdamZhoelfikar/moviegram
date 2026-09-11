"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function CreateRoomButton({
  videoId,
  label = "Watch",
  className,
}: {
  videoId: string;
  label?: string;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ videoId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not create the room.");
        return;
      }
      router.push(data.url as string);
    } catch {
      setError("Connection problem. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={create}
        className={
          className ??
          "rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black transition hover:bg-accent-dim disabled:opacity-50"
        }
      >
        {busy ? "Creating..." : label}
      </button>
      {error && <span className="text-xs text-bad">{error}</span>}
    </span>
  );
}
