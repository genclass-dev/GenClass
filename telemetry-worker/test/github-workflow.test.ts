// The link that opens GitHub's new-file editor with the workflow file filled in (src/github/workflow-file.ts): the
// file's text against the docs file, the address and what it refuses, where the app shows the link (a check that has
// no race files to read, and /github/setup) and where it never does (a comment, a reply, an inline comment, an issue),
// with GITHUB_APP_WORKFLOW_LINK on and off.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { githubApp } from "../src/github/config.js";
import { noEvidence } from "../src/github/evidence.js";
import { DOCS_URL, SETUP_URL } from "../src/github/handlers.js";
import { githubSetupPage } from "../src/github/pages.js";
import { emptyState, mergeFindings, renderCheck, renderIntro, renderStopped, renderSummary, renderUnsettled, summaryOf, type ReviewModel } from "../src/github/review.js";
import { DEFAULT_SETTINGS } from "../src/github/settings.js";
import { BRANCH_RE, FULL_NAME_RE, MAX_LINK_CHARS, WORKFLOW_ARTIFACT, WORKFLOW_FILE, WORKFLOW_LINK_JS, WORKFLOW_PATH, workflowLink, workflowLinkData, type WorkflowLinkData } from "../src/github/workflow-file.js";
import { call, resetClock } from "./account-helpers.js";
import { APP_ID, commentEvent, deliver, fakeGithub, githubSetup, INSTALLATION, installationCreated, pull, pullEvent, pullRequest, raceFile, races, racesZip, REPO, result, runEvent, SHA1, SHA2, SHA3 } from "./github-helpers.js";

beforeEach(() => {
  resetClock();
});

const WEB = "https://github.com";
const ON = { GITHUB_APP_WORKFLOW_LINK: "on" };
/** The address for the test repository on its default branch. */
const LINK = workflowLink(WEB, "acme/shop", "main")!;
/** Anything that would show the link, or the sentence around it, in a text. */
const SHOWS_LINK = /\/new\/|filename=|value=|add one workflow file|GitHub opens it filled in/;

// what the checks say, written out: the sentence with the link, and the text as it is without the setting
const READS = (artifact = "genclass") => `This check reads the race files the [GenClass Playwright fixture](${DOCS_URL}) writes while your end-to-end tests run, from an artifact whose name starts with \`${artifact}\``;
const TWO_STEPS = "in two steps: use the fixture in your Playwright tests, and upload `test-results/genclass` from the workflow.";
const SENTENCE = (link: string) =>
  `No change to your tests: [add one workflow file](${link}). GitHub opens it filled in; you review it and commit it. It runs your Playwright suite under GenClass in a job of its own that is allowed to fail, and uploads the race files.`;
const ONCE = "This check is written once: the next one appears when a workflow run uploads race files.";
const INTRO_OFF = `${READS()}; none has been read for this repository yet. [Set it up](${SETUP_URL}) ${TWO_STEPS} ${ONCE}`;
const INTRO_ON = (link: string) => `${READS()}; none has been read for this repository yet. ${SENTENCE(link)} The other way is to [set it up](${SETUP_URL}) ${TWO_STEPS} ${ONCE}`;
const NONE_OFF = `${READS()}. [Set it up](${SETUP_URL}) ${TWO_STEPS}`;
const NONE_ON = (link: string) => `${READS()}. ${SENTENCE(link)} The other way is to [set it up](${SETUP_URL}) ${TWO_STEPS}`;

describe("github app: the workflow file a repository adds (docs/github-app/workflows/genclass.yml)", () => {
  const DOC = readFileSync(new URL("../../docs/github-app/workflows/genclass.yml", import.meta.url), "utf8");

  it("the text in the worker is the docs file, character for character", () => {
    const a = DOC.split("\n");
    const b = WORKFLOW_FILE.split("\n");
    const at = a.findIndex((line, i) => line !== b[i]);
    const where = at >= 0 ? `line ${at + 1}: the docs file has ${JSON.stringify(a[at])}, the worker has ${JSON.stringify(b[at] ?? null)}` : `the docs file has ${a.length} lines, the worker has ${b.length}`;
    expect(
      WORKFLOW_FILE === DOC,
      `WORKFLOW_FILE in telemetry-worker/src/github/workflow-file.ts and docs/github-app/workflows/genclass.yml differ (${where}). ` +
        "The docs file is the source. To bring them back in step, paste its whole text into the WORKFLOW_FILE template literal, " +
        'write every "${" there as "\\${", keep the final newline, and run this test again.',
    ).toBe(true);
  });

  it("it goes where the link says, uploads the artifact the default settings read, and installs the package the setting waits for", () => {
    expect(WORKFLOW_PATH).toBe(".github/workflows/genclass.yml");
    expect(WORKFLOW_FILE).toContain(`# Copy to ${WORKFLOW_PATH}.`);
    expect(WORKFLOW_FILE).toContain(`          name: ${WORKFLOW_ARTIFACT}\n          path: test-results/genclass\n`);
    expect(WORKFLOW_ARTIFACT.startsWith(DEFAULT_SETTINGS.artifact)).toBe(true);
    // a job of its own that is allowed to fail, as the check's sentence says
    expect(WORKFLOW_FILE).toContain("    continue-on-error: true\n");
    // why the link is off until the owner turns it on: the workflow installs this package from npm
    expect(WORKFLOW_FILE).toContain("@genclass/playwright @genclass/runtime@beta");
    // the measured sizes the cap was chosen against
    expect(WORKFLOW_FILE).toHaveLength(2495);
    expect(LINK).toHaveLength(4023);
  });
});

