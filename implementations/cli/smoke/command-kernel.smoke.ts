/**
 * Pure smoke for the command kernel (no NATS, no fs): parseCommandArgs semantics —
 * strict flags, shorts, positional gating, rawArgs passthrough — plus commandUsage
 * generation and the dispatcher's flag-name completion. Run: pnpm smoke:cli-kernel
 */
import assert from "node:assert/strict";
import { commandUsage, parseCommandArgs, registry, type Command } from "@cotal-ai/core";
import "../src/index.js"; // self-register the CLI commands (for the completion check)
import { complete } from "../src/commands/completion.js";

const noop = async (): Promise<void> => {};

// --- flags parse strictly: strings, booleans, shorts -------------------------------------------
{
  const cmd: Command = {
    kind: "command",
    name: "t",
    summary: "t",
    positionals: "<x>",
    flags: [
      { name: "space", type: "string" },
      { name: "dry-run", type: "boolean" },
      { name: "file", type: "string", short: "f" },
    ],
    run: noop,
  };
  const a = parseCommandArgs(cmd, ["pos1", "--space", "demo", "--dry-run", "-f", "m.yaml", "pos2"]);
  assert.equal(a.values.space, "demo");
  assert.equal(a.values["dry-run"], true);
  assert.equal(a.values.file, "m.yaml");
  assert.deepEqual(a.positionals, ["pos1", "pos2"]);
  assert.deepEqual(a.raw, ["pos1", "--space", "demo", "--dry-run", "-f", "m.yaml", "pos2"]);

  // Unknown flag → ERR_PARSE_ARGS (the dispatcher renders it as a usage error).
  assert.throws(
    () => parseCommandArgs(cmd, ["--nope"]),
    (e: unknown) => String((e as { code?: string }).code).startsWith("ERR_PARSE_ARGS"),
  );
}

// --- a command with no declared positionals rejects strays --------------------------------------
{
  const cmd: Command = { kind: "command", name: "t2", summary: "t", flags: [{ name: "space", type: "string" }], run: noop };
  assert.throws(
    () => parseCommandArgs(cmd, ["stray"]),
    (e: unknown) => String((e as { code?: string }).code).startsWith("ERR_PARSE_ARGS"),
  );
  const a = parseCommandArgs(cmd, ["--space", "demo"]);
  assert.deepEqual(a.positionals, []);
}

// --- rawArgs: verbatim passthrough, flags of OTHER commands never throw -------------------------
{
  const cmd: Command = { kind: "command", name: "t3", summary: "t", rawArgs: true, positionals: "<w…>", run: noop };
  const a = parseCommandArgs(cmd, ["spawn", "--space", ""]);
  assert.deepEqual(a.positionals, ["spawn", "--space", ""]);
  assert.deepEqual(a.values, {});
}

// --- commandUsage: generated line + explicit override -------------------------------------------
{
  const gen: Command = {
    kind: "command",
    name: "t4",
    summary: "t",
    positionals: "<name>",
    flags: [
      { name: "out", type: "string", value: "<path>" },
      { name: "force", type: "boolean" },
      { name: "file", type: "string", short: "f" },
    ],
    run: noop,
  };
  assert.equal(commandUsage(gen), "cotal t4 <name> [--out <path>] [--force] [-f|--file <value>]");
  const over: Command = { ...gen, usage: "custom usage" };
  assert.equal(commandUsage(over), "custom usage");
}

// --- __complete offers declared flag names on a `-` prefix --------------------------------------
{
  const spawnCmd = registry.all<Command>("command").find((c) => c.name === "spawn");
  assert.ok(spawnCmd?.flags?.length, "spawn declares flags");
  let out = "";
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
  try {
    await complete({ values: {}, positionals: ["spawn", "--"], raw: ["spawn", "--"] });
  } finally {
    process.stdout.write = realWrite;
  }
  assert.ok(out.includes("--space"), "flag completion lists --space");
  assert.ok(out.includes("--config"), "flag completion lists --config");
  assert.ok(out.trimEnd().endsWith(":nofiles"), "directive is nofiles");
}

console.log("✓ command-kernel smoke passed");
