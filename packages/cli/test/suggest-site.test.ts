// Facts measured from a live site (src/suggest/site.mjs), against a stand-in site and stand-in DNS: no network.
import { describe, expect, it } from "vitest";
import { AI_CRAWLERS, collectSiteFacts, emptySiteFacts, isPublicHost, parseHtml, parseRobots, robotsBlocks } from "../src/suggest/site.mjs";

type Page = { status?: number; headers?: Record<string, string>; body?: string };

/** A stand-in for the internet: a map from address to answer. An address that is not listed fails like a dead host. */
function fakeWeb(pages: Record<string, Page | (() => Promise<Response>)>) {
  const calls: { url: string; method: string; redirect: string | undefined; agent: string | null }[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", redirect: init?.redirect, agent: new Headers(init?.headers as HeadersInit).get("user-agent") });
    const p = pages[url];
    if (!p) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    if (typeof p === "function") return p();
    return new Response(p.status && p.status >= 300 && p.status < 400 ? null : (p.body ?? ""), { status: p.status ?? 200, headers: p.headers ?? { "content-type": "text/html; charset=utf-8" } });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const dnsOf = (o: { mx?: unknown[] | Error; txt?: Record<string, string[][] | Error> } = {}) => ({
  resolveMx: async (_host: string) => {
    if (o.mx instanceof Error) throw o.mx;
    return o.mx ?? [];
  },
  resolveTxt: async (host: string) => {
    const v = o.txt?.[host];
    if (v instanceof Error) throw v;
    if (!v) throw Object.assign(new Error("no data"), { code: "ENODATA" });
    return v;
  },
});
const redirect = (to: string, status = 301): Page => ({ status, headers: { location: to } });
const text = (body: string, type = "text/plain"): Page => ({ body, headers: { "content-type": type } });

const GOOD_HOME = `<!doctype html>
<html lang="en-CA">
<head>
  <meta charset="utf-8">
  <title>Polar Parts &amp; Co: snowmobile parts shipped across Canada</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <META NAME='description' CONTENT='Belts, skis and carbides for every sled. Orders before noon ship the same day &quot;from Waterloo&quot;.'>
  <link rel="canonical" href="/">
  <link rel="icon" href="/icon.png">
  <meta property="og:title" content="Polar Parts">
  <meta content="Parts for every sled" property="og:description">
  <meta property="og:image" content="/og.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="generator" content="Astro v5.1.0">
  <script type="application/ld+json">{"@type":"Store"}</script>
  <script src="/app.js"></script>
  <style>.x{color:red}</style>
</head>
<body>
  <h1>Parts for <em>every</em> sled</h1>
  <p>${"Drive belts, skis, carbides and more, in stock and ready to ship. ".repeat(6)}</p>
  <p>From $29 a set. <a href="/pricing">See pricing</a></p>
  <noscript>Turn JavaScript on.</noscript>
  <script>window.hidden = "this is not page text";</script>
</body>
</html>`;

const SPA_HOME = `<!doctype html><html><head><meta charset="utf-8"><title>Vite + React</title><script type="module" src="/assets/index.js"></script><script>window.STRIPE="pk_test_51Abcdefghijklmnop"</script></head><body><div id="root"></div></body></html>`;

describe("genclass suggest: a well-made site (src/suggest/site.mjs)", () => {
  const web = () =>
    fakeWeb({
      "https://polarparts.example/": { body: GOOD_HOME, headers: { "content-type": "text/html; charset=utf-8", "strict-transport-security": "max-age=31536000" } },
      "http://polarparts.example/": redirect("https://polarparts.example/"),
      "https://www.polarparts.example/": redirect("https://polarparts.example/"),
      "https://polarparts.example/robots.txt": text("User-agent: *\nDisallow: /admin\n\nSitemap: https://polarparts.example/sitemap.xml\n"),
      "https://polarparts.example/sitemap.xml": text('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://polarparts.example/</loc></url><url><loc>https://polarparts.example/pricing</loc></url></urlset>', "application/xml"),
      "https://polarparts.example/llms.txt": text("# Polar Parts\n"),
      "https://polarparts.example/genclass-check-404-b7f3k9q2x": { status: 404, body: "<h1>Not found</h1>" },
    });

  it("every fact is read, with one GET per address, never followed by fetch itself, under the CLI's own name", async () => {
    const w = web();
    const dns = dnsOf({ mx: [{ exchange: "mx.polarparts.example", priority: 10 }], txt: { "polarparts.example": [["v=spf1 include:_spf.example ", "~all"]], "_dmarc.polarparts.example": [["v=DMARC1; p=none"]] } });
    const f = await collectSiteFacts("polarparts.example", { fetchFn: w.fetchFn, dns, now: () => 1000 });
    expect(f).toMatchObject({ url: "https://polarparts.example/", origin: "https://polarparts.example", host: "polarparts.example", reachable: true, error: null, elapsedMs: 0 });
    expect(f.https).toEqual({ ok: true, httpRedirects: true });
    expect(f.www).toEqual({ other: "www.polarparts.example", joined: true });
    expect(f.home).toEqual({
      status: 200,
      finalUrl: "https://polarparts.example/",
      bytes: Buffer.byteLength(GOOD_HOME),
      title: "Polar Parts & Co: snowmobile parts shipped across Canada",
      defaultTitle: false,
      description: 'Belts, skis and carbides for every sled. Orders before noon ship the same day "from Waterloo".',
      canonical: "https://polarparts.example/",
      lang: "en-CA",
      viewport: true,
      h1: ["Parts for every sled"],
      og: { title: "Polar Parts", description: "Parts for every sled", image: "https://polarparts.example/og.png" },
      twitterCard: "summary_large_image",
      jsonLd: true,
      favicon: true,
      noindex: false,
      textChars: expect.any(Number),
      scripts: 2,
      testStripeKey: false,
      stripe: false,
      mentionsPrice: true,
      pricingLink: true,
      generator: "Astro v5.1.0",
      hsts: true,
    });
    // the page's text is what a reader sees: no script, style or noscript text
    expect(f.home!.textChars).toBeGreaterThan(400);
    expect(f.home!.textChars).toBeLessThan(520);
    expect(f.robots).toEqual({ status: 200, html: false, allowsAll: true, blockedAi: [], sitemaps: ["https://polarparts.example/sitemap.xml"] });
    expect(f.sitemap).toEqual({ url: "https://polarparts.example/sitemap.xml", status: 200, valid: true, urls: 2 });
    expect(f.llms).toEqual({ status: 200, html: false });
    expect(f.notFound).toEqual({ status: 404 });
    expect(f.dns).toEqual({ mx: true, spf: true, dmarc: true });
    // each address once; only GETs; redirects are read here, not followed by fetch; the CLI says who it is
    const urls = w.calls.map((c) => c.url).sort();
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls).toEqual(
      ["http://polarparts.example/", "https://polarparts.example/", "https://polarparts.example/genclass-check-404-b7f3k9q2x", "https://polarparts.example/llms.txt", "https://polarparts.example/robots.txt", "https://polarparts.example/sitemap.xml", "https://www.polarparts.example/"].sort(),
    );
    for (const c of w.calls) expect([c.method, c.redirect, c.agent]).toEqual(["GET", "manual", "genclass-cli (+https://genclass.dev)"]);
  });
});

describe("genclass suggest: a bare single-page-app shell (src/suggest/site.mjs)", () => {
  it("an empty root, a placeholder title, a test key, a catch-all that answers every address with the app, and no mail records", async () => {
    const shell: Page = { body: SPA_HOME };
    const w = fakeWeb({
      "https://app.example/": shell,
      "http://app.example/": shell, // plain http is served as it is
      "https://www.app.example/": { body: "<title>Parked</title>" }, // the twin is another site
      "https://app.example/robots.txt": shell,
      "https://app.example/sitemap.xml": shell,
      "https://app.example/llms.txt": shell,
      "https://app.example/favicon.ico": shell,
      "https://app.example/genclass-check-404-b7f3k9q2x": shell,
    });
    const f = await collectSiteFacts("https://app.example", { fetchFn: w.fetchFn, dns: dnsOf() });
    expect(f.reachable).toBe(true);
    expect(f.https).toEqual({ ok: true, httpRedirects: false });
    expect(f.www.joined).toBe(false);
    expect(f.home).toMatchObject({ title: "Vite + React", defaultTitle: true, description: null, canonical: null, lang: null, viewport: false, h1: [], og: { title: null, description: null, image: null }, twitterCard: null, jsonLd: false, favicon: false, textChars: 0, scripts: 2, testStripeKey: true, stripe: true, mentionsPrice: false, pricingLink: false, hsts: false });
    // an HTML page at /robots.txt is no robots file: nothing is read out of it
    expect(f.robots).toEqual({ status: 200, html: true, allowsAll: true, blockedAi: [], sitemaps: [] });
    expect(f.sitemap).toMatchObject({ status: 200, valid: false, urls: null });
    expect(f.llms).toEqual({ status: 200, html: true });
    // a missing page answers 200: a soft 404
    expect(f.notFound).toEqual({ status: 200 });
    expect(f.dns).toEqual({ mx: false, spf: false, dmarc: false });
  });
});

describe("genclass suggest: addresses, failures and limits (src/suggest/site.mjs header)", () => {
  it("only public http and https addresses are measured; anything else is refused before any request", async () => {
    for (const host of ["localhost", "127.0.0.1", "10.0.0.5", "172.16.3.4", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "[::1]", "[::ffff:127.0.0.1]", "[fd00::1]", "[fe80::1]", "printer.local", "db.internal", "app.localhost", "intranet", "0x7f000001", "2130706433"]) expect(isPublicHost(host), host).toBe(false);
    for (const host of ["example.com", "sub.example.co.uk", "8.8.8.8", "[2606:4700::1111]", "EXAMPLE.com."]) expect(isPublicHost(host), host).toBe(true);
    const w = fakeWeb({});
    for (const [bad, why] of [
      ["http://localhost:3000", "not a public address"],
      ["https://192.168.0.2/", "not a public address"],
      ["ftp://example.com", "not an http or https address"],
      ["javascript:alert(1)", "not an http or https address"],
      ["mailto:me@example.com", "not an http or https address"],
      ["", "no address given"],
      ["http://", "not a valid address"],
    ] as const) {
      const f = await collectSiteFacts(bad, { fetchFn: w.fetchFn, dns: dnsOf() });
      expect(f.reachable, bad).toBe(false);
      expect(f.error, bad).toContain(why);
      expect(f.home, bad).toBeNull();
    }
    expect(w.calls).toEqual([]);
    // a sign-in part of an address is never kept or sent
    const f = await collectSiteFacts("https://user:secret@nowhere.example/#frag", { fetchFn: w.fetchFn, dns: dnsOf() });
    expect(f.url).toBe("https://nowhere.example/");
    expect(JSON.stringify(f)).not.toContain("secret");
    expect(w.calls.every((c) => !c.url.includes("secret"))).toBe(true);
  });

  it("a public address that redirects to a private one is not followed there", async () => {
    const w = fakeWeb({ "https://trap.example/": redirect("http://169.254.169.254/latest/meta-data/"), "https://trap.example/robots.txt": redirect("http://localhost:8080/robots.txt") });
    const f = await collectSiteFacts("https://trap.example", { fetchFn: w.fetchFn, dns: dnsOf() });
    expect(f.reachable).toBe(false);
    expect(f.error).toBe("not a public address");
    expect(w.calls.some((c) => /169\.254|localhost/.test(c.url))).toBe(false);
    expect(f.robots.status).toBeNull();
  });

  it("a dead host, a thrown request, a hung request and a DNS failure give nulls and a short reason, never an exception", async () => {
    const dead = await collectSiteFacts("https://gone.example", { fetchFn: fakeWeb({}).fetchFn, dns: dnsOf({ mx: new Error("SERVFAIL"), txt: { "gone.example": new Error("SERVFAIL"), "_dmarc.gone.example": new Error("SERVFAIL") } }) });
    expect(dead).toMatchObject({ reachable: false, error: "ENOTFOUND", home: null, https: { ok: null, httpRedirects: null }, www: { joined: null }, robots: { status: null, allowsAll: null }, notFound: { status: null }, dns: { mx: null, spf: null, dmarc: null } });
    const thrown = await collectSiteFacts("https://odd.example", { fetchFn: (() => { throw new Error("with a secret in its message"); }) as never, dns: dnsOf() });
    expect(thrown).toMatchObject({ reachable: false, error: "request failed" });
    expect(JSON.stringify(thrown)).not.toContain("secret");
    const hung = await collectSiteFacts("https://slow.example", { fetchFn: (() => new Promise(() => undefined)) as never, dns: { resolveMx: () => new Promise(() => undefined), resolveTxt: () => new Promise(() => undefined) } as never, timeoutMs: 30 });
    expect(hung).toMatchObject({ reachable: false, error: "timeout", dns: { mx: null, spf: null, dmarc: null } });
    // a refused https connection is a fact, where the home page was asked over http
    const noTls = await collectSiteFacts("http://plain.example", {
      fetchFn: fakeWeb({ "http://plain.example/": { body: "<title>Plain old site</title><p>hello</p>" }, "https://plain.example/": async () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })) }).fetchFn,
      dns: dnsOf(),
    });
    expect(noTls).toMatchObject({ reachable: true, https: { ok: false, httpRedirects: false } });
  });

  it("at most 1 MB of a page is read, and a redirect loop ends", async () => {
    const big = `<title>A very large page indeed</title><p>${"x".repeat(1_300_000)}</p><h1>after the cut</h1>`;
    const f = await collectSiteFacts("https://big.example", { fetchFn: fakeWeb({ "https://big.example/": { body: big } }).fetchFn, dns: dnsOf() });
    expect(f.home!.bytes).toBe(1024 * 1024);
    expect(f.home!.title).toBe("A very large page indeed");
    expect(f.home!.h1).toEqual([]);
    const loop = await collectSiteFacts("https://loop.example", { fetchFn: fakeWeb({ "https://loop.example/": redirect("https://loop.example/a"), "https://loop.example/a": redirect("https://loop.example/") }).fetchFn, dns: dnsOf() });
    expect(loop).toMatchObject({ reachable: false, error: "too many redirects" });
  });

  it("a noindex header, a mail domain that takes no mail, and a www address measured from its twin", async () => {
    const f = await collectSiteFacts("https://www.shop.example/", {
      fetchFn: fakeWeb({
        "https://www.shop.example/": { body: "<title>Shop of many things, open daily</title><body><p>hi</p>", headers: { "content-type": "text/html", "x-robots-tag": "noindex, nofollow" } },
        "https://shop.example/": redirect("https://www.shop.example/"),
        "https://www.shop.example/robots.txt": { status: 404, body: "nope" },
        "https://www.shop.example/favicon.ico": { body: "ICO", headers: { "content-type": "image/x-icon" } },
      }).fetchFn,
      dns: dnsOf({ mx: [{ exchange: ".", priority: 0 }], txt: { "shop.example": [["google-site-verification=abc"]] } }),
    });
    expect(f.home).toMatchObject({ noindex: true, favicon: true });
    expect(f.www).toEqual({ other: "shop.example", joined: true });
    // no robots.txt at all means everything is allowed; the sitemap was looked for at its usual place
    expect(f.robots).toMatchObject({ status: 404, allowsAll: true, blockedAi: [] });
    expect(f.sitemap).toMatchObject({ url: "https://www.shop.example/sitemap.xml", status: null });
    // mail records are looked up on the domain without www; an MX of "." takes no mail
    expect(f.dns).toEqual({ mx: false, spf: false, dmarc: false });
    expect(emptySiteFacts("https://x.example/a#b")).toMatchObject({ url: "https://x.example/a", origin: "https://x.example", host: "x.example", reachable: false, home: null });
  });
});

