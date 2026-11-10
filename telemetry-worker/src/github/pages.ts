// The GitHub App's pages: its public page (/github), the page GitHub sends someone to after installing
// (/github/setup) and the signed-in page that links repositories to GenClass apps (/account/github).
//
// Invariants:
// - /github and /github/setup are static: they show nothing about any installation, account or repository, whatever
//   their address carries, so they can be opened by anyone.
// - On a server that has the workflow link on (config.ts GITHUB_APP_WORKFLOW_LINK), /github/setup has a small form: a
//   repository and a branch a person types, and a button that opens GitHub's new-file editor with the workflow file
//   filled in. The address is built by the page's script (workflow-file.ts WORKFLOW_LINK_JS), under the page's nonce,
//   from the file's text in a JSON data block and the two inputs, each checked against a pattern first. Nothing typed
//   there is sent to this server or put into the page as markup; the form has no action and no inline handler.
//   Without the setting the page says to copy the file from the repository.
// - Every value from GitHub or the account (logins, repository and app names) is escaped; the account page's script
//   reads only numeric repository ids and app ids from data attributes and form values.
// - The pages say only what the app does: every sentence about what it reads, writes and keeps is the same as in
//   docs/github-app/README.md and PRIVACY.md. A change there is a change here.

import { CLIENT_JS, ORG_CSS, orgRail } from "../account-pages.js";
import { DASH_CSS, esc, orgName, shell } from "../pages.js";
import { PLANS_FILE } from "../plans.js";
import { studioPage } from "../studio.js";
import { SETTINGS_PATH } from "./settings.js";
import { WORKFLOW_LINK_JS, WORKFLOW_PATH, workflowLinkData } from "./workflow-file.js";

const DOCS = "https://github.com/genclass-dev/GenClass/blob/main/docs/github-app/README.md";
const PRIVACY = "https://github.com/genclass-dev/GenClass/blob/main/PRIVACY.md#the-github-app";
/** The workflow file in this repository, for someone who copies it by hand. */
const WORKFLOW_SOURCE = "https://github.com/genclass-dev/GenClass/blob/main/docs/github-app/workflows/genclass.yml";

const GH_CSS = `
ul.facts{list-style:none;display:grid;gap:8px;max-width:76ch;color:var(--ink2);font-size:14px}
ul.facts li{padding-left:16px;position:relative}
ul.facts li::before{content:"";position:absolute;left:0;top:.62em;width:6px;height:6px;background:var(--accent-f)}
ul.facts code,p.lead code,.steps code{font:13px var(--mono);color:var(--ink)}
ul.facts b{color:var(--ink);font-weight:500}
.steps{display:grid;grid-template-columns:minmax(0,1fr);gap:18px;max-width:76ch;counter-reset:s}
.steps>div{counter-increment:s;min-width:0}
.steps .snip{min-width:0}
.steps h3{font-size:16px;font-weight:500}
.steps h3::before{content:counter(s) ". ";color:var(--ink3)}
.steps p{font-size:14px;color:var(--ink2);margin-top:4px}
.gh-cta{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.gh-cta .btn.xl{min-height:52px;font-size:16px;padding:0 24px}
.gh-note{font-size:13px;color:var(--ink3);max-width:76ch}
.gh-p{font-size:14px;color:var(--ink2);max-width:76ch}
.gh-p code{font:13px var(--mono);color:var(--ink)}
.gh-wf{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr) auto;gap:10px;align-items:end;max-width:76ch}
.gh-wf label{display:grid;gap:6px;min-width:0;font-size:14px;font-weight:500}
.gh-wf-err{font-size:13px;color:var(--warn);max-width:76ch}
.gh-wf-err:empty{display:none}
@media (max-width:620px){.gh-wf{grid-template-columns:minmax(0,1fr)}}
`;

const snippet = (label: string, code: string): string =>
  `<div class="snip"><div class="row between"><h4 class="gh-note">${esc(label)}</h4><button class="btn sm ghost" type="button" data-copy="${esc(code)}" aria-label="Copy ${esc(label)}">Copy</button></div><pre class="code" tabindex="0">${esc(code)}</pre></div>`;

