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

async function completionOut(positionals: string[]): Promise<string> {
  let out = "";
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
  try {
    await complete({ values: {}, positionals, raw: positionals });
  } finally {
    process.stdout.write = realWrite;
  }
  return out;
}

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

// --- --help reaches rawArgs commands too (feedback), only __-internal is exempt -----------------
{
  const { runCli } = await import("../src/command.js");
  let out = "";
  const realLog = console.log;
  console.log = (s?: unknown) => void (out += `${s}\n`);
  try {
    await runCli(registry, ["feedback", "--help"]);
  } finally {
    console.log = realLog;
  }
  assert.ok(out.includes("usage:"), "feedback --help prints its usage");
  assert.ok(!out.includes("Unknown option"), "no usage error above the help");
}

// --- `-v` / `--version` print `cotal-ai <semver>` (+ any extensions) and short-circuit dispatch --
{
  const { runCli } = await import("../src/command.js");
  for (const flag of ["-v", "--version"]) {
    let out = "";
    const realLog = console.log;
    console.log = (s?: unknown) => void (out += `${s}\n`);
    try {
      await runCli(registry, [flag]);
    } finally {
      console.log = realLog;
    }
    // First line is always `cotal-ai <semver>`; any installed extensions follow indented (none in
    // a bare unit env). Reaching here at all proves it short-circuited before command dispatch.
    assert.match(out.split("\n")[0], /^cotal-ai \d+\.\d+\.\d+/, `${flag} prints the binary version`);
  }
}

// --- __complete offers declared flag names on a `-` prefix --------------------------------------
{
  const spawnCmd = registry.all<Command>("command").find((c) => c.name === "spawn");
  assert.ok(spawnCmd?.flags?.length, "spawn declares flags");
  const out = await completionOut(["spawn", "--"]);
  assert.ok(out.includes("--space"), "flag completion lists --space");
  assert.ok(out.includes("--config"), "flag completion lists --config");
  assert.ok(out.trimEnd().endsWith(":nofiles"), "directive is nofiles");
}

// --- exact commands and flags-before-positionals stay inside the command grammar -----------------
{
  const exactSend = await completionOut(["send"]);
  assert.ok(exactSend.includes("dm\tunicast to a peer"), "exact send completes send subcommands");
  assert.ok(!exactSend.includes("spawn\t"), "exact send does not fall back to top-level commands");

  const flaggedSend = await completionOut(["send", "--space", "demo", ""]);
  assert.ok(flaggedSend.includes("msg\tbroadcast to a channel"), "flags before send subcommands are ignored");
  assert.ok(!flaggedSend.includes("spawn\t"), "flagged send does not fall back to top-level commands");

  const flaggedPersonas = await completionOut(["personas", "--space", "demo", ""]);
  assert.ok(flaggedPersonas.includes("show\tprint a persona's card"), "flags before personas subcommands are ignored");

  const exactUp = await completionOut(["up"]);
  assert.ok(exactUp.includes("--space"), "exact flag-only commands offer their flags");
  assert.ok(!exactUp.includes("setup\t"), "exact flag-only commands do not fall back to top-level commands");

  const exactAttach = await completionOut(["attach", ""]);
  assert.ok(exactAttach.includes("--name"), "attach with an empty next word offers flags");

  const attachName = await completionOut(["attach", "--name", ""]);
  assert.ok(!attachName.includes("--space"), "attach --name value completion does not fall back to flags");
  assert.ok(attachName.trimEnd().endsWith(":nofiles"), "attach --name suppresses filename fallback");
}

console.log("✓ command-kernel smoke passed");