describe("genclass suggest: robots.txt and HTML parsing (src/suggest/site.mjs parseRobots, robotsBlocks, parseHtml)", () => {
  it("groups, the most specific group, an empty Disallow, and an Allow that cancels a Disallow", () => {
    const r = parseRobots(["# comment", "User-agent: GPTBot", "User-agent: ClaudeBot # both", "Disallow: /", "", "User-agent: *", "Disallow:", "Crawl-delay: 5", "Sitemap: /sitemap.xml", "", "User-agent: PerplexityBot", "Disallow: /", "Allow: /", "", "User-agent: CCBot", "Disallow: /private"].join("\r\n"));
    expect(r.groups.map((g) => g.agents)).toEqual([["gptbot", "claudebot"], ["*"], ["perplexitybot"], ["ccbot"]]);
    expect(r.sitemaps).toEqual(["/sitemap.xml"]);
    expect(Object.fromEntries(["*", ...AI_CRAWLERS].map((a) => [a, robotsBlocks(r, a)]))).toEqual({ "*": false, GPTBot: true, "OAI-SearchBot": false, "ChatGPT-User": false, ClaudeBot: true, "Claude-User": false, PerplexityBot: false, "Google-Extended": false, CCBot: false, Bytespider: false });
    // "*" blocks everyone it is not overridden for
    const all = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /\n");
    expect([robotsBlocks(all, "*"), robotsBlocks(all, "GPTBot"), robotsBlocks(all, "ClaudeBot")]).toEqual([true, false, true]);
    expect(robotsBlocks(parseRobots(""), "*")).toBe(false);
    expect(robotsBlocks(null as never, "GPTBot")).toBe(false);
  });

  it("tags in any attribute order and quote style, entities, and text that is really on the page", () => {
    const p = parseHtml(`<html lang=fr><head><title>\n  Caf&eacute; &amp; Th&#233; &lt;3  </title><meta content='Une description' name=description><meta name="robots" content="NOINDEX"><link href='icon.svg' rel="shortcut icon"><a title="a > b" href="/plans">Our plans</a></head><body><h1>Un</h1><h1>Deux <span>!</span></h1><script>var a = "<h1>not a heading</h1>";</script></body></html>`, "https://cafe.example/menu/");
    expect(p).toMatchObject({ title: "Caf&eacute; & Thé <3", description: "Une description", lang: "fr", noindex: true, h1: ["Un", "Deux !"], pricingLink: true, scripts: 1 });
    expect(p.iconLink).toBeTruthy();
    expect(parseHtml("", "https://x.example/")).toMatchObject({ title: null, description: null, h1: [], textChars: 0, scripts: 0 });
    for (const t of ["Vite + React", "create next app", "React App", "Document", "  Home "]) expect(parseHtml(`<title>${t}</title>`).defaultTitle, t).toBe(true);
    expect(parseHtml("<title>Home of the best pies in town</title>").defaultTitle).toBe(false);
  });
});
