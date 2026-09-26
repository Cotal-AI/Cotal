/**
 * REMOTE EXCHANGE smoke (lane U2) — the OPTIONAL public exchange face, executed against a REAL
 * auth-service daemon (self-re-exec'd, same shape as freeslot-respawn-barrier.smoke.ts), a REAL
 * broker, and a REAL Better Auth IdP. It runs BOTH listeners of one daemon side by side, which is
 * the only way most of these cells mean anything: nearly every claim below is a claim about a
 * DIFFERENCE between the two faces, so a single-listener harness could not state it.
 *
 *   A. the closed route table: GET /health, GET /jwks, POST /exchange and GET
 *      /.well-known/cotal-mesh are served on the public face and EVERYTHING else 404s — including
 *      the paths that exist on no face at all and the ones a prober would guess. Method discipline
 *      too: a GET at /exchange and a POST at /jwks are refused, so "the route exists" never means
 *      "any verb reaches it".
 *   B. the discovery bundle is GENERATED from what the daemon actually enforces — the pinned IdP
 *      url/issuer/audience, the space, the server, tlsRequired, and endpoints.url — never
 *      hand-written, and its endpoints.url is the value finalized AFTER bind (so `--port 0` cannot
 *      advertise an address nothing listens on).
 *   C. THE POINT OF THE LANE, stated as a matched pair. The SAME capless agent-exchange request:
 *        - against the PUBLIC listener  → 200 with a bearer (no capability, by design: the 0600
 *          cap is a same-uid file-ACL boundary with no remote meaning, so the proof is the
 *          credential itself — an actorToken whose sha256 matches a fresh ledger row);
 *        - against the LOOPBACK listener → still 401 (THE NEGATIVE CONTROL — the local boundary
 *          must not regress; if this cell ever goes green the feature has eaten the thing it was
 *          promised not to touch).
 *      Both directions are asserted in the same run against the same daemon, so neither can be
 *      true by accident of setup.
 *   D. the credential is really the proof, not decoration: a revoked row's actorToken is refused
 *      at the NEXT exchange on the public face with no restart, and a wrong secret is refused
 *      with the same sentence as an unknown agent (a prober learns nothing about existence).
 *   E. the public face's view policy: `purger` (and every other operator surface) is refused
 *      outright, and the same view request still reaches the bridge on loopback — a pair, so the
 *      refusal is the public face's policy and not a broken view path. `channel-writer` is the
 *      allow-list exception: a signed-in human whose row carries `admin` mints it on the public
 *      face. Agent-secret exchanges still never mint a view.
 *   F. Origin rejection, JSON-only content-type and the 64 KB body bound hold VERBATIM on the
 *      public face (they are inherited by sharing handleExchange, and this proves the sharing).
 *   G. per-peer isolation, the throttling claim: peer A floods the public face with refusals until
 *      it is throttled (429), and in that same window peer B still exchanges successfully AND the
 *      loopback face's own budget is untouched. Public throttling never consumes loopback budgets.
 *      Successful exchanges stay unthrottled (matching the existing stance): a long run of
 *      SUCCESSES never trips the limiter.
 *   H. refresh across expiry: an agent-bearer-style re-exchange with a short ttlSec yields a
 *      distinct, later-expiring bearer from the same row — the refresh loop a remote agent runs.
 *
 * Counts are asserted, not merely "no failures": a cell that silently stops running is a cell that
 * stops protecting anything, so the tail check pins the expected total.
 *
 * Run: pnpm smoke:remote-exchange:live   (pnpm build first — the daemon child runs built dist;
 * needs nats-server + node on PATH)
 */
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

// ---------- SELF-DISPATCH (must be the FIRST thing that runs) ----------
// This file re-execs ITSELF to run the auth-service daemon, so the daemon under test is the real
// registered command with the real flag parsing — including the three public-exchange flags. A
// hand-rolled in-process start would bypass exactly the declaration path we need to prove.
const SUBCOMMAND = process.argv[2] ?? "";
if (SUBCOMMAND === "auth-service") {
  await import("@cotal-ai/auth");
  const { registry } = await import("@cotal-ai/core");
  type Command = import("@cotal-ai/core").Command;
  const rest = process.argv.slice(3);
  const values: Record<string, string | boolean | undefined> = {};
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) { values[key] = next; i++; }
      else values[key] = true;
    } else positionals.push(a);
  }
  const cmd = registry.all<Command>("command").find((c) => c.name === SUBCOMMAND);
  if (!cmd) { console.error(`self-dispatch: command "${SUBCOMMAND}" is not registered`); process.exit(1); }
  try {
    await cmd.run({ values, positionals, raw: rest });
    process.exit(0);
  } catch (e) {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  }
}

// ---------- MAIN HARNESS ----------
type ChildProcess = import("node:child_process").ChildProcess;

