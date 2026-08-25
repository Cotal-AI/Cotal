/** The plugin *bundle* entry (esbuild → `dist/plugin.bundle.js`). OpenCode's loader treats every
 *  export of a plugin module as a plugin factory and calls it, so the bundle must export exactly
 *  one symbol: the plugin. The log-marker constants stay exported from `./plugin.ts` for the
 *  smokes, which import the source — they must never reach this surface. */
export { cotal } from "./plugin.js";
