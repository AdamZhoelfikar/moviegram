"use client";

import type { PresenceUser } from "../../lib/protocol";

export default function Participants({
  participants,
}: {
  participants: PresenceUser[];
}): React.ReactElement {
  return (
    <div className="flex items-center gap-3 text-xs">
      {participants.map((participant) => (
        <span key={participant.userId} className="flex items-center gap-1" title={participant.role}>
          <span
            aria-hidden
            className={`inline-block h-2 w-2 rounded-full ${
              participant.connected ? "bg-ok" : "bg-muted"
            }`}
          />
          {participant.displayName}
          {participant.role === "host" && <span aria-label="host">👑</span>}
        </span>
      ))}
      <span className="rounded-full border border-line px-2 py-0.5 text-muted">
        {participants.length} / 2
      </span>
    </div>
  );
}