const FIXTURE = `// playwright.config.ts
use: { genclass: { chaos: { seed: 1, delayMs: [0, 600] } } },

// in your specs
import { test, expect } from "@genclass/playwright/fixture";`;

const WORKFLOW = `      - run: npx playwright test --repeat-each 2
      - uses: actions/upload-artifact@v4
        if: \${{ !cancelled() }}
        with:
          name: genclass-races
          path: test-results/genclass
          retention-days: 7`;

const SETTINGS = `# ${SETTINGS_PATH} (optional; these are the defaults)
reviews:
  auto: true          # review each pull request when it opens and on every push
  drafts: false
comment: findings     # findings | always | never
check:
  fail_on: never      # never | reproducible | any
inline: true
min_seeds: 2
artifact: genclass    # artifacts whose name starts with this are read
commands: true
issues: never         # never | merge`;

function steps(slug: string): string {
  return `<div class="steps">
<div><h3>Use the fixture in your Playwright tests</h3>
<p>The fixture puts the GenClass runtime on each page under test, in observe mode: it reports and never holds, delays or changes anything your app does. With chaos on, each seed delays and reorders responses differently.</p>
${snippet("Install", "npm i -D @genclass/playwright @genclass/runtime@beta")}
${snippet("Configure", FIXTURE)}</div>
<div><h3>Upload the race files from your workflow</h3>
<p>The fixture writes one small JSON file per test and seed to <code>test-results/genclass</code>. ${esc(slug)}[bot] reads the artifact when the workflow run finishes, also for pull requests from forks, whose own token cannot comment.</p>
${snippet("In the job that runs Playwright", WORKFLOW)}</div>
<div><h3>Open a pull request</h3>
<p>The GenClass check appears on its commits. When something is flagged, one comment lists each finding with its test, its seeds and the evidence line; it is edited in place on later pushes. Reply <code>@${esc(slug)} help</code> on the pull request for the commands.</p></div>
</div>`;
}

function permissions(slug: string): string {
  return `<ul class="facts">
<li><b>Pull requests, read and write:</b> the list of files a pull request changes (their paths and which lines the diff shows) and its own comments.</li>
<li><b>Checks, write:</b> the GenClass check on each commit.</li>
<li><b>Actions, read:</b> the workflow runs of a pull request's head commit and the artifact with the race files.</li>
<li><b>Issues, read and write:</b> GitHub delivers pull-request comments (the <code>@${esc(slug)}</code> commands) under this permission; the app reacts to a command to show it was seen, and opens an issue only when a setting or a person with write access asks.</li>
<li><b>One file, read:</b> <code>${esc(SETTINGS_PATH)}</code> on the default branch, your settings.</li>
<li><b>Metadata, read:</b> required by GitHub for every app.</li>
<li><b>Not asked for:</b> repository contents. The app cannot read, clone or change your code, branches, workflows, secrets or settings, and it never opens a pull request.</li>
</ul>`;
}

