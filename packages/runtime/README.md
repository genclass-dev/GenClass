# @genclass/runtime

[![npm](https://img.shields.io/npm/v/@genclass/runtime/latest?label=npm)](https://www.npmjs.com/package/@genclass/runtime)
[![npm beta](https://img.shields.io/npm/v/@genclass/runtime/beta?label=beta)](https://www.npmjs.com/package/@genclass/runtime?activeTab=versions)
[![CI](https://github.com/genclass-dev/GenClass/actions/workflows/ci.yml/badge.svg)](https://github.com/genclass-dev/GenClass/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/genclass-dev/GenClass/blob/main/LICENSE)

### Reports race conditions, stale responses and double submits in your web app while they happen.

GenClass Runtime (`@genclass/runtime`) is an open-source (Apache-2.0) browser library that reports race conditions in
web apps while they happen: stale responses that land over newer data, duplicate requests such as double submits,
inconsistent state and failure storms. A small model runs on the user's device, in a Web Worker on WebGPU or WASM,
and each report comes with its evidence. By default it only reports (`observe`): it never holds, delays or changes a
request, a response or a state write. The opt-in `guard` mode can prevent a few of these failures, and `heal` is
experimental.

It is for front-end apps in React, Next.js, Vue, SvelteKit, Angular, Solid or plain HTML, and for the timing bugs
tests rarely catch: a slow response landing after a fast one, a button clicked twice, a save racing an edit, an
endpoint that starts failing at 2 a.m. Stale responses are reported for state it can see
([which](#automatic-state-discovery)). It runs in the browser only: during SSR or in Node, `/auto` installs nothing.

[Docs](https://genclass.dev/docs) · [Questions](https://github.com/genclass-dev/GenClass/blob/main/FAQ.md) ·
[Measured results](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/RESULTS.md) ·
[API](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/API.md) ·
[Changelog](https://github.com/genclass-dev/GenClass/blob/main/packages/runtime/CHANGELOG.md) ·
[Discord](https://discord.gg/kN9kRnFtZm)

## Quick start

```bash
npx @genclass/runtime@beta init   # finds your framework, shows the diff, then adds one import
```

Once you approve the diff, `init` also creates your app's free dashboard at genclass.dev and sends it your
`package.json` `name`; `--no-token`, `--token`, `--no-telemetry` and `--dry-run` create no dashboard and never contact
genclass.dev ([Your dashboard](#your-dashboard)).

**Two commands, no account.** They set up every open-source part, and nothing asks you to sign in (`--agent` is new
in `0.3.0-beta.6`):

```bash
npx @genclass/runtime@beta init --agent   # the runtime (observe), the dev-only overlay and agent link, your free dashboard link
npx -y @genclass/mcp@0.2.1 init           # the GenClass MCP server and the `genclass` skill for Claude Code
```

The first adds one marked import plus an option file with the app's token (plain HTML: the script tag with
`data-token`; Astro: a `<meta name="genclass">` line), creates the app's free dashboard link at genclass.dev (it sends
the package name, nothing else) and keeps anonymous diagnostics on, as every `init` does (never page text, never from
local hosts; `init --no-telemetry --agent` turns them off and creates no link); the second writes
`.mcp.json` and `.claude/skills/genclass/SKILL.md` (other agents: `npx -y @genclass/mcp@0.2.1 config <client>`). Nothing
else is needed; `npx @genclass/runtime@beta remove` undoes the first
([the open-source setup](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/INSTALL.md#how-do-i-set-up-the-open-source-parts-only)).

Or by hand:

```bash
npm install @genclass/runtime@beta
```

```ts
import "@genclass/runtime/auto"; // first line of your entry file (Next.js 15.3+: instrumentation-client.ts)
```

(Next.js builds that should ship without it: [only in some builds](#only-in-some-builds-nextjs).)

Or with no build step, first in `<head>`:

```html
<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@0.3.0-beta.6"></script>
```

That is the whole setup. Network traffic, user actions, errors and timing are observed, and so is your app's state:
React component state, Redux and Redux Toolkit stores, and Zustand stores with `devtools` are found automatically
([Automatic state discovery](#automatic-state-discovery)). Pinia, Svelte stores, signals and a plain HTML page's DOM
are not: there, stale responses are reported only for stores you register (double submits need no state).

**Versions:** this README describes `0.3.0` with model `@genclass/runtime-model@0.2.0`. The newest line is
`0.3.0-beta.6`, npm's `beta` dist-tag (`0.3.0-beta.1` to `beta.6` were released between 2026-10-22 and 2026-11-03);
npm's `latest` is still the older `0.2.3` (`npm view @genclass/runtime dist-tags` shows them now). Every npm and npx
command here names `@beta`: without it npm installs `0.2.x`, which has no token, dashboard, interaction analytics,
visual checks or agent link and ignores those options without a word (a TypeScript app gets a type error for
`analytics` and `token`), and whose CLI has no `login`, `dashboard`, `scan` or `--sink`. `0.2.x` is the exception,
for an app that cannot take a prerelease. Pin the script tag: the unversioned URL serves `latest`. A feature marked
with a beta number (`0.3.0-beta.2`, say) is not in the betas before it.

> **Anonymous diagnostics are on by default** on public hosts: GenClass's decisions and counts, no text from your
> page, sent to the GenClass maintainers to improve the model. Off on `localhost` and other local hosts from `0.2.2`
> (`0.1.0-beta.3` to `0.2.1` send from them too). Opt out with `GenClass.init({ telemetry: false })`,
> `?genclass=no-telemetry`, `localStorage["genclass.telemetry"] = "off"` or
> `npx @genclass/runtime@beta init --no-telemetry`; browsers sending Global Privacy Control are never collected.
> Details: [Privacy and telemetry](#privacy-and-telemetry) and [TELEMETRY.md](https://github.com/genclass-dev/GenClass/blob/main/packages/runtime/TELEMETRY.md).

## Contents

[At a glance](#at-a-glance) · [Modes](#modes) ·
[What it looks for](#what-it-looks-for) · [Safety and cost](#safety-and-cost-measured) ·
[Model quality](#model-quality) · [Costs](#costs) · [Privacy and telemetry](#privacy-and-telemetry) ·
[Known limitations](#known-limitations) · [Install](#install) ·
[For AI coding agents](#for-ai-coding-agents-installing-genclass) · [Audit a page](#audit-a-page) ·
[Your coding agent](#your-coding-agent-replay-and-explore) ·
[protect()](#function-specific-protect) · [Your dashboard](#your-dashboard) ·
[Automatic state discovery](#automatic-state-discovery) · [State it can protect](#state-it-can-protect) ·
[Visual and CSS checks](#visual-and-css-checks-new-in-030) · [Observability](#observability) ·
[Configuration](#configuration) · [Performance](#performance) ·
[Content-Security-Policy and self-hosting](#content-security-policy-and-self-hosting)

## What it looks like

When the model flags something, the console gets one plain-English line per detection or intervention, followed by a
collapsed group with the evidence. Here a typeahead's slow response for "rea" lands after the response for "reac".
This is real output (format unchanged since `0.1.0-beta.0`; q8 on WASM, in Node) in the default observe mode. The
response reaches the app at once, exactly as without GenClass, and the decision is made in the background:

```
[GenClass] Model ready (genclass-runtime-r17, wasm, q8, 0.43s). Mode: observe.
[GenClass] Flagged a stale response: search.results was written twice by other operations since its operation (#6)
started (version 1 → 3), last 0.69s ago by GET /api/search?q=reac (#8), which started 0.09s after #6, from a later
user action (#7). (stale, 0.96)
```

The same run in guard mode (captured with model 0.1.0; how often model 0.2.0 acts: [Model quality](#model-quality)).
The results for "reac" stayed:

```
[GenClass] Prevented a stale response: search.results was written twice by other operations since its operation (#6)
started (version 1 → 3), last 0.69s ago by GET /api/search?q=reac (#8), which started 0.09s after #6, from a later
user action (#7). Delivered the response to GET /api/search?q=rea (#6) and dropped the state changes it makes over
newer data (search.results). (stale, 0.97; discard 0.98)
```

## At a glance

| | |
|---|---|
| Default | `observe`: reports only; never holds, delays or changes a request, response or state write |
| Opt-in | `guard`: drop a stale response's writes, reuse a duplicate's result, defer, back off. `heal` (experimental): also retry, serve cached, block, hedge, roll back, resync |
| Detects (observe, `balanced`, held-out real apps, scored offline) | 75% of duplicate submits, 30% of stale overwrites (`situation-v2.3` slice; 21% on `situation-v2`), 6% of broken state, with the right diagnosis; report gate fitted to keep false detections at or below 2% (real apps) / 3% (simulated) of clean decisions, met on held-out test (exact rate not published) |
| Acts (guard, `balanced`) | on 7.8% of clear simulated and 7.5% of actionable real-app cases where acting would help; false interventions 0.13% (held-out simulated), 0.00% (held-out real apps) |
| First-load JavaScript | 108.25 KB gzip with `/auto`, 100.13 KB with `GenClass.init()` (`0.3.0-beta.0`; [Performance](#performance)) |
| Model | 10.2 MB (q8: WASM, and WebGPU without `shader-f16`) or 13.6 MB (fp16: WebGPU with `shader-f16`), downloaded once at idle and cached; about 180 ms per decision on one WASM thread (estimated in Node, not in a browser); not loaded on devices reporting 2 GB of memory or less, or on Save-Data |
| Memory | +190 to 280 MB in the renderer while the model is loaded (one pilot app, `0.1.0-beta.3`) |
| Browsers | measured in Chromium only |
| Data sent | anonymous diagnostics without page text, on by default on public hosts, off on local hosts; `telemetry: false` turns them off |
| License | Apache-2.0, the model package too |

Sources: [RESULTS.md](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/RESULTS.md#current-numbers-in-one-place)
§1, §2, §10, §11 and §17, and the
[model card](https://github.com/genclass-dev/GenClass/blob/main/packages/runtime-model/MODEL_CARD.md).

## Modes

| mode | what it does | non-passive actions |
|---|---|---|
| `observe` (**default**) | Finds and reports what it sees and what it would have done. Never holds a request or a response, never runs an action. | none |
| `guard` (opt-in) | Also prevents failures with minimal guard-tier actions: `discard`, `defer`, `coalesce`, `delay` (drop a stale response's writes, reuse a duplicate's result, back off). Only when the model's gain gate says acting beats doing nothing by the profile's margin and the top diagnosis is not `expected` ([model card](https://github.com/genclass-dev/GenClass/blob/main/packages/runtime-model/MODEL_CARD.md)). | guard tier |
| `heal` (**experimental**) | Also recovers: `retry`, `serve_cached`, `block`, `hedge`, `rollback`, `resync`, plus your own actions. | guard + heal tier |

`GenClass.init()` with no `mode`, `/auto` and the script tag without `data-mode` observe only (`0.1.0-alpha.0` and
`0.1.0-beta.1` defaulted to `guard`). Pass `mode: "guard"` or `init --mode guard` to let it act.

**Detections in observe (`0.3.0`).** A detection is *likely* when the model's top diagnosis is not `expected` and its
probability reaches the report gate (0.90 at `balanced` with model 0.2.0): one console line with its evidence. Observe
also reports *possible* detections, from the `eager` report value (0.70) up to the gate: on `console.debug`, counted
apart (`summary().possibleDetections`) and sent in the anonymous diagnostics as `detect` events with `tier: "possible"`.
`rt.on("detect")` and `report` get them only when you set `detect: "possible"` explicitly, sinks only with
`possible: true`; `detect: "likely"` turns them off. Situations raised while the model loads or the tab is hidden are
decided once it can (at most 32 wait), at the possible tier at most
([RESULTS.md §11](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/RESULTS.md#11-observe-mode-detection-in-030-the-possible-tier-and-deferred-situations)).

### How eager should it be?

Once you opt into `guard` or `heal`, GenClass only acts when the model is confident enough. You choose how confident:

```ts
GenClass.init({ aggressiveness: "cautious" }); // "cautious" | "balanced" (default) | "eager", or a number 0 to 1
GenClass.runtime.setAggressiveness("eager");   // change it later (the devtools have a selector too)
```

`cautious` acts less often; `eager` fixes more at a higher risk of acting when it did not need to (numbers under
[Model quality](#model-quality)). In observe, aggressiveness only moves the report gate: 0.95 / 0.90 / 0.70 for
cautious / balanced / eager. The thresholds ship in the model's `meta.json`, fitted on held-out dev data.
`policy.thresholds` overrides them (with model 0.2.0's gain gate, `guard` and `heal` are margins in cost units, not
probabilities); `rt.gates(trigger)` shows what is in force.

**Limits and switches.** Actions are limited to 60 per minute, 10 per minute on the same subject and 200 per session
(`policy.actionLimits`). `?genclass=off` (or `localStorage.genclass = "off"`) installs nothing. `GenClass.init()`
never throws, and outside a browser it returns a runtime with no observers and no model; for tests, use
`createRuntime(options)`.

## What it looks for

Actions other than flagging need `guard` or `heal`:

| situation | example | what GenClass can do |
|---|---|---|
| Stale response | an old search response lands after a newer one | deliver it but drop its writes over newer data, or defer it (guard) |
| Race / conflict | a server echo would overwrite what the user just typed | drop the stale part, defer (guard) |
| Duplicate | a double click sends the same order twice | reuse the first response (`coalesce`, guard) |
| Inconsistent state | the cart total no longer equals the sum of the lines | roll back or resync (heal) |
| Failure pattern | an endpoint fails 5 times in a row | serve the last good response (heal) |
| Transient failure | a one-off 503 | retry (heal) |
| Slow or flooding | 8× slower than usual; a render loop hammering an API | hedge (heal), delay (guard) |
| Unusual behaviour | an operation writes different fields than it usually does | flag; roll back (heal) |
| Your own question | "is now a good moment to start the upload?" | `rt.ask()` / `rt.decide()` |

The runtime decides at nine **triggers**: `delivery` (a response or WebSocket/EventSource message is about to reach
the app), `request`, `failure`, `stall`, `mutation` (a salient store write no delivery decision covered),
`inconsistency` (a learned relation such as `total == sum(items[*].price × qty)` broke), `transition` (an operation
wrote different fields than usual), `error` and `ask` (your own question, always asked). By default the others reach
the model only when salient; the rest is a cheap fact computation. The model gives a diagnosis (`expected`, `stale`,
`conflict`, `duplicate`, `inconsistent`, `failing`, `slow`, `overload`, `unusual` or `transient`) and picks an
action. The runtime has no list of known bugs: triage picks the situations, the model decides. Every trigger's actions:
[API.md](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/API.md#triggers-and-actions).

**Delivery decisions.** In guard and heal, GenClass decides about responses *at the network boundary*, before the app
sees them (observe decides in the background), and never holds or reorders the app's store writes. A delivery is
salient only when a field it is predicted to write already holds **newer applied data**, or it would **revert a
pending local change** or **replace text the user typed**. The model then reads facts such as these:

```
The response has search.results = 1 item ["rea-1"]: neither the current value 1 item ["react-1"], nor the value when #4 started.
The response to GET /api/search?q=rea (#4) arrived after 1.80s (200); the app has not seen it yet.
This request comes from user typed "rea" into input "Search" (#3), started 1.80s ago.
```

**Slow is `stall`, not `delivery`.** A delivery decision is about a response overwriting newer, pending or typed
state, never about how long it took: a response with no such conflict is delivered without a model call however slow
it was (unless `triage: "always"` or a standing question with `always` asks). A slow request is asked about through
`stall`, against latency baselines learned per page load and never stored: once 5 requests with the same signature
(method and path pattern, such as `POST /api/sessions/:id/offer`) have succeeded in this page load, each later one
becomes a stall when it is in flight longer than the largest of 4× their median, 2× their p95 and 0.5 s, so a 6 s
request after five 70 ms ones is asked about after 0.5 s. Slow successes stay in the window: below 20 samples the
slowest sets the p95, so after one slow request, later ones are held to at least twice its time. Without a baseline, a
request becomes a stall only after 10 s in flight. A 4 s call made once per page load, or a 6 s call before its
signature's fifth success, therefore gets no stall decision.

Clean in-order typeahead and autosave make no model calls and hold nothing. The model does not catch logic that is
consistently wrong, CSS or security bugs, and it never rewrites your code; some visual and CSS bugs are covered by
[measured checks](#visual-and-css-checks-new-in-030). Opt-in flow expectations (`learn: { expectations: true }`)
report a usual step that did not happen; off by default until their false-report rate is measured
([EXPECTATIONS.md](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/EXPECTATIONS.md)).

<a id="why-its-an-easy-yes-measured"></a>

## Safety and cost (measured)

These hold for the runtime; whether the model's decisions are good is under [Model quality](#model-quality).

- **It is not expected to make a working app worse.** Decisions about responses happen at the network boundary, which
  looks like ordinary latency to your app, and the default never holds or reorders your app's own store writes. With a
  model that never intervenes (heal mode, compared against observe mode), GenClass changed the outcome in **0 of 396**
  clean runs across **66 real apps in 23 frameworks** (including 14 open-source RealWorld front-ends), 6 seeds each
  (runtime as of `0.1.0-alpha.1`; not re-run since). The check compares final page text (inputs and alerts excluded) and
  server state, not request timing, store contents or observe against no GenClass. With network chaos, 3 of 198 runs
  differed: a request held about 25 ms changed the simulated network's draws
  ([RESULTS.md §4](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/RESULTS.md#4-never-make-a-correct-app-worse-runtime-design-comparison)).
- **Every mode, on seven idiomatic apps** (runtime commit `d04eff3`, the 0.1.0-beta.4 code: the matrix has not run
  0.2.0's other changes or anything since; model 0.2.0 at `balanced`, 2026-10-10). The
  [compatibility matrix](https://github.com/genclass-dev/GenClass/blob/main/compat/RESULTS.md) (six frameworks,
  React, Next.js, Vue, SvelteKit, Angular and Solid, and plain HTML; 15 data layers; 10 seeds per cell) found 0 bugs
  introduced in 3,510 runs with GenClass and 0 actions in 1,760 guard and heal runs on correct apps. Observe left page
  and server state identical to the run without GenClass in every cell but one, an app's own timing race (SWR's
  optimistic rollback) that came out right with GenClass, with no action taken: observe holds nothing, but its
  main-thread work is not zero. Observe reported 49 false findings in 880 correct-app runs, all in one polling and
  fan-out scenario.
- **Normal traffic costs little.** The model is consulted only for salient situations ([Performance](#performance)).
- **The model runs in the browser**, cached after the first load: no inference server, no API key, and decisions
  never wait on the network.
- **You can see what it did, and undo it.** Every detection and action gets one console line with its evidence;
  `rt.explain(id)` shows what the model read; discards and rollbacks can be undone.

## Model quality

The default model is `genclass-runtime-r17` 2.0.0-rc4t (`@genclass/runtime-model@0.2.0`, training run `r17-v2dT`): an
encoder of 8.1M parameters plus 0.7M of heads, trained on simulated apps and on real apps driven in headless
Chromium. It ships a gain gate with one fitted profile per aggressiveness level. FIR, the false-intervention rate, is
the share of cases where doing nothing was best but the gate fired anyway. Held-out test,
[RESULTS.md §1](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/RESULTS.md#1-model-stages-compared-held-out-simulated-apps):

| profile | guard FIR | guard recall (clear / real) | heal FIR | heal recall (clear / real) | report threshold | detected (duplicate / stale / broken) |
|---|---|---|---|---|---|---|
| `cautious` | 0.005% | 2.4% / 1.4% | 0.26% | 3.7% / 3.8% | 0.95 | 72% / 28% / 0% |
| **`balanced` (default)** | 0.13% | 7.8% / 7.5% | 0.59% | 7.1% / 10.4% | 0.90 | 75% / 30% / 6% |
| `eager` | 0.54% | 14.2% / 21.0% | 1.84% | 17.1% / 24.2% | 0.70 | 77% / 45% / 13% |

FIR is on simulated apps; on held-out real apps it was 0.00% for every profile. The targets are 0.1% (guard) and 0.5%
(heal): `cautious` meets both, `balanced` is slightly over both, `eager` trades well over them for about twice
`balanced`'s recall. Pick `cautious` if a wrong intervention costs more than a missed one.

- **Observe (default).** At `balanced`, scored offline per situation on held-out real apps, it reports 75% of duplicate
  submits, 30% of stale overwrites (`situation-v2.3`; 21% on `situation-v2`) and 6% of broken state with the right
  diagnosis. End to end in the compatibility matrix (commit `d04eff3`), it made 10 duplicate-submit detections
  over 10 seeds in each of the 14 data layers with that bug, and 10 stale-response detections in all over the 110
  stale-typeahead runs (none in 7 of those 11 layers), with 49 false findings in 880 correct-app runs. The 0.2.0
  report gate was fitted on dev data to keep false detections at or below 2% (real apps) / 3% (simulated) of clean
  decisions, and met that on held-out test; the exact rate is not published (RESULTS.md §11; model 0.1.0's exact rates:
  §1). One recurring pattern in your app can produce many more; `policy.thresholds.report` raises the bar. With the
  possible tier, the fit held false detections to at most 5% / 6%; the share of possible ones that are false is not
  measured. Three 0.3.0 runtime fixes (overwritten writes decided in observe on slow devices, the body wait, the idle
  unload) can add likely reports, false ones included, at a rate not measured yet; `detect: "likely"` does not turn them
  off.
- **Guard (opt-in).** It rarely acts and misses most problems (the `balanced` row: it acts on 7.8% of clear
  simulated cases at a FIR of 0.13%). Precision among its actions was not measured for 0.2.0.
- **Heal (experimental).** Its FIR at `balanced`, 0.59%, is over the 0.5% target, and it acts on 7.1% of clear
  simulated cases.
- **Not yet met:** diagnosis ≥ 95% and clear-case recall ≥ 80%; recall is the open problem (training data:
  RESULTS.md §6).
- **Format.** Trained on `situation-v2` and `situation-v2.3` data; this runtime renders `situation-v2.3`.

On the six demo apps under network chaos, the shipped gates did not lower the bug rate (72% with GenClass off, 70%
observe, 72% guard, 73% heal), with 0 false interventions on clean trials
([RESULTS.md §5](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/RESULTS.md#5-demos)). Its main
value today is observe mode: plain-English detections with the evidence.

## Costs

GenClass's own tests measure the JavaScript every page loads: about 108 KB gzip for `/auto` and 100 KB for the main
entry ([Performance](#performance)). They measure no load times or memory in a browser (the visual bench measures
only the visual checks' own long tasks, RESULTS.md §13 and §14). The numbers below come from one real app (a pilot
app: a Next.js 16 ordering site, production build served by `next start`, Chromium, a phone-sized viewport, 4× CPU
throttling, medians of 5 runs, observe mode), measured twice, with different versions, setups and controls. Compare
each column only with its own control, and read them as one app's numbers, not a bound:

- **`0.1.0-beta.3` (2026-10-09, model 0.2.0):** `GenClass.init({ mode: "observe", telemetry: false })` from the
  main entry (no state discovery), the model from jsDelivr; Playwright Chromium, 390×844
  ([RESULTS.md §17](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/RESULTS.md#17-browser-cost-on-a-pilot-app-2026-10-09-and-2026-10-10)).
  JavaScript was compared with the app's build without GenClass. Everything else was compared with the same build
  loaded with `?genclass=off`, which skips installing GenClass but still downloads and evaluates its code, so those
  rows leave out the cost of loading it.
- **`0.3.0-beta.0` (2026-10-17):** compared with the same commit built without GenClass
  ([a build-time switch](#only-in-some-builds-nextjs), so the control ships none of its code), Chromium on a desktop
  Mac. `@genclass/runtime/auto/observe` was loaded first and synchronously, before hydration, on `localhost` (so
  development-host defaults applied) and with options that are not the defaults: visual checks and flow expectations
  on, `debug` on, telemetry with every decision record (`decisionSample: 1`, no per-page cap), possible detections,
  the model self-hosted (WASM q8, 1 thread). The JavaScript includes the app's own small wrapper around GenClass.
  These are one app's numbers with these options, not GenClass's defaults
  ([RESULTS.md §25](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/RESULTS.md#25-one-apps-browser-cost-030-beta0-measured-by-the-apps-owner-2026-10-17)).

| | `0.1.0-beta.3` (2026-10-09) | `0.3.0-beta.0` (2026-10-17) |
|---|---|---|
| JavaScript on each page's first load | +97 KB gzip on every page (today: [Performance](#performance)) | **+111.4 KB** on the wire (`/` 346.0 → 457.4 KB, `/menu` 285.7 → 397.1 KB) |
| Load event | no measurable change (control: `?genclass=off`) | **73 to 156 ms later** (`/` 222 → 295 ms, `/menu` 213 → 369 ms, medians) |
| Long tasks (over 50 ms) | no measurable change (control: `?genclass=off`) | first long task **about 55 ms longer** (`/` 57-71 → 116-132 ms); warm loads went from none to 1 or 2 of 50-62 ms |
| LCP | no measurable change (control: `?genclass=off`) | no regression above the noise |
| Main-thread JS heap | +0.4 MB | +1.5 to 1.8 MB |
| **Memory: renderer RSS (holds the model worker)** | **+190 to 280 MB** while the model is loaded (cold and warm) | not used (too noisy) |
| **Memory: per process (`top`, renderer and worker, 12 s after load)** | not measured | **+117 to 175 MB** while the model is loaded |
| **First visit download** | **about 13 MB** on WASM after the load event (12.7 MB measured: q8 model, ONNX Runtime wasm, tokenizer); WebGPU: a 5.5 MB brotli ONNX Runtime build, and with `shader-f16` the 13.6 MB fp16 model instead of the q8 | **about 14.0 MB** from the app's own origin, of which the q8 model is 10.2 MB (sent uncompressed) |
| Later visits | about 1 KB (`model.json` revalidated); the rest comes from Cache Storage, checked with sha256 | about 1 KB |
| Model load | WASM (1 thread): 0.9 to 1.3 s cold, 0.4 s warm. WebGPU (Apple M-series): 12 s cold, 2 s warm | WASM q8 (1 thread): 0.85 to 1.0 s cold, about 0.4 s warm (`status.loadMs`); model ready 1.25 to 1.5 s after navigation cold, 0.75 to 0.85 s warm (medians per page) |
| Model latency per decision | not measured | 97 to 127 ms (`Decision.latencyMs`: from the call to the worker to its answer, on the main thread's clock) |
| App build output | +41 MB of unused ONNX Runtime files (none since `0.2.0`) | no `.wasm` files |

The `0.1.0-beta.3` "no measurable change" leaves out loading GenClass's code, which its control did too; the
`0.3.0-beta.0` column includes it. What made the first long task longer (running the entry before hydration, or the
runtime's own install work) was not measured. To ship no GenClass code in builds that do not use it, see
[Only in some builds (Next.js)](#only-in-some-builds-nextjs): `?genclass=off`, `enabled: false` and `model: false`
stop work, not the download.

**On phones** the memory and the download are what matter. **By default the model is not loaded on devices that
report 2 GB of memory or less, nor on Save-Data connections** (since `0.3.0`; `model.loadIf` defaults to
`{ minDeviceMemoryGB: 4, saveData: "skip" }`; Safari and Firefox do not report device memory and load). The runtime
then keeps observing without a model (nothing is detected or prevented on that device) and says why in one console
line. `model.loadIf` also takes a function, such as `(env) => !env.mobile` for no model on phones;
`model.preload: "lazy"` downloads on the first salient situation, and `model.unloadAfterIdleMs` frees the worker's
memory (guard and heal actions after a reload: FIR not measured, RESULTS.md §11). `model: false` keeps the runtime
observing with no download and no worker.

## Privacy and telemetry

- **Decisions are local.** Situations are built and decided in the browser; nothing is sent to make a decision.
- **Anonymous diagnostics are on by default** with `GenClass.init()` in a browser (and so with `/auto`, the script
  tag and `init` setups), except on local and private hosts (`localhost`, `*.localhost`, `*.local`, `*.test`,
  `127.0.0.1`, `::1`, private IP ranges), in Node/SSR, and in `createRuntime()`. `0.1.0-beta.3` to `0.2.1` send from
  local hosts too (fixed in `0.2.2`), and `0.1.0-beta.3` to `0.2.0` send the redacted situation text by default. They
  go to the GenClass maintainers' collector
  ([`telemetry-worker/`](https://github.com/genclass-dev/GenClass/tree/main/telemetry-worker), a Cloudflare
  Worker writing to a private R2 bucket) and are used to improve the model. One console notice per page says it is on.
- **By default no text from your page is sent.** Sent: a random per-page session id, versions, mode, device class,
  the app's hostname and id-normalised path, and per decision (every detection and every decision whose diagnosis is
  not `expected`, every action and veto; of the routine ones, one in four and at most 200 per page load; counts are
  exact) the trigger, the diagnosis and its confidence, the action and gate, the outcome and latency. The collector
  adds the visitor's coarse country (two letters) and stores no IP address or user agent.
- **Opt out:** `GenClass.init({ telemetry: false })`, `?genclass=no-telemetry`,
  `localStorage.setItem("genclass.telemetry", "off")`, or `npx @genclass/runtime@beta init --no-telemetry`, which
  writes the opt-out into your project (`telemetry=off` in the meta tag or `data-telemetry="off"` on the script tag
  do the same). Browsers sending Global Privacy Control are never collected. `runtime.telemetry` says whether it is
  on and why not.
- **The situation text the model read is sent only if you opt in** with
  `GenClass.init({ telemetry: { include: { situation: true } } })`. It is redacted by field meaning, but can still
  contain route names with query strings, short error messages and short field values; read TELEMETRY.md first.
- **With a token** (`0.3.0`), each batch also carries your app's public token, so the same diagnostics show on your
  app's private dashboard, and decisions about `protect()`ed functions carry the function's name. Without a token
  neither is sent; without telemetry, a token does nothing.
- **Interaction analytics are off unless you turn them on** (new in `0.3.0-beta.1`; `0.3.0-beta.0` does not have
  them). `GenClass.init({ token, analytics: true })` also sends, per page view, the route, engaged time, scroll depth,
  and clicks, rage clicks and dead clicks per element (the element named from markup, never its text), and from
  `0.3.0-beta.2`, within one page load, how each view was reached, the route before it with the time between, the
  first element used on it, and where the page load ended with its routes in order (at most 10). They need
  telemetry on and the app's token (or your own `telemetry.endpoint`); no visitor id exists, and the one thing stored
  on the device is the visit flag in `localStorage` (from `0.3.0-beta.2`: it links the page loads of a visit and says
  whether the browser visited before; `runtime.analytics.stop()` removes it); they never feed a decision or the
  model. Every opt-out above turns them off. Where consent is needed (the EU, EEA and UK), leave `analytics` unset and
  call `runtime.analytics.start()` once the visitor consents. Details:
  [TELEMETRY.md](https://github.com/genclass-dev/GenClass/blob/main/packages/runtime/TELEMETRY.md#interaction-analytics).
- **The measured visual checks send counts only** (from `0.3.0-beta.5`): whether they run on the page and whether
  their runtime fixes are on, and in each summary the findings per check and per page path (at most 20 paths), the
  fixes applied and undone, and their cost. Never a selector, element text, colour, URL, size or one event per finding;
  the findings themselves stay in the page (the console, `rt.checks()`, your own sinks, which send only where you point
  them). They are off on public hosts unless you turn them on.
- **The CLI** contacts genclass.dev only for the command you run: `init` creates a dashboard only after you approve
  its diff (it sends `package.json`'s `name`); `login`, `connect`, `whoami`, `logout` and, signed in without a private
  link in the folder, `dashboard` talk to your account
  ([DASHBOARD.md](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/DASHBOARD.md#what-does-the-cli-send-to-genclassdev)).
- **Privacy policy** for the diagnostics and for genclass.dev accounts (what is collected, how long it is kept, your
  rights): [PRIVACY.md](https://github.com/genclass-dev/GenClass/blob/main/PRIVACY.md).
- Apps that ship GenClass may need to disclose this to their users (GDPR/CCPA). `telemetry: { endpoint, ... }` sends
  to your own collector instead. Full schema, storage, every opt-out and guidance:
  [TELEMETRY.md](https://github.com/genclass-dev/GenClass/blob/main/packages/runtime/TELEMETRY.md).
- **Inputs and redaction.** Typed values of password, `cc-*` and `one-time-code` fields, and of fields whose name or
  label names a secret, are never recorded. The default redactor works by the leaf field's meaning (`auth.token`,
  `payment.card.number`; `auth.loading` stays visible); booleans and null are never redacted. Under a container named
  for a secret, strings, numbers and arrays are all redacted, so a word that is a secret in another sense hides numbers
  too (`map.pin.lat`). The "would replace text the user typed" fact shows a character diff only when neither value is
  redacted, else `[redacted] → [redacted]`. Pass your own `redact(path, value)` for app-specific secrets; the default
  has gaps (below).

## Known limitations

- **The model is new and imperfect.** It misses most problems, it was not evaluated on your app, and in observe mode
  it makes some false flags ([Model quality](#model-quality)). It is not a substitute for tests. Watch observe mode
  before turning on `guard` or `heal`.
- **Browsers.** Every browser measurement here ran in Chromium (headless or Playwright); model latency, the perf
  tests and the simulated apps ran in Node. Firefox and Safari are not tested. Layout shifts and failed CSS
  background images are checked in Chromium only.
- **Redaction gaps.** A container named by a two-word secret (`cardNumber`, `apiKey`, `creditCard`) counts as broad,
  like `auth`, so `payment.cardNumber.value = "4111 1111 1111 1111"` is shown in the situation text, `explain()`, the
  console evidence and devtools, and the telemetry situation text if you opted in (a leaf with such a name,
  `settings.apiKey`, is redacted). "X changed since #N started and is back to V" compares rendered text, so two
  different redacted values read as "back to [redacted]". Pass a custom `redact`, and keep secrets out of observed
  stores.
- **The discard mark lasts 10 s.** After a `discard`, writes by operations chained from the discarded one (a
  `setTimeout`-driven poll, a saga) to the protected fields are also dropped for 10 s, even when they carry fresh
  data. The marks also outlive `rt.pause()` and `setMode("observe")`.
- **`defer` can wait long.** A delivery may be deferred twice, each time until the related operations finish or 10 s
  pass. A deferred WebSocket/EventSource message holds back the messages queued behind it, and is still dispatched if
  the app closed the socket meanwhile. EventSource `open` events are not kept in order behind held messages. XHR
  listeners of a held response run after the original dispatch, so `e.currentTarget` is `null`: read the `xhr`
  object itself.
- **`retry` (heal) trusts HTTP semantics.** It is offered for idempotent methods, and for POST / PATCH only with an
  idempotency key (`policy.idempotencyHeaders`). An endpoint that is not idempotent despite its method (a `PUT` that
  appends) can still be retried. A 502 is described to the model as a status usually returned without processing the
  request, which is not always true behind proxies. `coalesce`, `retry`, `hedge` and failure/stall `serve_cached` are
  fetch-only.
- **`policy.holdWrites: true` (opt-in).** A held write that a later write flushed early can be recorded as dropped
  while it stays applied.
- **Synthetic events** (`isTrusted === false`: `el.click()`, `dispatchEvent`, in-page test drivers) are not user
  actions unless you pass `observe: { untrustedEvents: true }`.
- **Causality** across `await` is tracked by instrumenting fetch, XHR, timers, message events and Response bodies.
  This is best effort; wrap important work in `rt.op(name, fn)` for exact attribution.
- **Store state.** Discovered React and Zustand state is observed only
  ([Automatic state discovery](#automatic-state-discovery)). The first response of each kind after a page load is
  never a delivery decision, unless an explicit `learn.persist` stored what it writes on an earlier page load:
  GenClass has not yet seen what that request writes.
- **Install and CDN.** Read the diff `init` and `remove` show before you confirm. SRI covers only the script-tag file;
  what it loads is not integrity-checked by the browser (the runtime checks the model files' sha256), so pin a
  version, or self-host. A page that lets untrusted HTML into `<head>` should not use `<meta name="genclass">`.

## Install

Pick one; all start the same runtime, in observe mode unless you choose otherwise. Every `init` and `remove` flag, the
token and dashboard `init` creates, page configuration and the tested setups:
[INSTALL.md](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/INSTALL.md).

**1. One command.** `init` finds your framework and package manager, installs the package, adds one import as the
first line of your entry file (plus a dev-only devtools line), and shows you the diff before writing anything.

```bash
npx @genclass/runtime@beta init               # observe; shows the diff, asks, then writes
npx @genclass/runtime@beta init --mode guard  # let GenClass act (also: --mode heal); run again later to switch
npx @genclass/runtime@beta init --dry-run     # show the diff, write nothing, send nothing
npx @genclass/runtime@beta remove             # undo exactly what init added
```

Other flags: `--yes`, `--no-telemetry` (`--telemetry` undoes it on a later run and writes no telemetry option, so
the default applies: on, but off on local hosts), `--no-token`, `--token gc_...`, `--sink`, `--model-url`, `--no-install`,
`--no-devtools`, `--agent` (from `0.3.0-beta.6`: the dev-only agent link too, so your coding agent sees the dev
pages; [Your coding agent](#your-coding-agent-replay-and-explore)), and from `0.3.0-beta.2` `--no-network` and
`--sync` (plain HTML).

**Which version** (from `0.3.0-beta.2`). `init` (and `login`, `connect`) first prints its own version and the npm
dist-tag it came from, asks npm's dist-tags once (`npm view @genclass/runtime dist-tags`, at most 3 s; never with
`--dry-run`, `--no-network`, `--no-token` or `--no-telemetry`, nothing when offline) and says when a newer release is
on npm, with the command that runs it:

```
  ✔ Version    @genclass/runtime 0.3.0-beta.5 (npm dist-tag beta)
  ▲ Newer      @genclass/runtime 0.3.0-beta.6 is on npm (dist-tag beta): run npx @genclass/runtime@beta init instead
```

It installs its own version (`@genclass/runtime@^0.3.0-beta.6` today), and a project that already has an older one
(a `0.2.x` from `npx @genclass/runtime init` without `@beta`) is upgraded, after the same diff and question. Every
command it prints names `@beta` while it is a prerelease.

**Plain HTML** (from `0.3.0-beta.2`): `init` writes the script tag with `defer`, so a slow or blocked CDN never holds
up the page. GenClass then starts once the page is parsed: before your `defer` and `type="module"` scripts and before
`DOMContentLoaded`, but after classic scripts that have neither `defer` nor `async`, so requests and errors those
scripts cause while the page is still loading are not seen, and a library loaded that way before GenClass (a UMD
React from a CDN) is not discovered; a click handler's `fetch` is seen either way, and the model still loads at idle
after `load`. `--sync` writes the blocking tag of earlier versions, which runs before every script. `remove` takes
the tag out whatever attributes you add to it (`defer`, `async`, `nonce`). When a project looks mostly static (no
`fetch`, XHR, WebSocket or EventSource call in its sources, or a plain HTML page with one script), `init` says so in
one sentence and points to the visual checks and the page scan (`npx @genclass/runtime@beta scan <url>`,
[Audit a page](#audit-a-page)).

**2. One import** (any bundler; for Next.js builds that should ship without it, see
[Only in some builds (Next.js)](#only-in-some-builds-nextjs)), first in your entry file, so it is installed before
your framework:

```ts
import "@genclass/runtime/auto";          // observe (the default); also /auto/guard, /auto/heal
```

Options go in `window.GENCLASS_CONFIG = { ... }` (any `InitOptions`, set before the import runs) or
`<meta name="genclass" content="mode=guard, devtools=local">` in `<head>`.

**3. One script tag** (no build step), first in `<head>`:

```html
<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@0.3.0-beta.6" data-mode="observe" data-devtools="local"></script>
```

It exposes `window.GenClass` and loads the model worker and the overlay on demand from the same version; `data-mode`,
`data-devtools`, `data-telemetry`, `data-token`, `data-scope`, `data-sink` and more configure it
([every attribute](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/INSTALL.md#which-attributes-does-the-script-tag-take)).
Keep the version pinned: the unversioned URL serves npm's `latest` (the older `0.2.x` until `0.3.0` is stable); on a
plain HTML page `init` writes a pinned jsDelivr URL with SRI and, from `0.3.0-beta.2`, `defer`.
`data-devtools="local"` shows the overlay on local hosts (loopback with or without a port, `*.localhost`, `*.local`,
`*.test` and `file:`), so also in a Capacitor, Tauri or Electron build that ships it: set it per environment.

**4. By hand:** `npm install @genclass/runtime@beta`, then first in your entry file:

```ts
import { GenClass } from "@genclass/runtime";

const rt = GenClass.init(); // observe; GenClass.init({ mode: "guard" }) to let it act
```

`GenClass.init()` does not discover state on its own: register stores ([State it can protect](#state-it-can-protect)),
or import `@genclass/runtime/discover` first and pass `autoState: true`.

**ESM only.** No `require` build. Jest needs a `transformIgnorePatterns` entry such as
`["/node_modules/(?!@genclass/runtime)"]`. The unscoped `genclass-runtime` alias is deprecated. A bundler can still
`require` a module of your own that imports it ([Only in some builds (Next.js)](#only-in-some-builds-nextjs)).

### Only in some builds (Next.js)

The one import ships GenClass to every page, about 108 KB gzip on each first load, even when `?genclass=off` or
`enabled: false` keeps it from running (`model: false` only skips the model). To leave it out of some builds
entirely, put it behind a build-time switch the bundler can remove. In Next.js 16, a `NEXT_PUBLIC_*` variable is
inlined only when it is set at build time: an unset one stays a lookup at run time, the branch cannot be removed, and
the whole runtime ships unused (in one app, 15 chunks and about 275 KB gzip). So define it in `next.config.ts` as
well, with a value even when the variable is unset:

```ts
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // always defined ("" when unset), so the check in instrumentation-client.ts is a constant when Next builds
  env: { NEXT_PUBLIC_GENCLASS: process.env.NEXT_PUBLIC_GENCLASS ?? "" },
};

export default nextConfig;
```

```ts
// instrumentation-client.ts
if (process.env.NEXT_PUBLIC_GENCLASS === "on") {
  // synchronous, so GenClass is installed before React hydrates, as with the plain import
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./genclass");
}

export {};
```

```ts
// genclass.ts, next to instrumentation-client.ts
import "./genclass.config"; // optional: sets window.GENCLASS_CONFIG, so it comes before the runtime
import genclass from "@genclass/runtime/auto";

// the devtools overlay, in development only (optional)
if (process.env.NODE_ENV === "development") {
  import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass));
}
```

Build with `NEXT_PUBLIC_GENCLASS=on next build` (the same for `next dev`), or set it in `.env.production`; any other
value, or none, builds without GenClass. Like every `NEXT_PUBLIC_*` value, it is fixed when you build.

- **Why `require`.** It loads your own `genclass.ts`, which imports the package with `import`, and Next's bundler
  resolves both. Do not `require("@genclass/runtime/auto")` itself: the package is ESM only and its exports have no
  `require` condition. `require` is typed by `@types/node`, which create-next-app installs.
- **GenClass first.** Static `import`s in `instrumentation-client.ts` run before this block (imports are hoisted),
  so whatever they set up (an error tracker, say) would be installed before GenClass, against step 2's "first in
  your entry file". Load other instrumentation there with `require` below the block instead.
- **`import()` is weaker.** `import("./genclass")` in place of the `require` also ships nothing when off, but Next.js
  does not wait for it: it can resolve after hydration has begun, so GenClass misses the requests made before it and
  does not see React state that rendered before it ([Automatic state discovery](#automatic-state-discovery), "Not
  covered yet").
- **Options and `init`.** `init` treats `genclass.ts` as a setup made by hand and leaves it alone: it writes no token
  and no `--no-telemetry`, `--model-url` or `--sink` options there, and `remove` takes nothing out. Set them in
  `genclass.config.ts` yourself, in the form `init` writes:
  `(globalThis as { GENCLASS_CONFIG?: object }).GENCLASS_CONFIG = { telemetry: false };` (any `GenClass.init()`
  option, and `token: "gc_..."`).
- **A Content-Security-Policy** built in `next.config.ts` can add GenClass's origins under the same condition
  ([Content-Security-Policy and self-hosting](#content-security-policy-and-self-hosting)).
- **Measured in one app** (Next.js 16.3, Turbopack): built without the variable, the app had no GenClass files and
  was 64 B gzip larger than before GenClass was added (the empty `instrumentation-client` hook). Not checked with
  `next build --webpack`.

## For AI coding agents installing GenClass

1. Run `npx @genclass/runtime@beta init --dry-run` (it shows the diff and sends nothing). Tell the user that
   anonymous diagnostics are on by default on public hosts, and that applying `init` creates the app's dashboard at
   genclass.dev from `package.json`'s `name` unless they pass `--no-token`.
2. Apply it with `--yes` only once they agree. Telemetry is the user's decision: add `--no-telemetry` or
   `telemetry: false` only if they ask.
3. Keep the default observe mode. Use `--mode guard` only on request, and then keep payment and sign-in endpoints
   observe-only: `requests: { protect: ["preset:payments", "preset:auth"] }` in `window.GENCLASS_CONFIG` (the
   `genclass.config.ts` that `init` writes), or `protect: protectPreset("payments", "auth")` with `GenClass.init()`.
4. `.genclass.local` holds the private dashboard link and is gitignored: never paste it into code, docs, commits or
   pull requests. The token (`gc_...`) is public and belongs in the code.
5. Check: the console shows `[GenClass] Model ready (...). Mode: observe.`; undo with
   `npx @genclass/runtime@beta remove`.

To change GenClass itself, read [AGENTS.md](https://github.com/genclass-dev/GenClass/blob/main/AGENTS.md).

## Audit a page

One command checks any page, yours or not, with GenClass's 26 measured visual checks
([below](#visual-and-css-checks-new-in-030)) and prints a score and each problem with the element, its selector and a
suggested CSS fix, worst first. Nothing needs to be installed in the page:

```bash
npx @genclass/runtime@beta scan https://example.com          # also: audit; a dev server works too (localhost:5173)
npx @genclass/runtime@beta scan localhost:5173/pricing --json # the same report as JSON on stdout, for agents and CI
```

```
  GenClass scan • https://genclass-scan-fixture.mehar-144.workers.dev/
  ran locally: Chromium 153.0.8010.12, desktop 1280x800, phone 390x844; @genclass/runtime 0.3.0-beta.1 visual checks in observe mode (no telemetry, no model, nothing sent)

  Visual score 15/100  •  7 problems (6 high, 1 medium)

  HIGH
  ✖ control-unreachable (desktop)
      link "Terms"  body > footer > a
      body > footer > a "Terms" cannot be clicked: div.chatbar (position: fixed) covers all 5 of its hit points even at the end of the page.
      fix: body { padding-bottom: 72px; }  (Reserves space for div.chatbar, or move it on small screens: ...)
  ✖ text-invisible (desktop, phone)
      p "This sentence is nearly white on white."  p.fine
      text contrast 1.08:1 on p.fine "This sentence is nearly white on white.", below 1.5:1 (WCAG 2.2 contrast formula; unreadable-text threshold): #f6f6f6 on #ffffff from body.
      fix: p.fine { color: #767676; }  (Reaches 4.5:1. ...)
  ...
```

It runs on your machine when Playwright's Chromium is available (`npm i -D playwright && npx playwright install
chromium`, in the project or globally): headless Chromium loads the page at desktop (1280x800) and phone (390x844)
sizes with this package's script-tag build injected before the page's first script, in observe mode with telemetry
off and no model, presses Tab and scrolls to the end so the focus and fixed-bar checks see something, and reads
`rt.checks()`. The only requests are the page's own. The score is the hosted page check's "Visual bugs" category
formula on these findings. Without Playwright, or with `--hosted`, the page is checked by the
[genclass.dev page check](https://genclass-scan.mehar-144.workers.dev/scan) instead (it says so, and adds
accessibility, speed and security audits); a `localhost` or private address is never sent there, and `--local` never
uses it. `--phone` checks the phone size only, `--timeout <s>` sets the page load timeout. Exit code 0 when nothing
is found, 1 when the checks found something, 2 on an error. Coding agents get the same as the `genclass_scan` tool of
[`@genclass/mcp`](https://github.com/genclass-dev/GenClass/tree/main/packages/mcp).

## Your coding agent: replay and explore

A race depends on the network's timing, so it rarely shows on your fast machine and never in a test where mocked APIs
answer in order. `@genclass/runtime/agent` connects your development build to `@genclass/mcp`, an MCP server for
Claude Code and other coding agents, and lets the agent:

- **see what happened, in order:** clicks, requests, the order their responses were delivered, the state each one
  wrote, errors with the click and request behind them, and this runtime's detections;
- **replay** the exact delivery order that produced a bug, on any machine, before the fix (reproduced) and after it
  (not reproduced);
- **explore**: run the same steps with overlapping responses delivered in different seeded orders, optionally slower,
  and report what ends differently from the run where responses came back in order;
- **keep the proof:** a generated Playwright test that sets the same order and fails while the bug is there.

```bash
npx @genclass/runtime@beta init --agent   # the app side: a dev-only line next to the import init writes (0.3.0-beta.6)
npx -y @genclass/mcp@0.2.1 init                 # the server in .mcp.json and the `genclass` skill, for Claude Code
```

Other agents: `npx -y @genclass/mcp@0.2.1 config <client>`, or `claude mcp add genclass -- npx -y @genclass/mcp@0.2.1`. By
hand, the app side is one line in a development build (plain HTML: a module script after the tag, which `init --agent`
writes too):

```ts
import { GenClass } from "@genclass/runtime";
import { connectAgent } from "@genclass/runtime/agent";

const rt = GenClass.init();
if (import.meta.env.DEV) connectAgent(rt); // development builds only
```

`connectAgent` is its own entry (no first-load cost), runs only on pages served from your machine, talks only to a
loopback address, and holds a response only when you or your agent set a schedule (each at most 1.5 s beyond its
emulated delay; never changed; protected requests never). Without one it only records (a page load's first responses
wait for the bridge's hello, at most 0.6 s). Design and measurements: [AGENT.md](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/AGENT.md).

## Function-specific: protect()

**New in `0.3.0`** (`0.2.x` has no `protect` export). Use it when you want GenClass on a few functions that matter (a
checkout submit, a search, a save) rather than on the whole app.

```ts
import { GenClass, protect } from "@genclass/runtime";

GenClass.init({ token: "gc_...", scope: "functions" }); // early in your entry file (with /auto or the script tag: see below)

// Wrap at module level; calls made before GenClass.init() run fn directly.
export const submitOrder = protect("checkout submit", async (cart: Cart) => {
  const res = await fetch("/api/orders", { method: "POST", body: JSON.stringify(cart) });
  if (!res.ok) throw new Error(`order failed: ${res.status}`);
  return res.json();
});
```

- **Same function.** Same signature: `this`, arguments, return value and thrown errors pass through, and a sync
  function stays sync. `protect` itself never throws.
- **Each call is tracked** as an operation named `name`, the same as `runtime.op(name, fn)`: the requests, state
  writes, timers and errors it starts are linked to it; work started elsewhere (a WebSocket message) is not.
- **Decisions name the function**: `fn: name` on `rt.on("decide")`, and, with a token, in telemetry and on your
  dashboard (without a token the name is never sent). Use a fixed name: a label that looks like data (such as an
  e-mail address, a URL or 4 or more digits in a row) is sent as `[redacted]`. With the script tag, use
  `window.GenClass.protect`.

**`scope: "functions"`** (also `data-scope="functions"` or `scope=functions` in the meta tag): GenClass still observes
the whole app as context, but raises decisions only for activity inside protected functions and never holds or acts
on anything else; `rt.ask()` and `rt.decide()` are still answered everywhere. The default, `scope: "app"`, decides
about the whole app. There is no per-function mode: narrow where GenClass acts with `routes` or `requests.protect`.
With `/auto` or the script tag, GenClass starts before your code, so a later `GenClass.init({ token, scope })` is
ignored (the console says so once): set them in `window.GENCLASS_CONFIG` (the `genclass.config.ts` that `init`
writes), the meta tag or the script tag.

## Your dashboard

**New in `0.3.0`** (`0.2.x` ignores a token). Each web app gets a public **project key** (token: `gc_` + 22 letters and
digits) that groups its diagnostics on a dashboard at genclass.dev, kept in a GenClass account (the CLI's `login`,
then `connect`, `whoami`, `logout`) or behind one private link per app (anyone with the link can open it), which
`init` saves in `.genclass.local` and `npx @genclass/runtime@beta dashboard` prints again (from `0.3.0-beta.2`;
`--open` opens it). The dashboard is free for every app, with 90 days of history (1 year on Enterprise), and so are
your own classifier, which a person from GenClass trains on your app's traffic, bug reports or labelled examples once
you ask, and the `@genclass/mcp` server for coding agents ([pricing](https://genclass.dev/pricing)). It needs
telemetry on and a deployed host: local hosts do not send by default. Pass a key with `GenClass.init({ token })`,
`data-token`, `token=` in the meta tag or `window.GENCLASS_CONFIG = { token }`. Accounts, the private link and what
the CLI sends: [DASHBOARD.md](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/DASHBOARD.md).

**What it shows:** what GenClass found, on which pages, and what it did (decisions, detections by diagnosis, actions,
top routes and protected functions, model load and latency, runtime and model versions). With `analytics: true`
(`0.3.0-beta.1` or later, off by default) also how visitors use each page (page views, time on page, scroll depth, the
most clicked elements, rage and dead clicks; `data-genclass-name="pricing-cta"` gives an element a readable name) and,
from `0.3.0-beta.2`, how they move: the most taken paths, page-to-page steps with the time before each, where page
loads start and end, back and forward use, and the first element used per page. `0.2.x` ignores `analytics: true`
without a word, so the Visitors view says which runtime versions your app sends from. With the script tag, when the
analytics code itself does not load (a self-hosted `dist/` missing `analytics/`), the console says so (from
`0.3.0-beta.2`) and `runtime.analytics.reason` is `"error"`; files of two releases in one `dist/` get one warning
naming both ([ANALYTICS.md](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/ANALYTICS.md)
section 4.1).

## Automatic state discovery

With the one line (`@genclass/runtime/auto*` or the script tag) GenClass finds the app's state on its own. It
installs itself before your framework loads, the way React DevTools and Redux DevTools do, and records every state
change with the operation that caused it (the response, timer or user action whose callback called `setState` or
`dispatch`). Delivery decisions need those writes: without them, GenClass could only see the network.

| state | how it is found | what GenClass can do with it |
|---|---|---|
| React ≥ 16.8 (development and production builds): `useState`, `useReducer`, `useSyncExternalStore`, class state | the React DevTools global hook (installed, or chained onto the real extension's); each commit, only re-rendered components are compared | **observed only**: detections and delivery decisions (`deliver` / `defer`); never dropped or rolled back |
| Redux / Redux Toolkit (`configureStore` with `devTools` on, its default; `createStore` with the Redux DevTools enhancer) | the Redux DevTools globals (forwarded to the real extension) | **controllable**: as with GenClass's Redux enhancer: `discard`, late revert, `rollback`, `resync` |
| Zustand with the `devtools` middleware | the Redux DevTools `connect` API; off in production builds unless you pass `enabled: true` (or wrap the store with `genclass` from `@genclass/runtime/zustand`) | **observed only** |

- **Names.** A component's store is named after the component (`SearchPage.state0`); in production builds, after the
  element it renders (`id`, `data-testid`, `aria-label`). At most 3 instances per component and 48 component stores;
  a store appears on its first state change. Framework internals and values that are not app data (functions,
  promises, DOM nodes, class instances) are skipped.
- **Secrets.** Field names are redacted as usual, and a `useState` whose string equals what a password, card-number
  or one-time-code input holds is redacted from then on. Discovered state reaches telemetry only if you opt into
  sending situation text.
- **Turn it off:** `<meta name="genclass" content="autostate=off">`, `data-autostate="off"`,
  `window.GENCLASS_CONFIG = { autoState: false }`, or one source: `autoState: { react: false }` (also `redux`,
  `zustand`). With `GenClass.init()` it is off unless you import `@genclass/runtime/discover` first and pass
  `autoState: true`.
- **Not covered yet:** Vue / Pinia, MobX, Jotai, Recoil, signals, Svelte stores, and state outside these libraries.
  A React renderer that loaded before GenClass is observed without exact causes, and one that rendered before it is
  not observed at all. With `GenClass.init()` and `@genclass/runtime/discover`, Redux stores created before the
  runtime starts are observed only. Register such state with `rt.atom` / `rt.guard`
  ([State it can protect](#state-it-can-protect)).
- **Cost** (a pilot app): about 7 KB gzip in `/auto`; a React commit walk of p95 1.8 ms at 4× CPU throttling
  ([RESULTS.md §17](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/RESULTS.md#17-browser-cost-on-a-pilot-app-2026-10-09-and-2026-10-10)).

<a id="connect-your-state-optional"></a>

## State it can protect

Fetch, XHR, WebSocket, EventSource, DOM user events, errors, navigation, storage, long tasks and timers are observed
with no code, and with the one line React, Redux and Zustand state is found too. To let GenClass also protect your
state (roll back an inconsistent cart, revert a stale write), create it through GenClass or wrap the store you
already have; a write can be dropped or reverted only when the store goes through GenClass. Each option is one line:

```ts
const rt = GenClass.init({ mode: "guard" });

// Built-in atom
const cart = rt.atom("cart", { items: [], total: 0 }, { resync: () => loadCart() });
cart.set((c) => ({ ...c, items: [...c.items, item] }));

// React (uses GenClass.runtime, or the runtime from <GenClassProvider runtime={…}>; plain useState without one)
import { useGenClassState } from "@genclass/runtime/react";
const [results, setResults] = useGenClassState("searchResults", []);

// Redux / Redux Toolkit (put the enhancer last in compose())
import { genclassEnhancer } from "@genclass/runtime/redux";
const store = configureStore({ reducer, enhancers: (e) => e().concat(genclassEnhancer(rt, { name: "app" })) });

// Zustand
import { genclass } from "@genclass/runtime/zustand";
const useBoard = create(genclass(rt, "board")((set) => ({ cards: [], move: () => set(/* … */) })));

// Any store with get/set (and optionally subscribe)
const prefs = rt.guard("prefs", { get: () => store.prefs, set: (v) => store.setPrefs(v) });
```

| protection | how | works with |
|---|---|---|
| delivery `discard` | the response is delivered; its chain's writes to the protected fields are dropped synchronously inside each write, and its other fields (loading flags, counts) apply | atoms, `rt.guard`, `useGenClassState`, Redux and Zustand adapters, discovered Redux stores. Not offered when every field the response would write is observed only: `defer` still is |
| late revert | a background `mutation` decision to `discard` reverts the write if it was decided at most 800 ms after the write applied (`LATE_REVERT_MS`), its fields are unchanged since, and no later write of the same chain followed | any GenClass-aware store |
| `rollback` (heal) | restores the last settled snapshot where every learned relation held | stores GenClass can write |
| `resync` (heal) | calls your `resync` handler | stores registered with `{ resync }` |

The default never holds a store write: `set(x); get()` always returns `x` (write holds are opt-in,
`policy.holdWrites: true`).

## Visual and CSS checks (new in 0.3.0)

GenClass also measures visual bugs that never throw an error, in 26 kinds (23 before `0.3.0-beta.2`): text nearly the
colour of its background, images, fonts, stylesheets and media that failed to load, pages that scroll sideways on a
phone, invisible layers that swallow clicks, dialogs hidden behind other elements, and leaks such as "[object Object]"
or "$NaN"; from `0.3.0-beta.2` also a `fetch` or XHR request still pending after 15 s (`request-stalled`, with the
button the page disabled or marked `aria-busy` for it; `visual: { checks: { stallMs } }` sets the wait; long polls,
streams, sockets and endpoints that usually take that long are not checked), ad slots (named so by their id, class or
ad attributes, or cross-site frames at ad sizes) covering 30% of the page, half the first screen or, fixed, 30% of
the screen, or a full-screen ad on top of the page (`ad-heavy`), and text that cannot be read as text (`text-warped`:
lines on top of each other or cut through by their box, half an emoji or another character no font can draw,
mirrored or skewed text, letters spaced wider than words, text drawn below 8 px). Each report names the element,
what was measured and the threshold, and suggests a CSS change:

```
[GenClass] Check (measured): text contrast 1.04:1 on p.hero__subtitle "Ship faster with fewer bugs", below 1.5:1 (WCAG 2.2 contrast formula; unreadable-text threshold): #fafafa on #ffffff from section.hero. Suggested CSS: p.hero__subtitle { color: #737373; }
```

These are measured checks with fixed thresholds, reported as kind `"check"`; the model never sees them and they never
feed a decision. They skip what they cannot know (text over photos, video, canvases, gradients). They run by default
on development hosts (a dev server's port on `localhost` and similar, `*.test` names) and when the devtools overlay
mounts; elsewhere turn them on with `visual: true`. First-load cost is about 0.5 KB gzip; the checks load 1.5 s after
`load`, read the page in idle slices of 8 ms and send only their counts (from `0.3.0-beta.5`, see
[Privacy and telemetry](#privacy-and-telemetry)). Opt-in fixes (`visual: { on: true, fix: true }` in
guard or heal mode) are re-measured and undoable. `checkPage()` from `@genclass/runtime/visual` runs one pass in a
test; `npx @genclass/runtime@beta scan <url>` checks any URL without one ([Audit a page](#audit-a-page)).

The first pass waits for web fonts (at most 3 s), then for 500 ms with nothing in flight (requests, socket connects,
`rt.op()` and `protect()` calls) and no DOM change (at most 10 s): it runs about 2 s after `load` on a quiet page, and
about 11.5 s after it (14.5 s when fonts take their full 3 s too) on a page that is never quiet, such as one with a
JavaScript animation that writes inline styles on every frame. While that animation runs, re-checks of content that
changed wait too. Marking a purely decorative animation `data-genclass-ignore` keeps it out of both waits (GenClass
then also ignores taps and inputs inside it).

On the demos, templates and compat apps: 0 false reports in 128 page views, and in the bench's run 5 recall 1.00 on
planted faults for 19 of the 23 kinds (0.67 to 0.96 for the other four; the planted forms are the checks' author's).
The checks were tuned on 40 public home pages, where run 5's 6 findings in 97 loads were not reviewed, so there is no
false-report rate for other sites yet
([RESULTS.md §14](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/RESULTS.md#14-visual-bench-false-reports-recall-and-cost-github-runners-chromium-153-2026-10-13-branch-wave2visual)).
`request-stalled` on the demos: 0 false reports in 120 clean and chaos runs, and 11 of 18 planted 60 s hangs found
(polls on a learned schedule are skipped by design;
[RESULTS.md §23](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/RESULTS.md#23-issue-94-request-stalled-on-the-demos-and-the-first-load-cost-of-summaryrequests-local-2026-10-25-branch-issue-94)).
Every kind: [API.md](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/API.md#measured-visual-checks);
thresholds: [VISUAL.md](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/VISUAL.md).

## Observability

- **Console:** one line per detection and per intervention, with the evidence collapsed below it; identical repeats
  within a minute are summarised. `report: "silent"` or `report: (r) => …` to route them yourself.
- **Events and introspection:** `rt.on("detect" | "decide" | "act" | "report", fn)`; `rt.explain(id)` gives the exact
  situation text the model read, every answer with probabilities, and what changed; `rt.decisions()`,
  `rt.interventions()`.
- **What it saw** (from `0.3.0-beta.2`): `rt.summary().requests` counts this page load's `fetch` and XHR requests, in
  total and per host (`"same-origin"` or the API's host): `requests`, answers by status class (`2xx` to `5xx`),
  `network` (no answer), `aborted`, `notJson` (read with `response.json()` while the Content-Type is not JSON),
  `byGenClass`, `pending`, and `latency` (`p50`, `p95` of the answers that did not fail). `requests: 0` means GenClass
  did not see your requests (it loaded after them, or the app keeps its own `fetch` reference); requests counted with
  nothing in `detections` means it saw them and nothing was salient (a 404 or a non-JSON answer your own `catch`
  handles is counted, not reported). It is counted by the measured checks' chunk, so it is there wherever the checks
  run (development hosts by default; `visual: true` or `data-visual="on"` in production, the devtools overlay,
  `rt.checkNow()`), costs no first-load bytes, and stays in the page: telemetry does not send it.
- **Undo and audit:** `ActionRecord.undo()` for `discard`, late reverts, `rollback` and custom actions with `onUndo`;
  altered responses carry an `x-genclass` header. `rt.audit()` records every decision, action, undo and mode change
  with the gate, the probabilities and the model's sha256.
- **What it touches:**
  [INTERCEPTION.md](https://github.com/genclass-dev/GenClass/blob/main/packages/runtime/INTERCEPTION.md) lists
  every API GenClass wraps or listens to, what each mode may change, and every action's undo (a unit test keeps it in
  sync with the code).
- **Devtools overlay** with six views: Interventions (with Undo), Detections, Checks, Activity (requests, writes,
  user actions and errors with their causal links), Expectations and Now. It is a separate chunk, so load it in
  development only (`init` does this for you):

```ts
if (import.meta.env.DEV) {
  const { mountDevtools } = await import("@genclass/runtime/devtools");
  mountDevtools(rt);
}
```

### See it where you already look

In production the console lines print in your users' browsers. Sinks also send every detection, intervention, undo
and error to your side: JSON console lines for a log shipper (`console-json`), batched POSTs to your endpoint
(`webhook`), or a function or `{ send }` object of yours. `npx @genclass/runtime@beta init --sink webhook:/genclass`,
`data-sink="webhook:/genclass"`, or `sinks: [consoleJson(), webhook({ url: "/genclass" })]` from
`@genclass/runtime/sinks` (adapters and names: new in `0.3.0`). A sink never gets the situation text, bodies, headers
or cookies. Forwarding to Sentry, PostHog or Datadog is not part of the runtime: for an app in a GenClass account
with telemetry on and a token, the genclass.dev collector forwards likely detections once you turn it on in the
dashboard (every plan, Free included). Details:
[SINKS.md](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/SINKS.md).

## Configuration

GenClass runs with safe defaults (`mode: "observe"`, a `"balanced"` gate once you opt into guard or heal, circuit
breaker on). The options narrow where it acts, cap how much it does, and send findings to your tools; none of them
tell the model what a bug looks like.

- **Your app** (`0.3.0`): `token` ([Your dashboard](#your-dashboard)), `scope` ([protect()](#function-specific-protect)).
- **Activation**: `enabled` (a boolean, a predicate or a feature flag; while false the model is never downloaded),
  `rt.disable({ undo: true })` (remote kill that also rolls back recent actions), `sample` (the share of sessions
  allowed to act).
- **Scope**: `routes` (per-route mode, which can only be lowered), `requests.ignore`, `requests.protect` (endpoints
  never held, retried, cached or discarded), `requests.labels`.
- **Safety**: `breaker` (automatic downgrade after undos or errors), `shadow` (records what a higher mode would have
  done), `onBeforeAction` (a synchronous veto), `policy.actionLimits`, `policy.holdBudgetMs`.
- **Reporting and loading**: `sinks`, `session` (tags, never shown to the model), `report: "interventions"`,
  `rt.summary()`; `model.loadIf`, `model.preload`, `model.maxDecisionsPerMinute`, `model.unloadAfterIdleMs`.

URL overrides can only lower settings. `?genclass=observe|guard|heal` and `localStorage.genclass` may also raise the
mode on a development host (http(s) on `localhost`, `127.0.0.1`, `[::1]` or `*.localhost` with an explicit port, or
`*.test`); since `0.3.0-beta.2` and `0.2.3`, `debug: true` no longer lets a link raise anything (it is console logging
only), and `?genclass-mode`, `?genclass-aggr` and `?genclass-sample` only demote. `rt.status.effectiveMode` is the mode
in force now.

```ts
import { GenClass, protectPreset } from "@genclass/runtime";

const rt = GenClass.init({
  mode: "guard",
  aggressiveness: "cautious",
  sample: 0.1,                                       // 10% of sessions act, 90% observe
  routes: [{ match: "/checkout/*", mode: "observe" }, { match: /^\/admin/, mode: "off" }],
  requests: { ignore: [/sentry\.io/], protect: [...protectPreset("payments", "auth"), "/api/cart"] },
  breaker: { undos: 2, errorsAfterAction: 3, downgradeTo: "observe" },
  shadow: "heal",
  report: import.meta.env.PROD ? "interventions" : "console",
});
```

**Payments, checkout and sign-in: keep them observe-only.** Automatic intervention in money and identity flows is not
recommended. `requests.protect` is checked first, in every mode, and covers the request, its response and everything
its response callbacks cause. `protectPreset("payments", "auth")` (in JSON configs, `"preset:payments"`,
`"preset:auth"`) matches checkout, payment, billing, order, Stripe-style and sign-in URLs;
`npx @genclass/runtime@beta init` suggests them when your project uses a payment SDK
([INTERCEPTION.md](https://github.com/genclass-dev/GenClass/blob/main/packages/runtime/INTERCEPTION.md#money-and-identity-flows)).

**Rollout recipe:** start with `mode: "observe", shadow: "guard"`, then `mode: "guard", sample: 0.05`, and widen
`sample` while `rt.summary().undos` and `breaker` events stay quiet. Every option:
[API.md](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/API.md#options); why each exists:
[OPTIONS-SPEC.md](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/OPTIONS-SPEC.md).

## Ask it questions

The model answers typed questions about what is happening now:

```ts
const busy = await rt.ask({ type: "noul", instructions: "Is a save in flight or failing?" });
// { type: "noul", noul: <calibrated P(true)> }

const when = await rt.decide("Which upload strategy fits what is happening now?", {
  now: "start the upload immediately",
  later: "wait until the network is calm and the user is idle",
});
// "now" | "later"
```

Without a model both reject with `GenClassUnavailableError`. Short factual questions about the current situation work
best; it is not a general-purpose reasoner.

## Extend it

Plugins (`rt.use({ name, setup, actions, ... })`) can add observers, facts, actions, standing questions and diagnosis
labels. The model reads each action's description; the goal is that clearly described actions work without
retraining, which has not been measured
([API.md](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/API.md#plugins)).

## Performance

- **Most work never reaches the model.** `test/review-perf.test.ts` (run in CI, reported, not blocking) holds a
  keystroke write into a store with a 5,000-item array under 1 ms, a Redux-style dispatch on 5,000 entities under
  1 ms (2 ms for a write from async work) and a settled-point check under 16 ms. Its last recorded run (a shared VM,
  2026-10-07, the runtime just before `0.1.0-alpha.1`, commit `bac4409`; not re-recorded since) measured 0.22 ms,
  about 0.7 ms and 0.3 ms.
- **Bundle:** the published `0.3.0-beta.0` measured 108.25 KB gzip for `/auto` and 100.13 KB for the main entry
  ([RESULTS.md §10](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/RESULTS.md#10-release-030-beta0-first-load-and-telemetry-volume-ci)).
  The interaction-analytics stub measured about 108.5 / 100.4 KB on its branch (§15); `0.3.0-beta.1` to `beta.4` are
  not re-measured here (`summary().requests` added 34 B in `0.3.0-beta.2`, §23), and `test/bundle.test.ts` keeps them
  under 109.0 KB and 100.7 KB (the limits follow CI's gzip on Node 22; RESULTS.md §14 lists each raise). The model worker, ONNX
  Runtime, the devtools, the sinks and the visual checks load on demand; ONNX Runtime's `.wasm` (3.1 MB brotli; 5.5 MB
  with WebGPU, per the install tests) is never part of your build. The script-tag file is about 129 KB gzip.
- **Model:** with onnxruntime-web 1.30 on single-thread WASM, a forward pass takes an estimated 182 / 330 / 599 ms at
  500 / 780 / 1,170 tokens (fitted to runs in Node on the training VM, not in a browser), so about 180 ms per decision
  at the single-thread situation budget (1,000 characters). Serving the page with
  `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` enables WASM threads
  (about 3× faster with 4 threads in headless Chromium, measured with GenClass 0.1's 32M-parameter model; not
  re-measured for model 0.2.0; model card).
- **Holds are bounded.** A held response or request waits at most the hold budget (by default 1.5 × the median of
  the last 20 model latencies, clamped to 150 to 800 ms), then proceeds unchanged. Background decisions have a 5 s
  deadline.

## Content-Security-Policy and self-hosting

By default the model files and ONNX Runtime's wasm come from `https://cdn.jsdelivr.net`, fetched by a worker. A policy
whose `connect-src` does not allow that origin blocks them: GenClass then keeps observing without a model and prints
**one** console warning naming the blocked origin and the fix. Either allow `https://cdn.jsdelivr.net` in
`connect-src`, or self-host (no third-party origin):

```bash
npx @genclass/runtime@beta fetch-model public/genclass-model   # model + ONNX Runtime files (into public/genclass-model/ort/)
npx @genclass/runtime@beta init --model-url /genclass-model/   # or pass the options yourself:
```

```ts
GenClass.init({ model: { baseUrl: "/genclass-model/", ortWasmPaths: "/genclass-model/ort/" } });
```

- `fetch-model` downloads every model variant and both ONNX Runtime builds (about 64 MB); `--variant q8 --ort wasm` is
  about 24 MB (then set `model.device: "wasm"`; `init --model-url` does this when it finds only the WASM build). The
  WebGPU build's wasm is 27 MB, over the 25 MiB per-file limit of some static hosts such as Cloudflare: use
  `--ort wasm` there. `info <dir>` verifies a downloaded directory's files.
- The policy also needs `'wasm-unsafe-eval'` in `script-src` and `worker-src 'self'` (or `blob:` for the script tag).
  When the worker cannot start, the model runs on the main thread (about 180 ms of blocking per decision on
  single-thread WASM) unless you pass `model: { inlineFallback: false }`.
- Anonymous diagnostics (on by default on public hosts) go to `https://genclass.dev/api/v1/events`: add
  `https://genclass.dev` to `connect-src`, or pass `telemetry: false`. A blocked page stops after 3 failed requests.
- A webhook sink on another origin needs that origin in `connect-src`.

CLI: `init`, `remove`, `login`, `connect`, `whoami`, `logout`, `dashboard`, `scan <url>` (alias `audit`, from
`0.3.0-beta.2`: [Audit a page](#audit-a-page)), `fetch-model <dir>` (self-hosting) and `info <dir>`;
`npx @genclass/runtime@beta --help` lists them, and `init --help` and `login --help` give every flag (Next.js-only
`--strategy`: INSTALL.md).

## Questions

Short answers to the common questions (how to find race conditions in a React app, whether it changes what the app
does, how accurate it is, what it costs, what it sends) are in the
[FAQ](https://github.com/genclass-dev/GenClass/blob/main/FAQ.md). Ask anything else, or report a bug or a false
detection, on [GitHub Issues](https://github.com/genclass-dev/GenClass/issues) or
[Discord](https://discord.gg/kN9kRnFtZm). Security reports:
[SECURITY.md](https://github.com/genclass-dev/GenClass/blob/main/SECURITY.md).

## Documentation

- [Install](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/INSTALL.md): every `init` flag, tested setups
- [Dashboard and CLI](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/DASHBOARD.md): accounts, `login`, `.genclass.local`
- [Configuration](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/OPTIONS-SPEC.md) and [API](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/API.md): every option and export
- [Sinks](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/SINKS.md) · [Visual checks](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/VISUAL.md) · [Threat model](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/THREAT-MODEL.md)
- [What it intercepts](https://github.com/genclass-dev/GenClass/blob/main/packages/runtime/INTERCEPTION.md) · [Telemetry](https://github.com/genclass-dev/GenClass/blob/main/packages/runtime/TELEMETRY.md)
- [Measured results](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/RESULTS.md) · [Compatibility matrix](https://github.com/genclass-dev/GenClass/blob/main/compat/RESULTS.md) · [Model card](https://github.com/genclass-dev/GenClass/blob/main/packages/runtime-model/MODEL_CARD.md)
- [Changelog](https://github.com/genclass-dev/GenClass/blob/main/packages/runtime/CHANGELOG.md) · [All documents and the glossary](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/README.md#glossary)

## License

Apache-2.0. The model package, `@genclass/runtime-model` (Apache-2.0), comes with its own
[model card](https://github.com/genclass-dev/GenClass/blob/main/packages/runtime-model/MODEL_CARD.md).
