// Monitor with evalship (src/evalship.ts): what each model call sends, that nothing is sent without
// EVALSHIP_PRODUCTION_KEY, that a failed send never reaches the answer, and modelText's hook (src/suggest.ts).
import { beforeEach, describe, expect, it } from "vitest";
import { answer } from "../src/ask.js";
import { callBody, EVALSHIP_CALLS_URL, MAX_FIELD, messagesOf, monitored, reportCall, type ModelCall } from "../src/evalship.js";
import { MODEL_URL, modelText, resetStandIns } from "../src/suggest.js";

beforeEach(() => resetStandIns());

const KEY = "evalship-test-key";
const OPENAI = "sk-test";

const CALL: ModelCall = {
  call: "ask",
  messages: [
    { role: "system", content: "Answer from the numbers only." },
    { role: "user", content: "The app's numbers:\n{\"problems\":3}" },
    { role: "user", content: "Why did problems go up?" },
  ],
  model: "gpt-test",
  output: "Three stale responses on /cart.",
  error: null,
  durationMs: 812.4,
};

interface Sent {
  url: string;
  init?: RequestInit;
}

/** A fetch that answers the model with `content` (or `status`) and evalship with `evalship`, and keeps every request. */
function fakeFetch(o: { content?: string; status?: number; evalship?: number | "throw" } = {}) {
  const sent: Sent[] = [];
  const f = async (url: string, init?: RequestInit): Promise<Response> => {
    sent.push({ url, init });
    if (url === MODEL_URL) {
      if (o.status) return new Response(JSON.stringify({ error: { code: "server_error" } }), { status: o.status });
      return Response.json({ choices: [{ message: { content: o.content ?? "An answer." } }] });
    }
    if (url === EVALSHIP_CALLS_URL) {
      if (o.evalship === "throw") throw new Error("network down");
      return new Response("ok", { status: o.evalship ?? 202 });
    }
    return new Response("", { status: 404 });
  };
  return { f, sent, to: (url: string) => sent.filter((s) => s.url === url) };
}

const bodyOf = (s: Sent): Record<string, unknown> => JSON.parse(String(s.init?.body)) as Record<string, unknown>;

describe("evalship: the body of one call (src/evalship.ts callBody)", () => {
  it("sends the last user message as input and every message as context, the instructions first", () => {
    expect(callBody(CALL)).toEqual({
      call: "ask",
      input: "Why did problems go up?",
      context: "system: Answer from the numbers only.\n\nuser: The app's numbers:\n{\"problems\":3}\n\nuser: Why did problems go up?",
      output: "Three stale responses on /cart.",
      model: "gpt-test",
      duration_ms: 812,
    });
  });

  it("says why there is no answer when the call failed", () => {
    const b = callBody({ ...CALL, output: null, error: "HTTP 500" });
    expect(b.output).toBe("");
    expect(b.error).toBe("HTTP 500");
    expect(callBody({ ...CALL, output: null, error: null }).error).toBe("no text in the answer");
  });

  it("cuts a field that is too long", () => {
    const b = callBody({ ...CALL, output: "x".repeat(MAX_FIELD + 50) });
    expect((b.output as string).length).toBe(MAX_FIELD);
  });

  it("reads only messages with text content from a request body", () => {
    expect(messagesOf({ messages: [{ role: "system", content: "a" }, { role: "user", content: [{ type: "image" }] }, null, { role: "user", content: "b" }] })).toEqual([
      { role: "system", content: "a" },
      { role: "user", content: "b" },
    ]);
    expect(messagesOf(undefined)).toEqual([]);
  });
});

