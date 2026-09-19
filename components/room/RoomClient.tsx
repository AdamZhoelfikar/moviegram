"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type {
  ChatMessageDto,
  ClientEvent,
  RoomStateMessage,
  ServerEvent,
  StreamDescriptor,
} from "../../lib/protocol";
import { estimateClockOffset, expectedPosition } from "../../lib/sync";
import VideoPlayer, { type VideoPlayerHandle } from "../video/VideoPlayer";
import ChatPanel from "../chat/ChatPanel";
import Participants from "./Participants";
import InviteBar from "./InviteBar";

const WS_BASE =
  process.env.NEXT_PUBLIC_WS_URL && process.env.NEXT_PUBLIC_WS_URL.length > 0
    ? process.env.NEXT_PUBLIC_WS_URL
    : "ws://localhost:3001";

// Video bytes come from the sync-server host, so a relative stream path is
// resolved against the same origin as the WebSocket — one place to configure.
const STREAM_BASE = WS_BASE.replace(/^ws/, "http").replace(/\/+$/, "");

function resolveStreamPath(path: string): string {
  return path.startsWith("/") ? `${STREAM_BASE}${path}` : path;
}

type FloatingReaction = { id: number; emoji: string; name: string };

export default function RoomClient({
  inviteCode,
  roomTitle,
  videoTitle,
  isHost,
  displayName,
}: {
  inviteCode: string;
  roomTitle: string;
  videoTitle: string;
  isHost: boolean;
  displayName: string;
}): React.ReactElement {
  const [state, setState] = useState<RoomStateMessage | null>(null);
  const [stream, setStream] = useState<StreamDescriptor | null>(null);
  const [chat, setChat] = useState<ChatMessageDto[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [terminal, setTerminal] = useState(false);
  const [wsOpen, setWsOpen] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [driftMs, setDriftMs] = useState(0);
  const [floating, setFloating] = useState<FloatingReaction[]>([]);
  const [cinema, setCinema] = useState(false);
  const [mobileTab, setMobileTab] = useState<"chat" | "room">("chat");
  const [menuOpen, setMenuOpen] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const stateRef = useRef<RoomStateMessage | null>(null);
  const offsetRef = useRef(0);
  const offsetSamplesRef = useRef(0);
  const attemptsRef = useRef(0);
  const ticketRef = useRef<{ token: string; at: number } | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const terminalRef = useRef(false);
  const driftRef = useRef(0);
  const playerRef = useRef<VideoPlayerHandle>(null);
  const connectRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    // Read persisted preference after mount to keep SSR/hydration consistent.
    void Promise.resolve().then(() => {
      try {
        setCinema(window.localStorage.getItem("wp-cinema") === "1");
      } catch {
        /* private mode */
      }
    });
  }, []);

  const toggleCinema = useCallback(() => {
    setCinema((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("wp-cinema", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const sendEvent = useCallback((event: ClientEvent): void => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }, []);

  const fetchHistory = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/rooms/${inviteCode}/messages`);
      if (res.ok) {
        const data = (await res.json()) as { messages: ChatMessageDto[] };
        setChat(data.messages ?? []);
      }
    } catch {
      /* non-fatal */
    }
  }, [inviteCode]);

  const getExpected = useCallback((nowMs: number): number | null => {
    const snapshot = stateRef.current;
    if (!snapshot) return null;
    return expectedPosition(snapshot, nowMs, offsetRef.current, snapshot.durationSeconds);
  }, []);

  const openSocket = useCallback(async (): Promise<void> => {
    try {
      let ticket: string | null = null;
      const cached = ticketRef.current;
      if (cached && Date.now() - cached.at < 3_600_000) {
        // Reuse the short-lived ticket; reconnects must not storm the join endpoint.
        ticket = cached.token;
      } else {
        const res = await fetch(`/api/rooms/${inviteCode}/join`, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || typeof data.ticket !== "string") {
          setBanner(typeof data.error === "string" ? data.error : "Could not join this room.");
          setTerminal(true);
          terminalRef.current = true;
          return;
        }
        ticket = data.ticket as string;
        ticketRef.current = { token: ticket, at: Date.now() };
      }
      const ws = new WebSocket(
        `${WS_BASE}/?code=${encodeURIComponent(inviteCode)}&token=${encodeURIComponent(ticket)}`,
      );
      wsRef.current = ws;
      // A StrictMode remount (or a superseded reconnect) can leave an older
      // socket in flight. Its events must never drive state or reconnects —
      // two sockets for one member would kick each other in a loop and
      // re-issue the stream grant, resetting <video src> forever.
      const isCurrent = () => wsRef.current === ws;

      ws.onopen = () => {
        if (!mountedRef.current || !isCurrent()) {
          ws.close();
          return;
        }
        setWsOpen(true);
        setReconnecting(false);
        attemptsRef.current = 0;
      };
      ws.onmessage = (msg: MessageEvent<string>) => {
        if (!mountedRef.current || !isCurrent()) return;
        let event: ServerEvent;
        try {
          event = JSON.parse(msg.data) as ServerEvent;
        } catch {
          return;
        }
        switch (event.type) {
          case "joined":
            setState(event.state);
            setStream(event.stream);
            void fetchHistory();
            break;
          case "state":
            setState(event.state);
            break;
          case "stream":
            setStream(event.stream);
            break;
          case "pong": {
            const sample = estimateClockOffset(event.t0, event.serverTsMs, Date.now());
            if (offsetSamplesRef.current < 5) {
              offsetRef.current = sample;
              offsetSamplesRef.current += 1;
            } else {
              offsetRef.current = offsetRef.current * 0.85 + sample * 0.15;
            }
            break;
          }
          case "chat_message":
            setChat((prev) =>
              prev.some((m) => m.id === event.message.id)
                ? prev
                : [...prev, event.message],
            );
            break;
          case "reaction": {
            const id = Date.now() + Math.random();
            setFloating((prev) => [...prev, { id, emoji: event.emoji, name: event.displayName }]);
            setTimeout(() => {
              setFloating((prev) => prev.filter((r) => r.id !== id));
            }, 2500);
            break;
          }
          case "room_ended":
            setBanner(event.reason);
            setTerminal(true);
            terminalRef.current = true;
            ws.close();
            break;
          case "error":
            setBanner(event.message);
            if (event.code === "forbidden") {
              // Stale/expired ticket: drop it and let the reconnect fetch a fresh one.
              ticketRef.current = null;
              return;
            }
            if (event.code === "room_full" || event.code === "room_expired") {
              setTerminal(true);
              terminalRef.current = true;
            }
            break;
        }
      };
      ws.onclose = () => {
        if (!mountedRef.current || !isCurrent()) return;
        setWsOpen(false);
        if (terminalRef.current) return;
        setReconnecting(true);
        const delay = Math.min(10_000, 1_000 * 2 ** attemptsRef.current);
        attemptsRef.current += 1;
        reconnectTimerRef.current = setTimeout(() => {
          connectRef.current();
        }, delay);
      };
    } catch {
      setBanner("Connection problem. Please try again.");
    }
  }, [inviteCode, fetchHistory]);

  useEffect(() => {
    mountedRef.current = true;
    connectRef.current = () => {
      void openSocket();
    };
    queueMicrotask(connectRef.current);
    const ping = setInterval(() => {
      sendEvent({ type: "ping", t0: Date.now() });
    }, 5_000);
    const driftPublisher = setInterval(() => setDriftMs(driftRef.current), 1_000);
    const heartbeat = setInterval(() => {
      const snapshot = stateRef.current;
      if (!snapshot?.playing) return;
      const position = getExpected(Date.now());
      if (position == null) return;
      void fetch("/api/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ videoId: snapshot.videoId, position }),
      }).catch(() => undefined);
      // 60 s: half the function invocations while watching, still frequent
      // enough for "Continue watching" to be accurate.
    }, 60_000);
    return () => {
      mountedRef.current = false;
      clearInterval(ping);
      clearInterval(driftPublisher);
      clearInterval(heartbeat);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSocket]);

  const handleDrift = useCallback((ms: number) => {
    driftRef.current = ms;
  }, []);

  const onTimestampClick = useCallback(
    (seconds: number) => {
      if (isHost) {
        sendEvent({ type: "seek", position: seconds });
      } else {
        playerRef.current?.seekLocal(seconds);
      }
    },
    [isHost, sendEvent],
  );

  const syncStatus: "synced" | "syncing" | "unstable" = !wsOpen
    ? "unstable"
    : Math.abs(driftMs) > 100
      ? "syncing"
      : "synced";

  const syncLabel =
    syncStatus === "synced"
      ? "Synced"
      : syncStatus === "syncing"
        ? "Syncing..."
        : "Connection unstable";
  const syncDot = syncStatus === "synced" ? "🟢" : syncStatus === "syncing" ? "🟡" : "🔴";
  const syncTone =
    syncStatus === "synced"
      ? "border-ok/40 text-ok"
      : syncStatus === "syncing"
        ? "border-warn/40 text-warn"
        : "border-bad/40 text-bad";

  const tabClass = (active: boolean): string =>
    `flex-1 py-3 text-sm font-medium transition ${
      active ? "border-b-2 border-accent text-foreground" : "text-muted"
    }`;

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-background">
      {/* Phone top bar: title + sync dot + overflow menu. */}
      <header className="safe-top flex items-center gap-1 border-b border-line px-1.5 py-1 lg:hidden">
        <Link
          href="/library"
          aria-label="Back to library"
          className="flex h-11 w-11 shrink-0 items-center justify-center text-lg text-muted"
        >
          ←
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{state?.title ?? roomTitle}</h1>
          <p className="truncate text-[11px] text-muted">
            {state?.videoTitle ?? videoTitle}
          </p>
        </div>
        <span
          className={`flex h-8 shrink-0 items-center gap-1 rounded-full border px-2 text-xs ${syncTone}`}
          title={syncLabel}
        >
          <span aria-hidden>{syncDot}</span>
          <span className="sr-only">{syncLabel}</span>
        </span>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Room menu"
          aria-expanded={menuOpen}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line text-muted"
        >
          ⋯
        </button>
      </header>

      {menuOpen && (
        <div className="absolute right-2 top-14 z-30 flex w-60 flex-col gap-1 rounded-xl border border-line bg-surface p-2 shadow-2xl lg:hidden">
          <button
            type="button"
            onClick={() => {
              sendEvent({ type: "sync" });
              setMenuOpen(false);
            }}
            className="flex h-11 items-center rounded-lg px-3 text-left text-sm transition active:bg-surface-2"
          >
            ↻ Resync
          </button>
          <button
            type="button"
            onClick={() => {
              toggleCinema();
              setMenuOpen(false);
            }}
            className="flex h-11 items-center rounded-lg px-3 text-left text-sm transition active:bg-surface-2"
          >
            {cinema ? "Exit cinema" : "Cinema mode"}
          </button>
          <div className="flex h-11 items-center px-1">
            <InviteBar inviteCode={inviteCode} />
          </div>
        </div>
      )}

      <header
        className={`hidden items-center gap-4 border-b border-line px-4 py-3 transition lg:flex ${
          cinema ? "pointer-events-none absolute z-20 w-full bg-gradient-to-b from-black/70 to-transparent opacity-0 hover:opacity-100" : ""
        }`}
      >
        <Link href="/library" className="text-muted transition hover:text-foreground">
          ←
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">
            {state?.title ?? roomTitle}
          </h1>
          <p className="truncate text-xs text-muted">{state?.videoTitle ?? videoTitle}</p>
        </div>
        <div className="ml-auto flex items-center gap-4">
          {!cinema && <InviteBar inviteCode={inviteCode} />}
          {!cinema && <Participants participants={state?.participants ?? []} />}
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${syncTone}`}
            >
              <span aria-hidden>{syncDot}</span>
              {reconnecting ? "Reconnecting..." : syncLabel}
            </span>
            <button
              type="button"
              onClick={() => sendEvent({ type: "sync" })}
              className="rounded-full border border-line px-2.5 py-1 text-xs transition hover:border-accent"
              title="Request the authoritative room state and re-anchor the player"
            >
              ↻ Sync
            </button>
            <button
              type="button"
              onClick={toggleCinema}
              className="rounded-full border border-line px-2.5 py-1 text-xs transition hover:border-accent"
              title="Cinema mode"
            >
              {cinema ? "Exit cinema" : "Cinema"}
            </button>
          </div>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section
          className={`w-full shrink-0 ${
            cinema
              ? "min-h-0 flex-1"
              : "aspect-video bg-black lg:aspect-auto lg:min-h-0 lg:flex-1 lg:bg-transparent lg:p-4"
          }`}
        >
          {state && stream ? (
            <VideoPlayer
              ref={playerRef}
              state={state}
              stream={
                stream.kind === "telegram"
                  ? { ...stream, path: resolveStreamPath(stream.path) }
                  : stream
              }
              isHost={isHost}
              getExpected={getExpected}
              onControl={sendEvent}
              onDrift={handleDrift}
              floating={floating}
            />
          ) : (
            <div className="flex h-full min-h-[240px] items-center justify-center rounded-xl border border-line bg-surface p-4 text-center text-sm text-muted">
              {banner ?? "Connecting to the room..."}
            </div>
          )}
        </section>

        {!cinema && (
          <div className="flex shrink-0 border-b border-line lg:hidden">
            <button type="button" onClick={() => setMobileTab("chat")} className={tabClass(mobileTab === "chat")}>
              Chat
            </button>
            <button type="button" onClick={() => setMobileTab("room")} className={tabClass(mobileTab === "room")}>
              Room
            </button>
          </div>
        )}

        {!cinema && (
          <aside
            className={`min-h-0 flex-1 flex-col lg:flex lg:w-80 lg:flex-none lg:border-l lg:border-line ${
              mobileTab === "chat" ? "flex" : "hidden"
            }`}
          >
            <ChatPanel
              messages={chat}
              myName={displayName}
              hostName={state?.participants.find((p) => p.role === "host")?.displayName ?? null}
              isHost={isHost}
              getExpected={getExpected}
              onSend={(body, videoTimestamp) =>
                sendEvent({ type: "chat", body, videoTimestamp })
              }
              onReact={(emoji) => sendEvent({ type: "reaction", emoji })}
              onTimestampClick={onTimestampClick}
            />
          </aside>
        )}

        {!cinema && mobileTab === "room" && (
          <section className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 lg:hidden">
            <div className="rounded-xl border border-line bg-surface p-4">
              <h2 className="text-sm font-semibold">Invite your friend</h2>
              <p className="mt-1 text-xs text-muted">
                Send this link — it works on phones too. Only the first two people can join.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <InviteBar inviteCode={inviteCode} />
              </div>
            </div>

            <div className="rounded-xl border border-line bg-surface p-4">
              <h2 className="text-sm font-semibold">In the room</h2>
              <div className="mt-3">
                <Participants participants={state?.participants ?? []} />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => sendEvent({ type: "sync" })}
                className="h-11 rounded-lg border border-line px-4 text-sm transition active:bg-surface-2"
              >
                ↻ Resync
              </button>
              <button
                type="button"
                onClick={toggleCinema}
                className="h-11 rounded-lg border border-line px-4 text-sm transition active:bg-surface-2"
              >
                {cinema ? "Exit cinema" : "Cinema mode"}
              </button>
            </div>

            <p className="pb-4 text-xs text-muted">
              {isHost
                ? "You are the host: play, pause and seek control both of you."
                : "The host controls playback — your player follows automatically."}
            </p>
          </section>
        )}
      </main>

      {banner && (
        <div className="safe-bottom fixed inset-x-3 bottom-0 z-50 mx-auto flex max-w-md items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-sm shadow-xl sm:left-1/2 sm:right-auto sm:-translate-x-1/2">
          <span>{banner}</span>
          {!terminal && (
            <button
              type="button"
              className="ml-auto text-muted hover:text-foreground"
              onClick={() => setBanner(null)}
              aria-label="Dismiss"
            >
              ✕
            </button>
          )}
        </div>
      )}
    </div>
  );
}
