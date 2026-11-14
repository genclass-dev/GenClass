// GenClass reports by email (src/report.ts, src/report-email.ts, src/report-sweep.ts, src/report-routes.ts): the
// schedule, the priority rules, what a plan sees, the email, the hourly run (claims, alerts once a day, the cap), the
// settings routes, the signed links, and that the model gets numbers and never an email or a key.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/collector.js";
import type { Stats } from "../src/dashboard.js";
import { esc } from "../src/escape.js";
import { renderReport } from "../src/report-email.js";
import {
  accountToken,
  appItems,
  buildReport,
  CHECK_KINDS,
  claimSend,
  KINDS,
  nextSlot,
  promptSignature,
  showcaseFor,
  summaryFromAnswer,
  type AccountRow,
  type AppReport,
  type EmailMessage,
} from "../src/report.js";
import { reportSweep } from "../src/report-sweep.js";
import { MODEL_URL } from "../src/suggest.js";
import { call, cliToken, createApp, detection, now, resetClock, sendBatch, setNow, setup, signedIn } from "./account-helpers.js";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));

function mailbox() {
  const sent: EmailMessage[] = [];
  return { sent, binding: { async send(m: EmailMessage) { sent.push(m); return { messageId: `m${sent.length}` }; } } };
}

/** An env with the EMAIL stand-in and a link key, over node:sqlite. */
function world(over: Partial<Env> = {}) {
  const box = mailbox();
  const w = setup({ EMAIL: box.binding, INTEGRATIONS_KEY: KEY, ...over });
  return { ...w, box };
}

const grantPro = (sql: ReturnType<typeof setup>["sql"], appId: string) =>
  sql.db.prepare("UPDATE projects SET comp_until = ?, comp_plan = 'team' WHERE id = ?").run("2027-06-01T00:00:00.000Z", appId);

const accountRow = (sql: ReturnType<typeof setup>["sql"], id: string): AccountRow =>
  sql.db.prepare("SELECT id, email, email_verified, report_every, report_next, report_alerts, report_model, report_sent FROM accounts WHERE id = ?").get(id) as unknown as AccountRow;

const page = (route: string): Record<string, unknown> => ({ t: "session", seq: 0, at: 0, host: "shop.example", route, effectiveMode: "observe" });
const noModel = (async () => new Response("{}", { status: 500 })) as typeof fetch;

/** Stats as src/dashboard.ts stats() returns them, with only what a test sets. */
function fakeStats(o: Partial<Stats> & { kinds?: [string, string, number][]; checks?: [string, string, number][]; hours?: { sessions?: number; detections?: number; checks?: number }[] } = {}): Stats {
  const breakdowns: Stats["breakdowns"] = { ...(o.breakdowns ?? {}) };
  if (o.kinds) {
    const by = new Map<string, number>();
    for (const [k, , c] of o.kinds) by.set(k, (by.get(k) ?? 0) + c);
    breakdowns.detect_diagnosis = [...by].map(([key, count]) => ({ key, count }));
    breakdowns.detect_issue = o.kinds.map(([k, p, c]) => ({ key: `${k}\t${p}`, count: c }));
  }
  if (o.checks) {
    const by = new Map<string, number>();
    for (const [k, , c] of o.checks) by.set(k, (by.get(k) ?? 0) + c);
    breakdowns.check_kind = [...by].map(([key, count]) => ({ key, count }));
    breakdowns.check_issue = o.checks.map(([k, p, c]) => ({ key: `${k}\t${p}`, count: c }));
  }
  const hours = o.hours ?? Array.from({ length: 24 }, () => ({}));
  return {
    name: "Shop",
    token: "gc_AAAAAAAAAAAAAAAAAAAAAA",
    created: "2026-10-01T00:00:00.000Z",
    lastEvent: "2026-10-13T11:00:00.000Z",
    range: "24h",
    from: "2026-10-12T13:00:00.000Z",
    generated: "2026-10-13T12:00:00.000Z",
    totals: {},
    distinct: {},
    series: hours.map((h, i) => ({ bucket: String(i), sessions: h.sessions ?? 0, decisions: 0, detections: h.detections ?? 0, acted: 0, possible: 0, checks: h.checks ?? 0, ix_views: 0, ix_sessions: 0 })),
    typeSeries: [],
    checkSeries: [],
    previous: { sessions: 0, detections: 0, acted: 0, checks: 0, ix_views: 0, ix_sessions: 0 },
    recent: [],
    visits: { sessions: 0, pages: 0, bounces: 0, entry: [], exit: [] },
    funnels: [],
    agent: { findings: [], log: [], stages: {} } as unknown as Stats["agent"],
    ...o,
    breakdowns,
  } as Stats;
}

