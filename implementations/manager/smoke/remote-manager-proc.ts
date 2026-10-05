import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  credsClaims,
  mintLifecycleUid,
  remoteManagerActors,
  remoteManagerRegistrationProof,
  type RemoteManagerAuthorityMaterial,
  type RemoteManagerAuthorityRequest,
} from "@cotal-ai/core";
import { Manager as SourceManager, type ManagerOptions } from "../src/manager.js";
import "@cotal-ai/runtime";
import { managerClusterArtifacts as sourceManagerClusterArtifacts } from "../src/manager-service-contract.js";
import { registerRemoteManagerAuthority as sourceRegisterRemoteManagerAuthority } from "../src/remote-register.js";
import * as sourceAuthority from "../src/remote-authority.js";

// A library-hosted manager's shipped bearer command re-invokes THIS entry as `agent-bearer ...`
// (process.argv[1]); delegate that one subcommand before emitting fixture diagnostics.
if (process.argv[2] === "agent-bearer") {
  await import(new URL("../../../bin/run.ts", import.meta.url).href);
  process.exit(process.exitCode ?? 0);
}
const publicAuthority = process.env.EF_PUBLIC_AUTHORITY === "1";
const publicApi = publicAuthority ? await import("@cotal-ai/manager") : undefined;
if (publicAuthority) {
  assert.equal(typeof publicApi?.remoteManagerClient, "object", "public manager root exposes remoteManagerClient");
  assert.equal(typeof publicApi?.registerRemoteManagerAuthority, "function", "public manager root exposes native manager registration");
  assert.equal(typeof publicApi?.managerClusterArtifacts, "function", "public manager root exposes canonical activation artifacts");
  assert.equal(typeof publicApi?.Manager, "function", "public manager root exposes the Manager constructor");
}
const Manager = publicAuthority ? publicApi!.Manager : SourceManager;
const managerClusterArtifacts = publicAuthority ? publicApi!.managerClusterArtifacts : sourceManagerClusterArtifacts;
const registerRemoteManagerAuthority = publicAuthority ? publicApi!.registerRemoteManagerAuthority : sourceRegisterRemoteManagerAuthority;
const {
  currentRegistrationProof,
  loadOrCreateRemoteManagerIdentity,
  materialCredential,
  remoteManagerAdminAuthorizationRequest,
  remoteManagerAdminAuthorized,
  remoteManagedAgentEnrollmentMaterial,
  remoteManagedAgentEnrollmentRequest,
  remoteManagerAuthorityRequest,
  remoteManagerGoalIndexEntries,
  remoteRunAdmission,
  remoteRunAdmissionRequest,
  remoteRunAttemptRequest,
  remoteRunAttemptCredentials,
  remoteRunRenewalCredentials,
  remoteStandingBundleRenewal,
} = publicAuthority ? publicApi!.remoteManagerClient : sourceAuthority;
if (publicAuthority) console.log("PUBLIC_REMOTE_AUTHORITY_BOUND:package-root");

const POOLED = process.env.EF_POOLED_RUNTIME === "1";
if (POOLED) await registerPooledFixture();
const [space, servers, wsDir, httpUrl, owner, bearerToken] = process.argv.slice(2);
if (!space || !servers || !wsDir || !httpUrl || !owner || !bearerToken) {
  console.error("usage: remote-manager-proc <space> <servers> <wsDir> <httpUrl> <owner> <bearerToken>");
  process.exit(1);
}

