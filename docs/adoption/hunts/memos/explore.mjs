// Race hunt harness for Memos (docs/adoption/hunts/memos.md). Not part of CI; run by hand against a local Memos.
//
//   node docs/adoption/hunts/memos/explore.mjs --memos http://localhost:3001 --surface reaction \
//     --slow 300,600,900 [--runs 6] [--pause 0] [--out <dir>] [--user hunter --password hunt-pass-1]
//   GENCLASS=0 node docs/adoption/hunts/memos/explore.mjs --surface reaction --runs 8   # the same steps, no GenClass
//
// GenClass is injected from outside, as in ../gitea-explore.mjs: Memos' own code is unchanged. A Playwright route
// rewrites the SPA's HTML (Vite's dev server on :3001) to load the script-tag build
// (packages/runtime/dist/genclass.global.js) from a virtual same-origin path, started with the model skipped and
// telemetry off, then connects the coding-agent link (dist/agent.js) to the MCP bridge started in this process
// (packages/mcp/dist). Memos keeps its server state in TanStack Query, which GenClass does not discover, so the
// injected script mirrors what the memo card shows that has no text of its own (the pinned corner mark, an icon with an
// aria-label; the task checkboxes' checked states; the page path) into rt.atom() values from a MutationObserver.
// Reactions, memo text and comments are page text, which the explore verdict compares directly.
//
// Every load starts from the same server state: before it, the harness signs in over the app's Connect JSON API in a
// separate request context and resets the two seeded memos (setup.mjs): unpinned, NORMAL, no reactions, tasks
// unchecked, no comments. After the steps and the agent's whenSettled(), it waits --tail ms (default 2500: past the
// SSE-triggered refetches) and reads the oracle: what the page shows next to what the server holds (GetMemo).
//
// Surfaces (--surface), each two writes on the memo detail page (/memos/<uid>):
//   pin       More > Pin, then More > Unpin                      (useUpdateMemo, updateMask pinned)
//   archive   More > Archive, then More > Restore                (useUpdateMemo, updateMask state; navigates on success)
//   tasks     More > Check all tasks, then More > Uncheck all    (useUpdateMemo, updateMask content)
//   reaction  Add reaction > 👍, then Add reaction > ❤️            (useReactionActions: upsert, then getMemo -> detail)
//   comment   comment "first", then comment "second"             (useCreateMemo with parent)
// --pause waits between the two writes (default 0: Playwright's pace). For each --slow value it runs one explore
// session: 2 fifo baselines + --runs seeded loads, the same steps each load. Each load's line ends with the delivery
// order of the memo-service requests, as the agent link recorded it.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const rtDist = join(root, "packages/runtime/dist");
const WITH_GENCLASS = process.env.GENCLASS !== "0";

const { values: arg } = parseArgs({
  options: {
    memos: { type: "string", default: "http://localhost:3001" },
    user: { type: "string", default: "hunter" },
    password: { type: "string", default: "hunt-pass-1" },
    seeds: { type: "string", default: `${process.env.HOME}/targets/memos-state-memos.json` },
    surface: { type: "string", default: "reaction" },
    slow: { type: "string", default: "300,600,900" },
    runs: { type: "string", default: "6" },
    pause: { type: "string", default: "0" },
    tail: { type: "string", default: "2500" },
    out: { type: "string", default: "" },
  },
});
const M = arg.memos.replace(/\/+$/, "");
const seeds = JSON.parse(readFileSync(arg.seeds, "utf8")); // { tasks: "memos/…", target: "memos/…" }
const TYPES = { ".js": "text/javascript", ".map": "application/json" };
const pause = Number(arg.pause);
const TASKS = "race tasks memo\n\n- [ ] first task\n- [ ] second task\n- [ ] third task";

// --------------------------------------------------------------------------- what the route injects into <head>
const INJECT = `<script src="/__genclass/rt/genclass.global.js" data-manual data-base="/__genclass/rt/"></script>
<script>window.__gcRt = window.GenClass.init({ model: false, telemetry: false, report: "silent" });</script>
<script type="module">
import { connectAgent } from "/__genclass/rt/agent.js";
const rt = window.__gcRt;
connectAgent(rt);
// TanStack Query is not discovered: mirror what the memo card shows without text of its own.
const card = rt.atom("memoCard", { pinned: false, tasks: "", path: "" });
const read = () => {
  const main = document.querySelector("main") || document.body;
  const next = {
    pinned: !!main.querySelector('[role="img"][aria-label="Pinned"]'),
    tasks: [...main.querySelectorAll('input[type="checkbox"]')].map((c) => (c.checked ? "x" : "_")).join(""),
    path: location.pathname.replace(/[A-Za-z0-9]{22}$/, ":uid"),
  };
  const cur = card.get();
  if (cur.pinned !== next.pinned || cur.tasks !== next.tasks || cur.path !== next.path) card.set(next);
};
new MutationObserver(read).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
</script>
`;