function fakeApp(s: Stats, over: Partial<AppReport> = {}): AppReport {
  const b = s.breakdowns;
  return {
    id: "0123456789abcdef",
    name: "Shop",
    token: "gc_AAAAAAAAAAAAAAAAAAAAAA",
    pro: true,
    analytics: true,
    locked: false,
    demo: !!s.demo,
    created: "2026-10-10T00:00:00.000Z",
    range: s.range,
    period: "the last 24 hours",
    dashboard: "https://genclass.dev/account/apps/0123456789abcdef",
    lastEvent: s.lastEvent,
    totals: { loads: Number(s.totals.sessions ?? 0), problems: 0, possible: 0, checks: 0, fixed: 0, prevLoads: s.previous.sessions, prevProblems: 0, prevChecks: 0 },
    lastHour: null,
    kinds: (b.detect_diagnosis ?? []).map((x) => ({ kind: x.key, name: KINDS[x.key]?.name ?? x.key, count: x.count })),
    checks: (b.check_kind ?? []).map((x) => ({ kind: x.key, name: CHECK_KINDS[x.key]?.name ?? x.key, count: x.count })),
    pages: [],
    visitors: null,
    prs: [],
    ...over,
  };
}

const NOW = new Date("2026-10-13T12:00:00Z");
const rules = (s: Stats, over: Partial<AppReport> = {}) => appItems(fakeApp(s, over), s, null, "https://genclass.dev", NOW).map((i) => `${i.p} ${i.rule}`);

beforeEach(() => resetClock());

describe("reports: the schedule", () => {
  it("gives each schedule its next slot, strictly after now", () => {
    const at = new Date("2026-11-13T09:30:00Z"); // a Friday
    expect(nextSlot(at, "hourly")).toBe("2026-11-13T10:00:00.000Z");
    expect(nextSlot(at, "daily")).toBe("2026-11-13T13:00:00.000Z");
    expect(nextSlot(new Date("2026-11-13T13:00:00Z"), "daily")).toBe("2026-11-14T13:00:00.000Z");
    expect(nextSlot(at, "weekly")).toBe("2026-11-16T13:00:00.000Z");
    expect(nextSlot(new Date("2026-11-16T13:00:00Z"), "weekly")).toBe("2026-11-23T13:00:00.000Z");
    expect(nextSlot(at, "monthly")).toBe("2026-12-01T13:00:00.000Z");
    expect(nextSlot(new Date("2026-12-31T23:59:00Z"), "monthly")).toBe("2027-01-01T13:00:00.000Z");
    expect(nextSlot(at, "off")).toBeNull();
  });

  it("shows three showcase sites a day, one of them 3D, a different set the next day", () => {
    const a = showcaseFor(NOW), b = showcaseFor(new Date(NOW.getTime() + 86_400_000));
    expect(a).toHaveLength(3);
    expect(a.filter((s) => s.three)).toHaveLength(1);
    expect(a.map((s) => s.site)).not.toEqual(b.map((s) => s.site));
    for (const s of a) expect(s.site).toMatch(/^https:\/\/[a-z0-9.-]+\.[a-z]+$/);
  });
});

describe("reports: the names and fixes are the dashboard's own", () => {
  const pages = readFileSync(new URL("../src/pages.ts", import.meta.url), "utf8");
  it("problem kinds", () => {
    for (const [k, v] of Object.entries(KINDS)) {
      expect(pages, k).toContain(`${k}: { name: "${v.name}"`);
      expect(pages, k).toContain(v.fix.replace(/\.$/, ""));
      expect(pages, k).toContain(v.what.replace(/\.$/, "").split(". ")[0]!);
    }
  });
  it("measured checks", () => {
    for (const [k, v] of Object.entries(CHECK_KINDS)) {
      expect(pages, k).toContain(`"${k}": { name: "${v.name}"`);
      expect(pages, k).toContain(v.fix.replace(/\.$/, ""));
    }
  });
});