/** /github: what the app is and does, for someone who has not installed it. */
export function githubLandingPage(nonce: string, o: { slug: string; privateRepos: "plan" | "open" }): string {
  const bot = `${esc(o.slug)}[bot]`;
  const body = `
<style nonce="${nonce}">${GH_CSS}</style>
<section class="stack mt-xl">
  <h1>Runtime evidence on your pull requests</h1>
  <p class="lead">${bot} is GenClass's GitHub App. While your Playwright tests run, the GenClass runtime watches the page: which request was sent twice, which older response was applied over a newer one, which write was overwritten. The app puts that on the pull request, with the test, the seeds it happened in and the evidence line. It reads the race files your workflow uploads, never your source code. Free on public repositories.</p>
  <div class="gh-cta"><a class="btn green xl" href="/github/install">Install on GitHub</a><a class="btn ghost" href="${DOCS}">Read the guide</a></div>
</section>
<section class="stack mt-l">
  <h2 class="h2l">What a review contains</h2>
  <ul class="facts">
    <li>One check on each commit and one comment per pull request, edited in place. With nothing flagged there is no comment.</li>
    <li>Each finding names its test, the operation (<code>POST /api/orders</code>), how many seeds of that test flagged it, and the evidence line the runtime printed. Flagged in two or more seeds of the same test, it is marked reproducible.</li>
    <li>From push to push a finding is new, still flagged, or not flagged at the new commit. The app does not call anything fixed: a replay on your machine proves a fix.</li>
    <li>With a repository linked to a GenClass app: that app's production findings on the pages the pull request's files serve.</li>
    <li><code>@${esc(o.slug)} replay 1</code> gives the steps to reproduce a finding; <code>@${esc(o.slug)} fix 1</code> writes a brief your coding agent can work from with <code>@genclass/mcp</code>, in your own CI or on your machine.</li>
    <li>Each line is a diagnosis by the on-device model or a fact the runtime measured. Whether it is a bug is for you to decide.</li>
  </ul>
</section>
<section class="stack mt-l">
  <h2 class="h2l">Set it up</h2>
  ${steps(o.slug)}
</section>
<section class="stack mt-l">
  <h2 class="h2l">What it may read and write</h2>
  ${permissions(o.slug)}
</section>
<section class="stack mt-l">
  <h2 class="h2l">What it keeps</h2>
  <ul class="facts">
    <li>For an installation: its GitHub account's name and id. For a pull request: the ids of the app's own comment and check, and per finding a fingerprint and the short title already in the comment.</li>
    <li>Never: code, diffs, file contents, race files, tokens. An artifact is read in memory for the review and dropped.</li>
    <li>Uninstalling removes everything kept for the installation at once. <a href="${PRIVACY}">The privacy policy</a> has the full list.</li>
  </ul>
</section>
<section class="stack mt-l" id="plans">
  <h2 class="h2l">Plans</h2>
  <ul class="facts">
    <li><b>Public repositories:</b> free, for every account and organization.</li>
    <li><b>Private repositories:</b> ${o.privateRepos === "open" ? "included while the app is in beta." : `with the Enterprise plan, by agreement: write to <a href="mailto:${esc(PLANS_FILE.contact)}">${esc(PLANS_FILE.contact)}</a>. Without it, a private repository is not read at all.`}</li>
  </ul>
</section>`;
  return shell(nonce, `GenClass for GitHub: ${o.slug}[bot]`, body, "", { index: true });
}

/**
 * JSON for a data block (a script element of type application/json): "<", ">" and "&" are written as escapes, so
 * nothing in the text can end the element or start markup, and the two line separators JSON leaves as they are.
 */
const dataBlock = (v: unknown): string =>
  JSON.stringify(v).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/**
 * The script of the setup page's form (after WORKFLOW_LINK_JS, which defines gcWorkflowLink): on submit, the two
 * inputs are checked against the patterns of the data block, the address is built from them and the file's text, and
 * it is opened in a new tab. What a person typed goes nowhere else; a message is set with textContent.
 */
const SETUP_FORM_JS = `
(function(){
  var form = document.getElementById("gh-wf"), block = document.getElementById("gh-wf-data");
  if (!form || !block) return;
  var d;
  try { d = JSON.parse(block.textContent || ""); } catch (e) { return; }
  var repo = document.getElementById("gh-wf-repo"), branch = document.getElementById("gh-wf-branch"), err = document.getElementById("gh-wf-err");
  function say(t){ if (err) err.textContent = t; }
  form.addEventListener("submit", function(ev){
    ev.preventDefault();
    var r = repo.value.trim(), b = branch.value.trim();
    if (!new RegExp(d.repo).test(r)) { say("Write the repository as owner/name, for example acme/shop."); repo.focus(); return; }
    if (!new RegExp(d.branch).test(b)) { say("That is not a branch name. The default branch of most repositories is main."); branch.focus(); return; }
    var url = gcWorkflowLink(d, r, b);
    if (!url) { say("No address could be built for that branch. Copy the file from the repository instead."); return; }
    say("");
    window.open(url, "_blank", "noopener,noreferrer");
  });
})();`;

