# genclass

`genclass` is the short command for the CLI of GenClass Runtime
([`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime)), an open-source (Apache-2.0) browser library
that reports race conditions in web apps while they happen: stale responses that land over newer data, duplicate
requests such as double submits, inconsistent state and failure storms. By default it only reports (`observe`): it
never holds, delays or changes a request, a response or a state write.

> **Not on npm yet.** Nobody has published `genclass`, so until its first release npx would run whatever npm then
> serves under that name. The commands below run the same CLI from `@genclass/runtime@beta`; the release that first
> publishes `genclass` takes this note out and gives them with the short name.

`genclass <command>` runs `genclass-runtime <command>` from `@genclass/runtime` at the same version as `genclass`. It
adds nothing of its own: the commands, options, output and exit codes are the runtime CLI's, and its help calls the
command `genclass-runtime`.

```bash
npx @genclass/runtime@beta init               # set GenClass up in this project: shows the diff and asks first
npx @genclass/runtime@beta init --no-token    # the same without a token: no call to genclass.dev
npx @genclass/runtime@beta remove             # take out exactly what init added
npx @genclass/runtime@beta scan <url>         # check one page with the measured visual checks
npx @genclass/runtime@beta --help             # every command
```

## What init and scan send

`init` finds your framework, shows you the diff first, then installs `@genclass/runtime` (the version `genclass`
names) and adds one line to your entry file, plus a development-only devtools line. On a new setup, once you
approve the diff, it also creates your app's token and private dashboard link at genclass.dev, sending your
`package.json` name; it writes the token into what it adds and saves the link in `.genclass.local` (keep that link
private: anyone with it sees your app's dashboard). `--token gc_...` uses a token you already have and `--no-token`
skips the token; neither contacts genclass.dev. `init` also asks npm, for at most 3 seconds, whether a newer release
exists (`--no-network` skips that), and your package manager installs from its registry.

`scan` loads the page in headless Chromium on your computer when Playwright and its Chromium are installed: observe
mode, telemetry off, nothing sent. Without them, or with `--hosted`, it sends the URL to the
[genclass.dev page check](https://genclass-scan.mehar-144.workers.dev/scan), which loads the page instead; localhost
and private addresses are never sent there, and `--local` never uses it.

## Privacy

`@genclass/runtime` sends **anonymous diagnostics by default** from public hosts: GenClass's decisions and counts, no
text from your page unless the app opts in, to the GenClass maintainers to improve the model; with an app token the
same diagnostics also feed your app's private dashboard. They are off on `localhost` and other local or private
hosts. Opt out with `GenClass.init({ telemetry: false })`, `?genclass=no-telemetry`,
`localStorage.setItem("genclass.telemetry", "off")` or `init --no-telemetry` (which also skips the token); browsers
sending Global Privacy Control are never collected. Details:
[TELEMETRY.md](https://github.com/genclass-dev/GenClass/blob/main/packages/runtime/TELEMETRY.md).

## Versions

`genclass` is published only for stable versions of `@genclass/runtime`, to npm's `latest`, and each version depends
on exactly the runtime version with the same number, so the short command runs the newest stable line. While the
newest line is a prerelease, `npx @genclass/runtime@beta <command>` runs it.

Apache-2.0.

<!-- Maintainers: package.json here keeps the version of packages/runtime/package.json and a range (>=<version>) for
@genclass/runtime, so npm links the workspace runtime; test/genclass.test.ts (ci.yml's runtime job) checks both.
release.yml's genclass job publishes this package after the runtime, for a stable version and only when the
repository variable GENCLASS_CLI is on, with the dependency set to exactly that version (npm pkg set before npm pack),
to latest. Its first version is the owner's (release.yml's header). In the release commit of that first version, take
the quoted note at the top out and give the commands with the short name instead of @genclass/runtime@beta: while this
file says genclass is unpublished in those words, release.yml stops before it publishes anything, and the same test
fails if this file prints the short command while it says so, or does not print it once the note is gone. The test
also fails while a README or another document outside packages/genclass/ prints the command; the change that starts
printing it there, once genclass is on npm, changes that check too. -->