describe("github app: the address of GitHub's new-file editor (src/github/workflow-file.ts)", () => {
  /** The address as a browser reads it. */
  const parts = (link: string) => {
    const u = new URL(link);
    return { origin: u.origin, path: u.pathname, hash: u.hash, keys: [...u.searchParams.keys()], filename: u.searchParams.get("filename"), value: u.searchParams.get("value"), user: u.username + u.password };
  };

  it("the exact address for a small text", () => {
    expect(workflowLink(WEB, "acme/shop", "main", "name: x\non: push\n")).toBe("https://github.com/acme/shop/new/main?filename=.github%2Fworkflows%2Fgenclass.yml&value=name%3A%20x%0Aon%3A%20push%0A");
    // a GitHub Enterprise Server's web root, as the server's configuration gives it
    expect(workflowLink("https://ghe.acme.test", "acme/shop", "main", "a")).toBe("https://ghe.acme.test/acme/shop/new/main?filename=.github%2Fworkflows%2Fgenclass.yml&value=a");
  });

  it("the workflow file's own address: the editor on the branch, the file's name, and a value that decodes to the file", () => {
    expect(LINK.slice(0, 120)).toBe("https://github.com/acme/shop/new/main?filename=.github%2Fworkflows%2Fgenclass.yml&value=%23%20GenClass%20on%20your%20exi");
    expect(parts(LINK)).toEqual({ origin: WEB, path: "/acme/shop/new/main", hash: "", keys: ["filename", "value"], filename: WORKFLOW_PATH, value: WORKFLOW_FILE, user: "" });
    expect(LINK.length).toBeLessThan(MAX_LINK_CHARS);
  });

  it("everything but letters, digits, \"-\", \"_\" and \".\" is percent-encoded, so the address cannot end a markdown link or an attribute", () => {
    const text = "a b&c=d#e?f/g%h+i\n\t!'()*~ \"<>\" [x](y) `z` ${{ k }} $(ls) é 分支 😀\n";
    const link = workflowLink(WEB, "acme/shop", "main", text)!;
    expect(link).toMatch(/^https:\/\/github\.com\/acme\/shop\/new\/main\?filename=[A-Za-z0-9._%-]+&value=[A-Za-z0-9._%-]+$/);
    for (const c of ["!", "'", "(", ")", "*", "~", " ", '"', "<", ">", "[", "]", "`", "#", "+"]) expect(link.includes(c), c).toBe(false);
    expect(link).toContain("%21%27%28%29%2A%7E");
    expect(parts(link).value).toBe(text);
    // every percent sign starts an escape written in capitals
    expect(link.replace(/%[0-9A-F]{2}/g, "")).not.toContain("%");
  });

  it("a branch with a slash keeps its segments, each one percent-encoded by itself", () => {
    expect(workflowLink(WEB, "acme/shop", "release/2.x", "a")).toBe("https://github.com/acme/shop/new/release/2.x?filename=.github%2Fworkflows%2Fgenclass.yml&value=a");
    expect(workflowLink(WEB, "acme/shop", "feature/deep/er_1-2", "a")).toContain("/acme/shop/new/feature/deep/er_1-2?filename=");
    // what git allows in a branch and an address would read as something else stays inside its segment
    const odd = workflowLink(WEB, "acme/shop", "team/a#b&c=d%2e%2e+e;f@g!h(i)", "a")!;
    expect(odd).toBe("https://github.com/acme/shop/new/team/a%23b%26c%3Dd%252e%252e%2Be%3Bf%40g%21h%28i%29?filename=.github%2Fworkflows%2Fgenclass.yml&value=a");
    expect(parts(odd)).toMatchObject({ origin: WEB, path: "/acme/shop/new/team/a%23b%26c%3Dd%252e%252e%2Be%3Bf%40g%21h%28i%29", hash: "", keys: ["filename", "value"], filename: WORKFLOW_PATH, value: "a" });
    const named = workflowLink(WEB, "acme/shop", "分支/é", "a")!;
    expect(named).toContain("/acme/shop/new/%E5%88%86%E6%94%AF/%C3%A9?filename=");
    expect(decodeURIComponent(parts(named).path)).toBe("/acme/shop/new/分支/é");
  });

  it("a branch that is not a branch name gives no link", () => {
    const tab = String.fromCharCode(9);
    const half = String.fromCharCode(0xd800);
    const bad = [
      "", "HEAD", "@", ".", "..", "../x", "a/../b", "a/./b", "./a", ".hidden", "a/.b", "/a", "a/", "a//b", "a b", " main", "main ", `a${tab}b`, "a\nb", "a\rb",
      "a?b", "main?filename=x", "a:b", "a~1", "a^", "a*", "a[b", "a\\b", "\\\\evil.test\\x", "-a", "--help", "a.lock", "a.lock/b", "a.", "a@{b", "x".repeat(256),
      String.fromCharCode(0x7f), `a${String.fromCharCode(0x85)}b`, `a${String.fromCharCode(0x2028)}b`,
    ];
    for (const b of bad) expect(workflowLink(WEB, "acme/shop", b, "a"), JSON.stringify(b)).toBeNull();
    // half of a surrogate pair cannot be written into an address: no link, and nothing is thrown
    expect(workflowLink(WEB, "acme/shop", `a${half}`, "a")).toBeNull();
    expect(workflowLink(WEB, "acme/shop", "main", `a${half}`)).toBeNull();
    for (const b of [null, undefined, 5, {}, ["main"]]) expect(workflowLink(WEB, "acme/shop", b as never, "a")).toBeNull();
    // and the longest name that is one
    expect(workflowLink(WEB, "acme/shop", "x".repeat(255), "a")).not.toBeNull();
    for (const b of ["main", "master", "trunk", "develop", "gh-pages", "4.x", "v2", "release/1.0.x", "user/ada/fix_1", "head", "a.lockb", "HEAD/x"]) expect(BRANCH_RE.test(b), b).toBe(true);
  });

  it("a full name that is not owner/name gives no link", () => {
    const bad = [
      "", "acme", "acme/", "/shop", "acme/shop/extra", "acme/shop/../../evil/repo", "acme/..", "acme/.", "-acme/shop", "acme/sh op", "acme/shop?x=1", "acme/shop#x", "acme/shop&x", "ac%2Fme/shop",
      "ac.me/shop", "ac_me/shop", "acme\\shop", "https://evil.test/acme/shop", "evil.test/acme", "//evil.test/x", "acme/shop\n", `${"a".repeat(40)}/shop`, `acme/${"x".repeat(101)}`, "acme/分支",
    ];
    for (const n of bad) expect(workflowLink(WEB, n, "main", "a"), JSON.stringify(n)).toBeNull();
    for (const n of [null, undefined, 7, {}]) expect(workflowLink(WEB, n as never, "main", "a")).toBeNull();
    for (const n of ["acme/shop", "a/b", "Acme-Inc/.github", "acme/shop.js", "acme/_x-1", `${"a".repeat(39)}/${"x".repeat(100)}`]) {
      expect(FULL_NAME_RE.test(n), n).toBe(true);
      expect(workflowLink(WEB, n, "main", "a")).toBe(`https://github.com/${n}/new/main?filename=.github%2Fworkflows%2Fgenclass.yml&value=a`);
    }
  });

  it("whatever name and branch pass, the address stays on the web root, in that repository's editor, with the two fields and no more", () => {
    const branches = ["main", "a#b", "a&value=x", "a=b", "a%2Fb%2e", "a;b", "a@b", "a'b", 'a"b', "a<b>", "a|b", "a`b", "a{b}", "a$b", "a,b", "a+b", "a!b", "a(b)", "x/y/z", "分支"];
    for (const b of branches) {
      const link = workflowLink(WEB, "acme/shop", b)!;
      expect(link, b).not.toBeNull();
      const p = parts(link);
      expect(p, b).toMatchObject({ origin: WEB, hash: "", keys: ["filename", "value"], filename: WORKFLOW_PATH, value: WORKFLOW_FILE, user: "" });
      expect(decodeURIComponent(p.path), b).toBe(`/acme/shop/new/${b}`);
      expect(link).toMatch(/^https:\/\/github\.com\/acme\/shop\/new\/[A-Za-z0-9._%\/-]+\?filename=[A-Za-z0-9._%-]+&value=[A-Za-z0-9._%-]+$/);
    }
  });

  it("an address longer than 5,800 characters is not built", () => {
    expect(MAX_LINK_CHARS).toBe(5800);
    const base = workflowLink(WEB, "acme/shop", "main", "")!.length;
    const fits = workflowLink(WEB, "acme/shop", "main", "a".repeat(MAX_LINK_CHARS - base));
    expect(fits).toHaveLength(MAX_LINK_CHARS);
    expect(workflowLink(WEB, "acme/shop", "main", "a".repeat(MAX_LINK_CHARS - base + 1))).toBeNull();
    // the length that counts is the encoded one: a space is three characters
    expect(workflowLink(WEB, "acme/shop", "main", " ".repeat(Math.floor((MAX_LINK_CHARS - base) / 3)))).not.toBeNull();
    expect(workflowLink(WEB, "acme/shop", "main", " ".repeat(Math.floor((MAX_LINK_CHARS - base) / 3) + 1))).toBeNull();
    // the workflow file fits with the longest repository name and a branch of 255 letters; not with one of 255 characters that each take nine
    expect(workflowLink(WEB, `${"a".repeat(39)}/${"x".repeat(100)}`, "b".repeat(255))!.length).toBeLessThanOrEqual(MAX_LINK_CHARS);
    expect(workflowLink(WEB, "acme/shop", "分".repeat(255))).toBeNull();
  });

  it("the page's script builds the same address as the server, and refuses what the server refuses", () => {
    const gc = new Function(`${WORKFLOW_LINK_JS}\nreturn gcWorkflowLink;`)() as (d: WorkflowLinkData, repo: unknown, branch: unknown) => string | null;
    // through JSON, as the page's data block carries it
    const data = (text?: string): WorkflowLinkData => JSON.parse(JSON.stringify(workflowLinkData(WEB, text)));
    expect(data()).toEqual({ web: WEB, path: WORKFLOW_PATH, text: WORKFLOW_FILE, max: MAX_LINK_CHARS, repo: FULL_NAME_RE.source, branch: BRANCH_RE.source });
    const half = String.fromCharCode(0xd800);
    const repos = ["acme/shop", "a/b", "Acme-Inc/.github", "acme", "acme/shop/x", "acme/..", "acme/shop?x", "https://evil.test/a/b", "", " acme/shop", null, 5];
    const branches = ["main", "release/2.x", "a#b&c=d%2e", "分支/é", "a!'()b", "HEAD", "..", "a/../b", "a b", "a?b", "-a", "a.lock", "", "x".repeat(255), "x".repeat(256), "分".repeat(255), `a${half}`, null, 5];
    let built = 0;
    for (const r of repos) {
      for (const b of branches) {
        const want = workflowLink(WEB, r as never, b as never);
        expect(gc(data(), r, b), `${JSON.stringify(r)} ${JSON.stringify(b)}`).toBe(want);
        if (want) built++;
      }
    }
    expect(built).toBeGreaterThanOrEqual(3 * 6);
    expect(gc(data(), "acme/shop", "main")).toBe(LINK);
    // the cap, and a text that cannot be encoded
    const base = workflowLink(WEB, "acme/shop", "main", "")!.length;
    for (const n of [MAX_LINK_CHARS - base, MAX_LINK_CHARS - base + 1]) expect(gc(data("a".repeat(n)), "acme/shop", "main")).toBe(workflowLink(WEB, "acme/shop", "main", "a".repeat(n)));
    expect(gc(data("a".repeat(MAX_LINK_CHARS - base + 1)), "acme/shop", "main")).toBeNull();
  });
});

