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
