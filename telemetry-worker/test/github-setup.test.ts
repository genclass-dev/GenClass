// scripts/github-app-setup.mjs (the owner's one-time registration of the GitHub App from its manifest) without a
// network, a browser or a file; and the manifest itself against what the worker handles and what the docs promise.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { handleEvent } from "../src/github/handlers.js";
import { githubLandingPage } from "../src/github/pages.js";
import MANIFEST from "../github-app.manifest.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let setup: any;
beforeAll(async () => {
  setup = await import("../../scripts/github-app-setup.mjs");
});

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n";
const converted = (over: Record<string, unknown> = {}) => ({ id: 424242, slug: "genclass-dev", name: "GenClass.dev", html_url: "https://github.com/apps/genclass-dev", owner: { login: "genclass-dev" }, client_id: "Iv23liABC", client_secret: "cs_secret_value", webhook_secret: "wh_secret_value", pem: PEM, ...over });

describe("the GitHub App's manifest (telemetry-worker/github-app.manifest.json)", () => {
  it("asks for the permissions the docs list and no others: no repository contents, no administration, no secrets", () => {
    expect(MANIFEST.default_permissions).toEqual({ metadata: "read", pull_requests: "write", checks: "write", actions: "read", issues: "write" });
    for (const never of ["contents", "administration", "secrets", "workflows", "members", "organization_administration", "deployments", "statuses", "emails"]) {
      expect(never in MANIFEST.default_permissions, never).toBe(false);
    }
    expect(MANIFEST.public).toBe(true);
    // installing asks for nothing about the person: who they are is asked only by "Connect GitHub", later, if they want it
    expect(MANIFEST.request_oauth_on_install).toBe(false);
    expect(MANIFEST.setup_on_update).toBe(false);
    expect(MANIFEST.hook_attributes).toEqual({ url: "https://genclass.dev/api/github/webhook", active: true });
    expect(MANIFEST.setup_url).toBe("https://genclass.dev/github/setup");
    expect(MANIFEST.callback_urls).toEqual(["https://genclass.dev/github/callback"]);
    expect(MANIFEST.url).toBe("https://genclass.dev/github");
    expect(MANIFEST.description.length).toBeLessThanOrEqual(400);
  });

  it("subscribes to events the worker handles, and the app's page names every permission it asks for", async () => {
    const ctx = { env: {}, db: {}, cfg: {}, f: async () => new Response(), now: () => new Date() } as never;
    for (const event of MANIFEST.default_events) {
      // an empty payload is ignored by each handler, but an event nobody handles is "ignored" before any handler runs
      const src = readFileSync(new URL("../src/github/handlers.ts", import.meta.url), "utf8");
      expect(src, event).toContain(`case "${event}":`);
    }
    expect(await handleEvent(ctx, "push", {})).toBe("ignored");
    const page = githubLandingPage("n", { slug: "genclass-dev", privateRepos: "plan" });
    for (const label of ["Pull requests, read and write", "Checks, write", "Actions, read", "Issues, read and write", "Metadata, read", "One file, read"]) expect(page, label).toContain(label);
    expect(page).toContain("Not asked for:</b> repository contents");
  });
});

