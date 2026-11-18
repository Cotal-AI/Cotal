/** Shipped-entry coverage for rejected credential joins, using isolated local stacks. */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, killAndAwaitExit, recordSmokeSandbox, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";
import { clean, nodePty, wait, type Pty } from "./_console-pty.js";

const tree = resolve(import.meta.dirname, "../../..");
const entry = join(tree, "bin/dist/cotal.js");
const dir = mkdtempSync(join(tmpdir(), "join-credential-rejection-"));
const home = join(dir, "home"), alpha = join(dir, "alpha"), beta = join(dir, "beta"), keys = join(dir, "keys");
const config = join(dir, "config"), runtime = join(dir, "runtime"), cotal = join(dir, "cotal"), neutral = join(dir, "neutral");
for (const path of [home, alpha, beta, keys, config, runtime, cotal, neutral, join(neutral, ".cotal")]) mkdirSync(path, { mode: 0o700 });
const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((row): row is [string, string] => row[1] !== undefined && !row[0].startsWith("COTAL_")));
Object.assign(env, { HOME: home, COTAL_HOME: cotal, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1" });
const { check, finish } = createSuite();
const anchors = new Map<string, SmokeSandboxAnchor>();
const terminals = new Set<Pty>();
const children = new Set<ChildProcess>();
type Envelope = { result?: { lifecycleUid?: string }; error?: { code?: string; message?: string; remedy?: string }; target?: { space?: string; path?: string } };
function cli(cwd: string, ...args: string[]) {
  const options = { cwd, env, encoding: "utf8" as const, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 };
  assertSmokeSandboxDown(anchors.get(cwd), args, options);
  const run = spawnSync(process.execPath, [entry, ...args], options);
  assert.ifError(run.error);
  assert.equal(run.signal, null, "CLI must exit without a signal");
  const envelope = args.includes("--json") ? JSON.parse(run.stdout) as Envelope : undefined;
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, envelope };
}
function ok(cwd: string, ...args: string[]) {
  const run = cli(cwd, ...args);
  assert.equal(run.status, 0, `${args[0]} failed: ${run.stderr || run.stdout}`);
  return run;
}
async function until(test: () => boolean) {
  const deadline = Date.now() + 45_000;
  while (!test() && Date.now() < deadline) await wait(50);
  assert.ok(test(), "terminal did not reach its expected state");
}
function mint(root: string, space: string, name: string) {
  const file = join(keys, `${name}.creds`);
  const run = ok(root, "auth", "mint", name, "--space", space, "--provision", "--allow-subscribe", "general", "--allow-publish", "general", "--role", "reviewer", "--out", file, "--json");
  const uid = run.envelope?.result?.lifecycleUid;
  assert.ok(uid, "provisioning mint must report its lifecycle UID");
  return { file, uid };
}
async function rejected(label: string, credential: { file: string; uid: string }, diagnosis: string, ...flags: string[]) {
  const run = cli(alpha, "join", "--space", "alpha", "--name", "alice", "--channel", "general", "--creds", credential.file, "--lifecycle-uid", credential.uid, ...flags);
  console.log(`OBSERVED ${label}: exit ${run.status}\n${run.stderr}`);
  check(`${label}: refused under PERMISSION_DENIED`, run.status === 2 && /Code: +PERMISSION_DENIED/.test(run.stderr), run);
  check(`${label}: names target space and recorded diagnosis`, /Space: +alpha/.test(run.stderr) && run.stderr.includes(diagnosis), run.stderr);
  check(`${label}: replacement mint provisions a new lifecycle`, /cotal auth mint <label>[^`]*--provision/.test(run.stderr) && /lifecycle UID.*mint reports/.test(run.stderr), run.stderr);
  check(`${label}: replacement keeps read, post and role grants`, run.stderr.includes("--allow-subscribe general --allow-publish general --role reviewer --no-persona"), run.stderr);
  check(`${label}: no raw broker stack`, !/at Object\.|Authorization Violation|Permissions Violation/.test(run.stderr), run.stderr);
  const control = cli(alpha, "send", "-c", "general", "control", "--space", "alpha", "--creds", credential.file, "--json", ...flags);
  check(`${label}: one-shot control already diagnoses the same rejection`, control.status === 2 && control.envelope?.error?.code === "PERMISSION_DENIED" && control.envelope.error.message?.includes(diagnosis) === true && control.envelope.target?.space === "alpha", control.envelope?.error);
  const command = /`cotal auth mint ([^`]+)`/.exec(run.stderr)?.[1];
  if (command) {
    const file = join(keys, `repair-${label}.creds`);
    const args = command.replace("<label>", `repair_${label.replaceAll("-", "_")}`).replace(/<new file>|<file>/, file).split(" ");
    const repair = ok(alpha, "auth", "mint", ...args, "--json");
    const uid = repair.envelope?.result?.lifecycleUid;
    assert.ok(uid, "the suggested mint must report a lifecycle UID");
    await valid({ file, uid });
  }
}
async function valid(credential: { file: string; uid: string }, space = "alpha", flags: readonly string[] = ["--space", space]) {
  const proc = nodePty([entry, "join", ...flags, "--name", "alice", "--channel", "general", "--creds", credential.file, "--lifecycle-uid", credential.uid], { cwd: alpha, env, cols: 240 });
  terminals.add(proc);
  let out = "", code: number | undefined;
  proc.onData((chunk) => { out += chunk; });
  proc.onExit((result) => { code = result.exitCode; terminals.delete(proc); });
  await until(() => clean(out).includes(`Joined ${space} as alice on #general.`) || code !== undefined);
  assert.ok(clean(out).includes(`Joined ${space} as alice on #general.`), clean(out));
  proc.write("/quit\r");
  await until(() => code !== undefined);
  check("valid provisioned credential joins and quits successfully", code === 0, clean(out));
}
async function running(credential: { file: string; uid: string }) {
  const proc = spawn(process.execPath, [entry, "join", "--space", "alpha", "--creds", credential.file, "--lifecycle-uid", credential.uid, "--name", "live"], { cwd: alpha, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(proc);
  let out = "";
  proc.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  proc.stderr.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code) => { children.delete(proc); resolve(code); });
  });
  await until(() => out.includes("holding presence") || proc.exitCode !== null);
  assert.ok(out.includes("holding presence"), out);
  return { proc, exited, output: () => out };
}
const alphaServer = `nats://127.0.0.1:${await freePort()}`;
const betaServer = `nats://127.0.0.1:${await freePort()}`;
try {
  for (const [space, root] of [["alpha", alpha], ["beta", beta]] as const) {
    ok(home, "space", "create", space, "--root", root, "--json");
    anchors.set(root, recordSmokeSandbox({ root, cotalHome: cotal, xdgConfigHome: config }));
  }
  ok(beta, "up", "--no-manager", "--server", betaServer, "--json");
  const foreign = mint(beta, "beta", "foreign");
  ok(beta, "down", "--yes", "--json");
  ok(alpha, "up", "--no-manager", "--server", alphaServer, "--json");
  ok(beta, "up", "--no-manager", "--server", betaServer, "--json");
  const alphaLink = `${alphaServer.replace("nats://", "cotal://")}/alpha`;
  const betaLink = `${betaServer.replace("nats://", "cotal://")}/beta`;
  for (const [label, flags, removed, sameSpace] of [
    ["cross-space link", ["--link", alphaLink], "--link", false],
    ["cross-space server", ["--space", "alpha", "--server", alphaServer], "--server", false],
    ["cross-space both", ["--space", "alpha", "--link", betaLink, "--server", alphaServer], "--server and --link", false],
    ["same-space link", ["--link", `${alphaServer.replace("nats://", "cotal://")}/beta`], "--link", true],
    ["same-space server", ["--space", "beta", "--server", alphaServer], "--server", true],
    ["same-space both", ["--link", betaLink, "--server", alphaServer], "--server and --link", true],
  ] as const) {
    const run = cli(neutral, "join", ...flags, "--creds", foreign.file, "--lifecycle-uid", foreign.uid);
    console.log(`OBSERVED ${label}: exit ${run.status}\n${run.stderr}`);
    const expected = sameSpace
      ? removed === "--server" ? `drop --server to use beta's broker at ${betaServer}, or point --server at it` : `use --space beta without ${removed} to reach beta's broker at ${betaServer}, or pass --server ${betaServer}`
      : `use it with --space beta and without ${removed}, which dials beta's broker at ${betaServer}`;
    check(`${label}: recovery names the actual address flags`, run.status === 2 && /Code: +PERMISSION_DENIED/.test(run.stderr) && run.stderr.includes(expected) && (sameSpace || run.stderr.includes("--provision")), run.stderr);
    const drop = new Set(["--space", ...removed.split(" and ")]);
    const kept: string[] = [];
    for (let i = 0; i < flags.length; i += 2) if (!drop.has(flags[i]!)) kept.push(flags[i]!, flags[i + 1]!);
    await valid(foreign, "beta", ["--space", "beta", ...kept]);
  }
  // A --server override is another actionable recovery while retaining the original link.
  await valid(foreign, "beta", ["--space", "beta", "--link", alphaLink, "--server", betaServer]);
  ok(beta, "down", "--yes", "--json");
  const credentialArgs = ["--creds", foreign.file, "--lifecycle-uid", foreign.uid];
  const unnamed = cli(neutral, "join", "--server", alphaServer, ...credentialArgs);
  console.log(`OBSERVED unnamed explicit server: exit ${unnamed.status}\n${unnamed.stderr}`);
  check("an unnamed explicit-server join identifies only the credential's space", unnamed.status === 2 && /Code: +PERMISSION_DENIED/.test(unnamed.stderr) && unnamed.stderr.includes('is a credential for space "beta"') && !/Space:|not "main"|--space main|cotal auth mint/.test(unnamed.stderr), unnamed.stderr);
  const unnamedControl = cli(neutral, "send", "-c", "general", "control", "--server", alphaServer, "--creds", foreign.file, "--json");
  check("unnamed join and one-shot control give the same diagnosis and recovery", unnamedControl.status === 2 && unnamedControl.envelope?.target?.space === undefined && unnamed.stderr.includes(unnamedControl.envelope?.error?.message ?? "missing message") && unnamed.stderr.includes(unnamedControl.envelope?.error?.remedy ?? "missing remedy"), unnamedControl.envelope);
  for (const [label, cwd, flags, expected] of [
    ["explicit default", neutral, ["--space", "main", "--server", alphaServer], "main"],
    ["folder", alpha, [], "alpha"],
    ["link", neutral, ["--link", `${alphaServer.replace("nats://", "cotal://")}/alpha`], "alpha"],
  ] as const) {
    const run = cli(cwd, "join", ...flags, ...credentialArgs);
    check(`${label} space remains named in rejection and provisioning recovery`, run.status === 2 && run.stderr.includes(`not "${expected}"`) && new RegExp(`Space: +${expected}`).test(run.stderr) && run.stderr.includes(`--space ${expected}`) && run.stderr.includes("--provision"), run.stderr);
  }
  ok(alpha, "use", "alpha", "--json");
  try {
    const selected = cli(neutral, "join", ...credentialArgs);
    check("selected space remains named in rejection and provisioning recovery", selected.status === 2 && /Space: +alpha/.test(selected.stderr) && selected.stderr.includes('not "alpha"') && selected.stderr.includes("--space alpha") && selected.stderr.includes("--provision"), selected.stderr);
  } finally {
    ok(neutral, "use", "--clear", "--json");
  }
  await rejected("cross-space", foreign, 'is a credential for space "beta", not "alpha"');
  await valid(mint(alpha, "alpha", "valid"));
  const revoked = mint(alpha, "alpha", "revoked");
  const live = await running(revoked);
  ok(alpha, "down", "--yes", "--json");
  ok(alpha, "auth", "revoke-credential", revoked.file, "--yes", "--json");
  ok(alpha, "up", "--no-manager", "--json");
  await rejected("revoked", revoked, "with auth revoke-credential");
  const aliasLink = `${alphaServer.replace("nats://127.0.0.1", "cotal://localhost")}/alpha`;
  const aliased = cli(neutral, "join", "--link", aliasLink, "--creds", revoked.file, "--lifecycle-uid", revoked.uid);
  check("revoked credential through an aliased link names link recovery rather than an absent flag", aliased.status === 2 && aliased.stderr.includes(`use --space alpha without --link to reach alpha's broker at ${alphaServer}, or pass --server ${alphaServer}`) && !aliased.stderr.includes("drop --server"), aliased.stderr);
  const aliasRepair = cli(neutral, "join", "--space", "alpha", "--creds", revoked.file, "--lifecycle-uid", revoked.uid);
  check("following aliased-link recovery reaches the registered broker and reports recorded revocation", aliasRepair.status === 2 && aliasRepair.stderr.includes("with auth revoke-credential") && aliasRepair.stderr.includes("--provision"), aliasRepair.stderr);
  await until(() => live.proc.exitCode !== null);
  check("running join ends with its recorded revocation and provisioned recovery", await live.exited === 2 && /Space: +alpha/.test(live.output()) && live.output().includes("with auth revoke-credential") && /cotal auth mint <label>[^`]*--provision/.test(live.output()), live.output());
  const stale = mint(alpha, "alpha", "stale");
  ok(alpha, "down", "--yes", "--json");
  ok(alpha, "reset", "space", "alpha", "--yes", "--json");
  ok(alpha, "up", "--no-manager", "--json");
  await rejected("reset", stale, 'space "alpha" has a different local identity');
  await valid(mint(alpha, "alpha", "fresh"));
} finally {
  for (const terminal of terminals) terminal.kill();
  await until(() => terminals.size === 0);
  for (const child of children) await killAndAwaitExit(child);
  for (const root of [alpha, beta]) if (anchors.has(root)) ok(root, "down", "--yes", "--json");
  console.log(`Retained stopped credential-join sandbox: ${dir}`);
}
finish();
