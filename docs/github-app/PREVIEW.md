# Preview reviews: design notes

Not built. This page records a design for reviewing a pull request's preview deployment with no repository setup,
what three reviewers found wrong with it on 2026-11-10, and what it needs before it can be built. Users' guide:
[README.md](README.md). The app as it is: [DESIGN.md](DESIGN.md).

## The idea

After someone installs the app, the next pull request that gets a preview deployment (Vercel, Netlify, Cloudflare
Pages) would be reviewed without any change to the repository: the app loads the preview and production in the hosted
page check, as a desktop and a phone, and reports what shows on the preview and not on production (uncaught errors,
failed requests, a form that submits twice, what the runtime's visual checks measure).

## Why it is not built

The comparison is the problem, not the plumbing. A difference between a preview and production is usually not the
pull request's doing, and every case below would put a confident line on someone's pull request:

1. **A preview is another environment.** Hosts give previews their own variables and origins on purpose. An API that
   allows only the production origin, a map or captcha key bound to the production domain, a preview database with
   other rows: each gives the same error on every preview and never on production. A second load confirms it, so it
   would be reported on every pull request of that repository, a README change included.
2. **Some errors exist only inside the page check's browser.** It never lets a request other than GET or HEAD leave:
   a page that sends a POST while it loads (GraphQL, RPC) gets a stand-in answer and may throw. The public report marks
   such findings as possibly its own doing and does not score them; a diff would have to carry the same caveat per
   view, and the same for requests it refuses or cannot look up.
3. **The two loads may not be the same page.** Production behind a bot check or a rate limit, a redirect to a sign-in
   on another site, a single-page app answering 200 for a route that does not exist yet, a production address that
   belongs to another site of the same repository (docs on GitHub Pages, the app on Netlify).
4. **Production is not the pull request's base.** A branch behind production, production behind main, a production
   result remembered from hours ago, an outage shared by both sites: all read as "on the preview, not on production".
5. **Identities move between builds.** Position-path selectors shift when one element is added; minified names in
   error messages, build ids and hashed file names in paths change with every build.
6. **Who published the address.** A pull request's own workflow, a fork's included, can create a deployment status with
   any `environment_url` on the base repository, and an environment named like production would have replaced the
   repository's remembered production address. `target_url` is the job's log page, not the site. Railway's
   `environment_url` is its dashboard.

After the complaint about automated reports ([issue 173](https://github.com/genclass-dev/GenClass/issues/173)) a wrong
line on a pull request costs more than a missed finding, and none of this can be measured before real installations
exist. So the app launched with the evidence that is measured in the repository's own tests, and this stays a design.

## What it needs

**Signals: trust who made them, not their shape.**

- Vercel: `deployment_status` whose `deployment.creator.login` is `vercel[bot]`, environment `Preview` or
  `Preview – <project>` (space, U+2013, space), address from `environment_url` only. Never `target_url` or `log_url`.
- Netlify: a success commit status from `netlify[bot]` whose `target_url` host is exactly
  `deploy-preview-<N>--<site>.netlify.app`, with `<N>` the pull request's number. Two contexts exist,
  `netlify/<site>/deploy-preview` and `deploy/netlify`; a cancelled deploy is also a success status and points at
  `app.netlify.com`, which the host rule keeps out. Prefer reading `GET /commits/{sha}/statuses` for a pull request's
  head over subscribing to `status`, which delivers every status of every commit with the author's name and e-mail.
- Cloudflare Pages: a completed, successful check run from the app `cloudflare-workers-and-pages` (id 85455) named
  `Cloudflare Pages: <project>`, on action `created` or `completed` (Cloudflare creates it already completed); the
  address is the first `https://<8 hex>.<subdomain>.pages.dev` after "Preview URL:" in `output.summary`. Other apps'
  check runs arrive only when the app subscribes to `check_run`; the delivery must be dropped before any database
  write unless it is that app's.
- Everything else (Actions environments, Render, Railway, Fly.io, Heroku) only when the settings file names the
  environment and the production address. A fixed list of hosts is never an address: github.com, vercel.com,
  app.netlify.com, dashboard.render.com, railway.com, dash.cloudflare.com.
- Production: `preview.base`, else what the host's naming guarantees (remove `deploy-preview-<N>--` for Netlify, the
  first label for Cloudflare Pages). Nothing is derived for Render, and Vercel's production deployment address is a
  generated one behind the same protection as its previews.
- Fork pull requests: pages are loaded only when someone with write access asks.

**The comparison.**

- One seed for all loads of a path; production loaded in the same job, not remembered; a candidate must be absent from
  two production loads and present in two preview loads.
- Both loads must be the same page: document status 200, 203 or 304, no bot-check page by the page check's own test,
  final address on the same site and path, and alike (title, or half of the same-site script and stylesheet paths).
- No candidate from a view that got a stand-in answer or had requests refused, from a category that was cut or timed
  out on either side, or from a script on another site.
- Identities from content, not position: an image or stylesheet by URL path, a font by family, a custom property by
  name; where only a position path exists, compare counts. Mask hash-like runs, both hosts and short identifiers.
- A control before any comment: a finding goes to the comment only when another pull request's preview of the same
  repository was loaded on the same path and did not show it. Until a repository has that history, findings stay in
  the check. `preview.ignore` for what is expected on previews.
- Only when the pull request's base is the default branch.

**What it says.** Its own check run ("GenClass preview"), never the tests' check, with `preview.fail_on` of its own.
"First seen at `abc1234`", never "New". Each load's time, never "in the same run" for a remembered result. "No
difference found on 2 pages (signed out)", neutral, not a green tick. A busy page check is said as that, not as "the
preview could not be loaded". Addresses in code spans, never as links; page text stripped of control and format
characters, redacted (e-mail addresses, tokens, long opaque runs), then fenced. `fix` only for visual findings, with
page text only inside the brief's data block.

**The job.** A queue consumer in the collector (a page check takes 35 to 55 seconds; a Worker has 30 after answering a
webhook), `max_retries` set explicitly with a dead-letter queue, waiting done by sending again with a delay, a lease
token per attempt, finished loads kept on the job row so a redelivery resumes, a sweep for rows whose lease ran out,
at most one job per installation and per site at a time, budgets counted in page-check calls. The page check is
reached through a named entrypoint with `props` on the binding (no public path, no shared secret), with its own
share of the slots and no site probe.

**Before any of it writes on a pull request:** run it silently on real installations that agreed to it, count what
it would have said, and have a person check a sample. Report that rate next to anything it finds.

## Facts worth keeping (checked live, 2026-11-10)

- The prefilled new-file link works: `https://github.com/<owner>/<repo>/new/<branch>?filename=<path>&value=<text>`
  opens the editor with the name and the content filled in (about 6,000 characters of address at most).
- Of 14 live Vercel previews of public repositories, 12 redirected to Vercel's sign-in; 17 of 21 Netlify previews and
  19 of 19 Cloudflare previews answered 200.
- `deployment_status` needs Deployments read; `status` needs Commit statuses read; adding a permission to a
  registered app asks every installation to approve it.
- A check run's whole `output.summary` is in the webhook payload.
- The page check's deployed version (report 17) is on the branch `deploy/scan-page-light` of the site repository,
  four commits ahead of its `main`.