describe("scripts/github-app-setup.mjs", () => {
  it("parseArgs: the defaults, every flag, and what it refuses", () => {
    expect(setup.parseArgs([])).toEqual({ org: null, name: "GenClass.dev", origin: "https://genclass.dev", public: true, port: 8976, printManifest: false, open: true });
    expect(setup.parseArgs(["--org", "genclass-dev", "--name", " GenClass (test) ", "--origin", "https://tunnel.example/", "--private", "--port", "9000", "--no-open", "--print-manifest"])).toEqual({
      org: "genclass-dev",
      name: "GenClass (test)",
      origin: "https://tunnel.example",
      public: false,
      port: 9000,
      printManifest: true,
      open: false,
    });
    for (const bad of [["--what"], ["--org"], ["--org", "a b"], ["--name", "x".repeat(35)], ["--name", " "], ["--origin", "http://insecure.example"], ["--origin", "https://x.example/path"], ["--origin", "nope"], ["--port", "80"], ["--port", "abc"]]) {
      expect(() => setup.parseArgs(bad), bad.join(" ")).toThrow(setup.SetupError);
    }
  });

  it("buildManifest moves every address to the origin and adds only the way back; the default is the file as it is", () => {
    const o = setup.parseArgs([]);
    expect(setup.buildManifest(MANIFEST, o, null)).toEqual(MANIFEST);
    const test = setup.buildManifest(MANIFEST, setup.parseArgs(["--origin", "https://tunnel.example", "--name", "GenClass (test)", "--private"]), "http://127.0.0.1:8976/created");
    expect(test).toMatchObject({
      name: "GenClass (test)",
      public: false,
      url: "https://tunnel.example/github",
      hook_attributes: { url: "https://tunnel.example/api/github/webhook", active: true },
      callback_urls: ["https://tunnel.example/github/callback"],
      setup_url: "https://tunnel.example/github/setup",
      redirect_url: "http://127.0.0.1:8976/created",
    });
    expect(test.default_permissions).toEqual(MANIFEST.default_permissions);
    expect(test.default_events).toEqual(MANIFEST.default_events);
    expect(setup.registerUrl(null, "s t")).toBe("https://github.com/settings/apps/new?state=s%20t");
    expect(setup.registerUrl("genclass-dev", "abc")).toBe("https://github.com/organizations/genclass-dev/settings/apps/new?state=abc");
  });

  it("the form page carries the manifest as an escaped field and posts it to GitHub only", () => {
    const html = setup.formPage("https://github.com/settings/apps/new?state=abc", { ...MANIFEST, name: 'Gen"Class <b>' });
    expect(html).toContain('action="https://github.com/settings/apps/new?state=abc"');
    expect(html).not.toContain('<b>');
    const value = /name="manifest" value="([^"]*)"/.exec(html)![1]!;
    const decoded = value.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
    expect(JSON.parse(decoded).name).toBe('Gen"Class <b>');
  });

  it("readConversion: the app's facts and its secrets apart; an answer without them is refused", () => {
    const r = setup.readConversion(converted());
    expect(r.app).toEqual({ id: 424242, slug: "genclass-dev", name: "GenClass.dev", url: "https://github.com/apps/genclass-dev", owner: "genclass-dev" });
    expect(r.secrets).toEqual({ GITHUB_APP_ID: "424242", GITHUB_APP_PRIVATE_KEY: PEM, GITHUB_APP_WEBHOOK_SECRET: "wh_secret_value", GITHUB_APP_CLIENT_ID: "Iv23liABC", GITHUB_APP_CLIENT_SECRET: "cs_secret_value" });
    for (const bad of [null, {}, converted({ id: "x" }), converted({ slug: "Bad Slug" }), converted({ pem: "" }), converted({ pem: "not a key" }), converted({ webhook_secret: undefined }), converted({ client_secret: 5 })]) {
      expect(() => setup.readConversion(bad)).toThrow(setup.SetupError);
    }
  });

  it("the local page: the form, then one answer to the right state; a wrong state or a second visit does nothing", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(converted()), { status: 201 });
    };
    const h = setup.createHandler({ manifest: MANIFEST, action: "https://github.com/settings/apps/new?state=good", state: "good", fetch });
    expect((await h("GET", "/")).body).toContain('name="manifest"');
    expect((await h("POST", "/")).status).toBe(405);
    expect((await h("GET", "/other")).status).toBe(404);
    const wrong = await h("GET", "/created?code=abcdefgh1234&state=bad");
    expect(wrong.status).toBe(400);
    expect(wrong.result).toBeUndefined();
    expect(calls).toHaveLength(0);
    const ok = await h("GET", "/created?code=abcdefgh1234&state=good");
    expect(ok.status).toBe(200);
    expect(ok.result.app.slug).toBe("genclass-dev");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/app-manifests/abcdefgh1234/conversions");
    expect(calls[0]!.init.method).toBe("POST");
    // the page GitHub's redirect lands on shows no secret
    for (const secret of ["cs_secret_value", "wh_secret_value", "MIIEpAIBAAKCAQEA"]) expect(ok.body).not.toContain(secret);
    expect((await h("GET", "/created?code=abcdefgh1234&state=good")).status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it("a refused or malformed code is an error, never a half-registered app", async () => {
    const refuse = async () => new Response("{}", { status: 404 });
    await expect(setup.convert("abcdefgh1234", refuse)).rejects.toThrow(/refused the code \(HTTP 404\)/);
    await expect(setup.convert("../../etc", refuse)).rejects.toThrow(setup.SetupError);
    await expect(setup.convert(null, refuse)).rejects.toThrow(setup.SetupError);
    const h = setup.createHandler({ manifest: MANIFEST, action: "x", state: "s", fetch: refuse });
    const r = await h("GET", "/created?code=abcdefgh1234&state=s");
    expect(r.status).toBe(502);
    expect(r.error).toBeInstanceOf(setup.SetupError);
  });

  it("main: registers through the local page, hands the secrets to the writer only, and prints the next steps without them", async () => {
    const logs: string[] = [];
    const written: Record<string, string>[] = [];
    const opened: string[] = [];
    const app = await setup.main({
      argv: ["--org", "genclass-dev", "--port", "8977"],
      state: "fixed-state",
      fetch: async () => new Response(JSON.stringify(converted({ slug: "genclass-dev-app", html_url: "https://github.com/apps/genclass-dev-app" })), { status: 201 }),
      log: (s: string) => logs.push(s),
      open: (u: string) => opened.push(u),
      // the browser's two requests: the form, then GitHub's way back
      serve: async (handler: (m: string, u: string) => Promise<{ body: string; result?: unknown }>, port: number) => {
        expect(port).toBe(8977);
        const form = await handler("GET", "/");
        expect(form.body).toContain('action="https://github.com/organizations/genclass-dev/settings/apps/new?state=fixed-state"');
        expect(form.body).toContain("http://127.0.0.1:8977/created");
        return (await handler("GET", "/created?code=abcdefgh1234&state=fixed-state")).result;
      },
      writeSecrets: (s: Record<string, string>) => {
        written.push(s);
        return "/repo/telemetry-worker/.github-app.secrets.json";
      },
    });
    expect(app.slug).toBe("genclass-dev-app");
    expect(opened).toEqual(["http://127.0.0.1:8977/"]);
    expect(written).toHaveLength(1);
    expect(Object.keys(written[0]!)).toEqual(["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_WEBHOOK_SECRET", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET"]);
    const out = logs.join("\n");
    for (const secret of ["cs_secret_value", "wh_secret_value", "MIIEpAIBAAKCAQEA", "Iv23liABC"]) expect(out).not.toContain(secret);
    expect(out).toContain('"Single file": Read-only, path .github/genclass.yml');
    expect(out).toContain("https://github.com/organizations/genclass-dev/settings/apps/genclass-dev-app/permissions");
    expect(out).toContain('set GITHUB_APP_SLUG = "genclass-dev-app"');
    expect(out).toContain("npx --yes wrangler@4 secret bulk .github-app.secrets.json");
    expect(out).toContain("d1 migrations apply genclass-dashboard --remote");
  });

  it("--print-manifest prints the manifest and registers nothing", async () => {
    const logs: string[] = [];
    const never = () => {
      throw new Error("must not be called");
    };
    expect(await setup.main({ argv: ["--print-manifest"], log: (s: string) => logs.push(s), fetch: never, serve: never, writeSecrets: never, open: never })).toBeNull();
    expect(JSON.parse(logs.join("\n"))).toEqual(MANIFEST);
  });
});
