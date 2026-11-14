// Facts measured from a live site (src/suggest/site.mjs), against a stand-in site and stand-in DNS: no network.
import { describe, expect, it } from "vitest";
import { AI_CRAWLERS, bundleSecrets, collectSiteFacts, emptySiteFacts, isPublicHost, MAX_SCRIPTS, parseHtml, parseRobots, robotsBlocks, scriptSources } from "../src/suggest/site.mjs";

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
      // app.js: the page's own script, read for secret keys (secrets-in-bundle)
      ["http://polarparts.example/", "https://polarparts.example/", "https://polarparts.example/app.js", "https://polarparts.example/genclass-check-404-b7f3k9q2x", "https://polarparts.example/llms.txt", "https://polarparts.example/robots.txt", "https://polarparts.example/sitemap.xml", "https://www.polarparts.example/"].sort(),
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

describe("genclass suggest: the scripts a page ships, read for secret keys (src/suggest/site.mjs bundleSecrets, scriptSources)", () => {
  // key-shaped strings put together here, so that no key-shaped text is in this file
  const openai = ["sk", "proj", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4"].join("-");
  const jwt = (role: string) => ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", Buffer.from(JSON.stringify({ iss: "supabase", ref: "abcdefgh", role, iat: 1 })).toString("base64url"), "abcdefghijklmnopqrstuvwxyz012345"].join(".");

  it("finds the kinds, never returns a value, and leaves public keys and examples alone", () => {
    expect(bundleSecrets(`var a="${openai}",b="${jwt("service_role")}"`)).toEqual(["openai-key", "supabase-service-role"]);
    // the anon key is meant to be public; AWS's documented example key; a locale code; Stripe's documented sample
    expect(bundleSecrets(`x="${jwt("anon")}";y="sk-SK";z="AKIA" + "IOSFODNN7EXAMPLE";k="AKIAIOSFODNN7EXAMPLE";w="${["sk", "test", "4eC39HqLyjWDarjtT1zdp7dc"].join("_")}"`)).toEqual([]);
    expect(bundleSecrets("")).toEqual([]);
  });

  it("lists the page's own scripts and module preloads, each once, never another origin's or a nomodule one", () => {
    const html = `<script src="/assets/a.js"></script><script src="https://cdn.other.example/b.js"></script><link rel="modulepreload" href="/assets/c.js"><script>inline</script><script src=""></script><script src="data:text/javascript,1"></script><script src="/legacy.js" nomodule></script><link rel="modulepreload" href="/assets/a.js">${Array.from({ length: 9 }, (_, i) => `<script src="/s${i}.js"></script>`).join("")}`;
    const srcs = scriptSources(html, "https://shop.example/");
    expect(srcs.slice(0, 3)).toEqual(["https://shop.example/assets/a.js", "https://shop.example/s0.js", "https://shop.example/s1.js"]);
    expect(srcs).toHaveLength(11);
    expect(srcs.at(-1)).toBe("https://shop.example/assets/c.js");
    expect(srcs.every((s) => s.startsWith("https://shop.example/"))).toBe(true);
    expect(srcs).not.toContain("https://shop.example/legacy.js");

    // below the cap the preloads are in the list: a module preload and a script preload, not a style's (a Vite
    // app whose entry chunk is only preloaded is still read for keys)
    expect(scriptSources(`<script type="module" src="/assets/a.js"></script><link rel="modulepreload" href="/assets/c.js"><link rel="preload" as="script" href="/assets/d.js"><link rel="preload" as="style" href="/assets/e.css"><link rel="modulepreload" href="https://cdn.other.example/f.js">`, "https://shop.example/")).toEqual(["https://shop.example/assets/a.js", "https://shop.example/assets/c.js", "https://shop.example/assets/d.js"]);
  });

  it("a live page whose bundle holds a key: the kind and the script's path, with no query", async () => {
    const page = `<!doctype html><html><head><title>Shop</title><script type="module" src="/assets/index-a1.js?v=tok123"></script></head><body><h1>Shop</h1></body></html>`;
    const w = fakeWeb({ "https://shop.example/": { body: page }, "https://shop.example/assets/index-a1.js?v=tok123": text(`const k="${openai}";`, "text/javascript") });
    const f = await collectSiteFacts("https://shop.example/", { fetchFn: w.fetchFn, dns: dnsOf() });
    expect(f.bundle).toEqual({ scanned: 1, unread: 0, partial: [], found: [{ path: "/assets/index-a1.js", kind: "openai-key" }] });
    expect(JSON.stringify(f)).not.toContain(openai);
  });
});

describe("genclass suggest: which scripts are read, and how much of each (src/suggest/site.mjs scriptSources, collectSiteFacts)", () => {
  const jwt = (role: string, iss = "supabase") => ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", Buffer.from(JSON.stringify({ iss, ref: "abcdefgh", role, iat: 1 })).toString("base64url"), "abcdefghijklmnopqrstuvwxyz012345"].join(".");
  const js = (body: string): Page => text(body, "text/javascript");
  const chunk = (name: string) => `/_next/static/chunks/${name}.js`;

  // A Next.js 16 App Router home page as Turbopack builds it: the runtime's chunks first (one also preloaded, and
  // given again last with the bootstrap's id), the metadata chunk, the page's five chunks, then the polyfills for
  // old browsers; the payload names the chunks of the page's client components.
  const runtime = ["0d8wrqgf5wrm5", "3zn4q-rnqdnfg", "1u3un9vtebfyh", "turbopack-0ie61feraln2o"];
  const pageChunks = ["1qo6c542q5lnx", "110_cr1g3s2vn", "15nigigry8hy_", "1omwgckp_atno", "0mae80qyldj00"];
  const nextHome = (extra = "") =>
    `<!doctype html><html><head><title>Troy</title><link rel="preload" as="script" fetchPriority="low" href="${chunk("0-9slcls78bw1")}"/>${runtime.map((c) => `<script src="${chunk(c)}" async=""></script>`).join("")}<script src="${chunk("3dlqm4t3lwqe9")}" async=""></script>${pageChunks.map((c) => `<script src="${chunk(c)}" async=""></script>`).join("")}${extra}<script src="${chunk("0cz1d0mv5g_q7")}" noModule=""></script><script src="${chunk("0-9slcls78bw1")}" id="_R_" async=""></script></head><body><h1>Talk to Troy</h1><script>self.__next_f.push([1,"5:I[42089,[\\"/_next/static/chunks/3dlqm4t3lwqe9.js\\"],\\"default\\"]\\n7:I[51234,[\\"/_next/static/chunks/1omwgckp_atno.js\\",\\"/_next/static/chunks/15nigigry8hy_.js\\"],\\"LandingActions\\"]\\n"])</script></body></html>`;

  it("a Next.js App Router page: a key in the 9th script, the page's client component, is found (finding 11)", async () => {
    const pages: Record<string, Page> = { "https://troy.example/": { body: nextHome() } };
    for (const c of [...runtime, "3dlqm4t3lwqe9", ...pageChunks, "0-9slcls78bw1", "0cz1d0mv5g_q7"]) pages[`https://troy.example${chunk(c)}`] = js(`/* ${c} */`);
    pages[`https://troy.example${chunk("1omwgckp_atno")}`] = js(`createClient(u,"${jwt("service_role")}")`);
    const w = fakeWeb(pages);
    const f = await collectSiteFacts("https://troy.example/", { fetchFn: w.fetchFn, dns: dnsOf() });
    // eleven scripts: the polyfills (nomodule) are never requested
    expect(f.bundle).toEqual({ scanned: 11, unread: 0, partial: [], found: [{ path: chunk("1omwgckp_atno"), kind: "supabase-service-role" }] });
    expect(w.calls.some((c) => c.url.includes("0cz1d0mv5g_q7"))).toBe(false);
  });

  it("the chunks the payload names and the route's chunks come first, Next.js's runtime by name last, and the cap is counted", () => {
    const filler = Array.from({ length: 24 }, (_, i) => `<script src="${chunk(`f${String(i).padStart(2, "0")}`)}" async></script>`).join("");
    const html = `<script src="${chunk("webpack-1a2b3c")}"></script><script src="${chunk("main-app-9f8e7d")}"></script>${filler}<script src="${chunk("app/page-77aa")}"></script>${nextHome()}`;
    const srcs = scriptSources(html, "https://troy.example/").map((s) => new URL(s).pathname);
    // the route's chunk by name and the ones the payload names, in page order
    expect(srcs.slice(0, 4)).toEqual([chunk("app/page-77aa"), chunk("3dlqm4t3lwqe9"), chunk("15nigigry8hy_"), chunk("1omwgckp_atno")]);
    expect(srcs.slice(-3)).toEqual([chunk("webpack-1a2b3c"), chunk("main-app-9f8e7d"), chunk("turbopack-0ie61feraln2o")]);
    expect(srcs).toHaveLength(2 + 24 + 1 + 11);
  });

  it("past MAX_SCRIPTS, the scripts left are counted as not read", async () => {
    const many = Array.from({ length: MAX_SCRIPTS + 5 }, (_, i) => `/assets/c${i}.js`);
    const pages: Record<string, Page> = { "https://many.example/": { body: `<title>Many</title>${many.map((s) => `<script type="module" src="${s}"></script>`).join("")}` } };
    for (const s of many) pages[`https://many.example${s}`] = js("export {};");
    const w = fakeWeb(pages);
    const f = await collectSiteFacts("https://many.example/", { fetchFn: w.fetchFn, dns: dnsOf() });
    expect(f.bundle).toEqual({ scanned: MAX_SCRIPTS, unread: 5, partial: [], found: [] });
    expect(w.calls.filter((c) => c.url.includes("/assets/")).length).toBe(MAX_SCRIPTS);
  });

  it("a script over 1 MB is read to 1 MB and marked as read in part, never as read whole (finding 54)", async () => {
    // Vite and Rollup put the app's own modules at the end of the bundle, after the libraries
    const big = `${"var vendor=1;".repeat(Math.ceil((1.2 * 1024 * 1024) / 13))}const sb=createClient(u,"${jwt("service_role")}");`;
    const head = `const sb=createClient(u,"${jwt("service_role")}");${"var vendor=1;".repeat(Math.ceil((1.2 * 1024 * 1024) / 13))}`;
    const site = (body: string) => fakeWeb({ "https://big.example/": { body: `<title>Big</title><script type="module" src="/assets/index-a1.js"></script>` }, "https://big.example/assets/index-a1.js": js(body) });
    const tail = await collectSiteFacts("https://big.example/", { fetchFn: site(big).fetchFn, dns: dnsOf() });
    expect(tail.bundle).toEqual({ scanned: 1, unread: 0, partial: ["/assets/index-a1.js"], found: [] });
    const front = await collectSiteFacts("https://big.example/", { fetchFn: site(head).fetchFn, dns: dnsOf() });
    expect(front.bundle.found).toEqual([{ path: "/assets/index-a1.js", kind: "supabase-service-role" }]);
    expect(front.bundle.partial).toEqual(["/assets/index-a1.js"]);
    // a page that fits is read whole
    const small = await collectSiteFacts("https://big.example/", { fetchFn: site("export {};").fetchFn, dns: dnsOf() });
    expect(small.bundle.partial).toEqual([]);
  });
});

describe("genclass suggest: which key-shaped strings count as a secret in a bundle (src/suggest/site.mjs bundleSecrets)", () => {
  // key-shaped strings put together here, so that no key-shaped text is in this file
  const join = (...parts: string[]) => parts.join("");
  const awsId = join("AKIA", "Q3RZ7WJ2M5XK8PLB");
  const awsSecret = join("wJa1rXUtnF", "EMI/K7MDNG", "bPxRfiCYtQ", "Z9b8c7d6e5");
  const jwt = (role: string, iss: string) => ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", Buffer.from(JSON.stringify({ iss, role, exp: 1983812996 })).toString("base64url"), "abcdefghijklmnopqrstuvwxyz012345"].join(".");

  it("an AWS access key ID inside a pre-signed link is shared on purpose; with its secret next to it, it is a leak (finding 12)", () => {
    const v4 = `<img src="https://up.s3.amazonaws.com/u/a.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&amp;X-Amz-Credential=${awsId}%2F20250101%2Fus-east-1%2Fs3%2Faws4_request&amp;X-Amz-Date=20250101T000000Z&amp;X-Amz-Expires=900&amp;X-Amz-SignedHeaders=host&amp;X-Amz-Signature=${"a1".repeat(32)}">`;
    const v2 = `<img src="https://up.s3.amazonaws.com/u/b.png?AWSAccessKeyId=${awsId}&amp;Expires=1735689600&amp;Signature=Zm9vYmFy%2Bbaz%3D">`;
    const rsc = `self.__next_f.push([1,"{\\"src\\":\\"https://up.s3.amazonaws.com/c.png?X-Amz-Credential=${awsId}%2F20250101%2Fus-east-1%2Fs3%2Faws4_request\\"}"])`;
    expect(bundleSecrets(v4 + v2 + rsc)).toEqual([]);
    // the ID alone signs nothing
    expect(bundleSecrets(`const id="${awsId}";`)).toEqual([]);
    expect(bundleSecrets(`new S3Client({region:"us-east-1",credentials:{accessKeyId:"${awsId}",secretAccessKey:"${awsSecret}"}})`)).toEqual(["aws-access-key"]);
    // a SHA-1 (40 hex digits, no capitals) is no secret access key
    expect(bundleSecrets(`const id="${awsId}",sha="${"0123456789abcdef0123456789abcdef01234567"}";`)).toEqual([]);
  });

  it("placeholders and the keys providers document are no secret (finding 52)", () => {
    const docs = [
      join("STRIPE_SECRET_KEY=sk_live_", "x".repeat(24)),
      join("OPENAI_API_KEY=sk-proj-", "x".repeat(48)),
      join("sk_test_", "BQokikJOvBiI2HlWgH4olfQ2"),
      join("sk_test_", "4eC39HqLyjWDarjtT1zdp7dc"),
      join("accessKeyId:'AKIA", "I44QH8DHBEXAMPLE',secretAccessKey:'wJalrXUtnFEMI/K7MDENG/bPxRfiCY", "EXAMPLEKEY'"),
      join("accessKeyId:'AKIA", "XXXXXXXXXXXXXXXX',secretAccessKey:'", awsSecret, "'"),
      join("ghp_", "yourGithubTokenHere", "yourGithubTokenHere"),
      // the Supabase CLI's local service_role key: public, it opens only a local copy
      jwt("service_role", "supabase-demo"),
    ];
    for (const d of docs) expect(bundleSecrets(d), d.slice(0, 30)).toEqual([]);
    expect(bundleSecrets(jwt("service_role", "supabase"))).toEqual(["supabase-service-role"]);
  });

  it("Supabase secret keys, OpenRouter keys and encrypted private keys are found; publishable keys are not (finding 56)", () => {
    expect(bundleSecrets(`createClient(u,"${join("sb_secret_", "N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz")}")`)).toEqual(["supabase-secret-key"]);
    expect(bundleSecrets(`createClient(u,"${join("sb_publishable_", "N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz")}")`)).toEqual([]);
    expect(bundleSecrets(`{Authorization:"Bearer ${join("sk-or-v1-", "3f9a0c1b2d4e5f60718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c4d5e6f7")}"}`)).toEqual(["openrouter-key"]);
    expect(bundleSecrets(join("-----BEGIN ENCRYPTED ", "PRIVATE KEY-----\\nMIIFHDBOBgkqhkiG9w0BBQ0wQTApBgkqhkiG9w0BBQwwHAQI3pX7ZQ"))).toEqual(["private-key"]);
  });

  it("sk_live_ and sk_test_ keys are not named for Stripe alone: Clerk's and Paystack's start the same way (finding 59)", () => {
    const body = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
    expect(bundleSecrets(`clerk({secretKey:"${join("sk_live_", body)}"})`)).toEqual(["sk-live-secret-key"]);
    expect(bundleSecrets(`"${join("sk_test_", body)}"`)).toEqual(["sk-test-secret-key"]);
    // rk_live_ is Stripe's restricted key: Stripe alone
    expect(bundleSecrets(`"${join("rk_live_", body)}"`)).toEqual(["stripe-secret-live"]);
  });
});
