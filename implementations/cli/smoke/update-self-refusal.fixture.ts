// Runs the real update handler through the command kernel with a pure preflight refusal.
import { Registry, type Command } from "@cotal-ai/core";
import { CommandFailure } from "@cotal-ai/workspace";
import { runCli } from "../src/command.js";
import { update, updateFlags, updateRuntime, validateUpdateArguments } from "../src/commands/update.js";
const kind = process.env.UPDATE_REFUSAL_FIXTURE;
const registry = new Registry();
const command: Command = {
  kind: "command", name: "update", summary: "update refusal fixture", flags: updateFlags,
  outputs: ["json", "plain"], positionals: "[off|on]", prepareMeshTarget: false, validate: validateUpdateArguments,
  run: args => update(args, {
    ...updateRuntime,
    preflightExecution() {
      if (kind === "classified") throw new CommandFailure("refused", "UNSUPPORTED", "fixture unsupported installation", { remedy: "use the owning installer" });
      throw new Error("installation is not writable; use the owning command: npm install -g --prefix /fixture cotal-ai@latest");
    },
  }),
};
registry.register(command);
await runCli(registry, process.argv.slice(2));
