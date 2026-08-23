/**
 * DISCOVERY BUNDLE CONSUMABLE smoke — the producer/consumer seam of `/.well-known/cotal-mesh`.
 *
 * THE ONE CLAIM: the document a REAL auth-service actually serves over the wire is accepted by the
 * REAL consumer that `cotal meshes add --from` runs on it. Nothing here constructs the shape it
 * hopes to see — the bytes come off a live HTTP response, and the check is the shipped
 * `checkUserBundle` itself.
 *
 * WHY THIS EXISTS. The producer (#786's public face) emitted a flat `idp`/`endpoints` document with
 * no `userAuth` wrapper and no `provider`, while the consumer required the wrapper. Feeding the real
 * served bytes to the real consumer was refused with:
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
const { cotalAuthProvider, loadAuthServiceInfo, loadCalloutAuth } = await import("@cotal-ai/auth");
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

const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = `dbc-${Math.floor(Math.random() * 1e6)}`;
const PUBLIC_URL = "https://exchange.dbc.test";
const SELF = import.meta.filename;
const dir = userAuthStateDir(root, SPACE);
const store = workspaceSecretStore(root);

let broker: ChildProcess | undefined;
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

  jsDir = mkdtempSync(join(tmpdir(), "cotal-dbc-js-"));
  writeFileSync(
    join(root, "server.conf"),
    serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: jsDir, extraAccounts: prepared.extraAccounts }),
  );
  broker = spawn("nats-server", ["-c", join(root, "server.conf")], { stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVER); if (!up) await wait(200); }
  check("user-auth broker is reachable", up);
  await setupSpaceStreams({ servers: SERVER, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const publicPort = await pickFreePort();
  authChild = spawn(
    process.execPath,
    [...process.execArgv, SELF, "auth-service", "--space", SPACE, "--server", SERVER,
     "--exchange-public-port", String(publicPort), "--exchange-public-url", PUBLIC_URL],
    { cwd: root, env: childEnv, stdio: "ignore" },
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
    check("the parsed bundle carries the provider name the registry keys on", b.userAuth.provider === "cotal", b.userAuth);
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

  // The additive half of the ruling: #786's shipped top-level keys must SURVIVE, or this "fix"
  // silently breaks a reader that already depends on them inside a minor release.
  const servedDoc = JSON.parse(raw) as Record<string, unknown>;
  const idpFlat = servedDoc.idp as { url?: string; issuer?: string; audience?: string } | undefined;
  const epFlat = servedDoc.endpoints as { url?: string } | undefined;
  check(
    "#786's shipped top-level keys are RETAINED (additive change, no shipped reader regresses)",
    servedDoc.space === SPACE && typeof servedDoc.server === "string" && servedDoc.tlsRequired === true &&
      idpFlat?.url === base && idpFlat.issuer === origin && idpFlat.audience === origin &&
      epFlat?.url === PUBLIC_URL && servedDoc.sentinelCreds === expectedCallout.sentinelCreds,
    { keys: Object.keys(servedDoc).sort() },
  );

  // ---------- C. the instrument can fail ----------
  // A consumer that accepted anything would make every cell above green regardless, so the check
  // itself needs a matched pair. This section grades the CONSUMER, not the producer: it builds a
  // control document that carries the canonical wrapper (so it is meaningful before the producer
  // fix as well as after), proves that document is ACCEPTED, then removes exactly the field whose
  // absence caused the original defect and proves the SAME consumer refuses it. Without the
  // accepted half, a permanently-refusing checker would satisfy the refusal half by doing nothing.
  console.log("C) the instrument is load-bearing (a matched accept/refuse pair on the consumer)");
  const control = JSON.parse(raw) as Record<string, unknown>;
  const flatIdp = control.idp as { url: string; issuer: string; audience: string };
  control.userAuth = { provider: "cotal", idp: flatIdp, endpoints: { url: PUBLIC_URL } };
  const controlVerdict = checkUserBundle(JSON.stringify(control));
  check(
    "the control document (canonical userAuth wrapper) is ACCEPTED by the consumer",
    controlVerdict.ok === true,
    controlVerdict.ok ? undefined : controlVerdict.message,
  );
  const stripped = JSON.parse(JSON.stringify(control)) as Record<string, unknown>;
  delete (stripped.userAuth as Record<string, unknown>).provider;
  const strippedVerdict = checkUserBundle(JSON.stringify(stripped));
  check(
    "the SAME consumer REFUSES that document with userAuth.provider removed",
    strippedVerdict.ok === false && strippedVerdict.message.includes("provider name is required"),
    strippedVerdict.ok ? "accepted a document it must refuse" : strippedVerdict.message,
  );

  console.log(`\n${fail === 0 ? "✓" : "✗"} discovery-bundle-consumable: ${pass} passed, ${fail} failed`);
  // Counts are asserted, not merely "no failures": a cell that silently stops running is a cell
  // that stops protecting anything.
  const EXPECTED = 12;
  if (pass + fail !== EXPECTED)
    throw new Error(`expected ${EXPECTED} cells, ran ${pass + fail} - a cell was added or silently skipped; update EXPECTED deliberately`);
  if (fail > 0) process.exit(1);
} finally {
  authChild?.kill("SIGTERM");
  broker?.kill("SIGTERM");
  idpSrv.close();
  await wait(300);
  if (jsDir) rmSync(jsDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
