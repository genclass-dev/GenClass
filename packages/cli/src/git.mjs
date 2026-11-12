// What git says about a folder: whether it is a repository, its GitHub remote as "owner/name" and its branch.
//
// Invariants:
// - Read only: `git rev-parse` and `git remote get-url`, each with a 3 second limit. Nothing is fetched, written or
//   configured, and no credential is read.
// - Never throws: without git, outside a repository or on any failure, the answer is "not a repository".

import { spawnSync } from "node:child_process";

/** Runs `git <args>` in `cwd`: its trimmed output, or null when it failed, timed out or git is missing. */
export function runGit(args, cwd) {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    return r.status === 0 && typeof r.stdout === "string" ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** A GitHub repository's full name as GitHub writes one. */
const FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/** "owner/name" from a GitHub remote (https, ssh or git protocol, with or without ".git"), else null. */
export function githubName(remote) {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/|git:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(String(remote ?? "").trim());
  return m && FULL_NAME.test(m[1]) ? m[1] : null;
}

/**
 * @param {string} cwd
 * @param {(args: string[], cwd: string) => string | null} [run]
 * @returns {{ repo: boolean, root: string | null, remote: string | null, github: string | null, branch: string | null }}
 */
export function gitInfo(cwd, run = runGit) {
  const root = run(["rev-parse", "--show-toplevel"], cwd);
  if (!root) return { repo: false, root: null, remote: null, github: null, branch: null };
  const remote = run(["remote", "get-url", "origin"], cwd);
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return { repo: true, root, remote, github: githubName(remote), branch: branch && branch !== "HEAD" ? branch : null };
}

/**
 * The name GitHub has now for `repo` ("owner/name") when it was renamed or moved since this checkout was cloned:
 * github.com answers the old address with a redirect to the new one. Null when it was not renamed, when the
 * repository is private (GitHub answers 404 to a visitor) or when the question could not be asked. One HEAD request
 * to github.com, four seconds at most; nothing but the repository's own address is sent.
 * @param {string} repo
 * @param {{ fetchFn?: typeof fetch }} [opts]
 */
export async function renamedRepo(repo, opts = {}) {
  const f = opts.fetchFn ?? globalThis.fetch;
  if (typeof f !== "function" || !/^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)) return null;
  try {
    const r = await f(`https://github.com/${repo}`, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(4000), headers: { "user-agent": "genclass-cli" } });
    if (r.status !== 301) return null;
    const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100})\/?$/.exec(r.headers.get("location") ?? "");
    return m && m[1].toLowerCase() !== repo.toLowerCase() ? m[1] : null;
  } catch {
    return null;
  }
}
