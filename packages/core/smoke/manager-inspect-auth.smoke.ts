/**
 * Issue #904: a spawn-scoped orchestrator's `manager.inspect` publish, at the broker.
 *
 * The denied live credential carries no `manager.inspect` row. This suite reconstructs the exact
 * inspect-less spawn bundle that predates the two service-command additions, signs it through the
 * same account path, and asks a self-owned JWT broker about the exact request subject. It does not
 * claim that history is the live credential's issuance provenance; the remaining-row comparison is
 * a separate investigation. Current spawn and capability-less profiles are the two controls.
 *
 * The second half grades the caller verdict. NATS reports a denied core publish asynchronously on
 * `nc.status()`, so a call can distinguish it from a publish the broker accepted but nobody served.
 *
 * Run: pnpm smoke:manager-inspect-auth
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  BASELINE_LIFECYCLE_ENDPOINT,
  DEV_OWNER,
  compileContract,
  createSpaceAuth,
  epCall,
  epCallerGrantRows,
  epRequestSubject,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  permissionsFor,
  serverConfig,
  spawnCallerCapabilities,
  unansweredRequest,
  type EpCaller,
  type Identity,
  type SpaceAuth,
} from "../src/index.js";
import { principalTags } from "../src/subjects.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `inspect-auth-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], {
  transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"),
}));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

/** The real pre-44208a2 spawn assembly: baseline + spawn/despawn/attach, before the service
 * additions `define-persona` and `inspect`. It deliberately uses today's shared builders for every
 * unchanged row, then signs the resulting NATS permissions through the ordinary account chain. */
async function historicalSpawnCreds(identity: Identity, uid: string): Promise<string> {
  const pr = { owner: DEV_OWNER, actor: identity.id, connId: identity.id, lifecycleUid: uid };
  const perms = permissionsFor("agent", space, pr, { lifecycleUid: uid }) as {
    pub: { allow: string[]; deny?: string[] };
    sub: { allow: string[]; deny?: string[] };
  };
  const caller: EpCaller = { owner: DEV_OWNER, actor: identity.id, uid };
  const historical = epCallerGrantRows(space, [
    { endpoint: BASELINE_LIFECYCLE_ENDPOINT, command: "spawn" },
    { endpoint: BASELINE_LIFECYCLE_ENDPOINT, command: "despawn", target: { mode: "owner", tOwner: DEV_OWNER } },
    { endpoint: BASELINE_LIFECYCLE_ENDPOINT, command: "attach", target: { mode: "owner", tOwner: DEV_OWNER } },
  ], caller);
  perms.pub.allow.push(...historical.pub);
  const jwt = await encodeUser(
    "agent",
    fromPublic(identity.id),
    fromPublic(auth.account.pub),
    { ...perms, tags: principalTags(DEV_OWNER, identity.id) },
    { signer: fromSeed(new TextEncoder().encode(auth.account.signingSeed)) },
  );
  return new TextDecoder().decode(fmtCreds(jwt, fromSeed(new TextEncoder().encode(identity.seed))));
}

const connectAs = (creds: string, id: string) => connect({
  servers: SERVERS,
  authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
  inboxPrefix: `_INBOX_${id}`,
  maxReconnectAttempts: 0,
});

/** Raw request oracle. Authorization violation means the broker refused the publish; no responders
 * or timeout means it admitted it. */
