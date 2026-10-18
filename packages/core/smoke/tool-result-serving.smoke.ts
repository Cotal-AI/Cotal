/**
 * Managed tool-results serving registration, live — run with (needs nats-server on PATH):
 *   pnpm --dir packages/core exec tsx smoke/tool-result-serving.smoke.ts
 *
 * Drives the shipped registerToolResultServing / deregisterToolResultServing the manager calls at
 * a static-auth spawn and at retirement: the registration names the incarnation as the serving
 * instance, the agent's own serve credential serves the handle-only commands on it, retirement
 * removes the record, and a repeat retirement is
 * an `absent` no-op rather than an error. The holder-side redemption and broker confinement of the
 * holder rows are the auth package's redemption smokes.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  createSpaceAuth, DEV_OWNER, deregisterToolResultServing, ensureAuthorityStores, ensureContractStore, isReachable, mintCreds, mintLifecycleUid,
  newIdentity, openRecordsBucket, registerToolResultServing, serveEndpoint, serverConfig, compileContract, TOOL_RESULT_COMMANDS, TOOL_RESULT_CONTRACTS, TOOL_RESULT_ENDPOINT,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `trs${Date.now().toString(36)}`;
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };

const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const conns: NatsConnection[] = [];

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  const prov = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(await mintCreds(auth, newIdentity(), "provisioner"))) });
  conns.push(prov);
  const jsm = await jetstreamManager(prov);
  await ensureAuthorityStores(jsm, new Kvm(prov), space);
  await ensureContractStore(jsm, space);
  await openRecordsBucket(prov, space, { create: true });

  const target = { auth, servers: SERVERS, space, tls: false };
  const agent = newIdentity();
  const uid = mintLifecycleUid();
  const serving = await registerToolResultServing({ ...target, identity: agent, lifecycleUid: uid, expiresAt: Math.floor(Date.now() / 1000) + 600 });
  check("the serving instance is the incarnation's lifecycle UID", serving.grant.instanceId === uid && serving.grant.endpoint === TOOL_RESULT_ENDPOINT && serving.grant.space === space, serving.grant);
  check("the grant is owned by the operator owner, not a tenant", serving.grant.owner === DEV_OWNER);

  const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(serving.creds)) });
  conns.push(nc);
  // The registered contracts, compiled from the ONE shared definition; no request is sent here.
  const defs = TOOL_RESULT_COMMANDS.map((command) => ({
    command,
    contract: { input: compileContract({ root: TOOL_RESULT_CONTRACTS[command].input }), output: compileContract({ root: TOOL_RESULT_CONTRACTS[command].output }) },
    handler: () => ({ state: "unknown" }),
  }));
  let served = false;
  try {
    const handle = serveEndpoint(nc, space, serving.grant, defs, { public: true });
    served = true;
    await handle.stop();
  } catch (e) {
    console.error("  serve refused:", (e as Error).message);
  }
  check("the agent's own serve credential opens its granted instance", served);

  const removed = await deregisterToolResultServing({ ...target, lifecycleUid: uid });
  check("retirement removes the incarnation's record", removed.removed === true, removed);
  const again = await deregisterToolResultServing({ ...target, lifecycleUid: uid });
  check("a repeated retirement is an absent no-op, not an error", again.removed === false && "reason" in again && again.reason === "absent", again);

  console.log(`\nTOOL-RESULT-SERVING SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  for (const c of conns) { try { await c.close(); } catch { /* */ } }
  await killAndAwaitExit(srv);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  releaseBroker();
}
