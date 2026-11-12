// The catalog behind `genclass suggest`: every check, what it costs when it fails, and how to fix it. A check is a
// pure function from measured facts (repo.mjs RepoFacts, site.mjs SiteFacts) to a status and a few evidence lines.
//
// Invariants:
// - A check never fails on a guess. "fail" needs a measured fact that shows the problem; when the fact is missing
//   (no site address, the site did not answer, git could not list files) the status is "unknown"; when the check
//   does not apply to this app (no payments, no mail on the domain) it is "skip".
// - Ids are stable: they are an API between the CLI and the server. Renaming one is a breaking change.
// - Evidence is facts only (a status code, a tag's text, a file and line): at most 3 lines of at most 160 characters,
//   control characters removed, and anything shaped like a secret replaced. A secret's value is never printed.
// - runChecks never throws: a check that throws on odd facts is reported as "unknown".
// - This module imports nothing, so the catalog can be loaded anywhere. The secret shapes used to clean evidence
//   are a short copy of the ones in repo.mjs.
// - The words are for someone who builds with a coding agent and may not know the terms: each term is explained the
//   first time it appears, in plain sentences.

/** @typedef {import("./repo.mjs").RepoFacts} RepoFacts */
/** @typedef {import("./site.mjs").SiteFacts} SiteFacts */

/** The areas a check belongs to, with the names shown to people. */
export const AREAS = { launch: "Launch", search: "Search", ai: "AI assistants", payments: "Payments", safety: "Safety", quality: "Quality", email: "Email" };

/**
 * @typedef {Object} Check
 * @property {string} id            kebab-case, stable: it is an API between the CLI and the server
 * @property {keyof typeof AREAS} area
 * @property {string} title         what is wrong, as a short statement of fact
 * @property {1|2|3|4|5} weight     5: users or money are lost right now; 1: polish
 * @property {string} why           one or two plain sentences: what it costs, with any term explained
 * @property {string} fix           what to do, one or two sentences
 * @property {string} prompt        an instruction to paste to a coding agent in the repository
 * @property {("repo"|"site")[]} needs
 * @property {(f: { repo: RepoFacts | null, site: SiteFacts | null }) => { status: "pass" | "fail" | "unknown" | "skip", evidence: string[] }} run
 */

const MAX_EVIDENCE = 3;
const MAX_LINE = 160;
const MIN_TEXT = 250;
const STATUSES = new Set(["pass", "fail", "unknown", "skip"]);
/** The crawlers the `ai-crawlers` check looks at: the ones AI assistants and AI search read sites with. */
const ASSISTANT_CRAWLERS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "PerplexityBot", "Google-Extended"];
const EXAMPLE_ENV = /^\.env(?:\.[\w-]+)*\.(?:example|sample|template|dist)(?:\.[\w-]+)*$|^\.env[-_](?:example|sample|template)$|^env\.(?:example|sample|template)$|^(?:example|sample|template)\.env$/i;
const TWO_PART_SUFFIX = /\.(?:co|com|org|net|ac|gov|edu)\.[a-z]{2}$/;

const pass = (...evidence) => ({ status: "pass", evidence });
const fail = (...evidence) => ({ status: "fail", evidence });
const unknown = (...evidence) => ({ status: "unknown", evidence });
const skip = (...evidence) => ({ status: "skip", evidence });

const NO_SITE = "no site address was given";
const NO_REPO = "the project folder was not read";

