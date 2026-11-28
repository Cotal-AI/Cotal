/** Remaining acceptance: real signerless native manager, auth HTTP, encrypted broker callout,
 * issuer-observed keyed submission and actual seatless driver. No model seats or Cloud. */
if (process.argv[2] === "agent-bearer") {
  await import("../src/index.js");
  const { registry } = await import("@cotal-ai/core");
  const raw = process.argv.slice(3), values: Record<string, string | boolean> = {};
  for (let i = 0; i < raw.length; i++) {
    const flag = raw[i]!; if (!flag.startsWith("--")) throw new Error("fixture bearer expects flags");
    const next = raw[i + 1]; if (next && !next.startsWith("--")) { values[flag.slice(2)] = next; i++; }
    else values[flag.slice(2)] = true;
  }
  await registry.resolve<import("@cotal-ai/core").Command>("command", "agent-bearer").run({ values, positionals: [], raw });
  process.exit(0);
}
import nodeAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { connect as connectSocket, createServer as createRelay, type AddressInfo, type Socket } from "node:net";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { connect, credsAuthenticator, tokenAuthenticator } from "@nats-io/transport-node";
import {
  mintCreds, newIdentity, mintLifecycleUid, setupSpaceStreams, issuedUserCaller, resolveService,
  prepareKeyedRunSubmission, invokeKeyedRunSubmission, readKeyedRunSubmission, invokeCommand, inspectCredHealth,
  type RunStatusView,
} from "@cotal-ai/core";
import {
  cotalAuthProvider, deriveOwnerForIdpSubject, ensurePinnedIdp, grantActor, loadOwnerSecret, saveIdpSession, startAuthService,
  type AuthServiceHandle,
} from "../src/index.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { nativeRemoteManager } from "../../manager/smoke/_native-remote-manager.js";
import { bootDeliveryDaemon } from "../../manager/smoke/_boot-delivery.js";
import { homeCotalDir, recordMesh, userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import "../../runtime/src/index.js";
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;

const fx = await startHostedAuthFixture("keyed-native", 1), a = fx.accounts[0]!;
const previousHome = process.env.COTAL_HOME;
const home = join(fx.dir, "cli-home"); mkdirSync(home);
process.env.COTAL_HOME = home;
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(publicKey), kid: "keyed-idp", alg: "EdDSA" };
let runRecovery: "idp" | "idp-rate" | "idp-unsupported" | "connection" | "issuer" | "attempt" | "permanent" | "rate-limit" | "rate-bare" | "rate-plain" | "rate-read" | "not-implemented" | "unsupported-read" | undefined;
let recoveryRunId: string | undefined;
const recoveryFailures: string[] = [];
let permanentRefusals = 0;
const idp = createServer(async (req, res) => {
  if (req.url === "/api/auth/token" && runRecovery === "idp") {
    recoveryFailures.push("IdP HTTP 500");
    runRecovery = "connection";
    res.writeHead(500).end();
    return;
  }
  if (req.url === "/api/auth/token" && runRecovery === "idp-unsupported") {
    recoveryFailures.push("IdP HTTP 501");
    res.writeHead(501).end("plain");
    return;
  }
  if (req.url === "/api/auth/token" && runRecovery === "idp-rate") {
    if (recoveryFailures.length) {
      recoveryFailures.push(`retried at ${Date.now()}`);
      runRecovery = undefined;
    } else {
      recoveryFailures.push(`IdP HTTP 429 at ${Date.now()}`);
      res.writeHead(429, { "retry-after": "1" }).end("plain");
      return;
    }
  }
  res.setHeader("content-type", "application/json");
  // A fresh short-lived proof makes each recovery attempt check the IdP, without a cache hit.
  res.end(JSON.stringify(req.url === "/api/auth/token" ? { token: await signProof("30s") } : { keys: [jwk] }));
});
await new Promise<void>(resolve => idp.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}`;
const stateDir = join(fx.dir, "keyed-auth-state"); mkdirSync(stateDir);
ensurePinnedIdp(stateDir, `${origin}/api/auth`);
const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(a.store, a.space))!, origin, "keyed-human");
const cli = grantActor(stateDir, { owner, actor: "cli", scope: ["run", "supervise"], allowSubscribe: [], allowPublish: [] });
const signProof = (ttl: string) => new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: "keyed-idp" })
  .setSubject("keyed-human").setIssuer(origin).setAudience(origin).setIssuedAt().setExpirationTime(ttl).sign(privateKey);
let service: AuthServiceHandle | undefined;
let remote: Awaited<ReturnType<typeof nativeRemoteManager>> | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
const connections: Awaited<ReturnType<typeof connect>>[] = [];
let keyedHostCalls = 0, legacyHostAdmissions = 0;
let outageStart = Infinity;
const outageMs = 20_000;
const standingRequests: { at: number; status: number }[] = [];
const brokerSockets = new Set<Socket>();
let brokerCut = false;
const brokerRelay = createRelay(client => {
  if (brokerCut) { client.destroy(); return; }
  const upstream = connectSocket(Number(new URL(fx.servers).port), "127.0.0.1");
  for (const socket of [client, upstream]) {
    brokerSockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => { brokerSockets.delete(socket); client.destroy(); upstream.destroy(); });
  }
  client.pipe(upstream).pipe(client);
});
const edge = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const now = Date.now();
    const request = req.method === "POST" ? JSON.parse(body).request : undefined;
    const standing = request?.operation === "renewStandingBundle";
    if (request?.kind === "manager-run-attempt") {
      if (runRecovery === "permanent" && request.attempt?.epoch === 2) {
        permanentRefusals++;
        res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "the original run admission was revoked" }));
        return;
      }
      if (runRecovery === "connection") {
        recoveryFailures.push("exchange connection dropped");
        runRecovery = "issuer";
        req.socket.destroy();
        return;
      }
      if (runRecovery === "issuer") {
        recoveryFailures.push("issuer restart HTTP 403");
        runRecovery = "attempt";
        res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({
          error: `the auth service for space "${a.space}" is momentarily unavailable (it detected a fault and is restarting); retry shortly`,
        }));
        return;
      }
      if (runRecovery === "attempt" && request.attempt?.epoch === 2) {
        recoveryFailures.push("driver issuance HTTP 502");
        runRecovery = undefined;
        res.writeHead(502, { "content-type": "text/plain" }).end("Bad Gateway");
        return;
      }
      if ((runRecovery === "rate-read" || runRecovery === "unsupported-read") && request.operator?.runId === recoveryRunId && request.attempt === undefined) {
        if (runRecovery === "rate-read" && recoveryFailures.length) {
          recoveryFailures.push(`retried at ${Date.now()}`);
          runRecovery = undefined;
        } else {
          const status = runRecovery === "rate-read" ? 429 : 501;
          recoveryFailures.push(status === 429 ? `operator read HTTP 429 at ${Date.now()}` : "operator read HTTP 501");
          res.writeHead(status, { "content-type": "text/plain", ...(status === 429 ? { "retry-after": "1" } : {}) }).end("plain");
          return;
        }
      }
      if (runRecovery === "rate-plain" && request.attempt?.epoch === 2) {
        if (!recoveryFailures.length) {
          recoveryFailures.push(`driver issuance HTTP 429 text at ${Date.now()}`);
          res.writeHead(429, { "content-type": "text/plain", "retry-after": "1" }).end("Too Many Requests");
          return;
        }
        recoveryFailures.push(`retried at ${Date.now()}`);
        runRecovery = undefined;
      }
      if ((runRecovery === "rate-limit" || runRecovery === "rate-bare") && request.attempt?.epoch === 2) {
        if (!recoveryFailures.length) {
          recoveryFailures.push(`driver issuance HTTP 429 at ${Date.now()}`);
          res.writeHead(429, { "content-type": "application/json", ...(runRecovery === "rate-limit" ? { "retry-after": "2" } : {}) })
            .end(JSON.stringify({ error: "too many requests" }));
          return;
        }
        recoveryFailures.push(`retried at ${Date.now()}`);
        runRecovery = undefined;
      }
      if (runRecovery === "not-implemented" && request.attempt?.epoch === 2) {
        recoveryFailures.push("driver issuance HTTP 501");
        res.writeHead(501, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "not implemented" }));
        return;
      }
    }
    const unavailable = req.url === "/manager-service-authority" && now >= outageStart && now < outageStart + outageMs;
    if (unavailable) {
      if (standing) standingRequests.push({ at: now, status: 503 });
      await wait(5_000);
      res.writeHead(503, { "content-type": "application/json" }).end('{"error":"backend_unavailable"}');
      return;
    }
    const upstream = await fetch(`${service!.publicUrl}${req.url}`, {
      method: req.method, headers: req.method === "POST" ? { "content-type": "application/json" } : {},
      ...(body ? { body } : {}),
    });
    if (standing) standingRequests.push({ at: now, status: upstream.status });
    res.writeHead(upstream.status, { "content-type": "application/json" }).end(await upstream.text());
  } catch (error) {
    res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: String(error) }));
  }
});

async function recoverInterruptedRun(
  start: () => Promise<string>,
  show: (runId: string) => Promise<RunStatusView | undefined>,
  outcome: boolean | "rate-limit" | "rate-bare" | "rate-plain" | "rate-read" | "idp-rate" | "idp-unsupported" | "not-implemented" | "unsupported-read" | "restart" = false,
  bootAgain?: () => Promise<void>,
) {
  recoveryFailures.length = 0;
  async function until<T>(description: string, observe: () => Promise<T | undefined>, ms: number): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      let result: T | undefined;
      try {
        result = await observe();
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "unavailable" && code !== "deadline-exceeded" && !(error instanceof Error && error.name === "ClosedConnectionError")) throw error;
      }
      if (result !== undefined) return result;
      assert.ok(Date.now() < end, description);
      await wait(200);
    }
  }
  const runId = await start();
  const parked = await until("run did not park before the outage", async () => {
    const view = await show(runId);
    return view?.journal.some(row => row.kind === "step" && row.step === "/sleep:before#0" && row.state === "pending") ? view : undefined;
  }, 10_000);
  assert.equal(parked.status?.epoch, 1);
  const log = console.error;
  let releasePending = false;
  const recoveryLogs: string[] = [];
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    releasePending ||= line.includes(runId) && (
      line.includes(`the "released" status write did not land`)
      || line.includes(`the "released" status was recorded after the broker became available`)
      || line.includes("released - JournalAppendRejected"));
    if (line.includes(runId) && /retrying automatic recovery|could not resume after the broker interruption/.test(line)) recoveryLogs.push(line);
    log(...args);
  };
  try {
    brokerCut = true;
    for (const socket of brokerSockets) socket.destroy();
    await until("the outage did not interrupt a journal append", async () => releasePending || undefined, 90_000);
    runRecovery = outcome === "restart" ? "attempt"
      : outcome === true ? "permanent"
      : outcome === false ? "idp"
      : outcome;
    recoveryRunId = runId;
    brokerCut = false;
    if (outcome === true) {
      await until("the permanent issuer refusal did not stop recovery", async () => recoveryLogs[0], 20_000);
      await wait(2_500);
      assert.equal(permanentRefusals, 1);
      assert.equal(recoveryLogs.length, 1);
      assert.match(recoveryLogs[0]!, /could not resume.*revoked/);
      await until("the run did not stay released", async () => (await show(runId))?.status?.state === "released" ? true : undefined, 15_000);
      console.log("PASS a permanent issuer refusal ended automatic recovery on the first attempt");
      return;
    }
    if (outcome === "not-implemented") {
      await until("the unsupported issuance did not stop recovery", async () => recoveryLogs[0], 20_000);
      await wait(2_500);
      assert.equal(recoveryFailures.length, 1);
      assert.match(recoveryLogs[0]!, /could not resume/);
      await until("the run did not stay released", async () => (await show(runId))?.status?.state === "released" ? true : undefined, 15_000);
      console.log("PASS an HTTP 501 ended automatic recovery on the first attempt");
      return;
    }
    if (outcome === "rate-limit" || outcome === "rate-bare" || outcome === "rate-plain" || outcome === "rate-read" || outcome === "idp-rate") {
      const bareMinute = outcome === "rate-bare";
      // A status read takes a fresh operator credential and a fresh IdP proof. Polling it before the
      // recovery retry would record that poll as the retry.
      if (outcome === "rate-read" || outcome === "idp-rate") {
        await until("the rate-limited read was not retried", async () => recoveryFailures.length >= 2 ? true : undefined, 40_000);
      }
      const recovered = await until("a rate-limited issuance did not recover", async () => {
        const view = await show(runId);
        return view?.status && ["running", "completed"].includes(view.status.state) && view.status.epoch === 2 ? view : undefined;
      }, bareMinute ? 180_000 : 40_000);
      const limitedAt = Number(/429.*?at (\d+)/.exec(recoveryFailures[0] ?? "")?.[1]);
      const retriedAt = Number(/retried at (\d+)/.exec(recoveryFailures[1] ?? "")?.[1]);
      const gap = retriedAt - limitedAt;
      if (outcome === "rate-limit") assert.ok(gap >= 1_500, `recovery retried ${gap}ms after the rate limit`);
      else if (bareMinute) assert.ok(gap >= 50_000, `recovery retried ${gap}ms after a rate limit with no Retry-After`);
      else assert.ok(gap >= 800, `recovery retried ${gap}ms after the rate limit`);
      assert.equal(recovered.status?.epoch, 2);
      if (outcome !== "rate-read" && outcome !== "idp-rate") assert.equal(recoveryLogs.length, 1);
      console.log(`PASS one HTTP 429 ${outcome} recovered inside the same window`);
      return;
    }
    if (outcome === "unsupported-read" || outcome === "idp-unsupported") {
      await until("the unsupported read did not stop recovery", async () => recoveryLogs[0], 20_000);
      assert.match(recoveryLogs[0]!, /could not resume/);
      await wait(2_500);
      assert.equal(recoveryLogs.length, 1);
      console.log(`PASS one HTTP 501 ${outcome} ended automatic recovery on the first attempt`);
      return;
    }
    if (outcome === "restart") {
      await until("automatic recovery did not start before the stop", async () => recoveryLogs[0], 30_000);
      assert.match(recoveryLogs[0]!, /retrying automatic recovery/);
      await remote!.manager.stop();
      runRecovery = undefined;
      await bootAgain!();
      const recovered = await until("the restarted Manager did not continue the released run", async () => {
        const view = await show(runId);
        return view?.status && ["running", "completed"].includes(view.status.state) && view.status.epoch > parked.status!.epoch ? view : undefined;
      }, 40_000);
      assert.ok(recovered.status!.epoch > parked.status!.epoch);
      console.log("PASS the same Manager continued a released run after it stopped during recovery");
      return;
    }
    await until("automatic recovery did not reach driver issuance after the transient errors", async () => runRecovery === undefined || undefined, 80_000);
    const recovered = await until("the Manager did not recover its released run", async () => {
      const view = await show(runId);
      return view?.status && ["running", "completed"].includes(view.status.state) && view.status.epoch === 2 ? view : undefined;
    }, 75_000);
    assert.deepEqual(recoveryFailures, ["IdP HTTP 500", "exchange connection dropped", "issuer restart HTTP 403", "driver issuance HTTP 502"]);
    assert.equal(recoveryLogs.length, 1);
    assert.match(recoveryLogs[0]!, /retrying automatic recovery.*HTTP 500/);
    assert.equal(recovered.status?.holder.split(".")[0], parked.status?.holder.split(".")[0]);
    assert.equal(recovered.status?.fencingToken, 2);
    assert.deepEqual(recovered.journal.flatMap(row => row.kind === "activation" ? [row.epoch] : []), [1, 2]);
    console.log("PASS the same Manager reactivated exactly once after temporary authority failures without a resume command");
  } finally {
    brokerCut = false;
    runRecovery = undefined;
    recoveryRunId = undefined;
    console.error = log;
  }
}

async function restartAuthority(root: string, runIds: string[], manager: Awaited<ReturnType<typeof nativeRemoteManager>>) {
  const { state: { instanceId }, remote: { supervisorCreds } } = manager;
  const renewedSupervisor = () => (manager.manager as unknown as { credentialRenewal: { remoteSupervisorCreds?: string } }).credentialRenewal.remoteSupervisorCreds;
  const entry = fileURLToPath(new URL("../../../bin/dist/cotal.js", import.meta.url));
  const cli = (args: string[]) => new Promise<{ code: number | string; text: string }>((resolve) => {
    execFile(process.execPath, [entry, ...args, "--space", a.space, "--on", instanceId], { cwd: root, timeout: 15_000 }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, text: `${stdout}${stderr}`.trim() });
    });
  });
  const probe = () => Promise.all(runIds.map(runId => cli(["run", "show", runId, "--json"])));
  const baseline = await probe();
  assert.ok(baseline.every(result => result.code === 0), `run show must answer before the restart: ${baseline.find(result => result.code !== 0)?.text}`);
  const { renewAt, exp } = inspectCredHealth(supervisorCreds);
  assert.ok(renewAt && exp);
  await wait(Math.max(0, renewAt * 1000 - Date.now() - 1_000));
  outageStart = Date.now();
  const restoredAt = outageStart + outageMs;
  console.log(`authority restart: ${outageMs}ms outage, original supervisor expires ${exp * 1000 - restoredAt}ms from restoration`);
  let firstStatus: number | undefined;
  let adoption: number | undefined;
  let duringRefusal: string | undefined;
  while (Date.now() < restoredAt + 20_000) {
    const at = Date.now() - restoredAt;
    if (at >= 0 && renewedSupervisor() !== supervisorCreds) adoption ??= at;
    const [results, managerStatus] = await Promise.all([probe(), at < -10_000 ? cli(["ps", "--json"]) : undefined]);
    if (managerStatus) assert.equal(managerStatus.code, 0, `Manager ps must still answer: ${managerStatus.text}`);
    const allOk = results.every(result => result.code === 0);
    if (at < 0 && !allOk) duringRefusal ??= results.find(result => result.code !== 0)?.text;
    if (at >= 0 && allOk) firstStatus ??= at;
    console.log(`run show at ${at}ms from authority restoration: ${results.map(result => result.code).join(",")}${allOk ? "" : ` ${results.find(result => result.code !== 0)?.text}`}`);
    if (firstStatus !== undefined && adoption !== undefined) break;
    await wait(1_000);
  }
  console.log("standing renewal HTTP results (ms from restoration):", standingRequests.map(row => [row.at - restoredAt, row.status]));
  assert.ok(standingRequests.some(row => row.status === 503), "scheduled renewal must hit the restart");
  assert.match(duringRefusal ?? "", /"cause":\{"code":"unavailable"\}/, "the outage must return a retryable native code");
  assert.match(duringRefusal ?? "", /retry the read in a few seconds/);
  const renewed = standingRequests.find(row => row.at >= restoredAt && row.status === 200);
  assert.ok(renewed && renewed.at - restoredAt < 8_000, "standing renewal must retry within 8 seconds of restoration");
  assert.ok(adoption !== undefined && adoption >= 0 && adoption < 10_000, `standing family adoption after authority restoration: ${adoption}ms`);
  assert.ok(firstStatus !== undefined && firstStatus < 10_000, `run show recovery after authority restoration: ${firstStatus}ms`);
  console.log(`PASS Manager adopted the renewed family within ${adoption}ms and all three run-status reads recovered within ${firstStatus}ms of authority restoration`);
}
async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${service!.url}${path}`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${service!.cap}` }, body: JSON.stringify(body) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error ?? "refused"}`);
  return result;
}
try {
  await setupSpaceStreams({ servers: fx.servers, space: a.space, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space: a.space, servers: fx.servers, auth: a.auth, reloadStoreIdentity: a.store.identity });
  service = await startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() },
    space: a.space, servers: fx.servers, stateDir, store: a.store, storeIdentity: a.store.identity,
    publicFace: { port: 0, trustedProxy: false }, standingRenewableTtlSeconds: Number(process.env.F_STANDING_TTL ?? 128) });
  const root = join(fx.dir, "keyed-manager"); mkdirSync(root);
  await new Promise<void>(resolve => edge.listen(0, "127.0.0.1", resolve));
  const edgeUrl = `http://127.0.0.1:${(edge.address() as AddressInfo).port}`;
  await new Promise<void>(resolve => brokerRelay.listen(0, "127.0.0.1", resolve));
  const brokerUrl = `nats://127.0.0.1:${(brokerRelay.address() as AddressInfo).port}`;
  const dir = userAuthStateDir(root, a.space);
  const store = workspaceSecretStore(root);
  mkdirSync(dir, { recursive: true });
  const sentinel = join(dir, "sentinel.creds");
  writeFileSync(sentinel, a.sentinelCreds, { mode: 0o600 });
  recordMesh({ space: a.space, server: fx.servers, root, mode: "user", origin: "manual", policy: { events: "required" },
    userAuth: { provider: "cotal", remote: true, idp: { url: `${origin}/api/auth`, issuer: origin, audience: origin }, endpoints: { url: edgeUrl }, sentinelCredsPath: sentinel }, ts: new Date().toISOString() });
  saveIdpSession(homeCotalDir(), `${origin}/api/auth`, { token: "fixture-session", expiresAt: Math.floor(Date.now() / 1000) + 600, sub: "keyed-human" });
  const exchangeUrl = service.publicUrl!;
  async function bootManager() {
    return nativeRemoteManager({ space: a.space, servers: brokerUrl, root, exchangeUrl, execution: "runtime", runtime: "pty",
      call: async request => {
        if (request.kind === "manager-run-submission") keyedHostCalls++;
        if (request.kind === "manager-run-admission") legacyHostAdmissions++;
        if (request.operation === "renewStandingBundle") return cotalAuthProvider.managerServiceAuthority!({ store, dir, request });
        if (request.kind === "manager-run-attempt") return cotalAuthProvider.requestRemoteRunAttempt!({ store, dir, request });
        return post("/manager-service-authority", { idpToken: await signProof("10m"), request });
      } });
  }
  remote = await bootManager();
  assert.equal(remote.owner, owner);
  async function dial() {
    const exchange = await post<{ token: string }>("/exchange", { idpToken: await signProof("10m"), actor: "cli", view: "manager-caller", managerInstanceId: remote!.state.instanceId });
    const nonce = mintLifecycleUid();
    const nc = await connect({ servers: fx.servers,
      authenticator: [credsAuthenticator(new TextEncoder().encode(a.sentinelCreds)), tokenAuthenticator(exchange.token)],
      name: nonce, inboxPrefix: `_INBOX_${nonce}`, maxReconnectAttempts: 0, timeout: 5000 });
    connections.push(nc);
    const caller = await issuedUserCaller(nc, a.space, nonce, { owner, actor: "cli", uid: cli.lifecycleUid! });
    const selected = await resolveService(nc, a.space, "manager", caller, { instanceId: remote!.state.instanceId, deadlineMs: 10_000 });
    return { nc, caller, selected };
  }
  const d = await dial(), source = { source: 'log("signerless keyed native");', file: "signerless-keyed.cotal.js" };
  const submission = prepareKeyedRunSubmission(a.space, d.selected, mintLifecycleUid(), source);
  const results = await Promise.all(Array.from({ length: 4 }, () => invokeKeyedRunSubmission(d.nc, a.space, submission, { deadlineMs: 30_000 })));
  const runId = results[0]!.runId!;
  assert.equal(new Set(results.map(r => r.runId)).size, 1);
  assert.equal((await readKeyedRunSubmission(d.nc, a.space, submission, { deadlineMs: 5000 })).runId, runId);
  assert.equal(legacyHostAdmissions, 0); assert.ok(keyedHostCalls >= 5);
  console.log("PASS actual signerless manager forwards only keyed HTTP protocol and original caller native issued evidence binds one run");
  let completed = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = await invokeCommand(d.nc, a.space, d.selected, "run-status", { runId }, { deadlineMs: 5000 });
    assert.equal(status.reply.ok, true);
    if ((status.reply.data as { status?: { state: string } }).status?.state === "completed") { completed = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(completed); console.log("PASS actual signerless driver completes harmless run with no locally held account signer or model seat");
  // Fresh exchange is a new generation, not authority to take over the original reservation.
  const fresh = await dial(); assert.notEqual(fresh.caller.generation, d.caller.generation);
  const freshSameId = prepareKeyedRunSubmission(a.space, fresh.selected, submission.submissionId, source);
  await assert.rejects(invokeKeyedRunSubmission(fresh.nc, a.space, freshSameId, { deadlineMs: 5000 }));
  assert.equal((await readKeyedRunSubmission(d.nc, a.space, submission, { deadlineMs: 5000 })).runId, runId);
  console.log("PASS fresh issued generation cannot adopt the original binding, original exact pinned read remains stable");
  const runIds = [runId];
  for (let n = 0; n < 2; n++) {
    const next = await invokeKeyedRunSubmission(d.nc, a.space, prepareKeyedRunSubmission(a.space, d.selected, mintLifecycleUid(), source), { deadlineMs: 30_000 });
    assert.ok(next.runId);
    runIds.push(next.runId);
  }
  if (!process.env.F_RECOVERY_FROM) await restartAuthority(root, runIds, remote);
  let current = await dial();
  const start = async () => {
    const reply = await invokeCommand(current.nc, a.space, current.selected, "run-start", {
      source: 'await sleep("8s", { name: "before" }); await sleep("1s", { name: "after" });',
    }, { deadlineMs: 15_000 });
    assert.equal(reply.reply.ok, true, JSON.stringify(reply.reply.error ?? reply.reply).slice(0, 400));
    return (reply.reply.data as { runId: string }).runId;
  };
  let redialedAt = 0;
  const show = async (runId: string): Promise<RunStatusView | undefined> => {
    try {
      const reply = await invokeCommand(current.nc, a.space, current.selected, "run-status", { runId }, { deadlineMs: 5_000 });
      if (reply.reply.ok === true) return reply.reply.data as RunStatusView;
      // A caller generation ends with the bearer it was minted from. Later cells outlive that bearer.
      if (!JSON.stringify(reply.reply.error ?? "").includes("expired") || Date.now() - redialedAt < 2_000) return undefined;
    } catch (error) {
      if (!(error instanceof Error && error.name === "ClosedConnectionError") || Date.now() - redialedAt < 2_000) throw error;
    }
    redialedAt = Date.now();
    saveIdpSession(homeCotalDir(), `${origin}/api/auth`, { token: "fixture-session", expiresAt: Math.floor(Date.now() / 1000) + 600, sub: "keyed-human" });
    try { await current.nc.close(); } catch { /* the broker already dropped it */ }
    current = await dial();
    return undefined;
  };
  const recoveryCells: Array<Parameters<typeof recoverInterruptedRun>[2]> = [
    undefined, true, "not-implemented", "rate-limit", "rate-bare", "rate-plain", "rate-read",
    "unsupported-read", "idp-rate", "idp-unsupported", "restart",
  ];
  const from = process.env.F_RECOVERY_FROM;
  const startAt = from ? recoveryCells.findIndex(cell => cell === from) : 0;
  assert.ok(startAt >= 0, `unknown recovery cell ${from}`);
  for (const outcome of recoveryCells.slice(startAt)) {
    await recoverInterruptedRun(start, show, outcome, outcome === "restart" ? async () => {
      remote = await bootManager();
      await current.nc.close();
      current = await dial();
    } : undefined);
  }
  console.log(JSON.stringify({ scope: "owned native signerless Manager + actual auth HTTP/encrypted callout + driver, not Cloud/webhook/deployment",
    instanceId: remote.state.instanceId, epoch: remote.epoch, submissionId: submission.submissionId, runId, keyedHostCalls, legacyHostAdmissions,
    modelSeats: 0 }));
} finally {
  const errors: unknown[] = [];
  for (const close of [...connections.map(nc => () => nc.close()), () => remote?.manager.stop(), () => service?.close(), () => delivery?.stop(),
    () => brokerRelay.listening ? new Promise<void>(resolve => {
      for (const socket of brokerSockets) socket.destroy();
      brokerRelay.close(() => resolve());
    }) : undefined,
    () => edge.listening ? new Promise<void>(resolve => edge.close(() => resolve())) : undefined,
    () => new Promise<void>((resolve, reject) => idp.close(error => error ? reject(error) : resolve())), () => fx.stopBroker()]) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  console.log(JSON.stringify({ cleanup: errors.length ? "failed" : "complete", retainedScratch: fx.dir, scope: "owned signerless fixture only" }));
  if (previousHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = previousHome;
  if (errors.length) throw new AggregateError(errors, "owned signerless fixture cleanup failed");
}
emitSentinel({ passed: counted.cells(), failed: 0 });
