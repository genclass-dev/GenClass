// The GitHub App's configuration, read from the worker's secrets and vars (docs/github-app/SETUP.md).
//
// Invariants:
// - Without all three of GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and GITHUB_APP_WEBHOOK_SECRET the app is off: its
//   routes answer 404 (the webhook 503), nothing calls GitHub and no other route changes. A self-hosted collector
//   (wrangler.selfhost.toml) is therefore unaffected unless its owner registers an app of their own.
// - GITHUB_APP_WORKFLOW_LINK is off unless it says "on". While it is off, nothing the app writes on GitHub carries
//   the link to GitHub's new-file editor or differs in any character, and /github/setup has no form: it says where
//   to copy the workflow file from.
// - The client id and secret are only needed for linking a repository to a GenClass app (GitHub tells us who is
//   asking); reviews work without them.
// - Nothing here is logged or echoed: the key and the secrets leave this module only as arguments to WebCrypto.

import type { Env } from "../collector.js";

/** The secrets and vars the GitHub App reads (part of the worker's Env). */
export interface GithubEnv {
  /** The app's numeric id (GitHub: Settings, Developer settings, GitHub Apps, your app, "App ID"). */
  GITHUB_APP_ID?: string;
  /** The app's private key, PEM (PKCS#1 as GitHub generates it, or PKCS#8); "\n" written out is accepted. */
  GITHUB_APP_PRIVATE_KEY?: string;
  /** The webhook secret typed into the app's settings: every delivery is checked against it. */
  GITHUB_APP_WEBHOOK_SECRET?: string;
  /** The secret of the Marketplace listing's own webhook (POST /api/github/marketplace); default: the app's. */
  GITHUB_MARKETPLACE_WEBHOOK_SECRET?: string;
  /** The app's client id and one client secret, for "Connect GitHub" on the account page (optional). */
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  /** The app's URL name, github.com/apps/<slug> (default "genclass-dev", whose bot is genclass-dev[bot]). */
  GITHUB_APP_SLUG?: string;
  /**
   * Private repositories: "plan" (default) reviews them only for installations whose GenClass account or GitHub
   * Marketplace plan includes them (src/github/entitlement.ts); "open" reviews every repository (a beta, or a
   * self-hosted collector whose owner runs the app for themselves).
   */
  GITHUB_APP_PRIVATE_REPOS?: string;
  /** GitHub Enterprise Server: its API root (https://HOST/api/v3) and web root. Default github.com. */
  GITHUB_API_URL?: string;
  GITHUB_WEB_URL?: string;
  /**
   * "on": the check that has no race files to read, and the page /github/setup, carry a link that opens GitHub's
   * new-file editor with docs/github-app/workflows/genclass.yml filled in (src/github/workflow-file.ts). Unset, or
   * anything else: off, and nothing the app writes on GitHub is different. It is turned on once
   * @genclass/playwright, which that workflow installs, is on npm.
   */
  GITHUB_APP_WORKFLOW_LINK?: string;
}

export interface GithubAppConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  clientId: string | null;
  clientSecret: string | null;
  slug: string;
  /** REST API root without a trailing slash. */
  api: string;
  /** Web root without a trailing slash. */
  web: string;
  privateRepos: "plan" | "open";
  /** The link that opens GitHub's new-file editor with the workflow file filled in is shown (GITHUB_APP_WORKFLOW_LINK is "on"). */
  workflowLink: boolean;
  /** This server's own origin (where the app's pages and webhook live), without a trailing slash. */
  origin: string;
}

const trimmed = (v: string | undefined): string => (v ?? "").trim();

/** Plain HTTP on this machine: a stand-in for GitHub during development and the end-to-end check, never a real host. */
export const isLoopback = (u: URL): boolean => u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");

/**
 * An https origin (or path prefix) without a trailing slash, else the fallback. Plain HTTP is accepted only for
 * localhost and 127.0.0.1 (test/e2e/github.e2e.mjs runs the worker against a stand-in for GitHub there).
 */
function root(v: string | undefined, fallback: string): string {
  const s = trimmed(v).replace(/\/+$/, "");
  if (!s) return fallback;
  try {
    const u = new URL(s);
    if ((u.protocol !== "https:" && !isLoopback(u)) || u.username || u.password || u.search || u.hash) return fallback;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return fallback;
  }
}

export const DEFAULT_SLUG = "genclass-dev";
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** The app's configuration, or null while the app is not set up on this server. */
export function githubApp(env: Env): GithubAppConfig | null {
  const appId = trimmed(env.GITHUB_APP_ID);
  const privateKey = trimmed(env.GITHUB_APP_PRIVATE_KEY);
  const webhookSecret = trimmed(env.GITHUB_APP_WEBHOOK_SECRET);
  if (!/^\d{1,12}$/.test(appId) || !privateKey || webhookSecret.length < 16) return null;
  const slug = trimmed(env.GITHUB_APP_SLUG).toLowerCase();
  const clientId = trimmed(env.GITHUB_APP_CLIENT_ID);
  const clientSecret = trimmed(env.GITHUB_APP_CLIENT_SECRET);
  return {
    appId,
    privateKey,
    webhookSecret,
    clientId: clientId && clientSecret ? clientId : null,
    clientSecret: clientId && clientSecret ? clientSecret : null,
    slug: SLUG_RE.test(slug) ? slug : DEFAULT_SLUG,
    api: root(env.GITHUB_API_URL, "https://api.github.com"),
    web: root(env.GITHUB_WEB_URL, "https://github.com"),
    privateRepos: trimmed(env.GITHUB_APP_PRIVATE_REPOS).toLowerCase() === "open" ? "open" : "plan",
    workflowLink: trimmed(env.GITHUB_APP_WORKFLOW_LINK).toLowerCase() === "on",
    origin: (env.AUTH_ORIGIN || env.DASHBOARD_ORIGIN || "https://genclass.dev").replace(/\/+$/, ""),
  };
}

/** The app's public page on GitHub. */
export const appUrl = (cfg: GithubAppConfig): string => `${cfg.web}/apps/${cfg.slug}`;
/** Where a person installs it (GitHub asks which account and which repositories). */
export const installUrl = (cfg: GithubAppConfig, state?: string): string =>
  `${cfg.web}/apps/${cfg.slug}/installations/new${state ? `?state=${encodeURIComponent(state)}` : ""}`;
/** The login of the app's bot user, as it authors comments: "genclass-dev[bot]". */
export const botLogin = (cfg: GithubAppConfig): string => `${cfg.slug}[bot]`;