const { spawn } = await import("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { createServer } = await import("node:http");
type AddressInfo = import("node:net").AddressInfo;

const home = mkdtempSync(join(tmpdir(), "cotal-rx-home-"));
process.env.COTAL_HOME = home;
const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}rx-root-`));

// This smoke may itself run inside a managed mesh session. The auth-service child must receive
// only this fixture's sandboxed Cotal configuration, never the runner's live broker/credential
// material. `smoke:suite-ambient-env` enforces this scrub before any `...process.env` spread.
const childEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(childEnv)) if (key.startsWith("COTAL_")) delete childEnv[key];
childEnv.COTAL_HOME = home;

const { betterAuth } = await import("better-auth");
const { memoryAdapter } = await import("better-auth/adapters/memory");
const { jwt } = await import("better-auth/plugins/jwt");
const { deviceAuthorization } = await import("better-auth/plugins/device-authorization");
const { bearer: baBearer } = await import("better-auth/plugins/bearer");
const { toNodeHandler } = await import("better-auth/node");

const { createSpaceAuth, epAuthBucket, isReachable, managedRetirementOpId, mintCreds, newIdentity, recordSpecKey, recordStatusKey,
  recordsBucket, RECORD_KINDS, remoteManagerActors, serverConfig, setupSpaceStreams, standaloneConnectOpts, mintLifecycleUid } =
  await import("@cotal-ai/core");
const { Kvm } = await import("@nats-io/kv");
const { connect } = await import("@nats-io/transport-node");
const { authDir, saveManagerInstanceIdentity, saveSpaceAuth, userAuthStateDir, workspaceSecretStore } = await import("@cotal-ai/workspace");
const {
  cotalAuthProvider, establishIdpSession, grantActor, grantManagedActor, revokeManagedActor,
  loadAuthServiceInfo, loadCalloutAuth, newActorToken,
} = await import("@cotal-ai/auth");
const { createLocalJWKSet, jwtVerify } = await import("jose");
type DeviceLoginPrompt = import("@cotal-ai/auth").DeviceLoginPrompt;
const { pickFreePort } = await import("./_free-port.js");

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = `rx-${Math.floor(Math.random() * 1e6)}`;
const CLIENT_ID = "cotal-cli";
const SELF = import.meta.filename;
const AGENT = "worker";
const dir = userAuthStateDir(root, SPACE);
const store = workspaceSecretStore(root);

/** The public face's advertised URL — an https:// value is REQUIRED by the daemon (TLS terminates
 *  at the operator's reverse proxy), so the bundle must advertise this while the listener itself
 *  is reached over plain loopback here. That divergence is the deployment shape, and B asserts it. */
const PUBLIC_URL = "https://exchange.smoke.test";

type Reply = { status: number; body: Record<string, unknown>; headers: Headers };
async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown>, headers: res.headers };
}
async function get(url: string, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await fetch(url, { headers });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown>, headers: res.headers };
}

let broker: ChildProcess | undefined;
let authChild: ChildProcess | undefined;
let jsDir: string | undefined;
const idpSrv = createServer((req, res) => handler!(req, res));
let handler: ReturnType<typeof toNodeHandler> | undefined;

try {
  // ---------- A. setup ----------
  console.log("A) broker + IdP + auth service with BOTH faces bound");
  const auth = await createSpaceAuth(SPACE);
  saveSpaceAuth(authDir(root), auth);

  await new Promise<void>((r) => idpSrv.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(idpSrv.address() as AddressInfo).port}`;
  const base = `${origin}/api/auth`;
  const ba = betterAuth({
    baseURL: origin,
    secret: "smoke-only-better-auth-secret-0123456789",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [], deviceCode: [] }),
    emailAndPassword: { enabled: true },
    plugins: [
      jwt({ jwt: { issuer: origin, audience: origin } }),
      deviceAuthorization({ expiresIn: "2m", interval: "1s", validateClient: (id) => id === CLIENT_ID }),
      baBearer(),
    ],
  });
  handler = toNodeHandler(ba);
  const signup = await ba.api.signUpEmail({
    body: { email: "human@example.test", password: "correct-horse-battery", name: "Human 42" },
    returnHeaders: true,
  });
  const cookie = signup.headers.get("set-cookie")!.split(";")[0];
  const approve = async (userCode: string): Promise<void> => {
    const claim = await fetch(`${base}/device?user_code=${encodeURIComponent(userCode)}`, { headers: { cookie, origin } });
    if (!claim.ok) throw new Error(`device claim failed: HTTP ${claim.status}`);
    const res = await fetch(`${base}/device/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin },
      body: JSON.stringify({ userCode }),
    });
    if (!res.ok) throw new Error(`device/approve failed: HTTP ${res.status}`);
  };

  const prepared = await cotalAuthProvider.prepareServer({
    store, space: SPACE, operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    dir, idpUrl: base,
  });
  const expectedCallout = await loadCalloutAuth(store, SPACE);
  if (!expectedCallout) throw new Error("prepared callout material was not persisted");
  jsDir = mkdtempSync(join(tmpdir(), "cotal-rx-js-"));
  writeFileSync(
    join(root, "server.conf"),
    serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: jsDir, extraAccounts: prepared.extraAccounts }),
  );
  broker = spawn("nats-server", ["-c", join(root, "server.conf")], { stdio: "ignore" });
  teardownOnSignal(broker);
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVER); if (!up) await wait(200); }
  check("user-auth broker is reachable", up);
  const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVER, space: SPACE, creds: provCreds });
  const putManager = async (args: { instanceId: string; principal: string; owner: string; epoch?: number; registered?: boolean; state?: "open" | "frozen" | "retired" }) => {
    const id = newIdentity();
    const nc = await connect({ servers: SERVER, ...standaloneConnectOpts({ creds: await mintCreds(auth, id, "endpoint-serve-executor", { endpointServeExecutor: { endpoint: "manager", instanceId: args.instanceId } }), tls: false }) });
    try {
      const kvm = new Kvm(nc);
      const records = await kvm.open(recordsBucket(SPACE));
      const authKv = await kvm.open(epAuthBucket(SPACE));
      let revision = 1;
      if (args.registered !== false) {
        revision = await records.put(recordSpecKey(RECORD_KINDS.svc, ["manager", args.instanceId]), new TextEncoder().encode(JSON.stringify({ endpoint: "manager", owner: args.owner, clusterDigests: [`sha256:${"a".repeat(64)}`], protocol: { v: 1 } })));
        await records.put(recordStatusKey(RECORD_KINDS.svc, ["manager", args.instanceId]), new TextEncoder().encode(JSON.stringify({ epoch: args.epoch ?? 1, state: "ready", observedSpecRevision: revision })));
      }
      const state = args.state ?? "open";
      await authKv.put(`epgate.manager.${args.instanceId}`, new TextEncoder().encode(JSON.stringify({ state, generation: 1, processEpoch: args.epoch ?? 1, registrationRevision: revision, nameAuthorityRevision: 0, principal: args.principal, ...(state === "open" ? {} : { op: { opId: mintLifecycleUid(), kind: state === "retired" ? "retirement" : "takeover" } }) })));
    } finally {
      await nc.drain();
    }
  };
  const localManagerInstanceId = mintLifecycleUid();
  const localServe = newIdentity();
  await putManager({ instanceId: localManagerInstanceId, principal: `local.${localServe.id}`, owner: "local" });

  // The daemon, started through the REAL command with the REAL public-exchange flags. `--port 0`
  // and `--exchange-public-port 0` on purpose: both faces take OS-assigned ports, which is also
  // what makes B's "endpoints.url is finalized after bind" assertion meaningful.
  const publicPort = await pickFreePort();
  authChild = spawn(
    process.execPath,
    [...process.execArgv, SELF, "auth-service", "--space", SPACE, "--server", SERVER,
     "--exchange-public-port", String(publicPort), "--exchange-public-url", PUBLIC_URL,
     "--exchange-trusted-proxy"],
    { cwd: root, env: childEnv, stdio: "ignore" },
  );
  let info: ReturnType<typeof loadAuthServiceInfo>;
  {
    const end = Date.now() + 20000;
    for (;;) {
      info = loadAuthServiceInfo(dir);
      if (info) { try { const r = await fetch(`${info.url}/health`); if (r.ok) break; } catch { /* not bound */ } }
      if (Date.now() > end) throw new Error("auth service did not become ready");
      await wait(150);
    }
  }
  const LOOPBACK = info!.url;
  const PUBLIC = `http://127.0.0.1:${publicPort}`;
  check("the daemon accepted the public-exchange flags and bound both faces", (await get(`${PUBLIC}/health`)).status === 200);
  check("the discovery file records publicUrl (what `up` copies into the registry)", info!.publicUrl === PUBLIC_URL, info);
  check("the loopback face is still up alongside it", (await get(`${LOOPBACK}/health`)).status === 200);

  // ---------- B. the generated discovery bundle ----------
  console.log("B) /.well-known/cotal-mesh is generated from enforced config");
  const wk = await get(`${PUBLIC}/.well-known/cotal-mesh`);
  const publicJwks = await get(`${PUBLIC}/jwks`);
  const verifyPublicBearer = createLocalJWKSet(publicJwks.body as { keys: import("jose").JWK[] });
  const idpPin = wk.body.userAuth.idp as { url?: string; issuer?: string; audience?: string } | undefined;
  const eps = wk.body.userAuth.endpoints as { url?: string; managerAuthorityUrl?: string } | undefined;
  check("bundle serves 200 on the public face", wk.status === 200, wk.body);
  check("bundle carries the space + server it actually serves", wk.body.space === SPACE && wk.body.server === SERVER, wk.body);
  check("bundle states tlsRequired", wk.body.tlsRequired === true, wk.body);
  check("bundle pins the SAME IdP url/issuer/audience the daemon enforces",
    idpPin?.url === base && idpPin.issuer === origin && idpPin.audience === origin,
    { advertised: idpPin, enforced: { url: base, issuer: origin, audience: origin } });
  check("bundle's endpoints.url is the post-bind advertised public URL", eps?.url === PUBLIC_URL, eps);
  check("bundle advertises the typed manager-authority endpoint", eps?.managerAuthorityUrl === `${PUBLIC_URL}/manager-service-authority`, eps);
  check("bundle ships the ACTUAL deny-all sentinel credential prepared for this space",
    wk.body.sentinelCreds === expectedCallout.sentinelCreds,
    { advertisedLength: typeof wk.body.sentinelCreds === "string" ? wk.body.sentinelCreds.length : -1, expectedLength: expectedCallout.sentinelCreds.length });
  check("the bundle is NOT served on the loopback face (it is the public face's surface)",
    (await get(`${LOOPBACK}/.well-known/cotal-mesh`)).status === 404);

  // ---------- the ledger row both C-arms use ----------
  let idpSessionToken = "";
  const OWNER = await (async () => {
    const { session, sub } = await establishIdpSession({
      dir: home, idpUrl: base, clientId: CLIENT_ID,
      onPrompt: (p: DeviceLoginPrompt) => void approve(p.userCode),
    });
    idpSessionToken = session.token;
    check("device login established", typeof sub === "string" && sub.length > 0);
    return cotalAuthProvider.ownerForLogin({ store, dir, space: SPACE });
  })();
  grantActor(dir, { owner: OWNER, actor: "cli", scope: ["spawn", "supervise", "role:worker"], allowSubscribe: [">"], allowPublish: [">"], label: "smoke operator" });
  const secret = newActorToken();
  const agentLifecycleUid = mintLifecycleUid();
  grantManagedActor(dir, {
    owner: OWNER, actor: AGENT, scope: ["role:worker"], allowSubscribe: ["general"], allowPublish: ["general"],
    parent: `${OWNER}.cli`, tokenHash: secret.tokenHash, lifecycleUid: agentLifecycleUid,
  });
  const agentBody = { owner: OWNER, actor: AGENT, actorToken: secret.actorToken };

  const beforeLocalFile = await post(`${PUBLIC}/exchange`, { ...agentBody, view: "manager-caller" });
  check("without a persisted local manager identity and no remote gate, manager-caller refuses none",
    beforeLocalFile.status === 401 && String(beforeLocalFile.body.error).includes("no manager candidate"), beforeLocalFile);
  saveManagerInstanceIdentity(root, SPACE, { instanceId: localManagerInstanceId, serveIdentity: localServe });
  const localManagerCall = await post(`${PUBLIC}/exchange`, { ...agentBody, view: "manager-caller" });
  check("manager-caller re-reads a newly created local identity file and selects its live manager",
    localManagerCall.status === 200 && localManagerCall.body.managerInstanceId === localManagerInstanceId, localManagerCall);
  const explicitLocal = await post(`${PUBLIC}/exchange`, { ...agentBody, view: "manager-caller", managerInstanceId: localManagerInstanceId });
  check("the public face serves an explicit selector naming the live co-located manager",
    explicitLocal.status === 200 && explicitLocal.body.managerInstanceId === localManagerInstanceId, explicitLocal);

  const remoteOne = mintLifecycleUid();
  await putManager({ instanceId: remoteOne, principal: `${OWNER}.${remoteManagerActors(remoteOne).serve}`, owner: OWNER });
  const remoteSelected = await post(`${PUBLIC}/exchange`, { ...agentBody, view: "manager-caller" });
  check("one live remote manager takes precedence over the local candidate",
    remoteSelected.status === 200 && remoteSelected.body.managerInstanceId === remoteOne, remoteSelected);
  const parentIndependent = await post(`${PUBLIC}/exchange`, { ...agentBody, view: "manager-caller", managerInstanceId: remoteOne });
  check("the managed row's parent plays no part in manager selection", parentIndependent.status === 200, parentIndependent);
  const remoteTwo = mintLifecycleUid();
  await putManager({ instanceId: remoteTwo, principal: `${OWNER}.${remoteManagerActors(remoteTwo).serve}`, owner: OWNER });
  const ambiguous = await post(`${PUBLIC}/exchange`, { ...agentBody, view: "manager-caller" });
  check("two live remote managers refuse and name the count",
    ambiguous.status === 401 && String(ambiguous.body.error).includes("2 live remote manager candidates"), ambiguous);
  const explicitRemote = await post(`${PUBLIC}/exchange`, { ...agentBody, view: "manager-caller", managerInstanceId: remoteTwo });
  check("an explicit selector chooses one live own remote manager",
    explicitRemote.status === 200 && explicitRemote.body.managerInstanceId === remoteTwo, explicitRemote);
  const foreign = mintLifecycleUid();
  await putManager({ instanceId: foreign, principal: `${"u_" + "f".repeat(26)}.${remoteManagerActors(foreign).serve}`, owner: "u_" + "f".repeat(26) });
  const foreignSelector = await post(`${PUBLIC}/exchange`, { ...agentBody, view: "manager-caller", managerInstanceId: foreign });
  check("an explicit selector outside the owner's candidate set refuses by owner",
    foreignSelector.status === 401 && String(foreignSelector.body.error).includes("not this owner's"), foreignSelector);
  const stopped = mintLifecycleUid();
  await putManager({ instanceId: stopped, principal: `${OWNER}.${remoteManagerActors(stopped).serve}`, owner: OWNER, registered: false });
  const stoppedSelector = await post(`${PUBLIC}/exchange`, { ...agentBody, view: "manager-caller", managerInstanceId: stopped });
  check("an explicit selector naming an open but deregistered manager refuses not registered",
    stoppedSelector.status === 401 && String(stoppedSelector.body.error).includes("not registered"), stoppedSelector);
  const unavailableOwner = "u_" + "z".repeat(26);
  const unavailableActor = "unavailable";
  const unavailableSecret = newActorToken();
  grantManagedActor(dir, { owner: unavailableOwner, actor: unavailableActor, scope: [], allowSubscribe: [], allowPublish: [], tokenHash: unavailableSecret.tokenHash, lifecycleUid: mintLifecycleUid() });
  const unavailableId = mintLifecycleUid();
  await putManager({ instanceId: unavailableId, principal: `${unavailableOwner}.${remoteManagerActors(unavailableId).serve}`, owner: unavailableOwner, state: "frozen" });
  const unavailable = await post(`${PUBLIC}/exchange`, { owner: unavailableOwner, actor: unavailableActor, actorToken: unavailableSecret.actorToken, view: "manager-caller" });
  check("an unavailable owner remote manager refuses with the explicit-selector remedy instead of falling through local",
    unavailable.status === 401 && String(unavailable.body.error).includes("unavailable") && String(unavailable.body.error).includes("managerInstanceId"), unavailable);
  const wrongLocalOwner = "u_" + "y".repeat(26);
  const wrongLocalActor = "wronglocal";
  const wrongLocalSecret = newActorToken();
  grantManagedActor(dir, { owner: wrongLocalOwner, actor: wrongLocalActor, scope: [], allowSubscribe: [], allowPublish: [], tokenHash: wrongLocalSecret.tokenHash, lifecycleUid: mintLifecycleUid() });
  const wrongLocalId = mintLifecycleUid();
  await putManager({ instanceId: wrongLocalId, principal: `local.${newIdentity().id}`, owner: "local" });
  const wrongLocal = await post(`${PUBLIC}/exchange`, { owner: wrongLocalOwner, actor: wrongLocalActor, actorToken: wrongLocalSecret.actorToken, view: "manager-caller", managerInstanceId: wrongLocalId });
  check("a local gate under a serve id different from the persisted identity is not a candidate",
    wrongLocal.status === 401 && String(wrongLocal.body.error).includes("not this owner's"), wrongLocal);

  // Reproduction control: managed-agent secrets cannot request any existing view. This stays after
  // manager-caller lands to prove the one narrow exception did not widen the other view names.
  const agentView = await post(`${PUBLIC}/exchange`, { ...agentBody, view: "channel-writer" });
  check("a managed-agent secret asking for a non-manager view is refused 400 with the existing text",
    agentView.status === 400 && agentView.body.error === "the managed (agent-secret) exchange never mints elevated views - views ride a signed-in human exchange",
    agentView);

  // ---------- C. the matched pair: capless public 200 vs capless loopback 401 ----------
  console.log("C) the SAME capless request: public mints, loopback still 401s");
  const capless = await post(`${PUBLIC}/exchange`, agentBody);
  check("agent exchange succeeds WITHOUT a capability on the public face", capless.status === 200, capless.body);
  check("…and returns a real bearer for the granted owner",
    typeof capless.body.token === "string" && capless.body.owner === OWNER && typeof capless.body.exp === "number", capless.body);
  {
    let signed = false;
    let detail: unknown;
    try {
      const { payload, protectedHeader } = await jwtVerify(capless.body.token as string, verifyPublicBearer, {
        algorithms: ["EdDSA"], issuer: `urn:cotal:auth:${SPACE}`, audience: SPACE,
      });
      const act = payload.act as { actor?: string } | undefined;
      detail = { header: protectedHeader, act };
      signed = protectedHeader.alg === "EdDSA" && act?.actor === AGENT;
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e);
    }
    check("…is EdDSA-SIGNED by the public JWKS and carries the granted actor", signed, detail);
  }
  // THE NEGATIVE CONTROL. Byte-for-byte the same request, the other listener.
  const caplessLoopback = await post(`${LOOPBACK}/exchange`, agentBody);
  check("NEGATIVE CONTROL: the SAME capless request against LOOPBACK is still 401",
    caplessLoopback.status === 401, caplessLoopback);
  check("…refused for the capability specifically, not the credential", /capability/i.test(String(caplessLoopback.body.error)), caplessLoopback.body);
  // And loopback WITH the cap still works — so the 401 above is the gate, not a broken face.
  const withCap = await post(`${LOOPBACK}/exchange`, agentBody, { authorization: `Bearer ${info!.cap}` });
  check("loopback WITH the capability still mints (the 401 is the gate, not a broken face)", withCap.status === 200, withCap.body);

  // ---------- D. the credential is the proof ----------
  console.log("D) revocation and wrong secrets bite on the public face");
  const wrongSecret = await post(`${PUBLIC}/exchange`, { ...agentBody, actorToken: newActorToken().actorToken });
  check("a wrong actorToken is refused on the public face", wrongSecret.status === 401, wrongSecret.body);
  const unknownAgent = await post(`${PUBLIC}/exchange`, { owner: OWNER, actor: "ghost", actorToken: secret.actorToken });
  check("an unknown agent is refused with the SAME sentence (no existence oracle)",
    unknownAgent.status === 401 && unknownAgent.body.error === wrongSecret.body.error, { unknownAgent: unknownAgent.body, wrongSecret: wrongSecret.body });
  check("revoking the row takes effect with no restart", revokeManagedActor(dir, OWNER, AGENT));
  const afterRevoke = await post(`${PUBLIC}/exchange`, agentBody);
  check("a revoked row's actorToken is refused at the NEXT public exchange", afterRevoke.status === 401, afterRevoke.body);
  // Restore the row for the cells below (a fresh secret, as a real respawn would).
  const secret2 = newActorToken();
  grantManagedActor(dir, {
    owner: OWNER, actor: AGENT, scope: ["role:worker"], allowSubscribe: ["general"], allowPublish: ["general"],
    parent: `${OWNER}.cli`, tokenHash: secret2.tokenHash, lifecycleUid: agentLifecycleUid,
  });
  const agentBody2 = { owner: OWNER, actor: AGENT, actorToken: secret2.actorToken };
  check("the re-granted row exchanges again on the public face", (await post(`${PUBLIC}/exchange`, agentBody2)).status === 200);

  // ---------- E. views stay loopback-only except channel-writer / channel-purger ----------
  console.log("E) operator views refused on the public face; channel-writer mints when admin is granted");
  const idpJwt = await (async () => {
    const { fetchIdpJwt } = await import("@cotal-ai/auth");
    return fetchIdpJwt(base, idpSessionToken);
  })();
  const viewPublic = await post(`${PUBLIC}/exchange`, { idpToken: idpJwt, actor: "cli", view: "purger" });
  check("a `view` request is REFUSED on the public face (403)", viewPublic.status === 403, viewPublic.body);
  check("…naming it as a loopback operator surface", /loopback/i.test(String(viewPublic.body.error)), viewPublic.body);
  // The pair: the same view request on loopback is NOT refused by this rule. `cli` lacks scope
  // "admin", so the bridge refuses it 401 on its own merits — the point is that it reaches the
  // bridge at all (401 from the ledger, never the 403 face-refusal above).
  const viewLoopback = await post(`${LOOPBACK}/exchange`, { idpToken: idpJwt, actor: "cli", view: "purger" }, { authorization: `Bearer ${info!.cap}` });
  check("the same view request on LOOPBACK reaches the bridge (not the face refusal)",
    viewLoopback.status !== 403, viewLoopback);
  grantActor(dir, { owner: OWNER, actor: "cli", scope: ["spawn", "supervise", "admin", "role:worker"], allowSubscribe: [">"], allowPublish: [">"], label: "smoke operator" });
  const writerPublic = await post(`${PUBLIC}/exchange`, { idpToken: idpJwt, actor: "cli", view: "channel-writer" });
  let writerView = "";
  try {
    const { payload } = await jwtVerify(writerPublic.body.token as string, verifyPublicBearer, {
      algorithms: ["EdDSA"], issuer: `urn:cotal:auth:${SPACE}`, audience: SPACE,
    });
    writerView = (payload.act as { view?: string } | undefined)?.view ?? "";
  } catch { /* checked below */ }
  check("a channel-writer view mints on the public face when the row has admin",
    writerPublic.status === 200 && writerView === "channel-writer", { status: writerPublic.status, writerView, body: writerPublic.body });
  const humanManagerCall = await post(`${PUBLIC}/exchange`, { idpToken: idpJwt, actor: "cli", view: "manager-caller", managerInstanceId: remoteOne });
  check("the public human exchange serves manager-caller and returns the selected instance",
    humanManagerCall.status === 200 && humanManagerCall.body.managerInstanceId === remoteOne, humanManagerCall);

  // ---------- F. inherited hardening holds verbatim ----------
  const ids = Object.fromEntries(["supervisor", "executor", "serve", "goalWriter", "sessionLedger"].map((name) => [name, { id: newIdentity().id }]));
  const mgrPrepare = await post(`${PUBLIC}/manager-service-authority`, { idpToken: idpJwt, request: {
    v: 1, kind: "manager-service-authority", operation: "prepare", space: SPACE, actor: "cli",
    instanceId: mintLifecycleUid(), managerLifecycleUid: mintLifecycleUid(), requestId: `req${mintLifecycleUid()}`, identities: ids,
  } });
  check("the public typed manager-authority route accepts supervise scope", mgrPrepare.status === 200 && (mgrPrepare.body.credentials as Record<string, unknown>)?.supervisor !== undefined, mgrPrepare.body);
  const rawProfile = await post(`${PUBLIC}/exchange`, { idpToken: idpJwt, actor: "cli", view: "manager-service" });
  check("the public exchange still refuses raw manager-service view/profile strings", rawProfile.status === 403, rawProfile.body);

  console.log("F) Origin / content-type / body bound on the public face");
  const browser = await post(`${PUBLIC}/exchange`, agentBody2, { origin: "https://evil.example" });
  check("browser-origin requests are refused on the public face (403)", browser.status === 403, browser.body);
  check("no CORS headers, ever", browser.headers.get("access-control-allow-origin") === null);
  const wrongType = await fetch(`${PUBLIC}/exchange`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
  check("non-JSON content-type is refused (415)", wrongType.status === 415);
  const sizedJson = (bytes: number) => `{"pad":"${"x".repeat(bytes - 10)}"}`;
  const atLimitBody = sizedJson(64 * 1024);
  if (Buffer.byteLength(atLimitBody) !== 64 * 1024) throw new Error("body-bound fixture is not exactly 65536 bytes");
  const atLimit = await post(`${PUBLIC}/exchange`, atLimitBody);
  check("an EXACTLY 64-KB valid JSON body reaches exchange validation (400, not size refusal)",
    atLimit.status === 400 && /exchange needs/.test(String(atLimit.body.error)), atLimit);
  const overLimitBody = sizedJson(64 * 1024 + 1);
  if (Buffer.byteLength(overLimitBody) !== 64 * 1024 + 1) throw new Error("body-bound fixture is not exactly 65537 bytes");
  const overLimit = await post(`${PUBLIC}/exchange`, overLimitBody);
  check("a 65537-byte body gets the SERVER's exact 413 size refusal",
    overLimit.status === 413 && overLimit.body.error === "request body too large (maximum 65536 bytes)", overLimit);

  // ---------- A(cont). the closed route table ----------
  console.log("A') the public route table is closed");
  check("GET /health is served on the public face", (await get(`${PUBLIC}/health`)).status === 200);
  check("POST /health is refused (GET only)", (await post(`${PUBLIC}/health`, {})).status === 405);
  check("GET /jwks is served on the public face", publicJwks.status === 200);
  check("…with the exact cache contract max-age=300", publicJwks.headers.get("cache-control") === "max-age=300");
  let notFound = 0;
  for (const p of ["/", "/exchange/", "/manager-service-authority/", "/manager-service-authority/verify-enrollment", "/interactive-lifecycle/retire", "/managed-lifecycle/retire", "/admin", "/views", "/actor", "/ledger", "/health/", "/.well-known/", "/..%2f", "/toString", "/constructor"]) {
    if ((await get(`${PUBLIC}${p}`)).status === 404) notFound++;
  }
  check("every non-route path 404s on the public face (15/15, incl. all three private host doors + prototype-chain probes)", notFound === 15, { notFound });
  // The public face must refuse the enrollment door for a POST too, not only the GET the census
  // above sent: a route table closed to one verb and open to another is not closed.
  check("the enrollment-verification door 404s on the public face for POST as well",
    (await post(`${PUBLIC}/manager-service-authority/verify-enrollment`, { owner: OWNER, request: {} })).status === 404);
  check("GET at /exchange is refused (POST only)", (await get(`${PUBLIC}/exchange`)).status === 405);
  // The loopback managed-retire door (#2070): the same request guards as the interactive door, on
  // the loopback face only. Its outcome table runs against the real plane in managed-retire-door.smoke.ts.
  const MRD = `${LOOPBACK}/managed-lifecycle/retire`;
  const mrdProbe = { owner: "u_" + "a".repeat(26), actor: "ghost", lifecycleUid: "a".repeat(26) };
  const capHdr = { authorization: `Bearer ${info!.cap}` };
  check("managed-retire door: GET is refused (POST only)", (await get(MRD)).status === 405);
  check("managed-retire door: a browser Origin is refused (403)", (await post(MRD, mrdProbe, { ...capHdr, origin: "https://evil.example" })).status === 403);
  check("managed-retire door: a non-JSON content type is refused (415)", (await post(MRD, JSON.stringify(mrdProbe), { ...capHdr, "content-type": "text/plain" })).status === 415);
  check("managed-retire door: a missing capability is refused (401)", (await post(MRD, mrdProbe)).status === 401);
  check("managed-retire door: a wrong capability is refused (401)", (await post(MRD, mrdProbe, { authorization: "Bearer wrong" })).status === 401);
  check("managed-retire door: an unknown extra field is refused (400)", (await post(MRD, { ...mrdProbe, takeover: true }, capHdr)).status === 400);
  check("managed-retire door: a missing field is refused (400)", (await post(MRD, { owner: mrdProbe.owner, actor: mrdProbe.actor }, capHdr)).status === 400);
  const mrdOk = await post(MRD, mrdProbe, capHdr);
  check("POSITIVE CONTROL: a well-formed capped request reaches the plane (no head, so notStarted)",
    mrdOk.status === 200 && mrdOk.body.notStarted === true && mrdOk.body.retired === false, mrdOk);
  check("POST at /jwks is refused (GET only)", (await post(`${PUBLIC}/jwks`, {})).status === 405);

  // ---------- the #1972 enrollment-verification door, on the loopback face only ----------
  // This is the door a host platform calls for the DECISION while it owns every write. Its request
  // guards match the managed-retire door's; what is unique here is that the caller's capability
  // scope is derived from THIS machine's ledger and never read from the body.
  console.log("A'') the enrollment-verification door is loopback-only and derives its own scope");
  const VED = `${LOOPBACK}/manager-service-authority/verify-enrollment`;
  const vedInstance = mintLifecycleUid();
  const vedServe = remoteManagerActors(vedInstance).serve;
  await putManager({ instanceId: vedInstance, principal: `${OWNER}.${vedServe}`, owner: OWNER, epoch: 3 });
  const vedIdentities = Object.fromEntries(["supervisor", "executor", "serve", "goalWriter", "sessionLedger"].map((n) => [n, { id: newIdentity().id }]));
  const vedRequest = (overrides: Record<string, unknown> = {}) => ({
    v: 1, kind: "manager-managed-agent-enrollment", space: SPACE, actor: "cli",
    instanceId: vedInstance, managerLifecycleUid: mintLifecycleUid(),
    requestId: `enroll${mintLifecycleUid()}`,
    // A deliberately WRONG proof: the door must reach the proof check (403), which is what proves it
    // got past the cap, the parser, and its own internal scope derivation. The proof itself is
    // exercised against the real plane in managed-agent-enrollment.smoke.ts, where the harness holds
    // the signing seed; this daemon's seed is its own and is never handed out, which is the point.
    registrationProof: `sha256:${"f".repeat(64)}`,
    serveEpoch: 3,
    target: { actor: "enrolled", tokenHash: newActorToken().tokenHash, allowSubscribe: ["general"] },
    identities: vedIdentities,
    ...overrides,
  });
  check("enrollment door: GET is refused (POST only)", (await get(VED)).status === 405);
  check("enrollment door: a browser Origin is refused (403)",
    (await post(VED, { owner: OWNER, request: vedRequest() }, { ...capHdr, origin: "https://evil.example" })).status === 403);
  check("enrollment door: a non-JSON content type is refused (415)",
    (await post(VED, JSON.stringify({ owner: OWNER, request: vedRequest() }), { ...capHdr, "content-type": "text/plain" })).status === 415);
  check("enrollment door: a missing capability is refused (401)", (await post(VED, { owner: OWNER, request: vedRequest() })).status === 401);
  check("enrollment door: a wrong capability is refused (401)",
    (await post(VED, { owner: OWNER, request: vedRequest() }, { authorization: "Bearer wrong" })).status === 401);
  // THE SCOPE-DERIVATION CELL. A caller that hands the door a scope array gets its request refused
  // as malformed rather than honoured: the body is closed to { owner, request }, so there is no
  // field through which a platform bug could forward a participant-supplied `supervise`.
  const vedScope = await post(VED, { owner: OWNER, request: vedRequest(), scope: ["supervise"] }, capHdr);
  check("enrollment door: a caller-supplied scope field is refused (400) - scope is derived, never accepted",
    vedScope.status === 400 && /unknown field "scope"/.test(String(vedScope.body.error)), vedScope);
  const vedKind = await post(VED, { owner: OWNER, request: { ...vedRequest(), kind: "manager-service-authority" } }, capHdr);
  check("enrollment door: a foreign request kind is refused (400)", vedKind.status === 400, vedKind);
  const vedUngranted = await post(VED, { owner: `u_${"q".repeat(26)}`, request: vedRequest() }, capHdr);
  check("enrollment door: an owner with no interactive ledger row is refused (403) by the derived scope read",
    vedUngranted.status === 403 && /not granted/.test(String(vedUngranted.body.error)), vedUngranted);
  // `cli` holds spawn+supervise+admin at this point in the run, so this request passes the derived
  // scope check and is refused on the PROOF instead — the cell that proves the door reaches the
  // plane's real gate and proof verification rather than stopping at its own request validation.
  const vedProof = await post(VED, { owner: OWNER, request: vedRequest() }, capHdr);
  check("POSITIVE CONTROL: a capped, well-formed request reaches the plane's proof check (403 on the forged proof)",
    vedProof.status === 403 && /does not match current host registration/.test(String(vedProof.body.error)), vedProof);
  const vedStale = await post(VED, { owner: OWNER, request: vedRequest({ serveEpoch: 2 }) }, capHdr);
  check("enrollment door: a stale serve epoch maps the envelope conflict to 409",
    vedStale.status === 409 && /is stale/.test(String(vedStale.body.error)), vedStale);
  const vedFrozenInstance = mintLifecycleUid();
  await putManager({ instanceId: vedFrozenInstance, principal: `${OWNER}.${remoteManagerActors(vedFrozenInstance).serve}`, owner: OWNER, state: "frozen" });
  const vedFrozen = await post(VED, { owner: OWNER, request: vedRequest({ instanceId: vedFrozenInstance, serveEpoch: 1 }) }, capHdr);
  check("enrollment door: a frozen manager gate maps the failed precondition to 412",
    vedFrozen.status === 412 && /no current open manager gate/.test(String(vedFrozen.body.error)), vedFrozen);
  const vedPrepare = await post(VED, { owner: OWNER, request: {
    v: 1, kind: "manager-managed-agent-prepare-retirement", space: SPACE, actor: "cli",
    instanceId: vedInstance, managerLifecycleUid: mintLifecycleUid(), requestId: `prepare${mintLifecycleUid()}`,
    registrationProof: `sha256:${"f".repeat(64)}`, serveEpoch: 3,
    target: { owner: OWNER, actor: "enrolled", lifecycleUid: agentLifecycleUid },
    opId: managedRetirementOpId(agentLifecycleUid), identities: vedIdentities,
  } }, capHdr);
  check("enrollment door: the SAME door serves prepare-retirement and reaches its proof check (403)",
    vedPrepare.status === 403 && /does not match current host registration/.test(String(vedPrepare.body.error)), vedPrepare);
  // The dispatch refusal, on the wire: the same enrollment request through the manager-authority
  // route is refused as unimplemented rather than answered as a manager-lifecycle phase.
  const dispatched = await post(`${LOOPBACK}/manager-service-authority`, { idpToken: idpJwt, request: vedRequest() }, capHdr);
  check("the typed manager-authority route refuses an enrollment kind (host interception owns it)",
    dispatched.status === 403 && /must be handled by host platform interception/.test(String(dispatched.body.error)), dispatched);

  // ---------- G. per-peer isolation + budget separation ----------
  console.log("G) per-peer failure isolation; public throttling never touches loopback");
  // This daemon was deliberately started with --exchange-trusted-proxy, so the public peer key is
  // the LAST X-Forwarded-For hop while the loopback listener remains capability-gated and keeps
  // its own budgets. Presenting two peer keys on ONE public listener proves isolation without a
  // second service or a second authority plane muddying the result.
  const asPeer = (ip: string) => ({ "x-forwarded-for": `10.0.0.1, ${ip}` });

  // Peer A floods REFUSALS until throttled. The limiter is 30 refusals/min, so 40 is past it.
  let aThrottled = false;
  for (let i = 0; i < 40; i++) {
    const r = await post(`${PUBLIC}/exchange`, { ...agentBody2, actorToken: newActorToken().actorToken }, asPeer("203.0.113.7"));
    if (r.status === 429) { aThrottled = true; break; }
  }
  check("peer A's refusal flood throttles peer A (429)", aThrottled);
  // In that same window: peer B is untouched.
  const bOk = await post(`${PUBLIC}/exchange`, agentBody2, asPeer("198.51.100.9"));
  check("PER-SOURCE ISOLATION: peer B still exchanges while peer A is throttled", bOk.status === 200, bOk.body);
  // …and so is the loopback face of that same daemon (separate budgets entirely).
  const loopbackBudgetOk = await post(`${LOOPBACK}/exchange`, agentBody2, { authorization: `Bearer ${info!.cap}` });
  check("BUDGET SEPARATION: the loopback face is unaffected by the public flood", loopbackBudgetOk.status === 200, loopbackBudgetOk.body);
  // Successes stay unthrottled — the existing stance, now on the public face.
  let successes = 0;
  for (let i = 0; i < 40; i++) {
    const r = await post(`${PUBLIC}/exchange`, agentBody2, asPeer("198.51.100.9"));
    if (r.status === 200) successes++;
  }
  check("successful exchanges are never throttled (40/40 on one peer)", successes === 40, { successes });

  // A VALID credential still mints while its own bucket is full.
  //
  // This is the cell the whole throttle depends on and it did not exist. The gate used to run
  // before the body was read, so a full bucket refused every request from that peer key - valid
  // ones included. On the public face the DEFAULT peer key is the socket address, so in the
  // reverse-proxy topology `run-a-mesh.md` recommends (without --exchange-trusted-proxy) every
  // client shares one bucket, and thirty unauthenticated garbage POSTs denied the public mint
  // path for a rolling minute (#802). The cells above cannot see it: they only ever ask whether a
  // throttled peer is refused, never whether a LEGITIMATE caller behind that same key still works.
  //
  // Throttling exists to slow probing, and a valid credential is not probing.
  const victim = asPeer("203.0.113.44");
  let victimThrottled = false;
  for (let i = 0; i < 40; i++) {
    const r = await post(`${PUBLIC}/exchange`, { ...agentBody2, actorToken: newActorToken().actorToken }, victim);
    if (r.status === 429) { victimThrottled = true; break; }
  }
  check("a peer key is throttled after a refusal flood", victimThrottled);
  const validWhileFull = await post(`${PUBLIC}/exchange`, agentBody2, victim);
  check(
    "A VALID TOKEN STILL MINTS (200) FROM A THROTTLED PEER KEY - a full bucket must not deny a request that would succeed",
    validWhileFull.status === 200,
    { status: validWhileFull.status, body: validWhileFull.body },
  );
  // ...and the budget still does its job: a FAILED exchange from that same throttled key is
  // answered 429 rather than its specific reason, because the reason is what makes probing cheap.
  const failedWhileFull = await post(
    `${PUBLIC}/exchange`,
    { ...agentBody2, actorToken: newActorToken().actorToken },
    victim,
  );
  check(
    "a FAILED exchange from a throttled key is answered 429, not the refusal reason",
    failedWhileFull.status === 429,
    { status: failedWhileFull.status, body: failedWhileFull.body },
  );

  // ---------- H. refresh across expiry ----------
  console.log("H) agent-bearer-style refresh yields a fresh, later-expiring bearer");
  const first = await post(`${PUBLIC}/exchange`, { ...agentBody2, ttlSec: 1 });
  check("a one-second bearer mints on the public face", first.status === 200, first.body);
  await wait(1500); // cross its actual expiry; this is a refresh-across-expiry cell, not arithmetic
  check("the first bearer really expired before refresh", (first.body.exp as number) <= Math.floor(Date.now() / 1000), first.body);
  const second = await post(`${PUBLIC}/exchange`, { ...agentBody2, ttlSec: 300 });
  check("the refresh mints again from the same row AFTER expiry", second.status === 200, second.body);
  check("…a DISTINCT bearer", second.body.token !== first.body.token);
  check("…expiring strictly later than the one it replaces", (second.body.exp as number) > (first.body.exp as number),
    { first: first.body.exp, second: second.body.exp });

} finally {
  authChild?.kill("SIGKILL");
  broker?.kill("SIGKILL");
  idpSrv.close();
  await wait(200);
  for (const d of [home, root, jsDir]) if (d) rmSync(d, { recursive: true, force: true });
}

// Counts, not just "no failures": a cell that stops running stops protecting anything.
const EXPECTED = 89;
console.log(`\nremote-exchange smoke: ${pass} passed, ${fail} failed`);
if (pass + fail !== EXPECTED) {
  console.log(`  ✗ FAIL: expected ${EXPECTED} cells, ran ${pass + fail} - a cell was added or silently skipped`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);
