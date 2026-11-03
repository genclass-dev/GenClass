// Type conformance of opencode-genclass's built default export against the published plugin APIs, without casts:
// OpenCode passes its own input and context types, so each must be assignable to what the plugin declares.
import plugin from "./dist/index.js";
import type { PluginModule, Plugin as V1Plugin, Hooks } from "@opencode-ai/plugin";
import { Plugin } from "@opencode/plugin";

// V1 (@opencode-ai/plugin 1.19.5): `server` is a V1 Plugin, and the whole object is a PluginModule
const server: V1Plugin = plugin.server;
const v1: PluginModule = { id: plugin.id, server: plugin.server };
// the hooks it returns are V1 Hooks
const hooks = async (): Promise<Hooks> => plugin.server({} as Parameters<V1Plugin>[0]);
// V2 (@opencode/plugin 2.2.5): Plugin.define accepts { id, setup }
const v2: Plugin.Plugin = Plugin.define({ id: plugin.id, setup: plugin.setup });
const whole: Plugin.Plugin = plugin;
export { server, v1, hooks, v2, whole };