async function route(page) {
  await page.route(`${M}/**`, async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    if (url.pathname.startsWith("/__genclass/rt/")) {
      const file = join(rtDist, url.pathname.slice("/__genclass/rt/".length));
      if (!file.startsWith(rtDist)) return r.fulfill({ status: 404 });
      try {
        return r.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? "application/octet-stream", body: readFileSync(file) });
      } catch {
        return r.fulfill({ status: 404 });
      }
    }
    if (req.resourceType() !== "document") return r.fallback();
    const resp = await r.fetch();
    const type = resp.headers()["content-type"] ?? "";
    if (!type.includes("text/html")) return r.fulfill({ response: resp });
    const body = (await resp.text()).replace(/<head([^>]*)>/i, (m) => `${m}\n${INJECT}`);
    return r.fulfill({ response: resp, body });
  });
}

// --------------------------------------------------------------------------- the MCP server, driven like an agent
let tool = async () => "";
let served = null;
let bridgeUrl = "";
if (WITH_GENCLASS) {
  const { serve } = await import(join(root, "packages/mcp/dist/index.js"));
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  let buf = "";
  output.setEncoding("utf8");
  output.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  served = await serve({ cwd: here, env: {}, stdin: input, stdout: output, stderr: process.stderr, port: 0, stateDir: null });
  let id = 0;
  const rpc = async (method, params = {}) => {
    const my = ++id;
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`);
    for (let i = 0; i < 3000; i++) {
      const m = lines.find((x) => x.id === my);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no reply to ${method}`);
  };
  tool = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).result.content[0].text;
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "memos-hunt", version: "1" } });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  bridgeUrl = `http://127.0.0.1:${served.port}`;
}

// --------------------------------------------------------------------------- the app's API (reset and oracle)
async function signIn(request) {
  const r = await request.post(`${M}/memos.api.AuthService/SignIn`, {
    data: { passwordCredentials: { username: arg.user, password: arg.password } },
  });
  if (!r.ok()) throw new Error(`sign-in failed: HTTP ${r.status()} ${await r.text()}`);
  return (await r.json()).accessToken;
}
function api(request, token) {
  return async (method, body) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await request.post(`${M}/memos.api.MemoService/${method}`, { data: body, headers: { Authorization: `Bearer ${token}` } });
      if (r.status() === 429) {
        await new Promise((done) => setTimeout(done, 31_000)); // 120 writes per user per minute
        continue;
      }
      if (!r.ok()) throw new Error(`${method}: HTTP ${r.status()} ${await r.text()}`);
      return r.json();
    }
    throw new Error(`${method}: still rate limited`);
  };
}

async function reset(call) {
  const t = await call("GetMemo", { name: seeds.target });
  if (t.pinned || (t.state && t.state !== "NORMAL")) {
    await call("UpdateMemo", { memo: { name: seeds.target, pinned: false, state: "NORMAL" }, updateMask: "pinned,state" });
  }
  for (const r of t.reactions ?? []) await call("DeleteMemoReaction", { name: r.name });
  const k = await call("GetMemo", { name: seeds.tasks });
  if (k.content !== TASKS) await call("UpdateMemo", { memo: { name: seeds.tasks, content: TASKS }, updateMask: "content" });
  const c = await call("ListMemoComments", { parent: seeds.target });
  for (const m of c.memos ?? c.comments ?? []) await call("DeleteMemo", { name: m.name });
}

// --------------------------------------------------------------------------- the scenarios (what a person does)
const uid = (name) => name.slice(name.indexOf("/") + 1);
const nap = (page) => (pause ? page.waitForTimeout(pause) : Promise.resolve());
const menu = async (page, item) => {
  await page.getByRole("button", { name: "More" }).first().click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
};
const shownCard = (page) =>
  page.evaluate(() => {
    const main = document.querySelector("main") || document.body;
    const article = main.querySelector("article") || main;
    return {
      path: location.pathname.replace(/[A-Za-z0-9]{22}$/, ":uid"),
      pinned: !!main.querySelector('[role="img"][aria-label="Pinned"]'),
      tasks: [...main.querySelectorAll('input[type="checkbox"]')].map((c) => (c.checked ? "x" : "_")).join(""),
      reactions: [...article.querySelectorAll("button[aria-pressed]")].map((b) => b.textContent.replace(/\s+/g, "")).join(" "),
      comments: [...main.querySelectorAll("p")]
        .map((p) => p.textContent.trim())
        .filter((t) => /^comment (first|second)$/.test(t))
        .sort(),
    };
  });

