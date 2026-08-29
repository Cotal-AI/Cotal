/**
 * DISCOVERY BUNDLE CONSUMABLE smoke — the producer/consumer seam of `/.well-known/cotal-mesh`.
 *
 * THE ONE CLAIM: the document a REAL auth-service actually serves over the wire is accepted by the
 * REAL consumer that `cotal meshes add --from` runs on it, and it names the SAME auth provider the
 * registry will dispatch to. Nothing here constructs the shape it hopes to see — the bytes come off
 * a live HTTP response, and the check is the shipped `checkUserBundle` itself.
 *
 * WHY THIS EXISTS. The producer emitted a flat `idp`/`endpoints` document with no `userAuth` wrapper
 * and no `provider`, while the consumer required the wrapper. Feeding the real served bytes to the
 * real consumer was refused with:
 *
 *     ✗ user-auth bundle: auth provider publicAuth: a provider name is required
 *
 * so `cotal meshes add --from <origin>` could not register against a live mesh at all. Both sides
 * had passed review, because each side's own tests BUILD the shape that side expects: the producer
 * smoke asserted the flat fields it wrote, and the consumer smoke fed itself a hand-written
 * `userAuth` fixture. A seam that neither side's fixtures cross is a seam nobody tests. This cell
 * is the crossing, and it lives in `bin/smoke` because that is the composition root — the only tier
 * permitted to import BOTH `@cotal-ai/auth` and the CLI (implementations never import each other).
 *
 * The shape half of that defect is fixed, but the seam it hid behind was still untested, and one
 * half of the contract is still only held by agreement: the provider name. The bundle is the input
 * `cotal meshes add --from` registers from, so a document naming a provider other than the one the
 * registered `AuthProvider` answers to would register an entry nothing can resolve. Those two names
 * are now ONE exported constant (`AUTH_PROVIDER_NAME`), and this suite asserts the served name
 * against `cotalAuthProvider.name` — the registered provider's own identity, not the constant — so
 * re-hardcoding either site is caught here rather than at somebody's remote registration.
 *
 * The daemon is started by SELF-RE-EXEC through the registered `auth-service` command, so the flags
 * and the bundle generation under test are the real ones; a hand-rolled in-process start would
 * bypass exactly the path that was broken.
 *
 * Run: pnpm smoke:discovery-bundle-consumable:live   (pnpm build first — the daemon child runs built
 * dist; needs nats-server + node on PATH)
 */

// ---------- SELF-DISPATCH (must be the FIRST thing that runs) ----------
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
const { SMOKE_BROKER_TOKEN, teardownOnSignal } = await import("@cotal-ai/smoke-kit");
const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
const { createRequire } = await import("node:module");
const { tmpdir } = await import("node:os");
const { join, resolve } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const { createServer } = await import("node:http");
type AddressInfo = import("node:net").AddressInfo;

const worktree = resolve(import.meta.dirname, "..", "..");

const home = mkdtempSync(join(tmpdir(), "cotal-dbc-home-"));
process.env.COTAL_HOME = home;
const root = mkdtempSync(join(tmpdir(), "cotal-dbc-root-"));

// This smoke may itself run inside a managed mesh session. The auth-service child must receive only
// this fixture's sandboxed Cotal configuration, never the runner's live broker/credential material.
// `smoke:suite-ambient-env` enforces this scrub before any `...process.env` spread.
const childEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(childEnv)) if (key.startsWith("COTAL_")) delete childEnv[key];
childEnv.COTAL_HOME = home;

// better-auth is a dependency of implementations/auth, not of this root package, so it does not
// resolve from bin/. Resolve it from the package that owns it rather than widen root deps.
const authRequire = createRequire(join(worktree, "implementations", "auth", "package.json"));
const fromAuth = async (spec: string): Promise<Record<string, any>> =>
  import(pathToFileURL(authRequire.resolve(spec)).href) as Promise<Record<string, any>>;

const { betterAuth } = await fromAuth("better-auth");
const { memoryAdapter } = await fromAuth("better-auth/adapters/memory");
const { jwt } = await fromAuth("better-auth/plugins/jwt");
const { deviceAuthorization } = await fromAuth("better-auth/plugins/device-authorization");
const { bearer: baBearer } = await fromAuth("better-auth/plugins/bearer");
const { toNodeHandler } = await fromAuth("better-auth/node");

const { createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams } =
  await import("@cotal-ai/core");
