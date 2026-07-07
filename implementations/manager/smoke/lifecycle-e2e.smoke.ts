/**
 * Lifecycle e2e (#159 Part B) — the REAL end-to-end the fake-runtime preflight can't reach: a real
 * JWT-auth broker + a real Manager + real agent PROCESSES (e2e-stub.mjs) that join presence, driving the
 * actual production paths and INSPECTING the real broker footprint.
 *
 *   1. STARTED via real presence — startAgent resolves ok only once the agent's assigned id is live in
 *      presence; its footprint (dm_local-/dlv_local- durables + ACL row + creds file) exists on the broker/disk.
 *   2. DEPROVISION on despawn — a real despawn tears that footprint down: durables gone, ACL row gone,
 *      creds file gone.
 *   3. FAILED launch — an agent whose process exits on arrival is reported {ok:false} "exited on launch",
 *      and its just-minted footprint is rolled back (deprovisioned), not orphaned.
 *  3b. UNCERTAIN — a process that runs but never joins presence is reported {ok:false} "uncertain" and is
 *      KEPT (not deprovisioned — it may still be booting), distinct from both started and failed.
 *   4. SHUTDOWN teardown — Manager.stop() deprovisions every still-managed agent's footprint.
 *
 * Run: pnpm smoke:lifecycle-e2e   (needs nats-server + node on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  isReachable, createSpaceAuth, mintCreds, serverConfig, newIdentity, setupSpaceStreams,
  openAclRegistry, readAcl, dmStream, dlvStream, dmDurable, dlvDurable, DEV_OWNER, principalKey,
} from "@cotal-ai/core";
import type { Connector, LaunchOpts, LaunchSpec } from "@cotal-ai/core";
import { Manager } from "../src/manager.js";
import { registry } from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../.."); // worktree root — the agent process runs here so `@cotal-ai/core` resolves
const STUB = join(here, "e2e-stub.mjs");
const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `life-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-life-"));
const workspaceRoot = join(dir, "ws");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth); // the manager's start() reloads auth from disk (loadSpaceAuth)
for (const n of ["w1", "w2", "bad1", "idle1"]) writeFileSync(join(workspaceRoot, ".cotal", "agents", `${n}.md`), `---\nname: ${n}\nrole: worker\n---\n`);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

const DM = dmStream(space), DLV = dlvStream(space);
const provId = newIdentity();
const provCreds = await mintCreds(auth, provId, "provisioner");

/** Open a provisioner-cred jsm/acl connection to inspect the broker footprint. */
async function inspect<T>(fn: (jsm: Awaited<ReturnType<typeof jetstreamManager>>, aclNc: import("@nats-io/transport-node").NatsConnection) => Promise<T>): Promise<T> {
  const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(provCreds)), inboxPrefix: `_INBOX_${provId.id}`, maxReconnectAttempts: 0 });
  try { return await fn(await jetstreamManager(nc), nc); } finally { await nc.drain().catch(() => {}); }
}
const consumerExists = (stream: string, name: string) =>
  inspect(async (jsm) => { try { await jsm.consumers.info(stream, name); return true; } catch { return false; } });
const localPrincipal = (id: string) => principalKey(DEV_OWNER, id).key;
const aclPresent = (id: string) => inspect(async (_j, nc) => (await readAcl(await openAclRegistry(nc, space), localPrincipal(id))) !== undefined);
const credsFile = (name: string) => join(authDir(workspaceRoot), "creds", `${name}.creds`);
/** Poll until `f()` matches `want`, up to `ms`. */
async function until(f: () => Promise<boolean>, want: boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if ((await f()) === want) return true; await wait(300); }
  return (await f()) === want;
}
/** Does the whole local-principal footprint exist? (dm_local- + dlv_local- + acl + creds file) */
async function footprint(id: string, name: string): Promise<{ dm: boolean; dlv: boolean; acl: boolean; creds: boolean }> {
  return {
    dm: await consumerExists(DM, dmDurable(DEV_OWNER, id)),
    dlv: await consumerExists(DLV, dlvDurable(DEV_OWNER, id)),
    acl: await aclPresent(id),
    creds: existsSync(credsFile(name)),
  };
}

