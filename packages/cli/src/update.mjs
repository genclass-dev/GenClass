// A newer `genclass` on npm, said in one line when the command opens on a terminal. The check is npm's dist-tags for
// this package, at most once a day, remembered next to the sign-in (prefs.json): the line comes from what the last
// check found, so a run never waits on the network for it.
//
// Invariants:
// - One request a day at most, to npm's public registry, with nothing about the person or the project in it; 1.5 s
//   timeout. None in CI, without a terminal, with --json or --yes, or with NO_UPDATE_NOTIFIER or GENCLASS_NO_UPDATE set.
// - Never throws and never changes the exit code; a failed check is simply not remembered.

import { readPrefs, savePrefs } from "./name.mjs";
import { compareVersions } from "./doctor.mjs";

const DAY = 24 * 60 * 60 * 1000;

/** Whether the notice may run at all here. */
export function updateAllowed(o = {}, env = process.env, tty = !!process.stdout.isTTY) {
  return tty && !o.json && !o.yes && !env.CI && !env.NO_UPDATE_NOTIFIER && !env.GENCLASS_NO_UPDATE;
}

/** The line to print for `current`, from what the last check found, or null. */
export function updateLine(current, prefs = readPrefs()) {
  const latest = typeof prefs.latestGenclass === "string" ? prefs.latestGenclass : null;
  if (!latest || compareVersions(current, latest) >= 0) return null;
  return { latest, text: `genclass ${latest} is out (this is ${current}): npm install -g genclass@latest` };
}

/** Asks npm for the newest release when the last check is a day old; remembers it. Resolves when done (≤ 1.5 s). */
export async function refreshLatest(now = Date.now(), fetchFn = globalThis.fetch, prefs = readPrefs()) {
  if (typeof fetchFn !== "function") return;
  if (Number(prefs.latestCheckedAt) > now - DAY) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const r = await fetchFn("https://registry.npmjs.org/-/package/genclass/dist-tags", { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!r.ok) return;
    const j = await r.json();
    if (j && typeof j.latest === "string" && /^\d+\.\d+\.\d+/.test(j.latest)) savePrefs({ latestGenclass: j.latest, latestCheckedAt: now });
  } catch {
    /* offline: try again next run */
  } finally {
    clearTimeout(timer);
  }
}