describe("reports: the priority rules", () => {
  it("an endpoint failing 3 times is critical, once is important; a race on a payment page is critical", () => {
    expect(rules(fakeStats({ kinds: [["failing", "/api/items", 3]] }))).toContain("0 kind:failing");
    expect(rules(fakeStats({ kinds: [["failing", "/api/items", 1]] }))).toContain("1 kind:failing");
    expect(rules(fakeStats({ kinds: [["duplicate", "/checkout", 1]] }))).toContain("0 money:duplicate");
    expect(rules(fakeStats({ kinds: [["duplicate", "/search", 1]] }))).toContain("1 kind:duplicate");
    expect(rules(fakeStats({ kinds: [["stale", "/search", 2]] }))).toContain("1 kind:stale");
    expect(rules(fakeStats({ kinds: [["slow", "/search", 9]] }))).toContain("2 kind:slow");
  });

  it("a blank page is critical at once; a page that stops taking clicks from 3; invisible text is important; layout shifts are worth a look", () => {
    expect(rules(fakeStats({ checks: [["page-blank", "/", 1]] }))).toContain("0 check:page-blank");
    expect(rules(fakeStats({ checks: [["pointer-events-leak", "/", 3]] }))).toContain("0 check:pointer-events-leak");
    expect(rules(fakeStats({ checks: [["pointer-events-leak", "/", 2]] }))).toContain("1 check:pointer-events-leak");
    expect(rules(fakeStats({ checks: [["text-invisible", "/pricing", 4]] }))).toContain("1 check:text-invisible");
    expect(rules(fakeStats({ checks: [["layout-shift", "/", 40]] }))).toContain("2 check:layout-shift");
  });

  it("an app that went silent after steady traffic is critical; a quiet app is not", () => {
    const hours = [...Array.from({ length: 18 }, () => ({ sessions: 3 })), ...Array.from({ length: 6 }, () => ({ sessions: 0 }))];
    expect(rules(fakeStats({ hours }))).toContain("0 silent");
    const quiet = [...Array.from({ length: 18 }, () => ({ sessions: 1 })), ...Array.from({ length: 6 }, () => ({ sessions: 0 }))];
    expect(rules(fakeStats({ hours: quiet }))).not.toContain("0 silent");
    // a burst is not steady traffic: a small site's real day (30 of 38 loads in two hours while it was set up, then a
    // load every few hours) must not tell its owner the site went down
    const burst = [1, 0, 1, 1, 1, 0, 0, 0, 0, 14, 16, 1, 1, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0].map((sessions) => ({ sessions }));
    expect(rules(fakeStats({ hours: burst }))).not.toContain("0 silent");
  });

  it("problems that jumped within the hour are critical; a steady level is not", () => {
    const spike = [...Array.from({ length: 22 }, () => ({ detections: 1 })), { detections: 12 }, { detections: 8 }];
    expect(rules(fakeStats({ hours: spike }))).toContain("0 spike");
    const steady = Array.from({ length: 24 }, () => ({ detections: 6 }));
    expect(rules(fakeStats({ hours: steady }))).not.toContain("0 spike");
  });

  it("an app with no data has only its setup item, with the setup prompt naming its key", () => {
    const s = fakeStats({ lastEvent: null, kinds: [["failing", "/x", 5]] });
    const items = appItems(fakeApp(s, { lastEvent: null }), s, null, "https://genclass.dev", NOW);
    expect(items.map((i) => i.rule)).toEqual(["setup:no-data"]);
    expect(items[0]!.prompt).toContain("gc_AAAAAAAAAAAAAAAAAAAAAA");
    expect(items[0]!.section).toBe("setup");
  });

  it("the recorded demo's estimate gives no problem, hour or traffic item, only setup; an app unconnected for two weeks is a reminder", () => {
    const hours = [...Array.from({ length: 22 }, () => ({ detections: 1 })), { detections: 30 }, { detections: 30 }];
    const demo = fakeStats({ demo: true, kinds: [["failing", "/", 40]], hours, totals: { sessions: 900 } });
    expect(rules(demo)).toEqual([]);
    const fresh = fakeStats({ lastEvent: null });
    expect(rules(fresh, { lastEvent: null, created: "2026-10-12T00:00:00.000Z" })).toEqual(["1 setup:no-data"]);
    expect(rules(fresh, { lastEvent: null, created: "2026-09-01T00:00:00.000Z" })).toEqual(["2 setup:no-data"]);
  });

  it("setup: no data for 3 days, the model failing to load; security: traffic that tripled, request storms", () => {
    const old = fakeStats({ lastEvent: "2026-10-09T00:00:00.000Z" });
    expect(rules(old, { lastEvent: old.lastEvent })).toContain("1 setup:stopped");
    expect(rules(fakeStats({ totals: { model_ready: 3, model_load_failed: 40 } }))).toContain("1 setup:model");
    const busy = fakeStats({ totals: { sessions: 900 }, previous: { sessions: 100, detections: 0, acted: 0, checks: 0, ix_views: 0, ix_sessions: 0 } });
    const items = appItems(fakeApp(busy), busy, null, "https://genclass.dev", NOW);
    expect(items.find((i) => i.rule === "traffic")).toMatchObject({ p: 1, section: "security" });
    const storm = appItems(fakeApp(fakeStats({ kinds: [["overload", "/feed", 30]] })), fakeStats({ kinds: [["overload", "/feed", 30]] }), null, "https://genclass.dev", NOW);
    expect(storm.find((i) => i.rule === "kind:overload")).toMatchObject({ p: 1, section: "security" });
  });
});

