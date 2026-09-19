"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  Expand,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { ClientEvent, RoomStateMessage, StreamDescriptor } from "../../lib/protocol";
import { correctionFor, formatTime } from "../../lib/sync";

export type VideoPlayerHandle = {
  seekLocal: (seconds: number) => void;
};

type FloatingReaction = { id: number; emoji: string; name: string };

const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 2];

// 44px touch targets on phones, tighter on desktop pointers.
const CTRL_BTN =
  "flex h-11 w-11 shrink-0 items-center justify-center text-white/80 transition hover:text-white disabled:opacity-40 sm:h-9 sm:w-9";

const VideoPlayer = forwardRef<VideoPlayerHandle, {
  state: RoomStateMessage;
  stream: StreamDescriptor;
  isHost: boolean;
  getExpected: (nowMs: number) => number | null;
  onControl: (event: ClientEvent) => void;
  onDrift: (ms: number) => void;
  floating: FloatingReaction[];
}>(function VideoPlayer(
  { state, stream, isHost, getExpected, onControl, onDrift, floating },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrubbingRef = useRef(false);
  const controlsVisibleRef = useRef(true);
  const stateRef = useRef(state);
  const getExpectedRef = useRef(getExpected);
  const isHostRef = useRef(isHost);

  useEffect(() => {
    stateRef.current = state;
    getExpectedRef.current = getExpected;
    isHostRef.current = isHost;
  }, [state, getExpected, isHost]);

  const [nowDisplay, setNowDisplay] = useState(state.positionSeconds);
  const [duration, setDuration] = useState(state.durationSeconds ?? 0);
  const [buffering, setBuffering] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [codecUnsupported, setCodecUnsupported] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [scrubValue, setScrubValue] = useState<number | null>(null);

  useEffect(() => {
    controlsVisibleRef.current = controlsVisible;
  }, [controlsVisible]);

  const src = stream.kind === "url" ? stream.url : stream.path;

  useImperativeHandle(ref, () => ({
    seekLocal: (seconds: number) => {
      const el = videoRef.current;
      if (el) el.currentTime = Math.max(0, seconds);
    },
  }));

  // Swap source when the room switches video (auto next episode, host change)
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (!el.src.endsWith(src) && el.src !== window.location.origin + src) {
      setCodecUnsupported(false);
      el.src = src;
      el.load();
    }
  }, [src]);

  // Apply authoritative transitions (PRD 11.4)
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const expected = getExpectedRef.current(Date.now()) ?? state.positionSeconds;
    if (state.playing) {
      el.playbackRate = state.playbackRate;
      el.play().then(
        () => setAutoplayBlocked(false),
        () => setAutoplayBlocked(true),
      );
    } else {
      el.pause();
      if (Math.abs(el.currentTime - expected) > 0.25) {
        el.currentTime = expected;
      }
    }
    if (el.duration > 0) setDuration(el.duration);
    setNowDisplay(expected);
  }, [state]);

  // Continuous drift correction (PRD 6.12)
  useEffect(() => {
    const tick = setInterval(() => {
      const el = videoRef.current;
      const snapshot = stateRef.current;
      if (!el || el.readyState < 2 || scrubbingRef.current) return;
      const expected = getExpectedRef.current(Date.now());
      if (expected == null) return;
      const drift = (el.currentTime - expected) * 1000;
      onDrift(drift);
      setNowDisplay(expected);
      if (!snapshot.playing || el.paused || el.seeking) return;
      const correction = correctionFor(drift, expected);
      if (correction.action === "none") return;
      if (correction.action === "nudge") {
        el.playbackRate = Math.min(4, Math.max(0.25, correction.rate * snapshot.playbackRate));
        if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
        nudgeTimerRef.current = setTimeout(() => {
          const inner = videoRef.current;
          if (inner) inner.playbackRate = stateRef.current.playbackRate;
        }, 2500);
        return;
      }
      if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
      el.playbackRate = snapshot.playbackRate;
      el.currentTime = correction.positionSeconds;
    }, 250);
    return () => clearInterval(tick);
  }, [onDrift]);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
  }, []);

  // Phones have no hover: tapping the picture is how you summon/hide controls.
  const toggleControls = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    const next = !controlsVisibleRef.current;
    setControlsVisible(next);
    if (next) {
      hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
    }
  }, []);

  const togglePlay = useCallback(() => {
    const el = videoRef.current;
    const snapshot = stateRef.current;
    if (!el || !isHostRef.current) return;
    if (snapshot.playing) {
      onControl({ type: "pause", position: el.currentTime });
    } else {
      onControl({ type: "play", position: el.currentTime });
    }
  }, [onControl]);

  const commitSeek = useCallback(
    (seconds: number) => {
      const el = videoRef.current;
      if (!el || !isHostRef.current) return;
      el.currentTime = Math.max(0, seconds);
      onControl({ type: "seek", position: Math.max(0, seconds) });
    },
    [onControl],
  );

  const setRate = useCallback(
    (rate: number) => {
      const el = videoRef.current;
      const snapshot = stateRef.current;
      if (!el || !isHostRef.current) return;
      if (snapshot.playing) {
        onControl({ type: "play", position: el.currentTime, rate });
      } else {
        onControl({ type: "seek", position: el.currentTime });
        el.playbackRate = rate;
      }
    },
    [onControl],
  );

  const lockLandscape = useCallback(() => {
    const orientation = screen.orientation as
      | (ScreenOrientation & { lock?: (orientation: string) => Promise<void> })
      | undefined;
    void orientation?.lock?.("landscape").catch(() => undefined);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current;
    const el = videoRef.current;
    if (!container || !el) return;

    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      screen.orientation?.unlock?.();
      return;
    }

    // iPhone Safari only allows fullscreen on the <video> itself; the native
    // player handles rotation on its own.
    const iosVideo = el as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    if (typeof container.requestFullscreen !== "function") {
      iosVideo.webkitEnterFullscreen?.();
      return;
    }

    // Phones: go fullscreen, then rotate to landscape so the movie fills the
    // screen (screen.orientation.lock needs an active fullscreen element and
    // is unsupported on Firefox/desktop — fail quietly there).
    void container
      .requestFullscreen({ navigationUI: "hide" })
      .then(() => lockLandscape())
      .catch(() => iosVideo.webkitEnterFullscreen?.());
  }, [lockLandscape]);

  useEffect(() => {
    const onChange = (): void => {
      const active = Boolean(document.fullscreenElement);
      setIsFullscreen(active);
      if (active) lockLandscape();
      else screen.orientation?.unlock?.();
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [lockLandscape]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      const el = videoRef.current;
      if (!el) return;
      switch (event.key) {
        case " ":
        case "k":
          event.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          event.preventDefault();
          if (isHostRef.current) commitSeek(el.currentTime - 5);
          break;
        case "ArrowRight":
          event.preventDefault();
          if (isHostRef.current) commitSeek(el.currentTime + 5);
          break;
        case "ArrowUp":
          event.preventDefault();
          setVolume((v) => Math.min(1, v + 0.05));
          break;
        case "ArrowDown":
          event.preventDefault();
          setVolume((v) => Math.max(0, v - 0.05));
          break;
        case "m":
          setMuted((m) => !m);
          break;
        case "f":
          toggleFullscreen();
          break;
      }
      showControls();
    },
    [togglePlay, commitSeek, toggleFullscreen, showControls],
  );

  useEffect(() => {
    const el = videoRef.current;
    if (el) {
      el.volume = volume;
      el.muted = muted;
    }
  }, [volume, muted]);

  const progressMax = duration || state.durationSeconds || 0;
  const progressValue = scrubValue ?? nowDisplay;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onMouseMove={showControls}
      onKeyDown={onKeyDown}
      className="player-shell group relative flex h-full max-h-full select-none flex-col overflow-hidden rounded-none bg-black outline-none lg:rounded-xl"
    >
      <video
        ref={videoRef}
        playsInline
        onClick={toggleControls}
        className="min-h-0 w-full flex-1 bg-black"
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          if (Number.isFinite(el.duration)) setDuration(el.duration);
          const expected = getExpectedRef.current(Date.now());
          if (expected != null) el.currentTime = expected;
          // Chrome/Chromium silently drops HEVC (hvc1) tracks: audio plays,
          // the canvas stays black, readyState still reaches 4. Say so.
          setCodecUnsupported(el.videoWidth === 0 && el.videoHeight === 0 && !el.error);
        }}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onEnded={() => {
          if (isHostRef.current) onControl({ type: "ended" });
        }}
      >
        {stream.subtitlePath && (
          <track kind="subtitles" src={stream.subtitlePath} srcLang="en" label="Subtitles" />
        )}
      </video>

      {floating.map((reaction, index) => (
        <span
          key={reaction.id}
          className="reaction-float pointer-events-none absolute bottom-28 right-6 z-20 text-3xl"
          style={{ animationDelay: `${index * 40}ms` }}
          title={reaction.name}
        >
          {reaction.emoji}
        </span>
      ))}

      {codecUnsupported && (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-4">
          <p className="max-w-md rounded-lg bg-black/80 px-4 py-3 text-center text-sm leading-snug text-white ring-1 ring-white/15">
            Your browser can&apos;t decode this video&apos;s codec — the picture stays
            black while audio keeps playing (common with HEVC/H.265 files).
            <span className="mt-1 block text-xs text-white/60">
              Ask your host to re-upload an H.264 + faststart copy, or open the
              room in a browser that supports HEVC. Sync still works for both of you.
            </span>
          </p>
        </div>
      )}

      {buffering && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-accent" />
        </div>
      )}

      {autoplayBlocked && (
        <button
          type="button"
          onClick={() => {
            const el = videoRef.current;
            if (el) el.play().then(() => setAutoplayBlocked(false), () => undefined);
          }}
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 text-sm font-medium"
        >
          <span className="rounded-full bg-accent px-5 py-2.5 text-black">
            ▶ Tap to start watching
          </span>
        </button>
      )}

      <div
        className={`safe-bottom absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-2 pt-8 transition-opacity sm:px-4 sm:pt-10 ${
          controlsVisible || !state.playing ? "opacity-100" : "opacity-0"
        }`}
      >
        <input
          type="range"
          className="progress h-6 w-full sm:h-4"
          min={0}
          max={Math.max(progressMax, 0.1)}
          step={0.1}
          value={Math.min(progressValue, progressMax || progressValue)}
          readOnly={!isHost}
          aria-label="Seek"
          onPointerDown={() => {
            if (isHost) scrubbingRef.current = true;
          }}
          onInput={(e) => {
            if (isHost) setScrubValue(Number((e.target as HTMLInputElement).value));
          }}
          onPointerUp={(e) => {
            if (!isHost) return;
            scrubbingRef.current = false;
            const value = Number((e.target as HTMLInputElement).value);
            setScrubValue(null);
            commitSeek(value);
          }}
          onKeyUp={(e) => {
            if (!isHost) return;
            scrubbingRef.current = false;
            const value = Number((e.target as HTMLInputElement).value);
            setScrubValue(null);
            commitSeek(value);
          }}
        />
        <div className="flex items-center gap-1 text-sm sm:gap-3">
          <button
            type="button"
            onClick={togglePlay}
            disabled={!isHost}
            title={isHost ? "Play/Pause" : "Only the host controls playback"}
            className={CTRL_BTN}
          >
            {state.playing ? <Pause size={22} /> : <Play size={22} />}
          </button>
          <span className="font-mono text-xs text-white/80">
            {formatTime(nowDisplay)} / {formatTime(duration || state.durationSeconds)}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setMuted((m) => !m)}
              className={CTRL_BTN}
              aria-label="Mute"
            >
              {muted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
            </button>
            <input
              type="range"
              className="progress hidden h-1 w-16 sm:block"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => {
                setVolume(Number(e.target.value));
                setMuted(false);
              }}
              aria-label="Volume"
            />
          </span>
          {isHost && (
            <select
              value={state.playbackRate}
              onChange={(e) => setRate(Number(e.target.value))}
              className="h-11 rounded border border-white/20 bg-black/60 px-1 text-xs text-white/80 sm:h-8"
              aria-label="Playback speed"
            >
              {SPEED_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}×
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => {
              const el = videoRef.current;
              if (!el) return;
              if (document.pictureInPictureElement) void document.exitPictureInPicture();
              else void el.requestPictureInPicture().catch(() => undefined);
            }}
            className={`${CTRL_BTN} hidden sm:flex`}
            aria-label="Picture in picture"
          >
            <PictureInPicture2 size={18} />
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            className={CTRL_BTN}
            aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen (landscape)"}
          >
            {isFullscreen ? <Minimize size={20} /> : <Expand size={20} />}
          </button>
        </div>
      </div>
    </div>
  );
});

export default VideoPlayer;
