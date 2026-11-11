// The one workflow file a repository adds to give the app something to read with no change to its tests
// (docs/github-app/workflows/genclass.yml), and the link that opens GitHub's own "new file" editor with that file's
// name and text filled in, so that a person only reviews it and commits it.
//
// Invariants:
// - WORKFLOW_FILE is the docs file, character for character (test/github-workflow.test.ts fails when they differ).
//   The docs file is the source: a change there is pasted here.
// - The link opens an editor and nothing else. Nothing is written to a repository by the link or by the app, which
//   has no contents permission: whoever follows the link commits the file as themselves on GitHub, or does not.
// - Where the link points is decided here and by nothing it is given: <web root>/<owner>/<name>/new/<branch> with
//   the file's name and text as its query. The repository's full name and the branch are checked first (a full name
//   as GitHub writes one; a branch name as git allows one, so no "." or ".." segment and no empty one), and in each
//   segment of the branch, in the file's name and in the text every character except letters, digits, "-", "_" and
//   "." is percent-encoded. So no value can add a path segment, a query, a fragment or another host, and the address
//   holds no character that would end a markdown link or an HTML attribute around it.
// - An address longer than MAX_LINK_CHARS is not built: GitHub answers an address of about 6,000 characters with an
//   error (checked on github.com, 2026-11-10).
// - Pure: no clock, no network, no state. The same inputs give the same address, on the server (workflowLink) and in
//   a page's script (WORKFLOW_LINK_JS).

/** Where the file goes in a repository. */
export const WORKFLOW_PATH = ".github/workflows/genclass.yml";

/** The artifact the workflow uploads. The app reads it when the repository's `artifact` setting is a prefix of this name. */
export const WORKFLOW_ARTIFACT = "genclass-races";

/** The longest address that is built. */
export const MAX_LINK_CHARS = 5800;

/** The text of docs/github-app/workflows/genclass.yml (there, "${" is written without the backslash). */
export const WORKFLOW_FILE = `# GenClass on your existing Playwright suite: no change to your tests or your playwright.config.
# Copy to .github/workflows/genclass.yml.
#
# Assumes "npx playwright test" works on a fresh checkout with dependencies installed, which usually
# means your config has a webServer that starts the app. Playwright in a subdirectory: set
# defaults.run.working-directory and prefix the artifact path with it.
#
# The run holds your app's API calls for a seeded time, so tests that pass in your own e2e job can
# fail here: this job is separate and allowed to fail, so it never blocks a pull request.
name: genclass
# Pull requests, and pushes to the default branch: a review tells a pull request's findings from the
# ones already there. Under another name than main or master, put your default branch in the list.
on:
  pull_request:
  push:
    branches: [main, master]
permissions:
  contents: read
jobs:
  genclass:
    runs-on: ubuntu-latest
    continue-on-error: true
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      # With the package manager your lockfile names. A workspace's lockfile is at the root.
      - name: Your dependencies
        run: |
          [ "$(ls pnpm-lock.yaml yarn.lock bun.lock* package-lock.json 2>/dev/null)" ] || cd "$GITHUB_WORKSPACE"
          if [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile
          elif [ -f yarn.lock ]; then corepack enable && yarn install --frozen-lockfile
          elif [ -f bun.lock ] || [ -f bun.lockb ]; then npm install -g bun && bun install --frozen-lockfile
          else npm ci; fi
      # Outside your project: your lockfile is untouched. npm does not install Playwright with it (an
      # optional peer dependency), so the run uses your project's own copy.
      - name: GenClass
        run: npm install --prefix "$RUNNER_TEMP/genclass" @genclass/playwright @genclass/runtime@beta
      - name: Your Playwright's browsers
        run: npx playwright install --with-deps
      # Your suite under two seeds, with GenClass on the pages it opens. Arguments after the path go
      # to "playwright test" (--project chromium, a file, ...). GENCLASS_CHAOS=off: no holds.
      - name: Playwright with GenClass
        run: node "$RUNNER_TEMP/genclass/node_modules/@genclass/playwright/bin/genclass-playwright-run.mjs"
      # One small JSON file per test and seed. genclass-dev[bot] reads artifacts named genclass*.
      - uses: actions/upload-artifact@v4
        if: \${{ !cancelled() }}
        with:
          name: genclass-races
          path: test-results/genclass
          retention-days: 30
          if-no-files-found: ignore
`;

