/**
 * SECRET-STORE SEAM smoke (control-surface v0.4, Lane B finding 2) — the manager has ONE
 * `SecretStore` (`this.secrets`, the injected `ManagerOptions.secretStore` or the workspace FS
 * default). Every credential the manager reads, writes, or deletes MUST go through it.
 *
 * Four sites bypassed the seam and built their own `workspaceSecretStore(this.workspaceRoot)`:
 * the managed-cred renewal scan, the static-resume seed recovery, the retirement cleanup, and the
 * managed-cred re-sign. On a workstation the two stores happen to be the same object graph, so
 * nothing looks wrong; against ANY injected store (a hosted KMS/Vault adapter, which is the whole
 * point of the seam) the manager renews from a store it never reads, and a retired agent's
 * credential is never removed from the configured backend.
 *
 * The probe is a RECORDING PROXY over the real FS store, injected as `secretStore`. Behaviour is
 * byte-identical to today's default — the only observable is WHICH accesses arrived at the seam.
 * The lifecycle below is real: a real broker, real auth, a real spawn, the real renewal pass, the
 * real re-sign, the real retirement. Each check asserts the seam saw the access AND that the
 * access really happened (the file moved / the row landed), so a check can never pass by the
 * access simply not occurring.
 *
 * Run: pnpm smoke:secret-store-seam   (needs nats-server + node on PATH; boots its own broker)
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSpaceAuth, isReachable, mintCreds, mintLifecycleUid, newIdentity, principalKey,
  registry, serverConfig, setupSpaceStreams, DEV_OWNER,
  type AgentHandle, type Connector, type LaunchSpec, type Presence, type SecretStore,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, workspaceSecretStore, agentSecretKeyForFile } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

/** The seam probe: a real store that records every access that reaches it. */
interface Access { op: "get" | "put" | "delete"; key: string }
function recordingStore(inner: SecretStore): SecretStore & { seen: Access[]; sawSince(from: number, op: Access["op"], key: string): boolean } {
  const seen: Access[] = [];
  return {
    seen,
    sawSince: (from, op, key) => seen.slice(from).some((a) => a.op === op && a.key === key),
    async get(key) { seen.push({ op: "get", key }); return inner.get(key); },
    async put(key, value) { seen.push({ op: "put", key }); return inner.put(key, value); },
    async delete(key) { seen.push({ op: "delete", key }); return inner.delete(key); },
  };
}

const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `secseam-${mintLifecycleUid().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-secseam-"));
const workspaceRoot = join(dir, "ws");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
writeFileSync(
  join(workspaceRoot, ".cotal", "agents", "worker.md"),
  `---\nname: worker\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\nbody\n`,
);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));

const kids: ChildProcess[] = [];
const srv = spawnProc("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
kids.push(srv);
let mgr: InstanceType<typeof Manager> | undefined;

const store = recordingStore(workspaceSecretStore(workspaceRoot));

try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot, secretStore: store });
  // A fake runtime + connector: nothing launches, the credential lifecycle is fully real.
  const fakeSession = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} };
  const fakeHandle = (name: string): AgentHandle => ({ name, kind: "fake", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => fakeSession });
  (mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = { kind: "fake", spawn: (name) => fakeHandle(name) };
  (mgr as unknown as { ep: Record<string, unknown> }).ep = {
    ref: () => ({ id: "smoke-mgr" }), on: () => {}, off: () => {},
    waitForPresenceSnapshot: () => Promise.resolve(),
    getRoster: (): Presence[] =>
      [...(mgr as unknown as { agents: Map<string, { id: string; name: string; lifecycleUid: string }> }).agents.values()].map(
        (a): Presence => ({ card: { id: principalKey(DEV_OWNER, a.id).key, name: a.name, role: "worker", kind: "agent", description: "", tags: [] }, status: "idle", lifecycleUid: a.lifecycleUid, ts: 0 }),
      ),
  };
  const con: Connector = { kind: "connector", name: "smoke-ss", requires: ["node"], buildLaunch: () => ({ command: "true", args: [], env: {} }) };
  registry.register(con);

  await mgr.start();
  const M = mgr as unknown as {
    agents: Map<string, { id: string; name: string; lifecycleUid: string; seed?: string; terminalizing?: boolean; secretPaths?: { creds?: string } }>;
    renewDaemonCreds(): Promise<void>;
    renewManagedStaticCred(a: unknown): Promise<void>;
    deprovision(a: { id: string; name: string; lifecycleUid: string; secretPaths?: { creds?: string } }): Promise<void>;
    freeSlot(a: unknown, floor: boolean): void;
    retiring: Map<string, unknown>;
  };

  const spawned = await mgr.startAgent({ name: "worker", agent: "smoke-ss" });
  check("fixture: the agent spawned with a materialized static credential", spawned.ok === true, spawned);
  const a = M.agents.get("worker")!;
  const credsPath = a.secretPaths?.creds;
  check("fixture: the spawn recorded a credential path", typeof credsPath === "string" && existsSync(credsPath), credsPath);
  const credKey = agentSecretKeyForFile(credsPath!);

  // ── SITE renewManagedStaticCred: the re-sign must WRITE through the seam ──────────────────────
  console.log("A. the managed-cred re-sign writes through the injected store");
  {
    await wait(1100); // JWT iat is second-granular; step past the boundary so the re-sign is real
    const before = store.seen.length;
    const fileBefore = readFileSync(credsPath!, "utf8");
    await M.renewManagedStaticCred(a);
    const fileAfter = readFileSync(credsPath!, "utf8");
    check("the re-sign really happened (the credential file changed)", fileAfter !== fileBefore);
    check("the renewed credential was PUT through the injected store", store.sawSince(before, "put", credKey), store.seen.slice(before));
  }

  // ── SITE renewCredentials: the managed-cred renewal scan must READ through the seam ───────────
  console.log("B. the renewal pass reads the managed credential through the injected store");
  {
    const before = store.seen.length;
    await M.renewDaemonCreds();
    check("the renewal pass READ the managed credential through the injected store (a scan that reads a different store silently renews nothing)",
      store.sawSince(before, "get", credKey), store.seen.slice(before).filter((x) => x.op === "get"));
  }

  // ── SITE driveStaticRetirement cleanup: the teardown must DELETE through the seam ─────────────
  console.log("C. the retirement teardown deletes the credential through the injected store");
  {
    const before = store.seen.length;
    M.freeSlot(a, false);
    await M.deprovision({ id: a.id, name: a.name, lifecycleUid: a.lifecycleUid, secretPaths: a.secretPaths });
    for (let i = 0; i < 150 && M.retiring.has("worker"); i++) await wait(200);
    check("the teardown really happened (the credential file is gone)", !existsSync(credsPath!));
    check("the credential was DELETED through the injected store (else a retired agent's cred is left in the configured backend)",
      store.sawSince(before, "delete", credKey), store.seen.slice(before).filter((x) => x.op === "delete"));
  }

  console.log(`\nsecret-store-seam smoke: ${pass} passed, ${fail} failed`);
} finally {
  await mgr?.stop().catch(() => {});
  for (const k of kids) { k.kill("SIGKILL"); }
  await wait(200);
}

process.exit(fail > 0 ? 1 : 0);
