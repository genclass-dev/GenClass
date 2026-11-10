# Listing genclass-dev[bot] on GitHub Marketplace

Research and steps, written 2026-11-09 from GitHub's documentation as read that day. Nothing is submitted from this
repository, and the app is not registered yet ([docs/github-app/SETUP.md](../../github-app/SETUP.md)). Sources:
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
- It is free on public repositories. Private repositories are by agreement.
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
| "Listings must include valid contact information for the publisher." | mehar@daybot.ca |
| "Listings must have a relevant description of the application." | Draft below. |
| "Listings must specify a pricing plan." | One free plan, below. |
| "Listings must have a valid link to a privacy policy." | `PRIVACY.md` has "The GitHub App"; a page on genclass.dev that shows it is still to do (the site is in another repository). |
| "Listings must provide a method to receive support through a valid support link and/or a support email address." | The repository's issues, and the email above. |
| "Apps must provide value to customers and integrate with the platform in some way beyond authentication." | Checks, comments, commands. |
| "Apps must be publicly available in GitHub Marketplace and cannot be in public preview or available by invite only." | The manifest registers it as public. It must be past "nothing can be installed today" first: SETUP.md, "Before anything else". |
| "Apps must have webhook events set up to notify the publisher of any plan changes or cancellations using the GitHub Marketplace API." | `POST /api/github/marketplace` takes `marketplace_purchase`: purchased, changed, cancelled, pending_change, pending_change_cancelled. The listing's webhook is set on the listing page with its own secret (`GITHUB_MARKETPLACE_WEBHOOK_SECRET`) and must be Active before review. |
| "Apps must have a logo, feature card, and screenshots images that meet the recommendations" | To make: see Images. |
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
  outside the Marketplace. **This needs a decision before submitting**: either private repositories are not sold at
  all until the listing can carry a paid plan (`GITHUB_APP_PRIVATE_REPOS` stays `plan` and nobody is granted it for
  the app), or ask the onboarding contact whether an agreement by email counts.
- On `cancelled`, GitHub asks to "Remove all customer data within 30 days of receiving the cancelled event." The app
  deletes the plan row at once; an uninstall deletes everything else at once. A cancellation without an uninstall
  leaves the installation's rows, which the free tier needs to keep working: say so if asked.

## Pricing

GitHub's plans are "free, flat rate, or per-unit", up to 10, in US dollars; a paid plan needs a monthly and a yearly
price and may have a 14-day trial; a plan is for "Personal accounts and organizations, Personal accounts only, or
Organizations only". The Marketplace has no notion of public and private repositories: the app enforces that itself
(`src/github/entitlement.ts`: a plan whose monthly price is above 0 opens private repositories).

To list now:

| Plan | Price | For | Description |
|---|---|---|---|
| Open source | Free | personal accounts and organizations | Every public repository. One check per commit, one comment per pull request, all commands. |

Later, once a paid plan is possible (no price is decided; these are the shapes GitHub allows):

| Plan | Shape | What it adds |
|---|---|---|
| Team | flat rate, monthly and yearly | Private repositories. |

## Listing text (draft)

**Name:** GenClass

**Very short description** (40 to 80 characters, no app name, no call to action, no full stop):

> Runtime evidence from your own tests, on the pull request

**Introductory description** (150 to 250 characters, starts with the app's name):

> GenClass shows what its runtime saw in the page while a pull request's Playwright tests ran: a request sent twice,
> an older response applied over a newer one. Each finding names its test, its seeds and the evidence line.

**Detailed description** (up to 1,000 characters):

> GenClass reviews a pull request from what ran, not from what the diff looks like.
>
> - Add the GenClass fixture to your Playwright tests and upload its race files from your workflow. The app reads
>   them when the run finishes, also for pull requests from forks.
> - One check on each commit and one comment per pull request, edited in place. Nothing flagged, no comment.
> - A finding flagged in two or more seeds of the same test is marked reproducible. From push to push it is new,
>   still flagged, or not flagged at the new commit.
> - `@genclass-dev replay 1` gives the steps to reproduce a finding. `@genclass-dev fix 1` writes a brief your coding agent
>   can work from in your own CI.
> - It has no access to repository contents: it cannot read or change your code.
>
> Each line is a diagnosis or a measured fact to check, not a verdict.

**Categories:** Code review (primary), Testing (secondary). **Languages:** JavaScript, TypeScript.

**URLs:** Customer support `https://github.com/genclass-dev/GenClass/issues`; Privacy policy: the genclass.dev page
that shows `PRIVACY.md` (to do); Documentation
`https://github.com/genclass-dev/GenClass/blob/main/docs/github-app/README.md`; Company `https://genclass.dev`.
"Installation URL" is for OAuth apps: skip it.

## Images

- **Logo:** square, "at least 200 pixels x 200 pixels", no text. The mark at genclass.dev/brand is the source; a badge
  background colour is chosen with it.
- **Feature card:** "965 pixels x 482 pixels".
- **Screenshots:** "up to five", "at least 1200px wide", one aspect ratio. Take them on a real pull request, after the
  first run in SETUP.md: the comment with a reproducible finding; the check's page; a reply to `@genclass-dev replay`; the
  `/account/github` page. Not mock-ups.

## Steps

1. Everything in [SETUP.md](../../github-app/SETUP.md) up to "First run", on a real repository.
2. A privacy page on genclass.dev that shows "The GitHub App" from `PRIVACY.md`.
3. Decide the question under "Free and paid" about private repositories by agreement.
4. Logo, feature card, screenshots.
5. On the app's page: List in Marketplace. Fill the text above, add the Open source plan, set the listing's webhook to
   `https://genclass.dev/api/github/marketplace` with a new secret, store that secret as
   `GITHUB_MARKETPLACE_WEBHOOK_SECRET`, tick Active.
6. Test the purchase flow as GitHub's "Testing your app" page describes (the stubbed Marketplace endpoints), then
   submit.
7. When the listing is live: set the two `available: false` lines in `billing/plans.json` to `true`, and add the
   Marketplace link next to the install link in the README and on `/github`.