const surfaces = {
  pin: {
    memo: () => seeds.target,
    async steps(page) {
      await menu(page, "Pin");
      await nap(page);
      await menu(page, "Unpin");
    },
    oracle: (shown, server) => ({ shown: `pinned=${shown.pinned}`, server: `pinned=${!!server.pinned}` }),
  },
  archive: {
    memo: () => seeds.target,
    async steps(page) {
      await menu(page, "Archive");
      await nap(page);
      await menu(page, "Restore");
    },
    // The page a person ends on, against the page that lists the memo in its saved state (home or its own page for
    // NORMAL, /archived for ARCHIVED).
    oracle: (shown, server) => ({
      shown: `page=${shown.path === "/archived" ? "archived" : "home-or-detail"}`,
      server: `page=${server.state === "ARCHIVED" ? "archived" : "home-or-detail"}`,
    }),
  },
  tasks: {
    memo: () => seeds.tasks,
    async steps(page) {
      await menu(page, "Check all tasks");
      await nap(page);
      await menu(page, "Uncheck all tasks");
    },
    oracle: (shown, server) => ({
      shown: `tasks=${shown.tasks}`,
      server: `tasks=${[...server.content.matchAll(/- \[( |x)\]/g)].map((m) => (m[1] === "x" ? "x" : "_")).join("")}`,
    }),
  },
  reaction: {
    memo: () => seeds.target,
    async steps(page) {
      await page.locator("main article, main .group\\/memo").first().hover(); // the reaction button shows on hover
      await page.getByRole("button", { name: "Add reaction" }).first().click();
      await page.getByRole("button", { name: "👍", exact: true }).click();
      await nap(page);
      // The picker closes once the first reaction's refetch lands (onComplete), at a different moment in each order:
      // close it either way and open it again, so every load records the same steps.
      await page.keyboard.press("Escape");
      await page.locator("main article, main .group\\/memo").first().hover();
      await page.getByRole("button", { name: "Add reaction" }).first().click();
      await page.getByRole("button", { name: "❤️", exact: true }).click();
    },
    oracle: (shown, server) => ({
      shown: `reactions=${shown.reactions || "none"}`,
      server: `reactions=${
        Object.entries(
          (server.reactions ?? []).reduce((acc, r) => ({ ...acc, [r.reactionType]: (acc[r.reactionType] ?? 0) + 1 }), {}),
        )
          .map(([k, n]) => `${k}${n}`)
          .join(" ") || "none"
      }`,
    }),
  },
  comment: {
    memo: () => seeds.target,
    async steps(page) {
      for (const text of ["comment first", "comment second"]) {
        await page.getByRole("button", { name: "Write a comment" }).last().click();
        const box = page.locator('main [role="textbox"][contenteditable="true"]').last(); // the @usememos/editor surface
        await box.click();
        await page.keyboard.type(text);
        await page.getByRole("button", { name: "Comment", exact: true }).click();
        // the editor closes (or empties) once the comment is saved: the second comment is written after that
        await page
          .waitForFunction(() => !document.querySelector('main [role="textbox"][contenteditable="true"]')?.textContent?.trim(), null, { timeout: 15_000 })
          .catch(() => {});
        await nap(page);
      }
    },
    oracle: (shown, server) => ({ shown: `comments=${shown.comments.join("+") || "none"}`, server: `comments=${server.__comments}` }),
  },
};

async function connected(page) {
  if (!WITH_GENCLASS) return;
  await page.waitForFunction(() => window.__GENCLASS_AGENT__?.connected === true, null, { timeout: 15_000 });
}
async function settle(page) {
  if (WITH_GENCLASS) await page.evaluate(() => window.__GENCLASS_AGENT__.whenSettled(15_000)).catch(() => {});
  await page.waitForTimeout(Number(arg.tail));
}

const browser = await chromium.launch();

