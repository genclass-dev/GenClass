# Listing genclass-dev[bot] on GitHub Marketplace

Research and steps, written 2026-11-09 from GitHub's documentation as read that day, and the listing as it was
filled in on GitHub on 2026-11-10 ([The draft on GitHub](#the-draft-on-github)). The owner submitted it for review
that day; GitHub answers by email. Sources:
[Requirements for listing an app](https://docs.github.com/en/apps/github-marketplace/creating-apps-for-github-marketplace/requirements-for-listing-an-app),
[Writing a listing description](https://docs.github.com/en/apps/github-marketplace/listing-an-app-on-github-marketplace/writing-a-listing-description-for-your-app),
[Setting pricing plans](https://docs.github.com/en/apps/github-marketplace/listing-an-app-on-github-marketplace/setting-pricing-plans-for-your-listing),
[Pricing plans for apps](https://docs.github.com/en/apps/github-marketplace/selling-your-app-on-github-marketplace/pricing-plans-for-github-marketplace-apps),
[Configuring a webhook for plan changes](https://docs.github.com/en/apps/github-marketplace/listing-an-app-on-github-marketplace/configuring-a-webhook-to-notify-you-of-plan-changes),
[Handling new purchases](https://docs.github.com/en/apps/github-marketplace/using-the-github-marketplace-api-in-your-app/handling-new-purchases-and-free-trials),
[Handling cancellations](https://docs.github.com/en/apps/github-marketplace/using-the-github-marketplace-api-in-your-app/handling-plan-cancellations),
[Submitting your listing](https://docs.github.com/en/apps/github-marketplace/listing-an-app-on-github-marketplace/submitting-your-listing-for-publication),
[Marketplace badges](https://docs.github.com/en/apps/github-marketplace/github-marketplace-overview/about-marketplace-badges).

## What is true today (keep the listing to this)

- The app reads race files a workflow uploads and the names and line ranges of changed files. It does not read
  source code and has no contents permission.
- Findings are diagnoses by the runtime's on-device model, or facts it measured without the model. The listing says
  "flagged" and "reproducible in N seeds", never "finds every race" and never "fixes".
- No number about how often it is right belongs in the listing unless
  [docs/runtime/RESULTS.md](../../runtime/RESULTS.md) has it, with the false-report rate next to it.
- It is free, on public and private repositories (decided 2026-11-10; a paid plan for private repositories may come
  later). With no paid service sold elsewhere, a free listing is allowed.
- It never comments where it is not installed.

## How the Marketplace works

- A listing is drafted from the app's settings page ("List in Marketplace"). "You can only create draft listings for
  apps that are public", and for an app owned by an organization "only organization owners can create and submit
  listings". The publisher accepts the Marketplace Developer Agreement.
- Submitting ("Request publish" on one docs page, "Submit for review" on another) starts a review: "An onboarding
  expert will reach out to you with additional information." GitHub "does not analyze or inspect third party code".
- An unverified listing gets the badge "App meets the requirements for listing" and "cannot change their pricing plan
  until the publisher successfully applies for verification." The verified badge ("Publisher domain and email
  verified") needs a verified domain, a confirmed email and two-factor authentication required for the organization.

## Requirements, and where the app stands

For every listing (quoted from the requirements page):

| Requirement | Status |
|---|---|
| "Listings must not actively persuade users away from GitHub." | The listing links to the guide in this repository and to genclass.dev only for the privacy policy and the account page. |
| "Listings must include valid contact information for the publisher." | mehar@genclass.dev, for all four contacts the form asks for (technical, marketing, finance, security). |
| "Listings must have a relevant description of the application." | Draft below. |
| "Listings must specify a pricing plan." | One free plan, "Free", published inside the draft listing. |
| "Listings must have a valid link to a privacy policy." | The listing links `PRIVACY.md` in this repository, which has "The GitHub App". genclass.dev/privacy does not show that section yet (the site is in another repository). |
| "Listings must provide a method to receive support through a valid support link and/or a support email address." | The repository's issues, and the email above. |
| "Apps must provide value to customers and integrate with the platform in some way beyond authentication." | Checks, comments, commands. |
| "Apps must be publicly available in GitHub Marketplace and cannot be in public preview or available by invite only." | The manifest registers it as public. It must be past "nothing can be installed today" first: SETUP.md, "Before anything else". |
| "Apps must have webhook events set up to notify the publisher of any plan changes or cancellations using the GitHub Marketplace API." | `POST /api/github/marketplace` takes `marketplace_purchase`: purchased, changed, cancelled, pending_change, pending_change_cancelled. The listing's webhook is set on the listing page with its own secret (`GITHUB_MARKETPLACE_WEBHOOK_SECRET`) and must be Active before review. Set on 2026-11-10; the first delivery, the ping, was answered 202. |
| "Apps must have a logo, feature card, and screenshots images that meet the recommendations" | Uploaded: see Images. |
| For a GitHub App: "your app must identify users following the OAuth authorization flow"; the Setup URL "is a required field"; "Your app must provision a customer account for all new purchases." | Connect GitHub is the OAuth flow; the Setup URL is `/github/setup`; a purchase is recorded per GitHub account in `github_marketplace`. Whether a row per GitHub account, with no GenClass account until the person connects, satisfies "provision a customer account" is a question for the onboarding review. |

Free and paid:

- "To publish apps with free plans, you only need to meet the general requirements for listing any app." Apps with
  only free plans "do not need to handle events for free trials, upgrades, and downgrades" (the app handles them
  anyway).
- A paid plan needs: "your app must be owned by an organization that is a verified publisher"; "GitHub Apps should
  have a minimum of 100 installations."; "Apps must support both monthly and annual billing for paid subscriptions
  purchases."; and handling of every purchase event. GitHub keeps 5% of a sale.
- "you can't list your app with a free pricing plan if you offer a paid service outside of GitHub Marketplace." The
  same page says that once a free listing meets the requirements for paid apps, a paid version sold elsewhere must
  also be offered in the Marketplace. Private repositories by agreement (the Enterprise plan) are a paid service
  outside the Marketplace. Decided 2026-11-10: the app is free on private repositories too
  (`GITHUB_APP_PRIVATE_REPOS = "open"`), and no plan sold anywhere includes it, so nothing about the app is sold
  outside the Marketplace.
- On `cancelled`, GitHub asks to "Remove all customer data within 30 days of receiving the cancelled event." The app
  deletes the plan row at once; an uninstall deletes everything else at once. A cancellation without an uninstall
  leaves the installation's rows, which the free tier needs to keep working: say so if asked.

## Pricing

GitHub's plans are "free, flat rate, or per-unit", up to 10, in US dollars; a paid plan needs a monthly and a yearly
price and may have a 14-day trial; a plan is for "Personal accounts and organizations, Personal accounts only, or
Organizations only". The Marketplace has no notion of public and private repositories: the app enforces that itself
(`src/github/entitlement.ts`: a plan whose monthly price is above 0 opens private repositories).

Listed (2026-11-10):

| Plan | Price | For | Description |
|---|---|---|---|
| Free | Free | personal accounts and organizations | "Runtime reviews on public and private repositories". Bullets: "One check per commit, one comment per pull request"; "Public and private repositories"; "Every command: review, replay, fix, issue"; "No access to repository contents". |

GitHub locks a published plan's name and pricing model; its description and bullets stay editable.

Later, once a paid plan is possible (no price is decided; these are the shapes GitHub allows):

| Plan | Shape | What it adds |
|---|---|---|
| Team | flat rate, monthly and yearly | Private repositories. |

## Listing text

As entered on 2026-11-10. GitHub's form allows more than its guide recommends: 125 characters for the very short
description, 500 for the introduction, 400 to 2,000 for the detailed description.

**Name:** GenClass.dev ("GenClass" is refused: another account has that name)

**Very short description:**

> Runtime evidence from your own Playwright tests, on the pull request

**Introductory description:**

> GenClass.dev shows what the GenClass runtime saw in the page while a pull request's Playwright tests ran: a request
> sent twice, an older response applied over a newer one. Each finding names its test, its seeds and the evidence line.

**Detailed description:**

> GenClass.dev reviews a pull request from what happened in the page while its tests ran. Nothing is inferred from the
> diff.
>
> - **One file to set up.** Add one workflow file. It runs your existing Playwright suite under GenClass, in a job of
>   its own that is allowed to fail, and uploads small race files. No change to your tests or your Playwright config.
> - **One check, one comment.** A check on each commit and one comment per pull request, edited in place. With nothing
>   flagged there is no comment.
> - **Reproducible or not.** A finding flagged in two or more seeds of the same test is marked reproducible. From push
>   to push it is new, still flagged, or not flagged at the new commit.
> - **Commands.** `/genclass replay 1` replies with the steps to reproduce a finding. `/genclass fix 1` writes a brief
>   your coding agent can work from.
> - **No access to your code.** The app reads the race files your workflow uploads and the paths of the files a pull
>   request changes. It has no permission to read or change repository contents.
>
> Free, on public and private repositories.
>
> Each line is a diagnosis or a fact the runtime measured. Whether it is a bug is for you to decide. What the app keeps
> is in the [privacy policy](https://github.com/genclass-dev/GenClass/blob/main/PRIVACY.md#the-github-app).

It leaves out what has not been run against GitHub yet: pull requests from forks, and the fix workflow in CI.

**Categories:** Code review (primary), Testing (secondary). **Languages:** JavaScript, TypeScript.

**URLs:** Customer support `https://github.com/genclass-dev/GenClass/issues`; Documentation
`https://github.com/genclass-dev/GenClass/blob/main/docs/github-app/README.md`; Company `https://genclass.dev`; Status:
none.

<a id="the-draft-on-github"></a>

## The draft on GitHub

`https://github.com/marketplace/genclass-dev/edit` (organization owners only; GitHub asks for sudo). State on
2026-11-10: all five items are complete, the Developer Agreement (v2.4) is signed by the owner, and the listing is
"Pending for publish": the owner requested publication, and "Withdraw request" on that page takes it back.

The webhook is `https://genclass.dev/api/github/marketplace`, JSON, Active, with a secret of its own that is also the
worker's `GITHUB_MARKETPLACE_WEBHOOK_SECRET`. The owner set both; the ping was answered 202. From then on the
listing's endpoint no longer accepts the app's own webhook secret.

Security and compliance, as entered:

- **EU Digital Services Act:** "I do not operate as a trader under EU regulations". This is the owner's declaration
  (2026-11-10); the form says it concerns paid app publishers. It has to be looked at again before any paid plan.
- **Privacy Policy URL:** `https://github.com/genclass-dev/GenClass/blob/main/PRIVACY.md`.
- **Terms of Service URL:** empty. genclass.dev/terms covers the collector, dashboards, accounts and billing and
  does not mention the app.
- **Third-party services:** "Cloudflare: the app runs on Cloudflare Workers and keeps its records in Cloudflare D1. No
  other service receives data from the app."
- **Repository visibility:** Public, `https://github.com/genclass-dev/GenClass`.
- **Transparency disclosures:** six short paragraphs from [the guide](../../github-app/README.md) and
  [PRIVACY.md](../../../PRIVACY.md#the-github-app): the permissions; what is read and that race files are untrusted
  input; what is stored and for how long; how webhooks, tokens and settings are checked; that the app's server runs
  no model and nothing read is used for training; that no third-party certification is claimed, with the links to the
  source and to private vulnerability reports. A change to what the app reads or keeps has to be made there too.

## Images

In [`docs/github-app/media/`](../../github-app/media/), as uploaded on 2026-11-10:

- **Logo:** `logo-512.png`, the mark on white; badge background colour `ffffff`.
- **Feature card:** `listing/feature-card.png`, 965 by 482, drawn from `listing/feature-card.svg`: two requests in
  flight at once, the one sent first coming back last, in the mark's two colours on black. GitHub puts the badge and
  the name over the middle in light text, so the drawing stays in two corners.
- **Screenshots:** four, each 1440 by 812, of this repository's own pull requests (not mock-ups), with captions:
  `listing/1-review.jpg` "The review: one comment with the finding, its test and the seeds it was seen in";
  `listing/2-replay.jpg` "/genclass replay 1 replies with the steps to reproduce the finding";
  `listing/3-first-check.jpg` "The first check says what the app reads and links to the one workflow file";
  `listing/4-one-file.jpg` "The link opens GitHub's editor with the workflow file filled in: read it and commit".

## Steps

Done: the app is public and reviewed real pull requests ([SETUP.md](../../github-app/SETUP.md)); the question under
"Free and paid" is decided; logo, feature card and screenshots; the listing's text, plan and security information; the
listing's webhook with its own secret; the request for publication (2026-11-10).

Left:

1. GitHub's review. "An onboarding expert will reach out to you with additional information", by email to the
   contacts on the listing.
2. The purchase flow was not tested with GitHub's stubbed Marketplace endpoints ("Testing your app") before the
   request. The unit tests cover the purchase events; a delivery from GitHub itself has only been the ping. Test it
   when the onboarding contact writes, and in any case before a paid plan.
3. A privacy page on genclass.dev that shows "The GitHub App" from `PRIVACY.md`, and terms that mention the app; then
   point the listing at them.
4. When the listing is live: add the Marketplace link next to the install link in the README and on `/github`.

To change the webhook's secret later: put the new value on the worker first
(`wrangler secret put GITHUB_MARKETPLACE_WEBHOOK_SECRET`), then "Change secret" in the listing's webhook form. GitHub
does not send a failed Marketplace delivery again, so do both in one sitting.