/**
 * A repository's full name as GitHub writes one, "owner/name": the same two parts src/github/api.ts repoPath takes.
 * Neither part holds a character that means anything in an address, so they are put into the link as they are.
 */
export const FULL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/**
 * A name git allows for a branch (git check-ref-format), up to 255 characters: no control character, space, "~",
 * "^", ":", "?", "*", "[" or "\"; no "..", "//" or "@{"; no segment that starts with "." or ends with ".lock"; it
 * does not start with "-" or "/" and does not end with "/" or "."; it is not "@", and not "HEAD" (GitHub has no
 * new-file page for the literal HEAD). What this leaves may still hold "#", "%", "&" or "=": those are
 * percent-encoded, segment by segment.
 */
export const BRANCH_RE = /^(?![-./])(?!HEAD$)(?!@$)(?!.*(?:\.\.|\/\/|\/\.|@\{|\.lock\/))(?!.*(?:[./]|\.lock)$)[^\u0000-\u0020\u007f-\u009f\u2028\u2029~^:?*[\\]{1,255}$/;

/**
 * Percent-encode everything except letters, digits, "-", "_" and ".": encodeURIComponent, then the six characters it
 * leaves as they are. Throws, as encodeURIComponent does, on half of a surrogate pair.
 */
const enc = (s: string): string => encodeURIComponent(s).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * The address of GitHub's new-file editor on `branch` of the repository `fullName`, with the workflow file's name
 * and `text` filled in. `web` is the server's own GitHub web root (config.ts `web`: "https://github.com", or a GitHub
 * Enterprise Server's). Null when `fullName` is not "owner/name", when `branch` is not a name git allows for a
 * branch, or when the address would be longer than MAX_LINK_CHARS. The branch must exist for GitHub to open the
 * editor: callers pass the repository's default branch as GitHub names it.
 */
export function workflowLink(web: string, fullName: string, branch: string, text: string = WORKFLOW_FILE): string | null {
  if (typeof fullName !== "string" || typeof branch !== "string" || !FULL_NAME_RE.test(fullName) || !BRANCH_RE.test(branch)) return null;
  let url: string;
  try {
    url = `${web}/${fullName}/new/${branch.split("/").map(enc).join("/")}?filename=${enc(WORKFLOW_PATH)}&value=${enc(text)}`;
  } catch {
    // half of a surrogate pair in the branch or the text: it cannot be written into an address
    return null;
  }
  return url.length > MAX_LINK_CHARS ? null : url;
}

/** What a page's script needs to build the link itself (WORKFLOW_LINK_JS): this module's values and the server's web root. */
export interface WorkflowLinkData {
  web: string;
  path: string;
  text: string;
  max: number;
  /** The sources of FULL_NAME_RE and BRANCH_RE, so that the page checks what it is given against the same patterns. */
  repo: string;
  branch: string;
}

/** The values for a page that builds the link in the browser from a repository and a branch a person types. */
export function workflowLinkData(web: string, text: string = WORKFLOW_FILE): WorkflowLinkData {
  return { web, path: WORKFLOW_PATH, text, max: MAX_LINK_CHARS, repo: FULL_NAME_RE.source, branch: BRANCH_RE.source };
}

/**
 * workflowLink for a page's script: `gcWorkflowLink(d, repo, branch)`, with `d` what workflowLinkData gives, returns
 * the same address for the same repository and branch, and null where workflowLink returns null
 * (test/github-workflow.test.ts runs the two side by side). Plain script text: no markup, nothing from a request.
 */
export const WORKFLOW_LINK_JS = `
function gcWorkflowLink(d, repo, branch){
  function enc(s){ return encodeURIComponent(s).replace(/[!'()*~]/g, function(c){ return "%" + c.charCodeAt(0).toString(16).toUpperCase(); }); }
  if (typeof repo !== "string" || typeof branch !== "string" || !new RegExp(d.repo).test(repo) || !new RegExp(d.branch).test(branch)) return null;
  var url;
  try { url = d.web + "/" + repo + "/new/" + branch.split("/").map(enc).join("/") + "?filename=" + enc(d.path) + "&value=" + enc(d.text); } catch (e) { return null; }
  return url.length > d.max ? null : url;
}`;
