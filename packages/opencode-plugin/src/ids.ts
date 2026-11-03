// V1 part ids for the parts this plugin adds to a user message. OpenCode 1.x stores every part with an id that starts
// with `prt` (packages/opencode/src/session/schema.ts, PartID) and orders a message's parts by it; parts a
// `chat.message` hook pushes get none from OpenCode, so the plugin makes one in OpenCode's own ascending format.
// Its own module so that src/index.ts keeps a single (default) runtime export.

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * A V1 part id after every part created so far in this millisecond: OpenCode's own ascending format
 * (packages/opencode/src/id/id.ts: `prt_`, 6 bytes of `ms * 0x1000 + counter`, 14 base62 characters) with the
 * counter at its largest, so the digest sorts after the user's parts.
 */
export function v1PartId(now: number = Date.now(), random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const v = BigInt(now) * 0x1000n + 0xfffn;
  let hex = "";
  for (let i = 0; i < 6; i++) hex += Number((v >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0");
  const bytes = random(14);
  let tail = "";
  for (let i = 0; i < 14; i++) tail += BASE62[bytes[i]! % 62];
  return `prt_${hex}${tail}`;
}

