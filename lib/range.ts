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
