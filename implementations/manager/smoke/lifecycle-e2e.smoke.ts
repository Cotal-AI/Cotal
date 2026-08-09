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
 *  3c. FAIL BEFORE PRESENCE — a launch missing the launcher uid, or lying a different one while
 *      consuming, dies with NO roster ghost (SPEC 13.1 fail-before-presence).
 *   4. SHUTDOWN teardown — Manager.stop() deprovisions every still-managed agent's footprint.
 *
 * Run: pnpm smoke:lifecycle-e2e   (needs nats-server + node on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  isReachable, createSpaceAuth, mintCreds, serverConfig, newIdentity, setupSpaceStreams,
  openAclRegistry, readAcl, dmStream, dlvStream, dmDurable, dlvDurable, DEV_OWNER, principalKey,
  mintLifecycleUid, presenceBucket,
} from "@cotal-ai/core";
import type { Connector, LaunchOpts, LaunchSpec } from "@cotal-ai/core";
import { Manager } from "../src/manager.js";
import { registry } from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../.."); // worktree root — the agent process runs here so `@cotal-ai/core` resolves
const STUB = join(here, "e2e-stub.mjs");
// OS-assigned free port (collision-safe at allocation) — the old random port had no bind guard, so
// a rare collision could attach isReachable() to a FOREIGN broker and fail auth downstream.
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
const PORT = await freePort();
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
saveSpaceAuth(authDir(workspaceRoot), auth); // seeds the FS composition; the manager's start() reads it via getSpaceAuth(this.secrets) (FS default)
for (const n of ["w1", "w2", "bad1", "idle1", "nouid1", "wrong1", "wrongreg1", "bypass1"]) writeFileSync(join(workspaceRoot, ".cotal", "agents", `${n}.md`), `---\nname: ${n}\nrole: worker\n---\n`);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { port: PORT, storeDir: join(dir, "js") }));
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
// Every lifecycle-keyed broker resource (dm_/dlv_ durables, ACL row) carries the incarnation's uid
// (SPEC §13.1). The Manager mints it internally per spawn and records it on the ManagedAgent — read it
// there to predict the exact names. Capture it BEFORE a despawn/stop clears the agent from the map.
const uidOf = (name: string): string =>
  (mgr as unknown as { agents: Map<string, { lifecycleUid?: string }> }).agents.get(name)?.lifecycleUid ?? "";
const aclPresent = (id: string, uid: string) => inspect(async (_j, nc) => (await readAcl(await openAclRegistry(nc, space), localPrincipal(id), uid)) !== undefined);
// Lifecycle-keyed (`<name>.<uid>.creds`): the manager's spawn files the incarnation's cred under
// its uid, never the bare name (that's the standing-cred namespace).
const credsFile = (name: string, uid: string) => join(authDir(workspaceRoot), "creds", `${name}.${uid}.creds`);
/** Poll until `f()` matches `want`, up to `ms`. */
async function until(f: () => Promise<boolean>, want: boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if ((await f()) === want) return true; await wait(300); }
  return (await f()) === want;
}
/** Does the whole local-principal footprint exist? (dm_local- + dlv_local- + acl + creds file) */
async function footprint(id: string, uid: string, name: string): Promise<{ dm: boolean; dlv: boolean; acl: boolean; creds: boolean }> {
  return {
    dm: await consumerExists(DM, dmDurable(DEV_OWNER, id, uid)),
    dlv: await consumerExists(DLV, dlvDurable(DEV_OWNER, id, uid)),
    acl: await aclPresent(id, uid),
    creds: existsSync(credsFile(name, uid)),
  };
}

