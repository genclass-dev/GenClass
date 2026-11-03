// Seeds the Keystone usecase-blog example with the hunt's fixtures through its own GraphQL API
// (docs/adoption/hunts/keystone-admin-ui.md, section 2). Not part of any test suite.
//
// Deterministic: 60 authors (every fifth unverified), 240 posts and 120 tags whose names come from a fixed word list,
// so a search prefix ("gam") and its full term ("gamma 1") match different, known sets of rows. Idempotent: it does
// nothing when the authors are already there.
//
// Posts go straight into the SQLite file: at the hunted commit every Post write through Keystone fails in this
// monorepo with "Post.content: (0, import_weak_memoize.default) is not a function" (the document field's input
// resolver; see keystone-admin-ui.md section 2), so the hunt never writes a Post through the app, only reads them.
//
// Usage: node docs/adoption/hunts/keystone-admin-ui/seed.mjs
//   KEYSTONE_URL (default http://localhost:3000), KEYSTONE_DB (default ~/targets/keystone-admin-ui/examples/usecase-blog/keystone-example.db)

const APP = (process.env.KEYSTONE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "omega"];

async function gql(query, variables) {
  const r = await fetch(`${APP}/api/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors.map((e) => e.message).join("; "));
  return j.data;
}

const have = await gql(`{ authorsCount }`);
if (have.authorsCount >= 60) {
  console.log(`already seeded (${have.authorsCount} authors)`);
  process.exit(0);
}

const pad = (n, w = 3) => String(n).padStart(w, "0");
const authors = Array.from({ length: 60 }, (_, i) => ({
  name: `${WORDS[i % WORDS.length]} author ${pad(i, 2)}`,
  email: `author${pad(i, 2)}@example.com`,
  verified: i % 5 !== 4,
}));
const created = await gql(`mutation ($data: [AuthorCreateInput!]!) { createAuthors(data: $data) { id name } }`, { data: authors });
const tags = Array.from({ length: 120 }, (_, i) => ({ name: `${WORDS[i % WORDS.length]} tag ${pad(i)}` }));
await gql(`mutation ($data: [TagCreateInput!]!) { createTags(data: $data) { id } }`, { data: tags });
const { DatabaseSync } = await import("node:sqlite");
const { homedir } = await import("node:os");
const dbPath = process.env.KEYSTONE_DB ?? `${homedir()}/targets/keystone-admin-ui/examples/usecase-blog/keystone-example.db`;
const db = new DatabaseSync(dbPath, { timeout: 10_000 });
const insert = db.prepare(`INSERT INTO "Post" ("id", "title", "status", "content", "author") VALUES (?, ?, ?, ?, ?)`);
const content = JSON.stringify([{ type: "paragraph", children: [{ text: "" }] }]);
for (let i = 0; i < 240; i++) {
  insert.run(`huntpost${pad(i)}`, `${WORDS[i % WORDS.length]} ${i % 7} post ${pad(i)}`, i % 2 ? "published" : "draft", content, created.createAuthors[i % 60].id);
}
db.close();
console.log(`seeded ${authors.length} authors, ${tags.length} tags, 240 posts`);
