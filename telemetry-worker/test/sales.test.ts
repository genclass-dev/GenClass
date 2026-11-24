// POST /api/sales (src/sales.ts): genclass.dev's Contact sales form. What a request keeps (R2, never under events/),
// who is told (a notice with ids only, an email with the request to plans.json `contact`), and what is refused.
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/collector.js";
import type { EmailMessage } from "../src/report.js";
import { call, resetClock, setup } from "./account-helpers.js";

function world(over: Partial<Env> = {}) {
  const sent: EmailMessage[] = [];
  const hooks: Record<string, unknown>[] = [];
  const w = setup({ EMAIL: { async send(m: EmailMessage) { sent.push(m); return { messageId: `m${sent.length}` }; } }, NOTIFY_WEBHOOK: "https://hooks.example/notify", ...over });
  const fetch = async (_u: string, init?: RequestInit) => {
    hooks.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response("ok");
  };
  const keys = () => [...w.r2.objects.keys()];
  const kept = (k: string) => JSON.parse(new TextDecoder().decode(w.r2.objects.get(k)!)) as Record<string, unknown>;
  return { ...w, sent, hooks, fetch, keys, kept };
}

const REQUEST = { name: "Ada Lovelace", email: "Ada@Example.com", company: "Analytical Engines", size: "51-200", need: "Self-hosting and 40 apps.", plan: "enterprise", website: "" };

describe("POST /api/sales: the site's Contact sales form", () => {
  beforeEach(() => resetClock());

  it("keeps the request in R2 under sales/, emails it to the owner with a reply-to, and sends a notice with ids only", async () => {
    const w = world();
    const r = await call(w.env, "POST", "/api/sales", { body: REQUEST, fetch: w.fetch });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; id: string };
    expect(j.ok).toBe(true);
    const keys = w.keys().filter((k) => k.startsWith("sales/"));
    expect(keys).toHaveLength(1);
    expect(w.keys().some((k) => k.startsWith("events/"))).toBe(false);
    expect(w.kept(keys[0]!)).toMatchObject({ id: j.id, name: "Ada Lovelace", email: "ada@example.com", company: "Analytical Engines", size: "51-200", plan: "enterprise", need: "Self-hosting and 40 apps." });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ to: "mehar@genclass.dev", from: { email: "report@genclass.dev", name: "GenClass" }, replyTo: "ada@example.com", subject: "Sales request: Analytical Engines (51-200 people)" });
    expect(w.sent[0]!.text).toContain("Email: ada@example.com");
    expect(w.sent[0]!.text).toContain("What they need:\nSelf-hosting and 40 apps.");
    // the chat notice names the request and the team size, never the person
    expect(w.hooks).toHaveLength(1);
    const notice = JSON.stringify(w.hooks[0]);
    expect(notice).toContain(j.id);
    expect(notice).toContain("team of 51-200");
    expect(notice).not.toContain("ada@example.com");
    expect(notice).not.toContain("Ada Lovelace");
  });

  it("a form posted without script goes on to /thanks; the html email escapes what was typed", async () => {
    const w = world();
    const body = new URLSearchParams({ ...REQUEST, company: "<b>Acme</b>" }).toString();
    const r = await call(w.env, "POST", "/api/sales", { body, headers: { "content-type": "application/x-www-form-urlencoded" }, fetch: w.fetch });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("https://genclass.dev/thanks");
    expect(w.sent[0]!.html).toContain("&#60;b&#62;Acme&#60;/b&#62;");
    expect(w.sent[0]!.html).not.toContain("<b>Acme</b>");
  });

  it("refuses a bad email, a missing name or company, another site's origin, a large body and GET; a filled honeypot is a quiet success", async () => {
    const w = world();
    const bad = async (body: unknown, o: { origin?: string | null } = {}) => {
      const r = await call(w.env, "POST", "/api/sales", { body, fetch: w.fetch, ...o });
      return [r.status, ((await r.json()) as { error?: string }).error] as const;
    };
    expect(await bad({ ...REQUEST, email: "not-an-email" })).toEqual([400, "Please enter a valid work email."]);
    expect(await bad({ ...REQUEST, name: " " })).toEqual([400, "Please enter your name."]);
    expect(await bad({ ...REQUEST, company: "" })).toEqual([400, "Please enter your company."]);
    expect(await bad(REQUEST, { origin: "https://evil.example" })).toEqual([403, "This form posts from genclass.dev only."]);
    expect((await bad({ ...REQUEST, need: "x".repeat(9000) }))[0]).toBe(413);
    expect((await call(w.env, "GET", "/api/sales")).status).toBe(405);
    const hp = await call(w.env, "POST", "/api/sales", { body: { ...REQUEST, website: "https://spam.example" }, fetch: w.fetch });
    expect(hp.status).toBe(200);
    expect(w.keys().filter((k) => k.startsWith("sales/"))).toEqual([]);
    expect(w.sent).toEqual([]);
    expect(w.hooks).toEqual([]);
  });

  it("an unknown team size or plan is kept as none and enterprise; without EMAIL or a webhook the request is still kept", async () => {
    const w = world({ EMAIL: undefined, NOTIFY_WEBHOOK: undefined });
    const r = await call(w.env, "POST", "/api/sales", { body: { ...REQUEST, size: "lots", plan: "platinum" }, fetch: w.fetch });
    expect(r.status).toBe(200);
    const key = w.keys().find((k) => k.startsWith("sales/"))!;
    expect(w.kept(key)).toMatchObject({ size: null, plan: "enterprise" });
    expect(w.hooks).toEqual([]);
  });
});