describe("evalship: sending (src/evalship.ts reportCall)", () => {
  it("sends nothing without EVALSHIP_PRODUCTION_KEY", async () => {
    const { f, sent } = fakeFetch();
    expect(monitored({})).toBe(false);
    expect(monitored({ EVALSHIP_PRODUCTION_KEY: "  " })).toBe(false);
    await reportCall({}, f, CALL);
    await reportCall({ EVALSHIP_PRODUCTION_KEY: " " }, f, CALL);
    expect(sent).toEqual([]);
  });

  it("posts the body with the key when it is set", async () => {
    const { f, sent } = fakeFetch();
    await reportCall({ EVALSHIP_PRODUCTION_KEY: KEY }, f, CALL);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(EVALSHIP_CALLS_URL);
    expect(sent[0].init?.method).toBe("POST");
    expect(new Headers(sent[0].init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(bodyOf(sent[0])).toEqual(callBody(CALL));
    expect(sent[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("never rejects when evalship fails or cannot be reached", async () => {
    for (const evalship of [500, "throw"] as const) {
      const { f, sent } = fakeFetch({ evalship });
      await expect(reportCall({ EVALSHIP_PRODUCTION_KEY: KEY }, f, CALL)).resolves.toBeUndefined();
      expect(sent).toHaveLength(1);
    }
  });

  it("hands the send to waitUntil when there is one", async () => {
    const { f, sent } = fakeFetch();
    const deferred: Promise<unknown>[] = [];
    await reportCall({ EVALSHIP_PRODUCTION_KEY: KEY }, f, CALL, (p) => deferred.push(p));
    expect(deferred).toHaveLength(1);
    await deferred[0];
    expect(sent.map((s) => s.url)).toEqual([EVALSHIP_CALLS_URL]);
  });
});

describe("evalship: every model call is sent (src/suggest.ts modelText)", () => {
  const body = (model: string) => ({ model, messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Hello" }] });

  it("sends the call after the model answered, and the answer is unchanged", async () => {
    const { f, sent, to } = fakeFetch({ content: "Hi." });
    const text = await modelText({ OPENAI_API_KEY: OPENAI, EVALSHIP_PRODUCTION_KEY: KEY, SUGGEST_MODEL: "gpt-test" }, f, "suggest", body);
    expect(text).toBe("Hi.");
    expect(sent.map((s) => s.url)).toEqual([MODEL_URL, EVALSHIP_CALLS_URL]);
    const b = bodyOf(to(EVALSHIP_CALLS_URL)[0]);
    expect(b).toMatchObject({ call: "suggest", input: "Hello", context: "system: Be brief.\n\nuser: Hello", output: "Hi.", model: "gpt-test" });
    expect(b.error).toBeUndefined();
    expect(typeof b.duration_ms).toBe("number");
    // the OpenAI key never goes to evalship
    expect(JSON.stringify(to(EVALSHIP_CALLS_URL)[0].init)).not.toContain(OPENAI);
  });

  it("sends a failed call with its reason, and the answer is still null", async () => {
    const { f, to } = fakeFetch({ status: 500 });
    const text = await modelText({ OPENAI_API_KEY: OPENAI, EVALSHIP_PRODUCTION_KEY: KEY }, f, "report", body);
    expect(text).toBeNull();
    expect(bodyOf(to(EVALSHIP_CALLS_URL)[0])).toMatchObject({ call: "report", output: "", error: "HTTP 500" });
  });

  it("sends nothing to evalship without its key, and nothing at all without a model key", async () => {
    const a = fakeFetch();
    await modelText({ OPENAI_API_KEY: OPENAI }, a.f, "ask", body);
    expect(a.sent.map((s) => s.url)).toEqual([MODEL_URL]);
    const b = fakeFetch();
    expect(await modelText({ EVALSHIP_PRODUCTION_KEY: KEY }, b.f, "ask", body)).toBeNull();
    expect(b.sent).toEqual([]);
  });

  it("a failed send to evalship does not change the answer", async () => {
    const { f } = fakeFetch({ content: "Fine.", evalship: "throw" });
    expect(await modelText({ OPENAI_API_KEY: OPENAI, EVALSHIP_PRODUCTION_KEY: KEY }, f, "ask", body)).toBe("Fine.");
  });

  it("genclass ask sends the question as input and the numbers in the context, through waitUntil", async () => {
    const { f, to } = fakeFetch({ content: "Problems rose on /cart." });
    const deferred: Promise<unknown>[] = [];
    const text = await answer({ OPENAI_API_KEY: OPENAI, EVALSHIP_PRODUCTION_KEY: KEY }, f, { problems: { total: 3 } }, { question: "Why did problems go up?", history: [] }, (p) => deferred.push(p));
    expect(text).toBe("Problems rose on /cart.");
    expect(deferred).toHaveLength(1);
    await deferred[0];
    const b = bodyOf(to(EVALSHIP_CALLS_URL)[0]);
    expect(b.call).toBe("ask");
    expect(b.input).toBe("Why did problems go up?");
    expect(String(b.context)).toMatch(/^system: You are GenClass/);
    expect(String(b.context)).toContain('{"problems":{"total":3}}');
    expect(b.output).toBe("Problems rose on /cart.");
  });
});
