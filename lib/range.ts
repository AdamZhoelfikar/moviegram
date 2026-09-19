export type ByteRange = { start: number; end: number };

/**
 * Parses a single HTTP Range header of the form `bytes=start-end`,
 * `bytes=start-`, or `bytes=-suffix`. Returns null when invalid/unsupported.
 */
export function parseRange(header: string | null, totalSize: number): ByteRange | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  let start: number;
  let end: number;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? totalSize - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start >= totalSize || end < start) return null;
  return { start, end: Math.min(end, totalSize - 1) };
}

export function rangeHeader(start: number, end: number, total: number): string {
  return `bytes ${start}-${end}/${total}`;
}

/**
 * MTProto upload.getFile requires the byte offset to be a multiple of the
 * request limit, but browsers issue HTTP ranges at arbitrary positions
 * (moov probes, seeks). Align the offset down to a chunk boundary and
 * report how many leading bytes must be discarded before the wanted range.
 */
export function alignToChunk(
  start: number,
  chunkSize: number,
): { offset: number; skip: number } {
  const offset = Math.floor(start / chunkSize) * chunkSize;
  return { offset, skip: start - offset };
}
