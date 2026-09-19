"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export default function NameGate({ redirectTo }: { redirectTo?: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) {
      setError("Display name must be at least 2 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not sign in.");
        return;
      }
      if (redirectTo) router.push(redirectTo);
      router.refresh();
    } catch {
      setError("Connection problem. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <label htmlFor="display-name" className="text-sm text-muted">
        Enter your display name
      </label>
      <div className="flex gap-2">
        <input
          id="display-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={32}
          placeholder="e.g. Adam"
          autoComplete="nickname"
          enterKeyHint="go"
          className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 text-base outline-none focus:border-accent sm:text-sm"
        />
        <button
          type="submit"
          disabled={busy}
          className="h-11 shrink-0 rounded-lg bg-accent px-4 text-sm font-semibold text-black transition hover:bg-accent-dim disabled:opacity-50"
        >
          {busy ? "..." : "Continue"}
        </button>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
    </form>
  );
}
