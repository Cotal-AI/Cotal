import * as core from "../../../packages/core/dist/index.js";
import * as auth from "../../auth/dist/index.js";
// The browser Manager caller in a REAL browser. A headless Chromium loads a page served with a
// strict CSP (`script-src 'self'`, no `unsafe-eval`) whose script is an esbuild `platform: "browser"`
// bundle of the public `@cotal-ai/core/browser-control` entry and the Manager contracts generated
// with `generateBrowserContracts(managerBrowserContractSource())`. The page dials the broker's
// websocket listener as the signed-in person, with authority from the stock exchange through a
// server-side bridge (as an embedding's backend forwards the person's IdP proof), against two real
// owner-registered Managers on the native composition (no-execution-participant.smoke.ts).
//
// Cells: the person's own instance list; a bearer for one instance refused for another; calls
// answered only by the selected instance; an accepted spawn followed to its terminal and read back
// with a verified goal-result fact, before and after a page reload, and never submitted again;
// refused, unknown and unavailable outcomes kept distinct; another Manager's forged terminals for
// the followed goal ignored; the CSP enforced with no violation.
//
// The browser is `COTAL_SMOKE_BROWSER`, or the first Chromium-family binary on PATH. There is no
// substitute for a real browser here, so a host without one refuses.
if (process.argv[2] === "agent-bearer") {
  await import(new URL("../../../bin/dist/cotal.js", import.meta.url).href);
} else {
  await main();
}
async function main() {
  const { createServer } = await import("node:http");
  const { createRequire } = await import("node:module");
  const { spawn } = await import("node:child_process");
  const { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { delimiter, dirname, join, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { build } = await import("esbuild");
  const { SignJWT, generateKeyPair, exportJWK } = createRequire(new URL("../../auth/package.json", import.meta.url))("jose") as any;
  const { mintLifecycleUid, mintCreds, newIdentity, setupSpaceStreams, registry, epeSubject, goalProgressTopic, epGoalProgressGrantRow, standaloneConnectOpts } = core;
  const { connect } = await import("@nats-io/transport-node");
  const { credsAuthenticator } = await import("@nats-io/nats-core");
  const { generateBrowserContracts } = await import("../../../packages/core/dist/browser-validators-build.js");
  const { startAuthService, grantActor, loadOwnerSecret, deriveOwnerForIdpSubject } = auth;
  const { startHostedAuthFixture } = await import("../../auth/smoke/_hosted-auth-fixture.js");
  const { bootDeliveryDaemon } = await import("./_boot-delivery.js");
  const { nativeRemoteManager } = await import("./_native-remote-manager.js");
  const { managerBrowserContractSource } = await import("../dist/index.js");
  await import("../../runtime/dist/index.js");
  const { emitSentinel, killAndAwaitExit } = await import("@cotal-ai/smoke-kit");

  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  // Every cell runs and is counted; a red cell does not hide the ones after it.
  const EXPECTED = 27;
  let passed = 0, failed = 0;
  const check = (name: string, ok: unknown, detail?: unknown) => {
    if (ok) { passed++; console.log(`PASS ${name}`); } else { failed++; console.log(`FAIL ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`); }
  };

  const browser = (() => {
    const named = process.env.COTAL_SMOKE_BROWSER;
    if (named) { if (!existsSync(named)) throw new Error(`COTAL_SMOKE_BROWSER names no file: ${named}`); return named; }
    for (const dir of (process.env.PATH ?? "").split(delimiter))
      for (const name of ["chrome-headless-shell", "chromium", "chromium-browser", "google-chrome-stable", "google-chrome"])
        if (dir && existsSync(join(dir, name))) return join(dir, name);
    throw new Error("no Chromium-family browser on PATH and COTAL_SMOKE_BROWSER is unset; this smoke drives a real browser and has no substitute");
  })();

  // The host's build: the Manager's contracts generated once, the page bundled for the browser.
  const generated = generateBrowserContracts([managerBrowserContractSource()]);
  const coreDir = dirname(fileURLToPath(new URL("../../../packages/core/package.json", import.meta.url)));
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./browser-manager-caller.page.mjs", import.meta.url))],
    bundle: true, format: "esm", platform: "browser", target: "es2022", write: false, metafile: true, logLevel: "silent",
    plugins: [{ name: "manager-contracts", setup(b) {
      b.onResolve({ filter: /^virtual:manager-contracts$/ }, () => ({ path: "manager-contracts", namespace: "contracts" }));
      b.onLoad({ filter: /.*/, namespace: "contracts" }, () => ({ contents: generated.text, loader: "js", resolveDir: coreDir }));
    } }],
  });
  const pageJs = bundle.outputFiles[0]!.text;
  const bundled = Object.keys(bundle.metafile.inputs);
  check("C01 the page bundles for platform=browser from the public entry, with no Node built-in",
    bundled.some((p) => p.includes("browser-control")) && !bundled.some((p) => p.startsWith("node:")) && !Object.values(bundle.metafile.outputs).some((o) => o.imports.some((i) => i.external)),
    bundled.filter((p) => p.startsWith("node:")));

  const pair = await generateKeyPair("EdDSA", { extractable: true });
  const jwk = { ...await exportJWK(pair.publicKey), kid: "browser-idp", alg: "EdDSA", use: "sig" };
  const idp = createServer((q, s) => { if (q.url !== "/api/auth/jwks") { s.writeHead(404); s.end(); return; } s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}`;
  const jwt = (sub: string) => new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid }).setIssuer(origin).setAudience(origin).setSubject(sub).setIssuedAt().setExpirationTime("10m").sign(pair.privateKey);
  const fx = await startHostedAuthFixture("browser-mgr", 1, { websocket: true }); const a = fx.accounts[0]!;
  writeFileSync(join(a.stateDir, "idp.json"), JSON.stringify({ ver: 1, url: `${origin}/api/auth`, issuer: origin, audience: origin, jwksUri: `${origin}/api/auth/jwks` }), { mode: 0o600 });
  const rootA = join(fx.dir, "manager-a"), rootB = join(fx.dir, "manager-b");
  mkdirSync(join(rootA, ".cotal", "agents"), { recursive: true }); mkdirSync(rootB);
  const ownerSecret = (await loadOwnerSecret(a.store, a.space))!;
  const owner = deriveOwnerForIdpSubject(ownerSecret, origin, "owner"), otherOwner = deriveOwnerForIdpSubject(ownerSecret, origin, "other");
  // `cli` registers the person's Managers (the fixture's actor); `web` is the page's actor.
  for (const actor of ["cli", "web"]) grantActor(a.stateDir, { owner, actor, lifecycleUid: mintLifecycleUid(), scope: ["supervise", "spawn", "run"], allowSubscribe: [], allowPublish: [] });
  const tokens = { owner: await jwt("owner"), other: await jwt("other") };

  // Personas on Manager A: one whose child registers ready, two whose children never do.
  const launches: Record<string, number> = { native: 0, slow: 0, decoy: 0 };
  const sink = join(rootA, "sink"), ready = join(rootA, "ready"); writeFileSync(sink, "");
  writeFileSync(join(rootA, ".cotal", "agents", "native.md"), "---\nname: native\nagent: browser-native\ncapabilities: []\nallowSubscribe: []\nallowPublish: []\n---\n");
  for (const name of ["slow", "decoy"]) writeFileSync(join(rootA, ".cotal", "agents", `${name}.md`), `---\nname: ${name}\nagent: browser-slow\ncapabilities: []\nallowSubscribe: []\nallowPublish: []\n---\n`);
  const childEnv = { PATH: process.env.PATH!, HOME: process.env.HOME!, TMPDIR: process.env.TMPDIR!, ...(process.env.COTAL_HOME ? { COTAL_HOME: process.env.COTAL_HOME } : {}) };
  registry.register({ kind: "connector", name: "browser-native", requires: ["node"], buildLaunch: (o) => {
    launches.native++;
    return { command: process.execPath, args: [resolve("implementations/manager/smoke/native-participant-child.mjs")], env: {
      ...childEnv, COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers), COTAL_NAME: o.name, COTAL_LIFECYCLE_UID: String(o.lifecycleUid),
      COTAL_OWNER: o.userAuth!.owner, COTAL_ACTOR: o.userAuth!.actor, COTAL_SENTINEL_CREDS: o.userAuth!.sentinelCredsPath,
      COTAL_BEARER_CMD: JSON.stringify(o.userAuth!.bearerCmd), COTAL_NATIVE_SINK: sink, COTAL_NATIVE_READY: ready,
    } };
  } } as import("@cotal-ai/core").Connector);
  registry.register({ kind: "connector", name: "browser-slow", requires: ["node"], readinessTimeoutMs: 15_000, buildLaunch: (o) => {
    launches[o.name] = (launches[o.name] ?? 0) + 1;
    return { command: process.execPath, args: ["-e", "setInterval(() => {}, 1 << 30)"], env: childEnv };
  } } as import("@cotal-ai/core").Connector);

  let service: Awaited<ReturnType<typeof startAuthService>> | undefined;
  let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
  let managerA: Awaited<ReturnType<typeof nativeRemoteManager>> | undefined;
  let managerB: Awaited<ReturnType<typeof nativeRemoteManager>> | undefined;
  let page: import("node:http").Server | undefined;
  let chrome: import("node:child_process").ChildProcess | undefined;
  const profile = mkdtempSync(join(tmpdir(), "browser-manager-"));
  try {
    await setupSpaceStreams({ space: a.space, servers: fx.servers, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
    delivery = await bootDeliveryDaemon({ space: a.space, servers: fx.servers, auth: a.auth, reloadStoreIdentity: a.store.identity });
    service = await startAuthService({ context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: a.space, servers: fx.servers, stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity, publicFace: { port: 0, trustedProxy: false } });
    const humanCall = async (request: any) => { const response = await fetch(`${service!.publicUrl}/manager-service-authority`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idpToken: tokens.owner, request }) }); const body = await response.json() as any; if (!response.ok) throw new Error(`native authority refused ${request.kind}: ${body.error}`); return body; };
    managerA = await nativeRemoteManager({ space: a.space, servers: fx.servers, root: rootA, exchangeUrl: service.publicUrl!, execution: "runtime", call: humanCall });
    managerB = await nativeRemoteManager({ space: a.space, servers: fx.servers, root: rootB, exchangeUrl: service.publicUrl!, execution: "runtime", call: humanCall });
    const A = managerA.state.instanceId, B = managerB.state.instanceId;

    // The page's origin. `/bridge/*` is the embedding backend's server-side forward (no Origin).
    const csp = `default-src 'none'; script-src 'self'; connect-src 'self' ${fx.wsServers}; base-uri 'none'; form-action 'none'`;
    const results: any[] = [];
    let resultArrived: () => void = () => {};
    const forward = async (path: string, body: unknown) => { const r = await fetch(`${service!.publicUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const readBody = async (q: import("node:http").IncomingMessage) => { const chunks: Buffer[] = []; for await (const c of q) chunks.push(c as Buffer); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; };
    // Each route answers `{ status, body }`; a forward passes the auth service's own answer through.
    const routes: Record<string, (body: any) => Promise<{ status: number; body: unknown }>> = {
      "/config": async () => ({ status: 200, body: { space: a.space, wsServers: fx.wsServers, sentinelCreds: a.sentinelCreds, instances: { a: A, b: B }, cwd: rootA, abortAfterMs: 5_000 } }),
      "/bridge/manager-instances": async (body) => forward("/manager-instances", { idpToken: body.as === "other" ? tokens.other : tokens.owner }),
      "/bridge/exchange": async (body) => forward("/exchange", { idpToken: tokens.owner, actor: "web", view: "manager-caller", managerInstanceId: body.managerInstanceId }),
      "/control/launches": async () => ({ status: 200, body: { ...launches } }),
      "/control/forge": async (body) => { forging = forgeTerminals(body.goalId, body.caller); return { status: 200, body: { started: true } }; },
      "/control/forge-report": async () => { await forging; return { status: 200, body: forge }; },
      "/control/stop-b": async () => { await managerB!.manager.stop({ withAgents: true }); managerB = undefined; return { status: 200, body: { stopped: true } }; },
      "/result": async (body) => { results.push({ ...body, launches: { ...launches } }); resultArrived(); return { status: 200, body: { stored: results.length } }; },
    };
    // Manager B, with its own real serve credential, forges `succeeded` terminals for a goal the page
    // follows on A: once under A's instance (the broker must refuse it), and repeatedly under its own,
    // with the followed goal in the subject and with another goal in the subject but the followed one
    // in the body. An observer holding the person's own view counts what reaches their progress rows.
    const forge = { published: 0, denials: [] as string[], deniedUnderA: false, observed: { underA: 0, matching: 0, mismatched: 0 } };
    let forging: Promise<void> | undefined;
    const forgeTerminals = async (goalId: string, caller: { owner: string; actor: string; uid: string }) => {
      const b = managerB!.remote, aSide = managerA!.remote;
      const enc = new TextEncoder();
      const hostile = await connect({ servers: fx.servers, authenticator: credsAuthenticator(enc.encode(b.serveCreds)), inboxPrefix: `_INBOX_${b.identities.serve.id}`, maxReconnectAttempts: 0 });
      const ex = await forward("/exchange", { idpToken: tokens.owner, actor: "web", view: "manager-caller", managerInstanceId: A });
      const observer = await connect({ servers: fx.servers, ...standaloneConnectOpts({ bearer: (ex.body as any).token, sentinelCreds: a.sentinelCreds, tls: false }), maxReconnectAttempts: 0 });
      try {
        observer.subscribe(epGoalProgressGrantRow(a.space, "manager", caller), { callback: (_e, m) => {
          const forged: unknown = (() => { try { return JSON.parse(new TextDecoder().decode(m.data))?.data?.forged; } catch { return undefined; } })();
          if (forged === "under-a") forge.observed.underA++;
          else if (forged === "matching") forge.observed.matching++;
          else if (forged === "mismatched") forge.observed.mismatched++;
        } });
        await observer.flush();
        void (async () => { for await (const st of hostile.status()) if (st.type === "error") forge.denials.push(String((st as any).error?.message ?? "")); })();
        const terminal = (forged: string) => enc.encode(JSON.stringify({ v: 1, goalId, phase: "terminal", state: "succeeded", data: { forged } }));
        const ref = (g: string) => ({ endpoint: "manager", caller, goalId: g });
        const underA = epeSubject(a.space, "manager", A, aSide.serveGrant.epoch, goalProgressTopic(ref(goalId)));
        hostile.publish(underA, terminal("under-a"));
        for (let i = 0; i < 30; i++) {
          hostile.publish(epeSubject(a.space, "manager", B, b.serveGrant.epoch, goalProgressTopic(ref(goalId))), terminal("matching"));
          hostile.publish(epeSubject(a.space, "manager", B, b.serveGrant.epoch, goalProgressTopic(ref(`${goalId.slice(0, -1)}${goalId.endsWith("a") ? "b" : "a"}`))), terminal("mismatched"));
          forge.published += 2;
          await wait(250);
        }
        await hostile.flush(); await observer.flush(); await wait(500);
        forge.deniedUnderA = forge.denials.some((d) => /permission/i.test(d) && d.includes(underA));
      } finally {
        await hostile.close(); await observer.close();
      }
    };
    page = createServer((q, s) => void (async () => {
      const path = (q.url ?? "/").split("?")[0]!;
      if (q.method === "GET" && path === "/") {
        s.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": csp, "cache-control": "no-store" });
        s.end(`<!doctype html><meta charset="utf-8"><title>browser manager caller</title><script type="module" src="/page.js"></script>`);
        return;
      }
      if (q.method === "GET" && path === "/page.js") { s.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }); s.end(pageJs); return; }
      const route = routes[path];
      if (!route) { s.writeHead(404); s.end(); return; }
      try {
        const out = await route(q.method === "POST" ? await readBody(q) : {});
        s.writeHead(out.status, { "content-type": "application/json" }); s.end(JSON.stringify(out.body));
      } catch (e) {
        s.writeHead(500, { "content-type": "application/json" }); s.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
    })());
    await new Promise<void>((r) => page!.listen(0, "127.0.0.1", r));
    const pageUrl = `http://127.0.0.1:${(page.address() as import("node:net").AddressInfo).port}/`;
    check("C02 the page is served with a strict CSP: script-src 'self', no unsafe-eval or unsafe-inline",
      csp.includes("script-src 'self'") && !csp.includes("unsafe-eval") && !csp.includes("unsafe-inline"), csp);

    const both = new Promise<void>((done) => { resultArrived = () => { if (results.length >= 2) done(); }; });
    const stderr: string[] = [];
    chrome = spawn(browser, ["--headless", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", `--user-data-dir=${profile}`, pageUrl], { stdio: ["ignore", "ignore", "pipe"] });
    chrome.stderr!.on("data", (d: Buffer) => { stderr.push(d.toString("utf8")); if (stderr.length > 40) stderr.shift(); });
    const exited = new Promise<number | null>((r) => chrome!.once("exit", (code) => r(code)));
    const outcome = await Promise.race([both.then(() => "done"), exited.then((code) => `browser exited ${code}`), new Promise<string>((r) => setTimeout(() => r("timeout"), 180_000))]);
    if (outcome !== "done") console.log(`browser run ended: ${outcome}; results ${results.length}; stderr tail:\n${stderr.join("").slice(-2000)}`);
    const [first, reload] = [results.find((r) => r.phase === "first") ?? {}, results.find((r) => r.phase === "reload") ?? {}];
    console.log(JSON.stringify({ first, reload }, null, 1).slice(0, 12_000));

    const ok = (o: any) => o?.ok === true ? o.value : undefined;
    const err = (o: any) => o?.ok === false ? o.error : undefined;
    check("C03 the CSP is enforced: the page's eval control is blocked", first.evalBlocked === true, first.evalBlocked);
    check("C04 no CSP violation besides the eval control, in either load",
      Array.isArray(first.violations) && Array.isArray(reload.violations) && [...first.violations, ...reload.violations].every((v: any) => v.blocked === "eval"), [first.violations, reload.violations]);
    check("C05 the public entry exports openBrowserManagerCaller and verifyGoalResultFact",
      first.exports?.openBrowserManagerCaller === "function" && first.exports?.verifyGoalResultFact === "function", first.exports);
    const list = ok(first.list), rows = (list?.body?.instances ?? []) as Array<{ instanceId: string; placement: string; state: string }>;
    check("C06 POST /manager-instances lists the person's own two live Managers, complete and closed",
      list?.status === 200 && list.body.v === 1 && list.body.owner === owner && list.body.complete === true && Object.keys(list.body).sort().join() === "complete,instances,owner,v"
        && rows.length === 2 && [A, B].every((id) => rows.some((r) => r.instanceId === id && r.placement === "remote" && r.state === "candidate")), list);
    const other = ok(first.listOther);
    check("C07 another person lists none of them", other?.status === 200 && other.body.owner === otherOwner && Array.isArray(other.body.instances) && other.body.instances.length === 0, other);
    check("C08 a bearer issued for one instance is refused for another before the caller opens",
      /different manager instance/.test(err(first.pinMismatch)?.message ?? "") && first.pinMismatchAcquired === 1, [first.pinMismatch, first.pinMismatchAcquired]);
    check("C09 each caller is described by exactly its selected instance",
      ok(first.openA)?.instanceId === A && ok(first.openA)?.responder === A && ok(first.openB)?.instanceId === B && ok(first.openB)?.responder === B, [first.openA, first.openB]);
    check("C10 a read is answered by the selected instance only",
      ok(first.readA)?.outcome === "replied" && ok(first.readA)?.responder === A && ok(first.readB)?.outcome === "replied" && ok(first.readB)?.responder === B, [first.readA, first.readB]);
    check("C11 a goal without the caller's persisted id is refused before sending",
      err(first.noId)?.code === "bad-request" && err(first.noId)?.outcome === "not-executed", first.noId);
    const spawned = ok(first.spawn);
    check("C12 the confirmed spawn is followed to success on the selected instance and launched once",
      spawned?.ok === true && spawned.responder === A && first.afterSpawn?.native === 1, [first.spawn, first.afterSpawn]);
    const read = ok(first.reconcile);
    check("C13 the goal reads back through goal-result as a verified succeeded fact committed by that instance",
      read?.outcome === "replied" && read.goalId !== undefined && read.state === "succeeded" && read.committer?.instanceId === A, first.reconcile);
    check("C14 a fact whose payload was altered is refused by verifyGoalResultFact",
      /outcomeDigest/.test(err(first.tampered)?.message ?? ""), first.tampered);
    const refused = ok(first.refused);
    check("C15 a spawn the Manager refuses is a refusal: an error reply, not an unknown outcome, and nothing launched",
      refused?.ok === false && refused.responder === A && refused.code === "failed-precondition" && /no persona "missing"/.test(refused.message ?? "") && refused.errorOutcome === "not-executed" && first.launches?.native === 1, first.refused);
    const unknown = ok(first.unknown) ?? err(first.unknown);
    check("C16 a follow stopped after the submission reports outcome unknown, not a refusal",
      (ok(first.unknown)?.ok === false && ok(first.unknown)?.errorOutcome === "unknown") || err(first.unknown)?.outcome === "unknown", unknown);
    check("C17 that goal was launched once and reads back still pending",
      first.afterUnknown?.slow === 1 && ok(first.unknownRead)?.outcome === "replied" && ok(first.unknownRead)?.pending === true, [first.afterUnknown, first.unknownRead]);
    check("C18 an instance that stopped answers nothing: unavailable, distinct from a refusal",
      ok(first.stopB)?.body?.stopped === true && err(first.unavailable)?.unanswered === true, [first.stopB, first.unavailable]);
    check("C19 after a page reload the caller reopens on the same instance", ok(reload.reopenA)?.instanceId === A && ok(reload.reopenA)?.responder === A, reload.reopenA);
    const reloadRead = ok(reload.reloadRead);
    check("C20 the reloaded page reads the same succeeded goal back without submitting it",
      reloadRead?.state === "succeeded" && reloadRead.committer?.instanceId === A && reload.launches?.native === 1, [reload.reloadRead, reload.launches]);
    const settled = ok(reload.slowSettled);
    check("C21 the unknown goal later reads back as its own verified terminal, committed by that instance",
      settled?.pending === false && typeof settled.state === "string" && settled.state !== "succeeded" && settled.committer?.instanceId === A, reload.slowSettled);
    check("C22 the unknown goal was launched exactly once: never resubmitted", reload.launches?.slow === 1, reload.launches);
    check("C23 the browser stayed up for both loads", outcome === "done", outcome);
    check("C25 Manager B's own serve credential cannot publish goal progress under A's instance (a broker refusal)",
      first.forge?.deniedUnderA === true && first.forge.observed?.underA === 0, first.forge);
    check("C26 B's forged succeeded terminals reach the person's own progress rows, with the followed goal or another goal in the subject (instrument control)",
      first.forge?.observed?.matching > 0 && first.forge.observed.mismatched > 0, first.forge?.observed);
    const hostile = ok(first.hostile);
    check("C27 the follow ignores them and returns A's own terminal for that goal, not B's forged success, and launches it once",
      hostile?.ok === false && hostile.responder === A && typeof hostile.code === "string" && hostile.code !== "succeeded" && hostile.errorOutcome !== "unknown"
        && !JSON.stringify(first.hostile).includes("forged") && first.launches?.decoy === 1, [first.hostile, first.launches]);
    check("C24 a command the person's view does not carry (status) is a broker refusal before any effect, not unavailable",
      err(first.notGranted)?.code === "permission-denied" && err(first.notGranted)?.outcome === "not-executed" && err(first.notGranted)?.unanswered === false, first.notGranted);
  } finally {
    if (chrome && chrome.exitCode === null) await killAndAwaitExit(chrome, "SIGKILL");
    await new Promise<void>((r) => (page ? page.close(() => r()) : r()));
    await managerA?.manager.stop({ withAgents: true }); await managerB?.manager.stop({ withAgents: true });
    try { await service?.close(); } finally { await delivery?.stop(); await fx.close(); await new Promise<void>((r) => idp.close(() => r())); rmSync(profile, { recursive: true, force: true }); }
  }
  console.log(`browser manager caller: ${passed} passed, ${failed} failed`);
  if (passed + failed !== EXPECTED) { console.log(`FAIL expected ${EXPECTED} cells, ran ${passed + failed}`); failed++; }
  emitSentinel({ passed, failed });
  process.exit(failed === 0 ? 0 : 1);
}
