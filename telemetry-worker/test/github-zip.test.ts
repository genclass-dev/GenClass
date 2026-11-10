// The zip reader behind the GitHub App's artifact download (src/github/zip.ts): what it reads, what it skips and why,
// and that a hostile archive costs a bounded amount and can only ever be refused with ZipError.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crc32, DEFAULT_ZIP_LIMITS, MAX_SKIPPED, readZip, ZipError } from "../src/github/zip.js";
import { makeZip } from "./github-zip-helper.js";

const text = (b: Uint8Array) => new TextDecoder().decode(b);

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

  it("a deflate bomb costs one entry's cap: 8 MB of zeros declared as 100 bytes is dropped while it inflates", async () => {
    const bomb = makeZip([{ name: "bomb.json", data: new Uint8Array(8 * 1024 * 1024), declaredSize: 100 }, { name: "after.json", data: "still read" }]);
    expect(bomb.length).toBeLessThan(20_000);
    const t0 = performance.now();
    const r = await readZip(bomb);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(r.skipped).toEqual([{ name: "bomb.json", reason: "too large" }]);
    expect(r.entries.map((e) => e.name)).toEqual(["after.json"]);
    // declared honestly, it is not even started
    const honest = await readZip(makeZip([{ name: "big.json", data: new Uint8Array(DEFAULT_ZIP_LIMITS.maxEntryBytes + 1) }]));
    expect(honest.skipped).toEqual([{ name: "big.json", reason: "too large" }]);
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
