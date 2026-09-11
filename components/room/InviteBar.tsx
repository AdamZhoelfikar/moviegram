"use client";

import { useState } from "react";

export default function InviteBar({ inviteCode }: { inviteCode: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/r/${inviteCode}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard denied */
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="flex max-w-[240px] items-center gap-2 truncate rounded-full border border-line px-3 py-1 text-xs text-muted transition hover:border-accent hover:text-foreground"
      title="Copy invite link"
    >
      <span className="truncate">{copied ? "Link copied ✓" : `Invite: ${inviteCode}`}</span>
    </button>
  );
}
