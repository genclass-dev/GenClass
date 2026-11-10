// Reads a zip archive held in memory (a GitHub Actions artifact) with typed arrays and TextDecoder only: no
// dependency, no Node API and no platform stream, so it does the same work, byte for byte, wherever it runs.
//
// The archive is untrusted: a pull request from a fork uploads whatever it likes. Invariants:
// - Every offset and length read from the archive is checked against the buffer before it is used; an archive whose
//   structure points outside itself is refused as a whole (ZipError), before any entry is read. zip64 and multi-disk
//   archives are refused: an artifact of race files is a few hundred small files.
// - Sizes written in the archive are claims, not facts, and a claim is the most an entry can cost. An entry whose
//   claimed size is over `maxEntryBytes` is not started. One that is started is inflated here (inflateRaw, RFC 1951)
//   into a buffer of exactly its claimed size and dropped the moment its output would pass it: a zip bomb costs its
//   claimed size, never its real one. The runtime's DecompressionStream is not used: workerd inflates a whole write
//   before a byte of output can be counted, so a cap checked while reading that stream is not a cap there.
// - The work of one call is bounded whatever the entries turn out to be. Every entry that is inflated or copied
//   counts against `maxEntries`, and its claimed size against `maxTotalBytes`, before it is read and whether or not
//   it is kept (a wrong size or CRC costs what a good entry costs). Compressed data longer than deflate can need for
//   the claimed size is refused unread, and so is a record that points at a local header already read, so many
//   records cannot share one stream.
// - `filter` runs on the entry's name before anything is inflated, so files the caller does not want cost nothing.
// - Names are data: nothing is written to disk and no path is resolved. A name that is absolute, has a "." or ".."
//   segment or a control character is skipped anyway, so a caller can show names without thinking about them.
// - The CRC-32 of every entry kept is checked. One bad entry is skipped with a reason; it never fails the archive.
// - readZip rejects only with ZipError.

export interface ZipLimits {
  /** Entries inflated or copied (after the filter), kept or not, before the rest are skipped. */
  maxEntries: number;
  /** Largest uncompressed size of one entry, in bytes. */
  maxEntryBytes: number;
  /** Largest total of the claimed uncompressed sizes of the entries inflated or copied, kept or not. */
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
  /** Bytes counted against `maxTotalBytes`: what a caller with a budget over several archives takes off it. */
  spent: number;
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

// --------------------------------------------------------------------------------------------- inflate (RFC 1951)

/** Length codes 257..285 and distance codes 0..29: the base value and the number of extra bits (RFC 1951, 3.2.5). */
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/** The order in which a dynamic block gives the lengths of its code-length code (RFC 1951, 3.2.7). */
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman code: how many codes each length has (index 0: symbols not used), and the symbols in code order. */
interface Huffman {
  count: Uint16Array;
  symbol: Uint16Array;
}

const huffman = (symbols: number): Huffman => ({ count: new Uint16Array(16), symbol: new Uint16Array(symbols) });

/**
 * Fills `h` from the code lengths of `n` symbols at `lengths[from..]`. Returns 0 for a complete code, the number of
 * codes left unused for an incomplete one, and -1 for lengths that are no prefix code at all (over-subscribed).
 */
function construct(h: Huffman, lengths: Uint8Array, from: number, n: number, offs: Uint16Array): number {
  h.count.fill(0);
  for (let i = 0; i < n; i++) {
    const len = lengths[from + i]!;
    h.count[len] = h.count[len]! + 1;
  }
  let left = 1;
  for (let len = 1; len <= 15; len++) {
    left = (left << 1) - h.count[len]!;
    if (left < 0) return -1;
  }
  offs[1] = 0;
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len]! + h.count[len]!;
  for (let i = 0; i < n; i++) {
    const len = lengths[from + i]!;
    if (len === 0) continue;
    h.symbol[offs[len]!] = i;
    offs[len] = offs[len]! + 1;
  }
  return left;
}

