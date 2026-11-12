// Questions at a terminal (packages/runtime/bin/lib/ui.mjs ask; src/tui.mjs typed, agree, pick), with a stand-in for
// the terminal's input. Two things a real terminal showed that no other test could: a question asked right after
// another must still get its answer, and input that ends is never a yes.
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ask, inputClosed } from "../../runtime/bin/lib/ui.mjs";
import { agree, pick, typed } from "../src/tui.mjs";

const input = new PassThrough();
(input as unknown as { isTTY: boolean }).isTTY = true;
const real = Object.getOwnPropertyDescriptor(process, "stdin")!;

beforeAll(() => {
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
});
afterAll(() => {
  Object.defineProperty(process, "stdin", real);
  vi.restoreAllMocks();
});

const turn = () => new Promise((r) => setImmediate(r));
/** The promise's value, or "NO ANSWER" when nothing came within half a second. */
const within = <T>(p: Promise<T>) => Promise.race([p, new Promise<string>((r) => setTimeout(() => r("NO ANSWER"), 500))]);

describe("genclass: questions at a terminal (ui.mjs ask, tui.mjs typed, agree, pick)", () => {
  it("a question asked the moment the one before it was answered still gets its answer", async () => {
    const first = ask("first? ");
    await turn();
    input.write("one\n");
    expect(await within(first)).toBe("one");
    // nothing that waits between the two: the guided setup's suggestions step asks for an address right after Enter.
    // Before the fix the first question's interface closed a turn later and paused the input the second one reads,
    // and the command ended at the prompt.
    const second = ask("second? ");
    await turn();
    await turn();
    input.write("two\n");
    expect(await within(second)).toBe("two");
    // three in a row, through the helpers the commands use
    const a = typed("a? ");
    await turn();
    input.write("\n");
    expect(await within(a)).toBe("");
    const b = agree("b? ", true);
    await turn();
    await turn();
    input.write("\n");
    expect(await within(b)).toBe(true);
    const c = pick("c?", ["x", "y", "z"], 0);
    await turn();
    await turn();
    input.write("2\n");
    expect(await within(c)).toBe(1);
    expect(inputClosed()).toBe(false);
  });

  it("lines typed ahead in one chunk answer the questions that follow, in order", async () => {
    const first = ask("first? ");
    await turn();
    input.write("alpha\nbeta\ngamma\n");
    expect(await within(first)).toBe("alpha");
    expect(await within(ask("second? "))).toBe("beta");
    expect(await within(ask("third? "))).toBe("gamma");
  });

  it("input that ends is a stop: never an Enter, never a yes, never a pick", async () => {
    const waiting = typed("still there? ");
    await turn();
    input.end();
    expect(await within(waiting)).toBeNull();
    expect(inputClosed()).toBe(true);
    // from here on every question comes back at once, and none of them counts as an answer
    expect(await within(typed("again? "))).toBeNull();
    expect(await within(agree("write the file? ", true))).toBe(false);
    expect(await within(agree("send it? ", false))).toBe(false);
    expect(await within(pick("which?", ["install", "check", "skip"], 0))).toBeNull();
  });
});
