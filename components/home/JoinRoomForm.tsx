"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export default function JoinRoomForm() {
  const router = useRouter();
  const [code, setCode] = useState("");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const clean = code.trim().replace(/[^A-Za-z0-9]/g, "");
    if (clean.length < 4) return;
    router.push(`/r/${clean}`);
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-sm gap-2">
      <input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="Invite code"
        maxLength={16}
        autoCapitalize="characters"
        autoComplete="off"
        enterKeyHint="go"
        className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 text-base outline-none focus:border-accent sm:text-sm"
      />
      <button
        type="submit"
        className="h-11 shrink-0 rounded-lg border border-line bg-surface-2 px-4 text-sm font-semibold transition hover:border-accent"
      >
        Join
      </button>
    </form>
  );
}
