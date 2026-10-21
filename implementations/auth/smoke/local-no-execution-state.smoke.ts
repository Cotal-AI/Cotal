/** Local NONE capability admission and immutable retained-state refusals through public APIs. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, connect as tcpConnect } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { generateKeyPair, exportJWK } from "jose";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, readdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { connect } from "@nats-io/transport-node";
import { createSpaceAuth, mintCreds, newIdentity, mintLifecycleUid, serverConfig, setupSpaceStreams, isReachable,
  standaloneConnectOpts, registry, actionContext, recordGoalIndex, readGoalIndex, recordAtomicKey, RECORD_KINDS, type RuntimeProvider } from "@cotal-ai/core";
import { authDir, saveSpaceAuth, workspaceSecretStore, userAuthStateDir, recordMesh, assertUserAuthInfo, loadManagerInstanceIdentity, spaceKey } from "@cotal-ai/workspace";
import { cotalAuthProvider } from "@cotal-ai/auth";
import { Manager, type ManagerOptions } from "@cotal-ai/manager";
import { formatSentinel, SMOKE_BROKER_TOKEN, teardownOnSignal, killAndAwaitExit } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";
console.log = () => {}; console.error = () => {};
const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}local-none-state-`));
const home = join(root, "home"); mkdirSync(home);
process.env.COTAL_HOME = home;
const identity = (pid: number) => ({ pid, cwd: readlinkSync(`/proc/${pid}/cwd`), start: readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19] });
const children: ReturnType<typeof identity>[] = [];
const ports: number[] = [];
const checks: string[] = [];
const check = (name: string, condition: unknown) => { assert.ok(condition, name); checks.push(name); process.stdout.write(`PASS ${name}\n`); };
const throws = (name: string, fn: () => unknown, match: RegExp) => { assert.throws(fn, match); check(name, true); };
const rejects = async (name: string, fn: () => Promise<unknown>, match: RegExp) => { await assert.rejects(fn, match); check(name, true); };
const gone = (port: number) => new Promise<boolean>(done => { const s = tcpConnect({ host: "127.0.0.1", port }).once("connect", () => { s.destroy(); done(false); }).once("error", () => done(true)); s.setTimeout(500, () => { s.destroy(); done(false); }); });
let broker: ChildProcess | undefined, manager: Manager | undefined, writer: Awaited<ReturnType<typeof connect>> | undefined, release: (() => void) | undefined;
let running = false, cleanupOK = true, runtimeCalls = 0, dials = 0;
const witness: RuntimeProvider = { kind: "runtime", name: "local-state-witness", available: () => { runtimeCalls++; return true; }, create: () => { runtimeCalls++; throw new Error("inert Runtime must never be constructed"); } };
registry.register(witness);
const inert = createServer(socket => { dials++; socket.end(); });
const pair = await generateKeyPair("EdDSA"), jwk = { ...await exportJWK(pair.publicKey), kid: "owned-state" };
const idp = createHttpServer((_request, reply) => { reply.setHeader("content-type", "application/json"); reply.end(JSON.stringify({ keys: [jwk] })); });
try {
  await new Promise<void>(r => inert.listen(0, "127.0.0.1", r));
  const inertPort = (inert.address() as { port: number }).port; ports.push(inertPort);
  const empty = join(root, "empty"); mkdirSync(empty); mkdirSync(join(empty, ".cotal"));
  const configHome = join(root, "config"); mkdirSync(configHome);
  const cliRefusal = async (flags: string[], expected: RegExp, expectedExit = 1) => {
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: configHome };
    delete env.COTAL_SKIP_CONNECTOR_SEED;
    const child = spawn(process.execPath, [fileURLToPath(new URL("../../../bin/dist/cotal.js", import.meta.url)), "supervise", ...flags], { cwd: empty, env, stdio: ["ignore", "ignore", "pipe"] });
    children.push(identity(child.pid!));
    let output = ""; child.stderr!.on("data", (b: Buffer) => { if (output.length < 16000) output += b.toString(); });
    const deadline = Date.now() + 15_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    if (child.exitCode === null && child.signalCode === null) await killAndAwaitExit(child);
    return child.exitCode === expectedExit && expected.test(output);
  };
  const beforeCLI = JSON.stringify(readdirSync(root, { recursive: true }).sort());
  check("public CLI refuses unsupported execution before connector seeding", await cliRefusal(["--execution", "unknown"], /--execution must be/));
  for (const flag of ["runtime", "spawn", "roster", "launch", "resume-attempt", "resume-commit-token", "resume-commit-file", "resume-commit-sha256"])
    check(`public CLI NONE refuses --${flag} before effects`, await cliRefusal(["--execution", "none", `--${flag}`, "owned"], /execution: none forbids runtime and startup workload flags/));
  check("invalid public CLI modes install no connector or identity state", beforeCLI === JSON.stringify(readdirSync(root, { recursive: true }).sort()));
  const opts: ManagerOptions = { space: "state", servers: `nats://127.0.0.1:${inertPort}`, workspaceRoot: empty, execution: "none" };
  for (const execution of ["", "unknown", false] as const) throws(`unsupported execution ${String(execution)} refuses before effects`, () => new Manager({ ...opts, execution: execution as never }), /unknown manager execution/);
  for (const runtime of ["pty", "auto", "local-state-witness"]) throws(`NONE refuses explicit runtime ${runtime}`, () => new Manager({ ...opts, runtime }), /no runtime option/);
  for (const [name, tuple] of [["null remote", { remoteAuthority: null }], ["nonboolean pooled", { pooled: "false" }], ["array remote", { remoteAuthority: [], pooled: true }]] as const)
    throws(`NONE refuses invalid ${name} tuple before effects`, () => new Manager({ ...opts, ...tuple } as never), /requires boolean pooled and a non-null remote authority/);
  throws("pooled NONE without remote authority still refuses", () => new Manager({ ...opts, pooled: true }), /requires pooled/);
  throws("remote NONE without pooled authority still refuses", () => new Manager({ ...opts, remoteAuthority: {} as never }), /requires pooled/);
  const ordinary = new Manager({ ...opts, execution: undefined });
  check("omitted execution preserves ordinary local PTY construction", ordinary.execution === "runtime" && ordinary.runtimeKind === "pty");
  const files = JSON.stringify(readdirSync(empty, { recursive: true }));
  const unsupported = new Manager(opts);
  await rejects("NONE refuses an open or missing-trust root before dial", () => unsupported.start(), /genuine hosting user-auth root/);
  check("invalid local root creates no identity capability files or connection", files === JSON.stringify(readdirSync(empty, { recursive: true })) && dials === 0 && runtimeCalls === 0);
  await new Promise<void>((resolve, reject) => { const socket = tcpConnect({ host: "127.0.0.1", port: inertPort }).once("error", reject).once("close", () => resolve()); });
  witness.available();
  check("inert network and Runtime witnesses have actual positive controls", dials === 1 && runtimeCalls === 1);
  runtimeCalls = 0;
  await new Promise<void>(r => idp.listen(0, "127.0.0.1", r));
  const idpPort = (idp.address() as { port: number }).port; ports.push(idpPort);
  const space = `local-state-${mintLifecycleUid()}`, port = await pickFreePort(); ports.push(port);
  const server = `nats://127.0.0.1:${port}`, auth = await createSpaceAuth(space);
  saveSpaceAuth(authDir(root), auth);
  const prepared = await cotalAuthProvider.prepareServer({ store: workspaceSecretStore(root), space, operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, dir: userAuthStateDir(root, space), idpUrl: `http://127.0.0.1:${idpPort}/api/auth` });
  recordMesh({ space, server, root: empty, mode: "user", userAuth: { ...assertUserAuthInfo(prepared.publicAuth), remote: true }, ts: new Date().toISOString() });
  const beforeParticipant = JSON.stringify(readdirSync(root, { recursive: true }).sort());
  check("public CLI NONE refuses participant registration without minting remote authority", await cliRefusal(["--execution", "none", "--space", space, "--server", server], /requires a genuine hosting user-auth root, not a participant registration/, 1) && beforeParticipant === JSON.stringify(readdirSync(root, { recursive: true }).sort()));
  writeFileSync(join(root, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(root, "js"), extraAccounts: prepared.extraAccounts }), { mode: 0o600 });
  broker = spawn("nats-server", ["-c", join(root, "server.conf")], { cwd: root, stdio: "ignore" }); children.push(identity(broker.pid!)); release = teardownOnSignal(broker);
  for (let i = 0; i < 100 && !(await isReachable(server)); i++) await new Promise(r => setTimeout(r, 100));
  await setupSpaceStreams({ servers: server, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  recordMesh({ space, server, root, mode: "user", userAuth: assertUserAuthInfo(prepared.publicAuth), ts: new Date().toISOString() });
  const localOpts: ManagerOptions = { space, servers: server, workspaceRoot: root, execution: "none" };
  manager = new Manager(localOpts); await manager.start(); running = true; ports.push(Number(new URL(manager.consoleUrl).port));
  check("genuine local NONE starts on native authority with no runtime", manager.execution === "none" && !Object.hasOwn(manager, "runtime"));
  const local = loadManagerInstanceIdentity(root, space)!;
  const path = join(root, ".cotal", `manager-execution.${spaceKey(space)}.${local.instanceId}.json`), capability = readFileSync(path);
  check("first NONE admission binds a space and native instance capability", JSON.parse(capability.toString()).execution === "none" && JSON.parse(capability.toString()).instanceId === local.instanceId);
  await manager.stop(); running = false; manager = undefined;
  throws("NONE cannot become runtime before resolving its registered provider", () => new Manager({ ...localOpts, execution: "runtime", runtime: "local-state-witness" }), /execution capability differs/);
  check("incompatible runtime restart never resolves the provider", runtimeCalls === 0);
  writeFileSync(path, "{broken", { mode: 0o600 });
  throws("malformed local capability refuses at public construction", () => new Manager(localOpts), /does not parse/);
  writeFileSync(path, capability, { mode: 0o600 });
  rmSync(path);
  await rejects("existing unclassified local identity cannot silently become NONE", () => new Manager(localOpts).start(), /existing unclassified manager instance/);
  check("unclassified refusal preserves identity and does not recreate capability", !existsSync(path) && loadManagerInstanceIdentity(root, space)?.instanceId === local.instanceId);
  writeFileSync(path, capability, { mode: 0o600 });
  writer = await connect({ servers: server, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "goal-writer", { goalWriter: { endpoint: "manager" } }), tls: false }) });
  const ctx = await actionContext(writer, space), caller = { owner: "local", actor: "probe", uid: mintLifecycleUid() };
  for (const kind of ["seat", "turn"] as const) {
    const ref = { endpoint: "manager", caller, goalId: mintLifecycleUid() };
    await recordGoalIndex(ctx, ref, local.instanceId, kind === "seat" ? { name: "owned", actor: "owned", uid: mintLifecycleUid() } : undefined, kind === "turn" ? "owned turn" : undefined);
    const before = await readGoalIndex(ctx, ref);
    await rejects(`native retained ${kind} refuses local NONE before recovery`, () => new Manager(localOpts).start(), /retained seat or turn inventory/);
    check(`retained ${kind} refusal preserves the exact native row`, JSON.stringify(await readGoalIndex(ctx, ref)) === JSON.stringify(before));
    const key = recordAtomicKey(RECORD_KINDS.goalidx, [ref.endpoint, caller.owner, caller.actor, caller.uid, ref.goalId]);
    const row = await ctx.kv.get(key); assert.ok(row);
    await ctx.kv.update(key, new TextEncoder().encode(JSON.stringify({ ...before, iid: mintLifecycleUid() })), row.revision);
  }
  check("local admission failures preserve capability and resolve no Runtime", readFileSync(path).equals(capability) && runtimeCalls === 0);
} finally {
  await writer?.close();
  if (running) { try { await manager?.stop(); } catch { cleanupOK = false; } }
  if (broker) { await killAndAwaitExit(broker); release?.(); }
  if (inert.listening) await new Promise<void>(r => inert.close(() => r()));
  if (idp.listening) await new Promise<void>(r => idp.close(() => r()));
  check("all owned child PID start cwd generations exited", children.every(x => { try { const now = identity(x.pid); return now.start !== x.start || now.cwd !== x.cwd; } catch (e) { return ["ENOENT", "ESRCH"].includes((e as NodeJS.ErrnoException).code ?? ""); } }));
  check("all native and inert listener ports closed", (await Promise.all(ports.map(gone))).every(Boolean) && cleanupOK);
  if (process.env.FIXTURE_OUT) writeFileSync(join(process.env.FIXTURE_OUT, `local-state-custody.${process.pid}.json`), JSON.stringify({ root, fixture: identity(process.pid), children, ports, managerClosed: cleanupOK, checks }, null, 2) + "\n", { mode: 0o600 });
  if (cleanupOK && existsSync(root)) rmSync(root, { recursive: true });
}
assert.equal(checks.length, 40, "all local admission, retained-state, witness and cleanup cells ran");
process.stdout.write(`local NONE state: ${checks.length} named assertions passed\n`);
process.stdout.write(formatSentinel({ passed: checks.length, failed: 0 }) + "\n");
