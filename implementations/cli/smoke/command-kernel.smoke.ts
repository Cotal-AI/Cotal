/**
 * Broker-free smoke for the command kernel: parseCommandArgs semantics —
 * strict flags, shorts, positional gating, rawArgs passthrough — plus commandUsage
 * generation and the dispatcher's flag-name completion. Run: pnpm smoke:cli-kernel
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandUsage, parseCommandArgs, registry, type Command } from "@cotal-ai/core";
import type { InstalledExtension } from "@cotal-ai/workspace";
import "../src/index.js"; // self-register the CLI commands (for the completion check)
import { complete } from "../src/commands/completion.js";
import { EXT_UPDATE_PARENT_ENV, ext } from "../src/commands/ext.js";
import { executeUpdate, parseNpmVersion, update, verifyGlobalEntry, type UpdateRuntime } from "../src/commands/update.js";
import { claimExtensionMutation, claimExtensionUpdatePass } from "../src/lib/ext-mutation.js";
import { compareSemver } from "../src/seed/reconcile.js";

const noop = async (): Promise<void> => {};

function installed(pkg: string, version = "0.13.1", spec = pkg): InstalledExtension {
  return { pkg, version, spec, commands: [] };
}

function updateRuntime(opts: {
  version?: string;
  extensions?: InstalledExtension[];
  env?: NodeJS.ProcessEnv;
  npm?: (args: string[], inherit?: boolean) => { status: number | null; stdout?: string; stderr?: string; error?: string };
  spawn?: (file: string, args: string[], env: NodeJS.ProcessEnv) => { status: number | null; stdout?: string; stderr?: string; error?: string };
}) {
  const events: string[] = [];
  const rt: UpdateRuntime = {
    env: opts.env ?? {},
    pid: 101,
    parentPid: 99,
    nodePath: "/node",
    version: () => opts.version ?? "0.13.1",
    reconcile: async () => void events.push("reconcile"),
    extensions: () => opts.extensions ?? [],
    claimUpdatePass: () => {
      events.push("claim-mutation");
      return () => void events.push("release-mutation");
    },
    claimGlobalUpdate: (root) => {
      events.push(`claim-global:${root}`);
      return () => void events.push(`release-global:${root}`);
    },
    selfArgv: () => ["/node", "/old/cotal.js"],
    npm: (args, inherit) => {
      events.push(`npm:${args.join(" ")}${inherit ? ":inherit" : ""}`);
      const r = opts.npm?.(args, inherit) ?? { status: 0, stdout: '"0.13.1"' };
      return { stdout: "", stderr: "", ...r };
    },
    spawn: (file, args, env) => {
      events.push(`spawn:${file} ${args.join(" ")}`);
      const r = opts.spawn?.(file, args, env) ?? { status: 0 };
      return { stdout: "", stderr: "", ...r };
    },
    spawnGlobal: async (root, operation, file, args, env) => {
      events.push(`global:${operation}:${root}:${file} ${args.join(" ")}`);
      const r = operation === "reconcile" ? (opts.spawn?.(file, args, env) ?? { status: 0 }) : { status: 0 };
      return { stdout: "", stderr: "", ...r };
    },
    verifyGlobalEntry: (root, version) => {
      events.push(`verify:${root}:${version}`);
      return `${root}/cotal-ai/dist/cotal.js`;
    },
    out: (message) => void events.push(`out:${message}`),
    err: (message) => void events.push(`err:${message}`),
    stdout: (message) => void events.push(`stdout:${message}`),
    stderr: (message) => void events.push(`stderr:${message}`),
  };
  return { rt, events };
}

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

// --- update grammar: registered in Setup, exactly one public flag --------------------------------
{
  const cmd = registry.all<Command>("command").find((candidate) => candidate.name === "update");
  assert.equal(cmd?.group, "Setup");
  assert.deepEqual(cmd?.flags?.map((flag) => flag.name), ["self"]);
  assert.equal(parseCommandArgs(cmd!, ["--self"]).values.self, true);
  assert.throws(
    () => parseCommandArgs(cmd!, ["--unknown"]),
    (e: unknown) => String((e as { code?: string }).code).startsWith("ERR_PARSE_ARGS"),
  );
}

// --- update decisions: full SemVer, coherent first-party replay, report-only third-party ----------
{
  assert.ok(compareSemver("0.13.10", "0.13.9") > 0);
  assert.ok(compareSemver("0.13.2", "0.13.2-rc.1") > 0);
  assert.equal(parseNpmVersion('"0.13.2-rc.1"'), "0.13.2-rc.1");
  assert.throws(() => parseNpmVersion('"0.13"'), /invalid cotal-ai version/);
  assert.throws(() => parseNpmVersion('["0.13.1","0.13.2"]'), /invalid cotal-ai version/);

  const { rt, events } = updateRuntime({
    extensions: [
      installed("@cotal-ai/orca", "0.12.0", "@cotal-ai/orca"),
      installed("@cotal-ai/web", "0.12.0", "@cotal-ai/web"),
      installed("third-party-ext", "1.2.3", "third-party-ext@^1"),
    ],
    npm: (args) => ({ status: 0, stdout: args[0] === "view" ? '"0.13.2"' : "" }),
  });
  assert.equal(await executeUpdate(false, rt), 0);
  const replay = events.find((event) => event.startsWith("spawn:"));
  assert.ok(replay?.includes("ext __update-add @cotal-ai/orca @cotal-ai/orca@0.13.1"));
  assert.equal(events.filter((event) => event.startsWith("spawn:")).length, 1, "seeded web + third-party extension are not operator-replayed");
  assert.ok(
    !events.some((event) => event.startsWith("spawn:") && event.includes("@cotal-ai/web")),
    "the seeded web dashboard is reconciled by the seed pass, never operator-replayed from npm",
  );
  assert.ok(events.some((event) => event.includes("third-party-ext@1.2.3 - not auto-updated")));
  assert.ok(events.indexOf("reconcile") < events.findIndex((event) => event.startsWith("npm:view")), "default reconciles before npm check");
}

// --- malformed npm fails after local reconcile; extension failures continue and aggregate --------
{
  const malformed = updateRuntime({ npm: () => ({ status: 0, stdout: "not-json" }) });
  assert.equal(await executeUpdate(false, malformed.rt), 1);
  assert.ok(malformed.events.includes("reconcile"));

  const attempted: string[] = [];
  const continued = updateRuntime({
    extensions: [installed("@cotal-ai/orca"), installed("@cotal-ai/cmux")],
    spawn: (_file, args) => {
      attempted.push(args[args.indexOf("__update-add") + 1]);
      return args.includes("@cotal-ai/orca") ? { status: 1, stderr: "orca failed" } : { status: 0 };
    },
  });
  assert.equal(await executeUpdate(false, continued.rt), 1);
  assert.deepEqual(attempted, ["@cotal-ai/orca", "@cotal-ai/cmux"]);

  const abnormalAttempts: string[] = [];
  const abnormal = updateRuntime({
    extensions: [installed("@cotal-ai/orca"), installed("@cotal-ai/cmux")],
    spawn: (_file, args) => {
      abnormalAttempts.push(args[args.indexOf("__update-add") + 1]);
      return { status: null, error: "wrapper terminated" };
    },
  });
  assert.equal(await executeUpdate(false, abnormal.rt), 1);
  assert.deepEqual(abnormalAttempts, ["@cotal-ai/orca"], "abnormal wrapper death aborts later replays");

  const stopped = updateRuntime({ extensions: [installed("@cotal-ai/orca")] });
  stopped.rt.reconcile = async () => { throw new Error("seed interrupted"); };
  assert.equal(await executeUpdate(false, stopped.rt), 1);
  assert.ok(!stopped.events.some((event) => event.startsWith("spawn:")), "seed failure blocks later prefix mutation");
}

// --- one mutation claim linearizes the whole operator pass through the default npm check ----------
{
  const priorXdg = process.env.XDG_CONFIG_HOME;
  const xdg = mkdtempSync(join(tmpdir(), "cotal-update-lock-"));
  process.env.XDG_CONFIG_HOME = xdg;
  let blocked = 0;
  try {
    const concurrent = updateRuntime({
      extensions: [installed("@cotal-ai/orca")],
      spawn: () => {
        assert.throws(() => claimExtensionMutation(), /another extension update or mutation is in progress/);
        blocked++;
        return { status: 0 };
      },
      npm: () => {
        assert.throws(() => claimExtensionMutation(), /another extension update or mutation is in progress/);
        blocked++;
        return { status: 0, stdout: '"0.13.1"' };
      },
    });
    concurrent.rt.claimUpdatePass = claimExtensionUpdatePass;
    assert.equal(await executeUpdate(false, concurrent.rt), 0);
    assert.equal(blocked, 2, "concurrent mutations are excluded during replay and metadata check");
    const after = claimExtensionMutation();
    after();
  } finally {
    rmSync(xdg, { recursive: true, force: true });
    if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorXdg;
  }
}

// --- --self: exact checked artifact, alternate global root, verified child, status propagation ----
{
  const successful = updateRuntime({
    npm: (args) => {
      if (args[0] === "view") return { status: 0, stdout: '"0.13.2"' };
      if (args[0] === "root") return { status: 0, stdout: "/alternate/global/node_modules\n" };
      return { status: 0 };
    },
  });
  assert.equal(await executeUpdate(true, successful.rt), 0);
  assert.ok(successful.events.some((event) => event.includes("global:install:/alternate/global/node_modules:") && event.includes("install -g cotal-ai@0.13.2")));
  assert.ok(successful.events.includes("claim-global:/alternate/global/node_modules"));
  const installEvent = successful.events.findIndex((event) => event.startsWith("global:install:"));
  const reconcileEvent = successful.events.findIndex((event) => event.startsWith("global:reconcile:"));
  assert.ok(successful.events.indexOf("claim-global:/alternate/global/node_modules") < installEvent);
  assert.ok(reconcileEvent < successful.events.indexOf("release-global:/alternate/global/node_modules"));
  assert.ok(successful.events.includes("verify:/alternate/global/node_modules:0.13.2"));
  assert.ok(successful.events.some((event) => event.includes("global:reconcile:/alternate/global/node_modules:/node /alternate/global/node_modules/cotal-ai/dist/cotal.js update")));
  assert.ok(successful.events.some((event) => event.includes("npm's global installation") && event.includes("process remains loaded")));
  assert.ok(!successful.events.includes("reconcile"), "old generation is not reconciled before self-upgrade");

  const failedChild = updateRuntime({
    npm: (args) => args[0] === "view"
      ? { status: 0, stdout: '"0.13.2"' }
      : args[0] === "root"
        ? { status: 0, stdout: "/global/node_modules" }
        : { status: 0 },
    spawn: () => ({ status: 7, stderr: "child failed" }),
  });
  assert.equal(await executeUpdate(true, failedChild.rt), 7);
  const priorExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await update({ values: { self: true }, positionals: [], raw: ["--self"] }, failedChild.rt);
    assert.equal(process.exitCode, 7, "the global child status reaches the top-level process exit code");
  } finally {
    process.exitCode = priorExitCode;
  }
}

// The exact global package root is verified before re-exec; a mismatched install is refused.
{
  const root = mkdtempSync(join(tmpdir(), "cotal-update-global-"));
  const pkg = join(root, "cotal-ai");
  try {
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "dist", "cotal.js"), "#!/usr/bin/env node\n");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "cotal-ai", version: "0.13.2", bin: { cotal: "./dist/cotal.js" } }));
    assert.equal(verifyGlobalEntry(root, "0.13.2"), realpathSync(join(pkg, "dist", "cotal.js")));
    assert.throws(() => verifyGlobalEntry(root, "0.13.3"), /expected cotal-ai@0.13.3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- current --self never installs; bound child asserts version and runs reconcile-only ------------
{
  const current = updateRuntime({});
  assert.equal(await executeUpdate(true, current.rt), 0);
  assert.ok(current.events.includes("reconcile"));
  assert.ok(!current.events.some((event) => event.startsWith("global:install")));

  const child = updateRuntime({ env: { COTAL_UPDATE_TARGET_VERSION: "0.13.1", COTAL_UPDATE_PARENT: "99" } });
  assert.equal(await executeUpdate(false, child.rt), 0);
  assert.deepEqual(child.events.filter((event) => event === "reconcile" || event.startsWith("npm:")), ["reconcile"]);

  const wrongChild = updateRuntime({ env: { COTAL_UPDATE_TARGET_VERSION: "0.13.2", COTAL_UPDATE_PARENT: "99" } });
  assert.equal(await executeUpdate(false, wrongChild.rt), 1);
  assert.ok(!wrongChild.events.includes("reconcile"));

  for (const env of [
    { COTAL_UPDATE_TARGET_VERSION: "0.13.1" },
    { COTAL_UPDATE_PARENT: "99" },
    { COTAL_UPDATE_TARGET_VERSION: "0.13.1", COTAL_UPDATE_PARENT: "98" },
  ]) {
    const invalid = updateRuntime({ env });
    assert.equal(await executeUpdate(false, invalid.rt), 1);
    assert.ok(!invalid.events.includes("reconcile"), "partial/wrong child marker fails before mutation");
  }
}

// Ordinary add ignores ambient update state; the internal route requires its real parent and package tuple.
{
  const prior = process.env[EXT_UPDATE_PARENT_ENV];
  process.env[EXT_UPDATE_PARENT_ENV] = String(process.ppid);
  try {
    await assert.rejects(
      ext({ values: {}, positionals: ["add", "https://example.invalid/ext.tgz"], raw: [] }),
      /unsupported extension spec/,
    );
    process.env[EXT_UPDATE_PARENT_ENV] = "0";
    await assert.rejects(
      ext({ values: {}, positionals: ["__update-add", "expected-package", "actual-package"], raw: [] }),
      /must be launched by its recorded parent/,
    );

    const priorXdg = process.env.XDG_CONFIG_HOME;
    const xdg = mkdtempSync(join(tmpdir(), "cotal-update-child-"));
    process.env.XDG_CONFIG_HOME = xdg;
    const release = claimExtensionUpdatePass();
    try {
      const cli = join(import.meta.dirname, "..", "..", "..", "bin", "cotal.ts");
      const child = spawnSync(
        process.execPath,
        [...process.execArgv, cli, "ext", "__update-add", "expected-package", "actual-package"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            COTAL_SKIP_CONNECTOR_SEED: "1",
            [EXT_UPDATE_PARENT_ENV]: String(process.pid),
          },
        },
      );
      assert.equal(child.status, 1);
      assert.match(child.stderr, /recorded extension expected-package now resolves to actual-package/);
    } finally {
      release();
      rmSync(xdg, { recursive: true, force: true });
      if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = priorXdg;
    }
  } finally {
    if (prior === undefined) delete process.env[EXT_UPDATE_PARENT_ENV];
    else process.env[EXT_UPDATE_PARENT_ENV] = prior;
  }
}

console.log("✓ command-kernel smoke passed");