const { authDir, saveSpaceAuth, userAuthStateDir, workspaceSecretStore } = await import("@cotal-ai/workspace");
const { AUTH_PROVIDER_NAME, cotalAuthProvider, loadAuthServiceInfo, loadCalloutAuth } = await import("@cotal-ai/auth");
const { pickFreePort } = await import("../../implementations/auth/smoke/_free-port.js");
// THE REAL CONSUMER — the exact function `cotal meshes add --from` runs on a fetched document.
// Deep import: it is not re-exported from the CLI's index, and `bin/` is the composition root that
// may reach into both implementations (see the module header).
const { checkUserBundle } = await import("../../implementations/cli/src/commands/meshes-add.js");

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function stopOwned(child: ChildProcess | undefined, group = false): Promise<void> {
  if (!child) return;
  const alive = (): boolean => {
    if (!group) return child.exitCode === null && child.signalCode === null;
    if (child.pid === undefined) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const signal = (name: NodeJS.Signals): void => {
    try {
      if (group && child.pid !== undefined) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      /* already gone */
    }
  };
  if (!alive()) return;
  signal("SIGTERM");
  for (let i = 0; i < 60 && alive(); i++) await wait(50);
  if (alive()) signal("SIGKILL");
  for (let i = 0; i < 100 && alive(); i++) await wait(50);
  if (alive()) throw new Error(`owned ${group ? "process group" : "process"} did not exit before teardown`);
}

const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = `dbc-${Math.floor(Math.random() * 1e6)}`;
const PUBLIC_URL = "https://exchange.dbc.test";
const SELF = import.meta.filename;
const dir = userAuthStateDir(root, SPACE);
const store = workspaceSecretStore(root);

let broker: ChildProcess | undefined;
let releaseBroker: (() => void) | undefined;
let authChild: ChildProcess | undefined;
let jsDir: string | undefined;
const idpSrv = createServer((req, res) => handler!(req, res));
let handler: ReturnType<typeof toNodeHandler> | undefined;

try {
  // ---------- A. a real mesh with the public face bound ----------
  console.log("A) broker + IdP + auth-service with the public face bound");
  const auth = await createSpaceAuth(SPACE);
  saveSpaceAuth(authDir(root), auth);

  await new Promise<void>((r) => idpSrv.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(idpSrv.address() as AddressInfo).port}`;
  const base = `${origin}/api/auth`;
  handler = toNodeHandler(betterAuth({
    baseURL: origin,
    secret: "smoke-only-better-auth-secret-0123456789",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [], deviceCode: [] }),
    emailAndPassword: { enabled: true },
    plugins: [
      jwt({ jwt: { issuer: origin, audience: origin } }),
      deviceAuthorization({ expiresIn: "2m", interval: "1s", validateClient: () => true }),
      baBearer(),
    ],
  }));

  const prepared = await cotalAuthProvider.prepareServer({
    store, space: SPACE, operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    dir, idpUrl: base,
  });
  const expectedCallout = await loadCalloutAuth(store, SPACE);
  if (!expectedCallout) throw new Error("prepared callout material was not persisted");

  jsDir = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}dbc-js-`));
  writeFileSync(
    join(root, "server.conf"),
    serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: jsDir, extraAccounts: prepared.extraAccounts }),
  );
  broker = spawn("nats-server", ["-c", join(root, "server.conf")], { stdio: "ignore" });
  releaseBroker = teardownOnSignal(broker, jsDir);
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVER); if (!up) await wait(200); }
  check("user-auth broker is reachable", up);
  await setupSpaceStreams({ servers: SERVER, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const publicPort = await pickFreePort();
  authChild = spawn(
    process.execPath,
    [...process.execArgv, SELF, "auth-service", "--space", SPACE, "--server", SERVER,
     "--exchange-public-port", String(publicPort), "--exchange-public-url", PUBLIC_URL],
    { cwd: root, env: childEnv, stdio: "ignore", detached: true },
  );
  {
    const end = Date.now() + 20000;
    for (;;) {
      const info = loadAuthServiceInfo(dir);
      if (info) { try { const r = await fetch(`${info.url}/health`); if (r.ok) break; } catch { /* not bound */ } }
      if (Date.now() > end) throw new Error("auth service did not become ready");
      await wait(150);
    }
  }
  const PUBLIC = `http://127.0.0.1:${publicPort}`;
  check("the public face is serving", (await fetch(`${PUBLIC}/health`)).status === 200);

  // ---------- B. THE SEAM: live served bytes -> the real consumer ----------
  console.log("B) the served discovery document is accepted by the real `--from` consumer");
  const res = await fetch(`${PUBLIC}/.well-known/cotal-mesh`);
  check("the discovery route answers 200", res.status === 200);
  // RAW BYTES — never re-serialized, never rebuilt. What the consumer sees is what the wire carried.
  const raw = await res.text();

  const verdict = checkUserBundle(raw);
  check(
    "the LIVE served document is accepted by checkUserBundle (the `meshes add --from` consumer)",
    verdict.ok === true,
    verdict.ok ? undefined : { refusal: verdict.message, servedKeys: Object.keys(JSON.parse(raw)).sort() },
  );

  if (verdict.ok) {
    const b = verdict.value;
    // The consumer's parse is the authority on what registration will carry: assert against the
    // PARSED result, so this cell tracks what actually gets registered rather than raw JSON shape.
    check("the parsed bundle names the space the daemon serves", b.space === SPACE, b.space);
    // THE CONTRACT THE CONSTANT EXISTS FOR, asserted from the far side of the wire. The comparison
    // is against the REGISTERED provider's own `name` — not against the constant — because that is
    // the object the registry dispatches to. Both sites reading one constant is the mechanism; this
    // cell grades the outcome, so re-hardcoding either site diverges the two and fails here.
    check(
      "the served provider name IS the registered provider's own name (no drift between them)",
      b.userAuth.provider === cotalAuthProvider.name,
      { served: b.userAuth.provider, registered: cotalAuthProvider.name },
    );
    check(
      "and that name is the one exported constant the rest of the tree keys on",
      b.userAuth.provider === AUTH_PROVIDER_NAME,
      { served: b.userAuth.provider, constant: AUTH_PROVIDER_NAME },
    );
    check(
      "the parsed bundle pins the SAME IdP url/issuer/audience the daemon enforces",
      b.userAuth.idp.url === base && b.userAuth.idp.issuer === origin && b.userAuth.idp.audience === origin,
      b.userAuth.idp,
    );
    check(
      "the parsed bundle pins the post-bind advertised exchange URL",
      b.userAuth.endpoints?.url === PUBLIC_URL,
      b.userAuth.endpoints,
    );
    check(
      "the parsed bundle carries the ACTUAL deny-all sentinel credential (registration needs it)",
      b.sentinelCreds === expectedCallout.sentinelCreds,
      { advertisedLength: b.sentinelCreds.length, expectedLength: expectedCallout.sentinelCreds.length },
    );
  }

  // ---------- C. the instrument can fail ----------
  // A consumer that accepted anything would make every cell above green regardless, so the check
  // needs a matched pair. The ACCEPT half is already section B's seam cell: the served bytes,
  // through this same function. So C supplies only the REFUSE half, on those same bytes with
  // exactly the field whose absence caused the original defect removed. Re-asserting the accept
  // half here would be the same call on the same document — a cell that cannot disagree with one
  // already run is decoration, so it is deliberately not written.
  console.log("C) the instrument is load-bearing (the refuse half of section B's accept)");
  const stripped = JSON.parse(raw) as Record<string, unknown>;
  // The narrowing is not defensive noise, it is a MEASURED repair. Written as a bare
  // `delete (stripped.userAuth as ...).provider`, this line threw a TypeError under exactly the
  // producer regression the suite exists to catch — a served document with no wrapper at all — so
  // the run died in section C and never printed its counts. mutation-proof called that INCONCLUSIVE
  // rather than a kill, and it was right to: a suite that crashes instead of reporting cannot say
  // how much it checked. A guard must survive the failure it grades.
  const servedUserAuth = stripped.userAuth;
  if (servedUserAuth !== null && typeof servedUserAuth === "object")
    delete (servedUserAuth as Record<string, unknown>).provider;
  const strippedVerdict = checkUserBundle(JSON.stringify(stripped));
  check(
    "the SAME consumer REFUSES the served document with userAuth.provider removed",
    strippedVerdict.ok === false && strippedVerdict.message.includes("provider name is required"),
    strippedVerdict.ok ? "accepted a document it must refuse" : strippedVerdict.message,
  );

  console.log(`\n${fail === 0 ? "✓" : "✗"} discovery-bundle-consumable: ${pass} passed, ${fail} failed`);
  // Counts are asserted, not merely "no failures": a cell that silently stops running is a cell
  // that stops protecting anything.
  const EXPECTED = 11;
  if (pass + fail !== EXPECTED)
    throw new Error(`expected ${EXPECTED} cells, ran ${pass + fail} - a cell was added or silently skipped; update EXPECTED deliberately`);
  if (fail > 0) process.exitCode = 1;
} finally {
  await stopOwned(authChild, true);
  await stopOwned(broker);
  releaseBroker?.();
  if (idpSrv.listening) await new Promise<void>((resolveClose) => idpSrv.close(() => resolveClose()));
  if (jsDir) rmSync(jsDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
