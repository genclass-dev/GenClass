# Race hunts on open-source projects

Evidence-backed contributions: a popular project's app is run locally, `@genclass/mcp`'s explore reorders its
responses, and a race it finds is reproduced, fixed and covered by a regression test in the project's own style, for
the project's maintainers to take or leave. One report per target; nothing here is sent anywhere by itself.

| target | report | patch and draft text | harness |
|---|---|---|---|
| Strapi admin panel (5.59.0) | [strapi.md](strapi.md) | [strapi.patch](strapi.patch), [strapi-issue.md](strapi-issue.md) | [strapi/](strapi/) |
| Jellyfin Web (13.0.0, legacy layout; no draft prose: the project bans LLM-written issue and PR text) | [jellyfin-web.md](jellyfin-web.md) | [jellyfin-web.patch](jellyfin-web.patch) (reference), [jellyfin-web-facts.md](jellyfin-web-facts.md) | [jellyfin-web/](jellyfin-web/) |

Every report gives the versions and commits, the exact commands, every scenario with its verdict including the
negatives, the finding with its evidence in causal order, the root cause, the fix, the test result, the check on the
fixed variant, the problems hit with GenClass itself, and the time spent.