// A connector that launches the real stub agent (joins presence) or a die-on-arrival process.
// COTAL_LIFECYCLE_UID rides exactly as every stock connector forwards it (LaunchOpts → env).
const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? SERVERS), COTAL_CREDS: String(o.creds), COTAL_ID: String(o.id), COTAL_NAME: o.name, PATH: process.env.PATH ?? "",
  ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
});
const stubCon: Connector = { kind: "connector", name: "e2e-stub", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: "node", args: [STUB], env: envFor(o) }) };
const dieCon: Connector = { kind: "connector", name: "e2e-die", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: "node", args: ["-e", "process.exit(3)"], env: envFor(o) }) };
// Runs but never connects/joins presence — exercises the UNCERTAIN outcome (no exit, no mesh join).
const idleCon: Connector = { kind: "connector", name: "e2e-idle", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: "node", args: ["-e", "setInterval(()=>{}, 1e9)"], env: envFor(o) }) };
// The BROKEN-LAUNCHER shapes (residual #6, fail-before-presence): one DROPS the launcher uid off
// the env (the pre-D15 connector shape), one LIES a different uid while consuming (the stub then
// tries to bind lifecycle-keyed durables the credential/provisioner never named).
const noUidCon: Connector = { kind: "connector", name: "e2e-nouid", requires: ["node"], buildLaunch: (o): LaunchSpec => {
  const env = envFor(o);
  delete env.COTAL_LIFECYCLE_UID;
  return { command: "node", args: [STUB], env };
} };
const wrongUidCon: Connector = { kind: "connector", name: "e2e-wronguid", requires: ["node"], buildLaunch: (o): LaunchSpec => ({
  command: "node", args: [STUB], env: { ...envFor(o), COTAL_LIFECYCLE_UID: mintLifecycleUid(), COTAL_E2E_CONSUME: "1" },
}) };
// The REGISTER-ONLY wrong-uid shape (consume:false): the broker proof is not a consumer bind but
// the fail-before-presence dm_ durable proof, so a lied uid must still die with no roster ghost.
const wrongUidRegCon: Connector = { kind: "connector", name: "e2e-wronguid-reg", requires: ["node"], buildLaunch: (o): LaunchSpec => ({
  command: "node", args: [STUB], env: { ...envFor(o), COTAL_LIFECYCLE_UID: mintLifecycleUid() },
}) };
// The AUTHORITY-BYPASS shape (panel #6 authority boundary): a child holding a valid agent
// credential claims kind:"endpoint" (client metadata) to SKIP the library register-only dm_ proof,
// register-only + a lied uid. The manager readiness LIFECYCLE FENCE (presence uid == the minted
// uid) must still reject it — client-authored kind is not the authority boundary.
const bypassKindCon: Connector = { kind: "connector", name: "e2e-bypass-kind", requires: ["node"], buildLaunch: (o): LaunchSpec => ({
  command: "node", args: [STUB], env: { ...envFor(o), COTAL_LIFECYCLE_UID: mintLifecycleUid(), COTAL_E2E_KIND: "endpoint" },
}) };
registry.register(stubCon);
registry.register(dieCon);
registry.register(idleCon);
registry.register(noUidCon);
registry.register(wrongUidCon);
registry.register(wrongUidRegCon);
registry.register(bypassKindCon);

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
  const uid1 = uidOf("w1"); // capture the manager-minted uid while w1 is still managed (despawn clears it)
  const fp1 = await footprint(id1, uid1, "w1");
  check("footprint exists after start — dm_ durable", fp1.dm, fp1);
  check("footprint exists after start — dlv_ durable", fp1.dlv, fp1);
  check("footprint exists after start — read-ACL row", fp1.acl, fp1);
  check("footprint exists after start — creds file", fp1.creds, fp1);

  // 2 — DEPROVISION on despawn (real): the footprint is torn down.
  console.log("2. despawn → footprint deprovisioned:");
  const callerId = (mgr as unknown as { ep: { ref: () => { id: string } } }).ep.ref().id;
  (mgr as unknown as { opStop: (a: Record<string, unknown>, c: string, admin: boolean) => unknown }).opStop({ name: "w1", graceful: false }, callerId, true);
  check("dm_local- durable gone after despawn", await until(() => consumerExists(DM, dmDurable(DEV_OWNER, id1, uid1)), false), await footprint(id1, uid1, "w1"));
  check("dlv_local- durable gone after despawn", await until(() => consumerExists(DLV, dlvDurable(DEV_OWNER, id1, uid1)), false));
  check("read-ACL row gone after despawn", await until(() => aclPresent(id1, uid1), false));
  check("creds file gone after despawn", await until(async () => existsSync(credsFile("w1", uid1)), false));

  // 3 — FAILED launch: process exits on arrival → {ok:false} + footprint rolled back.
  console.log("3. die-on-arrival → failed + footprint rolled back:");
  const r3 = await mgr.startAgent({ name: "bad1", agent: "e2e-die", cwd: repoRoot });
  check("startAgent reports {ok:false}", r3.ok === false, r3);
  check("failure names 'exited on launch'", /exited on launch/.test((r3 as { error?: string }).error ?? ""), (r3 as { error?: string }).error);
  // The die connector still provisioned before it exited; that footprint must be torn down. Its id isn't
  // returned on failure, so assert via the ACL registry being empty of any non-w2 owner after a beat.
  await wait(2500);
  // The failed spawn's uid never came back, so sweep by prefix: no `bad1.<uid>.creds` (nor any
  // other `bad1.`-based secret) may remain.
  check("bad1 creds file not left behind", !readdirSync(join(authDir(workspaceRoot), "creds")).some((f) => f.startsWith("bad1.")));

  // 3b — UNCERTAIN: a process that runs but never joins presence → neither started nor failed within the
  // backstop → {ok:false} uncertain, and the agent is KEPT (not deprovisioned; it may still be booting).
  console.log("3b. runs-but-never-joins → uncertain + kept:");
  (mgr as unknown as { readinessTimeoutMs: number }).readinessTimeoutMs = 3000; // shrink the backstop for the test
  const r3b = await mgr.startAgent({ name: "idle1", agent: "e2e-idle", cwd: repoRoot });
  check("startAgent reports {ok:false}", r3b.ok === false, r3b);
  check("failure names it 'uncertain'", /uncertain/i.test((r3b as { error?: string }).error ?? ""), (r3b as { error?: string }).error);
  const idleId = (mgr as unknown as { agents: Map<string, { id: string; agent: string }> }).agents.get("idle1")?.id ?? "";
  const uidIdle = uidOf("idle1");
  check("uncertain agent is KEPT (still managed, not despawned)", idleId !== "" && (await footprint(idleId, uidIdle, "idle1")).creds, [...(mgr as unknown as { agents: Map<string, unknown> }).agents.keys()]);
  check("uncertain agent NOT deprovisioned (footprint intact)", (await footprint(idleId, uidIdle, "idle1")).dm, await footprint(idleId, uidIdle, "idle1"));
  (mgr as unknown as { readinessTimeoutMs: number }).readinessTimeoutMs = 30000; // restore for w2 below

  // 3c — FAIL BEFORE PRESENCE (SPEC 13.1, residual #6): an authed launch whose connector DROPS
  // the launcher uid (a broken launcher, the pre-cut shape) or LIES a different one while
  // consuming (the broker denies the lifecycle-keyed durable bind) must die with NO presence
  // ghost — the roster never advertises an agent that could not prove its lifecycle. Assert by
  // presence-key set difference: no key appears during either failed launch.
  console.log("3c. missing/wrong launcher uid → fail BEFORE presence (no roster ghost):");
  {
    // Enumerate the presence bucket's keys via its backing stream's per-subject counts (no KV
    // client needed): every present key is a `$KV.<bucket>.<key>` subject with messages.
    const presenceKeys = (): Promise<string[]> =>
      inspect(async (jsm) => {
        const b = presenceBucket(space);
        const info = await jsm.streams.info(`KV_${b}`, { subjects_filter: `$KV.${b}.>` });
        return Object.keys(info.state.subjects ?? {});
      });
    const before = new Set(await presenceKeys());
    const rNo = await mgr.startAgent({ name: "nouid1", agent: "e2e-nouid", cwd: repoRoot });
    check("a launch whose connector DROPS the launcher uid never reports started", rNo.ok === false, rNo);
    const rWrong = await mgr.startAgent({ name: "wrong1", agent: "e2e-wronguid", cwd: repoRoot });
    check("a consuming launch that LIES a different uid never reports started (bind denied)", rWrong.ok === false, rWrong);
    const rWrongReg = await mgr.startAgent({ name: "wrongreg1", agent: "e2e-wronguid-reg", cwd: repoRoot });
    check("a REGISTER-ONLY (consume:false) launch that lies a uid never reports started (dm_ proof denied)", rWrongReg.ok === false, rWrongReg);
    const added = (await presenceKeys()).filter((k) => !before.has(k));
    check("NONE of the fail-before-presence launches left a presence ghost (dropped/lying uid, consume or register-only)", added.length === 0, added);

    // The AUTHORITY BOUNDARY (panel #6): a child claims kind:endpoint to SKIP the library dm_
    // proof, so it DOES publish presence with its lied uid (a ghost record exists). The manager
    // readiness LIFECYCLE FENCE rejects it anyway - client-authored kind is not the authority
    // boundary; the manager owns the expected uid, so the ghost never reports STARTED.
    (mgr as unknown as { readinessTimeoutMs: number }).readinessTimeoutMs = 3000;
    const rBypass = await mgr.startAgent({ name: "bypass1", agent: "e2e-bypass-kind", cwd: repoRoot });
    check("a kind:endpoint child with a lied uid never reports STARTED (manager readiness lifecycle fence, not client kind)",
      rBypass.ok === false && /uncertain/i.test((rBypass as { error?: string }).error ?? ""), rBypass);
    (mgr as unknown as { readinessTimeoutMs: number }).readinessTimeoutMs = 30000;
  }

  // 4 — SHUTDOWN teardown: stop() deprovisions the still-managed agents (w2 + the kept idle1).
  console.log("4. manager stop() → still-managed footprint torn down:");
  const r4 = await mgr.startAgent({ name: "w2", agent: "e2e-stub", cwd: repoRoot });
  check("second agent started", r4.ok === true, r4);
  const id2 = (r4.data as { id?: string } | undefined)?.id ?? "";
  const uid2 = uidOf("w2"); // capture before stop() clears the managed set
  check("w2 footprint exists before stop", (await footprint(id2, uid2, "w2")).dm, await footprint(id2, uid2, "w2"));
  await mgr.stop(); // awaits teardownManagedAgents → deprovision
  const fp2 = await footprint(id2, uid2, "w2");
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
