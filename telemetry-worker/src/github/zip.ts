// Reads a zip archive held in memory (a GitHub Actions artifact) with Web APIs only: no dependency, no Node API.
//
// The archive is untrusted: a pull request from a fork uploads whatever it likes. Invariants:
// - Every offset and length read from the archive is checked against the buffer before it is used; an archive whose
//   structure points outside itself is refused as a whole (ZipError). zip64 and multi-disk archives are refused: an
//   artifact of race files is a few hundred small files.
// - Sizes written in the archive are claims, not facts. An entry is inflated in a stream and dropped as soon as its
//   real output passes `maxEntryBytes` (a zip bomb costs one entry's cap, never its claimed or real size); the bytes
//   kept in total are capped too, and so is the number of entries read.
// - `filter` runs on the entry's name before anything is inflated, so files the caller does not want cost nothing.
// - Names are data: nothing is written to disk and no path is resolved. A name that is absolute, has a "." or ".."
//   segment or a control character is skipped anyway, so a caller can show names without thinking about them.
// - The CRC-32 of every entry kept is checked. One bad entry is skipped with a reason; it never fails the archive.
// - readZip rejects only with ZipError.

export interface ZipLimits {
  /** Entries read (after the filter) before the rest are skipped. */
  maxEntries: number;
  /** Largest uncompressed size of one entry, in bytes. */
  maxEntryBytes: number;
  /** Largest total of uncompressed bytes kept. */
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 400, maxEntryBytes: 256 * 1024, maxTotalBytes: 8 * 1024 * 1024 };

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

export interface ZipSkipped {
  name: string;
  reason: string;
}

export interface ZipResult {
  entries: ZipEntry[];
  /** Entries that passed the filter but were not read, with why (at most MAX_SKIPPED are listed). */
  skipped: ZipSkipped[];
  /** File entries in the archive's central directory (directories not counted), before the filter. */
  total: number;
}

/** The archive itself cannot be read (not a zip, truncated, zip64, more than one disk, a directory that points outside the data). */
export class ZipError extends Error {}

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** Central directory records walked at most. */
const MAX_RECORDS = 20_000;
/** Skipped entries listed at most (the rest are still skipped). */
export const MAX_SKIPPED = 200;

let table: Uint32Array | null = null;
/** CRC-32 (IEEE 802.3), table driven. Exported for tests. */
export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** An entry's name as callers see it ("/" separators), or null when it is not a plain relative path. */
function safeName(raw: string): string | null {
  const name = raw.replace(/\\/g, "/");
  // eslint-disable-next-line no-control-regex
  if (!name || name.length > 512 || name.startsWith("/") || /[\u0000-\u001f\u007f]/.test(name)) return null;
  for (const seg of name.split("/")) if (seg === "" || seg === "." || seg === "..") return null;
  return name;
}

/** Raw-deflate `bytes`, stopping as soon as more than `max` bytes come out. */
async function inflate(bytes: Uint8Array, max: number): Promise<Uint8Array | "too large" | "corrupt entry"> {
  let stream: DecompressionStream;
  try {
    stream = new DecompressionStream("deflate-raw");
  } catch {
    return "corrupt entry";
  }
  const writer = stream.writable.getWriter();
  // not awaited before reading: the readable side must drain for the write to finish
  const fed = writer
    .write(bytes as BufferSource)
    .then(() => writer.close())
    .catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        await writer.abort().catch(() => undefined);
        await fed;
        return "too large";
      }
      chunks.push(value);
    }
  } catch {
    await writer.abort().catch(() => undefined);
    await fed;
    return "corrupt entry";
  }
  await fed;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/**
 * The files of a zip archive, within `limits` (DEFAULT_ZIP_LIMITS where not given). `filter` picks entries by name
 * before they are inflated. Entries come back in the archive's directory order.
 */
