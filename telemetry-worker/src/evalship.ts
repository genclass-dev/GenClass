// Monitor with evalship (https://evalship.com): every AI call this server makes (src/suggest.ts modelText, which
// `genclass suggest`, `genclass ask` and the report email's summary all go through) is sent to evalship, which checks
// each answer and emails GenClass when one fails, makes something up or gives no answer.
//
// Invariants:
// - Only when the Worker secret EVALSHIP_PRODUCTION_KEY is set. Without it (tests, local runs, a self-hosted
//   collector) nothing is sent and nothing else changes.
// - What is sent is what the model got and answered, nothing more: the call's name ("suggest", "ask", "report"), the
//   messages in order as one string (`context`, the instructions first), the last user message (`input`), the answer
//   as the model gave it (`output`; "" and `error` when the call failed), the model's name and how long it took. The
//   messages never hold an email, an account id or a key (each caller's own invariants); no token count is sent.
// - Never in the user's way: with the caller's waitUntil it runs after the response, always with a 5-second timeout,
//   and a failure is caught and logged as one line that holds neither the key nor the body. It never changes an answer.
// - The key is read here and nowhere else, and sent only to evalship over HTTPS.

import type { Env } from "./collector.js";

/** Where each call is sent. */
export const EVALSHIP_CALLS_URL = "https://evalship.com/api/v1/calls";
/** How long a send may take before it is given up. */
export const EVALSHIP_TIMEOUT_MS = 5000;
/** The longest `input`, `context` or `output` sent, in characters. */
export const MAX_FIELD = 200_000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
/** ctx.waitUntil in production; without it the send is awaited (the report sweep, the tests). */
export type Defer = (p: Promise<unknown>) => void;

/** One AI call as modelText saw it. */
export interface ModelCall {
  /** The call's name, modelText's tag: "suggest", "ask" or "report". */
  call: string;
  /** The messages the model got, in order. */
  messages: { role: string; content: string }[];
  /** The model asked (a stand-in's name when one answered). */
  model: string;
  /** The answer's text; null when the call failed or the answer held no text. */
  output: string | null;
  /** Why there is no answer ("HTTP 500", "timeout", "error"); null when the model answered. */
  error: string | null;
  durationMs: number;
}

/** Whether calls are sent at all: the secret is set. */
export const monitored = (env: Pick<Env, "EVALSHIP_PRODUCTION_KEY">): boolean => (env.EVALSHIP_PRODUCTION_KEY ?? "").trim().length > 0;

/** The messages of a chat request body, each with text content; anything else is dropped. Pure. */
export function messagesOf(body: Record<string, unknown> | null | undefined): { role: string; content: string }[] {
  const raw = body?.messages;
  if (!Array.isArray(raw)) return [];
  const out: { role: string; content: string }[] = [];
  for (const m of raw) {
    const o = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
    if (typeof o.role === "string" && typeof o.content === "string") out.push({ role: o.role, content: o.content });
  }
  return out;
}

const cut = (s: string): string => (s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) : s);

/** The JSON body evalship gets for one call (POST /api/v1/calls). Pure. */
export function callBody(c: ModelCall): Record<string, unknown> {
  const users = c.messages.filter((m) => m.role === "user");
  const body: Record<string, unknown> = {
    call: c.call,
    input: cut(users.length ? users[users.length - 1].content : ""),
    context: cut(c.messages.map((m) => `${m.role}: ${m.content}`).join("\n\n")),
    output: cut(c.output ?? ""),
    model: c.model,
    duration_ms: Math.max(0, Math.round(c.durationMs)),
  };
  if (c.output === null) body.error = c.error ?? "no text in the answer";
  return body;
}

/**
 * Sends one call to evalship when EVALSHIP_PRODUCTION_KEY is set: handed to `defer` when there is one (the returned
 * promise is then already settled), else awaited by the caller. Never rejects.
 */
export function reportCall(env: Pick<Env, "EVALSHIP_PRODUCTION_KEY">, f: Fetch, c: ModelCall, defer?: Defer): Promise<void> {
  const key = (env.EVALSHIP_PRODUCTION_KEY ?? "").trim();
  if (!key) return Promise.resolve();
  const send = (async (): Promise<void> => {
    try {
      const res = await f(EVALSHIP_CALLS_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(callBody(c)),
        signal: AbortSignal.timeout(EVALSHIP_TIMEOUT_MS),
      });
      if (!res.ok) console.log(`evalship: the ${c.call} call was answered HTTP ${res.status}`);
      await res.body?.cancel().catch(() => undefined);
    } catch (e) {
      console.log(`evalship: sending the ${c.call} call failed: ${e instanceof Error && e.name === "TimeoutError" ? "timeout" : "error"}`);
    }
  })();
  if (!defer) return send;
  try {
    defer(send);
  } catch {
    return send;
  }
  return Promise.resolve();
}
