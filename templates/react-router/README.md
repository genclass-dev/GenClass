# GenClass + React Router starter

A React Router 8 app (framework mode, server rendering on) with
[`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) installed the recommended way: one import,
first in `app/entry.client.tsx`.

```bash
npm install
npm run dev                  # http://localhost:5173
npm run build && npm start   # production build
```

Type a city quickly in the search box. The resource route (`app/routes/api.search.ts`) answers in a random 50-900 ms,
so an older answer can overwrite a newer one: the classic stale typeahead. Open the browser console to see what
GenClass noticed: one plain-English `[GenClass]` line per finding.

## The one line

`app/entry.client.tsx` starts with:

```ts
import "@genclass/runtime/auto";
```

It goes first so GenClass is installed before React Router hydrates and before your state exists. GenClass runs in the
browser only: server rendering, loaders on the server and your server's `fetch` are untouched. It watches fetch, XHR,
WebSocket, EventSource, user input and timers, and finds React state on its own (automatic state discovery).
`npx @genclass/runtime@beta init` writes the same line into an existing app (`npx react-router reveal` creates
`entry.client.tsx` if your project does not have one yet).

## Observe, then guard

| mode | import | what it does |
|---|---|---|
| observe (default) | `@genclass/runtime/auto` | reports what it finds; never holds, drops or changes anything |
| guard | `@genclass/runtime/auto/guard` | also prevents failures with small, reversible actions (drop a stale response, reuse a duplicate's result) when its model is confident |
| heal (experimental) | `@genclass/runtime/auto/heal` | also retries, serves cached data, rolls back |

Start in observe, watch the console for a while on real traffic, then switch the import to `/auto/guard`. Every action
is logged with its evidence.

## Devtools overlay (opt-in)

The template draws nothing on the page. To see the devtools overlay while you develop, name the import and add the
overlay line at the end of `app/entry.client.tsx`:

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
To turn that off, add a meta tag to the `<head>` in `app/root.tsx`:

```tsx
<meta name="genclass" content="telemetry=off" />
```

## Compatibility

React Router 8 in framework mode (Vite 8, SSR). The runtime's `init` command is tested end to end on a fresh
React Router framework-mode project; React 19 with plain state, TanStack Query, Zustand, Redux Toolkit and Apollo is
part of the public [compatibility matrix](https://github.com/genclass-dev/GenClass/blob/main/compat/RESULTS.md).
