// Subprocess entry for operation-space.smoke.ts: runs the SRC kernel (`runCli`) over one `scoped`
// command, because a classified failure ends the process. `--record <space>` records the operation's
// space before the command throws what its --fail value names.
// argv: the cotal words, e.g. `scoped --json --record s9 --fail bare`
import { Registry, type Command } from "@cotal-ai/core";
import { CommandFailure, jsonFlag, plainFlag, recordOperationSpace } from "@cotal-ai/workspace";
import { runCli } from "../src/command.js";

function fail(kind: unknown): void {
  if (kind === "bare") throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no matching participant");
  if (kind === "named") throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no matching participant", { target: { name: "x" } });
  if (kind === "own") throw new CommandFailure("refused", "CONFLICT", "another space answered", { target: { space: "other" } });
  if (kind === "none") throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no space is selected", { target: { space: null } });
  if (kind === "plain") throw new Error("socket closed mid-request");
}

const scoped: Command = {
  kind: "command",
  name: "scoped",
  summary: "a structured command that may record its resolved space",
  outputs: ["json", "plain"],
  flags: [jsonFlag, plainFlag, { name: "record", type: "string" }, { name: "fail", type: "string" }],
  run: async (args) => {
    if (typeof args.values.record === "string") recordOperationSpace(args.values.record);
    fail(args.values.fail);
  },
};

const registry = new Registry();
registry.register(scoped);
await runCli(registry, process.argv.slice(2));
