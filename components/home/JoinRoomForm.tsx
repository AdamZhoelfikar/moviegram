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
        className="flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent"
      />
      <button
        type="submit"
        className="rounded-lg border border-line bg-surface-2 px-4 py-2 text-sm font-semibold transition hover:border-accent"
      >
        Join
      </button>
    </form>
  );
}
