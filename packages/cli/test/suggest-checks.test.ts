// The catalog of `genclass suggest` (src/suggest/checks.mjs): for facts built by hand, every check gives the status
// the catalog promises, and its words and evidence keep to the rules (ids stable, plain text, no secret values).
import { describe, expect, it } from "vitest";
import { AREAS, CHECKS, runChecks } from "../src/suggest/checks.mjs";

type Facts = { repo?: any; site?: any };

/** A site where every check passes. */
const goodSite = (): any => ({
  url: "https://example.com/",
  origin: "https://example.com",
  host: "example.com",
  reachable: true,
  error: null,
  elapsedMs: 420,
  https: { ok: true, httpRedirects: true },
  www: { other: "www.example.com", joined: true },
  home: {
    status: 200,
    finalUrl: "https://example.com/",
    bytes: 20_000,
    title: "Acme Invoices: billing for freelancers",
    defaultTitle: false,
    description: "Send invoices, see who has paid and send reminders without a spreadsheet. Free for one client.",
    canonical: "https://example.com/",
    lang: "en",
    viewport: true,
    h1: ["Billing for freelancers"],
    og: { title: "Acme Invoices", description: "Billing for freelancers", image: "https://example.com/og.png" },
    twitterCard: "summary_large_image",
    jsonLd: true,
    favicon: true,
    noindex: false,
    textChars: 1800,
    scripts: 3,
    testStripeKey: false,
    stripe: true,
    mentionsPrice: true,
    pricingLink: true,
    generator: null,
    hsts: true,
  },
  robots: { status: 200, html: false, allowsAll: true, blockedAi: [], sitemaps: ["https://example.com/sitemap.xml"] },
  sitemap: { url: "https://example.com/sitemap.xml", status: 200, valid: true, urls: 12 },
  llms: { status: 200, html: false },
  notFound: { status: 404 },
  dns: { mx: true, spf: true, dmarc: true },
});

/** A repository where every check passes. */
const goodRepo = (): any => ({
  dir: "/work/acme",
  name: "acme",
  git: { repo: true, tracked: ["package.json", "src/main.ts", ".env.example"], remote: "https://github.com/acme/app.git", github: "acme/app", branch: "main" },
  files: ["package.json", "src/main.ts", ".env", ".env.example"],
  truncated: false,
  pkg: { name: "acme", scripts: { test: "vitest run" }, deps: { stripe: "^17.0.0", vitest: "^3.0.0" }, engines: null, homepage: null },
  lockfile: "npm",
  tests: { files: 4, script: "vitest run", playwright: false, runner: "vitest" },
  ci: { workflows: [{ file: ".github/workflows/ci.yml", onPullRequest: true, runsTests: true, deploys: false }], other: [] },
  env: { files: [".env", ".env.example"], tracked: [], example: true, ignored: true },
  secrets: [],
  payments: { provider: "stripe", testKeyInProduction: [], secretInClient: [] },
  hosting: { provider: "vercel", previews: true, staging: null },
  readme: { exists: true, chars: 900, boilerplate: false },
  monitoring: { genclass: true, sentry: false, other: [] },
  seo: { robots: true, sitemap: true, llms: true, ogImage: true, manifest: true },
  site: { url: "https://example.com", from: "package.json homepage" },
});

const site = (change?: (s: any) => void) => {
  const s = goodSite();
  change?.(s);
  return s;
};
const repo = (change?: (r: any) => void) => {
  const r = goodRepo();
  change?.(r);
  return r;
};
/** One check's result. A side left out is the good one; pass null for "not read". */
const one = (id: string, f: Facts = {}) => {
  const r = runChecks({ repo: f.repo === undefined ? goodRepo() : f.repo, site: f.site === undefined ? goodSite() : f.site }).find((x) => x.id === id);
  if (!r) throw new Error(`no check ${id}`);
  return r;
};
const status = (id: string, f: Facts = {}) => one(id, f).status;