/** A page's own words inside an evidence line: quoted and cut. */
const quote = (text, max = 90) => {
  const s = String(text ?? "");
  return `"${s.length > max ? `${s.slice(0, max - 3)}...` : s}"`;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const baseOf = (path) => String(path).slice(String(path).lastIndexOf("/") + 1);

/** The home page's facts, or the "unknown" result that says why there are none. */
function page(site) {
  if (!site) return { home: null, miss: unknown(NO_SITE) };
  if (!site.home) return { home: null, miss: unknown(site.error ? `the site did not answer: ${site.error}` : "the site did not answer") };
  const status = site.home.status;
  if (!(status >= 200 && status < 300)) return { home: null, miss: unknown(`the home page answered ${status}`) };
  return { home: site.home, miss: null };
}

/** Whether the app takes payments, as far as the facts show: true, false, or null when nothing was read. */
function payments(f) {
  const provider = f.repo && f.repo.payments ? f.repo.payments.provider || null : null;
  const home = f.site && f.site.home ? f.site.home : null;
  const onPage = Boolean(home && (home.testStripeKey || home.stripe));
  if (provider || onPage) return { applies: true, stripe: provider === "stripe" || onPage };
  return { applies: f.repo || home ? false : null, stripe: false };
}

/** The repository's facts when git could say what it tracks; otherwise the result to return. */
function tracked(repo) {
  if (!repo) return unknown(NO_REPO);
  if (!repo.git || !repo.git.repo) return skip("the folder is not a git repository");
  if (!Array.isArray(repo.git.tracked)) return unknown("git could not list the tracked files");
  return null;
}

/** The mail checks apply to a domain that has mail records; otherwise the result to return. */
function mail(site) {
  if (!site) return unknown(NO_SITE);
  if (!site.dns || site.dns.mx !== true) return skip(site.dns && site.dns.mx === false ? "the domain has no mail records (MX)" : "the domain's mail records could not be read");
  return null;
}

/** @type {Check[]} */
export const CHECKS = [
  // ---- Launch ------------------------------------------------------------------------------------------------------
  {
    id: "https",
    area: "launch",
    title: "Your site does not use a secure connection (https)",
    weight: 5,
    why: 'Browsers show a "Not secure" warning on addresses that start with http, and many visitors leave when they see it. Https is the encrypted form of the same address.',
    fix: "Turn on https at your host (most hosts include it at no cost) and send every http visit to the https address.",
    prompt:
      "Make this site answer only over https. In the hosting config for this project (vercel.json, netlify.toml, wrangler.toml, the nginx or Caddy file, or the server code), add a permanent redirect (status 301) from http:// to https:// for every path, and send the response header Strict-Transport-Security: max-age=31536000. Tell me which file you changed and anything I must switch on in the host's dashboard.",
    needs: ["site"],
    run({ site }) {
      if (!site) return unknown(NO_SITE);
      const h = site.https || {};
      if (h.ok === false) return fail(`https://${site.host} did not answer over a secure connection`);
      if (h.ok !== true) return unknown(site.error ? `the site did not answer: ${site.error}` : "the https address could not be reached");
      if (h.httpRedirects === false) return fail(`http://${site.host} answers without sending visitors to https`);
      return pass(h.httpRedirects === true ? `http://${site.host} redirects to https` : `https://${site.host} answers; http://${site.host} does not answer at all`);
    },
  },
  {
    id: "www-joined",
    area: "launch",
    title: "Your site answers at two addresses, with and without www",
    weight: 2,
    why: "Search engines can treat www.example.com and example.com as two copies of one site and split your ranking between them. A visitor signed in on one is also signed out on the other.",
    fix: "Pick one as the main address and redirect the other to it, at your host or at your DNS provider (the service that points your domain name at your host).",
    prompt:
      "Make the www address and the bare address of this site end at one address. Pick the one the app already uses in its links, then add a permanent redirect (status 301) from the other one in the hosting config (vercel.json redirects, netlify.toml [[redirects]], a Cloudflare redirect rule, or the server code). List any DNS record I have to add by hand.",
    needs: ["site"],
    run({ site }) {
      if (!site) return unknown(NO_SITE);
      const w = site.www || {};
      if (w.joined === true) return pass(`${w.other} and ${site.host} end at one address`);
      if (w.joined === false) return fail(`${w.other} and ${site.host} each answer on their own`);
      const host = String(site.host || "");
      const labels = host.split(".").length - (TWO_PART_SUFFIX.test(host) ? 1 : 0);
      if (!w.other || (labels > 2 && !host.startsWith("www."))) return skip(`${host} is a subdomain, which has no www twin`);
      return unknown(`${w.other} did not answer`);
    },
  },
  {
    id: "title",
    area: "launch",
    title: "Your page has no real title",
    weight: 4,
    why: "The title is the text on the browser tab and the headline of your result in Google. A missing title, or one left over from the starter template, tells people nothing and they do not click.",
    fix: "Write a title of 10 to 65 characters that says what the product is and who it is for.",
    prompt:
      "Set the <title> of the home page to a real title of 10 to 65 characters that names the product and what it does. Find where the title is set (index.html, app/layout.tsx metadata, src/app.html, nuxt.config, or the layout's <head>) and replace the placeholder. Give every other page its own title too.",
    needs: ["site"],
    run({ site }) {
      const { home, miss } = page(site);
      if (!home) return miss;
      if (!home.title) return fail("the page has no <title>");
      if (home.defaultTitle) return fail(`the title is a starter template's: ${quote(home.title)}`);
      const n = home.title.length;
      if (n < 10 || n > 65) return fail(`the title is ${plural(n, "character", "characters")}: ${quote(home.title)}`);
      return pass(`title: ${quote(home.title)}`);
    },
  },
  {
    id: "favicon",
    area: "launch",
    title: "Your site has no icon for the browser tab",
    weight: 2,
    why: "The favicon is the small picture on the browser tab, in bookmarks and next to your result in Google. Without one, browsers show a blank page icon and the site looks unfinished.",
    fix: "Add a square icon file and link it from the head of the page.",
    prompt:
      'Add a favicon to this site. Put favicon.ico (32x32) and an icon.svg or icon.png (at least 192x192) in the public folder (public/ or static/), and add <link rel="icon" href="/favicon.ico"> to the head of the HTML (index.html, the root layout, or src/app.html). If there is a logo in the repository, make the icon from it; otherwise tell me what file you need.',
    needs: ["site"],
    run({ site }) {
      const { home, miss } = page(site);
      if (!home) return miss;
      if (home.favicon === true) return pass("the page has an icon");
      if (home.favicon === false) return fail('no <link rel="icon"> in the page, and /favicon.ico is not an icon file');
      return unknown("/favicon.ico could not be read");
    },
  },
  {
    id: "not-found-page",
    area: "launch",
    title: "Missing pages answer as if they exist",
    weight: 2,
    why: 'A wrong address on your site answers with status 200, the code for "this page exists", where it should answer 404, "not found". Search engines then index empty pages, and a visitor who follows a broken link gets no clear message.',
    fix: 'Add a "page not found" page and make the server answer 404 for addresses that match no page.',
    prompt:
      "Addresses that match no page on this site answer with HTTP status 200. Add a not-found page (app/not-found.tsx in Next.js, src/routes/+error.svelte in SvelteKit, error.vue in Nuxt, src/pages/404.astro in Astro, public/404.html on a static host) and make sure the server sends status 404 for unknown paths. For a single-page app with a catch-all rewrite to index.html, keep the rewrite for real routes only, or add a 404.html the host can serve.",
    needs: ["site"],
    run({ site }) {
      if (!site) return unknown(NO_SITE);
      const status = site.notFound ? site.notFound.status : null;
      if (status == null) return unknown("the answer for a missing page could not be read");
      if (status >= 200 && status < 300) return fail(`an address that cannot exist answered ${status}`);
      if (status >= 400 && status < 500) return pass(`an address that cannot exist answered ${status}`);
      return unknown(`an address that cannot exist answered ${status}`);
    },
  },
  {
    id: "mobile-viewport",
    area: "launch",
    title: "Your page is not set up for phone screens",
    weight: 3,
    why: "Without the viewport tag, a phone draws the page at desktop width and shrinks it, so the text is too small to read. Most visits are on phones, and Google ranks a page by how it works on one.",
    fix: "Add the viewport tag to the head of every page.",
    prompt:
      'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the head of the HTML this app sends (index.html, the root layout, src/app.html, or the framework\'s head config). Then check the home page at 375 pixels wide and fix anything that overflows sideways.',
    needs: ["site"],
    run({ site }) {
      const { home, miss } = page(site);
      if (!home) return miss;
      return home.viewport ? pass("the page has a viewport tag") : fail('no <meta name="viewport"> in the page');
    },
  },
  {
    id: "staging",
    area: "launch",
    title: "You have nowhere to try a change before users see it",
    weight: 3,
    why: "Each change goes straight to the live site, so a mistake reaches real users the moment you push. A preview is a private copy of the site built for one change; a staging site is a second copy you test on first.",
    fix: "Turn on preview builds for pull requests at your host, or set up a second copy of the app as a staging site.",
    prompt:
      "Set up a place to try changes for this app before they reach users. Read the hosting config in this repository, then either turn on a preview build for each pull request (Vercel, Netlify and Cloudflare do this once the repository is connected) or add a staging environment (for Cloudflare, an [env.staging] section in wrangler.toml; for Fly or Render, a second app with its own config). Add a deploy command or workflow for it and tell me what I must set up in the host's dashboard.",
    needs: ["repo"],
    run({ repo }) {
      if (!repo) return unknown(NO_REPO);
      const h = repo.hosting || {};
      if (h.previews === true) return pass(h.provider === "vercel" || h.provider === "netlify" ? `${h.provider} builds a preview for each pull request` : `hosting: ${h.provider}, with a preview or a second environment set up`);
      if (h.staging === true) return pass("a staging setup is in the project files");
      if (h.staging === false) return fail(`hosting: ${h.provider}; no preview or staging setup in the project files`);
      return unknown(h.provider ? `hosting: ${h.provider}; its preview setting is in the host's dashboard, which was not read` : "the project files do not show where this app is hosted");
    },
  },

  // ---- Search ------------------------------------------------------------------------------------------------------
  {
    id: "description",
    area: "search",
    title: "Your search result description is missing or the wrong length",
    weight: 3,
    why: "The meta description is the short text under your title in Google results. Without one of a useful length, Google picks text from the page on its own, and fewer people click.",
    fix: "Write one or two sentences, 50 to 160 characters, that say what the product does.",
    prompt:
      'Add <meta name="description" content="..."> to the head of the home page with 50 to 160 characters that say what this product does and for whom. Find where head tags are set (index.html, app/layout.tsx metadata, src/app.html, nuxt.config, or the layout component) and give each main page its own description.',
    needs: ["site"],
    run({ site }) {
      const { home, miss } = page(site);
      if (!home) return miss;
      if (!home.description) return fail('no <meta name="description"> in the page');
      const n = home.description.length;
      if (n < 50 || n > 160) return fail(`the description is ${plural(n, "character", "characters")}: ${quote(home.description, 70)}`);
      return pass(`description: ${quote(home.description, 70)}`);
    },
  },
  {
    id: "link-preview",
    area: "search",
    title: "Links to your site show no preview card",
    weight: 3,
    why: "When someone shares your link in WhatsApp, Slack, iMessage or on X, the app reads the page's Open Graph tags (og:title, og:description, og:image) to draw a card with a picture. Without them the link is plain text and fewer people open it.",
    fix: "Add the three tags and an image of 1200 by 630 pixels.",
    prompt:
      'Add link preview tags to the head of the home page: <meta property="og:title">, <meta property="og:description">, <meta property="og:image"> with an absolute https address, and <meta name="twitter:card" content="summary_large_image">. Put a 1200x630 PNG in the public folder for the image (in Next.js, app/opengraph-image.png works). Use the page\'s real title and description.',
    needs: ["site"],
    run({ site }) {
      const { home, miss } = page(site);
      if (!home) return miss;
      const og = home.og || {};
      const missing = [!og.title && "og:title", !og.description && "og:description", !og.image && "og:image"].filter(Boolean);
      return missing.length ? fail(`missing in the page: ${missing.join(", ")}`) : pass("og:title, og:description and og:image are in the page");
    },
  },
  {
    id: "canonical",
    area: "search",
    title: "Your page does not name its main address",
    weight: 2,
    why: "One page can be reached at several addresses, for example with ?ref=x at the end or with and without a trailing slash. A canonical tag tells search engines which address to rank, so the copies do not compete with each other.",
    fix: "Add a canonical link tag with the page's full address.",
    prompt:
      'Add <link rel="canonical" href="..."> to the head of every page, holding that page\'s full https address without query parameters. In Next.js use metadata.alternates.canonical with metadataBase; in Astro, SvelteKit and Nuxt build it from the site address in the config and the current path.',
    needs: ["site"],
    run({ site }) {
      const { home, miss } = page(site);
      if (!home) return miss;
      return home.canonical ? pass(`canonical: ${home.canonical}`) : fail('no <link rel="canonical"> in the page');
    },
  },
  {
    id: "robots-txt",
    area: "search",
    title: "robots.txt is missing or tells search engines to stay out",
    weight: 4,
    why: 'robots.txt is a small text file at the top of your site that tells search engines which pages they may read. If it is missing they have to guess, and if it or a "noindex" tag blocks them, your site does not appear in search results.',
    fix: "Add a robots.txt that allows your public pages and names your sitemap, and remove any noindex tag from pages you want found.",
    prompt:
      'Make /robots.txt on this site answer with a plain text file that allows crawling: "User-agent: *", then "Allow: /", then "Sitemap: https://<the site address>/sitemap.xml". Put it in the public folder (public/robots.txt or static/robots.txt), or use app/robots.ts in Next.js. Remove any "Disallow: /" that covers the whole site, any <meta name="robots" content="noindex"> and any X-Robots-Tag: noindex header on public pages.',
    needs: ["site"],
    run({ site }) {
      if (!site) return unknown(NO_SITE);
      if (site.home && site.home.noindex) return fail("the home page says noindex (a robots meta tag or an X-Robots-Tag header)");
      const r = site.robots || {};
      if (r.status == null) return unknown("/robots.txt could not be read");
      if (r.status >= 500 || r.status === 429) return unknown(`/robots.txt answered ${r.status}`);
      if (r.status !== 200) return fail(`/robots.txt answered ${r.status}`);
      if (r.html) return fail("/robots.txt answered with an HTML page, not a robots file");
      if (r.allowsAll === false) return fail('robots.txt has "Disallow: /" for "User-agent: *"');
      return pass("/robots.txt answered 200 and allows crawling");
    },
  },
  {
    id: "sitemap",
    area: "search",
    title: "Your site has no sitemap",
    weight: 3,
    why: "A sitemap is a file that lists every page of your site. Search engines read it to find pages that nothing links to yet, so new pages reach search results sooner.",
    fix: "Generate sitemap.xml when the site is built and name it in robots.txt.",
    prompt:
      'Add a sitemap to this site at /sitemap.xml that lists every public page with its full https address. Use the framework\'s own way: app/sitemap.ts in Next.js, @astrojs/sitemap in Astro, @nuxtjs/sitemap in Nuxt, a src/routes/sitemap.xml/+server.ts route in SvelteKit, or a build script that writes public/sitemap.xml. Then add a "Sitemap:" line with its address to robots.txt.',
    needs: ["site"],
    run({ site }) {
      if (!site) return unknown(NO_SITE);
      const m = site.sitemap || {};
      if (m.status == null) return unknown("the sitemap could not be read");
      if (m.status === 200 && m.valid === true) return pass(`${m.url} lists ${plural(m.urls ?? 0, "address", "addresses")}`);
      if (m.status === 200 && m.valid == null) return unknown(`${m.url} answered 200 but could not be parsed`);
      if (m.status === 200) return fail(`${m.url} answered 200 but is not a sitemap`);
      if (m.status >= 500 || m.status === 429) return unknown(`${m.url} answered ${m.status}`);
      return fail(`${m.url} answered ${m.status}`);
    },
  },
  {
    id: "one-h1",
    area: "search",
    title: "Your page does not have exactly one main heading",
    weight: 2,
    why: "The h1 is the main headline of a page. Search engines, and screen readers (programs that read a page aloud for blind visitors), use it to tell what the page is about. None, or several, leaves that unclear.",
    fix: "Give each page one h1 that says what the page is, and use h2 and h3 for the headings under it.",
    prompt:
      "Make the home page send exactly one <h1> in its HTML, holding the main headline. Change any other <h1> to <h2> or lower, and if the headline is a <div> or <p> today, make it the <h1>. Check the other pages for the same rule.",
    needs: ["site"],
    run({ site }) {
      const { home, miss } = page(site);
      if (!home) return miss;
      const h1 = Array.isArray(home.h1) ? home.h1 : [];
      if (h1.length === 1) return pass(`h1: ${quote(h1[0])}`);
      if (h1.length === 0) return fail("no <h1> in the HTML the server sends");
      return fail(`${h1.length} <h1> headings in the page`, ...h1.slice(0, 2).map((t) => `h1: ${quote(t)}`));
    },
  },
  {
    id: "structured-data",
    area: "search",
    title: "Your page has no structured data",
    weight: 1,
    why: "Structured data is a small block of facts about your product in a format programs can read (JSON-LD): its name, logo, price and reviews. Google uses it to show richer results, and AI assistants use it to describe you correctly.",
    fix: "Add a JSON-LD block that describes the product or the organisation.",
    prompt:
      'Add a <script type="application/ld+json"> block to the head of the home page with schema.org data that fits this product: Organization and WebSite, plus SoftwareApplication or Product with name, description, url and offers if there is a price. Fill it only with facts that are true in this repository and leave out what you cannot confirm.',
    needs: ["site"],
    run({ site }) {
      const { home, miss } = page(site);
      if (!home) return miss;
      return home.jsonLd ? pass("the page has a JSON-LD block") : fail('no <script type="application/ld+json"> in the page');
    },
  },
  {
    id: "html-lang",
    area: "search",
    title: "Your page does not say what language it is in",
    weight: 1,
    why: "The lang attribute tells browsers, translation tools and screen readers which language the page is written in. Without it they guess, and the page can be read aloud with the wrong accent or offered for translation by mistake.",
    fix: "Add the language code to the html tag.",
    prompt:
      'Add a lang attribute to the <html> tag this app sends, for example <html lang="en">, using the language the pages are written in. It is set in index.html, app/layout.tsx, src/app.html, or the framework\'s head config.',
    needs: ["site"],
    run({ site }) {
      const { home, miss } = page(site);
      if (!home) return miss;
      return home.lang ? pass(`<html lang=${quote(home.lang, 20)}>`) : fail("the <html> tag has no lang attribute");
    },
  },

  // ---- AI assistants -----------------------------------------------------------------------------------------------
  {
    id: "ai-crawlers",
    area: "ai",
    title: "Your robots.txt blocks AI assistants",
    weight: 4,
    why: "ChatGPT, Claude, Perplexity and Google's AI answers read sites with their own crawlers (programs that fetch pages). Your robots.txt tells some of them to stay out, so they cannot quote or recommend your site.",
    fix: "Remove the rules that block them, unless you chose to keep AI assistants out.",
    prompt:
      'Edit robots.txt in this repository (public/robots.txt, static/robots.txt, or app/robots.ts) so that it does not disallow "/" for GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, PerplexityBot or Google-Extended, by name or through "User-agent: *". Keep the Disallow lines for private paths such as /api or /admin. If the file is written by the host or a plugin, tell me where to change that setting.',
    needs: ["site"],
    run({ site }) {
      if (!site) return unknown(NO_SITE);
      const r = site.robots || {};
      if (r.status == null) return unknown("/robots.txt could not be read");
      if (r.status >= 500 || r.status === 429) return unknown(`/robots.txt answered ${r.status}`);
      const blocked = (Array.isArray(r.blockedAi) ? r.blockedAi : []).filter((name) => ASSISTANT_CRAWLERS.includes(name));
      if (blocked.length) return fail(`robots.txt keeps out: ${blocked.join(", ")}`);
      return pass(r.status === 200 && !r.html ? "robots.txt keeps no AI crawler out of the site" : "no robots.txt, so no AI crawler is kept out");
    },
  },
  {
    id: "text-without-js",
    area: "ai",
    title: "Your page is empty until JavaScript runs",
    weight: 5,
    why: "The server sends a page with almost no text, and JavaScript fills it in afterwards. AI assistants and link previews do not run JavaScript, and search engines index such pages late or not at all, so they see a blank site.",
    fix: "Render the page to HTML on the server or when the site is built (often called SSR or prerendering), so the text is in the first response.",
    prompt:
      "The HTML this app's server sends for the home page holds almost no visible text; the content appears only after JavaScript runs. Change the app so public pages are rendered to HTML on the server or at build time. In a Vite single-page app, add prerendering (for example vite-react-ssg or vite-ssg) or move the public pages to a framework that renders on the server. In Next.js, keep the page a server component and do not load its content in useEffect. In SvelteKit, Nuxt and Astro, check that ssr and prerender are not turned off. Check the result with curl -s <the site address> and look for the page's text.",
    needs: ["site"],
    run({ site }) {
      const { home, miss } = page(site);
      if (!home) return miss;
      const n = Number(home.textChars) || 0;
      if (n >= MIN_TEXT) return pass(`${n} characters of text in the HTML the server sends`);
      return fail(`${plural(n, "character", "characters")} of visible text in the HTML the server sends`, `${plural(Number(home.scripts) || 0, "script tag", "script tags")} in the page`);
    },
  },
  {
    id: "llms-txt",
    area: "ai",
    title: "Your site has no llms.txt",
    weight: 1,
    why: "llms.txt is a plain text file that gives AI assistants a short summary of your site and links to its main pages. It is a young convention and not every assistant reads it, but it takes a few minutes to add.",
    fix: "Add llms.txt to the top of your site.",
    prompt:
      'Add a file served at /llms.txt (public/llms.txt or static/llms.txt) in Markdown: a first line "# <product name>", a one-paragraph summary in a block quote, then a "## Pages" list of links to the main pages with one line about each. Use only facts from this repository.',
    needs: ["site"],
    run({ site }) {
      if (!site) return unknown(NO_SITE);
      const l = site.llms || {};
      if (l.status == null) return unknown("/llms.txt could not be read");
      if (l.status === 200) return l.html ? fail("/llms.txt answered with an HTML page, not a text file") : pass("/llms.txt answered 200");
      if (l.status >= 500 || l.status === 429) return unknown(`/llms.txt answered ${l.status}`);
      return fail(`/llms.txt answered ${l.status}`);
    },
  },

  // ---- Payments ----------------------------------------------------------------------------------------------------
  {
    id: "test-keys-live",
    area: "payments",
    title: "Your live site uses a Stripe test key, so nobody can pay",
    weight: 5,
    why: "Stripe gives you two sets of keys: test keys (pk_test_, sk_test_) for trying things out with fake cards, and live keys for real money. With a test key on the live site, a real card is refused and you earn nothing.",
    fix: "Put the live keys from your Stripe dashboard in the production settings of your host, and keep the test keys for your own machine and for previews.",
    prompt:
      "The production setup of this app uses a Stripe test key (pk_test_ or sk_test_). Find where the Stripe keys are read (search for STRIPE and pk_test), make the code read them from environment variables only, and remove any key written in .env.production or the hosting config. Do not print any key. Then list the variable names I must set to my live keys in the host's production settings.",
    needs: ["repo", "site"],
    run(f) {
      const p = payments(f);
      if (p.applies === null) return unknown("neither the project folder nor the site was read");
      if (!p.applies || !p.stripe) return skip("no Stripe payments found in this app");
      const found = [];
      if (f.site && f.site.home && f.site.home.testStripeKey) found.push("the live page holds a Stripe test key (pk_test_)");
      const files = f.repo && f.repo.payments && Array.isArray(f.repo.payments.testKeyInProduction) ? f.repo.payments.testKeyInProduction : [];
      for (const file of files) found.push(`${file} holds a Stripe test key`);
      if (found.length) return fail(...found);
      const { home } = page(f.site);
      if (home) return pass("no pk_test_ key in the HTML of the live page");
      return unknown("the live page was not read; no test key in production env files or hosting config");
    },
  },
  {
    id: "secret-in-client",
    area: "payments",
    title: "A Stripe secret key is in code that ships to the browser",
    weight: 5,
    why: "A secret key (sk_live_ or sk_test_) lets its holder charge cards, refund payments and read your customers' details. Code in src, app, pages, components and public is sent to every visitor's browser, where anyone can read it.",
    fix: "Create a new secret key in Stripe and delete the old one, then use the key only in server code that reads it from an environment variable.",
    prompt:
      "A Stripe secret key (sk_live_ or sk_test_) is written in client-side source files in this repository. Remove it from those files, move every Stripe call that needs it into server code (an API route, a server action or a serverless function) that reads process.env.STRIPE_SECRET_KEY, and keep only the publishable key (pk_) in the browser. Do not print the key. Remind me to roll the key in the Stripe dashboard, because it is in the git history.",
    needs: ["repo"],
    run(f) {
      const p = payments(f);
      if (p.applies === null) return unknown(NO_REPO);
      if (!p.applies || !p.stripe) return skip("no Stripe payments found in this app");
      if (!f.repo) return unknown(NO_REPO);
      const files = f.repo.payments && Array.isArray(f.repo.payments.secretInClient) ? f.repo.payments.secretInClient : [];
      if (!files.length) return pass("no Stripe secret key in client source files");
      if (files.length <= MAX_EVIDENCE) return fail(...files.map((file) => `${file} holds a Stripe secret key`));
      return fail(...files.slice(0, 2).map((file) => `${file} holds a Stripe secret key`), `and ${files.length - 2} more files`);
    },
  },
  {
    id: "pricing-visible",
    area: "payments",
    title: "Visitors cannot see what your product costs",
    weight: 3,
    why: "The app takes payments, but the home page shows no price and no link to a pricing page. People who cannot find the price in a few seconds usually leave without asking.",
    fix: "Show the price on the home page, or link to a pricing page from the top menu.",
    prompt:
      'This app takes payments but the home page shows no price and has no link to pricing. Add a pricing section to the home page or a /pricing page that lists each plan, its price and billing period, and what it includes, taken from the plans defined in the code or the payment provider config. Link to it from the main navigation with the text "Pricing".',
    needs: ["repo", "site"],
    run(f) {
      const p = payments(f);
      if (p.applies === null) return unknown("neither the project folder nor the site was read");
      if (!p.applies) return skip("no payments found in this app");
      const { home, miss } = page(f.site);
      if (!home) return miss;
      if (home.pricingLink) return pass("the home page links to a pricing page");
      if (home.mentionsPrice) return pass("the home page shows a price");
      if ((Number(home.textChars) || 0) < MIN_TEXT) return unknown("the page's text is drawn by JavaScript, so it could not be read for a price");
      return fail("no price and no link to a pricing page on the home page");
    },
  },

  // ---- Safety ------------------------------------------------------------------------------------------------------
  {
    id: "env-committed",
    area: "safety",
    title: "A file with your secret keys is saved in git",
    weight: 5,
    why: "A .env file holds passwords and API keys, the secret codes that let your app use paid services. Once it is in git, everyone who can see the repository, now or later, can copy them and run up bills in your name.",
    fix: "Take the file out of git, add it to .gitignore, and replace every key that was in it, because old copies stay in the history.",
    prompt:
      "One or more .env files are tracked by git in this repository. For each, run git rm --cached <file> (keep the file on disk), add .env and .env.* to .gitignore with an exception for .env.example, and create .env.example with the same variable names and empty values. Do not print any value. Then list every variable I must now replace with a new key at its provider, because the old values are in the git history.",
    needs: ["repo"],
    run({ repo }) {
      const miss = tracked(repo);
      if (miss) return miss;
      const files = repo.env && Array.isArray(repo.env.tracked) ? repo.env.tracked : [];
      if (!files.length) return pass("git tracks no .env file with values in it");
      if (files.length <= MAX_EVIDENCE) return fail(...files.map((file) => `${file} is tracked by git`));
      return fail(...files.slice(0, 2).map((file) => `${file} is tracked by git`), `and ${files.length - 2} more .env files`);
    },
  },
  {
    id: "secrets-in-repo",
    area: "safety",
    title: "Secret keys are written in your code",
    weight: 5,
    why: "API keys and private keys in files that git tracks can be read by everyone who can see the repository, and bots scan public code for keys within minutes. A stolen key can spend your money or read your users' data.",
    fix: "Replace each key with a new one at its provider, and load keys from environment variables that are not saved in git.",
    prompt:
      "Secret-looking keys are written in files that git tracks in this repository (the report lists the kind, file and line of each). For each one, replace the value in the file with a read from an environment variable, add the variable name to .env.example with an empty value, and make sure .env is in .gitignore. Do not print any value. Then list which keys I must roll at their providers, because the old values stay in the git history.",
    needs: ["repo"],
    run({ repo }) {
      if (!repo) return unknown(NO_REPO);
      if (repo.git && repo.git.repo && !Array.isArray(repo.git.tracked)) return unknown("git could not list the tracked files");
      const found = Array.isArray(repo.secrets) ? repo.secrets : [];
      if (!found.length) return pass(repo.git && repo.git.repo ? "no secret-looking key in the files git tracks" : "no secret-looking key in the project files");
      const line = (s) => `${s.kind} in ${s.file}, line ${s.line}`;
      if (found.length <= MAX_EVIDENCE) return fail(...found.map(line));
      return fail(...found.slice(0, 2).map(line), `and ${found.length - 2} more`);
    },
  },
  {
    id: "env-example",
    area: "safety",
    title: "Your settings file has no example for the next person",
    weight: 1,
    why: "Your app reads settings and keys from a .env file that is not shared. Without a .env.example that lists the variable names, a teammate or a coding agent cannot tell what the app needs to start.",
    fix: "Add .env.example with every variable name and no real values.",
    prompt:
      "Create .env.example in this repository. List every environment variable the app reads (search for process.env, import.meta.env and the names in the local .env files, without printing their values), one per line as NAME= with an empty value and a short comment that says what it is for and where to get it. Make sure .gitignore keeps .env out and lets .env.example in.",
    needs: ["repo"],
    run({ repo }) {
      if (!repo) return unknown(NO_REPO);
      const env = repo.env || {};
      const real = (Array.isArray(env.files) ? env.files : []).filter((file) => !EXAMPLE_ENV.test(baseOf(file)));
      if (!real.length) return skip("the project has no .env file");
      if (env.example) return pass("the project has an example env file");
      return fail(`${real.slice(0, 3).join(", ")} ${real.length === 1 ? "is" : "are"} here, with no .env.example`);
    },
  },

  // ---- Quality -----------------------------------------------------------------------------------------------------
  {
    id: "tests",
    area: "quality",
    title: "Your app has no automated tests",
    weight: 2,
    why: "A test is a small program that uses your app and checks the result. Without any, a change by you or by a coding agent can break something that worked, and you find out when a user does.",
    fix: "Start with one test for the path that matters most, such as sign-up or checkout.",
    prompt:
      'Add automated tests to this repository. Install Vitest for unit tests of the main logic and Playwright for one end-to-end test of the most important flow (sign-up, checkout or the main action of the app). Add a "test" script to package.json that runs them, write the first tests so that they pass, and tell me how to run them.',
    needs: ["repo"],
    run({ repo }) {
      if (!repo) return unknown(NO_REPO);
      const t = repo.tests || {};
      const n = Number(t.files) || 0;
      if (n > 0) return pass(plural(n, "test file", "test files"), ...(t.runner ? [`runner: ${t.runner}`] : []));
      if (t.script) return unknown('package.json has a "test" script, but no test files were found');
      if (repo.truncated) return unknown("the project has more files than were listed, and none of the listed ones is a test");
      return fail("no test files in the project");
    },
  },
  {
    id: "ci",
    area: "quality",
    title: "Nothing runs your tests before a change is merged",
    weight: 3,
    why: "CI is a service that runs your tests on every pull request, the page where a change waits before it joins the main code. Without it, a broken change is merged because nobody ran the tests.",
    fix: "Add a GitHub Actions workflow that installs the app and runs the tests on each pull request.",
    prompt:
      "Add .github/workflows/ci.yml to this repository: on pull_request and on push to the main branch, check out the code, set up Node with the version this project uses, install with the lockfile (npm ci, pnpm install --frozen-lockfile or yarn install --immutable), then run the build and the test script. If there is no test script yet, add one first.",
    needs: ["repo"],
    run({ repo }) {
      if (!repo) return unknown(NO_REPO);
      const ci = repo.ci || {};
      const workflows = Array.isArray(ci.workflows) ? ci.workflows : [];
      const good = workflows.find((w) => w.onPullRequest && w.runsTests);
      if (good) return pass(`${good.file} runs the tests on pull requests`);
      const other = Array.isArray(ci.other) ? ci.other : [];
      if (other.length) return unknown(`${other[0]} is here; only GitHub Actions workflows are read`);
      if (!workflows.length) return fail("no workflow files in .github/workflows");
      const tests = workflows.find((w) => w.runsTests);
      if (tests) return fail(`${tests.file} runs tests, but not on pull requests`);
      const pulls = workflows.find((w) => w.onPullRequest);
      // GenClass's own workflow runs the tests once more under GenClass in a job that is allowed to fail: it is no gate
      if (pulls && /genclass/i.test(pulls.file) && workflows.length === 1) return fail(`no workflow runs your tests as a check on pull requests (${pulls.file} is GenClass's separate run, which never blocks a merge)`);
      if (pulls) return fail(`${pulls.file} runs on pull requests, but runs no tests`);
      return fail(`${plural(workflows.length, "workflow", "workflows")} in .github/workflows, none runs tests on pull requests`);
    },
  },
  {
    id: "error-visibility",
    area: "quality",
    title: "You cannot see the errors your users hit",
    weight: 3,
    why: "When something breaks in a visitor's browser, nothing tells you. Most people do not report a problem; they leave, and you never learn why.",
    fix: "Add a tool that reports errors and wrong behaviour from real visits. Run npx genclass in this folder to add the GenClass runtime, or add Sentry.",
    prompt:
      "Nothing in this app reports errors or wrong behaviour from real users. Run `npx genclass` in this repository and follow its steps: it adds the GenClass runtime to the app's entry file, which reports errors and wrong behaviour (such as a stale response or a duplicate request) from real visits. Show me the lines it changed.",
    needs: ["repo"],
    run({ repo }) {
      if (!repo) return unknown(NO_REPO);
      const m = repo.monitoring || {};
      const tools = [m.genclass && "GenClass", m.sentry && "Sentry", ...(Array.isArray(m.other) ? m.other : [])].filter(Boolean);
      return tools.length ? pass(`in the project: ${tools.join(", ")}`) : fail("no error reporting in the dependencies or the entry files");
    },
  },
  {
    id: "readme",
    area: "quality",
    title: "Your README does not describe your app",
    weight: 1,
    why: "The README is the first page people and coding agents read in a repository. If it is missing or still holds the starter template's text, nobody can tell what the app does or how to run it.",
    fix: "Write a short README: what the app is, how to run it, how it is deployed.",
    prompt:
      "Rewrite README.md for this repository. Read the code first, then write: one paragraph on what the app does, the commands to install, run and test it (from package.json), the environment variables it needs (names only), and how it is deployed. Remove the framework template's text. Keep it under one page.",
    needs: ["repo"],
    run({ repo }) {
      if (!repo) return unknown(NO_REPO);
      const r = repo.readme || {};
      if (!r.exists) return fail("no README file in the project");
      if (r.boilerplate) return fail("the README is still the starter template's text");
      return pass(`README of ${plural(Number(r.chars) || 0, "character", "characters")}`);
    },
  },
  {
    id: "lockfile",
    area: "quality",
    title: "Your dependency versions are not pinned",
    weight: 1,
    why: "A lockfile records the exact version of every package your app installed. Without it, each install can pull newer versions, so the app can break on the host without any change from you.",
    fix: "Run your package manager's install once and save the lockfile it writes in git.",
    prompt:
      "This project has a package.json but no lockfile. Run the install command of the package manager the project uses (npm install, pnpm install, yarn or bun install), commit the lockfile it writes (package-lock.json, pnpm-lock.yaml, yarn.lock or bun.lock), and remove the lockfile's name from .gitignore if it is listed there.",
    needs: ["repo"],
    run({ repo }) {
      if (!repo) return unknown(NO_REPO);
      if (!repo.pkg) return skip("the project has no package.json");
      return repo.lockfile ? pass(`lockfile: ${repo.lockfile}`) : fail("package.json is here, with no package-lock.json, pnpm-lock.yaml, yarn.lock or bun.lock");
    },
  },

  // ---- Email -------------------------------------------------------------------------------------------------------
  {
    id: "email-spf",
    area: "email",
    title: "Mail from your domain can land in spam: no SPF record",
    weight: 3,
    why: "SPF is a line in your domain's DNS settings (the records that say where your domain's site and mail live) that lists which services may send email as you. Without it, Gmail and Outlook treat your sign-up and receipt emails as suspect.",
    fix: "Add the SPF record your email service gives you at your DNS provider.",
    prompt:
      "This domain receives mail but has no SPF record. Find which service this app sends email with (search the code and config for resend, sendgrid, postmark, mailgun, ses or smtp) and tell me the exact TXT record to add at the DNS provider for the bare domain, in the form: v=spf1 include:<the service's SPF domain> ~all. If the repository manages DNS in code, add it there.",
    needs: ["site"],
    run({ site }) {
      const miss = mail(site);
      if (miss) return miss;
      if (site.dns.spf == null) return unknown("the domain's TXT records could not be read");
      return site.dns.spf ? pass("the domain has a v=spf1 record") : fail("the domain has mail records (MX) and no v=spf1 record");
    },
  },
  {
    id: "email-dmarc",
    area: "email",
    title: "Mail from your domain can land in spam: no DMARC record",
    weight: 3,
    why: "DMARC is a DNS record that tells mail providers what to do with email that claims to be from your domain but fails the sender checks. Gmail and Yahoo require it from anyone who sends in bulk, and without it others can send mail that looks like yours.",
    fix: "Add a DMARC record at your DNS provider, starting with a policy that only reports.",
    prompt:
      "This domain receives mail but has no DMARC record. Tell me the TXT record to add at the DNS provider under the name _dmarc.<the domain>: v=DMARC1; p=none; rua=mailto:<an address I read>. Explain in two sentences when to move from p=none to p=quarantine. If the repository manages DNS in code, add it there.",
    needs: ["site"],
    run({ site }) {
      const miss = mail(site);
      if (miss) return miss;
      if (site.dns.dmarc == null) return unknown("the record at _dmarc could not be read");
      return site.dns.dmarc ? pass("the domain has a v=DMARC1 record") : fail("the domain has mail records (MX) and no v=DMARC1 record at _dmarc");
    },
  },
];

// Shapes of secrets, to clean evidence with. Evidence is built from kinds, files and lines, so these should never
// match; they are here so that a page's own text (a title, a heading) cannot carry one out either.
const SECRET_SHAPES = [
  /(?<![A-Za-z0-9_])[sr]k_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}/g,
  /(?<![A-Za-z0-9_])(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/g,
  /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g,
  /\b(?:[A-Za-z_][A-Za-z0-9_]*)?(?:SECRET|TOKEN|PASSWORD|API_?KEY)=\S+/gi,
];
// Control characters, zero-width and direction marks, and the Unicode line separators (built from a string, so this
// file holds none of them itself).
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]", "g");

