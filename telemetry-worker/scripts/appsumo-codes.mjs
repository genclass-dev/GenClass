#!/usr/bin/env node
// The codes CSV AppSumo takes for a codes deal (src/appsumo.ts): one code per line, no header, signed with the same
// secret the collector checks (the Worker secret APPSUMO_CODE_SECRET). AppSumo takes 1,000 to 10,000 per file.
//
//   APPSUMO_CODE_SECRET=... node telemetry-worker/scripts/appsumo-codes.mjs 10000 > appsumo-codes.csv
//
// The secret is read from the environment only, never from an argument (it would land in the shell's history).

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function b32(bytes, chars) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.slice(0, chars);
}

/** The same code as src/appsumo.ts makeCode: GC-<12 random base32>-<8 base32 of HMAC-SHA256>. */
export async function makeCode(secret) {
  const part = b32(crypto.getRandomValues(new Uint8Array(8)), 12);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`genclass-appsumo-v1:${part}`)));
  return `GC-${part}-${b32(mac.slice(0, 5), 8)}`;
}

/** `n` distinct codes. */
export async function makeCodes(secret, n) {
  const seen = new Set();
  while (seen.size < n) seen.add(await makeCode(secret));
  return [...seen];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const secret = process.env.APPSUMO_CODE_SECRET;
  const n = Number(process.argv[2] ?? 1000);
  if (!secret || secret.length < 32) {
    console.error("set APPSUMO_CODE_SECRET (32 characters or more) in the environment");
    process.exit(2);
  }
  if (!Number.isInteger(n) || n < 1 || n > 10000) {
    console.error("the count is 1 to 10000 (AppSumo takes 1,000 to 10,000 per file)");
    process.exit(2);
  }
  process.stdout.write((await makeCodes(secret, n)).join("\n") + "\n");
}
