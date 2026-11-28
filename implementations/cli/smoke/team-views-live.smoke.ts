/**
 * LIVE e2e for the team verbs on a running static-auth stack. Folder `s` runs its space through
 * `space create` and `up --server` on a free port and takes a channel-only `team deploy`. Then:
 *
 *  A. `team`, `team show <id>`, `team deploy --dry-run`, `team boot --dry-run` and
 *     `team remove <id> --dry-run` each exit 0 with outcome `ok` and `completeness` `partial`, and
 *     the report says what the read does not establish, with no failure line on stderr.
 *     An unreadable record makes the inventory exit 4 without losing readable deployments.
 *  B. a card without `deliveryClass: live`: the apply refuses `UNSUPPORTED`, names the cards and
 *     says what to set, and its preview warns `LIVE_DELIVERY_REQUIRED` for the same cards.
 *  C. a reapply of the identical settled deployment is a no-op, and the preview says so instead of
 *     saying a reapply refuses.
 *  D. a manifest `defaults:` block: `team check` and `team boot --dry-run` show it, and mark each
 *     channel field that inherits it `(default)` instead of "not declared".
 *  E. rows that do not apply are left out: no "Durable delivery on open" row for a static space,
 *     and no empty agent table; the deploy preview's TLS row reads as `team show` reads it.
 *  F. `team boot` on a running stack names inspection, stop preview and ordinary restart.
 *  G. folder `b` attempts a fresh channel-only `team boot` on `s`'s address. The refusal names
 *     the conflicting space, address and retry. Changing the manifest to a free port lets the
 *     printed retry start the stack. Its
 *     receipt, `team show <id>` and the inventory name the record's kind, state, next action and
 *     auth mode in words; the JSON keeps the recorded values. Its printed stop preview runs from
 *     the sibling folder where the team was booted.
 *     Its show and both `team remove` forms offer `cotal down --space <space> --dry-run` with the
 *     space filled in. The refusal also works after stop and directs callers to the recorded root. After
 *     `down`, a second boot refuses LIFECYCLE_BLOCKED naming `cotal up` and a space-scoped
 *     inspection command. The command works with another space selected, and `cotal up` starts
 *     the stack again.
 *  H. a deployment ID that no record names is TARGET_NOT_FOUND, naming the ID, from `team show` and
 *     from `team remove` with and without `--dry-run`.
 *  I. `team boot --dry-run` of another space's manifest in this prepared folder says the folder
 *     belongs to the running space and that the apply needs a folder of its own. In folder `c`,
 *     prepared for no space, it says the folder is not prepared and names `--root .`.
 *  J. after a clean `down` of folder `s`, a removal preview names `cotal up` in its root and a scoped
 *     preview retry. After restart that retry leaves the cards present, and a removal after one of
 *     its cards was edited names that card.
 *  K. after `team remove --yes` of an 11-card deployment, `team show` lists each card's delete
 *     submission before its outcome, and the cards in manifest order, in text and JSON.
 *  L. on an open mesh, apply and preview recommend live delivery and name the requirement for
 *     durable channels. Setting the card to live lets the deployment succeed.
 *  M. the deploy receipt's space locates its record even with another space selected.
 *     The confirmation commands retain the target and output mode, and replay previews and removes the card.
 *  N. the printed fresh boot summary command works with a different space selected.
 *  O. an invalid launch name blocks validation and deployment before any channel is created.
 *  P. a returned mixed deployment permits the same stack to restart without relaunching its seat.
 *
 * The mixed deployment uses the local Jcode Harness API stand-in. COTAL_HOME is sandboxed, the
 * child environment carries no `COTAL_` variable of the runner, and each stack is stopped here.
 * Needs `nats-server` on PATH. Run: pnpm smoke:team-views:live
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { shellPath } from "@cotal-ai/workspace";
import { shellWord } from "../src/lib/endpoint-errors.js";

const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "dist", "cotal.js");
const SERVER = `nats://127.0.0.1:${await freePort()}`, SERVER_B = `nats://127.0.0.1:${await freePort()}`;
const SPACE = `team-views-${process.pid}`, SPACE_B = `team-boot-${process.pid}`;

const base = mkdtempSync(join(tmpdir(), "cotal-team-views-"));
const home = join(base, "home"), configDir = join(base, "xdg"), s = join(base, "s"), b = join(base, "boot project"), c = join(base, "open project");
const runtimeDir = join(base, "runtime");
// The product refuses a local-record store that is not private, so every folder here is 0700.
for (const dir of [home, configDir, runtimeDir, s, b, c]) mkdirSync(dir, { mode: 0o700 });
const sandboxes = new Map([s, b, c].map((root) => [root, recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir })]));
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("COTAL_") && key !== "FORCE_COLOR") env[key] = value;
Object.assign(env, { HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, XDG_RUNTIME_DIR: runtimeDir, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_PROMPT: "1" });

const { check, finish } = createSuite();
const cotal = (cwd: string, ...args: string[]) => {
  const options = { cwd, env, encoding: "utf8" as const, timeout: 180_000 };
  assertSmokeSandboxDown(sandboxes.get(cwd), args, options);
  const run = spawnSync(process.execPath, [CLI, ...args], options);
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, out: `${run.stdout}${run.stderr}` };
};
type Envelope = { outcome?: string; completeness?: string; target?: Record<string, unknown>; error?: { code?: string; message?: string; remedy?: string }; warnings?: { code: string; target: Record<string, unknown>; message: string }[]; result?: Record<string, unknown> };
const envelope = (stdout: string): Envelope | undefined => { try { return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Envelope; } catch { return undefined; } };
/** A read that completed: exit 0, outcome ok, completeness partial and no error. */
const answered = (run: ReturnType<typeof cotal>) => { const e = envelope(run.stdout); return run.status === 0 && e?.outcome === "ok" && e.completeness === "partial" && e.error === undefined; };
/** A text read that completed: exit 0, with its caveat in the report on stdout and not on stderr. */
const reported = (run: ReturnType<typeof cotal>, caveat: string) => run.status === 0 && run.stdout.includes(caveat) && !run.stderr.includes(caveat);

