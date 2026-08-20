import { cotal } from "../src/plugin.js";

/** Boot the plugin the way its implementation is written.
 *
 *  `cotal` carries opencode's `Plugin` type, `(input: PluginInput, options?) => Promise<Hooks>`, but
 *  the implementation declares no parameters at all: it reads its whole configuration from the
 *  environment (`configFromEnv`), so a smoke that hands it a fabricated `PluginInput` would be
 *  asserting a structure nothing reads. The smokes boot it with no host input, and this is the one
 *  place that says so: the day the plugin starts reading `input`, this helper is what has to grow a
 *  real one, and every smoke picks the change up together. */
export const bootPlugin = cotal as () => ReturnType<typeof cotal>;
