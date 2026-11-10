// The zip reader behind the GitHub App's artifact download (src/github/zip.ts): what it reads, what it skips and why,
// and that a hostile archive costs a bounded amount and can only ever be refused with ZipError.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants, deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { crc32, DEFAULT_ZIP_LIMITS, inflateRaw, MAX_SKIPPED, readZip, ZipError } from "../src/github/zip.js";
import { makeZip } from "./github-zip-helper.js";

const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** Bits packed the way deflate packs them: the first bit is the lowest bit of the first byte. */
function pack(bits: number[]): Uint8Array {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => {
    if (b) out[i >> 3]! |= 1 << (i & 7);
  });
  return out;
}
/** A header field or extra bits: `n` bits of `value`, lowest first. A Huffman code: its `n` bits, highest first. */
const field = (value: number, n: number): number[] => Array.from({ length: n }, (_, i) => (value >> i) & 1);
const code = (value: number, n: number): number[] => Array.from({ length: n }, (_, i) => (value >> (n - 1 - i)) & 1);
/** The start of a last block of a type (1: fixed codes, 2: dynamic), and the fixed code of a literal below 144. */
const lastBlock = (type: number): number[] => [1, ...field(type, 2)];
const literal = (byte: number): number[] => code(0x30 + byte, 8);

