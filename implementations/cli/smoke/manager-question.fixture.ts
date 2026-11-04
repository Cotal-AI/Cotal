// Subprocess entry for command-kernel.smoke.ts: asks the SRC manager question over a refused
// selection whose roster read is itself refused, so the smoke reads what the question writes to
// stderr. The smoke closes this process's input, which ends the question as Ctrl-C does.
// argv: the selection refusal's message, then the roster refusal's message and remedy
import { CommandFailure } from "@cotal-ai/workspace";
import { pickManager } from "../src/lib/manager-choice.js";

const [selection, message, remedy] = process.argv.slice(2);
await pickManager(
  new CommandFailure("refused", "PERMISSION_DENIED", selection!),
  async () => { throw new CommandFailure("refused", "PERMISSION_DENIED", message!, { remedy: remedy! }); },
  ["ps"],
);
