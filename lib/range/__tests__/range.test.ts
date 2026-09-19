import { describe, expect, it } from "vitest";
import { alignToChunk, parseRange } from "../../range";

describe("parseRange", () => {
  it("parses an inclusive byte range", () => {
    expect(parseRange("bytes=0-1023", 10_000)).toEqual({ start: 0, end: 1023 });
    expect(parseRange("bytes=5000-9999", 10_000)).toEqual({ start: 5000, end: 9999 });
  });

  it("parses an open-ended range to the end of the file", () => {
    expect(parseRange("bytes=4096-", 10_000)).toEqual({ start: 4096, end: 9999 });
  });

  it("parses a suffix range (last N bytes)", () => {
    expect(parseRange("bytes=-2000", 10_000)).toEqual({ start: 8000, end: 9999 });
  });

  it("clamps an end beyond the file size", () => {
    expect(parseRange("bytes=9000-20000", 10_000)).toEqual({ start: 9000, end: 9999 });
  });

  it("rejects invalid or unsupported ranges", () => {
    expect(parseRange(null, 10_000)).toBeNull();
    expect(parseRange("bytes=-", 10_000)).toBeNull();
    expect(parseRange("items=0-1", 10_000)).toBeNull();
    expect(parseRange("bytes=10000-20000", 10_000)).toBeNull();
    expect(parseRange("bytes=500-100", 10_000)).toBeNull();
    expect(parseRange("bytes=0-1023, 2048-3071", 10_000)).toBeNull();
  });
});

describe("alignToChunk", () => {
  const KB = 1024;
  it("keeps an aligned offset unchanged", () => {
    expect(alignToChunk(0, KB)).toEqual({ offset: 0, skip: 0 });
    expect(alignToChunk(512 * KB, KB)).toEqual({ offset: 512 * KB, skip: 0 });
  });

  it("rounds the offset down and reports the bytes to discard", () => {
    expect(alignToChunk(500, KB)).toEqual({ offset: 0, skip: 500 });
    expect(alignToChunk(KB * 3 + 7, KB)).toEqual({ offset: KB * 3, skip: 7 });
    // browser seeking into a moov atom at an arbitrary byte position
    const { offset } = alignToChunk(9_876_543, 512 * KB);
    expect(offset % (512 * KB)).toBe(0);
  });
});
