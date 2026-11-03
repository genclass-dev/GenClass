// Seeds a local Grafana for the admin-list race hunt (docs/adoption/hunts/grafana-panel-refresh.md). Not part of CI.
//
//   node docs/adoption/hunts/grafana-panel-refresh/seed.mjs [--grafana http://localhost:3000] [--password admin]
//
// Creates, through Grafana's HTTP API with basic auth as admin (a local instance only):
//   160 users (POST /api/admin/users), added to the main org by Grafana's default auto_assign_org: 4 pages on
//       /admin/users (50 per page) and 6 on /org/users (30 per page);
//   120 service accounts (POST /api/serviceaccounts): 3 pages on /org/serviceaccounts (50 per page);
//   a TestData data source and a two-panel dashboard (uid "hunt-refresh") for the panel-refresh negative control;
//   an email contact point "hunt-email" for the contact-point negative control.
// Names are built from letters only (adjective-noun pairs), because explore blanks every token holding a digit when it
// compares page lines: two pages of "user012"-style names would look the same to it. Idempotent: existing names are
// skipped.

import { parseArgs } from "node:util";

const { values: arg } = parseArgs({
  options: {
    grafana: { type: "string", default: "http://localhost:3000" },
    password: { type: "string", default: "admin" },
  },
});
const G = arg.grafana.replace(/\/+$/, "");
const auth = `Basic ${Buffer.from(`admin:${arg.password}`).toString("base64")}`;

export const ADJECTIVES = ["amber", "brisk", "cedar", "dusky", "eager", "fancy", "gentle", "hazel", "ivory", "jolly", "keen", "lunar", "mellow", "noble", "olive", "prime"];
export const NOUNS = ["falcon", "heron", "otter", "badger", "lynx", "marten", "osprey", "plover", "raven", "stoat"];

async function api(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${G}${path}`, {
    method,
    headers: { authorization: auth, "content-type": "application/json", accept: "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const counts = { users: 0, usersSkipped: 0, serviceAccounts: 0, serviceAccountsSkipped: 0 };
for (const a of ADJECTIVES) {
  for (const n of NOUNS) {
    const login = `${a}-${n}`;
    const r = await api("POST", "/api/admin/users", {
      name: `${a[0].toUpperCase()}${a.slice(1)} ${n[0].toUpperCase()}${n.slice(1)}`,
      email: `${a}.${n}@example.com`,
      login,
      password: `hunt-${login}-password`,
    });
    if (r.status === 200) counts.users++;
    else if (r.status === 412 || r.status === 409) counts.usersSkipped++;
    else throw new Error(`POST /api/admin/users ${login}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  }
}
for (const a of ADJECTIVES.slice(0, 12)) {
  for (const n of NOUNS) {
    const name = `svc ${a} ${n}`;
    const r = await api("POST", "/api/serviceaccounts", { name, role: "Viewer", isDisabled: false });
    if (r.status === 201 || r.status === 200) counts.serviceAccounts++;
    else if (r.status === 409 || r.status === 400) counts.serviceAccountsSkipped++;
    else throw new Error(`POST /api/serviceaccounts ${name}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  }
}

// negative controls: a TestData data source, a dashboard with two deterministic panels, a contact point
let ds = await api("GET", "/api/datasources/name/TestData");
if (ds.status !== 200) {
  ds = await api("POST", "/api/datasources", { name: "TestData", type: "grafana-testdata-datasource", access: "proxy", isDefault: true });
  if (ds.status !== 200) throw new Error(`POST /api/datasources: HTTP ${ds.status} ${JSON.stringify(ds.body)}`);
  ds = { body: ds.body.datasource };
}
const dsRef = { type: "grafana-testdata-datasource", uid: ds.body.uid };
const panel = (id, title, csv, x) => ({
  id,
  type: "stat",
  title,
  gridPos: { h: 6, w: 8, x, y: 0 },
  datasource: dsRef,
  targets: [{ refId: "A", datasource: dsRef, scenarioId: "csv_metric_values", stringInput: csv, alias: title }],
  options: { reduceOptions: { calcs: ["lastNotNull"] }, textMode: "value_and_name" },
});
const dash = await api("POST", "/api/dashboards/db", {
  overwrite: true,
  dashboard: {
    uid: "hunt-refresh",
    title: "Hunt refresh",
    schemaVersion: 39,
    time: { from: "now-1h", to: "now" },
    panels: [panel(1, "Alpha load", "1,20,90,30,5", 0), panel(2, "Bravo load", "7,3,11,2,4", 8)],
  },
});
if (dash.status !== 200) throw new Error(`POST /api/dashboards/db: HTTP ${dash.status} ${JSON.stringify(dash.body)}`);

const cps = await api("GET", "/api/v1/provisioning/contact-points?name=hunt-email");
if (!(Array.isArray(cps.body) && cps.body.length)) {
  const cp = await api("POST", "/api/v1/provisioning/contact-points", {
    name: "hunt-email",
    type: "email",
    settings: { addresses: "hunt@example.com" },
  }, { "X-Disable-Provenance": "true" }); // editable in the UI, like a contact point made there
  if (![200, 202].includes(cp.status)) throw new Error(`POST contact point: HTTP ${cp.status} ${JSON.stringify(cp.body)}`);
}

const search = await api("GET", "/api/users/search?perpage=1&page=1");
const sas = await api("GET", "/api/serviceaccounts/search?perpage=1&page=1");
const org = await api("GET", "/api/org/users/search?perpage=1&page=1");
console.log(
  JSON.stringify(
    { ...counts, totalUsers: search.body.totalCount, totalServiceAccounts: sas.body.totalCount, orgUsers: org.body.totalCount, dashboard: dash.body.url },
    null,
    2,
  ),
);
