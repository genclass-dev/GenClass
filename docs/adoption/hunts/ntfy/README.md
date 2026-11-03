# ntfy hunt: harness and results

The report is [../ntfy.md](../ntfy.md). Every script's header says how to run it; all of them drive a local ntfy
started with ntfy's own `web/e2e/server.mjs` (see the report, section 1) and take the admin token it prints.

| file | what |
|---|---|
| `explore.mjs` | the hunt harness: GenClass injected from outside, explore sessions per surface (`prefs`, `prefs-twice`, `subscribe`, `unsubscribe`, `rename`, `reserve`) at 300, 600 and 900 ms; `GENCLASS=0` for the control, `GENCLASS=0 --hold 1` for the plain reproduction |
| `last-subscription.mjs` | finding 2 without GenClass: two browsers, unsubscribe from the last topic in one |
| `reserve-reload.mjs` | what the page shows after the reserved subscribe lost its messages, 10 s later and after a reload |
| `unsubscribe-delay.mjs` | two unsubscribes with every account response delayed in order (the fixed build's remaining window, report section 4.6) |
| `results/{unfixed,fixed}/{explore,control,hold}/*-summary.json` | one line per load: the oracle (browser IndexedDB next to the server), the sidebar's topic rows over time, the recorded delivery order of the account requests |
| `results/unfixed/explore/subscribe-300-first-session.txt`, `reserve-600.txt`, `results/fixed/explore/unsubscribe-900.txt` | the full explore reports, findings and `genclass_explain` output of the sessions the report quotes |

The page text in the result files is from local test accounts on a throwaway server (`user`/`hunt…` names, random
topic names); no credential is in them.
