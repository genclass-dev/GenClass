# The GenClass Discord

The GenClass Discord, [discord.gg/kN9kRnFtZm](https://discord.gg/kN9kRnFtZm), is where people ask for help with
GenClass Runtime, show what it caught, suggest things and talk with the maintainers. It is linked from the
[README](../../README.md), the [package README](../../packages/runtime/README.md), [FAQ.md](../../FAQ.md), the
issue chooser (`.github/ISSUE_TEMPLATE/config.yml`) and the dashboard on genclass.dev. Bugs and false detections
still go to [GitHub Issues](https://github.com/genclass-dev/GenClass/issues), so nothing gets lost in chat, and
security reports follow [SECURITY.md](../../SECURITY.md), never a public channel.

This page is the server's layout, how it is set up (`scripts/discord-setup.mjs`, run by the owner) and what stays a
step by hand. The [Code of Conduct](../../CODE_OF_CONDUCT.md) applies in the server as it does in the repository.

## Layout

The layout lives in one place, `LAYOUT`, `ROLES` and the messages in [`scripts/discord-setup.mjs`](../../scripts/discord-setup.mjs);
this table mirrors it. Change the script, not the server, so a later run does not undo the change.

| category | channel | what for |
|---|---|---|
| Start here (read-only) | `#welcome` | what GenClass is, where to post, the links; the script posts and maintains this message |
| | `#rules` | the rules (a short form of the Code of Conduct); the server's rules channel |
| | `#announcements` | releases and news; an announcement channel other servers can follow; `@Release pings` is mentioned once per release |
| Community | `#general` | GenClass, race conditions, web apps (the server's own `#general` is moved here, not replaced) |
| | `#show-and-tell` | races GenClass caught, integrations, write-ups |
| | `#off-topic` | the rest |
| Help | `#help` (forum) | one post per question; tags Runtime, Coding agents (MCP), Playwright, Frameworks, Model, False detection, Solved |
| | `#ideas` (forum) | one idea per post; tags Runtime, Coding agents (MCP), Integrations, Docs, and the moderator-only Planned and Shipped |
| Development | `#contributing` | working on GenClass itself |
| | `#github` (read-only) | issues, pull requests and releases from `genclass-dev/GenClass`, through a webhook |
| Voice | Office hours | a voice channel for calls |
| Moderation (staff only) | `#mod-chat` | maintainers and moderators |
| | `#mod-log` | AutoMod alerts, raid alerts, Discord's community updates and safety alerts |

| role | who | can |
|---|---|---|
| Maintainer | the repository's maintainers (the owner gets it on the first run) | moderate, ban, manage channels, roles, webhooks and events, mention everyone, post in the read-only channels |
| Moderator | trusted community members | kick, time out, delete messages, manage threads, see the audit log |
| Contributor | people with a merged pull request | nothing extra; a visible thank-you, and exempt from the invite-link filter |
| Release pings | anyone who picks it in Channels & Roles (an onboarding question) | nothing; mentioned in `#announcements` per release |

`@everyone` keeps Discord's ordinary member permissions and loses the moderation ones (mention everyone, manage
messages, kick, and so on). Server settings: Community on (rules in `#rules`, updates and safety alerts in
`#mod-log`), verification Low or higher, the media filter for all members, default notifications mentions only, a
description, the GenClass mark as the icon, a welcome screen (rules, help, general, announcements, contributing)
and onboarding with every public channel as a default. AutoMod blocks spam, mention spam (5 or more), slurs and
sexual content, scam phrases and invites to other servers (the server's own invite is allowed), each with an alert
in `#mod-log`; maintainers and moderators are exempt from the spam and link rules.

## Setting it up

The script works through a bot the owner makes for the purpose, never a user account: automating a user account is
against Discord's terms, and a bot's actions are in the audit log under its own name. Discord grants Community mode
only to an Administrator, so the bot asks for that one permission and leaves the server at the end of the run.

1. Make the bot: [discord.com/developers/applications](https://discord.com/developers/applications), New
   Application, name it `GenClass setup`. On its Bot page untick Public Bot, then Reset Token and copy the token
   (it is shown once; it needs no privileged intents).
2. A dry run, from the repository root:
   ```bash
   DISCORD_BOT_TOKEN=... node scripts/discord-setup.mjs --dry-run
   ```
   The bot is in no server yet, so this prints the link that adds it. Open the link, pick the GenClass server (the
   one `discord.gg/kN9kRnFtZm` opens; the script checks that they match), Authorize, and run the dry run again:
   it lists every change it would make and changes nothing.
3. Apply it:
   ```bash
   DISCORD_BOT_TOKEN=... node scripts/discord-setup.mjs
   ```
   It reads and checks everything first and starts changing things only when every check passed; then it prints
   what it changed, what it found that is not in the layout (kept: nothing is ever deleted) and the remaining
   steps. The GitHub webhook is added to the repository with `gh` (issues, pull requests, releases); without `gh`
   signed in as a repository admin, the output has the webhook URL and the steps for the repository's settings.
4. Reset the bot's token (or delete the application) in the developer portal, unless the script will run again
   soon.

Running it again changes only what differs: a new channel in `LAYOUT` is created, a changed topic or message is
edited in place, everything else is left alone. `--stay` keeps the bot in the server, `--guild <id>` names the
server when the bot is in several (or when the README's invite opens another server, which the script otherwise
refuses to set up), `--no-github` skips the `gh` step.

The script stops, before changing anything, when: the token is a user's, the bot lacks Administrator, a layout role
exists twice or sits above the bot's role, a layout channel name is taken by a channel of a kind Discord cannot
convert (a voice channel named `help`, say), or the README's invite opens another server. A refusal from Discord
after changes began stops the run with the reason; fixing the cause and running again finishes it.

## By hand

- Give people their roles (Server Settings, Members): Maintainer, Moderator, Contributor.
- If the output warns that the welcome screen or onboarding could not be set (Discord wants at least seven default
  channels, five that members can post in, and sometimes refuses from the API on a new server), set them in Server
  Settings, Onboarding: the welcome screen's five channels are in the table above, and the onboarding question is
  "Do you want a ping when a release ships?" with one answer that gives the Release pings role.
- Keep `discord.gg/kN9kRnFtZm`: it is the link in the READMEs and on the site. If it is ever revoked, the script
  makes a permanent invite to `#welcome` and names the files to update (`INVITE_FILES` in the script; the site in
  genclass-dev/genclass-site has the link too).
- A release: post in `#announcements` with `@Release pings` and Publish it, so the servers that follow the channel
  get it. Mark answered `#help` posts Solved and ideas taken on Planned, then Shipped.
- Moderation: AutoMod alerts land in `#mod-log`. A report comes by direct message to a Maintainer or Moderator, or
  by email to the Code of Conduct's contact. The Code of Conduct's enforcement guidelines apply.

## Not done

Server Discovery, a vanity URL and boosts are not part of the layout. The server is not a support contract:
answers come when someone is around, and the FAQ, the docs and GitHub Issues remain the written record.