describe("reports: one account's report", () => {
  it("a Pro app's report lists its problems with pages and prompts; the email escapes what came from the site", async () => {
    const { env, sql } = world();
    const { cookie, account } = await signedIn(env);
    const app = await createApp(env, cookie, "Shop <script>alert(1)</script>");
    grantPro(sql, app.id);
    await sendBatch(env, app.token, [page("/checkout"), ...detection("duplicate", "/checkout"), ...detection("duplicate", "/checkout")]);
    const built = await buildReport(env, accountRow(sql, account.id), { kind: "report", now: now(), model: false, fetch: noModel });
    const r = built!.report;
    expect(r.items.find((i) => i.rule === "money:duplicate")).toMatchObject({ p: 0, pages: ["/checkout"] });
    const mail = renderReport(r);
    expect(mail.subject).toContain("1 critical");
    expect(mail.html).not.toContain("<script>alert(1)</script>");
    expect(mail.html).toContain("Shop &#60;script&#62;");
    expect(mail.html).toContain("/checkout");
    expect(mail.html).toContain("Upgrade your website design");
    expect(mail.text).toContain("Prompt for your coding agent:");
    // every prompt has a signed link to the prompt page
    const prompt = r.items.find((i) => i.prompt)!.prompt!;
    expect(r.promptLinks[prompt]).toContain(`s=${await promptSignature(env, prompt)}`);
  });

  it("the email is short: a linked prompt is a button, never its text; one setup step on several apps is one row", async () => {
    const { env, sql } = world();
    const { cookie, account } = await signedIn(env);
    const shop = await createApp(env, cookie, "Shop");
    grantPro(sql, shop.id);
    for (const name of ["Blog", "Docs", "Admin"]) grantPro(sql, (await createApp(env, cookie, name)).id);
    await sendBatch(env, shop.token, [page("/cart"), ...detection("stale", "/cart"), ...detection("stale", "/cart")]);
    const r = (await buildReport(env, accountRow(sql, account.id), { kind: "report", now: now(), model: false, fetch: noModel }))!.report;
    const { html, text } = renderReport(r);
    const fix = r.items.find((i) => i.rule === "kind:stale")!.prompt!;
    expect(html).toContain("Copy the fix prompt");
    expect(html).not.toContain(fix.slice(0, 60));
    expect(text).toContain(fix.slice(0, 60));
    // three apps without data: one row that names them, a signed setup prompt per app
    const noData = r.items.filter((i) => i.rule === "setup:no-data");
    expect(noData).toHaveLength(3);
    expect(html.split("No page has reported to GenClass yet")).toHaveLength(2);
    expect(html).toContain("On Blog, Docs and Admin.");
    for (const i of noData) expect(html).toContain(esc(r.promptLinks[i.prompt!]!));
    expect(html.length).toBeLessThan(102_000);
  });

  it("before an app sends anything, the report is about that app: no generic ideas, what the next reports hold", async () => {
    const { env, sql } = world();
    const { cookie, account } = await signedIn(env);
    grantPro(sql, (await createApp(env, cookie, "Glyco site")).id);
    const r = (await buildReport(env, accountRow(sql, account.id), { kind: "report", now: now(), model: false, fetch: noModel }))!.report;
    const { subject, html, text } = renderReport(r);
    expect(subject).toBe("GenClass daily report, Glyco site: finish setting up");
    expect(html).toContain("Glyco site isn&#39;t sending data yet");
    expect(html).toContain("What this report will show");
    expect(html).toContain("Once Glyco site sends its first page load");
    for (const generic of ["Sites to learn from today", "Upgrade your website design", "Suggestions for your app"]) expect(html).not.toContain(generic);
    expect(text).not.toContain("UPGRADE YOUR WEBSITE DESIGN");
    // once it has measured data, the ideas and the showcase come back
    await sendBatch(env, (sql.db.prepare("SELECT token FROM projects WHERE name = 'Glyco site'").get() as { token: string }).token, [page("/")]);
    const later = renderReport((await buildReport(env, accountRow(sql, account.id), { kind: "report", now: now(), model: false, fetch: noModel }))!.report);
    expect(later.html).toContain("Sites to learn from today");
    expect(later.html).not.toContain("What this report will show");
  });

  it("without signed links a short prompt is printed and a long one is left to the text part", async () => {
    const { env, sql } = world({ INTEGRATIONS_KEY: undefined });
    const { cookie, account } = await signedIn(env);
    const app = await createApp(env, cookie, "Shop");
    grantPro(sql, app.id);
    await sendBatch(env, app.token, [page("/cart"), ...detection("stale", "/cart")]);
    const r = (await buildReport(env, accountRow(sql, account.id), { kind: "report", now: now(), model: false, fetch: noModel }))!.report;
    expect(r.promptLinks).toEqual({});
    const long = "Redesign the site. ".repeat(60);
    r.designs = [{ title: "Calm", inspired_by: "https://example.com", why: null, prompt: long } as (typeof r.designs)[number]];
    const { html, text } = renderReport(r);
    const fix = r.items.find((i) => i.rule === "kind:stale")!.prompt!;
    expect(html).toContain(fix.slice(0, 60));
    expect(html).not.toContain(long.slice(0, 200));
    expect(html).toContain("The full prompt is in the plain-text part of this email.");
    expect(text).toContain(long.trim().slice(0, 200));
  });

  it("a Free account sees half: the first half of each app's problems, the rest counted with Pro's upgrade (owner, 2026-11-14)", async () => {
    const { env, sql } = world();
    const { cookie, account } = await signedIn(env);
    const app = await createApp(env, cookie, "Blog");
    // two problems: a failing endpoint (P0) on /api/pay, stale responses (P1) on /secret-admin
    await sendBatch(env, app.token, [page("/secret-admin"), ...detection("stale", "/secret-admin"), ...detection("failing", "/api/pay"), ...detection("failing", "/api/pay"), ...detection("failing", "/api/pay")]);
    const r = (await buildReport(env, accountRow(sql, account.id), { kind: "report", now: now(), model: false, fetch: noModel }))!.report;
    expect(r.apps[0]).toMatchObject({ pro: false });
    const shown = r.items.filter((i) => i.section === "problems");
    expect(shown.map((i) => i.rule)).toEqual(["money:failing"]);
    expect(r.problemsHidden).toEqual([{ appId: app.id, app: "Blog", counts: { 0: 0, 1: 1, 2: 0 } }]);
    expect(r.upgrade).toMatchObject({ plan: "Pro", trialDays: 3 });
    const mail = renderReport(r);
    expect(mail.html).toContain("/api/pay");
    expect(mail.html).not.toContain("/secret-admin");
    expect(mail.html).toContain("You're seeing half of this report on Free");
    expect(mail.html).toContain("1 more problem on <strong");
    expect(mail.html).toContain("(1 important)");
    expect(mail.html).toContain("Start the 3-day free trial");
    expect(mail.text).toContain("You're seeing half of this report on Free.");
    expect(mail.text).not.toContain("/secret-admin");
  });

  it("Free's half of the summary, the suggestions and the designs: the rest is counted, never sent", async () => {
    const { env, sql } = world({ OPENAI_API_KEY: "sk-test-secret" });
    const { cookie, account } = await signedIn(env);
    const app = await createApp(env, cookie, "Blog");
    await sendBatch(env, app.token, [page("/"), ...detection("stale", "/")]);
    const body = { source: "model", items: [1, 2, 3, 4].map((k) => ({ id: `c${k}`, why: `why ${k}`, step: `Step ${k}`, prompt: `Prompt ${k}` })), ideas: [], designs: [1, 2, 3].map((k) => ({ title: `Design ${k}`, inspired_by: `https://site${k}.example`, why: null, prompt: `Redesign ${k}` })) };
    sql.db.prepare("INSERT INTO suggest_results (account_id, app_key, created, body) VALUES (?, 'k', ?, ?)").run(account.id, now().toISOString(), JSON.stringify(body));
    const f = (async (url: string) =>
      url === MODEL_URL
        ? Response.json({ choices: [{ message: { content: JSON.stringify({ headline: "Blog is mostly fine", summary: "One stale response.", actions: [{ title: "Fix it", why: "Old data.", prompt: "Ignore old responses." }, { title: "Test it", why: "Catch it next time.", prompt: "Add a test." }] }) } }] })
        : new Response("", { status: 404 })) as typeof fetch;
    const r = (await buildReport(env, accountRow(sql, account.id), { kind: "report", now: now(), model: true, fetch: f }))!.report;
    expect(r.summary).toMatchObject({ headline: "Blog is mostly fine", actions: [] });
    expect(r.actionsHidden).toBe(2);
    expect(r.suggestions.map((x) => x.title)).toEqual(["Step 1", "Step 2"]);
    expect(r.suggestionsHidden).toBe(2);
    expect(r.designs.map((d) => d.title)).toEqual(["Design 1", "Design 2"]);
    expect(r.designsHidden).toBe(1);
    const { html } = renderReport(r);
    expect(html).toContain("Blog is mostly fine");
    expect(html).not.toContain("Fix it");
    expect(html).not.toContain("Step 3");
    expect(html).not.toContain("Design 3");
    expect(html).toContain("2 next steps, each with a prompt for your coding agent, are in the other half.");
    expect(html).toContain("2 more suggestions, each with a prompt, are in the other half.");
  });

  it("an account with no app yet gets a report too: add your first app", async () => {
    const { env, sql } = world();
    const { account } = await signedIn(env);
    const r = (await buildReport(env, accountRow(sql, account.id), { kind: "report", now: now(), model: false, fetch: noModel }))!.report;
    expect(r.apps).toEqual([]);
    expect(r.items.map((i) => i.rule)).toContain("setup:first-app");
    const mail = renderReport(r);
    expect(mail.subject).toBe("GenClass daily report: add your first app");
    expect(mail.html).toContain("Add your first app to GenClass");
    expect(mail.html).not.toContain("Your apps");
  });

  it("the model gets the numbers and the items, never the email, the key or the account id; its summary leads the email", async () => {
    const { env, sql } = world({ OPENAI_API_KEY: "sk-test-secret" });
    const { cookie, account } = await signedIn(env, "owner@example.com");
    const app = await createApp(env, cookie, "Shop");
    grantPro(sql, app.id);
    await sendBatch(env, app.token, [page("/cart"), ...detection("stale", "/cart")]);
    const asked: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      if (url === MODEL_URL) {
        asked.push(String(init?.body));
        return Response.json({ choices: [{ message: { content: JSON.stringify({ headline: "Stale responses on /cart need a fix", summary: "Shop had 1 stale response on /cart.", actions: [{ title: "Fix the cart", why: "Old totals show.", prompt: "Ignore old responses on /cart." }] }) } }] });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const r = (await buildReport(env, accountRow(sql, account.id), { kind: "report", now: now(), model: true, fetch: f }))!.report;
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("/cart");
    for (const secret of ["owner@example.com", "sk-test-secret", account.id, app.token]) expect(asked[0]).not.toContain(secret);
    expect(r.summary?.headline).toBe("Stale responses on /cart need a fix");
    expect(renderReport(r).html.indexOf("GenClass summary")).toBeLessThan(renderReport(r).html.indexOf("Your apps"));
  });

  it("keeps only the summary's own fields, cleaned and cut", () => {
    expect(summaryFromAnswer("not json")).toBeNull();
    expect(summaryFromAnswer(JSON.stringify({ headline: "", summary: "x", actions: [] }))).toBeNull();
    const s = summaryFromAnswer(JSON.stringify({ headline: "A\u0000 b", summary: "c", actions: [{ title: "t", why: "w", prompt: "p" }, {}, {}, {}], extra: 1 }));
    expect(s).toEqual({ headline: "A b", text: "c", actions: [{ title: "t", why: "w", prompt: "p" }] });
  });
});

describe("reports: the hourly run", () => {
  it("gives a slot first and sends nothing; at the slot, one report to the account's email; never twice", async () => {
    const { env, sql, box } = world();
    setNow(new Date("2026-10-13T09:07:00Z"));
    const { cookie, account } = await signedIn(env, "ada@example.com");
    const app = await createApp(env, cookie, "Shop");
    grantPro(sql, app.id);
    await sendBatch(env, app.token, [page("/"), ...detection("stale", "/search")]);
    expect(await reportSweep(env, new Date("2026-10-13T09:07:00Z"), noModel)).toEqual({ reports: 0, alerts: 0 });
    expect(accountRow(sql, account.id).report_next).toBe("2026-10-13T13:00:00.000Z");
    const at = new Date("2026-10-13T13:07:00Z");
    expect((await reportSweep(env, at, noModel)).reports).toBe(1);
    expect(box.sent).toHaveLength(1);
    const m = box.sent[0]!;
    expect(m).toMatchObject({ to: "ada@example.com", from: { email: "report@genclass.dev", name: "GenClass" }, replyTo: "mehar@genclass.dev" });
    expect(m.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/genclass\.dev\/api\/report\/unsubscribe\?a=[A-Za-z0-9]+&t=[A-Za-z0-9_-]+>$/);
    expect(m.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(m.subject).toBe("GenClass daily report, Shop: 1 important");
    expect(accountRow(sql, account.id).report_next).toBe("2026-10-14T13:00:00.000Z");
    expect((await reportSweep(env, at, noModel)).reports).toBe(0);
    expect(box.sent).toHaveLength(1);
  });

  it("sends a P0 alert between reports, once a day per app and rule", async () => {
    const { env, sql, box } = world();
    setNow(new Date("2026-10-13T15:00:00Z"));
    const { cookie, account } = await signedIn(env);
    const app = await createApp(env, cookie, "Shop");
    grantPro(sql, app.id);
    await sendBatch(env, app.token, [page("/"), ...detection("failing", "/api/items"), ...detection("failing", "/api/items"), ...detection("failing", "/api/items")]);
    await reportSweep(env, new Date("2026-10-13T15:07:00Z"), noModel); // the slot (tomorrow 13:00), and the alert
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]!.subject).toBe("[P0] Shop: Failing endpoints on /api/items");
    expect(box.sent[0]!.headers?.["X-GenClass-Report"]).toBe("alert");
    expect(accountRow(sql, account.id).report_next).toBe("2026-10-14T13:00:00.000Z");
    await reportSweep(env, new Date("2026-10-13T16:07:00Z"), noModel);
    expect(box.sent).toHaveLength(1);
  });

  it("an hourly report with nothing in it is not sent; reports and alerts stop when the account says off", async () => {
    const { env, sql, box } = world();
    setNow(new Date("2026-10-13T09:00:00Z"));
    const { cookie, account } = await signedIn(env);
    const app = await createApp(env, cookie, "Shop");
    grantPro(sql, app.id);
    await sendBatch(env, app.token, [page("/")]);
    sql.db.prepare("UPDATE accounts SET report_every = 'hourly', report_next = '2026-10-13T10:00:00.000Z' WHERE id = ?").run(account.id);
    expect((await reportSweep(env, new Date("2026-10-13T10:07:00Z"), noModel)).reports).toBe(0);
    expect(box.sent).toHaveLength(0);
    sql.db.prepare("UPDATE accounts SET report_every = 'off', report_next = '2026-10-13T10:00:00.000Z' WHERE id = ?").run(account.id);
    await sendBatch(env, app.token, [...detection("failing", "/api/x"), ...detection("failing", "/api/x"), ...detection("failing", "/api/x")]);
    expect(await reportSweep(env, new Date("2026-10-13T11:07:00Z"), noModel)).toEqual({ reports: 0, alerts: 0 });
    expect(box.sent).toHaveLength(0);
  });

  it("sends nothing without the EMAIL binding; caps an account's emails a day", async () => {
    const { env } = world({ EMAIL: undefined });
    expect(await reportSweep(env, new Date(), noModel)).toEqual({ reports: 0, alerts: 0 });
    const db = env.DB!;
    const at = new Date("2026-10-13T12:00:00Z");
    expect(await claimSend(db, "acct", at, 2)).toBe(true);
    expect(await claimSend(db, "acct", at, 2)).toBe(true);
    expect(await claimSend(db, "acct", at, 2)).toBe(false);
    expect(await claimSend(db, "acct", new Date("2026-10-14T00:00:00Z"), 2)).toBe(true);
  });
});

