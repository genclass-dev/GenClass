// `genclass setup --yes` on an app that has GenClass in its code but no key yet: GenClass's own starter templates
// (templates/react-vite: `import "@genclass/runtime/auto"` as the entry's first line, written by hand, no init
// markers), against the real collector in process. Up to genclass 0.3.18 connect created the app, printed the key to add by
// hand, and the walk then said the app was not in the account: an agent running setup --yes could never finish.
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handle } from "../../../telemetry-worker/src/collector.js";
import { CLI_ACCOUNT_FROM } from "../../../telemetry-worker/src/cli.js";
import { call, cliToken, now, resetClock, setNow, setup as collector, signedIn } from "../../../telemetry-worker/test/account-helpers.js";
import { saveCredentials } from "../../runtime/bin/lib/account.mjs";
import { inspectProject, run as runtimeCli } from "../../runtime/bin/lib/init.mjs";
import { setup } from "../src/setup.mjs";
import { readState } from "../src/state.mjs";
import { HOST, isolate, printed, tempDir, write } from "./helpers.js";

isolate();
beforeEach(() => {
  resetClock();
  // a terminal approved after the approval page began to list the CLI's routes
  setNow(new Date(Date.parse(CLI_ACCOUNT_FROM) + 3_600_000));
});

type Env = Parameters<typeof handle>[1];
const through = (env: Env) =>
  (async (input: string | URL, init?: RequestInit) => handle(new Request(String(input), { method: init?.method, headers: init?.headers, body: init?.body as never }), env, { now: () => now() })) as unknown as typeof fetch;

const STARTER = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../templates/react-vite");
const RUNTIME_VERSION = JSON.parse(readFileSync(resolve(fileURLToPath(new URL(".", import.meta.url)), "../../runtime/package.json"), "utf8")).version as string;

/** The starter as someone gets it (no node_modules), with the runtime it names already installed: nothing to install. */
function starter(): string {
  const dir = tempDir("genclass-starter-");
  cpSync(STARTER, dir, { recursive: true, filter: (src) => !/[\\/](node_modules|dist)([\\/]|$)/.test(src) });
  write(dir, { "node_modules/@genclass/runtime/package.json": JSON.stringify({ name: "@genclass/runtime", version: RUNTIME_VERSION }) });
  return dir;
}

/** Signed in with a CLI session, every request going to the collector in process. */
async function account() {
  const { env } = collector();
  const me = await signedIn(env);
  saveCredentials({ host: HOST, access_token: await cliToken(env, me.cookie), account: { id: me.account.id, email: me.account.email, github_login: null } });
  vi.stubGlobal("fetch", through(env));
  const apps = async () => ((await (await call(env, "GET", "/api/me", { cookie: me.cookie })).json()) as { projects: { name: string; token: string }[] }).projects;
  return { env, me, apps };
}

const flat = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ");

describe("genclass setup --yes on GenClass's own starter, set up by hand with no key (actions.mjs addRuntime, runtime bin/lib/login.mjs connectApp)", () => {
  it("connect puts the new app's key next to the starter's own import, and the walk ends with the app in the account", async () => {
    const { apps } = await account();
    const dir = starter();
    const main = readFileSync(join(dir, "src/main.tsx"), "utf8");
    expect(inspectProject({ cwd: dir })).toMatchObject({ handWritten: true, keyFits: true, token: null });

    let exit = -1;
    const said = flat(await printed(async () => (exit = await setup({ cwd: dir, yes: true }))));
    expect(exit, said).toBe(0);
    // the change is shown before it is made, as init shows its own
    expect(said).toContain("GenClass is already imported in src/main.tsx; connect adds this app's key next to it and leaves that import as it is");
    expect(said).toContain("src/genclass.config.ts");
    // nothing contradicts it: no key to add by hand, no "not in your account yet"
    expect(said).not.toContain("Add the key yourself");
    expect(said).not.toContain("not in your account yet");

    // one app in the account, and its key is the one now in the code
    const list = await apps();
    expect(list.map((a) => a.name)).toEqual(["genclass-react-vite-starter"]);
    const token = list[0].token;
    expect(readFileSync(join(dir, "src/genclass.config.ts"), "utf8")).toContain(`GENCLASS_CONFIG = { token: "${token}" };`);
    // the starter's import stays as it was; the options file is imported right before it, on a marked line, and the
    // coding agent step puts the dev-only agent link right after it
    const link = [
      'import { GenClass } from "@genclass/runtime"; // genclass:init',
      'import { connectAgent } from "@genclass/runtime/agent"; // genclass:init',
      "if (import.meta.env.DEV && GenClass.runtime) connectAgent(GenClass.runtime); // genclass:init",
    ].join("\n");
    expect(readFileSync(join(dir, "src/main.tsx"), "utf8")).toBe(main.replace('import "@genclass/runtime/auto";', `import "./genclass.config"; // genclass:init\nimport "@genclass/runtime/auto";\n${link}`));
    expect(said).toContain("Left to do: reload your coding agent's MCP servers");

    // the next reading of the state: Runtime is done, and the dashboard waits for the deployed site
    const state = await readState({ cwd: dir });
    expect(state.steps.find((s) => s.id === "runtime")).toMatchObject({ state: "done" });
    expect(state.steps.find((s) => s.id === "dashboard")).toMatchObject({ state: "waiting" });
    expect(state.steps.find((s) => s.id === "agent")).toMatchObject({ state: "done" });

    // remove takes out exactly what was added: the starter is back to what it was, its import and package kept
    await printed(async () => expect(await runtimeCli("remove", ["--yes", "--no-install", "--cwd", dir])).toBe(0));
    expect(readFileSync(join(dir, "src/main.tsx"), "utf8")).toBe(main);
    expect(existsSync(join(dir, "src/genclass.config.ts"))).toBe(false);
  });

  it("a GenClass.init() call takes the key in its own options: connect prints it, and the walk says to add it, not to connect again", async () => {
    const { apps } = await account();
    const dir = starter();
    write(dir, { "src/main.tsx": 'import { GenClass } from "@genclass/runtime";\nGenClass.init();\n' });
    expect(inspectProject({ cwd: dir })).toMatchObject({ handWritten: true, keyFits: false });

    let exit = -1;
    const said = flat(await printed(async () => (exit = await setup({ cwd: dir, yes: true }))));
    const token = (await apps())[0].token;
    expect(said).toContain(`GenClass.init({ token: "${token}" })`);
    expect(said).toContain("GenClass is set up by hand here, so its key goes in by hand, as connect said above");
    expect(said).not.toContain("not in your account yet");
    // the step is not done until the key is in the code, so an agent is told it did not finish
    expect(exit).toBe(1);
    // no key in the code, but the agent step connects the running app after that call all the same
    expect(readFileSync(join(dir, "src/main.tsx"), "utf8")).toBe('import { GenClass } from "@genclass/runtime";\nGenClass.init();\nimport { connectAgent } from "@genclass/runtime/agent"; // genclass:init\nif (import.meta.env.DEV && GenClass.runtime) connectAgent(GenClass.runtime); // genclass:init\n');
    expect(existsSync(join(dir, "src/genclass.config.ts"))).toBe(false);
  });
});