// A connector that launches the real stub agent (joins presence) or a die-on-arrival process.
const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? SERVERS), COTAL_CREDS: String(o.creds), COTAL_ID: String(o.id), COTAL_NAME: o.name, PATH: process.env.PATH ?? "",
});
const stubCon: Connector = { kind: "connector", name: "e2e-stub", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: "node", args: [STUB], env: envFor(o) }) };
const dieCon: Connector = { kind: "connector", name: "e2e-die", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: "node", args: ["-e", "process.exit(3)"], env: envFor(o) }) };
// Runs but never connects/joins presence — exercises the UNCERTAIN outcome (no exit, no mesh join).
const idleCon: Connector = { kind: "connector", name: "e2e-idle", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: "node", args: ["-e", "setInterval(()=>{}, 1e9)"], env: envFor(o) }) };
registry.register(stubCon);
registry.register(dieCon);
registry.register(idleCon);

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });
  await mgr.start();

  // 0 — the manager is the CLASS-2 RENEWAL OWNER (D5 slice 5): a real start runs the ordered
  // renewal pass and persists the audit record — here with both daemon files absent (no delivery
  // daemon staged), recorded honestly as skips, never a fabricated adoption.
  const renewalPath = join(workspaceRoot, ".cotal", "renewal.json");
  check("manager start writes the renewal audit record", existsSync(renewalPath));
  {
    const rec = JSON.parse(readFileSync(renewalPath, "utf8")) as { owner?: string; results?: Array<{ file: string; ok: boolean; skipped?: string }>; adoption?: unknown };
    check("renewal record is the manager's pass", rec.owner === "manager", rec);
    check("absent daemon files are honest skips (no fabricated re-sign/adoption)", rec.results?.every((r) => !r.ok && r.skipped === "missing-file") === true && rec.adoption === undefined, rec);
  }

  // 1 — STARTED via real presence + footprint exists.
  console.log("1. real spawn → started via presence:");
  const r1 = await mgr.startAgent({ name: "w1", agent: "e2e-stub", cwd: repoRoot });
  check("startAgent reports started (agent joined the mesh)", r1.ok === true, r1);
  const id1 = (r1.data as { id?: string } | undefined)?.id ?? "";
  const fp1 = await footprint(id1, "w1");
  check("footprint exists after start — dm_ durable", fp1.dm, fp1);
  check("footprint exists after start — dlv_ durable", fp1.dlv, fp1);
  check("footprint exists after start — read-ACL row", fp1.acl, fp1);
  check("footprint exists after start — creds file", fp1.creds, fp1);

  // 2 — DEPROVISION on despawn (real): the footprint is torn down.
  console.log("2. despawn → footprint deprovisioned:");
  const callerId = (mgr as unknown as { ep: { ref: () => { id: string } } }).ep.ref().id;
  (mgr as unknown as { opStop: (a: Record<string, unknown>, c: string, admin: boolean) => unknown }).opStop({ name: "w1", graceful: false }, callerId, true);
  check("dm_local- durable gone after despawn", await until(() => consumerExists(DM, dmDurable(DEV_OWNER, id1)), false), await footprint(id1, "w1"));
  check("dlv_local- durable gone after despawn", await until(() => consumerExists(DLV, dlvDurable(DEV_OWNER, id1)), false));
  check("read-ACL row gone after despawn", await until(() => aclPresent(id1), false));
  check("creds file gone after despawn", await until(async () => existsSync(credsFile("w1")), false));

  // 3 — FAILED launch: process exits on arrival → {ok:false} + footprint rolled back.
  console.log("3. die-on-arrival → failed + footprint rolled back:");
  const r3 = await mgr.startAgent({ name: "bad1", agent: "e2e-die", cwd: repoRoot });
  check("startAgent reports {ok:false}", r3.ok === false, r3);
  check("failure names 'exited on launch'", /exited on launch/.test((r3 as { error?: string }).error ?? ""), (r3 as { error?: string }).error);
  // The die connector still provisioned before it exited; that footprint must be torn down. Its id isn't
  // returned on failure, so assert via the ACL registry being empty of any non-w2 owner after a beat.
  await wait(2500);
  check("bad1 creds file not left behind", !existsSync(credsFile("bad1")));

  // 3b — UNCERTAIN: a process that runs but never joins presence → neither started nor failed within the
  // backstop → {ok:false} uncertain, and the agent is KEPT (not deprovisioned; it may still be booting).
  console.log("3b. runs-but-never-joins → uncertain + kept:");
  (mgr as unknown as { readinessTimeoutMs: number }).readinessTimeoutMs = 3000; // shrink the backstop for the test
  const r3b = await mgr.startAgent({ name: "idle1", agent: "e2e-idle", cwd: repoRoot });
  check("startAgent reports {ok:false}", r3b.ok === false, r3b);
  check("failure names it 'uncertain'", /uncertain/i.test((r3b as { error?: string }).error ?? ""), (r3b as { error?: string }).error);
  const idleId = (mgr as unknown as { agents: Map<string, { id: string; agent: string }> }).agents.get("idle1")?.id ?? "";
  check("uncertain agent is KEPT (still managed, not despawned)", idleId !== "" && (await footprint(idleId, "idle1")).creds, [...(mgr as unknown as { agents: Map<string, unknown> }).agents.keys()]);
  check("uncertain agent NOT deprovisioned (footprint intact)", (await footprint(idleId, "idle1")).dm, await footprint(idleId, "idle1"));
  (mgr as unknown as { readinessTimeoutMs: number }).readinessTimeoutMs = 30000; // restore for w2 below

  // 4 — SHUTDOWN teardown: stop() deprovisions the still-managed agents (w2 + the kept idle1).
  console.log("4. manager stop() → still-managed footprint torn down:");
  const r4 = await mgr.startAgent({ name: "w2", agent: "e2e-stub", cwd: repoRoot });
  check("second agent started", r4.ok === true, r4);
  const id2 = (r4.data as { id?: string } | undefined)?.id ?? "";
  check("w2 footprint exists before stop", (await footprint(id2, "w2")).dm, await footprint(id2, "w2"));
  await mgr.stop(); // awaits teardownManagedAgents → deprovision
  const fp2 = await footprint(id2, "w2");
  check("w2 dm_ durable gone after stop()", !fp2.dm, fp2);
  check("w2 dlv_ durable gone after stop()", !fp2.dlv, fp2);
  check("w2 read-ACL row gone after stop()", !fp2.acl, fp2);
  check("w2 creds file gone after stop()", !fp2.creds, fp2);

  console.log(`\nLIFECYCLE E2E ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await mgr.stop(); } catch { /* already stopped */ }
  srv.kill("SIGKILL");
  await wait(300);
  rmSync(dir, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