describe("github app: the setting GITHUB_APP_WORKFLOW_LINK (docs/github-app/SETUP.md, \"The link that adds the workflow file\")", () => {
  it("\"on\" turns the link on; unset and anything else is off", () => {
    const base = githubSetup().env;
    expect(githubApp(base)!.workflowLink).toBe(false);
    for (const v of ["on", "ON", " on "]) expect(githubApp({ ...base, GITHUB_APP_WORKFLOW_LINK: v })!.workflowLink, v).toBe(true);
    for (const v of ["", "off", "true", "1", "yes", "enabled", "on!", "o n"]) expect(githubApp({ ...base, GITHUB_APP_WORKFLOW_LINK: v })!.workflowLink, v).toBe(false);
  });

  it("the hosted worker's configuration names it, off or on, and the examples and the owner's guide name it too", () => {
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
    expect(read("../wrangler.toml")).toMatch(/^GITHUB_APP_WORKFLOW_LINK = "(off|on)"$/m);
    expect(read("../.dev.vars.example")).toMatch(/^# GITHUB_APP_WORKFLOW_LINK=on$/m);
    expect(read("../../docs/github-app/SETUP.md")).toContain("`GITHUB_APP_WORKFLOW_LINK`");
  });
});

describe("github app: what a check with no race files to read says, with the link and without (src/github/review.ts header)", () => {
  const LINKS = { docs: DOCS_URL, setup: SETUP_URL, app: "https://genclass.dev/github", origin: "https://genclass.dev" };
  const model = (over: Partial<ReviewModel> = {}): ReviewModel => ({ repo: "acme/shop", number: 12, headSha: SHA1, mention: "genclass-dev", ci: noEvidence(), summary: null, findings: [], production: null, settings: DEFAULT_SETTINGS, warnings: [], links: LINKS, ...over });

  it("the first-run check: without a link the text is what it was; with one, the sentence comes first and the two steps stay as the other way", () => {
    const m = { links: LINKS, settings: DEFAULT_SETTINGS };
    expect(renderIntro(m).summary).toBe(INTRO_OFF);
    expect(renderIntro(m, {})).toEqual(renderIntro(m));
    expect(renderIntro(m, { workflowLink: null })).toEqual(renderIntro(m));
    const on = renderIntro(m, { workflowLink: LINK });
    expect(on).toMatchObject({ status: "completed", conclusion: "skipped", title: "No race files to read yet", text: "" });
    expect(on.summary).toBe(INTRO_ON(LINK));
    expect(on.summary.split(LINK)).toHaveLength(2);
  });

  it("\"No race files for this commit\": the same, in the check's summary and nowhere else in it", () => {
    const off = renderCheck(model());
    expect(off).toMatchObject({ status: "completed", conclusion: "neutral", title: "No race files for this commit", text: "" });
    expect(off.summary).toBe(`No race files for \`1111111\`.\n\n\n${NONE_OFF}`);
    expect(renderCheck(model(), { entitled: true })).toEqual(off);
    expect(renderCheck(model(), { entitled: true, workflowLink: null })).toEqual(off);
    const on = renderCheck(model(), { entitled: true, workflowLink: LINK });
    expect(on).toMatchObject({ status: "completed", conclusion: "neutral", title: "No race files for this commit", text: "" });
    expect(on.summary).toBe(`No race files for \`1111111\`.\n\n\n${NONE_ON(LINK)}`);
    // the link changes no verdict: where the check may fail a pull request it is as neutral as before
    expect(renderCheck(model({ settings: { ...DEFAULT_SETTINGS, check: { enabled: true, failOn: "any" } } }), { entitled: true, workflowLink: LINK }).conclusion).toBe("neutral");
  });

  it("the sentence says what the file does and who commits it: no advert, no claim about what will be found", () => {
    const s = SENTENCE("L");
    expect(s).toBe("No change to your tests: [add one workflow file](L). GitHub opens it filled in; you review it and commit it. It runs your Playwright suite under GenClass in a job of its own that is allowed to fail, and uploads the race files.");
    expect(s.toLowerCase()).not.toMatch(/\bbugs?\b|\bfix|\bfind|\bcatch|\bdetect|\bfree\b|\bbest\b|\beas(y|ily)\b|\bjust\b|\bsimply\b|\binstantly\b|!/);
    expect(s).not.toContain("@");
  });

  it("a check that does not say how to set the app up has no link, whatever it is given", async () => {
    const give = { entitled: true, workflowLink: LINK };
    const pending = renderCheck(model({ ci: { ...noEvidence(), state: "pending" } }), give);
    expect(pending.title).toBe("Waiting for this commit's test run");
    const inputs = ["checkout-1.json", "checkout-2.json", "search-1.json", "search-2.json"].map((n) => ({ name: n, content: raceFile(n) }));
    const summary = summaryOf(inputs, DEFAULT_SETTINGS);
    const merged = await mergeFindings(emptyState(), summary, SHA1);
    const found = model({ ci: { ...noEvidence(), state: "ready", inputs, artifacts: [{ name: "genclass-races", runId: 1, files: 4 }] }, summary, findings: merged.view });
    const flagged = renderCheck(found, give);
    expect(flagged.title).toBe("2 findings, 1 reproducible");
    const junk = [{ name: "results.json", content: '{"suites":[]}' }];
    const unreadable = renderCheck(model({ ci: { ...noEvidence(), state: "ready", inputs: junk }, summary: summaryOf(junk, DEFAULT_SETTINGS) }), give);
    expect(unreadable.title).toBe("No race file could be read");
    const noPlan = renderCheck(model(), { entitled: false, plansUrl: "https://genclass.dev/github#plans", workflowLink: LINK });
    expect(noPlan.title).toBe("Private repositories need a plan");
    const others = [pending, flagged, unreadable, noPlan, renderStopped("superseded", { mention: "genclass-dev", held: false }), renderUnsettled({ ci: noEvidence(), headSha: SHA1, mention: "genclass-dev", settings: DEFAULT_SETTINGS })];
    for (const c of others) expect(`${c.title}\n${c.summary}\n${c.text}`, c.title).not.toMatch(SHOWS_LINK);
    // the summary comment is rendered from the model alone: it is never handed the link
    expect(renderSummary(found)).not.toMatch(SHOWS_LINK);
    expect(renderSummary.length).toBe(1);
  });
});

describe("github app: the link on a pull request's checks, through the webhook (src/github/handlers.ts header)", () => {
  const ALL = { repository_selection: "all" };
  const install = async (over: Parameters<typeof githubSetup>[0] = {}, selection: Record<string, unknown> = {}) => {
    const s = githubSetup(over);
    const gh = fakeGithub();
    await deliver(s.env, "installation", installationCreated(selection), { fetch: gh.fetch });
    return { ...s, gh };
  };
  const review = (env: Parameters<typeof deliver>[0], gh: ReturnType<typeof fakeGithub>, id: number) => deliver(env, "issue_comment", commentEvent(12, "/genclass review", { id }), { fetch: gh.fetch });

  it("the first-run check on a selected repository: the link with the setting on, the text as it was with it off", async () => {
    const on = await install(ON);
    expect(await result(await pullRequest(on.env, on.gh, "opened", 12, SHA1))).toBe("no race files");
    const [check] = on.gh.checksAt(SHA1);
    expect(check).toMatchObject({ name: "GenClass", status: "completed", conclusion: "skipped" });
    expect(check.output.title).toBe("No race files to read yet");
    expect(check.output.summary).toBe(INTRO_ON(LINK));
    expect(check.output.text).toBeUndefined();
    // the same calls as without the link: nothing more is asked of GitHub to build it
    expect(on.gh.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /app/installations/${INSTALLATION}/access_tokens`,
      "GET /repos/acme/shop/pulls/12",
      "GET /repos/acme/shop/contents/.github/genclass.yml",
      "GET /repos/acme/shop/actions/runs",
      "POST /repos/acme/shop/check-runs",
    ]);
    expect(on.gh.posted(12)).toEqual([]);

    for (const over of [{}, { GITHUB_APP_WORKFLOW_LINK: "off" }, { GITHUB_APP_WORKFLOW_LINK: "true" }]) {
      const off = await install(over);
      expect(await result(await pullRequest(off.env, off.gh, "opened", 12, SHA1))).toBe("no race files");
      expect(off.gh.checksAt(SHA1)[0].output.summary, JSON.stringify(over)).toBe(INTRO_OFF);
    }
  });

  it("\"No race files for this commit\", for a person who asks and after a push: the link on, the text as it was off; the comment never has it", async () => {
    // a person asks, in a repository nothing was read for yet
    const on = await install(ON, ALL);
    await pullRequest(on.env, on.gh, "opened", 12, SHA1);
    expect(on.gh.checks.size).toBe(0);
    expect(await result(await review(on.env, on.gh, 9100))).toBe("no race files");
    expect(on.gh.checksAt(SHA1)[0]).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(on.gh.checksAt(SHA1)[0].output.title).toBe("No race files for this commit");
    expect(on.gh.checksAt(SHA1)[0].output.summary).toBe(`No race files for \`1111111\`.\n\n\n${NONE_ON(LINK)}`);
    // Re-run on that check is a person asking too: the same text, so nothing is written again
    const written = () => on.gh.calls.filter((c) => c.method !== "GET" && !c.path.includes("/access_tokens")).length;
    const writes = written();
    const rerun = { action: "rerequested", check_run: { id: 1, head_sha: SHA1, app: { id: Number(APP_ID) } }, repository: REPO, installation: { id: INSTALLATION } };
    expect(await result(await deliver(on.env, "check_run", rerun, { fetch: on.gh.fetch }))).toBe("no race files");
    expect(written()).toBe(writes);

    const off = await install({}, ALL);
    await pullRequest(off.env, off.gh, "opened", 12, SHA1);
    expect(await result(await review(off.env, off.gh, 9101))).toBe("no race files");
    expect(off.gh.checksAt(SHA1)[0].output.summary).toBe(`No race files for \`1111111\`.\n\n\n${NONE_OFF}`);

    // a repository whose race files were read once: the next push without them gets the check, and the comment is edited
    for (const [over, want] of [[ON, NONE_ON(LINK)], [{}, NONE_OFF]] as const) {
      const s = await install(over);
      await pullRequest(s.env, s.gh, "opened", 12, SHA1);
      const run = s.gh.addRun(SHA1);
      expect(await result(await deliver(s.env, "workflow_run", runEvent(run.id, SHA1), { fetch: s.gh.fetch }))).toBe("findings");
      // the check with findings says nothing about setting up
      expect(JSON.stringify(s.gh.checksAt(SHA1)[0].output)).not.toMatch(SHOWS_LINK);
      expect(await result(await pullRequest(s.env, s.gh, "synchronize", 12, SHA2))).toBe("no race files");
      const [check] = s.gh.checksAt(SHA2);
      expect(check.output.title).toBe("No race files for this commit");
      expect(check.output.summary.endsWith(want)).toBe(true);
      expect(check.output.summary.startsWith("No race files for `2222222`.\n\n| # | Status | Finding | Test | Seen |")).toBe(true);
      expect(s.gh.summary(12)).toContain("No race files for `2222222`.");
      expect(s.gh.summary(12)).not.toMatch(SHOWS_LINK);
    }
  });

  it("\"Waiting for this commit's test run\" says nothing about setting up, so it has no link", async () => {
    const s = await install(ON);
    await pullRequest(s.env, s.gh, "opened", 12, SHA1);
    const run = s.gh.addRun(SHA1);
    await deliver(s.env, "workflow_run", runEvent(run.id, SHA1), { fetch: s.gh.fetch });
    s.gh.runs.get(REPO.full_name)!.push({ id: 6001, head_sha: SHA2, status: "in_progress", conclusion: null });
    expect(await result(await pullRequest(s.env, s.gh, "synchronize", 12, SHA2))).toBe("waiting for the test run");
    const [check] = s.gh.checksAt(SHA2);
    expect(check.output.title).toBe("Waiting for this commit's test run");
    expect(JSON.stringify(check.output)).not.toMatch(SHOWS_LINK);
    expect(check.output.summary).not.toContain("in two steps");
    // the run ends without race files: the same check now says how to set the app up, with the link
    const waited = s.gh.runs.get(REPO.full_name)!.find((r) => r.id === 6001)!;
    waited.status = "completed";
    waited.conclusion = "success";
    expect(await result(await deliver(s.env, "workflow_run", runEvent(6001, SHA2), { fetch: s.gh.fetch }))).toBe("no race files");
    expect(s.gh.checksAt(SHA2)).toHaveLength(1);
    expect(s.gh.checksAt(SHA2)[0].output.summary).toContain(`\n\n${NONE_ON(LINK)}\n\nNote: No artifact whose name starts with "genclass" in 1 completed workflow run on this commit.`);
  });

  it("the branch is the default branch as GitHub names it: the pull request GitHub returns first, the event's payload otherwise; not known, no link", async () => {
    const base = (repo: Record<string, unknown>) => ({ base: { ref: "main", repo: { id: REPO.id, full_name: REPO.full_name, ...repo } } });
    const { default_branch: _none, ...BARE } = REPO;
    const first = async (over: Record<string, unknown>, repo: Record<string, unknown> & { full_name: string }) => {
      const s = await install(ON);
      expect(await result(await pullRequest(s.env, s.gh, "opened", 12, SHA1, over, repo))).toBe("no race files");
      return s.gh.checksAt(SHA1)[0].output.summary as string;
    };
    // the pull request GitHub returns names another default branch than the event did (it was renamed since): GitHub's answer now counts
    expect(await first(base({ default_branch: "release/2.x" }), REPO)).toBe(INTRO_ON(workflowLink(WEB, "acme/shop", "release/2.x")!));
    // the payload alone
    expect(await first({}, { ...REPO, default_branch: "trunk" })).toBe(INTRO_ON(workflowLink(WEB, "acme/shop", "trunk")!));
    // the pull request alone
    expect(await first(base({ default_branch: "develop" }), BARE)).toBe(INTRO_ON(workflowLink(WEB, "acme/shop", "develop")!));
    // neither names one: the text without the link
    expect(await first({}, BARE)).toBe(INTRO_OFF);
    // a base repository that is not this one says nothing about this one
    expect(await first({ base: { ref: "main", repo: { id: 99001, full_name: "mallory/shop", default_branch: "evil" } } }, BARE)).toBe(INTRO_OFF);
    // a name that is not a branch name, from either place: no link, and the text is not changed by it
    for (const odd of ["HEAD", "a b", "../../mallory/evil", "main?filename=x", "x".repeat(300), 7, ""]) {
      expect(await first({}, { ...BARE, default_branch: odd }), String(odd).slice(0, 20)).toBe(INTRO_OFF);
      expect(await first(base({ default_branch: odd }), BARE), String(odd).slice(0, 20)).toBe(INTRO_OFF);
    }
    // the pull request's branches are never used: a head or base ref is not the default branch
    const refs = await first({ head: { sha: SHA1, ref: "evil/head", repo: { id: REPO.id, full_name: REPO.full_name } }, base: { ref: "release/9", repo: { id: REPO.id, full_name: REPO.full_name } } }, REPO);
    expect(refs).toBe(INTRO_ON(LINK));
  });

  it("a repository whose settings read another artifact than the file uploads gets no link", async () => {
    const s = githubSetup(ON);
    const gh = fakeGithub();
    gh.settings.set(REPO.full_name, "artifact: races\n");
    await deliver(s.env, "installation", installationCreated(), { fetch: gh.fetch });
    expect(await result(await pullRequest(s.env, gh, "opened", 12, SHA1))).toBe("no race files");
    const summary = gh.checksAt(SHA1)[0].output.summary as string;
    expect(summary).toBe(`${READS("races")}; none has been read for this repository yet. [Set it up](${SETUP_URL}) ${TWO_STEPS} ${ONCE}`);
    // a prefix of the file's artifact name is read, so the link stays
    const t = githubSetup(ON);
    const g2 = fakeGithub();
    g2.settings.set(REPO.full_name, "artifact: genclass-r\n");
    await deliver(t.env, "installation", installationCreated(), { fetch: g2.fetch });
    await pullRequest(t.env, g2, "opened", 12, SHA1);
    expect(g2.checksAt(SHA1)[0].output.summary).toContain(SENTENCE(LINK));
  });

  it("with the setting on, no comment, reply, inline comment or issue ever contains the link", async () => {
    const s = githubSetup(ON);
    const gh = fakeGithub();
    gh.settings.set(REPO.full_name, "comment: always\nissues: merge\n");
    const t1 = "checkout.spec.ts > checkout > places one order";
    const t2 = "search.spec.ts > search > shows results";
    const loc = { location: { file: "tests/checkout.spec.ts", line: 12 } };
    const artifacts = () => ({
      "genclass-races": racesZip({
        "a.json": races(t1, 1, [{ diagnosis: "duplicate", op: "POST /api/orders" }], loc),
        "b.json": races(t1, 2, [{ diagnosis: "duplicate", op: "POST /api/orders" }], loc),
        "c.json": races(t2, 1, [{ diagnosis: "stale", op: "GET /api/search" }]),
        "d.json": races(t2, 2, []),
      }),
    });
    gh.files.set(`${REPO.full_name}#12`, [{ filename: "tests/checkout.spec.ts", status: "modified", patch: "@@ -8,6 +8,9 @@ test.describe\n ctx\n+test('places one order', async () => {\n+});\n" }]);
    const say = async (text: string) => result(await deliver(s.env, "issue_comment", commentEvent(12, text), { fetch: gh.fetch }));
    const linked: string[] = [];
    const keep = (sha: string) => linked.push(...gh.checksAt(sha).map((c) => String(c.output.summary)).filter((x) => x.includes(LINK)));

    await deliver(s.env, "installation", installationCreated(), { fetch: gh.fetch });
    // the first-run check, with the link
    expect(await result(await pullRequest(s.env, gh, "opened", 12, SHA1))).toBe("no race files");
    keep(SHA1);
    // race files: the summary comment and an inline comment
    const run = gh.addRun(SHA1, artifacts());
    expect(await result(await deliver(s.env, "workflow_run", runEvent(run.id, SHA1), { fetch: gh.fetch }))).toBe("findings");
    // a push without race files: the check says how to set the app up, the comment says "No race files"
    expect(await result(await pullRequest(s.env, gh, "synchronize", 12, SHA2))).toBe("no race files");
    keep(SHA2);
    expect(gh.summary(12)).toContain("No race files for `2222222`.");
    // every command that answers
    expect(await say("@genclass-dev help")).toBe("help");
    expect(await say("@genclass-dev replay 1")).toBe("replay");
    expect(await say("@genclass-dev replay 9")).toBe("no such finding");
    expect(await say("@genclass-dev fix 1")).toBe("fix brief");
    expect(await say("@genclass-dev issue 2")).toBe("issue");
    expect(await say("@genclass-dev pause")).toBe("paused");
    expect(await say("@genclass-dev resume")).toBe("resumed");
    expect(await say("@genclass-dev review")).toBe("no race files");
    // the push's test run uploads race files, and the pull request merges with a reproducible finding: an issue
    const again = gh.addRun(SHA2, artifacts());
    expect(await result(await deliver(s.env, "workflow_run", runEvent(again.id, SHA2), { fetch: gh.fetch }))).toBe("findings");
    const merged = pullEvent("closed", 12, SHA2, { state: "closed", merged: true });
    gh.pulls.set(`${REPO.full_name}#12`, merged.pull_request);
    expect(await result(await deliver(s.env, "pull_request", merged, { fetch: gh.fetch }))).toBe("issue opened");
    // and a second pull request, which gets the "no race files" check and nothing else
    gh.pulls.set(`${REPO.full_name}#13`, pull(13, SHA3));
    expect(await result(await deliver(s.env, "pull_request", pullEvent("opened", 13, SHA3), { fetch: gh.fetch }))).toBe("no race files");
    keep(SHA3);

    // the setting was on: the checks that say how to set the app up carried the link
    expect(linked).toHaveLength(3);
    const comments = [...gh.comments.values()].map((c) => c.body);
    const inline = gh.reviews.flatMap((r) => [String(r.body.body), ...r.body.comments.map((c: { body: string }) => c.body)]);
    const issues = gh.issues.flatMap((i) => [i.title, i.body]);
    // every kind of text the app writes besides a check is there
    expect(comments.filter((b) => b.startsWith("<!-- genclass-bot:summary -->"))).toHaveLength(1);
    expect(comments.some((b) => b.startsWith("<!-- genclass-bot:fix-brief -->"))).toBe(true);
    expect(comments.filter((b) => b.startsWith("<!-- genclass-bot:reply -->")).length).toBeGreaterThanOrEqual(6);
    expect(inline).toHaveLength(2);
    expect(gh.issues).toHaveLength(2);
    for (const text of [...comments, ...inline, ...issues]) expect(text).not.toMatch(SHOWS_LINK);
    // nor does any request that is not a check run carry it
    for (const c of gh.calls) if (!c.path.includes("/check-runs")) expect(JSON.stringify(c.body ?? null), `${c.method} ${c.path}`).not.toContain("/new/");
  });
});

describe("github app: /github/setup with the link on and off (src/github/pages.ts header)", () => {
  const SOURCE = "https://github.com/genclass-dev/GenClass/blob/main/docs/github-app/workflows/genclass.yml";
  const get = async (over: Parameters<typeof githubSetup>[0], path = "/github/setup") => {
    const { env, sql } = githubSetup(over);
    const r = await call(env, "GET", path, { origin: null });
    return { r, html: await r.text(), csp: r.headers.get("content-security-policy") ?? "", sql };
  };
  /** The page without the bodies of its scripts and styles: what is left is markup. */
  const markup = (html: string) => html.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/g, "$1$2").replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/g, "$1$2");
  const dataOf = (html: string) => /<script type="application\/json" id="gh-wf-data">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? null;

  it("on: a form for the repository and the branch, the file's text in a JSON data block, one nonce, the same policy, no inline handler", async () => {
    const { r, html, csp } = await get(ON);
    expect(r.status).toBe(200);
    const nonce = /script-src 'nonce-([A-Za-z0-9]+)'/.exec(csp)![1]!;
    expect(csp).toBe(
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}' https://api.fontshare.com https://fonts.googleapis.com; font-src https://cdn.fontshare.com https://fonts.gstatic.com; connect-src 'self'; ` +
        "img-src 'self' data: https://genclass.dev; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    // the form: two inputs, "main" filled in, a submit button, no action
    const m = markup(html);
    const form = /<form\b[^>]*>[\s\S]*?<\/form>/.exec(m)![0];
    expect(m.match(/<form\b/g)).toHaveLength(1);
    expect(form).toContain('<form class="gh-wf" id="gh-wf" novalidate>');
    expect(form).not.toMatch(/\baction=|\bmethod=/);
    expect(form).toMatch(/<label for="gh-wf-repo">Repository<input type="text" id="gh-wf-repo" name="repo" placeholder="owner\/name"[^>]*>/);
    expect(form).toMatch(/<label for="gh-wf-branch">Branch<input type="text" id="gh-wf-branch" name="branch" value="main"[^>]*>/);
    expect(form).toContain('<button class="btn" type="submit">Open the file on GitHub</button>');
    expect(m).toContain('<p class="gh-wf-err" id="gh-wf-err" role="alert"></p>');
    expect(html).toContain("you review it and commit it there");
    expect(html).toContain("what you type here is not sent to GenClass");
    expect(html).toContain(`href="${SOURCE}"`);
    // every script that runs carries the response's nonce; the data block is JSON and is not run
    const scripts = [...m.matchAll(/<script\b[^>]*>/g)].map((x) => x[0]);
    expect(scripts.length).toBeGreaterThanOrEqual(3);
    for (const tag of scripts) expect(tag === '<script type="application/json" id="gh-wf-data">' || tag.startsWith(`<script nonce="${nonce}"`), tag).toBe(true);
    expect(scripts.filter((tag) => tag.includes("application/json"))).toHaveLength(1);
    for (const tag of m.matchAll(/<style\b[^>]*>/g)) expect(tag[0]).toBe(`<style nonce="${nonce}">`);
    // no inline handler and no script address in any tag
    for (const tag of m.matchAll(/<[a-zA-Z][^>]*>/g)) {
      expect(tag[0]).not.toMatch(/\son[a-z]+\s*=/i);
      expect(tag[0]).not.toMatch(/javascript:/i);
    }
    // the data block: the file's text and the builder's values, with nothing in it that could end the block or start markup
    const raw = dataOf(html)!;
    expect(raw).not.toMatch(/[<>&]/);
    expect(JSON.parse(raw)).toEqual(workflowLinkData(WEB));
    expect(JSON.parse(raw).text).toBe(WORKFLOW_FILE);
    // the page's script builds the address and opens it in a new tab
    const script = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].at(-1)![1]!;
    expect(script).toContain("function gcWorkflowLink(d, repo, branch)");
    expect(script).toContain('window.open(url, "_blank", "noopener,noreferrer")');
  });

  it("on: the form's script checks what was typed, opens the server's own address for it, and writes messages as text", async () => {
    const { html } = await get(ON);
    const script = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].at(-1)![1]!;
    const mine = script.slice(script.indexOf("function gcWorkflowLink"));
    // the form's own part of the script puts nothing into the page as markup
    expect(mine).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\b|new Function|location/);
    const field = (value = "") => ({ value, textContent: "", focused: 0, focus() { this.focused++; } });
    const repo = field();
    const branch = field("main");
    const err = field();
    const block = { textContent: dataOf(html)! };
    const opened: unknown[][] = [];
    let submit: ((ev: { preventDefault(): void }) => void) | undefined;
    const form = { addEventListener: (type: string, fn: typeof submit) => (type === "submit" ? (submit = fn) : undefined) };
    const ids: Record<string, unknown> = { "gh-wf": form, "gh-wf-data": block, "gh-wf-repo": repo, "gh-wf-branch": branch, "gh-wf-err": err };
    new Function("document", "window", mine)({ getElementById: (id: string) => ids[id] ?? null }, { open: (...a: unknown[]) => (opened.push(a), null) });
    let prevented = 0;
    const press = (r: string, b: string) => {
      repo.value = r;
      branch.value = b;
      submit!({ preventDefault: () => prevented++ });
    };

    // nothing typed, then things that are not a repository or a branch: a message, the field in focus, nothing opened
    press("", "main");
    expect(err.textContent).toBe("Write the repository as owner/name, for example acme/shop.");
    for (const r of ["acme", "acme/shop/x", "acme/shop?tab=1", "https://github.com/acme/shop", "<img src=x onerror=alert(1)>", "acme/.."]) press(r, "main");
    expect(repo.focused).toBe(7);
    press("acme/shop", "");
    expect(err.textContent).toBe("That is not a branch name. The default branch of most repositories is main.");
    for (const b of ["HEAD", "a b", "../x", "main?filename=evil", "a..b", "-x"]) press("acme/shop", b);
    expect(branch.focused).toBe(7);
    // a branch that is one and whose address would be too long
    press("acme/shop", "分".repeat(255));
    expect(err.textContent).toBe("No address could be built for that branch. Copy the file from the repository instead.");
    expect(opened).toEqual([]);

    // a repository and a branch: the address the server builds for them, in a new tab without an opener
    press(" acme/shop ", " main ");
    expect(err.textContent).toBe("");
    expect(opened).toEqual([[LINK, "_blank", "noopener,noreferrer"]]);
    press("Acme-Inc/web.app", "release/2.x");
    expect(opened[1]).toEqual([workflowLink(WEB, "Acme-Inc/web.app", "release/2.x"), "_blank", "noopener,noreferrer"]);
    // the browser's own submit never happens (the page's policy would refuse it anyway)
    expect(prevented).toBe(17);
  });

  it("on: the page is still the same whatever its address claims, and it uses the server's own GitHub web root", async () => {
    const strip = (h: string) => h.replace(/nonce="[^"]+"/g, "");
    const plain = await get(ON);
    const claimed = await get(ON, `/github/setup?installation_id=${INSTALLATION}&setup_action=install&repo=mallory/evil&branch=x&value=y`);
    expect(strip(claimed.html)).toBe(strip(plain.html));
    expect(plain.html).not.toContain("mallory");
    expect(plain.sql.rows("SELECT * FROM github_installations")).toEqual([]);
    const ghe = await get({ ...ON, GITHUB_WEB_URL: "https://ghe.acme.test/" });
    expect(JSON.parse(dataOf(ghe.html)!).web).toBe("https://ghe.acme.test");
    // the function that renders it takes the root from its caller and nothing from a request
    expect(dataOf(githubSetupPage("n", { slug: "genclass-dev", canConnect: false, workflowLink: { web: "https://ghe.acme.test" } }))).toContain('"web":"https://ghe.acme.test"');
  });

  it("off: no form, no data block and no builder; the page says to copy the file from the repository, with a link to it", async () => {
    for (const over of [{}, { GITHUB_APP_WORKFLOW_LINK: "off" }, { GITHUB_APP_WORKFLOW_LINK: "yes" }]) {
      const { r, html, csp } = await get(over);
      expect(r.status).toBe(200);
      expect(csp).toContain("form-action 'none'");
      expect(html).not.toContain("<form");
      expect(html).not.toContain("gh-wf-data");
      expect(html).not.toContain("application/json");
      expect(html).not.toContain("gcWorkflowLink");
      expect(html).not.toContain("window.open");
      expect(html).not.toContain("/new/");
      expect(html).toContain(`<p class="gh-p">Copy <a href="${SOURCE}"><code>workflows/genclass.yml</code></a> from the GenClass repository to <code>.github/workflows/genclass.yml</code> in yours. It runs your existing Playwright suite under GenClass in a job of its own that is allowed to fail, and uploads the race files.</p>`);
      // the two steps are still there, as the other way
      expect(html).toContain("Or in your own e2e job");
      expect(html).toContain("npm i -D @genclass/playwright @genclass/runtime@beta");
    }
    expect(githubSetupPage("n", { slug: "genclass-dev", canConnect: true })).toBe(githubSetupPage("n", { slug: "genclass-dev", canConnect: true, workflowLink: null }));
    // the app's other page has no form either way
    expect((await get(ON, "/github")).html).not.toMatch(/id="gh-wf|<form|application\/json/);
  });
});