const postHttp = async (request: unknown) => {
  const resp = await fetch(httpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idpToken: bearerToken, request }),
  });
  const json = (await resp.json()) as Record<string, unknown>;
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${String(json.error ?? "unknown")}`);
  }
  return json;
};

mkdirSync(join(wsDir, ".cotal"), { recursive: true });
const mgrIdentity = loadOrCreateRemoteManagerIdentity(wsDir, space);
const actors = remoteManagerActors(mgrIdentity.instanceId);

// 1. Prepare
const prepReq = remoteManagerAuthorityRequest(mgrIdentity, "cli", "prepare");
const prepMat = (await postHttp(prepReq)) as unknown as RemoteManagerAuthorityMaterial;
const supervisorCreds = materialCredential(prepMat, "supervisor", mgrIdentity.identities.supervisor);
const executorCreds = materialCredential(prepMat, "executor", mgrIdentity.identities.executor);

// 2. Register on broker
const registered = await registerRemoteManagerAuthority({
  space,
  server: servers,
  owner,
  instanceId: mgrIdentity.instanceId,
  serveActor: actors.serve,
  prepareCreds: executorCreds,
  tlsRequired: false,
  evict: async () => true,
});

// 3. Activate
const artifacts = managerClusterArtifacts();
const contractArtifacts = [artifacts.document, artifacts.manifest];
const activateProof = remoteManagerRegistrationProof(
  owner,
  remoteManagerAuthorityRequest(mgrIdentity, "cli", "activate", `sha256:${"0".repeat(64)}`, contractArtifacts),
);
const activateReq = remoteManagerAuthorityRequest(
  mgrIdentity,
  "cli",
  "activate",
  activateProof,
  contractArtifacts,
);
const activateMat = (await postHttp(activateReq)) as unknown as RemoteManagerAuthorityMaterial;
const retainedRegistrationProof = currentRegistrationProof(activateMat);

const standing = remoteStandingBundleRenewal({
  state: mgrIdentity,
  owner,
  registrationProof: retainedRegistrationProof,
  supervisorCreds,
  call: async (r) => (await postHttp(r)) as unknown as RemoteManagerAuthorityMaterial,
});

const renewExecutor = async () => {
  const renewed = (await postHttp(
    remoteManagerAuthorityRequest(mgrIdentity, "cli", "renew", retainedRegistrationProof),
  )) as unknown as RemoteManagerAuthorityMaterial;
  return materialCredential(renewed, "executor", mgrIdentity.identities.executor);
};

const serveCreds = materialCredential(activateMat, "serve", mgrIdentity.identities.serve);
const goalWriterCreds = materialCredential(activateMat, "goalWriter", mgrIdentity.identities.goalWriter);
const sessionLedgerCreds = materialCredential(activateMat, "sessionLedger", mgrIdentity.identities.sessionLedger);

const runBase = () => ({
  proof: retainedRegistrationProof,
  account: standing.accountPublicKey,
  epoch: registered.processEpoch,
});

const managerOpts = (runtime: string, pooled: boolean): ManagerOptions => ({
  space,
  servers,
  runtime,
  ...(pooled ? { pooled: true, eventsRequired: true } : {}),
  workspaceRoot: wsDir,
  remoteAuthority: {
    ...standing,
    renewExecutor,
    owner,
    actors,
    instanceId: mgrIdentity.instanceId,
    lifecycleUid: mgrIdentity.lifecycleUid,
    identities: mgrIdentity.identities,
    supervisorCreds,
    executorCreds,
    serveCreds,
    goalWriterCreds,
    sessionLedgerCreds,
    serveGrant: registered.serveGrant,
    agentBearerExchangeUrl: POOLED ? new URL(httpUrl).origin : "https://auth.example.test",
    mintSessionServing: async () => { throw new Error("mintSessionServing unsupported in signerless continuity smoke"); },
    mintRetirementRequester: async () => { throw new Error("mintRetirementRequester unsupported in signerless continuity smoke"); },
    prepareAgentRetirement: async () => { throw new Error("prepareAgentRetirement unsupported in signerless continuity smoke"); },
    validateRetainedAgent: async () => { throw new Error("validateRetainedAgent unsupported in signerless continuity smoke"); },
    scanGoalIndex: async () => {
      const { proof, epoch } = runBase();
      const request = {
        v: 1 as const,
        kind: "manager-goal-index-scan" as const,
        space,
        actor: "cli",
        instanceId: mgrIdentity.instanceId,
        managerLifecycleUid: mgrIdentity.lifecycleUid,
        requestId: `scan${mintLifecycleUid()}`,
        registrationProof: proof,
        serveEpoch: epoch,
        identities: Object.fromEntries(
          Object.entries(mgrIdentity.identities).map(([k, id]) => [k, { id: id.id }]),
        ) as never,
      };
      const res = (await postHttp(request)) as never;
      return remoteManagerGoalIndexEntries(res, request, owner);
    },
    authorizeAdmin: async (caller) => {
      const { proof, epoch } = runBase();
      const request = remoteManagerAdminAuthorizationRequest(
        mgrIdentity,
        "cli",
        proof,
        epoch,
        caller,
      );
      const res = (await postHttp(request)) as never;
      return remoteManagerAdminAuthorized(res, request, owner);
    },
    // FIXTURE: the manager's enrollment callback targets the labelled fixture host interception path.
    enrollManagedAgent: async ({ target }) => {
      const { proof, epoch } = runBase();
      const request = remoteManagedAgentEnrollmentRequest(mgrIdentity, "cli", proof, epoch, target);
      const url = POOLED ? httpUrl : httpUrl.replace("/manager-service-authority", "/fixture-host/manager-service-authority");
      const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idpToken: bearerToken, request }) });
      const json = (await resp.json()) as Record<string, unknown>;
      if (!resp.ok) throw new Error(`fixture host HTTP ${resp.status}: ${String(json.error ?? "unknown")}`);
      return remoteManagedAgentEnrollmentMaterial(json as never, request);
    },
    runHosting: {
      admitRun: async (run) => {
        const { proof, account, epoch } = runBase();
        const request = remoteRunAdmissionRequest(mgrIdentity, proof, account, epoch, { runId: run.runId, subject: run.subject });
        const result = (await postHttp(request)) as never;
        return remoteRunAdmission(result, request);
      },
      issueAttempt: async ({ runId, takeoverId, epoch, fencingToken, driver, mediator, served }) => {
        const base = runBase();
        const request = remoteRunAttemptRequest(mgrIdentity, base.proof, base.account, base.epoch, {
          attempt: { runId, takeoverId, epoch, fencingToken, driverId: driver.id, mediatorId: mediator.id, ...(served !== undefined ? { served } : {}) },
        });
        const result = (await postHttp(request)) as never;
        const pair = remoteRunAttemptCredentials(result, request, owner, { driver, mediator });
        if (!("driver" in pair)) throw new Error("host returned an operator instead of a run pair");
        return pair;
      },
      issueOperator: async ({ identity, takeoverId, runId, answers, served }) => {
        const { proof, account, epoch } = runBase();
        const request = remoteRunAttemptRequest(mgrIdentity, proof, account, epoch, {
          operator: { id: identity.id, takeoverId, ...(runId !== undefined ? { runId } : {}), ...(answers !== undefined ? { answers } : {}), ...(served !== undefined ? { served } : {}) },
        });
        const result = (await postHttp(request)) as never;
        const credential = remoteRunAttemptCredentials(result, request, owner, { operator: identity });
        if (!("operator" in credential)) throw new Error("host returned a run pair instead of an operator");
        return credential.operator;
      },
      renewRun: async ({ runId, holder, takeoverId, epoch, fencingToken, driver, mediator }) => {
        const base = runBase();
        const request: RemoteManagerAuthorityRequest = {
          ...remoteManagerAuthorityRequest(mgrIdentity, "cli", "renewRunDriver", base.proof),
          accountPublicKey: base.account,
          processEpoch: base.epoch,
          run: { runId, holder, takeoverId, epoch, fencingToken, driverId: driver.id, mediatorId: mediator.id },
        };
        const result = (await postHttp(request)) as unknown as RemoteManagerAuthorityMaterial;
        return remoteRunRenewalCredentials(result, request, owner, driver, mediator);
      },
    },
  },
});
if (POOLED) {
  // Continued refusal: the SAME authority with the local custodial PTY runtime is refused.
  try { new Manager(managerOpts("pty", true)); console.log("POOLED_PTY_REFUSED:false"); }
  catch (e) { console.log(`POOLED_PTY_REFUSED:${JSON.stringify((e as Error).message.slice(0, 160))}`); }
}
const manager = new Manager(managerOpts(POOLED ? "ef-fixture-host" : "pty", POOLED));
if (publicAuthority) assert.ok(manager instanceof publicApi!.Manager, "native child instantiates the public Manager constructor");

await manager.start();
// Fixture-only refusal boundary: stop new renewal entries and drain admitted calls before
// sampling the last-good pair. The real renewal implementation still performs every call.
const hostedRuns = (manager as unknown as { runHosting: { renew(): Promise<void> } }).runHosting;
const renewRuns = hostedRuns.renew.bind(hostedRuns);
const renewalFlights = new Set<Promise<void>>();
let pauseRunRenewals = false;
const renewalOwner = manager as any;
const renewStanding = renewalOwner.renewRemoteStandingBundle.bind(manager);
function trackedRenewal(renew: () => Promise<void>): Promise<void> {
  if (pauseRunRenewals) return Promise.resolve();
  const flight = renew();
  renewalFlights.add(flight);
  void flight.then(() => renewalFlights.delete(flight), () => renewalFlights.delete(flight));
  return flight;
}
hostedRuns.renew = () => trackedRenewal(renewRuns);
renewalOwner.renewRemoteStandingBundle = (force = false) => trackedRenewal(() => renewStanding(force));
console.log(`MANAGER_READY:${mgrIdentity.instanceId}:${registered.processEpoch}`);

// FIXTURE-ONLY observation seam: on a `PROBE <runId>` stdin line, report bounded non-secret
// metadata (public nkey, exp, debt reason, connection state, a live broker dial verdict) read from
// the run-hosting's ACTUAL held objects. Never emits a JWT or seed. Not a product API.
let stdinBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  stdinBuf += chunk;
  let i: number;
  while ((i = stdinBuf.indexOf("\n")) >= 0) {
    const line = stdinBuf.slice(0, i).trim();
    stdinBuf = stdinBuf.slice(i + 1);
    const m = line.match(/^PROBE (\S+)$/);
    if (m) void probe(m[1]!);
    const rw = line.match(/^(RETAIN|DIAL_WITNESS|PAUSE_RENEWALS|RESUME_RENEWALS|PREPARE_RECOVERY) (\S+)$/);
    if (rw) void witness(rw[1] as "RETAIN" | "DIAL_WITNESS" | "PAUSE_RENEWALS" | "RESUME_RENEWALS" | "PREPARE_RECOVERY", rw[2]!);
    const ep = line.match(/^ENROLL_PROBE(?: (stock|host|host-forged|host-intruder))?$/);
    if (ep) void enrollProbe((ep[1] ?? "stock") as "stock" | "host" | "host-forged" | "host-intruder");
  }
});
async function probe(runId: string) {
  const run = (manager as any).runHosting?.runs?.get(runId);
  const meta = (creds: unknown) => {
    if (typeof creds !== "string") return null;
    const c = credsClaims(creds);
    return { sub: c.sub, exp: c.exp, account: c.nats?.issuer_account };
  };
  let executorDialRefused: boolean | null = null;
  const execCreds = (manager as any).remoteExecutorCreds;
  if (typeof execCreds === "string") {
    try {
      const nc = await connect({ servers, reconnect: false, authenticator: credsAuthenticator(new TextEncoder().encode(execCreds)) });
      await nc.close();
      executorDialRefused = false;
    } catch {
      executorDialRefused = true;
    }
  }
  let dialRefused: boolean | null = null;
  if (typeof run?.creds === "string") {
    try {
      const nc = await connect({ servers, reconnect: false, authenticator: credsAuthenticator(new TextEncoder().encode(run.creds)) });
      await nc.close();
      dialRefused = false;
    } catch {
      dialRefused = true;
    }
  }
  const out = run
    ? {
        runId,
        held: true,
        driver: meta(run.creds),
        mediator: meta(run.mediatorCreds),
        debt: run.renewalDebt?.reason ?? null,
        driverConnClosed: run.nc ? run.nc.isClosed() : null,
        dialRefused,
        standing: standingMeta(),
        executorDialRefused,
      }
    : { runId, held: false, standing: standingMeta(), executorDialRefused };
  console.log(`PROBE_RESULT:${JSON.stringify(out)}`);
}
// FIXTURE-ONLY expiry witness: RETAIN snapshots the run's ACTUAL held driver credential at a
// verified pre-expiry moment, inside this process only (it never leaves it). DIAL_WITNESS later
// presents that same credential to the broker and reports only metadata and the broker's verdict,
// so refusal after expiry is observable even once the manager has correctly released the slot.
const witnesses = new Map<string, string>();
async function witness(op: "RETAIN" | "DIAL_WITNESS" | "PAUSE_RENEWALS" | "RESUME_RENEWALS" | "PREPARE_RECOVERY", runId: string) {
  if (op === "PAUSE_RENEWALS" || op === "RESUME_RENEWALS" || op === "PREPARE_RECOVERY") {
    pauseRunRenewals = op !== "RESUME_RENEWALS";
    if (pauseRunRenewals) await Promise.allSettled([...renewalFlights]);
    let prepared = false;
    let error: string | undefined;
    if (op === "PREPARE_RECOVERY") {
      // Autonomous recovery is asserted before this command. Keep the following CLI call from
      // racing the next short-TTL refresh: renew through the real host, observe the native reconnect,
      // then flush the restored subscription. No credential or broker response is fabricated.
      const nc = renewalOwner.serviceServe.nc;
      const events = nc.status()[Symbol.asyncIterator]();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let phase = "settle previous credential push";
      try {
        if (nc.isClosed()) throw new Error("recovered service connection is closed");
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("service reconnect was not observed")), 7_000);
        });
        const reconnected = async (requireForce: boolean) => {
          let requested = !requireForce;
          for (;;) {
            const event = await events.next();
            if (event.done) throw new Error("service status ended before reconnect");
            if (event.value.type === "forceReconnect") requested = true;
            if (requested && event.value.type === "reconnect") return;
          }
        };
        // The admitted renewal promise can settle before nats.js finishes its transport reconnect.
        // A flush interrupted by that existing push is not evidence that recovery itself failed.
        try { await Promise.race([nc.flush(), deadline]); }
        catch (e) {
          if (nc.isClosed()) throw e;
          console.error("fixture recovery: awaiting previous renewal reconnect");
          await Promise.race([reconnected(false), deadline]);
          await Promise.race([nc.flush(), deadline]);
        }
        phase = "renew held family";
        await Promise.all([renewStanding(true), Promise.race([reconnected(true), deadline])]);
        phase = "flush renewed subscriptions";
        await Promise.race([nc.flush(), deadline]);
        if (nc !== renewalOwner.serviceServe.nc || nc.isClosed()) throw new Error("service connection changed at recovery boundary");
        prepared = true;
      } catch (e) { error = `${phase}: ${(e as Error).message}`; }
      finally { clearTimeout(timer); void events.return?.(); }
    }
    console.log(`WITNESS_RESULT:${JSON.stringify({ op, runId, paused: pauseRunRenewals, inFlight: renewalFlights.size, prepared, error })}`);
    return;
  }
  const meta = (creds: string) => { const c = credsClaims(creds); return { sub: c.sub, exp: c.exp, account: c.nats?.issuer_account }; };
  if (op === "RETAIN") {
    const creds = (manager as any).runHosting?.runs?.get(runId)?.creds;
    if (typeof creds === "string") witnesses.set(runId, creds);
    console.log(`WITNESS_RESULT:${JSON.stringify({ op, runId, retained: typeof creds === "string", driver: typeof creds === "string" ? meta(creds) : null })}`);
    return;
  }
  const creds = witnesses.get(runId);
  let dialRefused: boolean | null = null;
  if (creds) {
    try {
      const nc = await connect({ servers, reconnect: false, authenticator: credsAuthenticator(new TextEncoder().encode(creds)) });
      await nc.close();
      dialRefused = false;
    } catch {
      dialRefused = true;
    }
  }
  console.log(`WITNESS_RESULT:${JSON.stringify({ op, runId, retained: !!creds, driver: creds ? meta(creds) : null, dialRefused })}`);
}
/** Standing duty metadata from the manager's ACTUAL held fields (fixture-only; public data only). */
function standingMeta() {
  const m = manager as any;
  const held: Record<string, unknown> = {
    supervisor: m.remoteSupervisorCreds,
    executor: m.remoteExecutorCreds,
    serve: m.serviceServe?.creds,
    goalWriter: m.goalWriterCreds,
    sessionLedger: m.sessionLedgerCreds,
  };
  const now = Math.floor(Date.now() / 1000);
  const out: Record<string, unknown> = { debt: m.remoteRenewalDebt?.reason ?? null };
  for (const [k, v] of Object.entries(held)) {
    if (typeof v !== "string") { out[k] = null; continue; }
    const c = credsClaims(v);
    out[k] = { sub: c.sub, exp: c.exp, account: c.nats?.issuer_account, live: typeof c.exp === "number" && c.exp > now };
  }
  return out;
}

process.on("SIGTERM", async () => {
  await manager.stop().catch(() => {});
  process.exit(0);
});

// FIXTURE-ONLY: send one real managed-agent enrollment request (token DIGEST only) through the
// same public authority route the manager's callbacks use, and report status/error text only.
async function enrollProbe(mode: "stock" | "host" | "host-forged" | "host-intruder") {
  const { proof, epoch } = runBase();
  const request = remoteManagedAgentEnrollmentRequest(mgrIdentity, mode === "host-intruder" ? "intruder" : "cli", proof, epoch, {
    actor: "sdk_fixture", tokenHash: "0".repeat(64), allowSubscribe: [">"],
  });
  if (mode === "host-forged") request.registrationProof = `sha256:${"f".repeat(64)}`;
  const url = mode === "stock" ? httpUrl : httpUrl.replace("/manager-service-authority", "/fixture-host/manager-service-authority");
  const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idpToken: bearerToken, request }) });
  const json = (await resp.json().catch(() => ({}))) as { error?: unknown };
  console.log(`ENROLL_RESULT:${JSON.stringify({ mode, status: resp.status, error: String(json.error ?? "").slice(0, 200) })}`);
}

/** LABELLED TEST FIXTURE (EF_POOLED_RUNTIME=1 only): the scripted SDK connector and a NON-custodial
 *  runtime registered through the stock registry. The runtime owns no process: spawn() hands the
 *  Manager's LaunchSpec to a SEPARATE trusted fixture host (EF_EXEC_HOST_URL), which verifies the
 *  launch identity against the enrollment it authorized and runs the SDK child itself. Not a
 *  production SandboxProvider. */
async function registerPooledFixture() {
  const { registry, eventChannel } = await import("@cotal-ai/core");
  await import("@cotal-ai/auth");
  const hostUrl = process.env.EF_EXEC_HOST_URL!;
  const childCmd = JSON.parse(process.env.EF_CHILD_CMD!) as string[];
  registry.register({
    kind: "connector", name: "ef-sdk-fixture", readinessTimeoutMs: 30000,
    eventChannel: (principal: { owner: string; actor: string }) => eventChannel(principal),
    buildLaunch(opts: any) {
      if (!opts.userAuth || !opts.lifecycleUid) throw new Error("ef-sdk-fixture requires enrolled user authority");
      return {
        command: childCmd[0]!, args: childCmd.slice(1),
        env: {
          COTAL_SPACE: opts.space, COTAL_SERVERS: opts.servers, COTAL_NAME: opts.name,
          COTAL_OWNER: opts.userAuth.owner, COTAL_ACTOR: opts.userAuth.actor,
          COTAL_SENTINEL_CREDS: opts.userAuth.sentinelCredsPath,
          COTAL_BEARER_CMD: JSON.stringify(opts.userAuth.bearerCmd), COTAL_LIFECYCLE_UID: opts.lifecycleUid,
        },
      };
    },
  } as never);
  const call = async (path: string, body: unknown) => {
    const r = await fetch(`${hostUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  registry.register({
    kind: "runtime", name: "ef-fixture-host", available: () => true,
    create: () => ({
      kind: "ef-fixture-host",
      spawn(name: string, spec: { command: string; args: string[]; env?: Record<string, string> }, cwd: string) {
        let state: "running" | "exited" = "running";
        let exit: { code?: number } | undefined;
        const exitFns: Array<() => void> = [];
        const done = (code?: number) => { if (state === "exited") return; state = "exited"; exit = { code }; for (const f of exitFns) f(); };
        const launched = call("/spawn", { name, cwd, spec }).then((r) => {
          console.log(`EXEC_HOST_SPAWN:${JSON.stringify({ name, status: r.status, error: r.json.error ?? null })}`);
          if (r.status !== 200) done(1);
          return r.json.id as string | undefined;
        }, () => { done(1); return undefined; });
        const poll = setInterval(async () => {
          const id = await launched;
          if (!id || state === "exited") return clearInterval(poll);
          const r = await call("/status", { id }).catch(() => undefined);
          if (r?.json.status === "exited") { clearInterval(poll); done(r.json.code as number); }
        }, 500);
        poll.unref();
        return {
          name, kind: "ef-fixture-host",
          status: () => state,
          stop: () => { void launched.then((id) => { if (id) void call("/stop", { id }); }); },
          waitForExit: () => new Promise<void>((res) => state === "exited" ? res() : exitFns.push(res)),
          exitInfo: () => exit,
          interrupt: () => {},
          attach: () => ({ cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: (f: () => void) => { exitFns.push(f); return () => {}; }, write: () => {}, resize: () => {} }),
        };
      },
    }),
  } as never);
}
