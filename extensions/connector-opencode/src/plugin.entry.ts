/**
 * The plugin *bundle* entry (esbuild → `dist/plugin/index.js`, a DIRECTORY target). One directory
 * loads on both OpenCode lines: 1.x calls `default.server(input)` and nothing else; 2.x calls
 * `default.setup(context)` and nothing else (measured in `fx105/measurements.md`). Named exports
 * are deliberately absent — the 1.x loader treats each one as a plugin factory, so a bundle that
 * exported anything beside `default` would be loaded twice over.
 */
import { cotal } from "./plugin.js";
import { setupCotal } from "./plugin2.js";
export default { id: "cotal", server: cotal, setup: setupCotal };
