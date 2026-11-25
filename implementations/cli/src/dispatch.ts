import type { RunCliOptions, runCli as dispatch } from "./command.js";
import { asksForHelp, leadingInvocation } from "./lib/leading-flags.js";

/** The dispatcher without the command surface. `@cotal-ai/cli` registers every base command when it
 *  is imported; a composition root that has loaded only the commands one process runs reads the
 *  command word with `commandWord` and dispatches with `runCli` from here instead, so none of the
 *  others load. Importing this module loads no command and not the dispatcher itself. */
export { commandWord } from "./lib/leading-flags.js";
export { completeFileWrites, ownStdoutErrors, stdoutError } from "./lib/stdout-owner.js";

interface DispatchOptions extends RunCliOptions {
  /** @internal Lets the binary install its notice and load only the selected command surfaces. */
  prepare?: (command: string | undefined, help: boolean) => Promise<void>;
}

export async function runCli(registry: Parameters<typeof dispatch>[0], argv: string[], opts?: DispatchOptions): ReturnType<typeof dispatch> {
  if (opts?.prepare) {
    const { original, word, args } = leadingInvocation(argv);
    await opts.prepare(original, word === "help" || asksForHelp(args));
  }
  return (await import("./command.js")).runCli(registry, argv, opts);
}