// A secret-shaped string, put together here so that no key-shaped text is in this file.
const fakeStripeKey = ["sk", "live", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("_");

const IDS = [
  ["https", "launch", 5],
  ["www-joined", "launch", 2],
  ["title", "launch", 4],
  ["favicon", "launch", 2],
  ["not-found-page", "launch", 2],
  ["mobile-viewport", "launch", 3],
  ["staging", "launch", 3],
  ["description", "search", 3],
  ["link-preview", "search", 3],
  ["canonical", "search", 2],
  ["robots-txt", "search", 4],
  ["sitemap", "search", 3],
  ["one-h1", "search", 2],
  ["structured-data", "search", 1],
  ["html-lang", "search", 1],
  ["ai-crawlers", "ai", 4],
  ["text-without-js", "ai", 5],
  ["llms-txt", "ai", 1],
  ["test-keys-live", "payments", 5],
  ["secret-in-client", "payments", 5],
  ["pricing-visible", "payments", 3],
  ["env-committed", "safety", 5],
  ["secrets-in-repo", "safety", 5],
  ["env-example", "safety", 1],
  ["tests", "quality", 2],
  ["ci", "quality", 3],
  ["error-visibility", "quality", 3],
  ["readme", "quality", 1],
  ["lockfile", "quality", 1],
  ["email-spf", "email", 3],
  ["email-dmarc", "email", 3],
] as const;

describe("suggest checks: the catalog", () => {
  it("has the ids, areas and weights of the spec, in order", () => {
    expect(CHECKS.map((c) => [c.id, c.area, c.weight])).toEqual(IDS.map((x) => [...x]));
  });

  it("ids are unique and kebab-case, areas are known", () => {
    const ids = CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CHECKS) {
      expect(c.id).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
      expect(Object.keys(AREAS)).toContain(c.area);
      expect([1, 2, 3, 4, 5]).toContain(c.weight);
      expect(typeof c.run).toBe("function");
      expect(c.needs.length).toBeGreaterThan(0);
      for (const n of c.needs) expect(["repo", "site"]).toContain(n);
    }
    expect(AREAS).toEqual({ launch: "Launch", search: "Search", ai: "AI assistants", payments: "Payments", safety: "Safety", quality: "Quality", email: "Email" });
  });

  it("every title, why, fix and prompt is plain text: not empty, no dashes, no emoji, short title", () => {
    for (const c of CHECKS) {
      for (const key of ["title", "why", "fix", "prompt"] as const) {
        const text = c[key];
        expect(typeof text, `${c.id}.${key}`).toBe("string");
        expect(text.trim().length, `${c.id}.${key}`).toBeGreaterThan(0);
        expect(text, `${c.id}.${key}`).not.toMatch(/[‒–—―]/);
        expect(text, `${c.id}.${key}`).not.toMatch(/\p{Extended_Pictographic}/u);
        expect(text, `${c.id}.${key}`).not.toMatch(/[\u0000-\u001f]/);
        expect(text, `${c.id}.${key}`).toBe(text.trim());
      }
      expect(c.title.length, c.id).toBeLessThanOrEqual(70);
      expect(c.title, c.id).not.toMatch(/[.!]$/);
      expect(c.why.length, c.id).toBeLessThanOrEqual(320);
      expect(c.fix.length, c.id).toBeLessThanOrEqual(220);
    }
  });

  it("the error-visibility fix names npx genclass", () => {
    const c = CHECKS.find((x) => x.id === "error-visibility")!;
    expect(c.fix).toContain("npx genclass");
    expect(c.prompt).toContain("npx genclass");
  });
});

describe("suggest checks: runChecks", () => {
  it("returns every check in catalog order with the catalog's words", () => {
    const results = runChecks({ repo: goodRepo(), site: goodSite() });
    expect(results.map((r) => r.id)).toEqual(CHECKS.map((c) => c.id));
    for (const [i, r] of results.entries()) {
      const c = CHECKS[i];
      expect(Object.keys(r).sort()).toEqual(["area", "evidence", "fix", "id", "prompt", "status", "title", "weight", "why"]);
      expect([r.area, r.title, r.weight, r.why, r.fix, r.prompt]).toEqual([c.area, c.title, c.weight, c.why, c.fix, c.prompt]);
    }
  });

  it("a well-made app passes every check", () => {
    for (const r of runChecks({ repo: goodRepo(), site: goodSite() })) expect(r.status, r.id).toBe("pass");
  });

  it("with no facts at all, everything is unknown or skip, and nothing throws", () => {
    for (const facts of [{ repo: null, site: null }, {}, undefined, null, { repo: 5, site: "x" }] as any[]) {
      const results = runChecks(facts);
      expect(results).toHaveLength(CHECKS.length);
      for (const r of results) expect(["unknown", "skip"], r.id).toContain(r.status);
    }
  });

  it("odd or partial facts never throw and always give a known status", () => {
    const odd: any[] = [
      { repo: {}, site: {} },
      { repo: { git: null, env: null, secrets: "x", ci: { workflows: "no" }, tests: null, payments: null }, site: { home: { status: 200 }, robots: null, dns: null, www: null, https: null } },
      { repo: goodRepo(), site: { ...goodSite(), home: { status: 200, h1: null, og: null, title: 7 } } },
    ];
    for (const facts of odd) {
      const results = runChecks(facts);
      expect(results).toHaveLength(CHECKS.length);
      for (const r of results) {
        expect(["pass", "fail", "unknown", "skip"], r.id).toContain(r.status);
        expect(Array.isArray(r.evidence), r.id).toBe(true);
      }
    }
  });

  it("an unreachable site makes the site checks unknown, never fail", () => {
    const down = { ...goodSite(), reachable: false, error: "ENOTFOUND", https: { ok: null, httpRedirects: null }, www: { other: "www.example.com", joined: null }, home: null, robots: { status: null, html: false, allowsAll: null, blockedAi: [], sitemaps: [] }, sitemap: { url: null, status: null, valid: null, urls: null }, llms: { status: null, html: false }, notFound: { status: null }, dns: { mx: null, spf: null, dmarc: null } };
    for (const r of runChecks({ repo: null, site: down })) expect(["unknown", "skip"], r.id).toContain(r.status);
    expect(one("title", { site: down }).evidence[0]).toContain("ENOTFOUND");
  });

  it("a home page that answers 403 or 503 makes the page checks unknown", () => {
    for (const code of [403, 503]) {
      const s = site((x) => (x.home.status = code));
      for (const id of ["title", "favicon", "mobile-viewport", "description", "link-preview", "canonical", "one-h1", "structured-data", "html-lang", "text-without-js", "pricing-visible"]) {
        expect(status(id, { site: s }), id).toBe("unknown");
      }
      expect(one("title", { site: s }).evidence[0]).toContain(String(code));
    }
  });
});

