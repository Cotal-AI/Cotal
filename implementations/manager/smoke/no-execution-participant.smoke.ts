// Native acceptance composition. The IdP publishes a real signed JWKS, auth-service owns
// all grants/issuance, and the participant owns genuine PTY children. No provider/model runs.
if (process.argv[2] === "agent-bearer") {
  await import(new URL("../../../bin/dist/cotal.js", import.meta.url).href);
} else {
  await main();
}
async function main() {
  const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
  const { createServer } = await import("node:http");
  const { createRequire } = await import("node:module");
  const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const { join, resolve } = await import("node:path");
  const { SignJWT, generateKeyPair, exportJWK, decodeJwt } = createRequire(new URL("../../auth/package.json", import.meta.url))("jose") as any;
  const { CotalEndpoint, mintLifecycleUid, mintCreds, newIdentity, setupSpaceStreams, registry, standaloneConnectOpts, issuedUserCaller, resolveService, invokeCommand, provisionAgentDurables } = await import("@cotal-ai/core");
  const { connect } = await import("@nats-io/transport-node");
  const { startAuthService, grantActor, loadOwnerSecret, deriveOwnerForIdpSubject } = await import("../../auth/dist/index.js");
  const { startHostedAuthFixture } = await import("../../auth/smoke/_hosted-auth-fixture.js");
  const { bootDeliveryDaemon } = await import("./_boot-delivery.js");
  const { nativeRemoteManager } = await import("./_native-remote-manager.js");
  const { nativeAccountConnections } = await import("./_native-account-connections.js");
  const { remoteManagerClient } = await import("../dist/index.js");
  const { meshSessionTransport } = await import("../../cli/src/lib/attach-client.js");
  await import("../../runtime/dist/index.js");
  const { emitSentinel } = await import("@cotal-ai/smoke-kit");
  let passed = 0;
  const check = (name: string, c: unknown) => { assert.ok(c, name); passed++; console.log(`PASS ${name}`); };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn: () => Promise<boolean> | boolean) => { for (let i = 0; i < 200; i++) { if (await fn()) return true; await wait(100); } return false; };
  const pair = await generateKeyPair("EdDSA", { extractable: true });
  const jwk = { ...await exportJWK(pair.publicKey), kid: "native-idp", alg: "EdDSA", use: "sig" };
  const idp = createServer((q, s) => { if (q.url !== "/api/auth/jwks") { s.writeHead(404); s.end(); return; } s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}`;
  const jwt = (sub: string) => new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid }).setIssuer(origin).setAudience(origin).setSubject(sub).setIssuedAt().setExpirationTime("10m").sign(pair.privateKey);
  const fx = await startHostedAuthFixture("native-selected", 1); const a = fx.accounts[0]!;
  // The disposable fixture's existing dummy pin is replaced before service boot. No live issuer changes.
  writeFileSync(join(a.stateDir, "idp.json"), JSON.stringify({ ver: 1, url: `${origin}/api/auth`, issuer: origin, audience: origin, jwksUri: `${origin}/api/auth/jwks` }), { mode: 0o600 });
  const root = join(fx.dir, "participant"), controlRoot = join(fx.dir, "control");
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true }); mkdirSync(controlRoot);
  const controlState = remoteManagerClient.loadOrCreateRemoteManagerIdentity(controlRoot, a.space);
  const assignment = { v: 1 as const, space: a.space, accountPublicKey: a.accountPublicKey, instanceId: controlState.instanceId, lifecycleUid: controlState.lifecycleUid, assignmentRevision: 1, state: "assigned" as const };
  const ownerSecret = (await loadOwnerSecret(a.store, a.space))!;
  const owner = deriveOwnerForIdpSubject(ownerSecret, origin, "owner"), otherOwner = deriveOwnerForIdpSubject(ownerSecret, origin, "other");
  for (const o of [owner, otherOwner]) grantActor(a.stateDir, { owner: o, actor: "cli", lifecycleUid: mintLifecycleUid(), scope: ["supervise", "spawn", "run"], allowSubscribe: [], allowPublish: [] });
  const freelanceUid = mintLifecycleUid();
  grantActor(a.stateDir, { owner, actor: "freelance", lifecycleUid: freelanceUid, scope: [], allowSubscribe: [], allowPublish: [] });
  const token = await jwt("owner"), otherToken = await jwt("other");
  let service: Awaited<ReturnType<typeof startAuthService>> | undefined;
  let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
  let participant: Awaited<ReturnType<typeof nativeRemoteManager>> | undefined;
  let control: Awaited<ReturnType<typeof nativeRemoteManager>> | undefined;
  let caller: Awaited<ReturnType<typeof connect>> | undefined;
  let sessionNc: Awaited<ReturnType<typeof connect>> | undefined;
  let freelance: InstanceType<typeof CotalEndpoint> | undefined;
  let transport: ReturnType<typeof meshSessionTransport> | undefined;
  let launched = 0, enrollments = 0;
  const sink = join(root, "sink"), ready = join(root, "ready"); writeFileSync(sink, "");
  writeFileSync(join(root, ".cotal", "agents", "native.md"), "---\nname: native\nagent: native-selected\ncapabilities: []\nallowSubscribe: []\nallowPublish: []\n---\n");
  const connector: import("@cotal-ai/core").Connector = { kind: "connector", name: "native-selected", requires: ["node"], buildLaunch: (o) => {
    assert.ok(o.userAuth); launched++;
    return { command: process.execPath, args: [resolve("implementations/manager/smoke/native-participant-child.mjs")], env: {
      PATH: process.env.PATH!, HOME: process.env.HOME!, TMPDIR: process.env.TMPDIR!, COTAL_HOME: process.env.COTAL_HOME!,
      COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers), COTAL_NAME: o.name, COTAL_LIFECYCLE_UID: String(o.lifecycleUid),
      COTAL_OWNER: o.userAuth.owner, COTAL_ACTOR: o.userAuth.actor, COTAL_SENTINEL_CREDS: o.userAuth.sentinelCredsPath,
      COTAL_BEARER_CMD: JSON.stringify(o.userAuth.bearerCmd), COTAL_NATIVE_SINK: sink, COTAL_NATIVE_READY: ready,
    } };
  } };
  registry.register(connector);
  try {
    await setupSpaceStreams({ space: a.space, servers: fx.servers, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
    delivery = await bootDeliveryDaemon({ space: a.space, servers: fx.servers, auth: a.auth, reloadStoreIdentity: a.store.identity });
    service = await startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity, publicFace: { port: 0, trustedProxy: false }, platformControl: { observeAssignment: async () => assignment } });
    const humanCall = async (request: any) => { if (request.kind === "manager-managed-agent-enrollment") enrollments++; const response = await fetch(`${service!.publicUrl}/manager-service-authority`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idpToken: token, request }) }); const body = await response.json() as any; if (!response.ok) throw new Error(`native authority refused ${request.kind}: ${body.error}`); return body; };
    const controlCall = (request: any) => service!.platformControlAuthority!({ v: 1, kind: "platform-control-authority", space: a.space, accountPublicKey: a.accountPublicKey, assignmentRevision: 1, request });
    control = await nativeRemoteManager({ space: a.space, servers: fx.servers, root: controlRoot, exchangeUrl: service.publicUrl!, execution: "none", call: controlCall });
    participant = await nativeRemoteManager({ space: a.space, servers: fx.servers, root, exchangeUrl: service.publicUrl!, execution: "runtime", call: humanCall });
    check("same account holds actual noexec control and signerless local participant", control.manager.execution === "none" && participant.manager.execution === "runtime" && participant.owner === owner);
    const connections = await nativeAccountConnections(a.auth, fx.servers);
    const keys = [participant.remote, control.remote].flatMap((r) => Object.entries(r.identities).filter(([duty]) => duty !== "executor").map(([, i]) => i.id));
    check("broker witnesses each Manager's four persistent standing identities", keys.every((key) => connections.some((row) => row.user === key)));
    const classSpawn = `cotal.${a.space}.ep.v1.one.manager.spawn.>`;
    const controlServe = connections.find((row) => row.subscriptions.includes(`cotal.${a.space}.ep.v1.inst.manager.${control!.state.instanceId}.spawn.>`));
    const participantServe = connections.find((row) => row.subscriptions.includes(`cotal.${a.space}.ep.v1.inst.manager.${participant!.state.instanceId}.spawn.>`));
    check("broker sees control instance and participant instance separately", controlServe && participantServe);
    check("noexec cannot steal class spawn while participant is available", !controlServe!.subscriptions.includes(classSpawn) && participantServe!.subscriptions.includes(classSpawn));
    const exchange = async (body: any, publicFace = true) => { const response = await fetch(`${publicFace ? service!.publicUrl : service!.url}/exchange`, { method: "POST", headers: { "content-type": "application/json", ...(!publicFace ? { authorization: `Bearer ${service!.cap}` } : {}) }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as any }; };
    const ex = await exchange({ idpToken: token, actor: "cli", view: "manager-caller", managerInstanceId: participant.state.instanceId });
    check("stock exchange issues immutable participant-scoped manager-caller", ex.status === 200 && ex.body.managerInstanceId === participant.state.instanceId);
    const claims = decodeJwt(ex.body.token) as any;
    const connectOptions = standaloneConnectOpts({ bearer: ex.body.token, sentinelCreds: a.sentinelCreds, tls: false });
    caller = await connect({ servers: fx.servers, ...connectOptions });
    const issued = await issuedUserCaller(caller, a.space, String(connectOptions.name), { owner, actor: "cli", uid: claims.act.lifecycleUid });
    const selected = await resolveService(caller, a.space, "manager", issued, { instanceId: participant.state.instanceId });
    const call = async (command: string, args?: any, target?: any) => { const r = await invokeCommand(caller!, a.space, selected, command, args, { deadlineMs: 25000, ...(target ? { target } : {}) }); assert.equal(r.responder.instanceId, participant!.state.instanceId); return r.reply; };
    const baseline = await exchange({ idpToken: token, actor: "freelance" }); assert.equal(baseline.status, 200);
    const provisioner = new CotalEndpoint({ space: a.space, servers: fx.servers, creds: await mintCreds(a.auth, newIdentity(), "provisioner"), card: { name: "native-provisioner", kind: "endpoint" }, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false });
    await provisioner.start();
    try { await provisionAgentDurables(provisioner, { owner, actor: "freelance", lifecycleUid: freelanceUid }); } finally { await provisioner.stop(); }
    freelance = new CotalEndpoint({ space: a.space, servers: fx.servers, bearer: baseline.body.token, sentinelCreds: a.sentinelCreds, lifecycleUid: freelanceUid, channels: [], consume: false, watchPresence: false, watchChannels: false, registerPresence: true, card: { owner, actor: "freelance", name: "freelance", kind: "agent" } });
    freelance.on("error", (error) => { console.error("native unmanaged presence:", error.message); });
    await freelance.start();
    const notOwned = await call("attach", undefined, { mode: "owner", owner, actor: "freelance", lifecycleUid: freelanceUid });
    check("real unmanaged presence is never adopted as a participant terminal", !notOwned.ok && notOwned.error?.code === "expired" && /no current lifecycle mapping/.test(notOwned.error.message));
    const foreign = await exchange({ idpToken: otherToken, actor: "cli", view: "manager-caller", managerInstanceId: participant.state.instanceId });
    check("other owner cannot obtain this participant manager-caller", foreign.status !== 200 && foreign.body.token === undefined);
    const wrong = await resolveService(caller, a.space, "manager", issued, { instanceId: control.state.instanceId, deadlineMs: 2000 }).then(() => false, (e: Error) => /REFUSED BY THE BROKER|permission|another/i.test(e.message));
    check("participant credential is broker-refused on other control instance", wrong);
    const source = `const a = await spawn("native", { placement: { endpoint: "manager", instanceId: "${participant.state.instanceId}" }, events: false }); await checkpoint("hold", "Keep native child?"); log(a.agent);`;
    const started = await call("run-start", { source, file: "native-selected.cotal.js" }); assert.ok(started.ok); const runId = (started.data as any).runId;
    let run: any;
    check("real signerless own-placement workflow parks after native child spawn", await until(async () => { const r = await call("run-status", { runId }); if (!r.ok) return false; run = r.data; return run.journal.some((r: any) => r.state === "pending" && r.step === "/checkpoint:hold#0"); }));
    const inspected = await call("inspect", { name: "native" }); assert.ok(inspected.ok); const row = inspected.data as any;
    check("selected participant owns child UID and control owns no child", row.lifecycleUid && (await service.platformControlReadiness!(control.state.instanceId)).reply.ok && launched === 1 && enrollments === 1);
    check("actual user-auth child registered ready with empty sink", await until(() => existsSync(ready)) && readFileSync(sink).length === 0);
    const target = { mode: "owner" as const, owner, actor: "native", lifecycleUid: row.lifecycleUid };
    const badUid = await call("attach", undefined, { ...target, lifecycleUid: mintLifecycleUid() });
    check("wrong lifecycle UID cannot establish participant session", !badUid.ok && badUid.error?.code === "expired" && /current mapping/.test(badUid.error.message));
    const deniedInput = await call("input", { text: "native" }, target).then(() => false, (e: Error) => /REFUSED BY THE BROKER/.test(e.message));
    check("ordinary selected user cannot mint operator-only input reach", deniedInput && readFileSync(sink).length === 0);
    const attached = await call("attach", undefined, target); assert.ok(attached.ok); const grant = (attached.data as any).grant;
    const sc = await exchange({ idpToken: token, actor: "cli", view: "session-caller", sessionGrant: grant }, false);
    check("real redeemed session exchanges for holder session-caller bearer", sc.status === 200 && typeof sc.body.token === "string");
    const otherSession = await exchange({ idpToken: otherToken, actor: "cli", view: "session-caller", sessionGrant: grant }, false);
    check("other owner cannot redeem held participant terminal authority", otherSession.status !== 200 && otherSession.body.token === undefined && /was issued to/.test(otherSession.body.error));
    sessionNc = await connect({ servers: fx.servers, ...standaloneConnectOpts({ bearer: sc.body.token, sentinelCreds: a.sentinelCreds, tls: false }) });
    let sessionReady = false, ended: string | undefined; const received: Buffer[] = [];
    transport = meshSessionTransport(sessionNc, grant); transport.onReady(() => { sessionReady = true; }); transport.onData((b) => { received.push(b); }); transport.onEnd((_e, reason) => { ended = reason; });
    check("redeemed signerless terminal rail completes real ready handshake", await until(() => sessionReady));
    const before = readFileSync(sink).length; transport.send(Buffer.from("session-byte"));
    check("redeemed terminal sends real bytes to participant child", await until(() => readFileSync(sink).subarray(before).equals(Buffer.from("session-byte"))));
    check("redeemed terminal returns real child output", await until(() => Buffer.concat(received).includes(Buffer.from("session-byte"))));
    transport.close(); check("terminal detach ends session distinctly", await until(() => ended === "detached")); await sessionNc.close(); sessionNc = undefined;
    const answered = await call("run-answer", { runId, stepKey: "/checkpoint:hold#0", value: "done" }, { mode: "self" }); assert.ok(answered.ok);
    check("signerless selected workflow completes after real checkpoint answer", await until(async () => { const r = await call("run-status", { runId }); return r.ok && (r.data as any).status.state === "completed"; }));
    check("workflow completion retires child from genuine participant inventory", await until(async () => { const r = await call("inspect", { name: "native" }); return !r.ok; }));
    await caller.close(); caller = undefined;
    await participant.manager.stop({ withAgents: true }); await control.manager.stop();
    const closed = await nativeAccountConnections(a.auth, fx.servers);
    check("broker observes both Managers' standing connections actually closed", closed.every((row) => !keys.includes(row.user ?? "")));
    console.log(`native signerless participant: ${passed} assertions passed`); emitSentinel({ passed, failed: 0 });
  } finally {
    transport?.close(); await sessionNc?.close(); await caller?.close(); await freelance?.stop(); await participant?.manager.stop({ withAgents: true }); await control?.manager.stop();
    try { await service?.close(); } finally { await delivery?.stop(); await fx.close(); await new Promise<void>((r) => idp.close(() => r())); }
  }
}
