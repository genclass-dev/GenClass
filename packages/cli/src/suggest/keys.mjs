// The tests both secret scanners of `genclass suggest` run on a key-shaped match before they report it: the
// project's files (repo.mjs findSecrets) and the scripts a live site ships (site.mjs bundleSecrets). A match whose
// body is a placeholder (isPlaceholder) or a key a provider printed in its own documentation (isDocumentedKey) is
// not a secret.
//
// Invariants:
// - Pure: no I/O, never throws, and nothing here returns or keeps a value it was given.
// - Only the part after a provider's prefix is tested (sk_live_<body>), so a prefix alone never decides.
// - A documented key is still a key of its kind: Stripe's sample sk_test_ key opens nothing, so it is no leak, but a
//   production setup that holds it still takes test payments. So isPlaceholder never counts documented keys; the
//   leak tests ask isDocumentedKey too, and the "test key in production" test asks isPlaceholder alone.

/** Words and runs that say a value is a stand-in, not a key. */
export const PLACEHOLDER = /your|example|placeholder|change[_-]?me|replace|dummy|fake|sample|redacted|secret[_-]?here|key[_-]?here|xxxx|\*\*\*|1234567|abcdefg|\.\.\.|[<>]|\$\{|\{\{/i;

/**
 * Key bodies that providers print in their public documentation and that open nothing: Stripe's sample secret keys
 * (the current one and the one its docs showed for years). AWS's documented access key IDs end in EXAMPLE, which
 * PLACEHOLDER already covers.
 */
export const DOCUMENTED_KEYS = new Set(["4eC39HqLyjWDarjtT1zdp7dc", "BQokikJOvBiI2HlWgH4olfQ2"]);

/**
 * A value nobody could use as a key: empty, a word such as "your_key_here", or a few characters repeated. A key a
 * provider documents is not a placeholder (isDocumentedKey).
 * @param {string | null | undefined} body  the part of a match after its prefix
 * @returns {boolean}
 */
export function isPlaceholder(body) {
  if (!body) return true;
  const s = String(body);
  if (PLACEHOLDER.test(s)) return true;
  return new Set(s.toLowerCase()).size <= 4;
}

/**
 * A key a provider prints in its public documentation (DOCUMENTED_KEYS): anyone may read it, so it leaks nothing.
 * @param {string | null | undefined} body  the part of a match after its prefix
 * @returns {boolean}
 */
export function isDocumentedKey(body) {
  return Boolean(body) && DOCUMENTED_KEYS.has(String(body));
}
