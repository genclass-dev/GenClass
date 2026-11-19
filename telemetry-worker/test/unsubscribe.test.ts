// The unsubscribe page for email written by hand (src/unsubscribe.ts, migration 0024): the form, what a post saves,
// the same answer twice, the notice (never to the typed address, capped a day), the limiter, and that nothing else
// about an account changes.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/collector.js";
import type { EmailMessage } from "../src/report.js";
import { NOTIFY_DAILY_CAP } from "../src/unsubscribe.js";
import { call, resetClock, setup, signedIn } from "./account-helpers.js";

function world(over: Partial<Env> = {}) {
  const sent: EmailMessage[] = [];
  const w = setup({ EMAIL: { async send(m: EmailMessage) { sent.push(m); return { messageId: `m${sent.length}` }; } }, UNSUBSCRIBE_NOTIFY: "sarah@genclass.dev", ...over });
  return { ...w, sent };
}

const FORM = { "content-type": "application/x-www-form-urlencoded" };
const post = (env: Env, email: string, headers: Record<string, string> = FORM) => call(env, "POST", "/unsubscribe", { body: `email=${encodeURIComponent(email)}`, headers, origin: null });
const rows = (w: ReturnType<typeof world>) => w.sql.rows("SELECT email, created FROM unsubscribes ORDER BY email");

describe("the unsubscribe page (/unsubscribe)", () => {
  beforeEach(() => {
    resetClock();
  });

  it("GET shows a form that posts an email address back to the page, and is not indexed", async () => {
    const w = world();
    const r = await call(w.env, "GET", "/unsubscribe", { origin: null });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("content-security-policy")).toContain("form-action 'self'");
    const html = await r.text();
    expect(html).toContain('<form class="pwf un" method="post" action="/unsubscribe">');
    expect(html).toContain('name="email" type="email"');
    expect(html).toContain("<h1>Unsubscribe</h1>");
    expect(rows(w)).toEqual([]);
  });

  it("a post saves the address in lower case and says so; a second post answers the same and adds nothing", async () => {
    const w = world();
    const first = await post(w.env, "  Ada@Example.COM ");
    expect(first.status).toBe(200);
    const html = await first.text();
    expect(html).toContain("You are unsubscribed");
    expect(html).toContain("ada@example.com");
    expect(rows(w)).toEqual([{ email: "ada@example.com", created: "2026-10-13T12:00:00.000Z" }]);
    const again = await post(w.env, "ada@example.com");
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("You are unsubscribed");
    expect(rows(w)).toHaveLength(1);
  });

  it("the answer for a known address is the page a new one gets (apart from the nonce)", async () => {
    const w = world();
    const strip = (s: string) => s.replace(/nonce="[^"]*"/g, 'nonce=""');
    const a = strip(await (await post(w.env, "ada@example.com")).text());
    const b = strip(await (await post(w.env, "ada@example.com")).text());
    expect(b).toBe(a);
  });

  it("something that is not an email address saves nothing and shows the form again with what was typed, escaped", async () => {
    const w = world();
    for (const bad of ["", "not an address", "a@b", '"><script>alert(1)</script>@x.io']) {
      const r = await post(w.env, bad);
      expect(r.status).toBe(400);
      const html = await r.text();
      expect(html).toContain("That does not look like an email address.");
      expect(html).not.toContain("<script>alert(1)</script>");
    }
    expect(rows(w)).toEqual([]);
    expect(w.sent).toEqual([]);
  });

  it("a new address sends one notice to UNSUBSCRIBE_NOTIFY and nothing to the typed address; a repeat sends none", async () => {
    const w = world();
    await post(w.env, "ada@example.com");
    await post(w.env, "ada@example.com");
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.to).toBe("sarah@genclass.dev");
    expect(w.sent[0]!.from.email).toBe("report@genclass.dev");
    expect(w.sent[0]!.subject).toBe("Unsubscribe: ada@example.com");
    expect(w.sent[0]!.text).toContain("ada@example.com asked for no more email from GenClass");
    expect(w.sent.some((m) => m.to === "ada@example.com")).toBe(false);
  });

  it("no notice without UNSUBSCRIBE_NOTIFY or without the EMAIL binding, and the row is saved all the same", async () => {
    const a = world({ UNSUBSCRIBE_NOTIFY: undefined });
    expect((await post(a.env, "ada@example.com")).status).toBe(200);
    expect(a.sent).toEqual([]);
    expect(rows(a)).toHaveLength(1);
    const b = world({ EMAIL: undefined });
    expect((await post(b.env, "ada@example.com")).status).toBe(200);
    expect(rows(b)).toHaveLength(1);
  });

  it("a notice that fails to send does not fail the request", async () => {
    const w = world({ EMAIL: { async send() { throw Object.assign(new Error("refused"), { code: "E_REFUSED" }); } } });
    expect((await post(w.env, "ada@example.com")).status).toBe(200);
    expect(rows(w)).toHaveLength(1);
  });

  it(`at most ${NOTIFY_DAILY_CAP} notices a day; later addresses are still saved`, async () => {
    const w = world();
    for (let i = 0; i < NOTIFY_DAILY_CAP + 3; i++) expect((await post(w.env, `p${i}@example.com`)).status).toBe(200);
    expect(w.sent).toHaveLength(NOTIFY_DAILY_CAP);
    expect(rows(w)).toHaveLength(NOTIFY_DAILY_CAP + 3);
  });

  it("over the network's budget: 429 with Retry-After, nothing saved", async () => {
    const w = world({ AUTH_LIMIT: { limit: async () => ({ success: false }) } });
    const r = await post(w.env, "ada@example.com");
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(rows(w)).toEqual([]);
  });

  it("JSON in, JSON out", async () => {
    const w = world();
    const ok = await call(w.env, "POST", "/unsubscribe", { body: { email: "Ada@example.com" }, origin: null });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(rows(w).map((r) => r.email)).toEqual(["ada@example.com"]);
    const bad = await call(w.env, "POST", "/unsubscribe", { body: { email: 7 }, origin: null });
    expect(bad.status).toBe(400);
  });

  it("an account with that address keeps its report settings and its sign-in", async () => {
    const w = world();
    const s = await signedIn(w.env, "ada@example.com");
    const before = w.sql.rows("SELECT * FROM accounts");
    expect((await post(w.env, "ada@example.com")).status).toBe(200);
    expect(w.sql.rows("SELECT * FROM accounts")).toEqual(before);
    expect((await call(w.env, "GET", "/api/me", { cookie: s.cookie })).status).toBe(200);
  });

  it("without the table (migration 0024 not applied) the page says it did not save and whom to write to", async () => {
    const w = world();
    w.sql.db.exec("DROP TABLE unsubscribes");
    const r = await post(w.env, "ada@example.com");
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("mailto:mehar@genclass.dev?subject=Unsubscribe");
    expect(w.sent).toEqual([]);
  });

  it("other methods are refused, and other paths are not this route's", async () => {
    const w = world();
    expect((await call(w.env, "DELETE", "/unsubscribe", { origin: null })).status).toBe(405);
    expect((await call(w.env, "GET", "/unsubscribe/x", { origin: null })).status).toBe(404);
  });

  it("production routes genclass.dev/unsubscribe to the collector", () => {
    expect(readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8")).toMatch(/^\s*\{ pattern = "genclass\.dev\/unsubscribe\*", zone_name = "genclass\.dev" \},$/m);
  });
});
