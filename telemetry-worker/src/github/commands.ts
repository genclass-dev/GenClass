// "@genclass <command>" in a pull-request comment. Pure: a comment's text in, at most one command out.
//
// Invariants:
// - A command is a line of its own that starts with the bot's mention ("@genclass", or "@genclass[bot]"), then one
//   known word, then at most a finding number. Mentions in the middle of a sentence, inside a quote ("> ...") or
//   inside a fenced code block are not commands, so quoting the bot's own help text never runs anything.
// - Only the first command of a comment counts, and only the first lines of a comment are looked at.
// - Who may run what is decided by the caller from GitHub's own data (src/github/handlers.ts); nothing in the comment
//   can widen it.

export type CommandName = "review" | "replay" | "fix" | "issue" | "help" | "pause" | "resume";

export interface Command {
  name: CommandName;
  /** The finding number the command names, when it names one. */
  n: number | null;
}

/** Commands that act on one finding. */
export const NEEDS_FINDING: readonly CommandName[] = ["replay", "fix", "issue"];
/** Commands only people with write access to the repository may run (the others: also the pull request's author). */
export const NEEDS_WRITE: readonly CommandName[] = ["fix", "issue", "pause", "resume"];

const NAMES: Record<string, CommandName> = { review: "review", "re-review": "review", replay: "replay", reproduce: "replay", fix: "fix", issue: "issue", help: "help", pause: "pause", resume: "resume" };
const MAX_LINES = 60;
const MAX_CHARS = 8000;

/** The command in a comment's body for a bot mentioned as `@<mention>`, or null. */
export function parseCommand(body: unknown, mention: string): Command | null {
  if (typeof body !== "string" || !/^[a-z0-9-]{1,40}$/.test(mention)) return null;
  const lines = body.slice(0, MAX_CHARS).split(/\r?\n/).slice(0, MAX_LINES);
  const head = `@${mention}`;
  let fenced = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line.startsWith(">")) continue;
    if (line.slice(0, head.length).toLowerCase() !== head) continue;
    let rest = line.slice(head.length);
    if (rest.toLowerCase().startsWith("[bot]")) rest = rest.slice(5);
    // "@genclass-dev fix 1" names someone else: the mention must end here
    if (!/^[\s,:]/.test(rest)) continue;
    // the whole line is the command: a word, then at most "finding" and a number; anything more is a sentence
    const words = rest.replace(/^[\s,:]+/, "").replace(/[.!?]+$/, "").split(/\s+/).filter(Boolean);
    const name = NAMES[(words[0] ?? "").toLowerCase()];
    if (!name) continue;
    const tail = words.slice(1);
    if (tail[0]?.toLowerCase() === "finding") tail.shift();
    if (tail.length > 1 || (tail.length === 1 && !/^#?\d{1,5}$/.test(tail[0]!))) continue;
    const n = tail.length ? Number(tail[0]!.replace("#", "")) : null;
    return { name, n: n !== null && n > 0 ? n : null };
  }
  return null;
}