describe("suggest checks: launch", () => {
  it("https", () => {
    expect(status("https", { site: site((s) => (s.https.ok = false)) })).toBe("fail");
    expect(status("https", { site: site((s) => (s.https.httpRedirects = false)) })).toBe("fail");
    expect(status("https", { site: site((s) => (s.https.httpRedirects = null)) })).toBe("pass");
    expect(status("https", { site: site((s) => (s.https.ok = null)) })).toBe("unknown");
    expect(status("https", { site: null })).toBe("unknown");
    expect(one("https", { site: site((s) => (s.https.httpRedirects = false)) }).evidence[0]).toContain("http://example.com");
  });

  it("www-joined", () => {
    expect(status("www-joined", { site: site((s) => (s.www.joined = false)) })).toBe("fail");
    expect(status("www-joined", { site: site((s) => (s.www.joined = null)) })).toBe("unknown");
    expect(status("www-joined", { site: null })).toBe("unknown");
    // a subdomain has no www twin: the check does not apply
    expect(status("www-joined", { site: site((s) => Object.assign(s, { host: "app.example.com", www: { other: "www.app.example.com", joined: null } })) })).toBe("skip");
    expect(status("www-joined", { site: site((s) => Object.assign(s, { host: "acme.vercel.app", www: { other: "www.acme.vercel.app", joined: null } })) })).toBe("skip");
    // an address without a name (an IP) has no twin either
    expect(status("www-joined", { site: site((s) => Object.assign(s, { host: "93.184.216.34", www: { other: "", joined: null } })) })).toBe("skip");
    // example.co.uk and www.example.com are top addresses, so a twin that did not answer is unknown
    expect(status("www-joined", { site: site((s) => Object.assign(s, { host: "example.co.uk", www: { other: "www.example.co.uk", joined: null } })) })).toBe("unknown");
    expect(status("www-joined", { site: site((s) => Object.assign(s, { host: "www.example.com", www: { other: "example.com", joined: null } })) })).toBe("unknown");
  });

  it("title", () => {
    expect(status("title", { site: site((s) => (s.home.title = null)) })).toBe("fail");
    expect(status("title", { site: site((s) => Object.assign(s.home, { title: "Vite + React", defaultTitle: true })) })).toBe("fail");
    expect(status("title", { site: site((s) => (s.home.title = "Acme")) })).toBe("fail");
    expect(status("title", { site: site((s) => (s.home.title = "A".repeat(66))) })).toBe("fail");
    expect(status("title", { site: site((s) => (s.home.title = "A".repeat(65))) })).toBe("pass");
    expect(status("title", { site: site((s) => (s.home.title = "Ten chars!")) })).toBe("pass");
    expect(status("title", { site: site((s) => (s.home = null)) })).toBe("unknown");
    expect(status("title", { site: null })).toBe("unknown");
    expect(one("title", { site: site((s) => Object.assign(s.home, { title: "Vite + React", defaultTitle: true })) }).evidence[0]).toContain('"Vite + React"');
  });

  it("favicon, not-found-page, mobile-viewport", () => {
    expect(status("favicon", { site: site((s) => (s.home.favicon = false)) })).toBe("fail");
    expect(status("favicon", { site: site((s) => (s.home.favicon = null)) })).toBe("unknown");
    expect(status("favicon", { site: null })).toBe("unknown");

    expect(status("not-found-page", { site: site((s) => (s.notFound.status = 200)) })).toBe("fail");
    expect(status("not-found-page", { site: site((s) => (s.notFound.status = 410)) })).toBe("pass");
    expect(status("not-found-page", { site: site((s) => (s.notFound.status = 500)) })).toBe("unknown");
    expect(status("not-found-page", { site: site((s) => (s.notFound.status = null)) })).toBe("unknown");
    expect(one("not-found-page", { site: site((s) => (s.notFound.status = 200)) }).evidence[0]).toContain("200");

    expect(status("mobile-viewport", { site: site((s) => (s.home.viewport = false)) })).toBe("fail");
    expect(status("mobile-viewport", { site: null })).toBe("unknown");
  });

  it("staging", () => {
    expect(status("staging", { repo: repo((r) => (r.hosting = { provider: "fly", previews: null, staging: true })) })).toBe("pass");
    expect(status("staging", { repo: repo((r) => (r.hosting = { provider: "cloudflare", previews: true, staging: null })) })).toBe("pass");
    expect(status("staging", { repo: repo((r) => (r.hosting = { provider: "fly", previews: null, staging: false })) })).toBe("fail");
    // the host is known, but whether it builds previews is a dashboard setting nobody read
    expect(status("staging", { repo: repo((r) => (r.hosting = { provider: "railway", previews: null, staging: null })) })).toBe("unknown");
    expect(status("staging", { repo: repo((r) => (r.hosting = { provider: null, previews: null, staging: null })) })).toBe("unknown");
    expect(status("staging", { repo: null })).toBe("unknown");
    expect(one("staging", { repo: repo((r) => (r.hosting = { provider: "fly", previews: null, staging: false })) }).evidence[0]).toContain("fly");
  });
});

