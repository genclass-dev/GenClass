# GenClass + React + Vite starter

A React 19 + Vite app with [`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) installed the
recommended way: one import, first in the entry file.

```bash
npm install
npm run dev        # http://localhost:5173, with the GenClass devtools overlay
npm run build && npm run preview   # production build (no overlay)
```

Type a city quickly in the search box. The mock API (`mock-api.ts`, served by Vite) answers in a random
50-900 ms, so an older answer can overwrite a newer one: the classic stale typeahead. Open the overlay (bottom right)
to see what GenClass noticed; the browser console has one plain-English line per finding.

## See the race on demand

Typing fast shows the race only when the mock happens to answer out of order. The URL can set the order instead:

1. Run `npm run dev` and open `http://localhost:5173/?genclass-schedule=seeded:1`.
2. Type `be` in the search box, both letters without a pause.

The list ends on the seven cities that start with "b" instead of Berlin and Bern: the answer for "b" reached the app
last and replaced the answer for "be". With `seeded:1` the answer for "be" is delivered first and the answer for "b"
waits until then, whenever the two requests are in flight together, as on a network that answers out of order. No
answer is changed, only the order in which they reach the app
([AGENT.md section 3](https://github.com/genclass-dev/GenClass/blob/main/docs/runtime/AGENT.md#3-schedules-srcagentschedulets)).

In the browser console, `__GENCLASS_AGENT__.witnesses()` lists the overwrite as an `overwrote-newer` witness on
`App.state1` (the results, the second `useState` in `src/App.tsx`): the response to `GET /api/search#1` (the request
for "b") wrote over the results from `GET /api/search#2` (the request for "be"). A witness is a fact the runtime
records from the order of the writes; no model is involved.

- With `?genclass-schedule=fifo` the answers are delivered in the order the requests were sent, and the same typing
  ends on Berlin and Bern.
- If `seeded:1` ends on Berlin and Bern, the answer for "b" was back before you typed "e" (the mock answers in
  50-900 ms), and an answer that is already back is not held: reload and type the two letters faster. Requests are
  numbered per page load, so after more typing than "be" another seed may give another order: try a few
  (`seeded:2`, `seeded:3`, ...).
- The link that does this is the last block of `src/main.tsx`: development builds only, and only with
  `genclass-schedule` in the URL, so other page loads do not load it. With no MCP server running, its one request to
  127.0.0.1:47357 fails (the browser may log it) and nothing waits for it.

The race is planted, so this is a self-test of the setup: it never counts in "races found" or in launch numbers.

To have a coding agent explore other orders and replay this one, add the GenClass MCP server:

```bash
claude mcp add genclass -- npx -y @genclass/mcp@0.2.2   # other clients: npx -y @genclass/mcp@0.2.2 config <client>
```

Explore gives each page load an order of its own, and a `genclass-schedule` in the URL would override it, so explore
needs every dev page load connected: replace that block with the link `genclass_setup` prints (the same link without
the URL check).

## The one line

`src/main.tsx` starts with:

```ts
import genclass from "@genclass/runtime/auto";
```

It goes first so GenClass is installed before React and your state exist. That is all the setup: GenClass watches
fetch, XHR, WebSocket, EventSource, user input and timers, and finds React state on its own (automatic state
discovery). `npx @genclass/runtime@beta init` writes the same line into an existing app.

## Observe, then guard

| mode | import | what it does |
|---|---|---|
| observe (default) | `@genclass/runtime/auto` | reports what it finds; never holds, drops or changes anything |
| guard | `@genclass/runtime/auto/guard` | also prevents failures with small, reversible actions (drop a stale response, reuse a duplicate's result) when its model is confident |
| heal (experimental) | `@genclass/runtime/auto/heal` | also retries, serves cached data, rolls back |

Start in observe, watch the overlay and the console for a while on real traffic, then switch the import to
`/auto/guard`. Every action is logged with its evidence, and the overlay can undo it.

## Devtools overlay

In `src/main.tsx`, after the render, this line loads the overlay in development only:

```ts
if (import.meta.env.DEV) import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass));
```

It lists detections and actions, explains each decision and lets you switch modes while you develop.

## Turning it off

- For one page load: add `?genclass=off` to the URL (nothing is installed).
- For a browser: `localStorage.genclass = "off"`.
- For good: remove the import (or run `npx @genclass/runtime@beta remove`).

## Privacy

In a browser, GenClass sends anonymous, redacted diagnostics by default
([TELEMETRY.md](https://github.com/genclass-dev/GenClass/blob/main/packages/runtime/TELEMETRY.md)).
To turn that off, set the option before the import runs, for example in `index.html`:

```html
<meta name="genclass" content="telemetry=off">
```

## Compatibility

This setup is part of the public compatibility matrix (React 19 + Vite 8 with plain state, TanStack Query, Zustand,
Redux Toolkit and Apollo): see
[compat/RESULTS.md](https://github.com/genclass-dev/GenClass/blob/main/compat/RESULTS.md).
