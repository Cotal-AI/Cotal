/**
 * A running `cotal join` that cannot come back ends with the reason and what to run.
 *
 * The suite runs the SRC join command as a real subprocess with a provisioned credential against an
 * auth broker it owns. It stops that broker until the join's client has given up reconnecting on its
 * own, so the join re-establishes the connection itself, and then starts the broker again:
 *
 *   1. under another trust, which rejects the join's credential: the join ends PERMISSION_DENIED with
 *      the refusal a one-shot command with that credential gets.
 *
 * Needs `nats-server` on PATH. Ports are OS-assigned.
 * Run: pnpm smoke:join-session-lost:live
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CotalEndpoint, createSpaceAuth, isReachable, mintCreds, mintLifecycleUid, newIdentity, provisionAgent,
  serverConfig, setupSpaceStreams, type SpaceAuth,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";

// The joining subprocess must not inherit a managed session's mesh identity from whatever runs
// this suite; it gets only the private home set below.
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => boolean | Promise<boolean>, ms: number) => {
  for (let i = 0; i < ms / 100; i++) { if (await cond()) return true; await wait(100); }
  return false;
};
const exited = (proc: ChildProcess) => proc.exitCode !== null || proc.signalCode !== null;

const root = fileURLToPath(new URL("../../../", import.meta.url));
const entry = fileURLToPath(new URL("./join-live-entry.fixture.ts", import.meta.url));
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `joinlost${Date.now().toString(36)}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
// The join's client retries a lost broker about ten times, two seconds apart, before it gives the
// connection up and the join re-establishes it. The broker stays away longer than that.
const CLIENT_GIVES_UP_MS = 30_000;
process.env.COTAL_HOME = join(dir, "home");
process.env.XDG_CONFIG_HOME = join(dir, "xdg");

const releases: (() => void)[] = [];
let srv: ChildProcess | undefined;
const startBroker = async (name: string, auth: SpaceAuth) => {
  writeFileSync(join(dir, `${name}.conf`), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, name) }));
  srv = spawn("nats-server", ["-c", join(dir, `${name}.conf`)], { stdio: "ignore" });
  releases.push(teardownOnSignal(srv, dir));
  if (!(await waitFor(() => isReachable(SERVERS), 10_000))) throw new Error(`nats-server ${name} did not come up on ${PORT}`);
};
const stopBroker = async () => {
  const s = srv!;
  s.kill("SIGKILL");
  await waitFor(() => exited(s), 5_000);
};

/** Provision a join's inbox on the current store and start the join with that credential. */
const startJoin = async (auth: SpaceAuth, name: string) => {
  const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });
  const prov = new CotalEndpoint({ space, servers: SERVERS, creds: provCreds, channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "prov", role: "manager", kind: "endpoint" } });
  prov.on("error", () => {});
  await prov.start();
  const uid = mintLifecycleUid();
  const creds = await provisionAgent(prov, auth, newIdentity(), { subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"], durableMembership: false, lifecycleUid: uid });
  await prov.stop();
  const credsPath = join(dir, `${name}.creds`);
  writeFileSync(credsPath, creds, { mode: 0o600 });
  const proc = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: root,
    env: { ...process.env, JOIN_VALUES: JSON.stringify({ space, server: SERVERS, name, creds: credsPath, "lifecycle-uid": uid }) },
    // stdin stays an open pipe, so the join runs headless and holds its session.
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout!.on("data", (b: Buffer) => { out += b.toString(); });
  proc.stderr!.on("data", (b: Buffer) => { out += b.toString(); });
  const text = () => out.replace(/\x1b\[[0-9;]*m/g, "");
  if (!(await waitFor(() => text().includes("holding presence"), 30_000))) throw new Error(`join ${name} never came up:\n${text()}`);
  return { proc, text };
};

const joins: ChildProcess[] = [];
try {
  const trust = await createSpaceAuth(space);
  await startBroker("first", trust);

  console.log("1. a join whose credential the broker now rejects ends with that credential's refusal");
  {
    const { proc, text } = await startJoin(trust, "rejected");
    joins.push(proc);
    await stopBroker();
    await wait(CLIENT_GIVES_UP_MS);
    await startBroker("rotated", await createSpaceAuth(space));
    const ended = await waitFor(() => exited(proc), 120_000);
    check("the join ends once the broker rejects its credential for good", ended && proc.exitCode === 2, { code: proc.exitCode, out: text() });
    check("...PERMISSION_DENIED, naming the rejected credential", text().includes(`REFUSED PERMISSION_DENIED credentials rejected at ${SERVERS}`), text());
  }

  console.log(`\nJOIN-SESSION-LOST SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  for (const proc of joins) if (!exited(proc)) { proc.kill("SIGKILL"); await waitFor(() => exited(proc), 5_000); }
  if (srv && !exited(srv)) await stopBroker();
  rmSync(dir, { recursive: true, force: true });
  for (const release of releases) release(); // last: ownership is held until this teardown has finished
}
