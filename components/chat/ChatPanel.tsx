"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessageDto } from "../../lib/protocol";
import { CHAT_MAX_LENGTH, REACTION_EMOJIS } from "../../lib/protocol";
import { formatTime } from "../../lib/sync";
import { cn } from "../../lib/utils";

export default function ChatPanel({
  messages,
  myName,
  hostName,
  isHost,
  getExpected,
  onSend,
  onReact,
  onTimestampClick,
}: {
  messages: ChatMessageDto[];
  myName: string;
  hostName: string | null;
  isHost: boolean;
  getExpected: (nowMs: number) => number | null;
  onSend: (body: string, videoTimestamp?: number) => void;
  onReact: (emoji: string) => void;
  onTimestampClick: (seconds: number) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState("");
  const [attachTimestamp, setAttachTimestamp] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function send(): void {
    const body = draft.trim();
    if (body.length === 0) return;
    const ts = attachTimestamp ? getExpected(Date.now()) ?? undefined : undefined;
    onSend(body.slice(0, CHAT_MAX_LENGTH), ts ?? undefined);
    setDraft("");
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">Chat</h2>
        {!isHost && (
          <p className="text-[10px] text-muted">{hostName ?? "The host"} controls playback</p>
        )}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <p className="text-center text-xs text-muted">
            No messages yet. Say hi 👋
          </p>
        )}
        {messages.map((message) => (
          <div key={message.id} className="text-sm">
            <div className="flex items-baseline gap-2">
              <span
                className={cn(
                  "font-semibold",
                  message.displayName === myName ? "text-accent" : "text-foreground",
                )}
              >
                {message.displayName}
              </span>
              <span className="text-[10px] text-muted">
                {new Date(message.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              {message.videoTimestamp != null && (
                <button
                  type="button"
                  onClick={() => onTimestampClick(message.videoTimestamp!)}
                  className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-accent underline-offset-2 hover:underline"
                  title={isHost ? "Seek the room here" : "Look here (sync will pull you back)"}
                >
                  ⏱ {formatTime(message.videoTimestamp)}
                </button>
              )}
            </div>
            <p className="mt-0.5 break-words text-foreground/90">{message.body}</p>
          </div>
        ))}
      </div>

      <div className="border-t border-line px-3 py-2">
        <div className="mb-2 flex items-center gap-1">
          {REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onReact(emoji)}
              className="rounded-lg px-1.5 py-1 text-lg transition hover:bg-surface-2"
              aria-label={`React ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAttachTimestamp((v) => !v)}
            className={cn(
              "rounded-lg border px-2 py-2 text-xs transition",
              attachTimestamp
                ? "border-accent text-accent"
                : "border-line text-muted hover:border-accent-dim",
            )}
            title="Attach the current video timestamp"
          >
            ⏱
          </button>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
            }}
            maxLength={CHAT_MAX_LENGTH}
            placeholder="Message…"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={send}
            className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-black transition hover:bg-accent-dim"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