describe("suggest checks: search", () => {
  it("description", () => {
    expect(status("description", { site: site((s) => (s.home.description = null)) })).toBe("fail");
    expect(status("description", { site: site((s) => (s.home.description = "Too short.")) })).toBe("fail");
    expect(status("description", { site: site((s) => (s.home.description = "d".repeat(161))) })).toBe("fail");
    expect(status("description", { site: site((s) => (s.home.description = "d".repeat(160))) })).toBe("pass");
    expect(status("description", { site: site((s) => (s.home.description = "d".repeat(50))) })).toBe("pass");
    expect(status("description", { site: null })).toBe("unknown");
  });

  it("link-preview names what is missing", () => {
    const r = one("link-preview", { site: site((s) => (s.home.og = { title: "Acme", description: null, image: null })) });
    expect(r.status).toBe("fail");
    expect(r.evidence[0]).toContain("og:description");
    expect(r.evidence[0]).toContain("og:image");
    expect(r.evidence[0]).not.toContain("og:title");
    expect(status("link-preview", { site: null })).toBe("unknown");
  });

  it("canonical, structured-data, html-lang", () => {
    expect(status("canonical", { site: site((s) => (s.home.canonical = null)) })).toBe("fail");
    expect(status("structured-data", { site: site((s) => (s.home.jsonLd = false)) })).toBe("fail");
    expect(status("html-lang", { site: site((s) => (s.home.lang = null)) })).toBe("fail");
    for (const id of ["canonical", "structured-data", "html-lang"]) expect(status(id, { site: null }), id).toBe("unknown");
  });

  it("robots-txt", () => {
    expect(status("robots-txt", { site: site((s) => (s.robots.status = 404)) })).toBe("fail");
    expect(status("robots-txt", { site: site((s) => (s.robots.html = true)) })).toBe("fail");
    expect(status("robots-txt", { site: site((s) => (s.robots.allowsAll = false)) })).toBe("fail");
    // a noindex on the home page fails it even with a good robots.txt
    expect(status("robots-txt", { site: site((s) => (s.home.noindex = true)) })).toBe("fail");
    expect(status("robots-txt", { site: site((s) => (s.robots.status = null)) })).toBe("unknown");
    expect(status("robots-txt", { site: site((s) => (s.robots.status = 503)) })).toBe("unknown");
    expect(status("robots-txt", { site: null })).toBe("unknown");
    expect(one("robots-txt", { site: site((s) => (s.robots.status = 404)) }).evidence[0]).toContain("404");
  });

  it("sitemap", () => {
    expect(status("sitemap", { site: site((s) => Object.assign(s.sitemap, { status: 404, valid: null, urls: null })) })).toBe("fail");
    expect(status("sitemap", { site: site((s) => Object.assign(s.sitemap, { status: 200, valid: false, urls: null })) })).toBe("fail");
    expect(status("sitemap", { site: site((s) => Object.assign(s.sitemap, { status: 200, valid: null, urls: null })) })).toBe("unknown");
    expect(status("sitemap", { site: site((s) => Object.assign(s.sitemap, { status: null, valid: null, urls: null })) })).toBe("unknown");
    expect(status("sitemap", { site: site((s) => Object.assign(s.sitemap, { status: 502, valid: null, urls: null })) })).toBe("unknown");
    expect(status("sitemap", { site: null })).toBe("unknown");
    expect(one("sitemap").evidence[0]).toContain("12 addresses");
  });

  it("one-h1", () => {
    expect(status("one-h1", { site: site((s) => (s.home.h1 = [])) })).toBe("fail");
    const two = one("one-h1", { site: site((s) => (s.home.h1 = ["First", "Second", "Third"])) });
    expect(two.status).toBe("fail");
    expect(two.evidence[0]).toContain("3");
    expect(two.evidence).toHaveLength(3);
    expect(status("one-h1", { site: null })).toBe("unknown");
  });
});

