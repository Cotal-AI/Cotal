/**
 * Deprovision-on-exit functional smoke (#159 Part B2) — the teardown counterpart to `provisionAgent`,
 * verified end to end against a real JWT-auth nats-server.
 *
 * Boots its own auth broker, provisions an agent the real way (a provisioner endpoint → `provisionAgent`,
 * which creates the bind-only `dm_<id>` + `dlv_<id>` durables, records the read-ACL row, and creates the
 * role-shared `svc_<role>` TASK durable), then runs `deprovisionAgent` with a TARGET-PINNED `deprovisioner`
 * cred and proves it is the exact inverse of the id-keyed footprint — and NOTHING more:
 *
 *   - `dm_<id>` + `dlv_<id>` durables: GONE.
 *   - the read-ACL row: GONE (the reader now treats the owner as unknown).
 *   - the role-shared `svc_<role>` durable: UNTOUCHED (deleting it would break the role's other agents;
 *     it lives until space teardown) — the correctness catch the plan calls out.
 *   - a second `deprovisionAgent` is a no-op (idempotent — a missing consumer / absent ACL row never throws).
 *
 * The permission BOUNDARIES of the `deprovisioner` profile (target-pinned, no body read, no svc_<role>,
 * no stream tamper) are proven separately in the deny-matrix (`manager-split-auth.smoke.ts`); this proves
 * the FUNCTIONAL teardown a manager runs when an agent exits.
 *
 * Run: pnpm smoke:deprovision
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  isReachable,
  createSpaceAuth,
  mintCreds,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  provisionAgent,
  deprovisionAgent,
  openAclRegistry,
  readAcl,
  CotalEndpoint,
  dmStream,
  dlvStream,
  taskStream,
  dmDurable,
  dlvDurable,
  taskDurable,
} from "../src/index.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

const space = `deprov-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-deprov-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

/** Does consumer `name` exist on `stream`? Opens a short-lived provisioner-cred jsm to check. */
async function consumerExists(provCreds: string, provId: string, stream: string, name: string): Promise<boolean> {
  const nc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(provCreds)),
    inboxPrefix: `_INBOX_${provId}`,
    maxReconnectAttempts: 0,
  });
  try {
    const jsm = await jetstreamManager(nc);
    await jsm.consumers.info(stream, name);
    return true;
  } catch {
    return false; // ConsumerNotFound (or gone) → false
  } finally {
    await nc.drain().catch(() => {});
  }
}

/** Is `owner`'s read-ACL row present? Reads it via a provisioner-cred connection. */
async function aclPresent(provCreds: string, provId: string, owner: string): Promise<boolean> {
  const nc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(provCreds)),
    inboxPrefix: `_INBOX_${provId}`,
    maxReconnectAttempts: 0,
  });
  try {
    return (await readAcl(await openAclRegistry(nc, space), owner)) !== undefined;
  } finally {
    await nc.drain().catch(() => {});
  }
}

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) { up = true; break; }
    await wait(200);
  }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const DM = dmStream(space), DLV = dlvStream(space), TASK = taskStream(space);

  // ---- provision an agent the real way (provisioner endpoint → provisionAgent) ----
  const provId = newIdentity();
  const provCreds = await mintCreds(auth, provId, "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });
  const prov = new CotalEndpoint({
    space, servers: SERVERS, creds: provCreds,
    card: { id: provId.id, name: "prov", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
  });
  prov.on("error", (e: Error) => console.error("  ! prov", e.message));
  await prov.start();

  const agent = newIdentity();
  await provisionAgent(prov, auth, agent, { subscribe: ["general"], allowSubscribe: ["general"], role: "worker" });
  await prov.stop();

  console.log("after provisionAgent — the id-keyed footprint + the role-shared svc_<role> exist:");
  check("dm_<id> durable present", await consumerExists(provCreds, provId.id, DM, dmDurable(agent.id)));
  check("dlv_<id> durable present", await consumerExists(provCreds, provId.id, DLV, dlvDurable(agent.id)));
  check("svc_<role> (worker) durable present", await consumerExists(provCreds, provId.id, TASK, taskDurable("worker")));
  check("read-ACL row present", await aclPresent(provCreds, provId.id, agent.id));

  // ---- deprovision with a TARGET-PINNED cred (what the manager mints on the agent's exit) ----
  const dpvCreds = await mintCreds(auth, newIdentity(), "deprovisioner", { deprovisionTarget: agent.id });
  await deprovisionAgent({ servers: SERVERS, space, targetId: agent.id, creds: dpvCreds });

  console.log("after deprovisionAgent — the id-keyed footprint is gone; the role-shared durable survives:");
  check("dm_<id> durable GONE", !(await consumerExists(provCreds, provId.id, DM, dmDurable(agent.id))));
  check("dlv_<id> durable GONE", !(await consumerExists(provCreds, provId.id, DLV, dlvDurable(agent.id))));
  check("read-ACL row GONE", !(await aclPresent(provCreds, provId.id, agent.id)));
  check("svc_<role> (worker) durable UNTOUCHED (role-shared — siblings still bind it)", await consumerExists(provCreds, provId.id, TASK, taskDurable("worker")));

  // ---- idempotent: a second teardown (missing consumers / absent ACL row) must not throw ----
  let threw = false;
  try {
    await deprovisionAgent({ servers: SERVERS, space, targetId: agent.id, creds: dpvCreds });
  } catch (e) {
    threw = true;
    console.error("  ! second deprovision threw:", (e as Error).message);
  }
  check("second deprovisionAgent is a no-op (idempotent)", !threw);

  console.log(`\nDEPROVISION SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