describe("reports: the settings and the email's links", () => {
  it("the account's settings: saved with a new slot; a terminal and another site are refused; Send me one now sends", async () => {
    const { env, sql, box } = world();
    const { cookie, account } = await signedIn(env);
    await createApp(env, cookie, "Shop");
    let r = await call(env, "POST", "/api/account/report", { body: { every: "weekly", alerts: false }, cookie });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ every: "weekly", alerts: false, next: nextSlot(now(), "weekly") });
    expect(accountRow(sql, account.id)).toMatchObject({ report_every: "weekly", report_alerts: 0 });
    expect((await call(env, "POST", "/api/account/report", { body: { every: "yearly" }, cookie })).status).toBe(400);
    expect((await call(env, "POST", "/api/account/report", { body: { every: "daily" }, cookie, origin: "https://evil.example" })).status).toBe(403);
    const bearer = await cliToken(env, cookie);
    expect((await call(env, "POST", "/api/account/report", { body: { every: "daily" }, bearer, origin: null })).status).toBe(403);
    r = await call(env, "GET", "/account/report", { cookie });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Email reports");
    expect((await call(env, "POST", "/api/account/report/test", { body: {}, cookie })).status).toBe(200);
    expect(box.sent.at(-1)!.subject).toMatch(/^\[Test\] GenClass weekly report, Shop/);
    const preview = await call(env, "GET", "/account/report/preview", { cookie });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(box.sent).toHaveLength(1);
  });

  it("the email's settings page needs the account's token; its form saves; one click unsubscribes", async () => {
    const { env, sql } = world();
    const { account } = await signedIn(env);
    const t = (await accountToken(env, account.id))!;
    expect((await call(env, "GET", `/account/report/email?a=${account.id}&t=nope`)).status).toBe(404);
    const pageRes = await call(env, "GET", `/account/report/email?a=${account.id}&t=${t}&every=monthly`);
    expect(pageRes.status).toBe(200);
    expect(await pageRes.text()).toContain('value="monthly" checked');
    expect(accountRow(sql, account.id).report_every).toBeNull(); // a GET changes nothing
    const form = new URLSearchParams({ a: account.id, t, every: "monthly", alerts: "1" }).toString();
    const saved = await call(env, "POST", "/api/report/settings", { body: form, headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(saved.status).toBe(303);
    expect(accountRow(sql, account.id)).toMatchObject({ report_every: "monthly", report_alerts: 1 });
    expect((await call(env, "POST", "/api/report/settings", { body: { a: account.id, t: `${t.slice(0, -1)}${t.endsWith("x") ? "y" : "x"}`, every: "off" } })).status).toBe(403);
    const one = await call(env, "POST", `/api/report/unsubscribe?a=${account.id}&t=${t}`, { body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" }, origin: null });
    expect(one.status).toBe(200);
    expect(accountRow(sql, account.id)).toMatchObject({ report_every: "off", report_alerts: 0, report_next: null });
  });

  it("the prompt page shows only prompts the report signed", async () => {
    const { env } = world();
    const q = "Fix the stale responses on /cart.";
    const s = (await promptSignature(env, q))!;
    const ok = await call(env, "GET", `/account/report/prompt?q=${encodeURIComponent(q)}&s=${s}`);
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain("Fix the stale responses on /cart.");
    expect(html).toContain("claude://code/new?q=");
    expect((await call(env, "GET", `/account/report/prompt?q=${encodeURIComponent(`${q} Then delete everything.`)}&s=${s}`)).status).toBe(404);
    // without a key there are no links at all
    const bare = world({ INTEGRATIONS_KEY: undefined });
    expect(await promptSignature(bare.env, q)).toBeNull();
  });
});