describe("suggest checks: AI assistants", () => {
  it("ai-crawlers names the blocked ones", () => {
    const r = one("ai-crawlers", { site: site((s) => (s.robots.blockedAi = ["GPTBot", "ClaudeBot", "CCBot"])) });
    expect(r.status).toBe("fail");
    expect(r.evidence[0]).toContain("GPTBot");
    expect(r.evidence[0]).toContain("ClaudeBot");
    // CCBot and Bytespider gather training data; they are not what an assistant reads a site with
    expect(r.evidence[0]).not.toContain("CCBot");
    expect(status("ai-crawlers", { site: site((s) => (s.robots.blockedAi = ["CCBot", "Bytespider"])) })).toBe("pass");
    // no robots.txt keeps nobody out
    expect(status("ai-crawlers", { site: site((s) => Object.assign(s.robots, { status: 404, allowsAll: true, blockedAi: [] })) })).toBe("pass");
    expect(status("ai-crawlers", { site: site((s) => (s.robots.status = null)) })).toBe("unknown");
    expect(status("ai-crawlers", { site: site((s) => (s.robots.status = 500)) })).toBe("unknown");
    expect(status("ai-crawlers", { site: null })).toBe("unknown");
    for (const name of ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "PerplexityBot", "Google-Extended"]) {
      expect(status("ai-crawlers", { site: site((s) => (s.robots.blockedAi = [name])) }), name).toBe("fail");
    }
  });

  it("text-without-js fails for an empty single-page-app shell", () => {
    const r = one("text-without-js", { site: site((s) => Object.assign(s.home, { textChars: 12, scripts: 1 })) });
    expect(r.status).toBe("fail");
    expect(r.evidence[0]).toContain("12 characters");
    expect(r.evidence[1]).toContain("1 script tag");
    expect(status("text-without-js", { site: site((s) => (s.home.textChars = 249)) })).toBe("fail");
    expect(status("text-without-js", { site: site((s) => (s.home.textChars = 250)) })).toBe("pass");
    expect(status("text-without-js", { site: null })).toBe("unknown");
  });

  it("llms-txt", () => {
    expect(status("llms-txt", { site: site((s) => (s.llms.status = 404)) })).toBe("fail");
    // a single-page app answers every path with its HTML shell: that is not an llms.txt
    expect(status("llms-txt", { site: site((s) => (s.llms.html = true)) })).toBe("fail");
    expect(status("llms-txt", { site: site((s) => (s.llms.status = null)) })).toBe("unknown");
    expect(status("llms-txt", { site: site((s) => (s.llms.status = 503)) })).toBe("unknown");
    expect(status("llms-txt", { site: null })).toBe("unknown");
  });
});