/** What the one workflow file does, in the words of docs/github-app/README.md ("Setup", step 1). */
const WORKFLOW_DOES = "It runs your existing Playwright suite under GenClass in a job of its own that is allowed to fail, and uploads the race files.";

/**
 * The setup page's section about the workflow file. With the link on: a form (repository, branch) whose button opens
 * GitHub's new-file editor with the file filled in, and the file's text and the patterns in a data block for the
 * page's script. Without it: where to copy the file from.
 */
function workflowSection(link: { web: string } | null): string {
  const path = `<code>${esc(WORKFLOW_PATH)}</code>`;
  const source = `<a href="${WORKFLOW_SOURCE}"><code>workflows/genclass.yml</code></a>`;
  if (!link) {
    return `<section class="stack mt-l" id="workflow">
  <h2 class="h2l">With no change to your tests</h2>
  <p class="gh-p">Copy ${source} from the GenClass repository to ${path} in yours. ${WORKFLOW_DOES}</p>
</section>`;
  }
  return `<section class="stack mt-l" id="workflow">
  <h2 class="h2l">With no change to your tests</h2>
  <p class="gh-p">Add one workflow file, ${path}. ${WORKFLOW_DOES} The button opens GitHub's new-file editor in a new tab with the file filled in; you review it and commit it there.</p>
  <form class="gh-wf" id="gh-wf" novalidate>
    <label for="gh-wf-repo">Repository<input type="text" id="gh-wf-repo" name="repo" placeholder="owner/name" maxlength="140" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
    <label for="gh-wf-branch">Branch<input type="text" id="gh-wf-branch" name="branch" value="main" maxlength="255" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
    <button class="btn" type="submit">Open the file on GitHub</button>
  </form>
  <p class="gh-wf-err" id="gh-wf-err" role="alert"></p>
  <p class="gh-note">The address is built in this page: what you type here is not sent to GenClass. The same file is in the GenClass repository, ${source}.</p>
  <script type="application/json" id="gh-wf-data">${dataBlock(workflowLinkData(link.web))}</script>
</section>`;
}

/**
 * /github/setup: after installing. Static: it says what to do next and shows nothing about any installation.
 * `workflowLink`: this server shows the link that opens GitHub's new-file editor (config.ts `workflowLink`), with its
 * GitHub web root; absent or null, the page says to copy the workflow file from the repository.
 */
