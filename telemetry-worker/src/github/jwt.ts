// The JSON Web Token a GitHub App authenticates with (RS256, signed with the app's private key), WebCrypto only.
//
// Invariants:
// - A token lives 9 minutes (GitHub's limit is 10) and is issued 60 s in the past, so a clock that runs a little
//   ahead of GitHub's does not make it "not yet valid". It is only ever sent to the configured GitHub API root.
// - GitHub generates PKCS#1 keys ("BEGIN RSA PRIVATE KEY"); WebCrypto imports PKCS#8 only, so a PKCS#1 key is wrapped
//   in the PKCS#8 structure here (no conversion step for whoever sets the secret). A PKCS#8 key is used as it is.
// - The imported key is not extractable and is cached per isolate by a hash of the PEM; signed tokens are cached for
//   REUSE_MS so a burst of webhooks signs once.
// - A key that cannot be read throws AppKeyError with a message that never contains key material.

import { b64url } from "../webauthn.js";

/** The private key in GITHUB_APP_PRIVATE_KEY cannot be used. The message is safe to log. */
export class AppKeyError extends Error {}

export const JWT_LIFETIME_S = 9 * 60;
export const JWT_BACKDATE_S = 60;
/** A signed token is reused while it has at least this long left. */
const REUSE_MARGIN_S = 3 * 60;

/** DER length octets. */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return [0x80 | out.length, ...out];
}

function der(tag: number, content: Uint8Array | number[]): Uint8Array {
  const body = content instanceof Uint8Array ? content : Uint8Array.from(content);
  const head = [tag, ...derLength(body.length)];
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** rsaEncryption (1.2.840.113549.1.1.1) with NULL parameters, as an AlgorithmIdentifier. */
const RSA_ALGORITHM = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);

/** A PKCS#1 RSAPrivateKey wrapped as a PKCS#8 PrivateKeyInfo. Exported for tests. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  return der(0x30, concat([Uint8Array.from([0x02, 0x01, 0x00]), RSA_ALGORITHM, der(0x04, pkcs1)]));
}

/** The DER bytes and the kind of a PEM private key. Exported for tests. */
export function parsePem(pem: string): { kind: "pkcs1" | "pkcs8"; der: Uint8Array } {
  // a secret pasted on one line carries its newlines written out
  const text = pem.replace(/\\n/g, "\n").replace(/\r/g, "");
  const m = /-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----([A-Za-z0-9+/=\s]+)-----END \1-----/.exec(text);
  if (!m) {
    if (/BEGIN ENCRYPTED PRIVATE KEY|Proc-Type: 4,ENCRYPTED/.test(text)) throw new AppKeyError("the app's private key is encrypted with a passphrase; store the key GitHub generated, as it is");
    throw new AppKeyError("the app's private key is not a PEM private key (it starts with -----BEGIN RSA PRIVATE KEY-----)");
  }
  let bin: string;
  try {
    bin = atob(m[2]!.replace(/\s+/g, ""));
  } catch {
    throw new AppKeyError("the app's private key is not valid base64 inside its PEM lines");
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length < 600) throw new AppKeyError("the app's private key is too short to be a 2048-bit RSA key");
  return { kind: m[1] === "RSA PRIVATE KEY" ? "pkcs1" : "pkcs8", der: bytes };
}

const keys = new Map<string, Promise<CryptoKey>>();
const tokens = new Map<string, { jwt: string; exp: number }>();

/** Drops the cached keys and tokens (tests). */
export function resetJwtCache(): void {
  keys.clear();
  tokens.clear();
}

async function digestHex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signingKey(pem: string): Promise<CryptoKey> {
  const id = await digestHex(pem);
  let k = keys.get(id);
  if (!k) {
    const parsed = parsePem(pem);
    const pkcs8 = parsed.kind === "pkcs1" ? pkcs1ToPkcs8(parsed.der) : parsed.der;
    k = crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]).catch(() => {
      keys.delete(id);
      throw new AppKeyError("the app's private key could not be imported (is it the RSA key GitHub generated for this app?)");
    });
    if (keys.size > 8) keys.clear();
    keys.set(id, k);
  }
  return k;
}

const part = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)));

/**
 * A JWT that authenticates as the app (not as an installation): `iss` is the app's id, issued JWT_BACKDATE_S ago,
 * valid JWT_LIFETIME_S from now. Reused from the cache while it has REUSE_MARGIN_S left.
 */
export async function appJwt(app: { appId: string; privateKey: string }, now: Date): Promise<string> {
  const nowS = Math.floor(now.getTime() / 1000);
  const id = `${app.appId}:${await digestHex(app.privateKey)}`;
  const hit = tokens.get(id);
  if (hit && hit.exp - nowS >= REUSE_MARGIN_S && hit.exp - nowS <= JWT_LIFETIME_S) return hit.jwt;
  const key = await signingKey(app.privateKey);
  const exp = nowS + JWT_LIFETIME_S;
  const head = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: nowS - JWT_BACKDATE_S, exp, iss: app.appId })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head));
  const jwt = `${head}.${b64url(sig)}`;
  if (tokens.size > 8) tokens.clear();
  tokens.set(id, { jwt, exp });
  return jwt;
}
