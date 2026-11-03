// Shared helpers for the Audiobookshelf hunt scripts (docs/adoption/hunts/audiobookshelf.md). Not part of CI.
//
// Everything here talks to a local Audiobookshelf started with `npm run dev` (http://localhost:3333) and seeded with
// seed.sh: a root user (root / hunt-pw-1 by default) and one book library. Nothing here imports GenClass.

import { chromium } from "@playwright/test";

export const ABS = (process.env.ABS_URL || "http://localhost:3333").replace(/\/+$/, "");
export const USER = process.env.ABS_USER || "root";
export const PASSWORD = process.env.ABS_PASSWORD || "hunt-pw-1";
/** The web client's base: the generated client is served under /audiobookshelf (its router base). */
export const WEB = `${ABS}${process.env.ABS_WEB_BASE ?? "/audiobookshelf"}`;

/** POST /login and return the bearer token (accessToken on 2.26+, token before). */
export async function token() {
  const r = await fetch(`${ABS}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`login failed: HTTP ${r.status}`);
  const { user } = await r.json();
  return user.accessToken || user.token;
}

/** A small API client with the bearer token. */
export async function api() {
  const t = await token();
  const call = async (method, path, body) => {
    const r = await fetch(`${ABS}${path}`, {
      method,
      headers: { authorization: `Bearer ${t}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status} ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  return {
    token: t,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    patch: (p, b) => call("PATCH", p, b),
    /** the first book library */
    async library() {
      const { libraries } = await call("GET", "/api/libraries");
      return libraries.find((l) => l.mediaType === "book");
    },
    /** a library item by its title */
    async itemByTitle(libraryId, title) {
      const res = await call("GET", `/api/libraries/${libraryId}/items?limit=500&minified=1`);
      return res.results.find((i) => i.media.metadata.title === title);
    },
  };
}

/** Log in through the web client's own form once and return the storage state (token in localStorage, refresh cookie). */
export async function loginState(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${WEB}/login`);
  await page.locator('input[name="username"]').fill(USER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('form:visible button[type="submit"]').click();
  await page.waitForURL((u) => !/\/login\/?$/.test(u.pathname), { timeout: 20_000 });
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

export { chromium };
