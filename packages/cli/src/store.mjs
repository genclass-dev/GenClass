// What the `genclass` command remembers about a project between runs: the site's address it was given and a summary
// of the last suggestions run. Kept next to the CLI session, outside the project, so nothing is added to a repository.
//
// Invariants:
// - One small JSON file per project folder, named by a hash of the folder's path, in the directory of the credentials
//   file (mode 700). It holds an address, counts, check ids and a date: no code, no evidence lines, no secrets.
// - Best effort: a file that cannot be read is "nothing remembered", and one that cannot be written is ignored.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { credentialsPath } from "../../runtime/bin/lib/account.mjs";

const fileFor = (dir) => join(dirname(credentialsPath()), "projects", `${createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 24)}.json`);

/**
 * @param {string} dir the project folder
 * @returns {{ site?: string, suggest?: { at: string, failed: number, urgent: number, passed: number, top: string[] } }}
 */
export function readNotes(dir) {
  try {
    const j = JSON.parse(readFileSync(fileFor(dir), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/** Merges `patch` into the project's notes. Returns whether it was written. */
export function saveNotes(dir, patch) {
  try {
    const file = fileFor(dir);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify({ ...readNotes(dir), ...patch, dir: resolve(dir) }, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
