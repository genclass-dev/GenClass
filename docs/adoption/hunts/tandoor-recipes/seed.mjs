// Seeds a local Tandoor (docs/adoption/hunts/tandoor-recipes.md) for the race hunt. Not part of CI.
//
//   node docs/adoption/hunts/tandoor-recipes/seed.mjs            # after /setup/ created the user "hunt"
//
// Logs in through allauth's headless browser API (the Vue login page does the same), saves the session to
// $HUNT_OUT/state.json for the harness, then creates through the REST API: foods and keywords whose names share
// prefixes (the pickers' search), 72 recipes (the search page's pagination; names hold no digits, because the explore
// verdict blanks digit tokens in page lines) and a shopping list. Names hold no digits for the same reason.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "@playwright/test";

export const BASE = (process.env.TANDOOR_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
export const OUT = process.env.HUNT_OUT ?? `${process.env.HOME}/targets/tandoor-hunt`;
export const USER = { username: "hunt", password: "HuntPassw0rd!x" };

/**
 * A logged-in API context: session cookie plus the CSRF header Django wants on unsafe methods. The session saved in
 * $HUNT_OUT/state.json is reused while it is valid (allauth rate-limits logins).
 */
export async function login() {
  const saved = join(OUT, "state.json");
  if (existsSync(saved)) {
    const ctx = await request.newContext({ baseURL: BASE, storageState: saved });
    if ((await ctx.get("/api/user-space/")).ok()) return withApi(ctx);
    await ctx.dispose();
  }
  const ctx = await request.newContext({ baseURL: BASE });
  await ctx.get("/account/login/");
  const r = await ctx.post("/_allauth/browser/v1/auth/login", { data: USER, headers: { "X-CSRFToken": await csrfOf(ctx), Referer: `${BASE}/account/login/` } });
  if (r.status() !== 200) throw new Error(`login: HTTP ${r.status()} ${(await r.text()).slice(0, 300)}`);
  mkdirSync(OUT, { recursive: true });
  await ctx.storageState({ path: saved });
  return withApi(ctx);
}
const csrfOf = (ctx) => ctx.storageState().then((s) => s.cookies.find((c) => c.name === "csrftoken")?.value);
function withApi(ctx) {
  const csrf = () => csrfOf(ctx);
  const api = async (method, path, data) => {
    const res = await ctx.fetch(path, { method, data, headers: { "X-CSRFToken": await csrf(), Referer: `${BASE}/` } });
    const text = await res.text();
    if (!res.ok()) throw new Error(`${method} ${path}: HTTP ${res.status()} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  return { ctx, api };
}

export const FOODS = [
  "chicken", "chicken breast", "chicken stock", "chickpea", "chili", "chives", "chocolate", "cheddar", "cherry",
  "chard", "chervil", "chestnut", "chia seed", "chipotle", "cheese", "chamomile", "champagne", "chutney",
  "carrot", "celery", "cabbage", "cumin", "coriander", "garlic", "ginger", "onion", "olive oil", "oregano",
  "potato", "paprika", "parsley", "pepper", "tomato", "thyme", "turmeric", "basil", "butter", "bay leaf",
];
export const KEYWORDS = [
  "breakfast", "brunch", "bread", "baking", "barbecue", "dinner", "dessert", "drinks", "lunch", "light",
  "vegan", "vegetarian", "quick", "quiche", "soup", "salad", "sauce", "spicy", "summer", "winter",
];
const A = ["Alpine", "Brisk", "Coastal", "Dusky", "Early", "Fresh", "Golden", "Hearty", "Island", "Jolly", "Kindly", "Lemon"];
const N = ["soup", "stew", "salad", "bake", "curry", "pie"];
export const RECIPES = A.flatMap((a) => N.map((n) => `${a} ${n}`)); // 72 names, no digits
export const SHOPPING = ["carrot", "celery", "garlic", "ginger", "onion", "potato"];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { ctx, api } = await login();
  await ctx.storageState({ path: join(OUT, "state.json") });
  // the first-run wizard (WelcomePage.vue) otherwise takes over every page: a household, then both setup flags
  const us = (await api("GET", "/api/user-space/")).results?.[0] ?? (await api("GET", "/api/user-space/"))[0];
  if (!us.household) {
    // as WelcomePage.householdAndNext does it: create the household, then send the user space back with it
    const households = await api("GET", "/api/household/");
    const household = (households.results ?? households)[0] ?? (await api("POST", "/api/household/", { name: "Hunt household" }));
    await api("PUT", `/api/user-space/${us.id}/`, { ...us, household });
  }
  await api("PATCH", `/api/space/${us.space}/`, { space_setup_completed: true, household_setup_completed: true });
  const existing = await api("GET", "/api/food/?page_size=200");
  if (existing.count >= FOODS.length) {
    console.log("already seeded:", existing.count, "foods");
    return;
  }
  const foods = {};
  for (const name of FOODS) foods[name] = (await api("POST", "/api/food/", { name })).id;
  const keywords = {};
  for (const name of KEYWORDS) keywords[name] = (await api("POST", "/api/keyword/", { name })).id;
  const recipes = [];
  for (const [i, name] of RECIPES.entries()) {
    const kw = [KEYWORDS[i % KEYWORDS.length]].map((k) => ({ name: k }));
    recipes.push((await api("POST", "/api/recipe/", { name, keywords: kw, steps: [], servings: 2 })).id);
  }
  const shopping = [];
  for (const name of SHOPPING) shopping.push((await api("POST", "/api/shopping-list-entry/", { food: { name }, amount: 1 })).id);
  const fx = { foods, keywords, recipes, shopping };
  writeFileSync(join(OUT, "fixture.json"), JSON.stringify(fx, null, 2));
  console.log(`seeded ${FOODS.length} foods, ${KEYWORDS.length} keywords, ${recipes.length} recipes, ${shopping.length} shopping entries`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
