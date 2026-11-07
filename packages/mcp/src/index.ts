// @genclass/mcp: GenClass for coding agents (docs/runtime/AGENT.md). The command (bin/genclass-mcp.mjs) is what agents
// run; these exports are for embedding the bridge in another tool and for tests.

export { Store, mergeOrder, replaySpecOf, capsNeeded, MAX_PROBES } from "./store.js";
export type { StoreOptions, FindingEvent, MinimizeResult, ProbeResult } from "./store.js";
export { sequenceCover, buildCover, MAX_PERMUTED } from "./cover.js";
export type { SequenceCover, Cover, CoverInput } from "./cover.js";
export { overlapOf, inversionsOf, schedulable, startOrderOf, deliveryRanks, deliveredBefore, MAX_PAIRS } from "./net.js";
export { startBridge, probeBridge, callBridge, devOrigin, VERSION } from "./http.js";
export type { Bridge, BridgeOptions } from "./http.js";
export { makeApi, analytics } from "./api.js";
export type { Api } from "./api.js";
export { McpServer, PROTOCOL_VERSIONS } from "./mcp.js";
export { TOOLS, INSTRUCTIONS, callTool, setupText } from "./tools.js";
export { CLIENTS, clientFor, clientById, installMarkdown, serverConfig, hookCommand, pinned, cursorLink, cursorWebLink, vscodeLink, vscodeWebLink, gooseLink } from "./clients.js";
export type { ClientInstall } from "./clients.js";
export { serve, channelEvent } from "./server.js";
export { compareRuns, coverageOf, groupRuns, nameDifference, reorderedOf, sameScenario, sameValue, scenarioOf, shownField, strongestFirst } from "./compare.js";
export type { Coverage, GroupReport, RunDiff, FieldDiff, Grouping, Tier } from "./compare.js";
export { regressionTest, locator, actionLines, parseTarget } from "./testgen.js";
export { ageless, agesIn, clean, fieldShape, q, routeShape, sameAges } from "./text.js";
export * from "./types.js";