export async function readZip(data: Uint8Array, opts: { limits?: Partial<ZipLimits>; filter?: (name: string) => boolean } = {}): Promise<ZipResult> {
  const limits: ZipLimits = { ...DEFAULT_ZIP_LIMITS, ...(opts.limits ?? {}) };
  if (!(data instanceof Uint8Array) || data.length < 22) throw new ZipError("not a zip archive");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (at: number): number => view.getUint16(at, true);
  const u32 = (at: number): number => view.getUint32(at, true);

  // the end-of-central-directory record: the last one whose comment ends exactly at the end of the data
  let eocd = -1;
  const floor = Math.max(0, data.length - (22 + 0xffff));
  for (let i = data.length - 22; i >= floor; i--) {
    if (u32(i) === EOCD && i + 22 + u16(i + 20) === data.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not a zip archive");
  const count = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  const cdOffset = u32(eocd + 16);
  if ((eocd >= 20 && u32(eocd - 20) === EOCD64_LOCATOR) || count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("zip64 archives are not supported");
  if (u16(eocd + 4) !== 0 || u16(eocd + 6) !== 0 || u16(eocd + 8) !== count) throw new ZipError("archives in more than one part are not supported");
  if (cdOffset + cdSize > eocd) throw new ZipError("corrupt archive");
  if (count > MAX_RECORDS) throw new ZipError("too many entries");

  const out: ZipResult = { entries: [], skipped: [], total: 0 };
  const skip = (name: string, reason: string): void => {
    if (out.skipped.length < MAX_SKIPPED) out.skipped.push({ name, reason });
  };
  const dec = new TextDecoder("utf-8", { fatal: false });
  const seen = new Set<string>();
  let kept = 0;
  let accepted = 0;
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cdEnd || u32(p) !== CENTRAL) throw new ZipError("corrupt archive");
    const flags = u16(p + 8);
    const method = u16(p + 10);
    const crc = u32(p + 16);
    const compSize = u32(p + 20);
    const size = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    const local = u32(p + 42);
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > cdEnd) throw new ZipError("corrupt archive");
    const rawName = dec.decode(data.subarray(p + 46, p + 46 + nameLen));
    p = next;
    if (rawName.endsWith("/") || rawName.endsWith("\\")) continue; // a directory
    out.total++;
    const name = safeName(rawName);
    if (name === null) {
      // eslint-disable-next-line no-control-regex
      skip(rawName.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 120) || "(no name)", "unsafe name");
      continue;
    }
    if (opts.filter && !opts.filter(name)) continue;
    if (seen.has(name)) {
      skip(name, "duplicate name");
      continue;
    }
    seen.add(name);
    if (flags & 1) {
      skip(name, "encrypted");
      continue;
    }
    if (method !== 0 && method !== 8) {
      skip(name, "unsupported compression");
      continue;
    }
    if (size > limits.maxEntryBytes) {
      skip(name, "too large");
      continue;
    }
    if (accepted >= limits.maxEntries) {
      skip(name, "too many files");
      continue;
    }
    if (kept + size > limits.maxTotalBytes) {
      skip(name, "archive too large");
      continue;
    }
    // the local header says where the data starts (its own name and extra lengths, which may differ from the directory's)
    if (local + 30 > data.length || u32(local) !== LOCAL) {
      skip(name, "corrupt entry");
      continue;
    }
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    if (start + compSize > data.length) {
      skip(name, "corrupt entry");
      continue;
    }
    const raw = data.subarray(start, start + compSize);
    let bytes: Uint8Array;
    if (method === 0) {
      if (compSize !== size) {
        skip(name, "corrupt entry");
        continue;
      }
      bytes = raw.slice();
    } else {
      const r = await inflate(raw, limits.maxEntryBytes);
      if (typeof r === "string") {
        skip(name, r);
        continue;
      }
      if (r.length !== size) {
        skip(name, "corrupt entry");
        continue;
      }
      bytes = r;
    }
    if (crc32(bytes) !== crc) {
      skip(name, "crc mismatch");
      continue;
    }
    if (kept + bytes.length > limits.maxTotalBytes) {
      skip(name, "archive too large");
      continue;
    }
    kept += bytes.length;
    accepted++;
    out.entries.push({ name, bytes });
  }
  return out;
}
