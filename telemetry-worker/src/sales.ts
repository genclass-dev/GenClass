// POST /api/sales: genclass.dev's Contact sales form (the dialog every site page carries and the form on /enterprise,
// site/public/app.js; the owner, 2026-11-24: "they contact sales and a form for submission shows up"). genclass.dev/api/*
// is routed to this worker, so the site's form lands here.
// Invariants:
// - A request is kept whole in R2 (BUCKET, key sales/<iso>-<id>.json; never under events/, which ingest and the site's
//   admin read) and told to the owner twice: a notice with the id and the team size only (NOTIFY_WEBHOOK, as every
//   other notice: no names or emails in a chat), and an email with the request to plans.json `contact`, from
//   report@genclass.dev (the only sender the EMAIL binding allows), its reply-to the person who asked.
// - Only genclass.dev (or this worker's own origin, for development) may post; 20 a minute per client (AUTH_LIMIT,
//   keyed by a hash of the IP, which is never stored); bodies over 8 KB are refused; a filled honeypot (`website`) is
//   answered as a success and kept nowhere.
// - Never throws: every failure is a JSON answer (or plain text for a form posted without script).

import type { Env, HandleOptions } from "./collector.js";
import { randomBase62, sha256Hex } from "./dashboard.js";
import { esc } from "./escape.js";
import { json } from "./http.js";
import { PLANS_FILE } from "./plans.js";
import { notifyOwner } from "./stripe.js";

/** The team sizes the form offers (site/build.py sales_fields). */
export const SALES_SIZES: readonly string[] = ["1-10", "11-50", "51-200", "201-1000", "1000+"];
/** The plans a request can name; anything else is kept as enterprise. */
const SALES_PLANS = new Set(["enterprise", "business", "pro"]);
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const SITE = "https://genclass.dev";
const FROM = { email: "report@genclass.dev", name: "GenClass" };
const MAX_BYTES = 8192;

const clip = (v: unknown, n: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n) : "");

/** One request, as kept in R2 and emailed. */
export interface SalesRequest {
  id: string;
  at: string;
  name: string;
  email: string;
  company: string;
  size: string | null;
  plan: string;
  need: string;
  page: string | null;
}

/** The email the owner gets for a request: plain text, the fields one per line. */
export function salesEmail(r: SalesRequest): { subject: string; text: string; html: string } {
  const text = salesText(r);
  return { subject: `Sales request: ${r.company} (${r.size ? `${r.size} people` : "size not given"})`, text, html: `<div style="font:15px/1.55 -apple-system,Segoe UI,sans-serif;white-space:pre-wrap">${esc(text)}</div>` };
}

function salesText(r: SalesRequest): string {
  return (
    [
      `A sales request from genclass.dev${r.page ? ` (${r.page})` : ""}.`,
      "",
      `Name: ${r.name}`,
      `Email: ${r.email}`,
      `Company: ${r.company}`,
      `Team size: ${r.size ?? "not given"}`,
      `Plan: ${r.plan}`,
      "",
      r.need ? `What they need:\n${r.need}` : "What they need: not given",
      "",
      `Request ${r.id}, ${r.at}. Reply to this email to write to them.`,
    ].join("\n")
  );
}

/** POST /api/sales, or null for any other path. */
export async function routeSales(request: Request, path: string, env: Env, opts: HandleOptions): Promise<Response | null> {
  if (path !== "/api/sales") return null;
  const isForm = !(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json");
  const reply = (status: number, body: { ok: boolean; error?: string; id?: string }): Response =>
    isForm
      ? status < 300
        ? new Response(null, { status: 303, headers: { location: `${SITE}/thanks`, "cache-control": "no-store" } })
        : new Response(body.error ?? "Something went wrong.", { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } })
      : json(status, body, { "cache-control": "no-store", "x-robots-tag": "noindex" });
  if (request.method !== "POST") return json(405, { ok: false, error: "method not allowed" }, { allow: "POST" });
  const origin = request.headers.get("origin");
  if (origin && origin !== SITE && origin !== new URL(request.url).origin) return reply(403, { ok: false, error: "This form posts from genclass.dev only." });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES) return reply(413, { ok: false, error: "Request too large." });
  if (env.AUTH_LIMIT) {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    try {
      if (!(await env.AUTH_LIMIT.limit({ key: (await sha256Hex(`sales:${ip}`)).slice(0, 32) })).success) return reply(429, { ok: false, error: "Too many requests. Try again in a minute." });
    } catch {
      /* the limiter is best effort */
    }
  }
  let data: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BYTES) return reply(413, { ok: false, error: "Request too large." });
    data = isForm ? Object.fromEntries(new URLSearchParams(raw)) : (JSON.parse(raw) as Record<string, unknown>);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not an object");
  } catch {
    return reply(400, { ok: false, error: "Could not read the form." });
  }
  if (clip(data.website, 200)) return reply(200, { ok: true }); // the honeypot: a bot filled the hidden field
  const email = clip(data.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) return reply(400, { ok: false, error: "Please enter a valid work email." });
  const name = clip(data.name, 120);
  if (!name) return reply(400, { ok: false, error: "Please enter your name." });
  const company = clip(data.company, 160);
  if (!company) return reply(400, { ok: false, error: "Please enter your company." });
  const size = clip(data.size, 20);
  const plan = clip(data.plan, 20).toLowerCase();
  const now = opts.now?.() ?? new Date();
  const r: SalesRequest = {
    id: randomBase62(16),
    at: now.toISOString(),
    name,
    email,
    company,
    size: SALES_SIZES.includes(size) ? size : null,
    plan: SALES_PLANS.has(plan) ? plan : "enterprise",
    need: clip(data.need, 2000),
    page: clip(data.page, 80) || null,
  };
  const key = `sales/${r.at}-${r.id}.json`;
  try {
    await env.BUCKET.put(key, new TextEncoder().encode(JSON.stringify(r)), { httpMetadata: { contentType: "application/json" } });
  } catch {
    return reply(500, { ok: false, error: "Something went wrong on our side. Try again, or email mehar@genclass.dev." });
  }
  const tell = async (): Promise<void> => {
    await notifyOwner(
      { env, fetch: opts.fetch ?? ((u, i) => fetch(u, i)), now },
      { event: "sales_request", text: `New sales request ${r.id} (${r.size ? `team of ${r.size}` : "team size not given"}, ${r.plan}). The details are in your email and in R2 at ${key}.`, request_id: r.id },
    );
    if (env.EMAIL) {
      const mail = salesEmail(r);
      try {
        await env.EMAIL.send({ to: PLANS_FILE.contact || "mehar@genclass.dev", from: FROM, subject: mail.subject, html: mail.html, text: mail.text, replyTo: r.email, headers: { "X-GenClass-Sales": r.id } });
      } catch {
        console.log(`sales: request ${r.id} kept, the email was not sent`);
      }
    }
  };
  if (opts.waitUntil) opts.waitUntil(tell().catch(() => undefined));
  else await tell().catch(() => undefined);
  return reply(200, { ok: true, id: r.id });
}
