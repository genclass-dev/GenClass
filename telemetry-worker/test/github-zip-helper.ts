// Test only: builds a zip archive by hand (local headers, central directory, end record), as GitHub's artifact
// download returns one, with overrides to build hostile archives.
import { deflateRawSync } from "node:zlib";
import { crc32 } from "../src/github/zip.js";

export interface ZipFileSpec {
  name: string;
  data: string | Uint8Array;
  /** 8 (deflate, default) or 0 (stored). */
  method?: 0 | 8 | number;
  /** Overrides written into the headers, to build hostile archives. */
  crc?: number;
  declaredSize?: number;
  encrypted?: boolean;
  /**
   * Hostile: no data of its own. Its directory record points at the local header and data of the file at this index
   * of the list (an earlier one), with that file's method, sizes and CRC; `data` is ignored.
   */
  sameDataAs?: number;
  /** zlib's compression level for a deflated file (default: zlib's own). */
  level?: number;
}

/** A zip archive with these files. With no overrides it opens with any unzip tool. */
export function makeZip(files: ZipFileSpec[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  const written: { at: number; method: number; crc: number; comp: number; size: number }[] = [];
  let offset = 0;
  for (const f of files) {
    const shared = f.sameDataAs === undefined ? null : written[f.sameDataAs]!;
    const raw = typeof f.data === "string" ? Buffer.from(f.data, "utf8") : Buffer.from(f.data);
    const method = shared ? shared.method : (f.method ?? 8);
    const body = method === 8 ? deflateRawSync(raw, f.level === undefined ? {} : { level: f.level }) : raw;
    const name = Buffer.from(f.name, "utf8");
    const crc = f.crc ?? (shared ? shared.crc : crc32(raw));
    const size = f.declaredSize ?? (shared ? shared.size : raw.length);
    const comp = shared ? shared.comp : body.length;
    const flags = (f.encrypted ? 1 : 0) | 0x0800; // bit 11: the name is UTF-8
    const at = shared ? shared.at : offset;
    written.push({ at, method, crc, comp, size });
    if (!shared) {
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(name.length, 26);
      parts.push(local, name, body);
    }
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(flags, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(comp, 20);
    dir.writeUInt32LE(size, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(at, 42);
    central.push(dir, name);
    if (!shared) offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, end]));
}