let fixed: { lit: Huffman; dist: Huffman } | null = null;
/** The codes of a block compressed with fixed Huffman codes (RFC 1951, 3.2.6), built once. */
function fixedCodes(): { lit: Huffman; dist: Huffman } {
  if (!fixed) {
    const lengths = new Uint8Array(288 + 30);
    lengths.fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288).fill(5, 288);
    const offs = new Uint16Array(16);
    const lit = huffman(288);
    const dist = huffman(30);
    construct(lit, lengths, 0, 288, offs);
    construct(dist, lengths, 288, 30, offs);
    fixed = { lit, dist };
  }
  return fixed;
}

/**
 * Inflates a raw deflate stream that must give exactly `size` bytes; null when it is damaged, ends early, or gives
 * fewer or more. Synchronous and bounded by construction: the output buffer is `size` bytes and nothing is ever
 * written past it, every step uses up input, and no memory is taken beyond the buffer and a few small tables. Bytes
 * after the last block are not read. Exported for tests.
 */
export function inflateRaw(src: Uint8Array, size: number): Uint8Array | null {
  const out = new Uint8Array(size);
  let op = 0;
  let ip = 0;
  // bits taken from the input and not used yet, low bit first (fewer than 8 between two reads)
  let hold = 0;
  let held = 0;
  /** The next `n` bits (0 to 13) as a number; -1 when the input ends first. */
  const bits = (n: number): number => {
    while (held < n) {
      if (ip >= src.length) return -1;
      hold |= src[ip++]! << held;
      held += 8;
    }
    const v = hold & ((1 << n) - 1);
    hold >>>= n;
    held -= n;
    return v;
  };
  /** The next symbol of code `h`; -1 when the input ends first or the bits are no code of `h`. */
  const decode = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      if (held === 0) {
        if (ip >= src.length) return -1;
        hold = src[ip++]!;
        held = 8;
      }
      code |= hold & 1;
      hold >>>= 1;
      held--;
      const count = h.count[len]!;
      if (code - count < first) return h.symbol[index + (code - first)]!;
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    return -1;
  };

  const lengths = new Uint8Array(286 + 30);
  const offs = new Uint16Array(16);
  const ownLit = huffman(286);
  const ownDist = huffman(30);
  const lenCode = huffman(19);
  for (;;) {
    const last = bits(1);
    const type = bits(2);
    if (last < 0 || type < 0 || type === 3) return null;
    if (type === 0) {
      // stored: the rest of the byte is padding, then the length, its complement, and that many bytes as they are
      hold = 0;
      held = 0;
      if (ip + 4 > src.length) return null;
      const len = src[ip]! | (src[ip + 1]! << 8);
      if ((len ^ 0xffff) !== (src[ip + 2]! | (src[ip + 3]! << 8))) return null;
      ip += 4;
      if (ip + len > src.length || op + len > size) return null;
      out.set(src.subarray(ip, ip + len), op);
      ip += len;
      op += len;
    } else {
      let lit = ownLit;
      let dist = ownDist;
      if (type === 1) ({ lit, dist } = fixedCodes());
      else {
        // dynamic: the block brings its own codes, their lengths written with a third code
        const a = bits(5);
        const b = bits(5);
        const c = bits(4);
        if (a < 0 || b < 0 || c < 0) return null;
        const nlit = a + 257;
        const ndist = b + 1;
        if (nlit > 286 || ndist > 30) return null;
        lengths.fill(0, 0, 19);
        for (let i = 0; i < c + 4; i++) {
          const v = bits(3);
          if (v < 0) return null;
          lengths[CL_ORDER[i]!] = v;
        }
        if (construct(lenCode, lengths, 0, 19, offs) !== 0) return null;
        const total = nlit + ndist;
        let n = 0;
        while (n < total) {
          const sym = decode(lenCode);
          if (sym < 0) return null;
          if (sym < 16) {
            lengths[n++] = sym;
            continue;
          }
          // 16: the previous length 3 to 6 times; 17 and 18: zero 3 to 10 and 11 to 138 times
          let value = 0;
          let repeat: number;
          if (sym === 16) {
            if (n === 0) return null;
            value = lengths[n - 1]!;
            repeat = bits(2);
          } else repeat = sym === 17 ? bits(3) : bits(7);
          if (repeat < 0) return null;
          repeat += sym === 18 ? 11 : 3;
          if (n + repeat > total) return null;
          while (repeat-- > 0) lengths[n++] = value;
        }
        // a block needs its end code; an incomplete code is allowed only when it has a single one-bit code
        if (lengths[256] === 0) return null;
        const litLeft = construct(lit, lengths, 0, nlit, offs);
        if (litLeft < 0 || (litLeft > 0 && nlit !== lit.count[0]! + lit.count[1]!)) return null;
        const distLeft = construct(dist, lengths, nlit, ndist, offs);
        if (distLeft < 0 || (distLeft > 0 && ndist !== dist.count[0]! + dist.count[1]!)) return null;
      }
      for (;;) {
        const sym = decode(lit);
        if (sym < 0) return null;
        if (sym === 256) break;
        if (sym < 256) {
          if (op >= size) return null;
          out[op++] = sym;
          continue;
        }
        // a length and a distance: copy `len` bytes from `back` bytes behind (the two may overlap)
        const l = sym - 257;
        if (l >= 29) return null;
        const more = bits(LEN_EXTRA[l]!);
        const d = decode(dist);
        if (more < 0 || d < 0 || d >= 30) return null;
        const far = bits(DIST_EXTRA[d]!);
        if (far < 0) return null;
        const len = LEN_BASE[l]! + more;
        const back = DIST_BASE[d]! + far;
        if (back > op || op + len > size) return null;
        for (const end = op + len; op < end; op++) out[op] = out[op - back]!;
      }
    }
    if (last) break;
  }
  return op === size ? out : null;
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
  // the whole directory is walked before any entry is read: an archive that is refused is refused before it costs anything
  const cdEnd = cdOffset + cdSize;
  for (let i = 0, at = cdOffset; i < count; i++) {
    if (at + 46 > cdEnd || u32(at) !== CENTRAL) throw new ZipError("corrupt archive");
    at += 46 + u16(at + 28) + u16(at + 30) + u16(at + 32);
    if (at > cdEnd) throw new ZipError("corrupt archive");
  }

  const out: ZipResult = { entries: [], skipped: [], total: 0, spent: 0 };
  const skip = (name: string, reason: string): void => {
    if (out.skipped.length < MAX_SKIPPED) out.skipped.push({ name, reason });
  };
  const dec = new TextDecoder("utf-8", { fatal: false });
  const seen = new Set<string>();
  // local headers already read: a second record pointing at one would read the same data again
  const used = new Set<number>();
  // entries inflated or copied so far, kept or not
  let read = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    const flags = u16(p + 8);
    const method = u16(p + 10);
    const crc = u32(p + 16);
    const compSize = u32(p + 20);
    const size = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    const local = u32(p + 42);
    const rawName = dec.decode(data.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
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
    if (read >= limits.maxEntries) {
      skip(name, "too many files");
      continue;
    }
    if (out.spent + size > limits.maxTotalBytes) {
      skip(name, "archive too large");
      continue;
    }
    // the local header says where the data starts (its own name and extra lengths, which may differ from the directory's)
    if (local + 30 > data.length || u32(local) !== LOCAL) {
      skip(name, "corrupt entry");
      continue;
    }
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    // Stored data is exactly its size. Deflate never needs more than an eighth and a sixty-fourth over the size plus a
    // few bytes (zlib's own bound for any settings), so longer data is not the stream of an entry of that size.
    const plausible = method === 0 ? compSize === size : compSize <= size + (size >>> 3) + (size >>> 6) + 64;
    if (start + compSize > data.length || !plausible || used.has(local)) {
      skip(name, "corrupt entry");
      continue;
    }
    used.add(local);
    // from here the entry costs work, so it counts against the limits whether or not it turns out to be good
    read++;
    out.spent += size;
    const raw = data.subarray(start, start + compSize);
    const bytes = method === 0 ? raw.slice() : inflateRaw(raw, size);
    if (bytes === null) {
      skip(name, "corrupt entry");
      continue;
    }
    if (crc32(bytes) !== crc) {
      skip(name, "crc mismatch");
      continue;
    }
    out.entries.push({ name, bytes });
  }
  return out;
}
