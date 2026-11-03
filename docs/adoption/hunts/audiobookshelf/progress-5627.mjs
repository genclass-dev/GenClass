// API-level check of the advplyr/audiobookshelf#5627 class (a stale playback session overwrites newer progress),
// without GenClass and without a browser. Not part of CI.
//
//   node docs/adoption/hunts/audiobookshelf/progress-5627.mjs [--title "Moon Song"] [--runs 3]
//
// Each run, on one book, as the same user from two devices (deviceInfo.deviceId "hunt-a" and "hunt-b"):
//   1. device A starts a session (POST /api/items/:id/play) and syncs currentTime 30 (POST /api/session/:id/sync)
//   2. device B starts its own session and syncs currentTime 90 (A's session stays open: startSession closes only
//      the same device's sessions)
//   3. device A, left open in another tab, closes its session with its last position, currentTime 30
//      (POST /api/session/:id/close with syncData, what PlayerHandler.sendCloseSession sends)
// then reads GET /api/me/progress/:id. "ROLLED BACK" = the stored position went from 90 back to 30.
// A control run (--control) closes A without syncData (what a close of a session that listened under 20 s sends).
// The seed's books are 2 s long, so the run passes `duration: 3600` in the sync payload (the field the client sends);
// the server takes it when present (PlaybackSessionManager.syncSession).

import { parseArgs } from "node:util";
import { api } from "./lib.mjs";

const { values: arg } = parseArgs({ options: { title: { type: "string", default: "Moon Song" }, runs: { type: "string", default: "3" }, control: { type: "boolean", default: false } } });
const a = await api();
const lib = await a.library();
const item = await a.itemByTitle(lib.id, arg.title);
if (!item) throw new Error(`no item titled ${arg.title}`);
const play = (deviceId) => a.post(`/api/items/${item.id}/play`, { deviceInfo: { deviceId, clientName: "hunt" }, forceDirectPlay: true, mediaPlayer: "html5", supportedMimeTypes: ["audio/mpeg"] });
const sync = (s, currentTime) => a.post(`/api/session/${s.id}/sync`, { currentTime, timeListened: 25, duration: 3600 });
const progress = async () => (await a.get(`/api/me/progress/${item.id}`)).currentTime;

const tally = { "ROLLED BACK": 0, KEPT: 0 };
for (let run = 1; run <= Number(arg.runs); run++) {
  const sA = await play("hunt-a");
  await sync(sA, 30);
  const afterA = await progress();
  const sB = await play("hunt-b");
  await sync(sB, 90);
  const afterB = await progress();
  await a.post(`/api/session/${sA.id}/close`, arg.control ? undefined : { currentTime: 30, timeListened: 25, duration: 3600 });
  const afterClose = await progress();
  await a.post(`/api/session/${sB.id}/close`);
  const verdict = afterB === 90 && afterClose === 30 ? "ROLLED BACK" : "KEPT";
  tally[verdict]++;
  console.log(`run ${run}${arg.control ? " (control)" : ""}: after A sync ${afterA}, after B sync ${afterB}, after A close ${afterClose} -> ${verdict}`);
}
console.log(JSON.stringify({ item: arg.title, control: arg.control, ...tally }));
