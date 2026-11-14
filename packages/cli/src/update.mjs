// A newer `genclass` on npm, said in one line when the command opens on a terminal. The check is npm's dist-tags for
// this package, at most once a day, remembered next to the sign-in (prefs.json): the line comes from what the last
// check found, so a run never waits on the network for it. "Newer" is the newer of `latest` and the dist-tag of the
// line this build is on (`alpha` for 0.4.0-alpha.N, as release-cli.yml publishes it), and the line names that tag.
//
// Invariants:
// - One request a day at most, to npm's public registry, with nothing about the person or the project in it; 1.5 s
//   timeout. None in CI, without a terminal, with --json or --yes, or with NO_UPDATE_NOTIFIER or GENCLASS_NO_UPDATE set.
// - Never throws and never changes the exit code; a failed check is simply not remembered.
// - A release is never told about a prerelease line: only the line `current` is on is read besides `latest`.

import { compareVersions, newestFor } from "./doctor.mjs";
import { readPrefs, savePrefs } from "./name.mjs";

const DAY = 24 * 60 * 60 * 1000;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Whether the notice may run at all here. */
export function updateAllowed(o = {}, env = process.env, tty = !!process.stdout.isTTY) {
  return tty && !o.json && !o.yes && !env.CI && !env.NO_UPDATE_NOTIFIER && !env.GENCLASS_NO_UPDATE;
}

/** The dist-tags the last check remembered: `latest` (latestGenclass, as before) and the others (genclassTags). */
function rememberedTags(prefs) {
  const tags = prefs.genclassTags && typeof prefs.genclassTags === "object" && !Array.isArray(prefs.genclassTags) ? { ...prefs.genclassTags } : {};
  if (typeof prefs.latestGenclass === "string") tags.latest = prefs.latestGenclass;
  return tags;
}

/** The line to print for `current`, from what the last check found, or null. */
export function updateLine(current, prefs = readPrefs()) {
  const { version: latest, tag } = newestFor(current, rememberedTags(prefs));
  if (!latest || compareVersions(current, latest) >= 0) return null;
  return { latest, text: `genclass ${latest} is out (this is ${current}): npm install -g genclass@${tag}` };
}

/**
 * Asks npm for the newest releases when the last check is a day old; remembers `latest` and the other dist-tags
 * (each a version; a dozen at most). Resolves when done (≤ 1.5 s).
 */
export async function refreshLatest(now = Date.now(), fetchFn = globalThis.fetch, prefs = readPrefs()) {
  if (typeof fetchFn !== "function") return;
  if (Number(prefs.latestCheckedAt) > now - DAY) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const r = await fetchFn("https://registry.npmjs.org/-/package/genclass/dist-tags", { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!r.ok) return;
    const j = await r.json();
    if (!j || typeof j.latest !== "string" || !/^\d+\.\d+\.\d+/.test(j.latest)) return;
    const tags = {};
    for (const [k, v] of Object.entries(j).slice(0, 12)) if (k !== "latest" && /^[a-z][a-z0-9-]{0,20}$/i.test(k) && typeof v === "string" && VERSION.test(v)) tags[k] = v;
    savePrefs({ latestGenclass: j.latest, genclassTags: tags, latestCheckedAt: now });
  } catch {
    /* offline: try again next run */
  } finally {
    clearTimeout(timer);
  }
}
