// Page origins (scheme://host:port): which app on this machine a run or a finding came from. Several dev servers can
// run at once (a shop on :5173, an admin on :3000), and their pages share routes ("/"), so findings, status and the
// explore and replay slots tell them apart by origin. A filter is an exact origin or a bare port ("5173").

import type { Run } from "./types.js";

/** The origin of an http(s) URL, or undefined. */
export function originOfUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** A run's origin: the one its hello came from (the browser's Origin header), else its page URL's. */
export function runOrigin(r: Pick<Run, "origin" | "page">): string | undefined {
  return r.origin ?? originOfUrl(r.page.url);
}

/** The port an origin listens on, its scheme's default when it names none. */
function portOf(origin: string): string | null {
  try {
    const u = new URL(origin);
    return u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : null);
  } catch {
    return null;
  }
}

/**
 * A filter from what an agent passed: a bare port ("5173") matches every origin on that port; anything else is read as
 * an origin ("http://localhost:5173", "localhost:5173" with http assumed, a trailing path ignored) and matches exactly.
 * Null when it is neither (the tool says so instead of matching nothing).
 */
export function originFilter(v: unknown): { label: string; test: (origin: string | undefined) => boolean } | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^\d{1,5}$/.test(s)) {
    const port = String(Number(s));
    return { label: `port ${port}`, test: (o) => !!o && portOf(o) === port };
  }
  const want = originOfUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`);
  if (!want) return null;
  return { label: want, test: (o) => o === want };
}

/** Items grouped by origin, the groups in the order their first item comes (so a ranked list stays ranked). */
export function byOrigin<T>(items: T[], of: (x: T) => string | undefined): [string | undefined, T[]][] {
  const groups = new Map<string | undefined, T[]>();
  for (const x of items) {
    const o = of(x);
    const g = groups.get(o);
    if (g) g.push(x);
    else groups.set(o, [x]);
  }
  return [...groups.entries()];
}