async function scenario(s) {
  const ctx = await browser.newContext({ permissions: WITH_GENCLASS ? ["local-network-access"] : [], viewport: { width: 1200, height: 900 } });
  const token = await signIn(ctx.request); // the refresh cookie lands in this context; the page signs in with it
  const call = api(ctx.request, token);
  await reset(call);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  if (process.env.HUNT_DEBUG) {
    page.on("console", (m) => console.log("[page]", m.type(), m.text()));
    page.on("requestfailed", (r) => console.log("[failed]", r.url(), r.failure()?.errorText));
  }
  if (WITH_GENCLASS) {
    await page.addInitScript((u) => (window.__GENCLASS_AGENT_URL__ = u), bridgeUrl);
    await route(page);
  }
  let line;
  try {
    await page.goto(`${M}/memos/${uid(s.memo())}`);
    await page.getByRole("button", { name: "More" }).first().waitFor({ timeout: 15_000 });
    await connected(page);
    await s.steps(page);
    await settle(page);
    const shown = await shownCard(page);
    const server = await call("GetMemo", { name: s.memo() });
    if (arg.surface === "comment") {
      const c = await call("ListMemoComments", { parent: s.memo() });
      server.__comments = (c.memos ?? c.comments ?? []).map((m) => m.content.trim()).sort().join("+") || "none";
    }
    const o = s.oracle(shown, server);
    line = `${o.shown === o.server ? "same  " : "DIFFER"} shown ${o.shown} | server ${o.server}`;
  } catch (e) {
    line = `ERROR ${String(e).split("\n")[0]}`;
  }
  const order = WITH_GENCLASS
    ? await page
        .evaluate(() =>
          window.__GENCLASS_AGENT__
            .recorded()
            .order.filter((k) => /MemoService\//.test(k))
            .map((k) => k.replace(/^.*MemoService\//, "")),
        )
        .catch(() => [])
    : [];
  if (WITH_GENCLASS) await page.waitForTimeout(500); // the snapshot batch reaches the bridge
  await ctx.close();
  line = `${line}${WITH_GENCLASS ? ` [delivered ${order.join(" then ") || "none"}]` : ""}`;
  return errors.length ? `${line} [pageerror: ${errors[0]}]` : line;
}

const s = surfaces[arg.surface];
if (!s) throw new Error(`unknown surface ${arg.surface}`);
const out = arg.out ? resolve(arg.out) : null;
if (out) mkdirSync(out, { recursive: true });
const summary = { surface: arg.surface, memos: M, genclass: WITH_GENCLASS, runs: Number(arg.runs), pause, tail: Number(arg.tail), sessions: [] };
if (!WITH_GENCLASS) {
  // the control: the same steps at the network's own pace, --runs loads
  const shown = [];
  for (let i = 0; i < Number(arg.runs); i++) shown.push(await scenario(s));
  summary.sessions.push({ slow_ms: 0, differ: shown.filter((l) => l.startsWith("DIFFER")).length, shown });
  console.log(shown.map((l, i) => `load ${i + 1}: ${l}`).join("\n"));
} else {
  for (const slow of arg.slow.split(",").map(Number)) {
    await tool("genclass_clear", { what: "all" });
    const started = await tool("genclass_explore", { action: "start", runs: Number(arg.runs), slow_ms: slow });
    const shown = [];
    for (let i = 0; i < Number(arg.runs) + 2; i++) shown.push(await scenario(s));
    const report = await tool("genclass_explore", { action: "report" });
    const fid = /Race finding\(s\): (f\d+)/.exec(report)?.[1];
    const explain = fid ? await tool("genclass_explain", { id: fid }) : null;
    const findings = await tool("genclass_findings");
    const verdict = /RACE: (\d+) of (\d+)/.exec(report);
    summary.sessions.push({
      slow_ms: slow,
      verdict: verdict ? `race in ${verdict[1]} of ${verdict[2]}` : "no race",
      differ: shown.filter((l) => l.startsWith("DIFFER")).length,
      finding: fid ?? null,
      shown,
    });
    if (out) writeFileSync(join(out, `${arg.surface}-${slow}.txt`), [started, "", ...shown.map((l, i) => `load ${i + 1}: ${l}`), "", report, "", findings, "", explain ?? ""].join("\n"));
    console.log(`--- ${arg.surface} slow_ms=${slow}\n${shown.map((l, i) => `load ${i + 1}: ${l}`).join("\n")}\n${report}\n`);
  }
}
await browser.close();
if (served) await served.close();
console.log(JSON.stringify(summary, null, 2));
if (out) writeFileSync(join(out, `${arg.surface}${WITH_GENCLASS ? "" : "-control"}-summary.json`), JSON.stringify(summary, null, 2));
process.exit(0);