/** At most 3 lines of at most 160 characters, without control characters or anything shaped like a secret. */
function cleanEvidence(lines) {
  const out = [];
  for (const raw of Array.isArray(lines) ? lines : []) {
    if (out.length >= MAX_EVIDENCE) break;
    let s = String(raw ?? "");
    for (const shape of SECRET_SHAPES) s = s.replace(shape, "[redacted]");
    s = s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
    if (!s) continue;
    if (s.length > MAX_LINE) s = `${s.slice(0, MAX_LINE - 3).replace(/[\ud800-\udbff]$/, "")}...`;
    out.push(s);
  }
  return out;
}

/**
 * Every check's result, in catalog order. `skip`: the check does not apply to this app (no payments, no email).
 * `unknown`: the facts it needs are missing. Evidence: at most 3 lines of at most 160 characters, facts only (a
 * status code, a tag's text, a file and line), with control characters removed. Never throws.
 * @param {{ repo?: RepoFacts | null, site?: SiteFacts | null }} facts
 * @returns {{ id: string, area: keyof typeof AREAS, title: string, weight: 1|2|3|4|5, status: "pass" | "fail" | "unknown" | "skip", evidence: string[], why: string, fix: string, prompt: string }[]}
 */
export function runChecks(facts) {
  const given = facts && typeof facts === "object" ? facts : {};
  const f = { repo: given.repo && typeof given.repo === "object" ? given.repo : null, site: given.site && typeof given.site === "object" ? given.site : null };
  return CHECKS.map((check) => {
    let result = null;
    try {
      result = check.run(f);
    } catch {
      result = null;
    }
    const status = result && STATUSES.has(result.status) ? result.status : "unknown";
    return { id: check.id, area: check.area, title: check.title, weight: check.weight, status, evidence: cleanEvidence(result ? result.evidence : []), why: check.why, fix: check.fix, prompt: check.prompt };
  });
}
