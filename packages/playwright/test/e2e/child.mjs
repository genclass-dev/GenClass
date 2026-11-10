// One child process of the end-to-end check (Playwright itself in run.mjs, the command genclass-playwright-run in
// unmodified.mjs), with a time limit, so the check cannot hang on a browser that never starts or a run that never
// ends. The child's stdout and stderr are collected in the order they arrive.
//
// Invariants:
//   - runNode always resolves, and within timeoutMs + graceMs + DRAIN_MS of its start: after timeoutMs the child gets
//     SIGTERM (Playwright stops its workers, its browsers and its web server on it, and the command passes it on and
//     removes its generated config); graceMs later the child's whole process group gets SIGKILL; a child that has
//     exited while something it started still holds its output open is waited for DRAIN_MS, no longer, and its
//     output is then let go of, so that nothing of it keeps the check itself from ending;
//   - it never throws and never rejects: a child that could not be started comes back with `error`;
//   - a SIGINT or SIGTERM sent to the check while a child runs is passed on to that child.

import { spawn } from "node:child_process";

/** How long a child that has exited is given for the rest of its output, in ms. */
export const DRAIN_MS = 3000;

/**
 * Starts node with `args` and waits for it to end. Resolves with:
 *   status    the exit code, or null when a signal ended it or it could not be started;
 *   signal    the signal that ended it, or null;
 *   timedOut  true when the time limit ended it;
 *   error     why it could not be started (absent otherwise);
 *   out       everything it wrote to stdout and stderr;
 *   ms        how long it ran.
 */
export function runNode(args, { cwd, env, timeoutMs, graceMs = 15_000 }) {
  return new Promise((done) => {
    const t0 = Date.now();
    let out = "";
    let timedOut = false;
    let settled = false;
    let term = null;
    let kill = null;
    let drain = null;
    let child = null;
    const pass = (signal) => {
      try {
        child?.kill(signal);
      } catch {
        /* it ended already */
      }
    };
    const onInt = () => pass("SIGINT");
    const onTerm = () => pass("SIGTERM");
    const finish = (r) => {
      if (settled) return;
      settled = true;
      for (const t of [term, kill, drain]) if (t) clearTimeout(t);
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      try {
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        child?.unref();
      } catch {
        /* nothing left to let go of */
      }
      done({ status: null, signal: null, ...r, timedOut, out, ms: Date.now() - t0 });
    };
    try {
      // its own process group (not on Windows), so that the last resort reaches what it started as well
      child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (e) {
      finish({ error: e instanceof Error ? e.message : String(e) });
      return;
    }
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    child.stdout.on("data", (d) => void (out += d.toString()));
    child.stderr.on("data", (d) => void (out += d.toString()));
    term = setTimeout(() => {
      timedOut = true;
      pass("SIGTERM");
      kill = setTimeout(() => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          pass("SIGKILL");
        }
      }, graceMs);
    }, timeoutMs);
    child.once("error", (e) => finish({ error: e.message }));
    child.once("exit", (status, signal) => {
      drain = setTimeout(() => finish({ status, signal }), DRAIN_MS);
    });
    child.once("close", (status, signal) => finish({ status, signal }));
  });
}

/** How a child ended, for a failure message: "exit code 1", "ended by SIGKILL after the 180 s limit", "could not be started (...)". */
export function ending(r, timeoutMs) {
  if (r.error) return `could not be started (${r.error})`;
  const how = r.status !== null ? `exit code ${r.status}` : `ended by ${r.signal ?? "an unknown signal"}`;
  return r.timedOut ? `${how} after the ${Math.round(timeoutMs / 1000)} s limit` : how;
}