/** mulberry32: a small seeded generator, so the random cases are the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("github app: reading an artifact's zip (docs/github-app/README.md, \"Security\")", () => {
  it("reads stored and deflated files, text and binary, an empty file and a UTF-8 name, in the archive's order", async () => {
    const binary = Uint8Array.from({ length: 5000 }, (_, i) => (i * 31) & 0xff);
    const zip = makeZip([
      { name: "a.json", data: '{"schema":"genclass-races/1"}' },
      { name: "dir/b.json", data: "stored", method: 0 },
      { name: "empty.json", data: "" },
      { name: "empty-stored.json", data: "", method: 0 },
      { name: "prüfung/ü.json", data: "ü" },
      { name: "bin.dat", data: binary },
    ]);
    const r = await readZip(zip);
    expect(r.total).toBe(6);
    expect(r.skipped).toEqual([]);
    expect(r.entries.map((e) => e.name)).toEqual(["a.json", "dir/b.json", "empty.json", "empty-stored.json", "prüfung/ü.json", "bin.dat"]);
    expect(text(r.entries[0]!.bytes)).toBe('{"schema":"genclass-races/1"}');
    expect(text(r.entries[1]!.bytes)).toBe("stored");
    expect(r.entries[2]!.bytes).toHaveLength(0);
    expect(text(r.entries[4]!.bytes)).toBe("ü");
    expect([...r.entries[5]!.bytes]).toEqual([...binary]);
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("the helper's archive is a real zip (the system's unzip reads it), and one made by zip is read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "genclass-zip-"));
    try {
      writeFileSync(join(dir, "mine.zip"), makeZip([{ name: "x/one.json", data: "one" }, { name: "two.json", data: "two".repeat(100), method: 0 }]));
      let listing = "";
      try {
        listing = execFileSync("unzip", ["-p", join(dir, "mine.zip"), "x/one.json"], { encoding: "utf8" });
      } catch {
        return; // no unzip on this machine: the round trip above is the check
      }
      expect(listing).toBe("one");
      writeFileSync(join(dir, "r.json"), '{"hello":"world"}');
      try {
        execFileSync("zip", ["-q", "-j", join(dir, "theirs.zip"), join(dir, "r.json")]);
      } catch {
        return;
      }
      const r = await readZip(new Uint8Array(readFileSync(join(dir, "theirs.zip"))));
      expect(r.entries.map((e) => [e.name, text(e.bytes)])).toEqual([["r.json", '{"hello":"world"}']]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the filter runs before anything is inflated, and directories are not files", async () => {
    const zip = makeZip([
      { name: "keep.json", data: "k" },
      { name: "sub/", data: "", method: 0 },
      // its CRC is wrong: reading it would be reported, so not seeing it proves it was never read
      { name: "skip.txt", data: "s", crc: 1 },
    ]);
    const r = await readZip(zip, { filter: (n) => n.endsWith(".json") });
    expect(r.total).toBe(2);
    expect(r.entries.map((e) => e.name)).toEqual(["keep.json"]);
    expect(r.skipped).toEqual([]);
  });

  it("skips one entry with its reason and keeps the rest", async () => {
    const zip = makeZip([
      { name: "ok.json", data: "ok" },
      { name: "enc.json", data: "x", encrypted: true },
      { name: "lzma.json", data: "x", method: 14 },
      { name: "crc.json", data: "x", crc: 0xdeadbeef },
      { name: "ok.json", data: "again" },
      { name: "lying.json", data: "abcdef", declaredSize: 3 },
      { name: "stored-lying.json", data: "abcdef", method: 0, declaredSize: 2 },
      { name: "../up.json", data: "x" },
      { name: "/abs.json", data: "x" },
      { name: "a/./b.json", data: "x" },
      { name: "nul\u0000.json", data: "x" },
      { name: "back\\slash.json", data: "fine" },
    ]);
    const r = await readZip(zip);
    expect(r.entries.map((e) => e.name)).toEqual(["ok.json", "back/slash.json"]);
    expect(r.skipped).toEqual([
      { name: "enc.json", reason: "encrypted" },
      { name: "lzma.json", reason: "unsupported compression" },
      { name: "crc.json", reason: "crc mismatch" },
      { name: "ok.json", reason: "duplicate name" },
      { name: "lying.json", reason: "corrupt entry" },
      { name: "stored-lying.json", reason: "corrupt entry" },
      { name: "../up.json", reason: "unsafe name" },
      { name: "/abs.json", reason: "unsafe name" },
      { name: "a/./b.json", reason: "unsafe name" },
      { name: "nul?.json", reason: "unsafe name" },
    ]);
    expect(r.total).toBe(12);
  });

  it("a deflate bomb costs its claimed size: one whose data is longer than that size can need is not started, one that fits is cut at the size", async () => {
    // 8 MB of zeros claimed to be 100 bytes: 8 KB of deflate data cannot be the stream of a 100-byte entry
    const bomb = makeZip([{ name: "bomb.json", data: new Uint8Array(8 * 1024 * 1024), declaredSize: 100 }, { name: "after.json", data: "still read" }]);
    expect(bomb.length).toBeLessThan(20_000);
    const r = await readZip(bomb);
    expect(r.skipped).toEqual([{ name: "bomb.json", reason: "corrupt entry" }]);
    expect(r.entries.map((e) => e.name)).toEqual(["after.json"]);
    // and it counted for nothing: it was refused before any work
    expect(r.spent).toBe("still read".length);
    // 1 MB of zeros is about 1 KB of deflate data, which a 4000-byte entry could need: it is started, and stopped at 4000
    const fits = makeZip([{ name: "bomb.json", data: new Uint8Array(1024 * 1024), declaredSize: 4000 }, { name: "after.json", data: "still read" }]);
    const f = await readZip(fits);
    expect(f.skipped).toEqual([{ name: "bomb.json", reason: "corrupt entry" }]);
    expect(f.entries.map((e) => e.name)).toEqual(["after.json"]);
    expect(f.spent).toBe(4000 + "still read".length);
    // declared honestly, it is not even started
    const honest = await readZip(makeZip([{ name: "big.json", data: new Uint8Array(DEFAULT_ZIP_LIMITS.maxEntryBytes + 1) }]));
    expect(honest.skipped).toEqual([{ name: "big.json", reason: "too large" }]);
    expect(honest.spent).toBe(0);
  });

  it("no entry is handed to the runtime's DecompressionStream, which inflates a whole write before its output can be counted (workerd)", async () => {
    // a stand-in for that behaviour: it counts what it is given and never gives anything back
    let made = 0;
    vi.stubGlobal(
      "DecompressionStream",
      class {
        constructor() {
          made++;
          throw new Error("the zip reader must not use DecompressionStream");
        }
      },
    );
    try {
      const zip = makeZip([
        { name: "a.json", data: '{"schema":"genclass-races/1"}' },
        { name: "zeros.json", data: new Uint8Array(100_000) },
        { name: "bomb.json", data: new Uint8Array(1024 * 1024), declaredSize: 4000 },
      ]);
      const r = await readZip(zip);
      expect(r.entries.map((e) => [e.name, e.bytes.length])).toEqual([
        ["a.json", 29],
        ["zeros.json", 100_000],
      ]);
      expect(made).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("inflateRaw gives what zlib's inflate gives, for stored, fixed and dynamic blocks at every level and strategy", () => {
    const rand = prng(7);
    const noise = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));
    const race = JSON.stringify({ schema: "genclass-races/1", test: "checkout.spec.ts > checkout > places one order", seed: 1, signatures: Array.from({ length: 40 }, (_, i) => ({ sig: `request|duplicate|POST /api/orders/${i}`, trigger: "request", diagnosis: "duplicate", op: `POST /api/orders/${i}`, confidence: 0.9, evidence: `1 identical POST /api/orders/${i} request in the last 10s`, seeds: [1, 2] })) }, null, 2);
    const far = new Uint8Array(70_000);
    // a 300-byte pattern repeated 32 KB apart: matches at the largest distances
    for (let i = 0; i < far.length; i++) far[i] = i % 32_700 < 300 ? (i * 7) & 0xff : Math.floor(rand() * 256);
    const inputs: [string, Uint8Array][] = [
      ["empty", new Uint8Array(0)],
      ["one byte", Uint8Array.of(0x61)],
      ["a race file", new TextEncoder().encode(race)],
      ["zeros", new Uint8Array(300_000)],
      ["every byte value", Uint8Array.from({ length: 4096 }, (_, i) => i & 0xff)],
      ["noise", noise(70_000)],
      ["far matches", far],
      ["text and noise", new Uint8Array([...new TextEncoder().encode(race.slice(0, 3000)), ...noise(3000), ...new TextEncoder().encode(race.slice(0, 3000))])],
    ];
    const strategies = [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED, constants.Z_HUFFMAN_ONLY, constants.Z_RLE, constants.Z_FIXED];
    let streams = 0;
    for (const [what, input] of inputs) {
      for (const strategy of strategies) {
        // memLevel 1 ends a block every 128 symbols: many blocks in one stream; windowBits 9 keeps distances short
        for (const o of [{ level: 0 }, { level: 1 }, { level: 6 }, { level: 9 }, { level: 6, memLevel: 1 }, { level: 9, memLevel: 9, windowBits: 9 }]) {
          const packed = deflateRawSync(input, { ...o, strategy });
          const got = inflateRaw(new Uint8Array(packed), input.length);
          expect(got !== null && Buffer.compare(got, input) === 0, `${what}, ${JSON.stringify({ ...o, strategy })}`).toBe(true);
          streams++;
        }
      }
    }
    expect(streams).toBe(inputs.length * strategies.length * 6);
    // bytes after the last block are not the entry's and are not read
    const packed = deflateRawSync(Buffer.from("hello hello hello"));
    expect(text(inflateRaw(new Uint8Array([...packed, 1, 2, 3]), 17)!)).toBe("hello hello hello");
  });

  it("inflateRaw gives null, never more than the size and never an exception, for a wrong size or a damaged stream", () => {
    const input = new TextEncoder().encode("the same words, the same words, the same words: over and over and over again");
    const packed = new Uint8Array(deflateRawSync(input));
    expect(inflateRaw(packed, input.length)).toEqual(input);
    // the size is a claim the stream must meet exactly
    for (const size of [0, 1, input.length - 1, input.length + 1, input.length * 2]) expect(inflateRaw(packed, size), `size ${size}`).toBeNull();
    // cut anywhere, it is not a whole stream
    for (let cut = 0; cut < packed.length; cut++) expect(inflateRaw(packed.subarray(0, cut), input.length), `cut at ${cut}`).toBeNull();
    // the reserved block type; a stored block whose length and complement disagree; a stored block longer than the data
    expect(inflateRaw(pack(lastBlock(3)), 0)).toBeNull();
    expect(inflateRaw(Uint8Array.of(0x01, 0x05, 0x00, 0x00, 0x00, 1, 2, 3, 4, 5), 5)).toBeNull();
    expect(inflateRaw(Uint8Array.of(0x01, 0x05, 0x00, 0xfa, 0xff, 1, 2), 5)).toBeNull();
    expect(inflateRaw(Uint8Array.of(0x01, 0x05, 0x00, 0xfa, 0xff, 1, 2, 3, 4, 5), 5)).toEqual(Uint8Array.of(1, 2, 3, 4, 5));
    // blocks written bit by bit, fixed codes: "a" and the end code; "a" and a copy of 3 from 1 behind, which overlaps
    const end = code(0, 7);
    const copy3from1 = [...code(1, 7), ...code(0, 5)];
    expect(text(inflateRaw(pack([...lastBlock(1), ...literal(0x61), ...end]), 1)!)).toBe("a");
    expect(text(inflateRaw(pack([...lastBlock(1), ...literal(0x61), ...copy3from1, ...end]), 4)!)).toBe("aaaa");
    // the same copy as the first thing in the output reaches before its start; with room for 3 bytes it would write 4
    expect(inflateRaw(pack([...lastBlock(1), ...copy3from1, ...end]), 3)).toBeNull();
    expect(inflateRaw(pack([...lastBlock(1), ...literal(0x61), ...copy3from1, ...end]), 3)).toBeNull();
    // no end code; a length code that does not exist (286); a distance code that does not exist (30)
    expect(inflateRaw(pack([...lastBlock(1), ...literal(0x61)]), 1)).toBeNull();
    expect(inflateRaw(pack([...lastBlock(1), ...literal(0x61), ...code(0xc0 + 6, 8), ...code(0, 5), ...end]), 300)).toBeNull();
    expect(inflateRaw(pack([...lastBlock(1), ...literal(0x61), ...code(1, 7), ...code(30, 5), ...end, ...end]), 4)).toBeNull();
    // a dynamic block whose code lengths are no prefix code: 19 codes of one bit each
    const header = [...lastBlock(2), ...field(0, 5), ...field(0, 5), ...field(15, 4)];
    expect(inflateRaw(pack([...header, ...Array.from({ length: 19 }, () => field(1, 3)).flat(), ...end, ...end]), 0)).toBeNull();
    // whatever bits are flipped: null, or exactly `size` bytes
    const rand = prng(20261110);
    for (let round = 0; round < 3000; round++) {
      const c = packed.slice();
      const flips = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < flips; i++) c[Math.floor(rand() * c.length)]! ^= 1 << Math.floor(rand() * 8);
      const got = inflateRaw(c, input.length);
      if (got !== null) expect(got.length, `round ${round}`).toBe(input.length);
    }
    // random bytes as a stream: the same
    for (let round = 0; round < 3000; round++) {
      const junk = Uint8Array.from({ length: 1 + Math.floor(rand() * 60) }, () => Math.floor(rand() * 256));
      const size = Math.floor(rand() * 200);
      const got = inflateRaw(junk, size);
      if (got !== null) expect(got.length, `junk round ${round}`).toBe(size);
    }
  });

  it("many records that point at one entry's data read it once", async () => {
    const zip = makeZip([{ name: "one.json", data: "x".repeat(5000) }, ...Array.from({ length: 300 }, (_, i) => ({ name: `again-${i}.json`, data: "", sameDataAs: 0 }))]);
    // 301 records, the data of one
    expect(zip.length).toBeLessThan(25_000);
    const r = await readZip(zip);
    expect(r.total).toBe(301);
    expect(r.entries.map((e) => e.name)).toEqual(["one.json"]);
    expect(r.spent).toBe(5000);
    expect(r.skipped).toHaveLength(MAX_SKIPPED);
    expect(r.skipped.every((s) => s.reason === "corrupt entry")).toBe(true);
  });

  it("an entry that is read and turns out bad counts against the limits like a good one", async () => {
    const bad = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.json`, data: "x".repeat(100), crc: 1 }));
    const few = await readZip(makeZip(bad), { limits: { maxEntries: 3 } });
    expect(few.entries).toEqual([]);
    expect(few.skipped.map((s) => s.reason)).toEqual([...Array(3).fill("crc mismatch"), ...Array(7).fill("too many files")]);
    expect(few.spent).toBe(300);
    const bytes = await readZip(makeZip(bad), { limits: { maxTotalBytes: 250 } });
    expect(bytes.skipped.map((s) => s.reason)).toEqual([...Array(2).fill("crc mismatch"), ...Array(8).fill("archive too large")]);
    expect(bytes.spent).toBe(200);
    // a wrong size is the same: each claim of 90 bytes for 100 is started, fails, and is counted
    const lying = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.json`, data: `${i}`.repeat(100), declaredSize: 90 }));
    const sized = await readZip(makeZip(lying), { limits: { maxEntries: 4 } });
    expect(sized.skipped.map((s) => s.reason)).toEqual([...Array(4).fill("corrupt entry"), ...Array(6).fill("too many files")]);
    expect(sized.spent).toBe(360);
    // what costs nothing is not counted: an encrypted entry, a name outside the filter
    const free = await readZip(makeZip([{ name: "enc.json", data: "x", encrypted: true }, { name: "skip.txt", data: "x" }, { name: "ok.json", data: "ok" }]), { filter: (n) => n.endsWith(".json"), limits: { maxEntries: 1 } });
    expect(free.entries.map((e) => e.name)).toEqual(["ok.json"]);
    expect(free.spent).toBe(2);
  });

  it("the limits: entries, bytes per entry, bytes in total; the list of skipped entries is capped too", async () => {
    const files = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.json`, data: "x".repeat(100) }));
    const few = await readZip(makeZip(files), { limits: { maxEntries: 3 } });
    expect(few.entries).toHaveLength(3);
    expect(few.skipped).toHaveLength(7);
    expect(few.skipped[0]).toEqual({ name: "f3.json", reason: "too many files" });
    const small = await readZip(makeZip(files), { limits: { maxEntryBytes: 99 } });
    expect(small.entries).toHaveLength(0);
    expect(small.skipped.every((s) => s.reason === "too large")).toBe(true);
    const total = await readZip(makeZip(files), { limits: { maxTotalBytes: 250 } });
    expect(total.entries).toHaveLength(2);
    expect(total.skipped[0]).toEqual({ name: "f2.json", reason: "archive too large" });
    const many = await readZip(makeZip(Array.from({ length: MAX_SKIPPED + 50 }, (_, i) => ({ name: `e${i}.json`, data: "x", encrypted: true }))));
    expect(many.total).toBe(MAX_SKIPPED + 50);
    expect(many.skipped).toHaveLength(MAX_SKIPPED);
  });

  it("refuses, with ZipError, what is not an archive it reads: empty, random, truncated, zip64, in parts, a directory outside the data", async () => {
    await expect(readZip(new Uint8Array(0))).rejects.toThrow(ZipError);
    await expect(readZip(new TextEncoder().encode("this is not a zip archive at all, not even close"))).rejects.toThrow("not a zip archive");
    await expect(readZip("zip" as never)).rejects.toThrow(ZipError);
    const good = makeZip([{ name: "a.json", data: "a".repeat(200) }, { name: "b.json", data: "b" }]);
    const end = good.length - 22;
    const patch = (at: number, bytes: number[]) => {
      const c = good.slice();
      c.set(bytes, at);
      return c;
    };
    // the directory's offset points past the end record
    await expect(readZip(patch(end + 16, [0xf0, 0xff, 0xff, 0x7f]))).rejects.toThrow("corrupt archive");
    // zip64 markers
    await expect(readZip(patch(end + 16, [0xff, 0xff, 0xff, 0xff]))).rejects.toThrow("zip64 archives are not supported");
    await expect(readZip(patch(end + 10, [0xff, 0xff]))).rejects.toThrow("zip64 archives are not supported");
    // another disk
    await expect(readZip(patch(end + 4, [1, 0]))).rejects.toThrow("more than one part");
    // more entries claimed than the directory holds
    await expect(readZip(patch(end + 8, [9, 0, 9, 0]))).rejects.toThrow("corrupt archive");
    // a local header that is not one: that entry is skipped, the other is read
    const first = await readZip(patch(0, [0, 0, 0, 0]));
    expect(first.skipped).toEqual([{ name: "a.json", reason: "corrupt entry" }]);
    expect(first.entries.map((e) => e.name)).toEqual(["b.json"]);
    // cut anywhere, it resolves or is refused with ZipError, nothing else
    for (let cut = 0; cut < good.length; cut += 7) {
      try {
        await readZip(good.subarray(0, cut));
      } catch (e) {
        expect(e, `cut at ${cut}`).toBeInstanceOf(ZipError);
      }
    }
  });

  it("random damage: whatever bytes are flipped, readZip resolves or rejects with ZipError", async () => {
    const good = makeZip([
      { name: "a.json", data: JSON.stringify({ schema: "genclass-races/1", test: "t", seed: 1, signatures: [] }) },
      { name: "b.json", data: "b".repeat(3000) },
      { name: "c.json", data: "c", method: 0 },
    ]);
    const rand = prng(20261109);
    for (let round = 0; round < 400; round++) {
      const c = good.slice();
      const flips = 1 + Math.floor(rand() * 6);
      for (let i = 0; i < flips; i++) c[Math.floor(rand() * c.length)] = Math.floor(rand() * 256);
      try {
        const r = await readZip(c);
        for (const e of r.entries) expect(e.bytes.length).toBeLessThanOrEqual(DEFAULT_ZIP_LIMITS.maxEntryBytes);
      } catch (e) {
        expect(e, `round ${round}`).toBeInstanceOf(ZipError);
      }
    }
  });
});
