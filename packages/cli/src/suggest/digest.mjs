// What `genclass suggest` sends to genclass.dev to get a plan: the checks that failed, each with the few evidence
// lines that were measured, and five words about the app. This is the whole of it, and the command shows it to the
// person before the first time it is sent.
//
// Invariants:
// - No source code, no file contents, no environment values and no secrets: a check's evidence is a status code, a
//   tag's text, or a file name and line (checks.mjs), and it is cut and cleaned again here.
// - Only failed checks are sent, with a count of the ones that passed and the ones that could not be checked.
// - The shape is the one the server reads (telemetry-worker/src/suggest.ts readDigest); a field it does not know is
//   dropped there.

import { clean } from "../tui.mjs";

/** The most failed checks sent (the server's limit). */
export const MAX_CHECKS = 60;

/**
 * @param {{ name: string | null, framework: string | null, site: string | null, payments: string | null, hosting: string | null }} app
 * @param {{ id: string, area: string, title: string, weight: number, status: string, evidence: string[] }[]} results  every check's result
 */
export function buildDigest(app, results) {
  const failed = results.filter((r) => r.status === "fail").slice(0, MAX_CHECKS);
  return {
    app: {
      name: app.name ? clean(app.name, 80) : null,
      framework: app.framework ? clean(app.framework, 60) : null,
      site: app.site ? clean(app.site, 200) : null,
      payments: app.payments ? clean(app.payments, 30) : null,
      hosting: app.hosting ? clean(app.hosting, 30) : null,
      // what the site says it is about (its title and meta description): the design ideas fit the company with it
      about: app.about ? clean(app.about, 300) : null,
    },
    checks: failed.map((r) => ({ id: r.id, area: r.area, title: clean(r.title, 100), weight: r.weight, evidence: (r.evidence ?? []).slice(0, 3).map((e) => clean(e, 160)).filter(Boolean) })),
    passed: results.filter((r) => r.status === "pass").length,
    unknown: results.filter((r) => r.status === "unknown").length,
  };
}

/** The lines that say, in plain words, what a digest holds (shown before it is sent). */
export function describeDigest(d) {
  const about = [d.app.name && "its name", d.app.framework && "its framework", d.app.site && "its address", d.app.about && "its site's title and description", d.app.payments && "its payment provider", d.app.hosting && "its host"].filter(Boolean);
  return [
    `The ${d.checks.length} check${d.checks.length === 1 ? "" : "s"} that failed, each with its title and the evidence lines printed below.`,
    about.length ? `About the app: ${about.join(", ")}.` : null,
    "No source code, no file contents and no secrets. genclass.dev passes this to the model that writes the plan, and keeps the plan it writes for this app, not what was sent.",
  ].filter(Boolean);
}