describe("suggest checks: payments", () => {
  const noPayments = () => ({ repo: repo((r) => (r.payments.provider = null)), site: site((s) => (s.home.stripe = false)) });

  it("are skipped for an app without payments", () => {
    for (const id of ["test-keys-live", "secret-in-client", "pricing-visible"]) {
      expect(status(id, noPayments()), id).toBe("skip");
      // no repository, and a page without a Stripe key
      expect(status(id, { repo: null, site: site((s) => (s.home.stripe = false)) }), id).toBe("skip");
      // nothing read at all: it cannot be told whether the app takes payments
      expect(status(id, { repo: null, site: null }), id).toBe("unknown");
    }
  });

  it("apply when only the page shows a Stripe key", () => {
    const f = { repo: repo((r) => (r.payments.provider = null)), site: site((s) => Object.assign(s.home, { stripe: false, testStripeKey: true })) };
    expect(status("test-keys-live", f)).toBe("fail");
    expect(status("secret-in-client", f)).toBe("pass");
    expect(status("pricing-visible", f)).toBe("pass");
    // without `stripe` on the page facts (facts built to the first shape), testStripeKey alone still counts
    const older = site((s) => {
      delete s.home.stripe;
      s.home.testStripeKey = true;
    });
    expect(status("test-keys-live", { repo: null, site: older })).toBe("fail");
    expect(status("secret-in-client", { repo: null, site: older })).toBe("unknown");
  });

  it("test-keys-live", () => {
    const onPage = one("test-keys-live", { site: site((s) => (s.home.testStripeKey = true)) });
    expect(onPage.status).toBe("fail");
    expect(onPage.evidence[0]).toContain("pk_test_");
    const inFile = one("test-keys-live", { repo: repo((r) => (r.payments.testKeyInProduction = [".env.production"])) });
    expect(inFile.status).toBe("fail");
    expect(inFile.evidence[0]).toContain(".env.production");
    // the repository alone cannot show what the live site uses
    expect(status("test-keys-live", { site: null })).toBe("unknown");
    expect(status("test-keys-live", { site: null, repo: repo((r) => (r.payments.testKeyInProduction = ["vercel.json"])) })).toBe("fail");
    // a Stripe check does not apply to another provider
    expect(status("test-keys-live", { repo: repo((r) => (r.payments.provider = "paddle")), site: site((s) => (s.home.stripe = false)) })).toBe("skip");
  });

  it("secret-in-client", () => {
    const r = one("secret-in-client", { repo: repo((x) => (x.payments.secretInClient = ["src/pay.ts"])) });
    expect(r.status).toBe("fail");
    expect(r.evidence).toEqual(["src/pay.ts holds a Stripe secret key"]);
    const many = one("secret-in-client", { repo: repo((x) => (x.payments.secretInClient = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"])) });
    expect(many.evidence).toHaveLength(3);
    expect(many.evidence[2]).toBe("and 3 more files");
    expect(status("secret-in-client", { repo: null })).toBe("unknown");
    expect(status("secret-in-client", { repo: repo((x) => (x.payments.provider = "lemonsqueezy")), site: site((s) => (s.home.stripe = false)) })).toBe("skip");
  });

  it("pricing-visible", () => {
    expect(status("pricing-visible", { site: site((s) => Object.assign(s.home, { mentionsPrice: false, pricingLink: true })) })).toBe("pass");
    expect(status("pricing-visible", { site: site((s) => Object.assign(s.home, { mentionsPrice: true, pricingLink: false })) })).toBe("pass");
    expect(status("pricing-visible", { site: site((s) => Object.assign(s.home, { mentionsPrice: false, pricingLink: false })) })).toBe("fail");
    // an empty shell cannot be read for a price: not a failure
    expect(status("pricing-visible", { site: site((s) => Object.assign(s.home, { mentionsPrice: false, pricingLink: false, textChars: 20 })) })).toBe("unknown");
    expect(status("pricing-visible", { site: null })).toBe("unknown");
    // any provider counts here
    expect(status("pricing-visible", { repo: repo((r) => (r.payments.provider = "paddle")), site: site((s) => Object.assign(s.home, { stripe: false, mentionsPrice: false, pricingLink: false })) })).toBe("fail");
  });
});

describe("suggest checks: safety", () => {
  it("env-committed", () => {
    const r = one("env-committed", { repo: repo((x) => (x.env.tracked = [".env"])) });
    expect(r.status).toBe("fail");
    expect(r.evidence).toEqual([".env is tracked by git"]);
    const many = one("env-committed", { repo: repo((x) => (x.env.tracked = [".env", ".env.local", "api/.env", "web/.env"])) });
    expect(many.evidence).toHaveLength(3);
    expect(many.evidence[2]).toBe("and 2 more .env files");
    expect(status("env-committed", { repo: repo((x) => (x.git = { repo: false, tracked: null, remote: null, github: null, branch: null })) })).toBe("skip");
    expect(status("env-committed", { repo: repo((x) => (x.git.tracked = null)) })).toBe("unknown");
    expect(status("env-committed", { repo: null })).toBe("unknown");
  });

  it("secrets-in-repo gives kind, file and line only", () => {
    const r = one("secrets-in-repo", { repo: repo((x) => (x.secrets = [{ file: "src/pay.ts", line: 12, kind: "stripe-secret-live" }])) });
    expect(r.status).toBe("fail");
    expect(r.evidence).toEqual(["stripe-secret-live in src/pay.ts, line 12"]);
    const many = one("secrets-in-repo", {
      repo: repo((x) => (x.secrets = ["openai-key", "aws-access-key", "github-token", "private-key", "slack-token"].map((kind, i) => ({ file: `src/f${i}.ts`, line: i + 1, kind })))),
    });
    expect(many.status).toBe("fail");
    expect(many.evidence).toEqual(["openai-key in src/f0.ts, line 1", "aws-access-key in src/f1.ts, line 2", "and 3 more"]);
    // git is there but could not list its files: what is tracked is not known
    expect(status("secrets-in-repo", { repo: repo((x) => (x.git.tracked = null)) })).toBe("unknown");
    // a folder that is not a git repository is still read
    const plain = repo((x) => {
      x.git = { repo: false, tracked: null, remote: null, github: null, branch: null };
      x.secrets = [{ file: "server.js", line: 3, kind: "anthropic-key" }];
    });
    expect(status("secrets-in-repo", { repo: plain })).toBe("fail");
    expect(status("secrets-in-repo", { repo: repo((x) => (x.git = { repo: false, tracked: null, remote: null, github: null, branch: null })) })).toBe("pass");
    expect(status("secrets-in-repo", { repo: null })).toBe("unknown");
  });

  it("env-example", () => {
    const r = one("env-example", { repo: repo((x) => (x.env = { files: [".env", ".env.local"], tracked: [], example: false, ignored: true })) });
    expect(r.status).toBe("fail");
    expect(r.evidence[0]).toContain(".env, .env.local");
    expect(status("env-example", { repo: repo((x) => (x.env = { files: [], tracked: [], example: false, ignored: null })) })).toBe("skip");
    // only an example file: there is no real env file to explain
    expect(status("env-example", { repo: repo((x) => (x.env = { files: [".env.example"], tracked: [], example: true, ignored: true })) })).toBe("skip");
    expect(status("env-example", { repo: null })).toBe("unknown");
  });
});

describe("suggest checks: quality", () => {
  it("tests", () => {
    expect(status("tests", { repo: repo((r) => (r.tests = { files: 0, script: null, playwright: false, runner: null })) })).toBe("fail");
    // a test script with no test files found: it may run tests this reader did not recognise
    expect(status("tests", { repo: repo((r) => (r.tests = { files: 0, script: "node check.js", playwright: false, runner: null })) })).toBe("unknown");
    // more files than were listed: the tests may be among the rest
    expect(status("tests", { repo: repo((r) => Object.assign(r, { truncated: true, tests: { files: 0, script: null, playwright: false, runner: null } })) })).toBe("unknown");
    expect(status("tests", { repo: null })).toBe("unknown");
    expect(one("tests").evidence).toEqual(["4 test files", "runner: vitest"]);
  });

  it("ci", () => {
    expect(status("ci", { repo: repo((r) => (r.ci = { workflows: [], other: [] })) })).toBe("fail");
    const notOnPr = one("ci", { repo: repo((r) => (r.ci = { workflows: [{ file: ".github/workflows/release.yml", onPullRequest: false, runsTests: true, deploys: true }], other: [] })) });
    expect(notOnPr.status).toBe("fail");
    expect(notOnPr.evidence[0]).toContain("release.yml");
    expect(status("ci", { repo: repo((r) => (r.ci = { workflows: [{ file: ".github/workflows/lint.yml", onPullRequest: true, runsTests: false, deploys: false }], other: [] })) })).toBe("fail");
    // two workflows that each do half do not make one that runs tests on pull requests
    expect(
      status("ci", {
        repo: repo(
          (r) =>
            (r.ci = {
              workflows: [
                { file: ".github/workflows/lint.yml", onPullRequest: true, runsTests: false, deploys: false },
                { file: ".github/workflows/nightly.yml", onPullRequest: false, runsTests: true, deploys: false },
              ],
              other: [],
            }),
        ),
      }),
    ).toBe("fail");
    // another CI service is there: its config is not read, so nothing is claimed
    expect(status("ci", { repo: repo((r) => (r.ci = { workflows: [], other: [".gitlab-ci.yml"] })) })).toBe("unknown");
    expect(status("ci", { repo: null })).toBe("unknown");
  });

  it("error-visibility", () => {
    const none = { genclass: false, sentry: false, other: [] };
    expect(status("error-visibility", { repo: repo((r) => (r.monitoring = { ...none })) })).toBe("fail");
    expect(status("error-visibility", { repo: repo((r) => (r.monitoring = { ...none, sentry: true })) })).toBe("pass");
    expect(status("error-visibility", { repo: repo((r) => (r.monitoring = { ...none, other: ["posthog"] })) })).toBe("pass");
    expect(one("error-visibility").evidence[0]).toContain("GenClass");
    expect(status("error-visibility", { repo: null })).toBe("unknown");
  });

  it("readme and lockfile", () => {
    expect(status("readme", { repo: repo((r) => (r.readme = { exists: false, chars: 0, boilerplate: false })) })).toBe("fail");
    expect(status("readme", { repo: repo((r) => (r.readme = { exists: true, chars: 1200, boilerplate: true })) })).toBe("fail");
    expect(status("readme", { repo: null })).toBe("unknown");

    expect(status("lockfile", { repo: repo((r) => (r.lockfile = null)) })).toBe("fail");
    expect(status("lockfile", { repo: repo((r) => Object.assign(r, { pkg: null, lockfile: null })) })).toBe("skip");
    expect(status("lockfile", { repo: null })).toBe("unknown");
    expect(one("lockfile").evidence).toEqual(["lockfile: npm"]);
  });
});

describe("suggest checks: email", () => {
  it("is skipped for a domain without mail records", () => {
    for (const id of ["email-spf", "email-dmarc"]) {
      expect(status(id, { site: site((s) => (s.dns = { mx: false, spf: false, dmarc: false })) }), id).toBe("skip");
      expect(status(id, { site: site((s) => (s.dns = { mx: null, spf: null, dmarc: null })) }), id).toBe("skip");
      expect(status(id, { site: null }), id).toBe("unknown");
    }
  });

  it("email-spf and email-dmarc", () => {
    expect(status("email-spf", { site: site((s) => (s.dns.spf = false)) })).toBe("fail");
    expect(status("email-spf", { site: site((s) => (s.dns.spf = null)) })).toBe("unknown");
    expect(status("email-dmarc", { site: site((s) => (s.dns.dmarc = false)) })).toBe("fail");
    expect(status("email-dmarc", { site: site((s) => (s.dns.dmarc = null)) })).toBe("unknown");
    // one missing does not fail the other
    expect(status("email-dmarc", { site: site((s) => (s.dns.spf = false)) })).toBe("pass");
  });
});

describe("suggest checks: evidence", () => {
  /** An app where nearly everything is wrong, with long and hostile strings in the page. */
  const messy = (): Facts => ({
    site: site((s) => {
      Object.assign(s.home, {
        title: `Ac\u0007me\u001b[31m ${fakeStripeKey} ‮${"long ".repeat(80)}`,
        defaultTitle: false,
        description: `d\u0000\n\t${"e".repeat(400)}`,
        canonical: null,
        lang: null,
        viewport: false,
        h1: [`one ${"x".repeat(300)}`, `two\r\n${"y".repeat(300)}`, "three"],
        og: { title: null, description: null, image: null },
        jsonLd: false,
        favicon: false,
        textChars: 3,
        scripts: 40,
        testStripeKey: true,
        mentionsPrice: false,
        pricingLink: false,
      });
      s.https.httpRedirects = false;
      s.www.joined = false;
      s.robots = { status: 200, html: false, allowsAll: false, blockedAi: ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "PerplexityBot", "Google-Extended", "CCBot", "Bytespider"], sitemaps: [] };
      s.sitemap = { url: `https://example.com/${"s".repeat(400)}.xml`, status: 404, valid: null, urls: null };
      s.llms = { status: 404, html: false };
      s.notFound = { status: 200 };
      s.dns = { mx: true, spf: false, dmarc: false };
    }),
    repo: repo((r) => {
      r.env = { files: [".env"], tracked: [".env", ".env.local", ".env.production", "api/.env"], example: false, ignored: false };
      r.secrets = Array.from({ length: 9 }, (_, i) => ({ file: `src/${"deep/".repeat(40)}f${i}.ts`, line: i + 1, kind: "stripe-secret-live" }));
      r.payments = { provider: "stripe", testKeyInProduction: [".env.production", "vercel.json", "netlify.toml", "wrangler.toml"], secretInClient: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"] };
      r.hosting = { provider: "fly", previews: null, staging: false };
      r.tests = { files: 0, script: null, playwright: false, runner: null };
      r.ci = { workflows: [], other: [] };
      r.monitoring = { genclass: false, sentry: false, other: [] };
      r.readme = { exists: false, chars: 0, boilerplate: false };
      r.lockfile = null;
    }),
  });

  it("a badly made app fails every check that could be measured", () => {
    // its page is an empty shell, so whether a price is shown could not be read: that one is unknown, not a failure
    for (const r of runChecks(messy())) expect(r.status, r.id).toBe(r.id === "pricing-visible" ? "unknown" : "fail");
  });

  it("is at most 3 lines of at most 160 characters, with no control characters", () => {
    for (const facts of [messy(), { repo: goodRepo(), site: goodSite() }, { repo: null, site: null }]) {
      for (const r of runChecks(facts)) {
        expect(r.evidence.length, r.id).toBeLessThanOrEqual(3);
        for (const line of r.evidence) {
          expect(typeof line, r.id).toBe("string");
          expect(line.length, r.id).toBeGreaterThan(0);
          expect(line.length, r.id).toBeLessThanOrEqual(160);
          expect(line, r.id).not.toMatch(/[\u0000-\u001f\u007f-\u009f‪-‮]/);
          expect(line, r.id).toBe(line.trim());
        }
      }
    }
  });

  it("every check that failed or could not be measured says why", () => {
    for (const r of runChecks(messy())) expect(r.evidence.length, r.id).toBeGreaterThan(0);
    for (const r of runChecks({ repo: null, site: null })) expect(r.evidence.length, r.id).toBeGreaterThan(0);
  });

  it("never holds a secret value, even one a page puts in its own text", () => {
    const results = runChecks(messy());
    const all = JSON.stringify(results);
    expect(all).not.toContain(fakeStripeKey);
    expect(all).not.toContain("A1b2C3d4E5f6G7h8I9j0K1l2");
    const title = results.find((r) => r.id === "title")!;
    expect(title.status).toBe("fail");
    expect(title.evidence.join(" ")).toContain("[redacted]");
    // the secrets check reports where, never what
    const secrets = results.find((r) => r.id === "secrets-in-repo")!;
    for (const line of secrets.evidence.slice(0, 2)) expect(line).toMatch(/^stripe-secret-live in src\//);
    expect(secrets.evidence[2]).toBe("and 7 more");
  });

  it("cleans other secret shapes and sign-in parts of addresses out of page text", () => {
    const shapes = [
      ["sk-ant", "api03", "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2"].join("-"),
      ["AKIA", "Q7RZ2M4X8N1P5T9W"].join(""),
      ["ghp", "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe9Dc8Ba7"].join("_"),
      ["xoxb", "1234567890", "abcdefGHIJKL"].join("-"),
    ];
    for (const shape of shapes) {
      const r = one("one-h1", { site: site((s) => (s.home.h1 = [`key ${shape}`, "second"])) });
      expect(JSON.stringify(r.evidence), shape.slice(0, 6)).not.toContain(shape);
      expect(r.evidence.join(" ")).toContain("[redacted]");
    }
    const canonical = one("canonical", { site: site((s) => (s.home.canonical = "https://user:hunter2pass@example.com/")) });
    expect(canonical.status).toBe("pass");
    expect(canonical.evidence[0]).toBe("canonical: https://example.com/");
  });
});
