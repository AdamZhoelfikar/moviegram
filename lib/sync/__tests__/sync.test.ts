import { describe, expect, it } from "vitest";
import {
  classifyConnection,
  computeDriftMs,
  correctionFor,
  estimateClockOffset,
  expectedPosition,
  formatTime,
} from "../../sync";

const base = {
  playing: true,
  positionSeconds: 100,
  playbackRate: 1,
  serverTsMs: 1_000_000,
};

describe("estimateClockOffset", () => {
  it("centers server time between send and receive", () => {
    expect(estimateClockOffset(1000, 2500, 2000)).toBe(1000);
  });
});

describe("expectedPosition", () => {
  it("advances the authoritative position while playing", () => {
    const pos = expectedPosition(base, 1_002_000, 0);
    expect(pos).toBeCloseTo(102, 6);
  });

  it("holds the position while paused", () => {
    expect(expectedPosition({ ...base, playing: false }, 9_999_999, 0)).toBe(100);
  });

  it("accounts for clock offset", () => {
    const pos = expectedPosition(base, 1_002_000, -2_000);
    expect(pos).toBeCloseTo(100, 6);
  });

  it("scales with playback rate", () => {
    const pos = expectedPosition({ ...base, playbackRate: 2 }, 1_002_000, 0);
    expect(pos).toBeCloseTo(104, 6);
  });

  it("never returns a position beyond duration or before zero", () => {
    expect(expectedPosition(base, 1_002_000, 0, 101)).toBe(101);
    expect(expectedPosition({ ...base, serverTsMs: 1_005_000 }, 1_002_000, 0)).toBe(100);
  });
});

describe("correctionFor (PRD 6.12 thresholds)", () => {
  it("ignores drift below 100ms", () => {
    expect(correctionFor(50, 100).action).toBe("none");
    expect(correctionFor(-99, 100).action).toBe("none");
  });

  it("nudges playbackRate between 100ms and 500ms", () => {
    const behind = correctionFor(-200, 100);
    const ahead = correctionFor(200, 100);
    expect(behind.action).toBe("nudge");
    expect(ahead.action).toBe("nudge");
    if (behind.action === "nudge" && ahead.action === "nudge") {
      expect(behind.rate).toBeGreaterThan(1);
      expect(ahead.rate).toBeLessThan(1);
    }
  });

  it("hard-seeks above 500ms", () => {
    const correction = correctionFor(600, 100);
    expect(correction.action).toBe("seek");
    if (correction.action === "seek") {
      expect(correction.positionSeconds).toBe(100);
    }
    expect(correctionFor(-5_000, 100).action).toBe("seek");
  });

  it("computes drift sign: positive means ahead", () => {
    expect(computeDriftMs(102, 100)).toBeCloseTo(2000, 6);
    expect(computeDriftMs(99.9, 100)).toBeCloseTo(-100, 6);
  });
});

describe("classifyConnection (PRD 12 buffering vs sync vs connection)", () => {
  it("separates reconnecting from disconnected", () => {
    expect(
      classifyConnection({
        socketOpen: false,
        reconnectPending: true,
        waitingForData: false,
        driftMs: 0,
        hasState: true,
      }),
    ).toBe("reconnecting");
    expect(
      classifyConnection({
        socketOpen: false,
        reconnectPending: false,
        waitingForData: false,
        driftMs: 0,
        hasState: true,
      }),
    ).toBe("disconnected");
  });

  it("labels buffering as buffering, not as a sync error", () => {
    expect(
      classifyConnection({
        socketOpen: true,
        reconnectPending: false,
        waitingForData: true,
        driftMs: 4_000,
        hasState: true,
      }),
    ).toBe("buffering");
  });

  it("labels significant drift as syncing", () => {
    expect(
      classifyConnection({
        socketOpen: true,
        reconnectPending: false,
        waitingForData: false,
        driftMs: 300,
        hasState: true,
      }),
    ).toBe("syncing");
  });
});

describe("formatTime", () => {
  it("formats mm:ss and h:mm:ss", () => {
    expect(formatTime(84.2)).toBe("1:24");
    expect(formatTime(5072)).toBe("1:24:32");
    expect(formatTime(null)).toBe("--:--");
  });
});
