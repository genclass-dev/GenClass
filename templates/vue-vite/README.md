# GenClass + Vue + Vite starter

A Vue 3 + Vite app with [`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) installed the
recommended way: one import, first in the entry file.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build && npm run preview   # production build
```

Type a city quickly in the search box. The mock API (`mock-api.ts`, served by Vite) answers in a random 50-900 ms, so
an older answer can overwrite a newer one: the classic stale typeahead. Open the browser console to see what GenClass
noticed: one plain-English `[GenClass]` line per finding.

## The one line

`src/main.ts` starts with:

```ts
import "@genclass/runtime/auto";
```

It goes first so GenClass is installed before Vue and your first requests. GenClass then watches fetch, XHR,
WebSocket, EventSource, user input and timers. `npx @genclass/runtime@beta init` writes the same line into an existing
app.

**What it sees in a Vue app.** Automatic state discovery covers React, Redux and Zustand, not Vue refs or Pinia
yet, so in a Vue app GenClass works from the network and user input: duplicate submits, failure storms, retries and
stalls. Decisions that compare a late response with newer data already in your state need that state registered
(`genclass.atom(...)` / `genclass.guard(...)`, see
[State it can protect](https://github.com/genclass-dev/GenClass/blob/main/packages/runtime/README.md#state-it-can-protect)).

## Observe, then guard

| mode | import | what it does |
|---|---|---|
| observe (default) | `@genclass/runtime/auto` | reports what it finds; never holds, drops or changes anything |
| guard | `@genclass/runtime/auto/guard` | also prevents failures with small, reversible actions (reuse a duplicate's result, back off) when its model is confident |
| heal (experimental) | `@genclass/runtime/auto/heal` | also retries, serves cached data, blocks a runaway request |

Start in observe, watch the console for a while on real traffic, then switch the import to `/auto/guard`. Every action
is logged with its evidence.

## Devtools overlay (opt-in)

The template draws nothing on the page. To see the devtools overlay while you develop, name the import and add the
overlay line at the end of `src/main.ts`:

```ts
import genclass from "@genclass/runtime/auto";
// ...
if (import.meta.env.DEV) import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass));
```

## Turning it off

- For one page load: add `?genclass=off` to the URL (nothing is installed).
- For a browser: `localStorage.genclass = "off"`.
- For good: remove the import (or run `npx @genclass/runtime@beta remove`).

## Privacy

In a browser, GenClass sends anonymous, redacted diagnostics by default
([TELEMETRY.md](https://github.com/genclass-dev/GenClass/blob/main/packages/runtime/TELEMETRY.md)).
To turn that off, add to `index.html`'s `<head>`:

```html
<meta name="genclass" content="telemetry=off">
```

## Compatibility

This setup is part of the public compatibility matrix (Vue 3 + Vite 8 with Pinia): see
[compat/RESULTS.md](https://github.com/genclass-dev/GenClass/blob/main/compat/RESULTS.md).
