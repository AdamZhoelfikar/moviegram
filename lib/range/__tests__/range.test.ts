import { describe, expect, it } from "vitest";
import { parseRange } from "../../range";

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