export function githubSetupPage(nonce: string, o: { slug: string; canConnect: boolean; workflowLink?: { web: string } | null }): string {
  const link = o.workflowLink ?? null;
  const body = `
<style nonce="${nonce}">${GH_CSS}</style>
<section class="stack mt-xl">
  <h1>${esc(o.slug)}[bot] is installed</h1>
  <p class="lead">It reviews a pull request as soon as that pull request's workflow run uploads race files. One workflow file, or two steps in your own e2e job; no account needed.</p>
</section>
${workflowSection(link)}
<section class="stack mt-l">
  <h2 class="h2l">Or in your own e2e job</h2>
  ${steps(o.slug)}
</section>
<section class="stack mt-l">
  <h2 class="h2l">Optional</h2>
  <ul class="facts">
    <li><b>Settings:</b> add <code>${esc(SETTINGS_PATH)}</code> on the default branch. A pull request cannot change how it is reviewed.</li>
    ${o.canConnect ? `<li><b>Production findings:</b> <a href="/account/github">link the repository to a GenClass app</a> and reviews also list that app's findings on the pages a pull request touches.</li>` : ""}
    <li><b>Coding agents:</b> <a href="${DOCS}#fix">a workflow</a> can pick up <code>@${esc(o.slug)} fix</code> and run your agent with <code>@genclass/mcp</code> in your own CI, with your own key.</li>
  </ul>
  ${snippet("Settings file", SETTINGS)}
  <p class="gh-note"><a href="${DOCS}">The guide</a> has every setting and command. To remove the app, uninstall it in your GitHub settings: everything kept for the installation is deleted at once.</p>
</section>`;
  return shell(nonce, `${o.slug}[bot] is installed | GenClass`, body, link ? WORKFLOW_LINK_JS + SETUP_FORM_JS : "", {});
}

export interface GithubAccountView {
  /** The signed-in person, as the account pages name them. */
  who: string;
  plan: string;
  slug: string;
  /** This server can ask GitHub who someone is (the app's client id and secret are set). */
  canConnect: boolean;
  /** GitHub's answer for this account, while it lasts. */
  connected: { login: string; expires: string; more: boolean } | null;
  /**
   * `managed`: this account manages the installation (it is on the GitHub account the person connected as, or the
   * server's operator set it). `managedElsewhere`: another GenClass account does. Neither: nobody does.
   */
  installations: { id: number; login: string; type: string; selection: string; suspended: boolean; managed: boolean; managedElsewhere: boolean }[];
  /**
   * The repositories GitHub's answer lists. `needsPlan`: private, and its installation has no plan that includes
   * private repositories (the managing account's, or a Marketplace plan), so it is not reviewed.
   */
  repos: { id: number; name: string; private: boolean; installation: number; push: boolean; project: string | null; linkedElsewhere: boolean; paused: boolean; needsPlan: boolean }[];
  /**
   * Repositories linked to one of this account's apps that GitHub's answer does not list (there is no answer now, or
   * the person cannot reach them any more): the link can be taken away, nothing else. `name` is null for a private one.
   */
  linked: { id: number; name: string | null; private: boolean; project: string }[];
  projects: { id: string; name: string }[];
  notice: string | null;
  /** This account's own plan includes private repositories, or the server reviews every repository. */
  privatePlan: boolean;
}

/** Who manages an installation, and what that decides (HTML; the same sentences as docs/github-app/README.md, "Plans"). */
const managing = (): string => `The plan that counts for an installation's private repositories is the plan of the GenClass account that manages it. An installation on your own GitHub account is managed by the GenClass account you choose Connect GitHub from. For an organization, the managing account is set when the plan is agreed: write to <a href="mailto:${esc(PLANS_FILE.contact)}">${esc(PLANS_FILE.contact)}</a>. Being able to push to a repository does not make an account the manager of its installation.`;

/** What the list of links outside GitHub's answer is (the same sentences as docs/github-app/README.md, "Production findings"). */
const LINKED_ELSEWHERE =
  "These repositories are linked to one of your apps, and GitHub's answer does not list them: this page has not asked GitHub in the last 30 minutes, or you can no longer reach them. The link puts your app's production findings on their pull requests. You can take it away here at any time. Anything else needs GitHub's answer that you have write access.";

/** /account/github: which repositories the app is on, and which GenClass app each one is linked to. */
export function accountGithubPage(nonce: string, v: GithubAccountView): string {
  const org = orgName(v.who);
  const options = (current: string | null): string =>
    `<option value="">Not linked</option>${v.projects.map((p) => `<option value="${esc(p.id)}"${p.id === current ? " selected" : ""}>${esc(p.name)}</option>`).join("")}`;
  const appName = (id: string): string => v.projects.find((p) => p.id === id)?.name ?? "one of your apps";
  // the one control an app's own account has on a repository it cannot write to: take its app's link away
  const unlink = (repoId: number, what: string): string => `<button class="btn sm ghost" type="button" data-unlink="${repoId}" aria-label="Unlink ${esc(what)}"><span>Unlink</span></button>`;
  const rows = v.repos
    .map((r) => {
      const where = `<a href="https://github.com/${esc(r.name)}" rel="noreferrer">${esc(r.name)}</a>${r.private ? ' <span class="aside">· private</span>' : ""}`;
      const link = r.push
        ? `<select data-repo="${r.id}" aria-label="GenClass app for ${esc(r.name)}"${v.projects.length ? "" : " disabled"}>${options(r.project)}</select>${r.linkedElsewhere ? ' <span class="aside">linked to an app of another account</span>' : ""}`
        : r.project
          ? `<span class="aside" data-linkstate>Linked to ${esc(appName(r.project))} (you need write access on GitHub to change anything but this link)</span>`
          : `<span class="aside">${r.linkedElsewhere ? "Linked" : "Not linked"} (you need write access on GitHub to change it)</span>`;
      const act = r.push ? `<button class="btn sm ghost" type="button" data-pause="${r.id}" data-on="${r.paused ? "1" : "0"}"><span>${r.paused ? "Resume" : "Pause"}</span></button>` : r.project ? unlink(r.id, r.name) : "";
      const note = r.needsPlan
        ? ` <span class="aside">· not reviewed: ${v.privatePlan ? "your plan counts for the installations this account manages, and it does not manage this one" : "private repositories need a plan"}</span>`
        : r.paused
          ? ' <span class="aside">· paused</span>'
          : "";
      return `<tr><td data-l="Repository">${where}${note}</td><td data-l="GenClass app">${link}</td><td class="act">${act}</td></tr>`;
    })
    .join("");
  const linkedRows = v.linked
    .map((r) => {
      const where = r.name ? `<a href="https://github.com/${esc(r.name)}" rel="noreferrer">${esc(r.name)}</a>` : `A private repository <span class="aside">· GitHub's id ${r.id}</span>`;
      return `<tr><td data-l="Repository">${where}</td><td data-l="GenClass app"><span class="aside" data-linkstate>Linked to ${esc(appName(r.project))}</span></td><td class="act">${unlink(r.id, r.name ?? "the private repository")}</td></tr>`;
    })
    .join("");
  const installs = v.installations.length
    ? `<ul class="facts">${v.installations.map((i) => `<li><b>${esc(i.login)}</b> (${i.type === "Organization" ? "organization" : "personal account"}, ${i.selection === "all" ? "all repositories" : "selected repositories"})${i.suspended ? ", suspended on GitHub" : ""}, ${i.managed ? "managed by this account" : i.managedElsewhere ? "managed by another GenClass account" : "managed by no GenClass account"}</li>`).join("")}</ul><p class="gh-note">${managing()}</p>`
    : `<p class="intro">No installation is connected to this account yet.</p>`;
  const connect = !v.canConnect
    ? `<p class="intro">This server cannot ask GitHub who you are, so repositories cannot be linked here. Reviews work without it.</p>`
    : v.connected
      ? `<p class="intro">Connected as <b>${esc(v.connected.login)}</b>. GitHub's answer about your repositories is used for 30 minutes, then this page asks again.${v.connected.more ? " Only the first 300 repositories are listed." : ""} <a href="/github/connect">Refresh from GitHub</a></p>`
      : `<p class="intro">To link a repository, this page asks GitHub which installations of ${esc(v.slug)}[bot] and which repositories you can reach. Your GitHub token is used for that question and not kept.</p><div class="row"><a class="btn" href="/github/connect"><span>Connect GitHub</span></a></div>`;
  const table = v.repos.length
    ? `<div class="tablewrap"><table class="dt rows"><thead><tr><th>Repository</th><th>GenClass app</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : v.connected
      ? `<p class="intro">GitHub lists no repository you can reach through an installation of ${esc(v.slug)}[bot]. <a href="/github/install">Install it</a> on an account or an organization first.</p>`
      : "";
  // one place for what a failed change says, in whichever table is on the page
  const errp = `<p class="err" id="gherr" role="alert"></p>`;
  const body = `
<div class="sb-page" id="mc" tabindex="-1">
<style nonce="${nonce}">${GH_CSS}.gh .pnl+.pnl{margin-top:20px}.gh .pnl-b{padding:16px 20px}.gh .pnl-h h1{font-size:14px;color:var(--ink)}.gh select{max-width:260px}.gh .aside{font-size:12px;color:var(--ink3)}.gh .gh-note{margin:10px 0 14px}.gh-ok{font-size:14px;color:var(--ink2);margin-bottom:16px}.gh-ok b{font-weight:500;color:var(--accent)}</style>
<div class="gh">
${v.notice ? `<p class="gh-ok" role="status"><b>Done.</b> ${esc(v.notice)}</p>` : ""}
<section class="pnl">
  <div class="pnl-h"><h1>GitHub</h1><a class="btn sm ghost" href="/github/install">Install on another account</a></div>
  <div class="pnl-b">
    <p class="intro">${esc(v.slug)}[bot] reviews pull requests from the race files their test runs upload; that needs no link. Linking a repository to one of your apps adds that app's production findings (kinds, page routes and counts) for the pages a pull request touches. On a public repository everyone who can see the pull request sees them.</p>
    ${installs}
    ${connect}
  </div>
</section>
${table ? `<section class="pnl"><div class="pnl-h"><h2>Repositories</h2><span class="aside">${v.repos.length} you can reach</span></div><div class="pnl-b">${table}${errp}</div></section>` : ""}
${linkedRows ? `<section class="pnl"><div class="pnl-h"><h2>Linked, not in GitHub's answer</h2><span class="aside">${v.linked.length} linked to your apps</span></div><div class="pnl-b"><p class="intro">${LINKED_ELSEWHERE}${v.linked.some((r) => !r.name) ? " A private repository is listed without its name." : ""}</p><div class="tablewrap"><table class="dt rows"><thead><tr><th>Repository</th><th>GenClass app</th><th></th></tr></thead><tbody>${linkedRows}</tbody></table></div>${table ? "" : errp}</div></section>` : ""}
</div>
</div>`;
  const script = `
(function(){
  var err = document.getElementById("gherr");
  function say(e){ if (err) err.textContent = e ? gcWhy(e) : ""; }
  document.querySelectorAll("select[data-repo]").forEach(function(sel){
    var was = sel.value;
    sel.addEventListener("change", function(){
      say(null); sel.disabled = true;
      gcPost("/api/account/github/repos/" + encodeURIComponent(sel.getAttribute("data-repo")), { project_id: sel.value || null })
        .then(function(){ was = sel.value; }, function(e){ sel.value = was; say(e); })
        .then(function(){ sel.disabled = false; });
    });
  });
  document.querySelectorAll("button[data-pause]").forEach(function(b){
    b.addEventListener("click", function(){
      var on = b.getAttribute("data-on") === "1";
      say(null); b.disabled = true;
      gcPost("/api/account/github/repos/" + encodeURIComponent(b.getAttribute("data-pause")), { paused: !on })
        .then(function(){ b.setAttribute("data-on", on ? "0" : "1"); b.lastChild.textContent = on ? "Pause" : "Resume"; }, say)
        .then(function(){ b.disabled = false; });
    });
  });
  document.querySelectorAll("button[data-unlink]").forEach(function(b){
    b.addEventListener("click", function(){
      say(null); b.disabled = true;
      gcPost("/api/account/github/repos/" + encodeURIComponent(b.getAttribute("data-unlink")), { project_id: null })
        .then(function(){
          var row = b.closest("tr"), st = row && row.querySelector("[data-linkstate]");
          if (st) st.textContent = "Not linked";
          b.lastChild.textContent = "Unlinked";
        }, function(e){ b.disabled = false; say(e); });
    });
  });
})();`;
  return studioPage(nonce, {
    title: "GitHub | GenClass",
    account: true,
    org: { name: org, plan: v.plan, href: "/account" },
    projects: v.projects,
    project: null,
    user: { label: v.who, sub: org },
    ...orgRail("projects"),
    railLabel: "Organization",
    css: DASH_CSS + ORG_CSS,
    body,
    script: CLIENT_JS + script,
  });
}