async function publishVerdict(creds: string, id: string, subject: string): Promise<"allowed" | "denied"> {
  const nc = await connectAs(creds, id);
  try {
    await nc.request(subject, new Uint8Array(), { timeout: 500 });
    return "allowed";
  } catch (e) {
    return /permission|authoriz/i.test((e as Error).message) ? "denied" : "allowed";
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

const CONTRACT = {
  input: compileContract({ root: { type: "object", additionalProperties: false } }),
  output: compileContract({ root: {} }),
};
async function callVerdict(creds: string, caller: EpCaller): Promise<{ code: string; unanswered: boolean; elapsed: number; message: string }> {
  const nc = await connectAs(creds, caller.actor);
  const started = Date.now();
  try {
    await epCall(nc, space, { mode: "one" }, {
      endpoint: BASELINE_LIFECYCLE_ENDPOINT,
      command: "inspect",
      contract: CONTRACT,
      caller,
      args: {},
    }, { deadlineMs: 1500, currentEpoch: async () => 0 });
    return { code: "ok", unanswered: false, elapsed: Date.now() - started, message: "" };
  } catch (e) {
    return {
      code: String((e as { code?: unknown }).code ?? "unknown"),
      unanswered: unansweredRequest(e),
      elapsed: Date.now() - started,
      message: (e as Error).message,
    };
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) { up = true; break; }
    await wait(200);
  }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const currentId = newIdentity(), currentUid = mintLifecycleUid();
  const legacyId = newIdentity(), legacyUid = mintLifecycleUid();
  const plainId = newIdentity(), plainUid = mintLifecycleUid();
  const currentCaller: EpCaller = { owner: DEV_OWNER, actor: currentId.id, uid: currentUid };
  const legacyCaller: EpCaller = { owner: DEV_OWNER, actor: legacyId.id, uid: legacyUid };
  const plainCaller: EpCaller = { owner: DEV_OWNER, actor: plainId.id, uid: plainUid };
  const currentCreds = await mintCreds(auth, currentId, "agent", { lifecycleUid: currentUid, capabilities: ["spawn"] });
  const legacyCreds = await historicalSpawnCreds(legacyId, legacyUid);
  const plainCreds = await mintCreds(auth, plainId, "agent", { lifecycleUid: plainUid });
  const subject = (caller: EpCaller) => epRequestSubject(space, {
    route: { mode: "one" }, endpoint: BASELINE_LIFECYCLE_ENDPOINT,
    command: "inspect", caller, nonce: "n".repeat(24),
  });

  const currentRows = epCallerGrantRows(space, spawnCallerCapabilities(DEV_OWNER), currentCaller).pub;
  const exactCurrent = `cotal.${space}.ep.one.manager.inspect.${DEV_OWNER}.${currentId.id}.${currentUid}.*`;
  check("current spawn mint emits the exact untargeted inspect row (owner, actor, uid, nonce wildcard)",
    currentRows.includes(exactCurrent), { exactCurrent, currentRows });

  console.log("broker publish boundary:");
  check("current spawn credential publishes its own manager.inspect subject", await publishVerdict(currentCreds, currentId.id, subject(currentCaller)) === "allowed");
  check("the historical spawn credential is DENIED on that exact subject", await publishVerdict(legacyCreds, legacyId.id, subject(legacyCaller)) === "denied");
  check("a capability-less principal remains DENIED (inspect did not become baseline)", await publishVerdict(plainCreds, plainId.id, subject(plainCaller)) === "denied");

  console.log("caller verdict boundary:");
  const accepted = await callVerdict(currentCreds, currentCaller);
  check("an admitted inspect with no manager reports unavailable and carries unanswered provenance",
    accepted.code === "unavailable" && accepted.unanswered, accepted);
  const denied = await callVerdict(legacyCreds, legacyCaller);
  check("a broker-denied inspect reports permission-denied, not a false unanswered deadline",
    denied.code === "permission-denied" && !denied.unanswered, denied);
  check("the denial is observed before the 1500ms reply budget expires", denied.elapsed < 1000, denied);
  const deniedPrefix = `cotal.${space}.ep.one.manager.inspect.${DEV_OWNER}.${legacyId.id}.${legacyUid}.`;
  check("the denial names the broker refusal and its caller-pinned subject",
    /REFUSED BY THE BROKER/.test(denied.message) && denied.message.includes(deniedPrefix), denied.message);

  const EXPECTED_CELLS = 8;
  const ran = pass + fail;
  console.log(`\n${fail === 0 ? "MANAGER INSPECT AUTH OK ✅" : "MANAGER INSPECT AUTH FAILED ❌"} (${pass} passed, ${fail} failed)`);
  if (ran !== EXPECTED_CELLS) {
    console.log(`SUITE INCOMPLETE: ran ${ran} of ${EXPECTED_CELLS} cells`);
    process.exitCode = 1;
  } else if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
