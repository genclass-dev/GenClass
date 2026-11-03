# Race hunts on open-source projects

Evidence-backed contributions: a popular project's app is run locally, `@genclass/mcp`'s explore reorders its
responses, and a race it finds is reproduced, fixed and covered by a regression test in the project's own style, for
the project's maintainers to take or leave. One report per target; nothing here is sent anywhere by itself.

| target | report | patch and draft text | harness |
|---|---|---|---|
| Strapi admin panel (5.59.0) | [strapi.md](strapi.md) | [strapi.patch](strapi.patch), [strapi-issue.md](strapi-issue.md) | [strapi/](strapi/) |
| Keystone Admin UI (`@keystone-6/core` 8.3.0, `main` at 88da2cc): Enter pressed twice on a create page creates the item twice | [keystone-admin-ui.md](keystone-admin-ui.md) | [keystone-admin-ui.patch](keystone-admin-ui.patch), [keystone-admin-ui-issue.md](keystone-admin-ui-issue.md) | [keystone-admin-ui/](keystone-admin-ui/) |

Every report gives the versions and commits, the exact commands, every scenario with its verdict including the
negatives, the finding with its evidence in causal order, the root cause, the fix, the test result, the check on the
fixed variant, the problems hit with GenClass itself, and the time spent.
