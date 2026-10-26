import type { runCli as dispatch } from "./command.js";

/** The dispatcher without the command surface. `@cotal-ai/cli` registers every base command when it
 *  is imported; a composition root that has loaded only the commands one process runs reads the
 *  command word with `commandWord` and dispatches with `runCli` from here instead, so none of the
 *  others load. Importing this module loads no command and not the dispatcher itself: `runCli`
 *  imports it when called, after the root has imported the commands it chose. */
export { commandWord } from "./lib/leading-flags.js";
export { stdoutError } from "./lib/stdout-owner.js";

export async function runCli(...args: Parameters<typeof dispatch>): ReturnType<typeof dispatch> {
  return (await import("./command.js")).runCli(...args);
}
