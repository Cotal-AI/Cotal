/**
 * Registers `private-core-hook.mjs` into the module resolution chain for THIS process only.
 *
 * Used as `node --import <this file>` (the harness injects it through NODE_OPTIONS so the suite's
 * own command line is unchanged). Separate from the hook itself because `module.register` must run
 * on the main thread while the hook runs on the loader thread.
 */
import { register } from "node:module";

register("./private-core-hook.mjs", import.meta.url);
