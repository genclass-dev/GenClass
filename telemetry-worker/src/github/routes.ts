// From the files a pull request changes to the page routes those files serve, by the file-system routing conventions
// of Next.js (app and pages routers), SvelteKit, Nuxt, Astro and Remix / React Router. Pure: paths in, patterns out.
//
// What this is for, and what it is not:
// - It only decides which of a linked app's production findings are listed as "on pages this pull request touches"
//   and which are counted as "elsewhere". It never decides that something is a bug and never reads file contents:
//   the path alone is used.
// - A file that is not a route file by one of these conventions (a component, a store, a server handler, anything in
//   a project without file-system routing) maps to nothing, and the review says so rather than guessing.
// - A root layout would match every page, which says nothing, so it maps to nothing as well.

export interface RoutePattern {
  /** The route as shown: "/posts/:id", "/docs/*". */
  route: string;
  /** Path segments: a literal, or null for a dynamic segment. */
  segments: (string | null)[];
  /** The pattern also covers everything below it (a catch-all route, or a layout). */
  rest: boolean;
  /** The changed file it came from. */
  file: string;
}

const PAGE_EXT = /\.(tsx|ts|jsx|js|mjs|mdx|md|vue|astro|svelte)$/;
const NEXT_APP_FILES = new Set(["page", "layout", "template", "loading", "error", "not-found", "default"]);
const SVELTE_FILES = /^\+(page|layout)(\.server)?\.(svelte|ts|js)$/;
const MAX_SEGMENTS = 12;

/** One bracketed directory or file name as a segment: a literal, null (dynamic), "rest", or "drop". */
function bracket(seg: string): string | null | "\u0000rest" | "\u0000drop" {
  if (/^\(\.{1,3}\)/.test(seg)) seg = seg.replace(/^\(\.{1,3}\)/, ""); // Next.js intercepting routes: (.)photo
  if (/^\(.*\)$/.test(seg)) return "\u0000drop"; // route groups
  if (seg.startsWith("@")) return "\u0000drop"; // Next.js parallel route slots
  if (/^\[\[?\.\.\.[^\]]+\]?\]$/.test(seg)) return "\u0000rest";
  if (/^\[\[?[^\]]+\]?\]$/.test(seg)) return null;
  return seg;
}

function build(file: string, raw: string[], rest = false): RoutePattern | null {
  const segments: (string | null)[] = [];
  for (const s of raw) {
    if (!s) continue;
    const b = bracket(s);
    if (b === "\u0000drop") continue;
    if (b === "\u0000rest") {
      rest = true;
      break;
    }
    // eslint-disable-next-line no-control-regex
    if (typeof b === "string" && (b.length > 80 || /[\u0000-\u001f\s]/.test(b))) return null;
    segments.push(b);
    if (segments.length > MAX_SEGMENTS) return null;
  }
  if (!segments.length && rest) return null; // a root layout or a site-wide catch-all: every page, so no signal
  const route = `/${segments.map((s) => s ?? ":id").join("/")}${rest ? (segments.length ? "/*" : "*") : ""}`;
  return { route, segments, rest, file };
}

/** The directories after the last occurrence of `marker` ("/app/", "/pages/") in a path, and the file's base name. */
function after(path: string, marker: string): { dirs: string[]; base: string } | null {
  const p = `/${path}`;
  const at = p.lastIndexOf(marker);
  if (at < 0) return null;
  const tail = p.slice(at + marker.length).split("/");
  const base = tail.pop() ?? "";
  return { dirs: tail, base };
}

/** The page route a changed file serves, by path alone; null when the path is not a route file. */
export function routeOfFile(path: string): RoutePattern | null {
  if (typeof path !== "string" || path.length > 400 || path.includes("\\") || path.startsWith("/")) return null;
  const parts = path.split("/");
  if (parts.some((s) => s === ".." || s === "." || s === "node_modules")) return null;
  const base = parts[parts.length - 1] ?? "";

  // SvelteKit: src/routes/<dirs>/+page.svelte, +layout.svelte (and their .ts / .server.ts); +server is an endpoint
  if (SVELTE_FILES.test(base)) {
    const a = after(path, "/src/routes/") ?? (path.startsWith("src/routes/") ? after(path, "/src/routes/") : null);
    if (!a) return null;
    return build(path, a.dirs, base.startsWith("+layout"));
  }

  if (!PAGE_EXT.test(base)) return null;
  const stem = base.replace(PAGE_EXT, "");

  // Remix / React Router file routes: app/routes/posts.$id.tsx, app/routes/posts.$id/route.tsx
  const remix = after(path, "/app/routes/");
  if (remix) {
    const name = remix.dirs.length === 0 ? stem : remix.dirs.length === 1 && (stem === "route" || stem === "index") ? remix.dirs[0]! : null;
    if (name === null) return null;
    const segs: string[] = [];
    let rest = false;
    for (const part of name.split(".")) {
      if (part === "_index" || part === "index") continue;
      if (part.startsWith("_")) continue; // a pathless layout
      const seg = part.replace(/_$/, "");
      if (seg === "$") {
        rest = true;
        break;
      }
      segs.push(seg.startsWith("$") || /^\(\$.*\)$/.test(seg) ? "[param]" : seg.replace(/^\((.*)\)$/, "$1"));
    }
    return build(path, segs, rest);
  }

  // Next.js app router: app/<dirs>/page.tsx, layout.tsx, loading.tsx ... (route.ts is an endpoint)
  if (NEXT_APP_FILES.has(stem)) {
    const a = after(path, "/app/");
    if (a) {
      if (a.dirs.some((d) => d.startsWith("_"))) return null; // private folders are not routable
      return build(path, a.dirs, stem === "layout" || stem === "template");
    }
  }

  // pages directories: Next.js pages router, Nuxt, Astro
  const pages = after(path, "/pages/");
  if (pages) {
    if (pages.dirs[0] === "api") return null; // Next.js API routes are not pages
    if (stem.startsWith("_") || pages.dirs.some((d) => d.startsWith("_"))) return null; // _app, _document, Astro's private files
    return build(path, stem === "index" ? pages.dirs : [...pages.dirs, stem]);
  }
  return null;
}

/** Whether a route as the dashboard keys it ("/posts/:id", "/checkout") is one the pattern serves. */
export function matchesRoute(p: RoutePattern, route: string): boolean {
  if (typeof route !== "string" || !route.startsWith("/")) return false;
  const segs = route.split("/").filter(Boolean);
  if (p.rest ? segs.length < p.segments.length : segs.length !== p.segments.length) return false;
  return p.segments.every((s, i) => s === null || s === segs[i]);
}

/** The patterns of a pull request's changed files (at most `max` files are looked at), one per distinct route. */
export function routesOfFiles(files: readonly string[], max = 300): RoutePattern[] {
  const seen = new Map<string, RoutePattern>();
  for (const f of files.slice(0, max)) {
    const p = routeOfFile(f);
    if (p && !seen.has(p.route)) seen.set(p.route, p);
  }
  return [...seen.values()];
}