function checkRemovalConfirmation(deployment: string): void {
  const refused = cotal(c, "team", "remove", deployment, "--space", OTHER, "--json");
  const refusal = envelope(refused.stdout);
  check("unconfirmed removal refuses in the explicit space", refused.status === 1 && refusal?.outcome === "refused" && refusal.target?.space === OTHER && refusal.error?.code === "USAGE_INVALID", refused.out);
  const commands = [...(refusal?.error?.remedy ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  const prefix = `cotal team remove ${deployment} --space ${OTHER}`;
  const [preview, apply] = commands;
  const safeToReplay = commands.length === 2 && preview === `${prefix} --json --dry-run` && apply === `${prefix} --json --yes`;
  check("both JSON remedies pin the space and retain JSON output", safeToReplay, commands);

  const plain = cotal(c, "team", "remove", deployment, "-s", OTHER, "--plain");
  check("both plain remedies pin the space and retain plain output", plain.status === 1 &&
    plain.stderr.includes(`\`${prefix} --plain --dry-run\``) && plain.stderr.includes(`\`${prefix} --plain --yes\``), plain.out);

  const readCard = () => {
    const shown = cotal(c, "channel", "show", "audit-team", "--space", OTHER, "--json");
    const registry = envelope(shown.stdout)?.result?.registry as { channels?: Record<string, unknown> } | undefined;
    if (shown.status !== 0 || !registry?.channels) throw new Error(`channel show did not return the registry: ${shown.out}`);
    return Object.hasOwn(registry.channels, "audit-team");
  };
  check("the unconfirmed calls leave the card present", readCard());
  if (!safeToReplay) return;

  const previewRun = cotal(c, ...preview.split(" ").slice(1));
  const previewResult = envelope(previewRun.stdout);
  check("replaying the preview returns JSON and keeps the card", answered(previewRun) && previewResult?.target?.space === OTHER &&
    previewResult.result?.kind === "channel-team-removal-preview" && readCard(), previewRun.out);
  const applyRun = cotal(c, ...apply.split(" ").slice(1));
  const applyResult = envelope(applyRun.stdout);
  check("replaying the confirmation returns JSON and removes the card", applyRun.status === 0 && applyResult?.outcome === "ok" && applyResult.target?.space === OTHER &&
    applyResult.result?.kind === "channel-team-removal" && applyResult.result.returnedReceipt === true && !readCard(), applyRun.out);
}

const manifest = (name: string, space: string, channels: Record<string, string>, { head = "", open = false, dir = s, server = SERVER } = {}) => {
  writeFileSync(join(dir, name), `apiVersion: cotal/v1\nkind: Mesh\nspace: ${space}\nbroker:\n  servers: ${server}\n${open ? "  auth: false\n" : ""}${head}channels:\n${Object.entries(channels).map(([channel, extra]) => `  ${channel}:\n    description: The ${channel} channel.\n${extra}`).join("")}`);
};
manifest("live.yaml", SPACE, { live1: "    deliveryClass: live\n", live2: "    deliveryClass: live\n" });
manifest("invalid-window.yaml", SPACE, { notes: "    deliveryClass: live\n    replayWindow: forever\n" });
writeFileSync(join(s, "extra.yaml"), `apiVersion: cotal/v1\nkind: Mesh\nspace: ${SPACE}\nchannels:\n  extra: {deliveryClass: live}\n`);
manifest("order.yaml", SPACE, Object.fromEntries(Array.from({ length: 11 }, (_, n) => [`order${n}`, "    deliveryClass: live\n"])));
manifest("inherit.yaml", SPACE, { design: "", ops: "    replay: true\n", fine: "    deliveryClass: live\n" });
const OTHER = `other-${process.pid}`, SERVER_OTHER = `nats://127.0.0.1:${await freePort()}`;
for (const dir of [s, c]) manifest("other.yaml", OTHER, { x: "    deliveryClass: live\n" }, { dir, server: SERVER_OTHER });
manifest("boot.yaml", SPACE_B, { bootch: "    deliveryClass: live\n" }, { dir: b, server: SERVER });
manifest("open.yaml", SPACE, { lobby: "    deliveryClass: live\n" }, { open: true });
manifest("defaults.yaml", SPACE, { dops: "", own: "    replay: true\n" }, { head: "defaults:\n  replay: false\n  replayWindow: 2h\n  deliveryClass: live\n" });

function checkForegroundPreview(): void {
  const help = cotal(b, "team", "boot", "--help");
  const helpText = help.stdout.replace(/\s+/g, " ");
  check("team boot help shows independent foreground and dry-run flags and their output rules",
    help.status === 0 && helpText.includes("cotal team boot <file> [--dry-run] [--foreground]") &&
    helpText.includes("A foreground preview accepts --json or --plain. A foreground apply accepts neither."), help.out);
  const args = ["team", "boot", "boot.yaml", "--foreground"];
  const json = cotal(b, ...args, "--dry-run", "--json");
  const result = envelope(json.stdout)?.result;
  check("the foreground JSON preview finishes without effects or records", answered(json) && result?.kind === "fresh-team-boot-preview" &&
    result.lifetimeRequest === "terminal-bound" && result.effectAttempted === false && result.persisted === false, json.out);
  const plain = cotal(b, ...args, "--dry-run", "--plain");
  check("the foreground plain preview also finishes", plain.status === 0 && /Lifetime request:\s+terminal-bound/.test(plain.stdout), plain.out);
  const apply = cotal(b, ...args, "--json");
  check("a foreground apply still refuses structured output", apply.status === 1 && envelope(apply.stdout)?.error?.code === "USAGE_INVALID", apply.out);
}

function checkFreshBootAddressConflict(): void {
  const path = join(b, "boot.yaml"), original = readFileSync(path, "utf8");
  const control = join(b, ".cotal"), before = readdirSync(control, { recursive: true }).sort();
  const plain = cotal(b, "team", "boot", "boot.yaml", "--plain");
  check("fresh boot names the recorded broker conflict and prints a plain retry",
    plain.status === 2 && plain.stderr.includes("CONFLICT") && plain.stderr.includes(SERVER) &&
    plain.stderr.replace(/\s+/g, " ").includes(`local space "${SPACE}"`) && /^Next$/m.test(plain.stderr) && plain.stderr.includes("`broker.servers`") &&
    ["cotal", "pnpm cotal"].some((launcher) => plain.stderr.includes(`\`${launcher} team boot boot.yaml --plain\``)), plain.out);

  const file = "../boot project/boot.yaml";
  const json = cotal(c, "team", "boot", file, "--json");
  const failure = envelope(json.stdout);
  check("fresh boot keeps the structured conflict target and quotes a relative manifest in the JSON retry",
    json.status === 2 && failure?.outcome === "refused" && failure.error?.code === "CONFLICT" && failure.target?.server === SERVER &&
    JSON.stringify(failure.target.otherSpaces) === JSON.stringify([SPACE]) &&
    failure.error.remedy?.includes(`\`cotal team boot '${file}' --json\``) === true, json.out);
  check("both conflicts leave the fresh root's startup paths and manifest unchanged",
    JSON.stringify(readdirSync(control, { recursive: true }).sort()) === JSON.stringify(before) && readFileSync(path, "utf8") === original);
  writeFileSync(path, original.replace(SERVER, SERVER_B));
}

function checkInvalidLaunchName(): void {
  const file = "dash.yaml";
  const fixture = (name: string) => manifest(file, SPACE, {
    dashch: `    deliveryClass: live\n    subscribe: [${JSON.stringify(name)}]\n`,
  }, { head: `agent: claude\nagents:\n  ${JSON.stringify(name)}:\n    instructions: Review changes.\n` });
  fixture("-reviewer");
  for (const action of ["check", "deploy"]) {
    const run = cotal(s, "team", action, file, "--json");
    const error = envelope(run.stdout)?.error;
    check(`team ${action} refuses the invalid launch name and tells the user what to rename`,
      run.status === 1 && error?.code === "SCHEMA_INVALID" &&
      error.message?.includes('invalid agent name "-reviewer"') === true && error.message.includes("update its channel references"), run.out);
  }
  const shown = cotal(s, "channel", "show", "dashch", "--json");
  const registry = envelope(shown.stdout)?.result?.registry as { channels?: Record<string, unknown> } | undefined;
  check("invalid deployment leaves its declared live channel absent", shown.status === 0 &&
    registry?.channels !== undefined && !Object.hasOwn(registry.channels, "dashch"), shown.out);
  fixture("reviewer");
  const corrected = cotal(s, "team", "check", file, "--json");
  check("renaming the key and channel references makes the manifest valid", corrected.status === 0, corrected.out);
}

function checkDeployAuthConflict(): void {
  const args = ["team", "deploy", "open.yaml"];
  const preview = cotal(s, ...args, "--dry-run", "--json");
  const parsed = envelope(preview.stdout);
  const native = parsed?.result?.native as { channels?: { create?: string[] } } | undefined;
  const warning = parsed?.warnings?.find((w) => w.code === "MANIFEST_WARNING" && w.message.startsWith("Apply refuses: broker.auth"));
  check("the deploy preview completes, warns about the explicit mode conflict and has no creation candidates",
    answered(preview) && warning?.target.space === SPACE && warning.message.includes("requests open") &&
    warning.message.includes("static auth") && warning.message.includes("Omit broker.auth or set it to match") &&
    native?.channels?.create?.length === 0, preview.out);
  const plain = cotal(s, ...args, "--dry-run", "--plain");
  check("the plain deploy preview shows the warning and no candidates", plain.status === 0 &&
    plain.stderr.includes("Apply refuses: broker.auth requests open") && /New channel candidates:\s+0/.test(plain.stdout), plain.out);
  const apply = cotal(s, ...args, "--json");
  check("deploy apply still refuses the auth mismatch", apply.status === 2 && envelope(apply.stdout)?.error?.code === "CONFLICT", apply.out);
}

function checkMixedRestart(): void {
  manifest("mixed.yaml", SPACE, { "team-observer": "    deliveryClass: live\n    subscribe: [observer]\n    allowPublish: [observer]\n" }, {
    head: "agent: jcode\nagents:\n  observer:\n    role: observer\n    model: gpt-6.2-sol\n    instructions: Respond only to test prompts.\n",
  });
  const deploy = cotal(s, "team", "deploy", "mixed.yaml", "--json");
  const receipt = envelope(deploy.stdout)?.result;
  const id = receipt?.deploymentId;
  const returned = deploy.status === 0 && typeof id === "string" && receipt?.returnedReceipt === true &&
    Array.isArray(receipt.createdAgents) && receipt.createdAgents.length === 1 && receipt.createdAgents[0]?.name === "observer" &&
    Array.isArray(receipt.createdChannels) && receipt.createdChannels.length === 1 && receipt.createdChannels[0]?.name === "team-observer";
  check("the mixed deployment returns one joined seat and one created card", returned, deploy.out);
  if (!returned || typeof id !== "string") return;
  const shownBefore = cotal(s, "team", "show", id, "--space", SPACE, "--json");

  const stopped = cotal(s, "down", "--yes", "--with-agents", "--json");
  const stoppedMembers = envelope(stopped.stdout)?.result?.members as { role: string; state: string }[] | undefined;
  check("down with agents stops the three members", stopped.status === 0 &&
    ["broker", "delivery", "manager"].every((role) => stoppedMembers?.some((row) => row.role === role && row.state === "stopped")), stopped.out);
  if (stopped.status !== 0) return;
  const restarted = cotal(s, "up", "--detach", "--server", SERVER, "--json");
  const members = envelope(restarted.stdout)?.result?.members as { role: string; state: string }[] | undefined;
  check("up restarts the broker, delivery and manager over the returned mixed deployment", restarted.status === 0 &&
    ["broker", "delivery", "manager"].every((role) => members?.some((row) => row.role === role && row.state === "started")), restarted.out);
  if (restarted.status !== 0) return;

  const seats = cotal(s, "ps", "--space", SPACE, "--json");
  const roster = envelope(seats.stdout);
  check("restart does not bring the stopped seat back", seats.status === 0 && roster?.completeness === "complete" &&
    Array.isArray(roster.result?.items) && !roster.result.items.some((row) => row.name === "observer"), seats.out);
  const card = cotal(s, "channel", "show", "team-observer", "--space", SPACE, "--json");
  const registry = envelope(card.stdout)?.result?.registry as { channels?: Record<string, unknown> } | undefined;
  check("the mixed deployment's card remains in the broker", card.status === 0 && Object.hasOwn(registry?.channels ?? {}, "team-observer"), card.out);
  const shown = cotal(s, "team", "show", id, "--space", SPACE, "--json");
  const before = envelope(shownBefore.stdout)?.result?.receipt;
  check("up leaves the original returned deployment receipt unchanged", answered(shownBefore) && before !== undefined &&
    answered(shown) && JSON.stringify(envelope(shown.stdout)?.result?.receipt) === JSON.stringify(before), shown.out);
}

let up = false, bUp = false, openUp = false;
try {
  const noApplications = join(base, "no-applications");
  mkdirSync(noApplications);
  manifest("claude.yaml", OTHER, { general: "    subscribe: [planner]\n" }, {
    dir: c, server: SERVER_OTHER, head: "agent: claude\nagents:\n  planner:\n    instructions: Make a plan.\n",
  });
  const extension = cotal(c, "ext", "add", join(WT, "extensions", "connector-claude-code"));
  check("the workspace Claude connector installs into the sandbox", extension.status === 0, extension.out);
  const withoutApplications = (...args: string[]) => spawnSync(process.execPath, [join(WT, "bin", "dist", "cotal.js"), ...args],
    { cwd: c, env: { ...env, PATH: noApplications }, encoding: "utf8", timeout: 180_000 });
  const graph = withoutApplications("team", "check", "claude.yaml", "--graph");
  check("team check renders the graph with Claude absent from PATH", graph.status === 0 && graph.stdout.includes("planner"), graph);
  const preview = withoutApplications("team", "boot", "claude.yaml", "--dry-run");
  check("team boot previews the declared agents with Claude absent from PATH",
    preview.status === 0 && preview.stdout.includes("Requested agents") && preview.stdout.includes("planner"), preview);
  const refusedUp = withoutApplications("up", "-f", "claude.yaml", "--dry-run", "--server", SERVER_OTHER);
  check("up -f --dry-run refuses before printing a plan with Claude absent from PATH",
    refusedUp.status === 1 && refusedUp.stdout === "" && refusedUp.stderr.includes("connector preflight failed: claude needs claude on PATH"), refusedUp);

  if (process.platform !== "win32") {
    const fake = join(WT, "extensions", "connector-jcode", "smoke", "fake-jcode.mjs");
    const bin = join(base, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "jcode"), `#!/bin/sh\nexec ${shellPath(process.execPath)} ${shellPath(fake)} "$@"\n`, { mode: 0o755 });
    env.PATH = `${bin}${delimiter}${env.PATH ?? ""}`;
    const jcode = cotal(s, "ext", "add", join(WT, "extensions", "connector-jcode"));
    check("the workspace Jcode connector installs into the sandbox", jcode.status === 0, jcode.out);
  }
  check("space create prepares the folder", cotal(s, "space", "create", SPACE).status === 0);
  up = true;
  const started = cotal(s, "up", "--server", SERVER);
  check("up starts the static-auth stack", started.status === 0, started.out.slice(-600));
  if (started.status !== 0) throw new Error("the stack did not start; no later cell can run");
  checkForegroundPreview();
  checkDeployAuthConflict();

  console.log("\nA. reads and previews that complete exit 0");
  const deployPreview = cotal(s, "team", "deploy", "live.yaml", "--dry-run");
  check("team deploy --dry-run exits 0 and says its read is not a deployment plan",
    reported(deployPreview, "not an authorized deployment plan"), deployPreview.out.slice(-800));
  check("without broker.auth the deploy preview retains the new channel candidates",
    /New channel candidates:\s+2/.test(deployPreview.stdout) && !deployPreview.stderr.includes("broker.auth requests"), deployPreview.out);
  check("team deploy --dry-run --json is ok and partial in completeness", answered(cotal(s, "team", "deploy", "live.yaml", "--dry-run", "--json")));
  const applied = cotal(s, "team", "deploy", "live.yaml", "--json");
  const id = envelope(applied.stdout)?.result?.deploymentId;
  check("team deploy applies the live channels", applied.status === 0 && typeof id === "string", applied.out.slice(-600));
  const deployment = String(id);

  const inventory = cotal(s, "team");
  check("team exits 0 and says the inventory is not complete",
    reported(inventory, "do not establish a complete historical or live team inventory"), inventory.out.slice(-800));
  check("team --json is ok and partial in completeness", answered(cotal(s, "team", "--json")));
  const malformed = join(realpathSync(s), ".cotal", "team-boot-attempt-abcdef0123456789.json");
  writeFileSync(malformed, "{\n", { mode: 0o600 });
  try {
    const partial = cotal(s, "team", "--json");
    const result = envelope(partial.stdout);
    const items = result?.result?.items;
    check("team --json exits 4 and retains readable deployments and the unreadable path",
      partial.status === 4 && partial.stderr === "" && result?.outcome === "partial" && result.completeness === "partial" &&
      result.error?.code === "OPERATION_PARTIAL" && Array.isArray(items) && items.some((item) => item.deploymentId === deployment) &&
      result.warnings?.some((warning) => warning.code === "DEPLOYMENT_RECORD_UNREADABLE" && warning.target.path === malformed) === true, partial.out);
    const plain = cotal(s, "team", "--plain");
    check("team --plain exits 4 and keeps the inventory and warning",
      plain.status === 4 && plain.stdout.includes(deployment) && plain.stderr.includes("A local deployment record could not be read or validated"), plain.out);
  } finally {
    rmSync(malformed);
  }
  const shown = cotal(s, "team", "show", deployment);
  check("team show <id> exits 0 and says the receipt is historical",
    reported(shown, "This is historical, not current broker state"), shown.out.slice(-800));
  check("team show <id> --json is ok and partial in completeness", answered(cotal(s, "team", "show", deployment, "--json")));
  const removePreview = cotal(s, "team", "remove", deployment, "--dry-run");
  check("team remove <id> --dry-run exits 0 and says how it compared the cards",
    reported(removePreview, "Current card revisions were compared with the returned create revisions"), removePreview.out.slice(-800));
  check("team remove <id> --dry-run --json is ok and partial in completeness", answered(cotal(s, "team", "remove", deployment, "--dry-run", "--json")));
  const bootPreview = cotal(s, "team", "boot", "live.yaml", "--dry-run");
  check("team boot --dry-run exits 0 and says what it has not checked",
    reported(bootPreview, "startup readiness have not been checked"), bootPreview.out.slice(-800));
  check("team boot --dry-run --json is ok and partial in completeness", answered(cotal(s, "team", "boot", "live.yaml", "--dry-run", "--json")));

  console.log("\nB. cards without deliveryClass: live");
  const notLivePreview = envelope(cotal(s, "team", "deploy", "inherit.yaml", "--dry-run", "--json").stdout);
  const required = notLivePreview?.warnings?.find((w) => w.code === "LIVE_DELIVERY_REQUIRED");
  check("team deploy --dry-run warns that the apply refuses the cards without deliveryClass: live",
    JSON.stringify(required?.target.cards) === JSON.stringify(["design", "ops"]) && required!.message.startsWith("Apply refuses: #design, #ops do not set deliveryClass: live."), notLivePreview?.warnings);
  const notLiveText = cotal(s, "team", "deploy", "inherit.yaml", "--dry-run");
  check("the text preview prints that warning on stderr", notLiveText.status === 0 && notLiveText.stderr.includes("! Apply refuses: #design, #ops do not set deliveryClass: live."), notLiveText.stderr);
  const notLive = cotal(s, "team", "deploy", "inherit.yaml", "--json");
  const refused = envelope(notLive.stdout);
  check("team deploy refuses those cards with UNSUPPORTED, names them and says what to set",
    notLive.status === 2 && refused?.error?.code === "UNSUPPORTED" && refused.error.message!.includes("#design, #ops do not set deliveryClass: live") &&
      refused.error.remedy === "set `deliveryClass: live` on each card, or create a durable channel with `cotal channel set <name> --delivery durable`", notLive.out.slice(-800));
  const liveCheck = cotal(s, "team", "deploy", "live.yaml", "--dry-run", "--json");
  check("a manifest whose cards all set deliveryClass: live has no such warning", !envelope(liveCheck.stdout)?.warnings?.some((w) => w.code === "LIVE_DELIVERY_REQUIRED"));
  const invalidPreview = cotal(s, "team", "deploy", "invalid-window.yaml", "--dry-run", "--plain");
  const invalidApply = cotal(s, "team", "deploy", "invalid-window.yaml", "--plain");
  const invalidWindow = 'channels.notes.replayWindow: invalid duration "forever"';
  check("deploy preview reports the invalid window and excludes its card from creation candidates",
    invalidPreview.status === 0 && invalidPreview.stderr.includes(invalidWindow) && /New channel candidates:\s+0/.test(invalidPreview.stdout), invalidPreview.out);
  check("deploy apply refuses the same window with its field and native duration diagnostic",
    invalidApply.status === 1 && invalidApply.stderr.includes("SCHEMA_INVALID") && invalidApply.stderr.includes(invalidWindow), invalidApply.out);

  console.log("\nC. a reapply of an identical settled deployment");
  const reapplied = cotal(s, "team", "deploy", "live.yaml", "--json");
  check("the second team deploy of the same manifest is a no-op", reapplied.status === 0 && envelope(reapplied.stdout)?.outcome === "no-op", reapplied.out.slice(-600));
  const reapplyPreview = cotal(s, "team", "deploy", "live.yaml", "--dry-run");
  check("its preview says a reapply of an identical settled deployment changes nothing, not that it refuses",
    reapplyPreview.stdout.includes("Reapplying an identical settled deployment changes nothing") && !reapplyPreview.stdout.includes("reapply refuse"), reapplyPreview.stdout.slice(-900));
  check("the preview classifies unchanged cards as owned by the returned deployment",
    reapplyPreview.status === 0 && new RegExp(`Prior additive run:\\s+${deployment}`).test(reapplyPreview.stdout) &&
      /Prior-owned channel records:\s+2/.test(reapplyPreview.stdout) && /Unmanaged existing channels:\s+0/.test(reapplyPreview.stdout), reapplyPreview.out);
  manifest("foreign.yaml", SPACE, { live1: "    deliveryClass: live\n    replay: true\n" });
  const foreignPreview = cotal(s, "team", "deploy", "foreign.yaml", "--dry-run", "--plain");
  check("an existing card without a receipt for this declaration is unmanaged",
    foreignPreview.status === 0 && /Prior-owned channel records:\s+0/.test(foreignPreview.stdout) && /Unmanaged existing channels:\s+1/.test(foreignPreview.stdout), foreignPreview.out);

  console.log("\nD. a manifest defaults block");
  const checked = cotal(s, "team", "check", "defaults.yaml");
  const inheritedRow = /#dops\s+live \(default\)\s+off \(default\)\s+2h \(default\)/;
  check("team check shows the manifest defaults", /Manifest defaults:\s+delivery live, replay off, window 2h/.test(checked.stdout), checked.stdout);
  check("team check marks each field a channel inherits from them (default)", inheritedRow.test(checked.stdout) && /#own\s+live \(default\)\s+on\s+2h \(default\)/.test(checked.stdout), checked.stdout);
  check("team check --json carries the defaults", JSON.stringify(envelope(cotal(s, "team", "check", "defaults.yaml", "--json").stdout)?.result?.defaults) === JSON.stringify({ replay: false, replayWindow: "2h", deliveryClass: "live" }));
  const bootDefaults = cotal(s, "team", "boot", "defaults.yaml", "--dry-run");
  check("team boot --dry-run shows them the same way", /Manifest defaults:\s+delivery live, replay off, window 2h/.test(bootDefaults.stdout) && inheritedRow.test(bootDefaults.stdout), bootDefaults.stdout.slice(-1500));
  const noDefaults = cotal(s, "team", "check", "live.yaml");
  check("a manifest with no defaults block says none are declared", /Manifest defaults:\s+none declared/.test(noDefaults.stdout) && /#live1\s+live\s+not declared\s+not declared/.test(noDefaults.stdout), noDefaults.stdout);

  console.log("\nE. rows that do not apply");
  const staticCheck = cotal(s, "team", "check", "live.yaml");
  check("team check of a static manifest has no durable-on-open row", staticCheck.status === 0 && !staticCheck.stdout.includes("Durable delivery on open"), staticCheck.stdout);
  check("team check with no agents says so instead of printing an empty agent table", staticCheck.stdout.includes("No agents declared.") && !/Agent\s+Application\s+Role\s+Declared model/.test(staticCheck.stdout), staticCheck.stdout);
  const openCheck = cotal(s, "team", "check", "open.yaml");
  check("team check of an open manifest keeps the durable-on-open row", /Durable delivery on open:\s+not a contradiction/.test(openCheck.stdout), openCheck.stdout);
  const staticDeploy = cotal(s, "team", "deploy", "live.yaml", "--dry-run");
  check("the deploy preview on a static space has no durable-on-open row, and its TLS row reads not required",
    !staticDeploy.stdout.includes("Durable delivery on open") && /\n\s+TLS:\s+not required\n/.test(staticDeploy.stdout) && !staticDeploy.stdout.includes("recorded required"), staticDeploy.stdout.slice(0, 1200));
  check("the boot preview of a static manifest has no durable-on-open row", !cotal(s, "team", "boot", "live.yaml", "--dry-run").stdout.includes("Durable delivery on open"));

  console.log("\nF. team boot on a stack that is up");
  const second = cotal(s, "team", "boot", "live.yaml", "--json");
  const blocked = envelope(second.stdout)?.error;
  check("team boot on the running stack refuses LIFECYCLE_BLOCKED and says the space is already up",
    second.status === 2 && blocked?.code === "LIFECYCLE_BLOCKED" && blocked.message === `"${SPACE}" is already up at this root and no \`cotal down\` has stopped it; a team boot starts only a stopped stack, so nothing was booted`, second.out.slice(-800));
  const remedy = blocked?.remedy ?? "";
  check("its Next offers inspection, stop preview and ordinary restart",
    remedy.includes(`cotal service --space ${SPACE}`) && remedy.includes(`cd ${shellPath(realpathSync(s))} && cotal down --space ${SPACE} --dry-run`) && remedy.includes(`cd ${shellPath(realpathSync(s))} && cotal up --space ${SPACE}`) && !remedy.includes("team deploy"), blocked);
  const spacedFile = "team add.yaml";
  manifest(spacedFile, SPACE, { alerts: "    deliveryClass: live\n" });
  const conflict = cotal(s, "up", "-f", spacedFile, "--dry-run");
  check("up -f --dry-run on the running controller stack refuses without starting anything",
    conflict.status === 2 && conflict.stderr.includes("CONFLICT") && conflict.stderr.includes("nothing was started"), conflict.out);
  const command = conflict.stderr.split("`").find((part) => part.startsWith("cotal team boot "));
  const expectedPreview = `cotal team boot '${realpathSync(s).replaceAll("'", "'\\''")}/${spacedFile}' --dry-run`;
  check("up -f quotes the whole manifest path in its preview and does not suggest redeployment",
    command === expectedPreview && !conflict.stderr.includes("team deploy"), conflict.out);
  if (command === expectedPreview && process.platform !== "win32") {
    const preview = spawnSync("sh", ["-c", `cli=$1\ncotal() { "$0" "$cli" "$@"; }\n${command}`, process.execPath, CLI],
      { cwd: s, env, encoding: "utf8", timeout: 180_000 });
    check("the printed command previews the intended manifest in a POSIX shell",
      preview.status === 0 && preview.stdout.includes("#alerts"), preview);
  }

  console.log("\nG. a fresh boot's records in words");
  check("space create prepares folder b", cotal(b, "space", "create", SPACE_B).status === 0);
  const priorBootNotice = "This stopped root records an earlier team boot";
  const firstPreview = cotal(b, "team", "boot", "boot.yaml", "--dry-run", "--json");
  check("a newly prepared root previews without an earlier boot blocker", answered(firstPreview) &&
    !envelope(firstPreview.stdout)?.warnings?.some((warning) => warning.code === "LIFECYCLE_BLOCKED"), firstPreview.out);
  checkFreshBootAddressConflict();
  bUp = true;
  const booted = cotal(c, "team", "boot", "../boot project/boot.yaml", "--plain");
  check("the retry starts the fresh stack on the new address and names the auth mode in words",
    booted.status === 0 && booted.stdout.split("\n").some((line) => line.trim().replace(/\s+/g, " ") === `Broker: ${SERVER_B}`) &&
    /Auth mode:\s+static auth\n/.test(booted.stdout) && !booted.stdout.includes("static-auth"), booted.out.slice(-1200));
  const bootCommand = booted.stdout.split("\n").map((line) => line.trim()).find((line) => /^(?:pnpm )?cotal team show /.test(line))?.split(/ {2,}/)[0] ?? "";
  const bootArgs = bootCommand.replace(/^(?:pnpm )?cotal /, "").split(" ");
  const bootId = bootArgs[2] ?? "";
  const receiptPreview = booted.stdout.split("\n").find((line) => line.includes("Preview the guarded whole-stack stop"))
    ?.trim().replace(/ {2,}Preview the guarded whole-stack stop$/, "");
  const receiptLaunchers = ["cotal", "pnpm cotal", [process.execPath, CLI].map(shellWord).join(" ")];
  const receiptScoped = receiptLaunchers.some((cli) => receiptPreview === `cd ${shellPath(realpathSync(b))} && ${cli} down --space ${SPACE_B} --dry-run`);
  check("the sibling boot receipt quotes the project root in its scoped stop preview", receiptScoped, booted.stdout);
  if (receiptScoped && process.platform !== "win32") {
    assertSmokeSandboxDown(sandboxes.get(b), ["down", "--space", SPACE_B, "--dry-run"], { cwd: b, env });
    const replayed = spawnSync("sh", ["-c", `cli=$1\ncotal() { "$0" "$cli" "$@"; }\n${receiptPreview}`, process.execPath, CLI],
      { cwd: c, env, encoding: "utf8", timeout: 180_000 });
    check("the copied boot receipt preview works from the sibling without stopping the stack",
      replayed.status === 0 && replayed.stdout.includes("Whole-stack stop plan") && replayed.stdout.includes(SPACE_B) &&
      replayed.stdout.includes("Nothing was stopped or written"), replayed);
  }
  const repeat = cotal(c, "team", "boot", "../boot project/boot.yaml", "--foreground");
  const repeatPreview = repeat.stderr.split("`").find((part) => part.startsWith("cd ") && part.includes("--dry-run"));
  const scopedPreview = `cd ${shellPath(realpathSync(b))} && cotal down --space ${SPACE_B} --dry-run`;
  check("repeating the actual boot refuses without recommending deployment of the cards it seeded",
    repeat.status === 2 && repeat.stderr.includes("LIFECYCLE_BLOCKED") && repeat.stderr.includes(`cotal service --space ${SPACE_B}`) && repeatPreview === scopedPreview &&
      repeat.stderr.includes(`cd ${shellPath(realpathSync(b))} && cotal up --space ${SPACE_B}`) && !repeat.stderr.includes("team deploy"), repeat.out);
  if (repeatPreview === scopedPreview && process.platform !== "win32") {
    assertSmokeSandboxDown(sandboxes.get(b), ["down", "--space", SPACE_B, "--dry-run"], { cwd: b, env });
    const replayed = spawnSync("sh", ["-c", `cli=$1\ncotal() { "$0" "$cli" "$@"; }\n${repeatPreview}`, process.execPath, CLI],
      { cwd: c, env, encoding: "utf8", timeout: 180_000 });
    check("the printed stop preview works from the sibling and targets the running stack", replayed.status === 0 && replayed.stdout.includes(SPACE_B), replayed);
  }
  check("the printed inspection and stop preview both work while the booted stack runs",
    cotal(b, "service", "--space", SPACE_B).status === 0 && cotal(b, "down", "--dry-run").status === 0);
  const freshShow = cotal(b, "team", "show", bootId);
  check("team show <boot id> names its kind, state, next action and auth mode in words",
    /Kind:\s+fresh boot\n/.test(freshShow.stdout) && /Auth mode:\s+static auth\n/.test(freshShow.stdout) && /Recorded state:\s+boot returned\n/.test(freshShow.stdout) &&
      /Next action:\s+inspect the stack\n/.test(freshShow.stdout) && !/broker-boot-returned|inspect-selected-stack/.test(freshShow.stdout), freshShow.stdout);
  check("team show <boot id> offers the stack's own down preview, with no placeholder",
    freshShow.stdout.includes(`cotal down --space ${SPACE_B} --dry-run  Preview the guarded whole-stack stop`) && !/<recorded-space>|in this source/.test(freshShow.stdout), freshShow.stdout);
  const removeBoot = cotal(b, "team", "remove", bootId, "--dry-run", "--json");
  const bootRefusal = envelope(removeBoot.stdout)?.error;
  check("team remove <boot id> refuses CONFLICT and offers cotal down with the space filled in",
    removeBoot.status === 2 && bootRefusal?.code === "CONFLICT" && bootRefusal.remedy === `stop the booted stack with \`cotal down\`; preview that stop with \`cotal down --space ${SPACE_B} --dry-run\``, removeBoot.out.slice(-800));
  const applyBoot = cotal(b, "team", "remove", bootId, "--yes", "--json");
  check("team remove <boot id> --yes gives the same fresh boot refusal and remedy as dry-run",
    applyBoot.status === 2 && JSON.stringify(envelope(applyBoot.stdout)?.error) === JSON.stringify(bootRefusal), applyBoot.out);
  const away = cotal(c, "team", "remove", bootId, "--space", SPACE_B, "--yes", "--json");
  const awayRefusal = envelope(away.stdout)?.error;
  const atBootRoot = `cd '${realpathSync(b)}' && `;
  check("team remove from another folder offers both down commands at the quoted boot root",
    away.status === 2 && awayRefusal?.code === "CONFLICT" && awayRefusal.remedy === `stop the booted stack with \`${atBootRoot}cotal down\`; preview that stop with \`${atBootRoot}cotal down --space ${SPACE_B} --dry-run\``, away.out);
  const freshJson = envelope(cotal(b, "team", "show", bootId, "--json").stdout)?.result;
  check("its JSON keeps the recorded values", freshJson?.recordedState === "broker-boot-returned" && freshJson.nextAction === "inspect-selected-stack" && freshJson.authMode === "auth", freshJson);
  const freshList = cotal(b, "team");
  check("the inventory row names them in words", new RegExp(`${bootId}\\s+fresh boot\\s+boot returned\\s+inspect the stack`).test(freshList.stdout), freshList.stdout);
  const runningPreview = cotal(b, "team", "boot", "boot.yaml", "--dry-run");
  check("the running boot preview names the auth mode without claiming a completed stop", runningPreview.status === 0 &&
    /Auth mode request:\s+static auth\n/.test(runningPreview.stdout) && !runningPreview.out.includes(priorBootNotice), runningPreview.out);
  const stopped = cotal(b, "down", "--yes");
  const applyStoppedBoot = cotal(b, "team", "remove", bootId, "--space", SPACE_B, "--yes", "--json");
  check("the fresh boot refusal and remedy are unchanged after the separate whole-stack stop",
    stopped.status === 0 && /Controller stack stopped/.test(stopped.stdout) && applyStoppedBoot.status === 2 &&
      JSON.stringify(envelope(applyStoppedBoot.stdout)?.error) === JSON.stringify(bootRefusal), { down: stopped.out, remove: applyStoppedBoot.out });
  const stoppedPreview = cotal(b, "team", "boot", "boot.yaml", "--dry-run", "--plain");
  check("the stopped boot preview names the blocker even with a matched summary", reported(stoppedPreview, priorBootNotice) &&
    new RegExp(`${bootId}\\s+${SPACE_B}\\s+matched`).test(stoppedPreview.stdout), stoppedPreview.out);
  manifest("changed-boot.yaml", SPACE_B, { changed: "    deliveryClass: live\n" }, { dir: b, server: SERVER_B });
  const changedPreview = cotal(b, "team", "boot", "changed-boot.yaml", "--dry-run", "--json");
  const changedReceipt = envelope(changedPreview.stdout);
  check("a changed manifest still previews the earlier boot blocker in JSON with no effect", answered(changedPreview) &&
    changedReceipt?.result?.effectAttempted === false && changedReceipt.warnings?.some((warning) =>
      warning.code === "LIFECYCLE_BLOCKED" && warning.target.space === SPACE_B && warning.target.root === realpathSync(b) &&
      warning.message.includes(priorBootNotice)) === true, changedPreview.out);
  // A stopped stack that carried a team is not booted with another one. The refusal names the
  // earlier boot's ID and space, and cotal up, which starts that stack again.
  const again = cotal(b, "team", "boot", "boot.yaml", "--json");
  const againRefusal = envelope(again.stdout);
  check("a second team boot after down refuses LIFECYCLE_BLOCKED and scopes the earlier boot inspection",
    stopped.status === 0 && again.status === 2 && againRefusal?.target?.space === SPACE_B && againRefusal.error?.code === "LIFECYCLE_BLOCKED" &&
      againRefusal.error.remedy === `start this stack again with \`cotal up\` in ${realpathSync(b)}, or inspect the earlier boot with \`cotal team show ${bootId} --space ${SPACE_B}\``, { down: stopped.out.slice(-400), again: again.out.slice(-800) });
  const selectedForRefusal = cotal(s, "use", SPACE);
  check("another space is selected while the booted stack is stopped", selectedForRefusal.status === 0 &&
    envelope(cotal(b, "use", "--json").stdout)?.result?.current === SPACE, selectedForRefusal.out);
  try {
    const plain = cotal(b, "team", "boot", "boot.yaml", "--plain");
    const inspection = plain.stderr.split("`").find((part) => /^(?:pnpm )?cotal team show /.test(part));
    const scoped = ["cotal", "pnpm cotal"].some((cli) => inspection === `${cli} team show ${bootId} --space ${SPACE_B}`);
    check("the plain refusal prints a team show command for the stopped space",
      plain.status === 2 && plain.stderr.includes("LIFECYCLE_BLOCKED") && scoped, plain.out);
    if (inspection && scoped) {
      const replay = cotal(b, ...inspection.replace(/^(?:pnpm )?cotal /, "").split(" "));
      check("the printed inspection finds the earlier boot without changing the saved selection",
        replay.status === 0 && replay.stdout.includes("Recorded fresh boot") && replay.stdout.includes(bootId) &&
        envelope(cotal(b, "use", "--json").stdout)?.result?.current === SPACE, replay.out);
    }
  } finally { cotal(b, "use", "--clear"); }
  const restarted = cotal(b, "up");
  check("cotal up there starts that stack again", restarted.status === 0 && /Controller stack started/.test(restarted.stdout), restarted.out.slice(-800));
  const additiveShow = cotal(s, "team", "show", deployment);
  check("an additive team show names its state and auth mode in words",
    /Auth mode:\s+static auth\n/.test(additiveShow.stdout) && /Recorded state:\s+channels created\n/.test(additiveShow.stdout), additiveShow.stdout);

  console.log("\nH. a deployment ID that no record names");
  const missing = (run: ReturnType<typeof cotal>, message: string, list = "cotal team --json") => {
    const error = envelope(run.stdout)?.error;
    return run.status === 2 && error?.code === "TARGET_NOT_FOUND" && error.message === message && error.remedy === `list the deployments recorded here with \`${list}\``;
  };
  const unknown = "0000000000000000";
  check("a missing team shown from another project names the selected inventory in JSON", missing(cotal(b, "team", "show", unknown, "--space", SPACE, "--json"), `no team deployment "${unknown}" is recorded in this root`, `cotal team --space ${SPACE} --json`));
  check("team show <garbage> is TARGET_NOT_FOUND and says what an ID looks like", missing(cotal(s, "team", "show", "nonsense", "--json"), `no team deployment "nonsense" is recorded in this root; a deployment ID is 16 hex characters`));
  check("team remove <unknown id> --dry-run is TARGET_NOT_FOUND", missing(cotal(s, "team", "remove", unknown, "--dry-run", "--json"), `no team deployment "${unknown}" is recorded in this root`));
  check("team remove <unknown id> --yes is TARGET_NOT_FOUND, not a route it does not support", missing(cotal(s, "team", "remove", unknown, "--yes", "--json"), `no team deployment "${unknown}" is recorded in this root`));

  console.log("\nI. another space's manifest in this folder");
  const other = cotal(s, "team", "boot", "other.yaml", "--dry-run");
  check("the boot preview says this folder belongs to the running space", other.status === 0 && new RegExp(`Root source:\\s+this folder, which belongs to "${SPACE}"\\n`).test(other.stdout), other.stdout.slice(0, 900));
  check("its hint says the apply needs the space's own folder, with no placeholder",
    other.stdout.includes(`the apply refuses until "${OTHER}" has its own folder: prepare one with \`cotal space create ${OTHER} --root <project-directory>\``) && !other.stdout.includes("--root ."), other.stdout.slice(-900));
  const otherJson = envelope(cotal(s, "team", "boot", "other.yaml", "--dry-run", "--json").stdout)?.result;
  check("its JSON root source is invoking-folder-of-other-space", otherJson?.rootSource === "invoking-folder-of-other-space", otherJson?.rootSource);
  const unprepared = cotal(c, "team", "boot", "other.yaml", "--dry-run");
  check("in a folder prepared for no space, the preview says so and names --root . with the space filled in",
    unprepared.status === 0 && /Root source:\s+this folder, not prepared\n/.test(unprepared.stdout) && unprepared.stdout.includes(`the apply refuses until "${OTHER}" is prepared: prepare this folder with \`cotal space create ${OTHER} --root .\``), unprepared.stdout.slice(-900));

  console.log("\nJ. the stack that took a team deploy, after a clean down");
  const stoppedS = cotal(s, "down", "--yes");
  for (const flags of [["--dry-run"], []]) {
    const run = cotal(s, "team", "deploy", "extra.yaml", ...flags, "--json");
    const refusal = envelope(run.stdout);
    check(`team deploy ${flags[0] ?? "apply"} names the stopped stack and its restart command`,
      run.status === 2 && refusal?.error?.code === "TARGET_UNAVAILABLE" && refusal.error.message?.includes("local stack is stopped") === true &&
      refusal.target?.root === realpathSync(s) && refusal.error.remedy === `start it again with \`cotal up\` in ${realpathSync(s)}`, run.out);
  }
  const legacyPreview = ["up", "-f", "live.yaml", "--dry-run"];
  const previewRemedy = `cotal team boot ${join(realpathSync(s), "live.yaml")} --dry-run`;
  const blockedPreview = cotal(s, ...legacyPreview, "--json");
  const previewError = envelope(blockedPreview.stdout)?.error;
  check("up -f --dry-run --json on the stopped controller stack refuses CONFLICT and names the team boot preview",
    stoppedS.status === 0 && blockedPreview.status === 2 && previewError?.code === "CONFLICT"
      && previewError.message?.includes(`holds the controller stack of space ${SPACE}`) === true
      && previewError.remedy?.includes(previewRemedy) === true && !previewError.remedy.includes("omit --json"), blockedPreview.out);
  for (const flags of [[], ["--plain"]]) {
    const refusedPreview = cotal(s, ...legacyPreview, ...flags);
    check(`up -f --dry-run ${flags[0] ?? "in rich output"} names the same conflict and preview`,
      refusedPreview.status === 2 && /Code:\s+CONFLICT/.test(refusedPreview.stderr)
        && refusedPreview.stderr.includes(previewRemedy), refusedPreview.out);
  }
  const supportedPreview = cotal(s, "team", "boot", "live.yaml", "--dry-run", "--json");
  check("the suggested team boot preview still works on the stopped controller root",
    answered(supportedPreview) && envelope(supportedPreview.stdout)?.result?.effectAttempted === false, supportedPreview.out);
  const removeStopped = cotal(s, "team", "remove", deployment, "--space", SPACE, "--dry-run", "--json");
  const removeStoppedError = envelope(removeStopped.stdout)?.error;
  const retry = removeStoppedError?.remedy?.match(/then run `([^`]+)` again$/)?.[1];
  const expectedRetry = `cotal team remove ${deployment} --space ${SPACE} --dry-run --json`;
  check("the stopped JSON removal preview names the restart and preserves the scoped preview",
    stoppedS.status === 0 && removeStopped.status === 2 && removeStoppedError?.code === "CONFLICT" &&
    removeStoppedError.remedy === `no registration names ${SPACE}, as after \`cotal down\`; start the stack again with \`cotal up\` in ${realpathSync(s)}, which registers it, then run \`${expectedRetry}\` again`, removeStopped.out);
  const removeStoppedPlain = cotal(s, "team", "remove", deployment, "-s", SPACE, "--dry-run", "--plain");
  check("the stopped plain removal preview keeps the scope, dry run and plain output",
    removeStoppedPlain.status === 2 && ["cotal", "pnpm cotal"].some((cli) =>
      removeStoppedPlain.stderr.includes(`\`${cli} team remove ${deployment} --space ${SPACE} --dry-run --plain\``)), removeStoppedPlain.out);
  const restartedS = cotal(s, "up");
  const kept = cotal(s, "team", "show", deployment);
  check("a bare up starts that stack again and keeps the deployment's records as they are",
    restartedS.status === 0 && /Controller stack started/.test(restartedS.stdout) && /Recorded state:\s+channels created\n/.test(kept.stdout), { up: restartedS.out.slice(-800), kept: kept.out.slice(-800) });
  if (retry === expectedRetry) {
    const resumed = cotal(s, ...retry.split(" ").slice(1));
    const result = envelope(resumed.stdout)?.result;
    const card = cotal(s, "channel", "show", "live1", "--space", SPACE, "--json");
    const registry = envelope(card.stdout)?.result?.registry as { channels?: Record<string, unknown> } | undefined;
    check("replaying the retry completes a read-only JSON preview and leaves the card present",
      answered(resumed) && result?.kind === "channel-team-removal-preview" && result.effectAttempted === false &&
      result.historyPurged === false && card.status === 0 && Object.hasOwn(registry?.channels ?? {}, "live1"), { retry: resumed.out, card: card.out });
  }
  check("team deploy succeeds after restarting the recorded stack", cotal(s, "team", "deploy", "extra.yaml", "--json").status === 0);
  const edited = cotal(s, "channel", "set", "live1", "--desc", "Edited by hand.");
  const removeEdited = envelope(cotal(s, "team", "remove", deployment, "--dry-run", "--json").stdout)?.error;
  check("team remove after a card was edited refuses CONFLICT naming that card",
    edited.status === 0 && removeEdited?.code === "CONFLICT" && removeEdited.message === "the card #live1 changed after this deployment created it; changed metadata is not owned and no card was deleted", { edited: edited.out.slice(-400), removeEdited });
  const editedPreview = cotal(s, "team", "deploy", "live.yaml", "--dry-run", "--json");
  const editedResult = envelope(editedPreview.stdout);
  const editedChannels = (editedResult?.result?.native as { channels?: unknown } | undefined)?.channels;
  check("preview verifies the unchanged card but does not claim the edited card",
    answered(editedPreview) && JSON.stringify(editedChannels) === JSON.stringify({ create: [], owned: ["live2"], existsUnmanaged: [], existsUnmanagedPolicy: [] }) &&
      editedResult?.warnings?.some((warning) => warning.code === "CURRENT_CHANNEL_STATE_UNCHECKED" && JSON.stringify(warning.target.cards) === '["live1"]') === true, editedPreview.out);

  console.log("\nK. a card removal's steps in the order they were written");
  const ordered = envelope(cotal(s, "team", "deploy", "order.yaml", "--json").stdout)?.result?.deploymentId;
  const orderedId = String(ordered);
  const removedOrder = cotal(s, "team", "remove", orderedId, "--yes");
  const orderShow = cotal(s, "team", "show", orderedId);
  const steps = (envelope(cotal(s, "team", "show", orderedId, "--json").stdout)?.result?.channelRemoval as { steps?: { name: string; phase: string }[] } | undefined)?.steps ?? [];
  const expected = Array.from({ length: 11 }, (_, n) => [`order${n}:submitted`, `order${n}:deleted`]).flat();
  check("team show lists each removed card's submission before its outcome, the cards in manifest order",
    typeof ordered === "string" && removedOrder.status === 0 && JSON.stringify(steps.map((step) => `${step.name}:${step.phase}`)) === JSON.stringify(expected), { remove: removedOrder.out.slice(-600), steps });
  const rows = orderShow.stdout.split("\n").filter((line) => /^\s+#order\d+\s/.test(line)).map((line) => line.trim().replace(/\s+/g, " "));
  check("  and its text ends each card on its deletion, not on the submitted step",
    orderShow.status === 0 && rows.at(-1)?.startsWith("#order10 deleted at created revision") === true && rows.indexOf("#order0 delete submitted; outcome not implied none") < rows.findIndex((row) => row.startsWith("#order0 deleted at created revision")), rows);

  checkInvalidLaunchName();

  console.log("\nL. live delivery guidance on an open mesh");
  check("space create prepares the open project", cotal(c, "space", "create", OTHER).status === 0);
  openUp = true;
  const openStarted = cotal(c, "up", "--open", "--server", SERVER_OTHER);
  check("up starts the open stack", openStarted.status === 0, openStarted.out);
  if (openStarted.status !== 0) throw new Error("the open stack did not start");

  const openOptions = { dir: c, server: SERVER_OTHER };
  manifest("audit.yaml", OTHER, { "audit-team": "" }, openOptions);
  const openRefused = cotal(c, "team", "deploy", "audit.yaml", "--json");
  const openError = envelope(openRefused.stdout)?.error;
  const openRemedy = "set `deliveryClass: live` on each card. Durable channels require a different authenticated mesh with a delivery service";
  check("open apply names the live manifest fix and does not suggest a durable channel command",
    openRefused.status === 2 && openError?.code === "UNSUPPORTED" && openError.remedy === openRemedy, openRefused.out);
  const mixedRefused = cotal(c, "team", "deploy", "claude.yaml", "--json");
  const mixedError = envelope(mixedRefused.stdout)?.error;
  check("open mixed apply gives the same remedy before requesting a launch",
    mixedRefused.status === 2 && mixedError?.code === "UNSUPPORTED" && mixedError.remedy === openRemedy, mixedRefused.out);
  const openPreview = cotal(c, "team", "deploy", "audit.yaml", "--dry-run", "--json");
  const openWarning = envelope(openPreview.stdout)?.warnings?.find((w) => w.code === "LIVE_DELIVERY_REQUIRED");
  check("open preview offers the same guidance", openPreview.status === 0 && openWarning?.message.endsWith(`${openRemedy}.`) === true, openPreview.out);

  manifest("audit.yaml", OTHER, { "audit-team": "    deliveryClass: durable\n" }, openOptions);
  const durablePreview = cotal(c, "team", "deploy", "audit.yaml", "--dry-run", "--json");
  const durableWarning = envelope(durablePreview.stdout)?.warnings?.find((w) => w.code === "LIVE_DELIVERY_REQUIRED");
  const durableApply = cotal(c, "team", "deploy", "audit.yaml", "--json");
  const durableRefusal = envelope(durableApply.stdout);
  check("open apply names the explicit durable card and gives the same remedy as preview",
    durablePreview.status === 0 && durableWarning?.message.startsWith("Apply refuses: #audit-team does not set deliveryClass: live.") === true &&
      durableWarning.message.endsWith(`${openRemedy}.`) && JSON.stringify(durableWarning.target.cards) === JSON.stringify(["audit-team"]) &&
      durableApply.status === 2 && durableRefusal?.outcome === "refused" && durableRefusal.error?.code === "UNSUPPORTED" &&
      durableRefusal.error.message?.includes("#audit-team does not set deliveryClass: live") === true && durableRefusal.error.remedy === openRemedy &&
      JSON.stringify(durableRefusal.target?.cards) === JSON.stringify(durableWarning.target.cards), { preview: durablePreview.out, apply: durableApply.out });
  const shownCard = cotal(c, "channel", "show", "audit-team", "--json");
  const shownRegistry = envelope(shownCard.stdout)?.result?.registry as { channels?: Record<string, unknown> } | undefined;
  check("the refused apply did not create the durable card",
    shownCard.status === 0 && shownRegistry?.channels !== undefined && !Object.hasOwn(shownRegistry.channels, "audit-team"), shownCard.out);

  for (const server of [SERVER, SERVER_OTHER.replace("nats:", "tls:")]) {
    manifest("audit.yaml", OTHER, { "audit-team": "    deliveryClass: live\n" }, { ...openOptions, server });
    for (const flags of [["--dry-run"], []]) {
      const run = cotal(c, "team", "deploy", "audit.yaml", ...flags, "--json");
      check(`team deploy ${flags[0] ?? "apply"} refuses a different port or transport (${server})`,
        run.status === 2 && envelope(run.stdout)?.error?.code === "CONFLICT", run.out);
    }
  }
  manifest("audit.yaml", OTHER, { "audit-team": "    deliveryClass: live\n" }, { ...openOptions, head: "defaults: {replay: false}\n" });
  const defaultsRefused = cotal(c, "team", "deploy", "audit.yaml", "--json");
  const defaultsError = envelope(defaultsRefused.stdout)?.error;
  check("channel-only apply still refuses a declared default of false",
    defaultsRefused.status === 2 && defaultsError?.code === "UNSUPPORTED" && defaultsError.message?.includes("space defaults") === true, defaultsRefused.out);

  manifest("audit.yaml", OTHER, { "audit-team": "    deliveryClass: live\n" }, { ...openOptions, head: "defaults: {}\n", server: SERVER_OTHER.replace("nats:", "NATS:") + "/" });
  const foreignFile = "../open project/audit.yaml", registeredRoot = realpathSync(c);
  const checkoutHint = `Apply from the registered project root ${registeredRoot}.`;
  const siblingPreview = cotal(s, "team", "deploy", foreignFile, "--dry-run", "--plain");
  check("a sibling checkout can preview the channel and sees where apply must run",
    reported(siblingPreview, checkoutHint) && /New channel candidates:\s+1/.test(siblingPreview.stdout), siblingPreview.out);
  const siblingApply = cotal(s, "team", "deploy", foreignFile, "--space", OTHER, "--json");
  const checkoutError = envelope(siblingApply.stdout)?.error;
  check("a sibling checkout still refuses apply and gives an exact, quoted retry",
    siblingApply.status === 2 && checkoutError?.code === "CONFLICT" && checkoutError.message?.includes(registeredRoot) === true &&
    checkoutError.remedy === `cd '${registeredRoot}' && cotal team deploy '${join(c, "audit.yaml")}' --space ${OTHER} --json`, siblingApply.out);
  const localPreview = cotal(c, "team", "deploy", "audit.yaml", "--dry-run", "--plain");
  check("the registered checkout still previews without a checkout hint",
    localPreview.status === 0 && !localPreview.out.includes(checkoutHint) && /New channel candidates:\s+1/.test(localPreview.stdout), localPreview.out);
  check("team deploy preview accepts an equivalent broker URL", answered(cotal(c, "team", "deploy", "audit.yaml", "--dry-run", "--json")));
  manifest("host.yaml", OTHER, { "host-team": "    deliveryClass: live\n" }, { ...openOptions, open: true, head: "  host: 127.0.0.1\n" });
  const hostPreview = envelope(cotal(c, "team", "deploy", "host.yaml", "--dry-run", "--json").stdout);
  const hostNative = hostPreview?.result?.native as { channels?: { create?: unknown[] } } | undefined;
  const hostWarning = hostPreview?.warnings?.find((warning) => warning.code === "MANIFEST_WARNING" && warning.message.includes("broker.host"));
  check("team deploy --dry-run warns that broker.host makes apply refuse and lists no creation candidates",
    hostPreview?.result?.kind === "additive-team-deploy-preview" && hostNative?.channels?.create?.length === 0 &&
    hostWarning?.message.includes("Omit broker.host") === true, hostPreview?.warnings);
  const hostText = cotal(c, "team", "deploy", "host.yaml", "--dry-run");
  check("the text preview prints the broker.host warning on stderr",
    hostText.status === 0 && hostText.stderr.includes("! Apply refuses: broker.host declares a broker bind"), hostText.stderr);
  const hostApply = cotal(c, "team", "deploy", "host.yaml", "--json");
  const hostRefusal = envelope(hostApply.stdout);
  check("team deploy still refuses broker.host with UNSUPPORTED and creates no card",
    hostApply.status === 2 && hostRefusal?.error?.code === "UNSUPPORTED" && hostRefusal.error.message?.includes("broker bind") === true &&
    !Object.hasOwn((envelope(cotal(c, "channel", "show", "host-team", "--space", OTHER, "--json").stdout)?.result?.registry as { channels?: Record<string, unknown> } | undefined)?.channels ?? {}, "host-team"), hostApply.out);
  const chosen = cotal(b, "use", SPACE_B);
  const selection = envelope(cotal(c, "use", "--json").stdout)?.result;
  check("the saved selection differs from the deployment's space", chosen.status === 0 && selection?.current === SPACE_B && selection.folder === OTHER, selection);
  const openApplied = cotal(c, "team", "deploy", "audit.yaml", "--space", OTHER, "--plain");
  const openId = /^\s*Deployment:\s+([a-f0-9]{16})$/m.exec(openApplied.stdout)?.[1];
  const revision = /^\s*#audit-team\s+(\d+)$/m.exec(openApplied.stdout)?.[1];
  check("team deploy accepts empty defaults and an equivalent broker URL and creates the live card on the open mesh",
    openApplied.status === 0 && openId !== undefined && revision !== undefined, openApplied.out);
  if (!openId) throw new Error("the open deployment did not return a full ID");
  manifest("audit.yaml", OTHER, { "audit-team": "    deliveryClass: live\n" }, { ...openOptions, open: true });
  const bootWhileRetained = cotal(c, "team", "boot", "audit.yaml", "--space", OTHER, "--dry-run", "--json");
  check("fresh boot preview warns about the unremoved deployment",
    answered(bootWhileRetained) && envelope(bootWhileRetained.stdout)?.warnings?.some((warning) =>
      warning.code === "ADDITIVE_ATTEMPT_REMAINS" && JSON.stringify(warning.target.deploymentIds) === JSON.stringify([openId])) === true, bootWhileRetained.out);

  console.log("\nM. deployment lookup and confirmation commands pin the target space");
  const showCommand = openApplied.stdout.split("\n").map((line) => line.trim()).find((line) => /^(?:pnpm )?cotal team show /.test(line))?.split(/ {2,}/)[0];
  check("the printed team show command pins the deployment's space",
    ["cotal", "pnpm cotal"].some((launcher) => showCommand === `${launcher} team show ${openId} --space ${OTHER}`), openApplied.out);
  const showArgs = showCommand?.split(" ").slice(showCommand.startsWith("pnpm ") ? 2 : 1) ?? [];
  const deploymentShow = cotal(c, ...showArgs, "--json");
  const shownDeployment = envelope(deploymentShow.stdout);
  const recordedReceipt = shownDeployment?.result?.receipt as { createdChannels?: unknown } | undefined;
  check("team show with the receipt's space returns the original card revisions without changing the selection",
    answered(deploymentShow) && shownDeployment?.target?.space === OTHER && shownDeployment.target.deploymentId === openId &&
    JSON.stringify(recordedReceipt?.createdChannels) === JSON.stringify([{ name: "audit-team", revision: Number(revision) }]) &&
    envelope(cotal(c, "use", "--json").stdout)?.result?.current === SPACE_B, deploymentShow.out);
  checkRemovalConfirmation(openId);
  const afterRemovalSelection = envelope(cotal(c, "use", "--json").stdout)?.result;
  check("removal scoped to the deployment space leaves the saved selection unchanged",
    afterRemovalSelection?.current === SPACE_B, afterRemovalSelection);

  const openDown = cotal(c, "down", "--yes");
  if (openDown.status === 0) openUp = false;
  const bootAfterRemoval = cotal(c, "team", "boot", "audit.yaml", "--foreground", "--dry-run", "--json");
  const bootResult = envelope(bootAfterRemoval.stdout);
  const history = bootResult?.result?.additiveAttempts;
  check("fresh boot preview keeps the removed deployment as history without a blocker warning",
    openDown.status === 0 && answered(bootAfterRemoval) &&
      Array.isArray(history) && history.some((row) => row.deploymentId === openId && row.recordedState === "removal-returned") &&
      !bootResult?.warnings?.some((warning) => warning.code === "ADDITIVE_ATTEMPT_REMAINS"), { down: openDown.out, preview: bootAfterRemoval.out });
  const unreadable = join(realpathSync(c), ".cotal", "team-deploy-attempt-abcdef0123456789.json");
  writeFileSync(unreadable, "{\n", { mode: 0o600 });
  try {
    const bootUnreadable = cotal(c, "team", "boot", "audit.yaml", "--dry-run", "--json");
    check("an unreadable attempt still warns after a different deployment was removed",
      answered(bootUnreadable) && envelope(bootUnreadable.stdout)?.warnings?.some((warning) => warning.code === "ADDITIVE_ATTEMPT_REMAINS" &&
        JSON.stringify(warning.target.deploymentIds) === "[]" && JSON.stringify(warning.target.unreadable) === JSON.stringify([unreadable])) === true, bootUnreadable.out);
  } finally { rmSync(unreadable); }

  console.log("\nN. the printed launch-summary command pins the boot space");
  const selected = cotal(s, "use", SPACE);
  check("the saved selection differs from the boot space", selected.status === 0 &&
    envelope(cotal(b, "use", "--json").stdout)?.result?.current === SPACE, selected.out);
  try {
    const replay = cotal(b, ...bootArgs);
    check("the printed launch-summary command finds the boot without changing the saved selection",
      /^[0-9a-f]{16}$/.test(bootId) && ["cotal", "pnpm cotal"].some((launcher) => bootCommand === `${launcher} team show ${bootId} --space ${SPACE_B}`) &&
      replay.status === 0 && /^\s+Deployment:\s+([0-9a-f]{16})$/m.exec(replay.stdout)?.[1] === bootId &&
      envelope(cotal(b, "use", "--json").stdout)?.result?.current === SPACE, { command: bootCommand, replay: replay.out });
  } finally { cotal(b, "use", SPACE_B); }

  const summaries = join(c, ".cotal", "team-summaries");
  mkdirSync(summaries, { recursive: true, mode: 0o700 });
  copyFileSync(join(b, ".cotal", "team-summaries", `${bootId}.json`), join(summaries, `${bootId}.json`));
  for (const args of [["show", bootId], ["remove", bootId, "--dry-run"]]) {
    const copied = cotal(b, "team", ...args, "--space", OTHER, "--json");
    const error = envelope(copied.stdout)?.error;
    check(`team ${args[0]} of a copied summary points status at the folder and space holding the copy`,
      copied.status === 2 && error?.code === "CONFLICT" && error.remedy?.includes(`\`cd '${realpathSync(c)}' && cotal status --space=${OTHER}\``) === true, copied.out);
  }
  if (process.platform !== "win32") {
    console.log("\nP. the stack restarts after stopping a returned mixed deployment");
    checkMixedRestart();
  }
} finally {
  if (openUp) {
    const down = cotal(c, "down", "--yes");
    check("down --yes stops the open stack", down.status === 0, down.out.slice(-600));
  }
  if (bUp) {
    const down = cotal(b, "down", "--yes");
    check("down --yes stops the stack in b", down.status === 0, down.out.slice(-600));
  }
  if (up) {
    const down = cotal(s, "down", "--yes", "--with-agents");
    check("down stops the static-auth stack", down.status === 0, down.out.slice(-600));
  }
  rmSync(base, { recursive: true, force: true });
}
finish();
