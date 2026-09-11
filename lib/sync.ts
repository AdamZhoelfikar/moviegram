// Pure synchronization math (PRD 6.11-6.13, 11). No DOM, no network — unit testable.

export type SyncThresholds = {
  /** Drift below this is ignored entirely (ms). */
  ignoreMs: number;
  /** Up to this, correct gradually with a playbackRate nudge (ms). */
  gradualMs: number;
  /** At/above this, hard-seek to the authoritative position (ms). */
  hardMs: number;
  /** Nudge playbackRate applied while inside the gradual band. */
  nudgeRate: number;
};

export const DEFAULT_THRESHOLDS: SyncThresholds = {
  ignoreMs: 100,
  gradualMs: 500,
  hardMs: 1000,
  nudgeRate: 1.05,
};

export type AuthoritativeState = {
  playing: boolean;
  positionSeconds: number;
  playbackRate: number;
  /** Server wall-clock ms when positionSeconds was true. */
  serverTsMs: number;
};

/**
 * Clock offset = serverTime - localTime, estimated from ping/pong samples.
 */
export function estimateClockOffset(
  t0LocalMs: number,
  serverTsMs: number,
  t1LocalMs: number,
): number {
  const midPoint = (t0LocalMs + t1LocalMs) / 2;
  return serverTsMs - midPoint;
}

/**
 * expectedPosition = authoritativePosition + elapsedServerTime (PRD 11.1).
 */
export function expectedPosition(
  state: AuthoritativeState,
  nowLocalMs: number,
  clockOffsetMs: number,
  durationSeconds?: number | null,
): number {
  if (!state.playing) return clampPosition(state.positionSeconds, durationSeconds);
  const nowServerMs = nowLocalMs + clockOffsetMs;
  const elapsedSeconds = Math.max(0, nowServerMs - state.serverTsMs) / 1000;
  return clampPosition(
    state.positionSeconds + elapsedSeconds * state.playbackRate,
    durationSeconds,
  );
}

/** Positive = local player is ahead of the room. */
export function computeDriftMs(
  localPositionSeconds: number,
  expectedSeconds: number,
): number {
  return (localPositionSeconds - expectedSeconds) * 1000;
}

export type Correction =
  | { action: "none" }
  | { action: "nudge"; rate: number }
  | { action: "seek"; positionSeconds: number };

export function correctionFor(
  driftMs: number,
  expectedSeconds: number,
  thresholds: SyncThresholds = DEFAULT_THRESHOLDS,
): Correction {
  const abs = Math.abs(driftMs);
  if (abs < thresholds.ignoreMs) return { action: "none" };
  if (abs <= thresholds.gradualMs) {
    const speedUp = driftMs < 0;
    return {
      action: "nudge",
      rate: speedUp ? thresholds.nudgeRate : 2 - thresholds.nudgeRate,
    };
  }
  return { action: "seek", positionSeconds: Math.max(0, expectedSeconds) };
}

function clampPosition(position: number, duration?: number | null): number {
  if (duration && duration > 0 && position > duration) return duration;
  return Math.max(0, position);
}

export type ConnectionState =
  | "playing"
  | "paused"
  | "buffering"
  | "syncing"
  | "disconnected"
  | "reconnecting"
  | "ready";

/** Maps raw signals to the user-facing states of PRD section 12. */
export function classifyConnection(input: {
  socketOpen: boolean;
  reconnectPending: boolean;
  waitingForData: boolean;
  driftMs: number;
  hasState: boolean;
}): ConnectionState {
  if (input.reconnectPending) return "reconnecting";
  if (!input.socketOpen) return "disconnected";
  if (input.waitingForData) return "buffering";
  if (!input.hasState || Math.abs(input.driftMs) > DEFAULT_THRESHOLDS.ignoreMs)
    return "syncing";
  return "ready";
}

export function formatTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "--:--";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}
