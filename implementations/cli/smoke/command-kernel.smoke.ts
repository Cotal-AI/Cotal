/**
 * Broker-free smoke for the command kernel: parseCommandArgs semantics —
 * strict flags, shorts, positional gating, rawArgs passthrough — plus commandUsage
 * generation and the dispatcher's flag-name completion. Run: pnpm smoke:cli-kernel
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandUsage, parseCommandArgs, registry, type Command } from "@cotal-ai/core";
import type { InstalledExtension } from "@cotal-ai/workspace";
import "../src/index.js"; // self-register the CLI commands (for the completion check)
import { complete } from "../src/commands/completion.js";
import { EXT_UPDATE_PARENT_ENV, ext } from "../src/commands/ext.js";
import { isCommandFailure, MeshTargetError, seededCommandsMismatch } from "@cotal-ai/workspace";
import { executeUpdate, parseNpmVersion, reportRunningManagers, update, verifyGlobalEntry, type UpdateRuntime } from "../src/commands/update.js";
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
  reportRunningManager?: () => Promise<"none" | "legacy">;
  checkout?: boolean;
}) {
  const events: string[] = [];
  const rt: UpdateRuntime = {
    env: opts.env ?? {},
    pid: 101,
    parentPid: 99,
    nodePath: "/node",
    version: () => opts.version ?? "0.13.1",
    reconcile: async () => void events.push("reconcile"),
    refreshConnectors: async () => (events.push("refresh-connectors"), []),
    reportRunningManager: async () => {
      events.push("report-running-manager");
      return await opts.reportRunningManager?.() ?? "none";
    },
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
    checkout: () => opts.checkout ?? false,
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
  assert.match(out, /\bUsage\b/u, "feedback --help prints its usage heading");
  assert.match(out, /cotal feedback\b/u, "feedback --help prints its command usage");
  assert.ok(!out.includes("Unknown option"), "no usage error above the help");
}

// --- `version`, `--version` and `-V` print `cotal-ai <semver>` (+ any extensions) -----------------
// (`-v` is refused; the entry smoke covers that, since a refusal exits the process.)
{
  const { runCli } = await import("../src/command.js");
  for (const argv of [["version"], ["--version"], ["-V"]]) {
    let out = "";
    const realLog = console.log;
    console.log = (s?: unknown) => void (out += `${s}\n`);
    try {
      await runCli(registry, argv);
    } finally {
      console.log = realLog;
    }
    // First line is always `cotal-ai <semver>`; any installed extensions follow indented (none in
    // a bare unit env).
    assert.match(out.split("\n")[0], /^cotal-ai \d+\.\d+\.\d+/, `${argv.join(" ")} prints the binary version`);
  }
}

// --- version --json is one envelope; an unreadable extensions manifest makes its list partial -----
// The binary's overlay refuses a corrupt manifest before version runs; a composition root without
// extensions reaches version's own read.
{
  const { runCli } = await import("../src/command.js");
  const { extensionsManifestPath } = await import("@cotal-ai/workspace");
  const priorXdg = process.env.XDG_CONFIG_HOME;
  const xdg = mkdtempSync(join(tmpdir(), "cotal-version-json-"));
  process.env.XDG_CONFIG_HOME = xdg;
  const capture = async (argv: string[]) => {
    let out = "";
    const real = process.stdout.write;
    process.stdout.write = ((chunk: string) => ((out += chunk), true)) as typeof process.stdout.write;
    try {
      await runCli(registry, argv);
    } finally {
      process.stdout.write = real;
    }
    return out;
  };
  try {
    const clean = JSON.parse(await capture(["version", "--json"]));
    assert.equal(clean.completeness, "complete", "version --json with a readable manifest is complete");
    assert.deepEqual(clean.warnings, [], "version --json with a readable manifest has no warnings");
    mkdirSync(join(extensionsManifestPath(), ".."), { recursive: true });
    writeFileSync(extensionsManifestPath(), "{ not json");
    const corrupt = JSON.parse(await capture(["version", "--json"]));
    const partialExit = process.exitCode;
    process.exitCode = 0;
    assert.equal(corrupt.result?.version, clean.result.version, "version --json still reports the binary's version");
    assert.equal(corrupt.outcome, "partial", "an unreadable manifest makes the read partial, not empty and complete");
    assert.equal(corrupt.completeness, "partial", "an unreadable manifest makes the extension list partial");
    assert.equal(corrupt.error?.code, "OPERATION_PARTIAL", "a partial read carries OPERATION_PARTIAL");
    assert.equal(partialExit, 4, "a partial read exits 4");
    assert.equal(corrupt.warnings[0]?.code, "EXTENSIONS_UNREADABLE", "an unreadable manifest is named in a warning");
  } finally {
    rmSync(xdg, { recursive: true, force: true });
    if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorXdg;
  }
}

// --- A classified failure sets the exit code its outcome names, with its envelope on --json -------
// The kernel ends the process, so it runs in a child over probe commands: `probe` declares a JSON
// output, `legacy` declares none, and `shadow` declares a global flag's name.
{
  const fixture = join(import.meta.dirname, "output-exit.fixture.ts");
  const sandbox = mkdtempSync(join(tmpdir(), "cotal-output-exit-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_")));
  const run = (...words: string[]) => runWith({}, ...words);
  const runWith = (extra: Record<string, string>, ...words: string[]) => {
    const r = spawnSync(process.execPath, [...process.execArgv, fixture, ...words], {
      encoding: "utf8",
      env: { ...env, COTAL_HOME: join(sandbox, "home"), XDG_CONFIG_HOME: join(sandbox, "cfg"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1", ...extra },
    });
    const lines = r.stdout.split("\n").filter(Boolean);
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, envelope: lines.length === 1 && lines[0]!.startsWith("{") ? JSON.parse(lines[0]!) : undefined };
  };
  try {
    const ok = run("probe", "--json");
    assert.equal(ok.status, 0, "probe --json exits 0");
    assert.equal(ok.envelope?.outcome, "ok", "probe --json writes one ok envelope");
    assert.equal(ok.envelope?.result?.input, false, "--json implies --no-input");
    assert.equal(run("probe").stdout, "ran input:true\n", "control: without --json or --no-input, input is allowed");
    assert.equal(run("probe", "--no-input").stdout, "ran input:false\n", "--no-input after the command's words disables input");

    const conflict = run("probe", "--json", "--fail", "conflict");
    assert.equal(conflict.status, 2, "a boundary refusal exits 2");
    assert.equal(conflict.envelope?.error?.code, "CONFLICT", "a refusal's envelope carries its stable code");
    assert.deepEqual(conflict.envelope?.error?.cause, { code: "E_LEASE", outcome: "not-executed" }, "a refusal's envelope keeps the native cause");
    assert.deepEqual(conflict.envelope?.target, { space: "s1" }, "a refusal's envelope names its target");
    assert.match(conflict.stderr, /the lease is held[\s\S]*wait for the holder to release it/u, "a refusal prints its message and remedy on stderr");

    const human = run("probe", "--fail", "conflict");
    assert.equal(human.status, 2, "a refusal without --json exits 2 as well");
    assert.equal(human.stdout, "", "a refusal without --json writes nothing on stdout");

    const usage = run("probe", "--json", "--fail", "usage");
    assert.equal(usage.status, 1, "a usage refusal raised by the command exits 1");
    assert.equal(usage.envelope?.error?.code, "USAGE_INVALID", "a command's usage refusal keeps its code");

    const partial = run("probe", "-j", "--fail", "partial");
    assert.equal(partial.status, 4, "a partial outcome exits 4");
    assert.deepEqual(partial.envelope?.changed, [{ seat: "a" }], "a partial outcome reports what it changed");

    const failed = run("probe", "--json", "--fail", "failed");
    assert.equal(failed.status, 5, "a failed outcome exits 5");
    assert.equal(failed.envelope?.outcome, "failed", "a failed outcome writes its envelope");

    const plain = run("probe", "--json", "--fail", "plain");
    assert.equal(plain.status, 3, "an unclassified error from a structured command exits 3");
    assert.equal(plain.envelope?.error?.code, "OPERATION_UNKNOWN", "an unclassified error from a structured command is unknown");
    assert.equal(plain.envelope?.error?.message, "socket closed mid-request", "the unknown envelope keeps the error's message");

    // A target the command could not resolve or reach is refused under the refusal's own code, not
    // reported as an unknown outcome.
    const refusal = run("probe", "--json", "--fail", "refusal");
    assert.equal(refusal.status, 2, "a connect refusal from a structured command exits 2");
    assert.equal(refusal.envelope?.error?.code, "TARGET_UNAVAILABLE", "a connect refusal keeps its code");
    assert.equal(refusal.envelope?.error?.message, "can't reach a broker at nats://127.0.0.1:1", "a connect refusal's message drops the mark");
    assert.equal(refusal.envelope?.error?.remedy, "start it with `cotal up`", "a connect refusal's hint is its remedy");
    const target = run("probe", "--json", "--fail", "target");
    assert.equal(target.status, 2, "an unresolvable target exits 2");
    assert.equal(target.envelope?.error?.code, "TARGET_AMBIGUOUS", "an ambiguous target is TARGET_AMBIGUOUS");
    assert.equal(target.envelope?.error?.message, "multiple meshes running: a (/a), b (/b)", "an unresolvable target's message says what was found");
    assert.equal(target.envelope?.error?.remedy, "pick one with `--space <name>` or set a default with `cotal use <name>`", "an unresolvable target's remedy is apart from its message");
    const catalog = run("probe", "--json", "--fail", "catalog");
    assert.equal(catalog.status, 2, "a space catalog that stopped the command exits 2");
    assert.equal(catalog.envelope?.error?.code, "DEPENDENCY_UNAVAILABLE", "a failed catalog refresh is DEPENDENCY_UNAVAILABLE");

    const bogus = run("probe", "--json", "--bogus");
    assert.equal(bogus.status, 1, "a usage error under --json exits 1");
    assert.equal(bogus.envelope?.error?.code, "USAGE_INVALID", "a usage error under --json is one USAGE_INVALID envelope");
    assert.doesNotMatch(bogus.stdout, /usage:/, "a usage error under --json keeps the help text off stdout");
    assert.equal(run("probe", "-aj", "--bogus").envelope?.error?.code, "USAGE_INVALID", "-j inside a group of short flags asks for the usage envelope");

    // A command that declares a global flag's name could receive it only as `--no-color=<value>`.
    const shadowed = runWith({ OUTPUT_EXIT_SHADOW: "1" }, "shadow", "--no-color=red");
    assert.equal(shadowed.status, 1, "a command that declares a global flag is an internal error that exits 1");
    assert.match(shadowed.stderr, /internal error: command "shadow" declares --no-color, which is a global flag/, "the internal error names the command and the flag");
    assert.doesNotMatch(shadowed.stdout, /ran/, "a command that declares a global flag never runs");
    assert.doesNotMatch(runWith({ OUTPUT_EXIT_SHADOW: "1" }, "probe").stdout, /ran/, "a declared global flag stops every command, not only its own");

    const legacy = run("legacy", "--fail", "plain");
    assert.equal(legacy.status, 1, "an unclassified error from a command with no structured output still exits 1");
    assert.equal(run("legacy", "--fail", "failed").status, 5, "a classified failure from a command with no structured output exits by its outcome");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// --- a refused manager read becomes the failure its catalog code names -----------------------------
{
  const { readFailure } = await import("../src/lib/control.js");
  // The reply a request nobody answered carries: the deadline the caller waited out.
  const silent = readFailure({ error: "no describe reply from cotal.manager within 3000ms on the ep rail", code: "deadline-exceeded" }, { space: "s" });
  assert.equal(`${silent.outcome}/${silent.code}`, "refused/TARGET_UNAVAILABLE", "an unanswered read is an unavailable target");
  assert.deepEqual(silent.target, { space: "s" }, "a refused read names its target");
  const denied = readFailure({ error: "not permitted", code: "permission-denied" });
  assert.equal(`${denied.outcome}/${denied.code}`, "refused/PERMISSION_DENIED", "a denied read is PERMISSION_DENIED");
  assert.deepEqual(denied.native, { code: "permission-denied" }, "a refused read keeps the endpoint's code as its cause");
  assert.equal(readFailure({ error: "x", code: "unauthenticated" }).code, "AUTH_REQUIRED", "an unauthenticated read needs a sign-in");
  assert.equal(readFailure({ error: "x", code: "contract-mismatch" }).code, "UNSUPPORTED", "a read the manager's contract does not serve is UNSUPPORTED");
  const internal = readFailure({ error: "boom", code: "internal" });
  assert.equal(`${internal.outcome}/${internal.code}`, "failed/OPERATION_FAILED", "a read that failed for an unclassified reason is failed, not unknown");
  assert.equal(readFailure({ error: "boom" }).code, "OPERATION_FAILED", "a read failure with no code is failed");
}

// --- a refused operator call to another endpoint names the paired caller file that makes it ------
{
  const { EpEnvelopeError } = await import("@cotal-ai/core");
  const { endpointFailure, withPairedCallerRemedy } = await import("../src/lib/endpoint-errors.js");
  const denied = endpointFailure(new EpEnvelopeError("permission-denied", "refused by the broker", undefined, "not-executed"), { space: "s" }, true);
  const named = withPairedCallerRemedy(denied, "com.example.reviews", { space: "s" });
  assert.equal(`${named.outcome}/${named.code}`, "refused/PERMISSION_DENIED", "naming a paired caller keeps the refusal");
  assert.equal(named.remedy, "issue a caller for com.example.reviews with cotal auth mint <name> --endpoint com.example.reviews --space s --out <private-file>, then rerun with --creds <private-file>", "a refused call to another endpoint names the caller file that makes it");
  assert.deepEqual([named.native, named.target], [denied.native, denied.target], "the remedy keeps the native cause and the target");
  assert.equal(withPairedCallerRemedy(denied, "com.example.reviews", { space: "s", server: "nats://127.0.0.1:4333" }).remedy, "issue a caller for com.example.reviews with cotal auth mint <name> --endpoint com.example.reviews --space s --server nats://127.0.0.1:4333 --out <private-file>, then rerun with --creds <private-file>", "the caller remedy keeps the --server the call was given");
  assert.equal(withPairedCallerRemedy(denied, "com.example.reviews", { space: "s", server: "nats://h:1 o'k" }).remedy, "issue a caller for com.example.reviews with cotal auth mint <name> --endpoint com.example.reviews --space s --server 'nats://h:1 o'\\''k' --out <private-file>, then rerun with --creds <private-file>", "a server a shell would split is quoted in the caller remedy");
  assert.equal(withPairedCallerRemedy(denied, "manager", { space: "s" }).remedy, undefined, "a refused manager call names no caller file, because the operator instrument already requests the manager");
  const unknown = endpointFailure(new Error("lost"), { space: "s" }, true);
  assert.equal(withPairedCallerRemedy(unknown, "com.example.reviews", { space: "s" }), unknown, "only a refusal gains the caller-file remedy");
}

// --- a paired caller's issuance intent reads back as `auth mint --endpoint` wrote it --------------
// The mint writes the record `standaloneCallerIntent` returns, and describe and invoke read the file
// back through it. It used to return the endpoint's wire token, which that second read refused.
{
  const { randomUUID } = await import("node:crypto");
  const { mintLifecycleUid, newIdentity } = await import("@cotal-ai/core");
  const { standaloneCallerIntent } = await import("@cotal-ai/workspace");
  const written = standaloneCallerIntent({
    schemaVersion: 1, kind: "endpoint-caller-issuance-intent", requestId: randomUUID(), createdAt: new Date(0).toISOString(), space: "s",
    endpoint: "com.example.reviews", identity: newIdentity().id, owner: "local", lifecycleUid: mintLifecycleUid(), output: "/private/caller.creds",
    channels: [], expiresInSeconds: null, phase: "local-intent-only", secretIncluded: false,
    scope: { source: "fresh-native-resolution", supportedMode: "untargeted-synchronous-ephemeral", owner: "local", responder: { instanceId: mintLifecycleUid(), epoch: 0 }, instancePinned: false,
      commands: [{ command: "echo", class: "ephemeral", capability: "echo", inputDigest: "sha256:in", outputDigest: "sha256:out" }] },
  });
  assert.equal(written.endpoint, "com.example.reviews", "the written intent keeps the dotted endpoint name");
  assert.deepEqual(standaloneCallerIntent(JSON.parse(JSON.stringify(written))), written, "the written intent reads back unchanged");
  assert.throws(() => standaloneCallerIntent({ ...written, endpoint: "com_example_reviews" }), (e: unknown) => isCommandFailure(e) && e.code === "SCHEMA_INVALID" && e.remedy !== undefined, "an intent that records the endpoint's wire token is refused with a remedy");
}

// --- the caller remedy names the space the refused call resolved, not the current one -------------
// `endpoint invoke` reaches this refusal only after a static-auth broker answers and a served
// endpoint is described, so this cell runs without either: it takes the space from the selection
// the invocation makes, builds the remedy with the arguments `invokeCmd` passes, and reads the
// remedy's flags back through the resolver `auth mint` runs.
{
  const { EpEnvelopeError } = await import("@cotal-ai/core");
  const { recordMesh, setCurrent } = await import("@cotal-ai/workspace");
  const { endpointFailure, withPairedCallerRemedy } = await import("../src/lib/endpoint-errors.js");
  const { resolveEndpointSelection } = await import("../src/lib/endpoint-selection.js");
  const { resolveMintTarget } = await import("../src/lib/credential-authority.js");
  const priorHome = process.env.COTAL_HOME, cwd = process.cwd();
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "cotal-caller-space-")));
  const servers = { alpha: "nats://127.0.0.1:4301", beta: "nats://127.0.0.1:4302" } as const;
  process.env.COTAL_HOME = join(sandbox, "home");
  try {
    for (const space of ["alpha", "beta"] as const) {
      mkdirSync(join(sandbox, space, ".cotal"), { recursive: true });
      recordMesh({ space, server: servers[space], root: join(sandbox, space), mode: "open", origin: "manual", ts: new Date(0).toISOString() });
    }
    setCurrent("alpha");
    mkdirSync(join(sandbox, "elsewhere"));
    process.chdir(join(sandbox, "elsewhere"));
    // The flags of the remedy a refused `endpoint invoke ep:com.example.reviews <command>` names.
    const remedyFor = (values: { space?: string; server?: string }) => {
      const selection = resolveEndpointSelection("ep:com.example.reviews", values);
      const denied = endpointFailure(new EpEnvelopeError("permission-denied", "refused by the broker", undefined, "not-executed"), { space: selection.space, endpoint: selection.endpoint }, true);
      const remedy = withPairedCallerRemedy(denied, selection.endpoint, { space: selection.space, ...(values.server === undefined ? {} : { server: values.server }) }).remedy ?? "";
      return (name: "space" | "server") => new RegExp(` --${name} (\\S+)`, "u").exec(remedy)?.[1];
    };
    const requested = remedyFor({ space: "beta" });
    assert.equal(requested("space"), "beta", "the caller remedy names the space the refused call resolved, not the current one");
    const minted = resolveMintTarget({ space: requested("space") ?? "" });
    assert.deepEqual([minted.space, minted.root, minted.server], ["beta", join(sandbox, "beta"), servers.beta], "auth mint with the remedy's --space resolves the refused call's root and broker");
    assert.equal(resolveMintTarget({}).space, "alpha", "control: auth mint without --space resolves the current space, which did not refuse");
    const overServer = remedyFor({ space: "beta", server: servers.beta });
    assert.deepEqual([overServer("space"), overServer("server")], ["beta", servers.beta], "the caller remedy keeps the --server the refused call was given");
    const mintedOver = resolveMintTarget({ space: overServer("space") ?? "", server: overServer("server") ?? "" });
    assert.deepEqual([mintedOver.root, mintedOver.server], [join(sandbox, "beta"), servers.beta], "auth mint with the remedy's --space and --server resolves the refused call's root and broker");
  } finally {
    process.chdir(cwd);
    if (priorHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = priorHome;
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// --- endpoint init's Next is the check command for the contract it created ------------------------
{
  const { scaffoldCheckCommand } = await import("../src/commands/endpoint-authoring.js");
  assert.equal(scaffoldCheckCommand("/run/ep/reviews"), "cotal ep check /run/ep/reviews/contract.json", "the scaffold's Next names its own contract, not a placeholder");
  assert.equal(scaffoldCheckCommand("/run/it's here"), "cotal ep check '/run/it'\\''s here/contract.json'", "a scaffold path a shell would split is quoted");
  const { runCli } = await import("../src/command.js");
  const priorXdg = process.env.XDG_CONFIG_HOME;
  const scaffold = realpathSync(mkdtempSync(join(tmpdir(), "cotal-ep-init-")));
  process.env.XDG_CONFIG_HOME = join(scaffold, "cfg");
  const dir = join(scaffold, "it's here");
  try {
    let out = "";
    const real = process.stdout.write;
    process.stdout.write = ((chunk: string) => ((out += chunk), true)) as typeof process.stdout.write;
    try {
      await runCli(registry, ["endpoint", "init", "reviews", "--dir", dir, "--plain"]);
    } finally {
      process.stdout.write = real;
    }
    assert.ok(out.includes(scaffoldCheckCommand(dir)), "endpoint init's Next is the check command for the contract it created");
  } finally {
    if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorXdg;
    rmSync(scaffold, { recursive: true, force: true });
  }
}

// --- up rejects pure flag conflicts before even checking a supplied project root ----------------
{
  const cmd = registry.resolve<Command>("command", "up");
  assert.ok(cmd?.validate, "up declares pre-effect argument validation");
  const missingRoot = join(tmpdir(), "cotal-up-usage-no-project", `${process.pid}-${Date.now()}`);
  for (const flags of [
    ["--json", "--plain"],
    ["--no-manager", "--runtime", "pty", "--json"],
    ["--no-manager", "--max-sessions", "2", "--json"],
    ["--user-auth", "--open", "--json"],
    ["--open", "--idp", "http://127.0.0.1:1", "--json"],
  ]) {
    const parsed = parseCommandArgs(cmd, [...flags, "--root", missingRoot]);
    assert.throws(() => cmd.validate!(parsed), (error: unknown) =>
      isCommandFailure(error) && error.outcome === "refused" && error.code === "USAGE_INVALID" && Boolean(error.remedy),
    `${flags.join(" ")} is classified usage with a remedy before project lookup or preparation`);
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

// --- an alias completes as its command does; a subcommand alias reaches the completer canonical --
{
  assert.equal(await completionOut(["sp", "--"]), await completionOut(["spawn", "--"]), "sp completes as spawn");
  assert.ok((await completionOut(["sp"])).includes("spawn\t"), "a lone alias is still a word being typed: it offers command names");
  const prefix = await completionOut(["spa"]);
  assert.ok(prefix.includes("spawn\t") && prefix.includes("status\t"), "a prefix offers command names, it never selects one");
}

// --- the cursor's -- prefix differs from a committed end-of-options separator --------------------
{
  for (const words of [["spawn"], ["sp"], ["up"], ["attach"], ["service"], ["service", "stop"], ["service", "status"], ["endpoint"], ["endpoint", "invoke"]]) {
    assert.match(await completionOut([...words, "--"]), /^--space(?:\t|$)/mu, `${words.join(" ")} completes the unfinished -- word as flags`);
    const committed = await completionOut([...words, "--", ""]);
    assert.ok(!/^--/mu.test(committed), `${words.join(" ")} does not offer options after a committed --`);
    assert.ok(committed.trimEnd().endsWith(":nofiles"), `${words.join(" ")} preserves its positional completion directive`);
  }
  const stop = await completionOut(["service", "stop", "--"]);
  const status = await completionOut(["service", "status", "--"]);
  assert.match(stop, /^--with-agents\t/mu, "service stop offers its own flag");
  assert.ok(!/^--with-agents\t/mu.test(status), "service status does not offer stop-only flags");
  assert.match(await completionOut(["up", "--runtime", ""]), /^pty$/mu, "runtime value completion remains available before the separator");
  assert.ok(!/^pty$/mu.test(await completionOut(["up", "--", "--runtime", ""])), "literal words after the separator are not option values");
  assert.match(await completionOut(["up", "--file", "--", "--"]), /^--space\t/mu, "a separator-shaped option value does not end options");
  for (const words of [["up", "--server", ""], ["endpoint", "invoke", "--args", ""]]) {
    const values = await completionOut(words);
    assert.ok(!/^--/mu.test(values), `${words.join(" ")} does not offer option names as a string value`);
    assert.ok(values.trimEnd().endsWith(":nofiles"), "non-file values suppress filename fallback");
  }
}

// --- a seeded package must claim the words its seed entry declares, aliases included -------------
{
  assert.equal(seededCommandsMismatch("@cotal-ai/web", [{ name: "__service-web" }]), undefined, "the web package's hidden service child matches its seed declaration");
  assert.match(seededCommandsMismatch("@cotal-ai/web", [{ name: "__service-web", aliases: ["w"] }]) ?? "", /claiming \[__service-web, w\].*declares \[__service-web\]/, "an undeclared alias of a seeded command passed the seed check");
  assert.match(seededCommandsMismatch("@cotal-ai/web", [{ name: "__service-web" }, { name: "dash" }]) ?? "", /declares \[__service-web\]/, "an undeclared seeded command passed the seed check");
  assert.match(seededCommandsMismatch("@cotal-ai/web", []) ?? "", /declares \[__service-web\]/, "a seeded package that dropped its command passed the seed check");
  assert.equal(seededCommandsMismatch("@example/not-seeded", [{ name: "x", aliases: ["y"] }]), undefined, "a package that is not seeded has no declared words");
}

// --- exact commands and flags-before-positionals stay inside the command grammar -----------------
{
  const exactSend = await completionOut(["send"]);
  assert.equal(registry.all<Command>("command").find((cmd) => cmd.name === "send")?.subcommands?.length ?? 0, 0, "send selects its destination with flags, not legacy dm/msg subcommands");
  assert.ok(exactSend.trimEnd().endsWith(":nofiles"), "send has no positional body candidates or filename fallback");
  assert.ok(!exactSend.includes("spawn\t"), "exact send does not fall back to top-level commands");

  const flaggedSend = await completionOut(["send", "--space", "demo", ""]);
  assert.ok(flaggedSend.trimEnd().endsWith(":nofiles"), "target flags do not turn the message body into legacy subcommands or filenames");
  for (const value of [exactSend, flaggedSend]) assert.ok(!/^(?:dm|msg)\t/mu.test(value), "send does not offer removed subcommands");
  const send = registry.all<Command>("command").find((cmd) => cmd.name === "send")!;
  for (const name of ["to", "channel", "role"]) assert.ok(send.flags?.some((flag) => flag.name === name), `send declares the ${name} destination flag`);
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

// --- endpoint describe has no contract cache, so --refresh refuses before any request ------------
{
  const endpoint = registry.all<Command>("command").find((cmd) => cmd.name === "endpoint")!;
  let refused: unknown;
  try { endpoint.validate?.(parseCommandArgs(endpoint, ["describe", "manager", "--refresh"])); } catch (e) { refused = e; }
  assert.ok(isCommandFailure(refused) && refused.code === "UNSUPPORTED", "endpoint describe --refresh refuses as UNSUPPORTED instead of being accepted and ignored");
  endpoint.validate?.(parseCommandArgs(endpoint, ["describe", "manager"]));
  for (const name of ["spawn", "status"]) {
    const usage = registry.all<Command>("command").find((cmd) => cmd.name === name)?.usage ?? "";
    assert.doesNotMatch(usage, /\[(?:persona|agent)\]/u, `${name} writes its optional name as a <placeholder>, never a bare word the census reads as a mode`);
  }
}

// --- update grammar: registered in Setup with target selection -----------------------------------
{
  const cmd = registry.all<Command>("command").find((candidate) => candidate.name === "update");
  assert.equal(cmd?.group, "Setup");
  assert.deepEqual(cmd?.flags?.map((flag) => flag.name), ["self", "check", "json", "plain", "space", "server", "creds"]);
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
  // Real npm wraps `view cotal-ai@latest version --json` in a JSON array once the registry holds more
  // than one published version — a bare string only appears with a single version. Accept the array
  // form (the production shape) and take the highest valid semver; reject empty/garbage arrays loudly.
  assert.equal(parseNpmVersion('["0.13.2"]'), "0.13.2");
  assert.equal(parseNpmVersion('["0.13.1","0.13.2"]'), "0.13.2");
  assert.equal(parseNpmVersion('["0.13.2","0.13.10"]'), "0.13.10");
  assert.throws(() => parseNpmVersion("[]"), /invalid cotal-ai version/);
  assert.throws(() => parseNpmVersion('["0.13","not-a-version"]'), /invalid cotal-ai version/);

  const { rt, events } = updateRuntime({
    extensions: [
      installed("@cotal-ai/orca", "0.12.0", "@cotal-ai/orca"),
      installed("@cotal-ai/web", "0.12.0", "@cotal-ai/web"),
      installed("third-party-ext", "1.2.3", "third-party-ext@^1"),
    ],
    npm: (args) => ({ status: 0, stdout: args[0] === "view" ? '"0.13.2"' : "" }),
  });
  assert.equal(await executeUpdate(false, rt), 0, "update replays first-party extensions at the current binary generation");
  const replay = events.find((event) => event.startsWith("spawn:"));
  assert.ok(replay?.includes("ext __update-add @cotal-ai/orca @cotal-ai/orca@0.13.1"));
  assert.equal(events.filter((event) => event.startsWith("spawn:")).length, 1, "seeded web + third-party extension are not operator-replayed");
  assert.ok(
    !events.some((event) => event.startsWith("spawn:") && event.includes("@cotal-ai/web")),
    "the seeded web dashboard is reconciled by the seed pass, never operator-replayed from npm",
  );
  assert.ok(events.some((event) => event.includes("third-party-ext@1.2.3 - not auto-updated")));
  assert.ok(events.indexOf("reconcile") < events.findIndex((event) => event.startsWith("npm:view")), "default reconciles before npm check");
  assert.ok(
    events.indexOf("reconcile") < events.indexOf("refresh-connectors"),
    "update refreshes what connectors installed in their harnesses, after the connectors themselves",
  );
}

// --- a connector refresh that fails fails the update ----------------------------------------------
{
  const failing = updateRuntime({});
  failing.rt = { ...failing.rt, refreshConnectors: async () => { throw new Error("plugin update failed (cotal, /p)"); } };
  const code = await executeUpdate(false, failing.rt);
  assert.equal(code, 1, "a stale harness copy is not reported as a finished update");
  assert.ok(failing.events.some((event) => event.includes("✗ connector installs: plugin update failed (cotal, /p)")));
}

// --- a running legacy manager is reported, then blocks an update before replay --------------------
{
  const legacy = updateRuntime({ reportRunningManager: async () => "legacy" });
  const code = await executeUpdate(false, legacy.rt);
  assert.ok(legacy.events.includes("report-running-manager"), "the running manager is classified before refusal");
  assert.ok(!legacy.events.includes("reconcile"), "a legacy custody verdict refuses BEFORE the seed store is rewritten");
  assert.ok(!legacy.events.includes("claim-mutation"), "legacy report refuses before extension replay can mutate packages");
  assert.ok(!legacy.events.some((event) => event.startsWith("spawn:")), "legacy report starts no extension replay subprocess");
  assert.equal(code, 1);
}

// --- #1879: the continuity refusal carries the workspace renderer's remedy ------------------------
// The resolver's own text is command-agnostic by design ("multiple meshes running: …") and carries
// no recovery. Every other command renders the same error through `renderWorkspaceError`, which adds
// the `--space` / `cotal use` sentence. This one printed the bare text, so a refusal that STANDS
// (several tenants on one root: no running manager to enumerate) left the operator with no next step.
{
  const refused = updateRuntime({
    reportRunningManager: async () => {
      throw new MeshTargetError("ambiguous-target", "/root's broker holds accounts for 2 spaces (a, b) - name one with --space", {
        root: "/root",
        available: ["a", "b"],
      });
    },
  });
  assert.equal(await executeUpdate(false, refused.rt), 1);
  const line = refused.events.find((event) => event.includes("running manager continuity check"));
  assert.ok(line, "the refusal is printed under the continuity-check marker");
  assert.ok(
    line.includes("pick one with `--space <name>` or set a default with `cotal use <name>`"),
    "the standing refusal carries the workspace renderer's remedy sentence",
  );
  assert.ok(!refused.events.includes("reconcile"), "a standing refusal still writes nothing");
  // One marker, not two: the command prints its own `✗` and the rendered line's is dropped.
  assert.equal(line.match(/✗/g)?.length, 1, "the rendered marker is not doubled under the command's own");
}

// --- #1879: several running meshes report each manager's continuity in turn -----------------------
// `update --self` replaces the single `cotal-ai` install every running manager shares. With no
// selector it refused outright (no report at all), and with `--space` it reported one and never
// named the others — a silent partial answer about a machine-wide install.
{
  // A declaration, not a `const` arrow: TypeScript only narrows on a `never` return through a
  // declared function, so the callers below can treat a non-string space as unreachable.
  function ambiguous(): never {
    throw new MeshTargetError("ambiguous-target", "multiple meshes running: alpha (/a), beta (/b)", {
      available: ["alpha (/a)", "beta (/b)"],
      spaces: ["alpha", "beta"],
    });
  }

  // The refusal is CAUGHT rather than allowed to propagate: an implementation that stops enumerating
  // rethrows it, and an uncaught throw would end the suite on a stack trace instead of the assertion
  // that names what was lost. The assertions below are the verdict either way.
  const enumerate = async (
    read: (space: string) => "none" | "legacy",
  ): Promise<{ seen: string[]; verdict?: "none" | "legacy"; threw?: unknown }> => {
    const seen: string[] = [];
    try {
      const verdict = await reportRunningManagers({}, async (flags) => {
        const space = flags.space;
        if (typeof space !== "string") ambiguous();
        seen.push(space);
        return read(space);
      });
      return { seen, verdict };
    } catch (e) {
      return { seen, threw: e };
    }
  };

  const all = await enumerate(() => "none");
  assert.deepEqual(all.seen, ["alpha", "beta"], "every running manager is read, in turn");
  assert.equal(all.threw, undefined, "several running managers are reported rather than refused");
  assert.equal(all.verdict, "none", "all-current custody is not a legacy verdict");

  // A `legacy` verdict on EITHER manager makes the whole run not a hot update, and every manager is
  // still observed before the answer comes back (#1620 stands for all of them, not just the first).
  for (const legacySpace of ["alpha", "beta"]) {
    const mixed = await enumerate((space) => (space === legacySpace ? "legacy" : "none"));
    assert.deepEqual(mixed.seen, ["alpha", "beta"], "a legacy verdict does not stop the remaining managers being observed");
    assert.equal(mixed.verdict, "legacy", `a legacy verdict on ${legacySpace} makes the whole run not a hot update`);
  }

  // Through the command: two managers, one legacy, nothing written.
  let asked = 0;
  const twoManagers = updateRuntime({
    reportRunningManager: () => reportRunningManagers({}, async (flags) => {
      if (typeof flags.space !== "string") ambiguous();
      asked++;
      return flags.space === "beta" ? "legacy" : "none";
    }),
  });
  assert.equal(await executeUpdate(false, twoManagers.rt), 1);
  assert.equal(asked, 2, "both managers are observed before the update answers");
  assert.ok(!twoManagers.events.includes("reconcile"), "a legacy verdict on either manager writes nothing");

  // A selector flag still selects exactly one: the enumeration is the UNSELECTED case only.
  for (const flags of [{ space: "alpha" }, { server: "nats://example:4222" }, { creds: "/c.creds" }]) {
    const one: Array<Record<string, unknown>> = [];
    assert.equal(
      await reportRunningManagers(flags, async (f) => {
        one.push(f);
        return "none";
      }),
      "none",
    );
    assert.deepEqual(one, [flags], "a selected target is read once, exactly as given");
  }
  // And a selected target's refusal still stands rather than fanning out.
  await assert.rejects(
    reportRunningManagers({ space: "alpha" }, async () => ambiguous()),
    /multiple meshes running/,
    "a selected target never enumerates",
  );
}

// --- #2158: a remote user mesh is skipped before the manager-caller mint ------------------------
{
  const { readManagerContinuity } = await import("../src/commands/update.js");
  const { recordMesh, removeMesh } = await import("@cotal-ai/workspace");
  const realHome = process.env.COTAL_HOME;
  const tmpHome = mkdtempSync(join(realpathSync(tmpdir()), "cotal-2158-"));
  const tmpRoot = mkdtempSync(join(realpathSync(tmpdir()), "cotal-2158-root-"));
  process.env.COTAL_HOME = tmpHome;
  try {
    recordMesh({
      space: "hosted",
      server: "nats://127.0.0.1:9",
      mode: "user",
      origin: "manual",
      root: tmpRoot,
      tlsRequired: false,
      userAuth: {
        provider: "cotal",
        remote: true,
        idp: { url: "http://127.0.0.1:9/idp", issuer: "http://127.0.0.1:9/idp", audience: "cotal-mesh" },
        endpoints: { url: "http://127.0.0.1:9/" },
        sentinelCredsPath: join(tmpRoot, "sentinel.creds"),
      },
      ts: new Date().toISOString(),
    });

    let out = "";
    const realLog = console.log;
    console.log = (s?: unknown) => void (out += `${s}\n`);
    let verdict: "none" | "legacy" | undefined;
    let thrown: unknown;
    const started = Date.now();
    try {
      verdict = await readManagerContinuity({ space: "hosted" });
    } catch (e) {
      thrown = e;
    } finally {
      console.log = realLog;
    }
    const elapsedMs = Date.now() - started;

    assert.equal(thrown, undefined, "#2158: a remote user mesh is skipped before the manager-caller mint");
    assert.equal(verdict, "none", "#2158: a remote user mesh is skipped before the manager-caller mint");
    assert.ok(
      out.includes("hosted: this mesh's manager runs elsewhere; no custody on this machine"),
      "#2158: the skip names the mesh and says its manager runs elsewhere",
    );
    assert.ok(!out.includes("manager-caller"), "#2158: the skip names the mesh and says its manager runs elsewhere");
    assert.ok(
      !out.includes("running manager continuity check"),
      "#2158: the skip names the mesh and says its manager runs elsewhere",
    );
    assert.ok(elapsedMs < 1_000, "#2158: the skip reaches no exchange");

    // A remote entry among several running meshes contributes none and does not clear a legacy verdict.
    function ambiguous2158(): never {
      throw new MeshTargetError("ambiguous-target", "multiple meshes running: alpha (/a), hosted (/h)", {
        available: ["alpha (/a)", "hosted (/h)"],
        spaces: ["alpha", "hosted"],
      });
    }
    let out2 = "";
    const realLog2 = console.log;
    console.log = (s?: unknown) => void (out2 += `${s}\n`);
    let verdict2: "none" | "legacy";
    try {
      verdict2 = await reportRunningManagers({}, async (flags) => {
        if (typeof flags.space !== "string") ambiguous2158();
        return flags.space === "hosted" ? readManagerContinuity(flags) : "legacy";
      });
    } finally {
      console.log = realLog2;
    }
    assert.equal(
      verdict2,
      "legacy",
      "#2158: a remote entry among several running meshes contributes none and does not clear a legacy verdict",
    );
    assert.ok(
      out2.includes("hosted: this mesh's manager runs elsewhere; no custody on this machine"),
      "#2158: a remote entry among several running meshes contributes none and does not clear a legacy verdict",
    );
  } finally {
    if (realHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = realHome;
    removeMesh("hosted");
  }
}

// --- #1620: update observes the running manager BEFORE it rewrites the global seed store ----------
// `rt.reconcile()` is `runSeed({force: true})` — it rewrites the operator-global seed store,
// manifest and npm prefix. Running it before the continuity check meant an `update --self` against
// an older mesh migrated the machine and only THEN failed the check, leaving it migrated by a run
// that refused to proceed. Observation is a pure read and must come first.
{
  const failedCheck = updateRuntime({
    reportRunningManager: async () => { throw new Error("stream not found"); },
  });
  assert.equal(await executeUpdate(false, failedCheck.rt), 1);
  assert.ok(
    !failedCheck.events.includes("reconcile"),
    "a failed running-manager observation must leave the global seed store untouched",
  );

  const ordered = updateRuntime({});
  assert.equal(await executeUpdate(false, ordered.rt), 0);
  const observed = ordered.events.indexOf("report-running-manager");
  const wrote = ordered.events.indexOf("reconcile");
  assert.ok(observed !== -1 && wrote !== -1, "both the observation and the seed write happen on a clean update");
  assert.ok(observed < wrote, "the running-manager observation precedes the seed store rewrite");
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
  const selfReport = successful.events.indexOf("report-running-manager");
  assert.ok(selfReport !== -1 && selfReport < installEvent, "self-update reports the running manager before the global install");

  const namedTarget = updateRuntime({
    npm: (args) => {
      if (args[0] === "view") return { status: 0, stdout: '"0.13.2"' };
      if (args[0] === "root") return { status: 0, stdout: "/alternate/global/node_modules\n" };
      return { status: 0 };
    },
  });
  assert.equal(await executeUpdate(true, namedTarget.rt, {
    space: "named-space",
    server: "nats://example:4222",
    creds: "/tmp/creds.creds",
  }), 0);
  assert.ok(
    namedTarget.events.some((event) => event.includes("global:reconcile:/alternate/global/node_modules:/node /alternate/global/node_modules/cotal-ai/dist/cotal.js update --space named-space --server nats://example:4222 --creds /tmp/creds.creds")),
    "self-update replacement child carries the selected target flags",
  );

  const selfLegacy = updateRuntime({
    reportRunningManager: async () => "legacy",
    npm: (args) => {
      if (args[0] === "view") return { status: 0, stdout: '"0.13.2"' };
      if (args[0] === "root") return { status: 0, stdout: "/alternate/global/node_modules\n" };
      return { status: 0 };
    },
  });
  assert.equal(await executeUpdate(true, selfLegacy.rt, { space: "named-space" }), 1);
  assert.ok(selfLegacy.events.includes("report-running-manager"), "self-update classifies the selected manager before install");
  assert.ok(!selfLegacy.events.some((event) => event.startsWith("global:install")), "legacy report refuses the global install");

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

// --- the registry version read leaves nothing in npm's own cache, logs or notifier stamp ---------
{
  let cache: string | undefined;
  const { rt, events } = updateRuntime({
    npm: (args) => {
      if (args[0] !== "view") return { status: 0 };
      const at = args.indexOf("--cache");
      cache = at > 0 ? args[at + 1] : undefined;
      assert.ok(cache !== undefined && existsSync(cache), "the read runs against a throwaway cache that exists while npm runs");
      return { status: 0, stdout: '"0.13.2"' };
    },
  });
  let out = "";
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
  try {
    await update({ values: { check: true, json: true }, positionals: [], raw: ["--check", "--json"] }, rt);
  } finally {
    process.stdout.write = realWrite;
  }
  const view = events.find((event) => event.startsWith("npm:view"));
  assert.ok(view?.includes(" --logs-max=0") && view.includes(" --update-notifier=false"), `the read writes no npm log and runs no npm update notifier: ${view}`);
  assert.ok(cache !== undefined && cache.startsWith(tmpdir()) && !existsSync(cache), `the throwaway cache is under the temp directory and removed afterwards: ${cache}`);
  assert.equal(JSON.parse(out).result.latest, "0.13.2", "the check still reports the registry version");
}

// --- from a source checkout, the --self hint says it installs a separate global copy -------------
{
  const npm = (args: string[]) => ({ status: 0, stdout: args[0] === "view" ? '"0.13.2"' : "" });
  const fromCheckout = updateRuntime({ npm, checkout: true });
  assert.equal(await executeUpdate(false, fromCheckout.rt), 0);
  assert.ok(fromCheckout.events.some((event) => event.startsWith("out:") && event.includes("cotal update --self") && event.replace(/\s+/g, " ").includes("separate global copy")), "the checkout hint names the separate global copy");
  const released = updateRuntime({ npm });
  assert.equal(await executeUpdate(false, released.rt), 0);
  assert.ok(!released.events.some((event) => event.replace(/\s+/g, " ").includes("separate global copy")), "an installed CLI keeps the plain --self hint");
  let out = "";
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
  try {
    await update({ values: { check: true, plain: true }, positionals: [], raw: ["--check", "--plain"] }, updateRuntime({ npm, checkout: true }).rt);
  } finally {
    process.stdout.write = realWrite;
  }
  assert.ok(out.includes("cotal update --self") && out.replace(/\s+/g, " ").includes("separate global copy"), `update --check from a checkout gives the same hint: ${out}`);
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

// Exercise the registered update metadata through the real dispatcher. Only run is replaced:
// the observer avoids npm mutations; full-updater behavior is covered by terminal replays.
{
  const { Registry } = await import("@cotal-ai/core");
  const { recordMesh, setCurrent, getCurrent } = await import("@cotal-ai/workspace");
  const { runCli } = await import("../src/command.js");
  const { prepareCatalogCommand } = await import("../src/commands/sync.js");
  const home = mkdtempSync(join(tmpdir(), "cotal-update-catalog-"));
  const priorHome = process.env.COTAL_HOME;
  const idp = "https://expired.example/api/auth";
  let catalogCalls = 0;
  const provider: Pick<import("@cotal-ai/core").AuthProvider, "kind" | "name" | "prepareSpaceCatalogs"> = {
    kind: "auth-provider",
    name: "update-catalog-smoke",
    async prepareSpaceCatalogs() {
      catalogCalls++;
      return [{
        account: { idpUrl: idp, issuer: "https://expired.example", sub: "fixture", ownerKey: "fixture", catalogUrl: "https://expired.example/spaces" },
        state: "failed",
        error: "fixture catalog refused: HTTP 401",
      }];
    },
  };
  process.env.COTAL_HOME = home;
  registry.register(provider);
  try {
    recordMesh({
      space: "expired", server: "nats://127.0.0.1:1", root: home, mode: "user", origin: "catalog", catalogOwner: "fixture",
      userAuth: { provider: "cotal", idp: { url: idp, issuer: "https://expired.example", audience: "fixture" }, remote: true, sentinelCredsPath: join(home, "sentinel.creds") },
      ts: new Date(0).toISOString(),
    });
    setCurrent("expired");
    await assert.rejects(prepareCatalogCommand({ positionals: [], values: {}, raw: [] }), /fixture catalog refused: HTTP 401/);
    assert.equal(catalogCalls, 1, "the expired selected account is a live catalogue-gate control");
    const registered = registry.resolve<Command>("command", "update");
    for (const flags of [[], ["--self"], ["--space", "expired"], ["--self", "--space", "expired", "--server", "nats://127.0.0.1:1", "--creds", join(home, "fixture.creds")]]) {
      catalogCalls = 0;
      let entered = false;
      let exitCode: number | undefined;
      const stopped = new Error("fixture process.exit");
      const exit = process.exit;
      const probe = new Registry();
      probe.register({ ...registered, async run(args) {
        entered = true;
        assert.deepEqual(args.raw, flags, "update keeps its parsed selector and self flags");
      } } as Command);
      process.exit = ((code?: number) => { exitCode = code ?? 0; throw stopped; }) as never;
      try {
        await runCli(probe, ["update", ...flags]);
      } catch (error) {
        if (error !== stopped) throw error;
      } finally {
        process.exit = exit;
      }
      assert.equal(exitCode, undefined, "update dispatch reaches its own continuity checks without catalogue authentication");
      assert.equal(entered, true, "update invokes its own command after parsing");
      assert.equal(catalogCalls, 0, "update dispatch does not refresh account catalogues");
      assert.equal(getCurrent(), "expired", "update dispatch preserves the recorded mesh selection");
    }
  } finally {
    registry.unregister("auth-provider", provider.name);
    if (priorHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  }
}

console.log("✓ command-kernel smoke passed");
