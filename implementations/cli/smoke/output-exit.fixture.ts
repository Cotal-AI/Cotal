// Subprocess entry for output-exit.smoke.ts: runs the SRC kernel (`runCli`) over a registry holding
// probe commands, because a classified failure ends the process. `probe` declares a JSON output;
// `legacy` declares none. Each throws what its --fail value names.
// argv: the cotal words, e.g. `probe --json --fail conflict`
import { Registry, type Command } from "@cotal-ai/core";
import { CommandFailure, ConnectRefusal, MeshTargetError, inputDisabledByFlag, jsonFlag, writeEnvelope } from "@cotal-ai/workspace";
import { runCli } from "../src/command.js";
import { CatalogPreparationError } from "../src/commands/sync.js";

function fail(kind: unknown): void {
  if (kind === "conflict")
    throw new CommandFailure("refused", "CONFLICT", "the lease is held", {
      remedy: "wait for the holder to release it",
      native: { code: "E_LEASE", outcome: "not-executed" },
      target: { space: "s1" },
    });
  if (kind === "usage") throw new CommandFailure("refused", "USAGE_INVALID", "two targets named");
  if (kind === "partial") throw new CommandFailure("partial", "OPERATION_PARTIAL", "one of two stopped", { changed: [{ seat: "a" }] });
  if (kind === "failed") throw new CommandFailure("failed", "OPERATION_FAILED", "nothing stopped");
  if (kind === "plain") throw new Error("socket closed mid-request");
  if (kind === "refusal") throw new ConnectRefusal("✗ can't reach a broker at nats://127.0.0.1:1", "  start it with `cotal up`", { code: "TARGET_UNAVAILABLE", kind: "transient" });
  if (kind === "target") throw new MeshTargetError("ambiguous-target", "two meshes", { available: ["a (/a)", "b (/b)"] });
  if (kind === "catalog") throw new CatalogPreparationError("space catalog for https://idp.example failed: HTTP 503", "DEPENDENCY_UNAVAILABLE");
}

const probe: Command = {
  kind: "command",
  name: "probe",
  summary: "a structured probe",
  outputs: ["json"],
  flags: [jsonFlag, { name: "all", short: "a", type: "boolean" }, { name: "fail", type: "string" }],
  run: async (args) => {
    fail(args.values.fail);
    if (args.values.json) writeEnvelope({ schemaVersion: 1, command: "probe", target: null, outcome: "ok", completeness: "complete", result: { ran: true, input: !inputDisabledByFlag() }, warnings: [] });
    else console.log(`ran input:${!inputDisabledByFlag()}`);
  },
};

const legacy: Command = {
  kind: "command",
  name: "legacy",
  summary: "a probe with no structured output",
  flags: [{ name: "fail", type: "string" }],
  run: async (args) => {
    fail(args.values.fail);
    console.log("ran");
  },
};

// `shadow` declares the global --no-color, so it is registered only when the run asks for it: the
// kernel refuses every command while one is on the surface.
const shadow: Command = {
  kind: "command",
  name: "shadow",
  summary: "a probe that declares a global flag",
  flags: [{ name: "no-color", type: "string" }],
  run: async (args) => console.log(`ran ${JSON.stringify(args.values)}`),
};

const registry = new Registry();
registry.register(probe, legacy);
if (process.env.OUTPUT_EXIT_SHADOW === "1") registry.register(shadow);
await runCli(registry, process.argv.slice(2));
