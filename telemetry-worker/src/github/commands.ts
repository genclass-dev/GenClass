// "@genclass-dev <command>" or "/genclass <command>" in a pull-request comment. Pure: a comment's text in, at most one
// command out.
//
// Invariants:
// - A command is a line of its own that starts with the bot's mention ("@genclass-dev", or "@genclass-dev[bot]") or with
//   "/genclass", then one known word, then at most a finding number. The short form mentions nobody: "@genclass" is
//   another GitHub account, which a mention would notify, so that spelling is never a command. Mentions in the middle of a sentence, inside a quote ("> ...") or
//   inside a fenced code block are not commands, so quoting the bot's own help text never runs anything.
// - Only the first command of a comment counts, and only the first lines of a comment are looked at.
// - Who may run what is decided by the caller from GitHub's answer about the commenter's permission on the repository
//   (src/github/handlers.ts onComment), not from the association a comment event carries; nothing in the comment can
//   widen it.

export type CommandName = "review" | "replay" | "fix" | "issue" | "help" | "pause" | "resume";

export interface Command {
  name: CommandName;
  /** The finding number the command names, when it names one. */
  n: number | null;
}

/** Commands that act on one finding. */
export const NEEDS_FINDING: readonly CommandName[] = ["replay", "fix", "issue"];
/**
 * Commands only people with write access to the repository may run. The others (review, replay, help) are also the
 * pull request's author's; a `review` from an author without write access does not lift a pause or `ignore_authors`.
 */
export const NEEDS_WRITE: readonly CommandName[] = ["fix", "issue", "pause", "resume"];

const NAMES: Record<string, CommandName> = { review: "review", "re-review": "review", replay: "replay", reproduce: "replay", fix: "fix", issue: "issue", help: "help", pause: "pause", resume: "resume" };
/** The short form: no mention, so it notifies nobody and cannot be taken over by an account of the same name. */
export const SLASH = "/genclass";
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
    let rest: string;
    if (line.slice(0, head.length).toLowerCase() === head) {
      rest = line.slice(head.length);
      if (rest.toLowerCase().startsWith("[bot]")) rest = rest.slice(5);
    } else if (line.slice(0, SLASH.length).toLowerCase() === SLASH) {
      rest = line.slice(SLASH.length);
    } else continue;
    // "@genclass-dev-x fix 1" names someone else and "/genclassy" is another word: the prefix must end here
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
