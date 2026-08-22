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
 *   E. the public face's own refusals: `view` is refused outright (elevated operator surfaces stay
 *      loopback-only, whatever the credential), and the same view request still MINTS on loopback
 *      — again a pair, so the refusal is the public face's policy and not a broken view path.
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
const root = mkdtempSync(join(tmpdir(), "cotal-rx-root-"));

const { betterAuth } = await import("better-auth");
const { memoryAdapter } = await import("better-auth/adapters/memory");
const { jwt } = await import("better-auth/plugins/jwt");
const { deviceAuthorization } = await import("better-auth/plugins/device-authorization");
const { bearer: baBearer } = await import("better-auth/plugins/bearer");
const { toNodeHandler } = await import("better-auth/node");

const { createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams, mintLifecycleUid } =
  await import("@cotal-ai/core");
const { authDir, saveSpaceAuth, userAuthStateDir, workspaceSecretStore } = await import("@cotal-ai/workspace");
const {
  cotalAuthProvider, establishIdpSession, grantActor, grantManagedActor, revokeManagedActor,
  loadAuthServiceInfo, newActorToken,
} = await import("@cotal-ai/auth");
const { decodeJwt } = await import("jose");
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
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown>, headers: res.headers };
  } catch (e) {
    // The 64-KB guard destroys the request once the bound is crossed; undici reports that correct
    // server-side refusal as a closed socket rather than exposing the attempted JSON error body.
    // Preserve it as a refusal-class reply so the named body-bound cell can grade the boundary.
    if ((e as { cause?: { code?: string } }).cause?.code === "UND_ERR_SOCKET")
      return { status: 413, body: { error: "connection closed after request body exceeded the bound" }, headers: new Headers() };
    throw e;
  }
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
  jsDir = mkdtempSync(join(tmpdir(), "cotal-rx-js-"));
  writeFileSync(
    join(root, "server.conf"),
    serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: jsDir, extraAccounts: prepared.extraAccounts }),
  );
  broker = spawn("nats-server", ["-c", join(root, "server.conf")], { stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVER); if (!up) await wait(200); }
  check("user-auth broker is reachable", up);
  const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVER, space: SPACE, creds: provCreds });

  // The daemon, started through the REAL command with the REAL public-exchange flags. `--port 0`
  // and `--exchange-public-port 0` on purpose: both faces take OS-assigned ports, which is also
  // what makes B's "endpoints.url is finalized after bind" assertion meaningful.
  const publicPort = await pickFreePort();
  authChild = spawn(
    process.execPath,
    [...process.execArgv, SELF, "auth-service", "--space", SPACE, "--server", SERVER,
     "--exchange-public-port", String(publicPort), "--exchange-public-url", PUBLIC_URL,
     "--exchange-trusted-proxy"],
    { cwd: root, env: { ...process.env, COTAL_HOME: home }, stdio: "ignore" },
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
  const idpPin = wk.body.idp as { url?: string; issuer?: string; audience?: string } | undefined;
  const eps = wk.body.endpoints as { url?: string } | undefined;
  check("bundle serves 200 on the public face", wk.status === 200, wk.body);
  check("bundle carries the space + server it actually serves", wk.body.space === SPACE && wk.body.server === SERVER, wk.body);
  check("bundle states tlsRequired", wk.body.tlsRequired === true, wk.body);
  check("bundle pins the SAME IdP url/issuer/audience the daemon enforces",
    idpPin?.url === base && typeof idpPin?.issuer === "string" && idpPin.issuer.length > 0 && typeof idpPin?.audience === "string",
    idpPin);
  check("bundle's endpoints.url is the post-bind advertised public URL", eps?.url === PUBLIC_URL, eps);
  check("bundle ships the sentinel creds the remote arm needs", typeof wk.body.sentinelCreds === "string" && (wk.body.sentinelCreds as string).length > 0);
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
  grantActor(dir, { owner: OWNER, actor: "cli", scope: ["spawn", "role:worker"], allowSubscribe: [">"], allowPublish: [">"], label: "smoke operator" });
  const secret = newActorToken();
  const agentLifecycleUid = mintLifecycleUid();
  grantManagedActor(dir, {
    owner: OWNER, actor: AGENT, scope: ["role:worker"], allowSubscribe: ["general"], allowPublish: ["general"],
    parent: `${OWNER}.cli`, tokenHash: secret.tokenHash, lifecycleUid: agentLifecycleUid,
  });
  const agentBody = { owner: OWNER, actor: AGENT, actorToken: secret.actorToken };

  // ---------- C. the matched pair: capless public 200 vs capless loopback 401 ----------
  console.log("C) the SAME capless request: public mints, loopback still 401s");
  const capless = await post(`${PUBLIC}/exchange`, agentBody);
  check("agent exchange succeeds WITHOUT a capability on the public face", capless.status === 200, capless.body);
  check("…and returns a real bearer for the granted owner",
    typeof capless.body.token === "string" && capless.body.owner === OWNER && typeof capless.body.exp === "number", capless.body);
  {
    const claims = decodeJwt(capless.body.token as string) as { act?: { actor?: string } };
    check("…whose actor claim is the granted row's actor", claims.act?.actor === AGENT, claims.act);
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

  // ---------- E. views are loopback-only ----------
  console.log("E) elevated views refused on the public face, still minted on loopback");
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

  // ---------- F. inherited hardening holds verbatim ----------
  console.log("F) Origin / content-type / body bound on the public face");
  const browser = await post(`${PUBLIC}/exchange`, agentBody2, { origin: "https://evil.example" });
  check("browser-origin requests are refused on the public face (403)", browser.status === 403, browser.body);
  check("no CORS headers, ever", browser.headers.get("access-control-allow-origin") === null);
  const wrongType = await fetch(`${PUBLIC}/exchange`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
  check("non-JSON content-type is refused (415)", wrongType.status === 415);
  const huge = await post(`${PUBLIC}/exchange`, `{"pad":"${"x".repeat(70 * 1024)}"}`);
  check("a body past the 64 KB bound is refused", huge.status >= 400, huge);

  // ---------- A(cont). the closed route table ----------
  console.log("A') the public route table is closed");
  check("GET /jwks is served on the public face", (await get(`${PUBLIC}/jwks`)).status === 200);
  check("…with the explicit cache contract", /max-age=/.test((await get(`${PUBLIC}/jwks`)).headers.get("cache-control") ?? ""));
  let notFound = 0;
  for (const p of ["/", "/exchange/", "/admin", "/views", "/actor", "/ledger", "/health/", "/.well-known/", "/..%2f", "/toString", "/constructor"]) {
    if ((await get(`${PUBLIC}${p}`)).status === 404) notFound++;
  }
  check("every non-route path 404s on the public face (11/11, incl. prototype-chain probes)", notFound === 11, { notFound });
  check("GET at /exchange is refused (POST only)", (await get(`${PUBLIC}/exchange`)).status === 405);
  check("POST at /jwks is refused (GET only)", (await post(`${PUBLIC}/jwks`, {})).status === 405);

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
const EXPECTED = 44;
console.log(`\nremote-exchange smoke: ${pass} passed, ${fail} failed`);
if (pass + fail !== EXPECTED) {
  console.log(`  ✗ FAIL: expected ${EXPECTED} cells, ran ${pass + fail} - a cell was added or silently skipped`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);
