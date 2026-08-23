/**
 * `cotal meshes add | rm` and the record-origin rule they rest on.
 *
 * The registry used to be written only by `cotal up`, which meant (a) a mesh running on another
 * machine could not be registered at all, and (b) the liveness sweep deleted records nothing on
 * this machine could write back — a sleeping laptop silently unregistered a healthy remote mesh.
 * So the load-bearing assertions here are the ones about ORIGIN:
 *
 *  • an `up` record whose broker is dead is pruned; a `manual` one is KEPT and reported `offline`,
 *    on that sweep and on every later one;
 *  • `add` verifies against the real broker before recording, and records nothing when that fails;
 *  • `--force` is the explicit record-without-verifying / replace escape;
 *  • `rm` drops records, releases the `current` pointer, and refuses a mesh running here.
 *
 * Needs `nats-server` on PATH (as the rest of smoke:ci does) for the live-broker probes.
 *
 * KNOWN LIMIT: the live broker here is open and JetStream-less, so the AUTH admission path is
 * covered only by its refusals (a broker that enforces nothing, a root whose trust does not
 * compose). A positive auth registration against a provisioned mesh belongs with the provisioning
 * smokes (`multi-space`), not here — this file must not be read as proving that path works.
 * Run: pnpm smoke:meshes-registry
 */
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Sandbox the machine-home BEFORE anything reads the registry — homeCotalDir() reads COTAL_HOME per
// call, so the real ~/.cotal is never touched.
const home = mkdtempSync(join(tmpdir(), "cotal-meshes-home-"));
process.env.COTAL_HOME = home;

// The local-process lifecycle descriptors (nats/manager/delivery pidfiles) are registered by the
// CLI composition root, and `rm`'s "is this mesh running here" check reads them — import it first,
// exactly as the real binary does, or the check silently has nothing to look at.
await import("../src/index.js");
const { createSpaceAuth, isReachable } = await import("@cotal-ai/core");
const { authDir, findMesh, getCurrent, loadMeshes, loadSpaceAuth, pruneStaleMeshes, recordMesh, removeMesh, saveSpaceAuth, setCurrent } = await import("@cotal-ai/workspace");
const { meshes, meshesComplete } = await import("../src/commands/meshes.js");

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

/** Run the command, capturing stdout/stderr and turning its `process.exit` into a code. */
async function run(positionals: string[], values: Record<string, string | boolean> = {}): Promise<{ out: string; code: number }> {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  const exit = process.exit;
  let code = 0;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  // The command exits through process.exit on every failure path; a throw unwinds to us the same
  // way the real process would stop, so the assertions below see the exact code the operator gets.
  process.exit = ((c?: number) => {
    code = c ?? 0;
    throw new ExitSignal();
  }) as never;
  try {
    await meshes({ positionals, values, raw: [] });
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
  } finally {
    console.log = log;
    console.error = err;
    process.exit = exit;
  }
  return { out: lines.join("\n"), code };
}
class ExitSignal extends Error {}

/**
 * Run the REAL pinned-fetch policy against an `https://` source whose 302 points at plaintext,
 * out of process so the self-signed CA can be trusted at startup (Node reads NODE_EXTRA_CA_CERTS
 * only then). Returns the policy's verdict, or `ok: false` with a reason — never a silent skip.
 */
// A SUITE THAT SPAWNS A CHILD IS NOT COVERED BY ITS OWN SUITE RUN. `pnpm smoke:meshes-registry`
// passed on an env spread that `pnpm smoke:ci` (the sharded aggregate CI reads) refuses — the census
// that catches it is a SEPARATE suite, so a lane running only the suites it owns is green by
// construction while the gate is red. Run `pnpm smoke:ci` before pushing anything that spawns.
//
// BUT A GREEN CENSUS IS NOT EVIDENCE A SPAWN IS CLEAN, and this is the more important half.
// `bin/smoke/suite-ambient-env.smoke.ts` matches the literal text `...process.env` (:49) and SKIPS
// any file that does not contain it (:150). So it covers EXPLICIT spreads only. A spawn that omits
// `env:` entirely inherits the parent environment in full — measured: with no `env:` the child reads
// a COTAL_ value, with an explicit env it does not — and passes the census by construction. The
// census therefore detects a SPELLING where the hazard is a PROPERTY: what the child inherited.
// Reason about the child's actual environment; do not read a passing census as an answer. Teaching
// the census to ask the property question is an upstream repair, tracked separately.
async function httpsDowngradeFixture(
  plaintextTarget: string,
): Promise<{ ok: true; refused: boolean; message: string } | { ok: false; why: string }> {
  const dir = mkdtempSync(join(tmpdir(), "cotal-dgfix-"));
  roots.push(dir);
  const key = join(dir, "k.pem");
  const cert = join(dir, "c.pem");
  const gen = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
  ], { stdio: "ignore" });
  if (gen.status !== 0 || !existsSync(cert)) return { ok: false, why: "openssl unavailable" };

  // NO SESSION CREDENTIALS AND NO INSTRUMENT KNOBS IN EITHER CHILD.
  //
  // Spreading the runner's whole environment handed a child a live managed session's credential and
  // broker URL, and neither child needs any of it: the server's key, cert and redirect target are
  // inlined into its source at write time, and the probe imports one function and fetches one URL.
  // Not "reviewed safe" — that would claim inheritance was measured harmless; these children simply
  // have no business holding connection material.
  //
  // The named knobs go too, and NODE_TLS_REJECT_UNAUTHORIZED is the one that matters: an ambient
  // `0` would switch off exactly the certificate verification this fixture exists to exercise, and
  // the downgrade cell would then pass for a reason that has nothing to do with the redirect policy.
  // A deny-list rather than a whitelist on purpose — a whitelist breaks the child the first time it
  // legitimately needs a new variable, and the repair for that is always to widen it back to
  // everything.
  const DENIED_KNOBS = /^(NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_FILE|SSL_CERT_DIR|(HTTP|HTTPS|ALL|NO)_PROXY)$/i;
  const childEnv: NodeJS.ProcessEnv = { NODE_EXTRA_CA_CERTS: cert };
  for (const [k, v] of Object.entries(process.env)) {
    // The `startsWith("COTAL_")` test is written out rather than folded into DENIED_KNOBS because
    // the census matches that exact spelling (`suite-ambient-env.smoke.ts:52`). Folding it into one
    // regex is a STRICTER filter that the census reads as NO filter at all — measured: the combined
    // form failed the census naming this file. One more way that instrument grades a spelling
    // rather than the property, noted here because the next person to tidy this loop will hit it.
    if (k.startsWith("COTAL_") || DENIED_KNOBS.test(k)) continue;
    childEnv[k] ??= v;
  }
  const serverJs = join(dir, "server.mjs");
  writeFileSync(serverJs, `import { createServer } from "node:https";\nimport { readFileSync } from "node:fs";\nconst s = createServer({ key: readFileSync(${JSON.stringify(key)}), cert: readFileSync(${JSON.stringify(cert)}) }, (_q, res) => { res.statusCode = 302; res.setHeader("location", ${JSON.stringify(`${plaintextTarget}/health`)}); res.end(); });\ns.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ port: s.address().port })));\n`);
  const server = spawn(process.execPath, [serverJs], { stdio: ["ignore", "pipe", "ignore"], env: childEnv });
  const port = await new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 10_000);
    server.stdout.on("data", (b: Buffer) => {
      const m = b.toString().match(/"port":(\d+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
  });
  if (!port) { server.kill(); return { ok: false, why: "https fixture did not start" }; }

  // The child calls the SHIPPED policy, not a re-implementation of it.
  const probeJs = join(dir, "probe.mjs");
  const addMod = new URL("../src/commands/meshes-add.ts", import.meta.url).pathname;
  writeFileSync(probeJs, `const { pinnedFetchProbe } = await import(${JSON.stringify(addMod)});\nconsole.log(JSON.stringify(await pinnedFetchProbe(process.argv[2])));\n`);
  const run = spawnSync(process.execPath, ["--import", "tsx", probeJs, `https://127.0.0.1:${port}/health`], {
    encoding: "utf8",
    env: childEnv,
  });
  server.kill();
  const line = (run.stdout || "").trim().split("\n").pop() ?? "";
  try {
    const v = JSON.parse(line) as { refused: boolean; message: string };
    return { ok: true, refused: v.refused, message: v.message };
  } catch {
    return { ok: false, why: `probe produced no verdict (${(run.stderr || "").trim().split("\n").pop() ?? "no stderr"})` };
  }
}

/** A free localhost port (the listener is closed before the port is handed back). */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  assert.ok(addr && typeof addr === "object");
  const { port } = addr;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const roots: string[] = [];


/** A project root that looks like a mesh checkout (a `.cotal/`, no trust material). */
function projectRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `cotal-${label}-`));
  mkdirSync(join(root, ".cotal"), { recursive: true });
  roots.push(root);
  return root;
}

const DEAD = `nats://127.0.0.1:${await freePort()}`; // nothing listens there
const brokerPort = await freePort();
const LIVE = `nats://127.0.0.1:${brokerPort}`;
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(brokerPort)], { stdio: "ignore" });
// A second broker that actually ENFORCES something, so the guided flow's auth branches (the
// "this folder holds no credentials" recovery) are reachable at all. Password auth is enough:
// probeEnforcement only asks whether a bare connect is refused.
const authPort = await freePort();
const AUTH_LIVE = `nats://127.0.0.1:${authPort}`;
const authBroker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(authPort), "--user", "u", "--pass", "p"], { stdio: "ignore" });
broker.on("error", () => {
  console.error("needs nats-server on PATH");
  process.exit(1);
});
for (let i = 0; i < 50 && !(await isReachable(LIVE)); i++) await new Promise((r) => setTimeout(r, 100));
// THE AUTH BROKER NEEDS THE SAME WAIT. Without it a startup race lets the user-arm cells see
// "unreachable" where they mean to see "auth-required" — the right outcome for the wrong reason,
// and intermittently, which is the worst kind. A refused bare connect IS reachability here, so
// probe for either answer rather than for success.
{
  const { probeEnforcement } = await import("../src/commands/meshes-add.js");
  for (let i = 0; i < 50; i++) {
    if ((await probeEnforcement(AUTH_LIVE)) === "auth") break;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const cwd = process.cwd();
try {
  assert.ok(await isReachable(LIVE), "the test broker never came up");
  // Asserted, not assumed: the auth broker must be answering AND enforcing before any user-arm
  // cell reads its refusal as evidence.
  {
    const { probeEnforcement } = await import("../src/commands/meshes-add.js");
    const enforces = await probeEnforcement(AUTH_LIVE);
    assert.equal(enforces, "auth", `the auth broker never came up enforcing (probe said "${enforces}")`);
  }
  const root = projectRoot("remote");

  // ── add: verified registration of a mesh this machine did not start ────────────────────────────
  const added = await run(["add", "beta"], { server: LIVE, root });
  check("add records a verified mesh", added.code === 0 && findMesh("beta")?.server === LIVE, added.out);
  check("add records it as operator-registered", findMesh("beta")?.origin === "manual", findMesh("beta"));
  check("add infers open mode from a root with no trust material", findMesh("beta")?.mode === "open", findMesh("beta"));
  check("add adopts the default when there is no usable current", getCurrent() === "beta", getCurrent());
  check("add says what it registered", added.out.includes("registered") && added.out.includes(LIVE), added.out);

  // ── add: a failed verification records NOTHING ────────────────────────────────────────────────
  const dead = await run(["add", "ghost"], { server: DEAD, root });
  check("add against a dead address exits non-zero", dead.code === 1, dead);
  check("add against a dead address records nothing", findMesh("ghost") === undefined, loadMeshes());
  check("add says nothing was registered, and how to override", dead.out.includes("nothing was registered") && dead.out.includes("--force"), dead.out);

  const forced = await run(["add", "ghost"], { server: DEAD, root, force: true });
  check("add --force registers a mesh that is currently down", forced.code === 0 && findMesh("ghost")?.origin === "manual", forced.out);
  check("add --force says the record was written without verifying", forced.out.includes("without verifying"), forced.out);
  check("add --force does NOT steal a usable current", getCurrent() === "beta", getCurrent());

  // ── add: guards ───────────────────────────────────────────────────────────────────────────────
  const dup = await run(["add", "beta"], { server: LIVE, root });
  check("add refuses a space that is already registered", dup.code === 1 && dup.out.includes("already registered"), dup.out);
  const replaced = await run(["add", "beta"], { server: DEAD, root, force: true });
  check("add --force replaces an existing record", replaced.code === 0 && findMesh("beta")?.server === DEAD, findMesh("beta"));
  const noServer = await run(["add", "nowhere"], { root });
  check("add without --server fails loud", noServer.code === 1 && noServer.out.includes("--server"), noServer.out);
  const authless = await run(["add", "needs-auth"], { server: LIVE, root, mode: "auth" });
  check("add --mode auth without that space's trust material fails loud", authless.code === 1 && authless.out.includes("trust material"), authless.out);
  check("add --mode auth recorded nothing", findMesh("needs-auth") === undefined, loadMeshes());
  // The pins-must-be-supplied rule outlives the sequencing fence (it is what U3 keeps), so it is
  // asserted behind the development opt-in — otherwise the fence would answer first and this cell
  // would silently stop proving anything about pinned trust.
  process.env.COTAL_REMOTE_REGISTRATION_DEV = "1";
  const userMode = await run(["add", "hosted"], { server: LIVE, root, mode: "user" });
  delete process.env.COTAL_REMOTE_REGISTRATION_DEV;
  check("add --mode user WITHOUT pinned trust is refused (pins must be supplied, not guessed)",
    userMode.code === 1 && userMode.out.includes("--user-auth-file") && userMode.out.includes("--from"), userMode.out);
  const badMode = await run(["add", "hosted"], { server: LIVE, root, mode: "sideways" });
  check("add --mode with a junk value fails loud", badMode.code === 1 && badMode.out.includes("auth, open or user"), badMode.out);
  const badUsage = await run(["add"], { server: LIVE, root });
  check("add without a space name prints usage", badUsage.code === 1 && badUsage.out.includes("usage:"), badUsage.out);

  // MODE HONESTY. A NATS broker with no auth configured accepts a credential-bearing CONNECT and
  // ignores it, so "the creds were accepted" is not evidence of enforcement. Registering `auth`
  // against an open broker would promise JWT/ACL protection that does not exist.
  //
  // This needs REAL composed trust, not a marker file: with nothing usable on disk the compose
  // guard fires first and the mode probe is never reached — the assertion would then pass with the
  // whole mode-verification branch deleted, which is the circular-test trap this file is meant to
  // avoid. So mint an actual space auth and save it the way `cotal up` does.
  const trustRoot = projectRoot("trust");
  saveSpaceAuth(authDir(trustRoot), await createSpaceAuth("openbroker"));
  const fakeAuth = await run(["add", "openbroker"], { server: LIVE, root: trustRoot, mode: "auth" });
  check("add --mode auth is refused against a broker that enforces nothing",
    fakeAuth.code === 1 && findMesh("openbroker") === undefined, fakeAuth.out);
  check("…for the RIGHT reason: the broker accepts unauthenticated connections",
    fakeAuth.out.includes("accepts unauthenticated connections"), fakeAuth.out);
  check("…and the trust it was given really does compose (so the probe was reached)",
    loadSpaceAuth(authDir(trustRoot), "openbroker") !== undefined);
  // The compose guard is its own case: an account record with no usable trust behind it.
  const accountOnly = projectRoot("account-only");
  saveSpaceAuth(authDir(accountOnly), await createSpaceAuth("halfspace"));
  rmSync(join(authDir(accountOnly), "broker.json"), { force: true }); // account survives, trust cannot compose
  const halfTrust = await run(["add", "halfspace"], { server: LIVE, root: accountOnly, mode: "auth" });
  check("add --mode auth is refused when the root's trust does not compose",
    halfTrust.code === 1 && findMesh("halfspace") === undefined, halfTrust.out);
  check("…naming the missing half rather than a connection problem",
    halfTrust.out.includes("does not compose") || halfTrust.out.includes("trust material"), halfTrust.out);

  // CREDENTIALS IN THE URL. The record is written to disk and echoed back by add + list, so an
  // inline password would be copied into both. Refuse it without repeating the secret.
  const creddy = await run(["add", "leaky"], { server: "nats://alice:swordfish@127.0.0.1:1", root });
  check("add refuses a --server with embedded credentials", creddy.code === 1 && findMesh("leaky") === undefined, creddy.out);
  check("…and does not echo the password back", !creddy.out.includes("swordfish"), creddy.out);
  for (const [label, url] of [["a non-broker scheme", "http://127.0.0.1:4222"], ["junk", "not-a-url"]] as const) {
    const bad = await run(["add", "badurl"], { server: url, root });
    check(`add refuses ${label} in --server`, bad.code === 1 && findMesh("badurl") === undefined, bad.out);
  }

  // ── add: TLS intent — typed, sourced, ENFORCED ──────────────────────────────────────────────
  // A tls:// scheme is cosmetic at the client (nats.js connects plaintext to tls://host with
  // empty options), so the record converts that typed intent into enforcement: the scheme sets
  // tlsRequired=true, the candidate target carries it, and preflight then REQUIRES the handshake
  // rather than tolerating plaintext.
  const tlsTyped = await run(["add", "tls-typed"], { server: LIVE.replace("nats://", "tls://"), root });
  check("add tls:// against a plaintext broker is REFUSED — typed intent is enforced, not cosmetic",
    tlsTyped.code === 1 && findMesh("tls-typed") === undefined, tlsTyped.out);
  const tlsForced = await run(["add", "tls-typed"], { server: LIVE.replace("nats://", "tls://"), root, force: true });
  check("add tls:// --force records the TLS requirement on the entry",
    tlsForced.code === 0 && findMesh("tls-typed")?.tlsRequired === true, findMesh("tls-typed"));
  removeMesh("tls-typed");
  const tlsFlagged = await run(["add", "tls-flagged"], { server: DEAD, root, tls: true, force: true });
  check("add --tls records the TLS requirement without the scheme",
    tlsFlagged.code === 0 && findMesh("tls-flagged")?.tlsRequired === true, findMesh("tls-flagged"));
  removeMesh("tls-flagged");
  check("a plain nats:// registration records no TLS requirement",
    findMesh("ghost")?.tlsRequired === undefined, findMesh("ghost"));
  // The dial policy reads the SAME source: a hostname is registrable IFF the dial will require TLS.
  const hostNoTls = await run(["add", "hosty"], { server: "nats://broker.example.com:4222", root, force: true });
  check("add a hostname without TLS intent stays refused (--force does not waive the dial policy)",
    hostNoTls.code === 1 && findMesh("hosty") === undefined, hostNoTls.out);
  const hostTls = await run(["add", "hosty"], { server: "tls://broker.example.com:4222", root, force: true });
  check("add a hostname WITH tls:// is permitted and recorded with the requirement",
    hostTls.code === 0 && findMesh("hosty")?.tlsRequired === true, findMesh("hosty"));
  removeMesh("hosty");
  const cafeTls = await run(["add", "cafe"], { server: "tls://192.168.1.10:4222", root, tls: true, force: true });
  check("RFC1918 stays refused even with TLS intent (a cafe LAN is private too)",
    cafeTls.code === 1 && findMesh("cafe") === undefined, cafeTls.out);

  // ── add: --mode user with SUPPLIED pinned trust ────────────────────────────────────────────────────
  // The old refusal's reasoning — IdP pins must be established, not guessed — is satisfied by
  // SUPPLYING them: a bundle carries the pins, the exchange must answer /health + /jwks with the
  // pinned issuer, and the credless broker probe reporting auth-required is the PASS.
  const { statSync: statSentinel } = await import("node:fs");
  const { createServer: createHttpServer } = await import("node:http");
  const ISSUER = "https://idp.example.test/";
  // A stand-in exchange: answers /health with the pinned issuer and /jwks with a key set.
  const exchange = createHttpServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") return void res.end(JSON.stringify({ ok: true, issuer: ISSUER }));
    if (req.url === "/jwks") return void res.end(JSON.stringify({ keys: [{ kty: "OKP" }] }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => exchange.listen(0, "127.0.0.1", r));
  const exchangeUrl = `http://127.0.0.1:${(exchange.address() as { port: number }).port}`;
  // VALID JWKS ON PURPOSE. With an empty key set this fixture refuses for TWO reasons at once, and
  // the issuer cell then passes even with the issuer comparison deleted — it was pinning the empty
  // JWKS, not the foreign issuer. A non-empty key set makes the foreign issuer the ONLY thing
  // wrong, so the cell can only pass if the issuer really is compared.
  const wrongExchange = createHttpServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") return void res.end(JSON.stringify({ ok: true, issuer: "https://someone-else.test/" }));
    if (req.url === "/jwks") return void res.end(JSON.stringify({ keys: [{ kid: "k1", kty: "RSA" }] }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => wrongExchange.listen(0, "127.0.0.1", r));
  const wrongExchangeUrl = `http://127.0.0.1:${(wrongExchange.address() as { port: number }).port}`;
  const SENTINEL_BLOB = "-----BEGIN NATS USER JWT-----\nsentinel-secret-material-o7\n------END NATS USER JWT------";
  const bundleFor = (over: Record<string, unknown> = {}) => ({
    space: "hosted",
    server: AUTH_LIVE, // the broker that actually refuses a bare connect — the user-arm PASS
    tlsRequired: false, // loopback in this smoke; a real remote bundle says true
    userAuth: { provider: "cotal", idp: { url: ISSUER, issuer: ISSUER, audience: "cotal-mesh" }, endpoints: { url: exchangeUrl } },
    sentinelCreds: SENTINEL_BLOB,
    ...over,
  });
  const bundlePath = join(root, "bundle.json");
  writeFileSync(bundlePath, JSON.stringify(bundleFor()));
  const hostedRoot = projectRoot("hosted");

  // ── THE SEQUENCING FENCE ─────────────────────────────────────────────────────────────────────
  // No production connect can consume a remote entry yet (the auth provider still refuses with
  // "remote discovery is not supported yet"), so registering one by DEFAULT is refused: a
  // `✓ registered` that selects a durable mesh nothing can dial is a lie to the operator. These
  // cells are what must go red the day the fence is deleted without its consumer.
  const fencedFile = await run(["add", "hosted"], { mode: "user", "user-auth-file": bundlePath, root: hostedRoot });
  check("remote user-auth registration is REFUSED by default (no consumer yet)",
    fencedFile.code === 1 && fencedFile.out.includes("remote user-auth connect is not yet supported"), fencedFile.out);
  check("…the refusal names the sequencing, not a generic failure",
    fencedFile.out.includes("remote-exchange clients"), fencedFile.out);
  check("…and it records NOTHING on the refused path",
    findMesh("hosted") === undefined, loadMeshes());
  check("…no partial-success wording ever reaches the operator",
    !fencedFile.out.includes("✓ registered"), fencedFile.out);
  // The fence is hit BEFORE --from touches the network: a refused registration must not fetch.
  let discoHits = 0;
  const countingDisco = createHttpServer((_req, res) => { discoHits++; res.statusCode = 404; res.end("{}"); });
  await new Promise<void>((r) => countingDisco.listen(0, "127.0.0.1", r));
  const discoUrl = `http://127.0.0.1:${(countingDisco.address() as { port: number }).port}`;
  const fencedFrom = await run(["add", "hosted"], { mode: "user", from: `${discoUrl}/.well-known/cotal-mesh`, root: hostedRoot });
  check("--from is refused by the same fence, before any fetch",
    fencedFrom.code === 1 && discoHits === 0 && findMesh("hosted") === undefined, { out: fencedFrom.out, discoHits });
  countingDisco.close();

  // Everything below exercises the registration machinery itself, which is complete and must stay
  // proven while the fence holds. It runs behind the consumer lane's development opt-in — the same
  // switch the remote-exchange client work uses, and the fence's only escape.
  process.env.COTAL_REMOTE_REGISTRATION_DEV = "1";

  const userAdd = await run(["add", "hosted"], { mode: "user", "user-auth-file": bundlePath, root: hostedRoot });
  check("add --mode user with a pinned bundle records a remote entry",
    userAdd.code === 0 && findMesh("hosted")?.mode === "user", userAdd.out);
  const hostedEntry = findMesh("hosted");
  check("…marked remote, with the pinned exchange as a stated trust position",
    hostedEntry?.userAuth?.remote === true && hostedEntry?.userAuth?.endpoints?.url === exchangeUrl, hostedEntry);
  check("…and the record carries the sentinel PATH, never the blob",
    typeof hostedEntry?.userAuth?.sentinelCredsPath === "string" &&
      !JSON.stringify(hostedEntry).includes("sentinel-secret-material"), hostedEntry);
  const sentinelStat = statSentinel(hostedEntry!.userAuth!.sentinelCredsPath!);
  check("the sentinel lands 0600", (sentinelStat.mode & 0o777) === 0o600, sentinelStat.mode.toString(8));
  // ASSERT THE VALUE, not merely that a 0600 file exists. Presence+mode alone is satisfied by any
  // nonempty decoy, so this cell passed without the bundle's actual creds ever being written — the
  // same false-green shape as an issuer check that only asks whether a string is nonempty.
  check("…carrying the bundle's ACTUAL sentinel creds, byte for byte",
    readFileSync(hostedEntry!.userAuth!.sentinelCredsPath!, "utf8") === SENTINEL_BLOB,
    { path: hostedEntry!.userAuth!.sentinelCredsPath });
  // Round-trip: the recorded entry resolves to a usable user-mode target.
  const { targetFromEntry } = await import("@cotal-ai/workspace");
  const hostedTarget = targetFromEntry(hostedEntry!, hostedEntry!.server, "registry");
  check("the remote entry round-trips through targetFromEntry",
    hostedTarget.mode === "user" && hostedTarget.userAuth?.remote === true && hostedTarget.server.startsWith("nats://127.0.0.1"), hostedTarget);
  const hostedList = await run([]);
  check("`cotal meshes` output never contains the sentinel blob",
    !hostedList.out.includes("sentinel-secret-material"), hostedList.out.slice(0, 200));
  removeMesh("hosted");
  // A bundle missing ANY pin refuses — each of the trust fields, not just one.
  for (const strip of ["idp-url", "issuer", "audience", "endpoints", "sentinel"] as const) {
    const broke = bundleFor();
    if (strip === "idp-url") (broke.userAuth.idp as { url?: string }).url = undefined as never;
    if (strip === "issuer") (broke.userAuth.idp as { issuer?: string }).issuer = undefined as never;
    if (strip === "audience") (broke.userAuth.idp as { audience?: string }).audience = undefined as never;
    if (strip === "endpoints") (broke.userAuth as { endpoints?: unknown }).endpoints = undefined;
    if (strip === "sentinel") (broke as { sentinelCreds?: string }).sentinelCreds = undefined;
    writeFileSync(bundlePath, JSON.stringify(broke));
    const refusedPin = await run(["add", "hosted"], { mode: "user", "user-auth-file": bundlePath, root: hostedRoot });
    check(`a bundle missing ${strip} refuses`, refusedPin.code === 1 && findMesh("hosted") === undefined, refusedPin.out);
  }
  // The exchange must answer with the PINNED issuer — a different issuer is a different authority.
  writeFileSync(bundlePath, JSON.stringify(bundleFor({ userAuth: { provider: "cotal", idp: { url: ISSUER, issuer: ISSUER, audience: "cotal-mesh" }, endpoints: { url: wrongExchangeUrl } } })));
  const wrongIss = await run(["add", "hosted"], { mode: "user", "user-auth-file": bundlePath, root: hostedRoot });
  check("an exchange answering with a foreign issuer refuses", wrongIss.code === 1 && findMesh("hosted") === undefined, wrongIss.out);
  // The user arm's enforcement check: an OPEN broker cannot be a user-auth mesh.
  writeFileSync(bundlePath, JSON.stringify(bundleFor({ server: LIVE })));
  const openUser = await run(["add", "hosted"], { mode: "user", "user-auth-file": bundlePath, root: hostedRoot });
  // ASSERT THE REASON, NOT JUST THE REFUSAL. Exit 1 + no record is also what a DEAD SOCKET
  // produces, so this cell passed when pointed at an unreachable address — "it refused" is not
  // "it refused because the broker accepts unauthenticated connections". Match the open-broker
  // sentence, and prove the dead-socket path is a DIFFERENT sentence (below).
  check("add --mode user against an OPEN broker refuses (auth-required is the pass)",
    openUser.code === 1 && findMesh("hosted") === undefined
      && /accepts unauthenticated connections/.test(openUser.out), openUser.out);
  // The discriminating control: an UNREACHABLE broker must refuse with its own reason, never with
  // the open-broker one. Without this, the cell above cannot tell the two apart.
  writeFileSync(bundlePath, JSON.stringify(bundleFor({ server: DEAD })));
  const deadUser = await run(["add", "hosted"], { mode: "user", "user-auth-file": bundlePath, root: hostedRoot });
  check("…and an UNREACHABLE broker refuses for a different, named reason",
    deadUser.code === 1 && findMesh("hosted") === undefined
      && /no broker answered/.test(deadUser.out)
      && !/accepts unauthenticated connections/.test(deadUser.out), deadUser.out);
  // The dial-policy fence is NOT waived for user mode: a hostname without TLS intent stays refused.
  writeFileSync(bundlePath, JSON.stringify(bundleFor({ server: "nats://hosted.example.com:4222" })));
  const userHostNoTls = await run(["add", "hosted"], { mode: "user", "user-auth-file": bundlePath, root: hostedRoot });
  check("user-mode registration still goes THROUGH the dial-policy fence",
    userHostNoTls.code === 1 && findMesh("hosted") === undefined, userHostNoTls.out);
  // --from is HTTPS-only: handing the pins to a plaintext fetch would let the network choose them.
  const fromHttp = await run(["add", "hosted"], { mode: "user", from: `${exchangeUrl}/.well-known/cotal-mesh`, root: hostedRoot });
  check("--from refuses a plain-http discovery URL", fromHttp.code === 1 && findMesh("hosted") === undefined, fromHttp.out);

  // ── NO DOWNGRADE, NO REDIRECT, NO PRE-CONSENT I/O ──────────────────────────────────────
  // `fetch` follows redirects by default and will follow https→http, so a 302 from anyone on the
  // path turns a pinned encrypted fetch into a plaintext one — and the document IS the trust.
  // Verified against the real defect: before the fix, the exchange probe accepted a plain-http
  // base and a 302 was followed silently.
  let exchangeHits = 0;
  const downgrade = createHttpServer((req, res) => {
    exchangeHits++;
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/health")) return void res.end(JSON.stringify({ ok: true, issuer: ISSUER }));
    if (req.url?.endsWith("/jwks")) return void res.end(JSON.stringify({ keys: [{ kid: "k" }] }));
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>((r) => downgrade.listen(0, "127.0.0.1", r));
  const downgradeUrl = `http://127.0.0.1:${(downgrade.address() as { port: number }).port}`;
  const redirector = createHttpServer((_req, res) => {
    res.statusCode = 302;
    res.setHeader("location", `${downgradeUrl}/health`);
    res.end();
  });
  await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
  const redirectorUrl = `http://127.0.0.1:${(redirector.address() as { port: number }).port}`;

  const { verifyUserExchange, assertPinnedFetchUrl, pinnedFetchProbe } = await import("../src/commands/meshes-add.js");
  // A non-loopback plain-http exchange base is refused outright: the pin cannot ride plaintext.
  check("a plain-http (non-loopback) exchange base is refused by the pinned-fetch policy",
    assertPinnedFetchUrl(new URL("http://exchange.example.com"), "x") !== undefined,
    assertPinnedFetchUrl(new URL("http://exchange.example.com"), "x"));
  check("…and a file:// exchange base is refused too",
    assertPinnedFetchUrl(new URL("file:///etc/passwd"), "x") !== undefined);
  check("…while https is accepted", assertPinnedFetchUrl(new URL("https://exchange.example.com"), "x") === undefined);

  // THE LOOPBACK EXCEPTION IS AN ADDRESS DECISION, NOT A STRING ONE. It was written `/^127\./`,
  // which is a prefix match on a NAME: `127.evil.com`, `127.0.0.1.nip.io` and `127.com` are all
  // registrable by anyone and were all granted the plain-http exception (the probe really did
  // fetch public `127.com` over http). The same string test also MISSED genuine loopback
  // spellings. The host is now parsed and canonicalized instead, so both directions are pinned.
  for (const name of ["http://127.evil.com", "http://127.0.0.1.nip.io", "http://127.com", "http://127x.example.com", "http://localhost"]) {
    check(`a NAME gets no loopback exception: ${name}`,
      assertPinnedFetchUrl(new URL(name), "x") !== undefined, name);
  }
  // …and the exception still works for real loopback literals, in every spelling the canonicalizer
  // knows — without these the fix could "pass" by deleting the exception the suites depend on.
  for (const lit of ["http://127.0.0.1:8080", "http://127.9.9.9", "http://[::1]:9", "http://0177.0.0.1", "http://2130706433", "http://[::ffff:127.0.0.1]"]) {
    check(`a real loopback literal keeps the exception: ${lit}`,
      assertPinnedFetchUrl(new URL(lit), "x") === undefined, lit);
  }
  // A 302 is REFUSED, not followed — asserted against a live redirector.
  exchangeHits = 0;
  const redirected = await verifyUserExchange(redirectorUrl, ISSUER);
  check("the exchange probe refuses a 302 instead of following it",
    !redirected.ok && /redirect/i.test(redirected.ok ? "" : redirected.message), redirected);
  check("…and the redirect target is never contacted", exchangeHits === 0, { exchangeHits });

  // THE ACTUAL ATTACK: an HTTPS→HTTP DOWNGRADE, exercised from a REAL https SOURCE.
  //
  // An in-process fixture cannot do this. A self-signed TLS server fails certificate verification
  // before the redirect is reached, so the cell greens on the wrong reason; NODE_EXTRA_CA_CERTS is
  // read only at process start, so setting it here does nothing; and rejectUnauthorized:false would
  // delete the very verification whose failure was masking the result. An http→http redirector is
  // no substitute either: it proves "a 302 is refused", not that an https SOURCE cannot be walked
  // down to plaintext, so a rule that followed https redirects while refusing http ones passes it.
  //
  // So run the real code path in a CHILD spawned with the CA trusted at startup, which does trust
  // it (measured: with the CA the child sees the 302; without it, DEPTH_ZERO_SELF_SIGNED_CERT).
  const dg = await httpsDowngradeFixture(downgradeUrl);
  if (dg.ok) {
    check("an HTTPS-source downgrade to plaintext is refused, naming the redirect",
      dg.refused && /redirect/i.test(dg.message) && dg.message.includes(downgradeUrl), dg);
    check("…and the plaintext downgrade target is never contacted", exchangeHits === 0, { exchangeHits });
  } else {
    check(`an HTTPS-source downgrade to plaintext is refused (NOT RUN: ${dg.why})`, false);
  }
  redirector.close();
  downgrade.close();

  // `--from` must not touch the network before the operator consents to the address. On a pipe
  // there is no way to consent, so it must refuse WITHOUT reaching out.
  //
  // This counts TCP CONNECTIONS, not HTTP requests, against an `https://` URL. Both matter:
  // an `http://` URL is rejected by the scheme rule before any fetch, so it would pass this cell
  // no matter where the consent gate sat (it did — the first version of this assertion survived
  // the ordering mutation); and TLS never completes against a bare socket, so the request never
  // becomes an HTTP hit even though the process did dial out. A connection here is the network
  // I/O the gate exists to prevent.
  let fromConnects = 0;
  const fromSocket = createServer((s) => { fromConnects++; s.destroy(); });
  await new Promise<void>((r) => fromSocket.listen(0, "127.0.0.1", () => r()));
  const fromPort = (fromSocket.address() as { port: number }).port;
  const fromNoTty = await run(["add", "hosted"], { mode: "user", from: `https://127.0.0.1:${fromPort}/.well-known/cotal-mesh`, root: hostedRoot });
  check("--from performs NO network I/O before the consent gate",
    fromNoTty.code === 1 && fromConnects === 0 && findMesh("hosted") === undefined, { out: fromNoTty.out, fromConnects });
  fromSocket.close();

  delete process.env.COTAL_REMOTE_REGISTRATION_DEV;
  exchange.close();
  wrongExchange.close();

  // ROOT INFERENCE. `findCotalRoot` returns its starting directory when it finds no `.cotal`
  // up-tree, so the "outside a project" guard has to check the directory really is one — without
  // that, running this from `/` recorded `root: "/"`.
  //
  // The walk goes UP, through ancestors this test does not own: CI runners really do carry a
  // `/tmp/.cotal` (an earlier smoke in the same shard leaves one), and a machine-dependent
  // assertion here is worse than no assertion — it fails the gate for an ambient reason on one box
  // and passes vacuously on another. So assert the RULE, which holds either way: use the nearest
  // genuine project, and demand `--root` only when there isn't one.
  const bare = mkdtempSync(join(tmpdir(), "cotal-noproject-"));
  roots.push(bare);
  let ancestorProject: string | undefined;
  for (let dir = dirname(bare); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".cotal"))) { ancestorProject = dir; break; }
    if (dirname(dir) === dir) break;
  }
  const prevCwd2 = process.cwd();
  process.chdir(bare);
  const rootless = await run(["add", "rootless"], { server: LIVE });
  process.chdir(prevCwd2);
  // ONE cell either way, so the TOTAL COUNT IS THE SAME ON EVERY BOX. The two arms used to run a
  // different NUMBER of checks (2 when no ancestor project, 1 when one existed), which made the
  // suite total ambient-dependent — 152 under a `/tmp/.cotal` left by another run, 153 without —
  // so a number quoted from one machine was a property of the box, not of the commit. The RULE is
  // still asserted from whichever side the environment presents; only the arity is now fixed.
  // Compared canonically: the walk resolves through symlinks (macOS /var → /private/var), so a raw
  // string compare would fail on the spelling rather than the behaviour.
  const canon = (p: string) => { try { return realpathSync.native(p); } catch { return p; } };
  check(
    ancestorProject === undefined
      ? "add outside any project requires --root, and names --root as the fix"
      : `add uses the nearest genuine project up-tree (${ancestorProject}), never the cwd`,
    ancestorProject === undefined
      ? rootless.code === 1 && findMesh("rootless") === undefined && rootless.out.includes("--root")
      : rootless.code === 0 && canon(findMesh("rootless")?.root ?? "") === canon(ancestorProject),
    { out: rootless.out, entry: findMesh("rootless"), ancestorProject },
  );
  if (ancestorProject !== undefined) removeMesh("rootless");

  // An EXPLICIT --root is not exempt from being a real directory.
  const notADir = join(bare, "a-file");
  writeFileSync(notADir, "x");
  const fileRoot = await run(["add", "filey"], { server: LIVE, root: notADir });
  check("add refuses a --root that is not a directory", fileRoot.code === 1 && findMesh("filey") === undefined, fileRoot.out);
  const missingRoot = await run(["add", "missy"], { server: LIVE, root: join(bare, "nope", "nope") });
  check("add refuses a --root that does not exist", missingRoot.code === 1 && findMesh("missy") === undefined, missingRoot.out);
  // …and the URL contract it claims: a bare broker URL has no path either.
  const pathy = await run(["add", "pathy"], { server: `${LIVE}/subject`, root });
  check("add refuses a --server with a path", pathy.code === 1 && findMesh("pathy") === undefined, pathy.out);

  // ── THE INVARIANT: a sweep prunes an `up` record and keeps an operator-registered one ──────────
  rmSync(join(home, "meshes"), { recursive: true, force: true });
  const localRoot = projectRoot("local");
  recordMesh({ space: "local-dead", server: DEAD, root: localRoot, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  recordMesh({ space: "legacy-dead", server: DEAD, root: localRoot, mode: "open", ts: new Date(0).toISOString() });
  recordMesh({ space: "remote-dead", server: DEAD, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  const sweep = await pruneStaleMeshes();
  check("sweep prunes a dead mesh this machine started", findMesh("local-dead") === undefined, loadMeshes());
  check("sweep prunes a dead pre-origin record (absent origin = `up`)", findMesh("legacy-dead") === undefined, loadMeshes());
  check("sweep KEEPS a dead operator-registered mesh", findMesh("remote-dead")?.space === "remote-dead", loadMeshes());
  check("sweep reports the kept one as offline", sweep.offline.includes("remote-dead") && sweep.pruned.includes("local-dead"), sweep);
  const sweep2 = await pruneStaleMeshes();
  check("a second sweep still keeps it (not a one-time reprieve)", findMesh("remote-dead") !== undefined && sweep2.offline.includes("remote-dead"), sweep2);

  // …and the same rule for the paths that delete by ROOT rather than by liveness. `add` defaults
  // --root to the project you run it in, so a hand-registered remote mesh routinely shares a root
  // with the local one; `cotal down` / `cotal clean all` there must not take the remote with it.
  const { removeMeshesByRoot, localMeshesForRoot } = await import("@cotal-ai/workspace");
  const shared = projectRoot("shared");
  recordMesh({ space: "here", server: LIVE, root: shared, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  recordMesh({ space: "elsewhere", server: LIVE, root: shared, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  const byRoot = removeMeshesByRoot(shared);
  check("a root teardown drops this project's own record", byRoot.includes("here") && findMesh("here") === undefined, byRoot);
  check("a root teardown KEEPS a co-rooted registered mesh", findMesh("elsewhere") !== undefined, loadMeshes());
  check("…and does not claim it removed it", !byRoot.includes("elsewhere"), byRoot);
  // `clean`'s "is this root's mesh still live" guard asks the same question: a reachable REMOTE
  // broker is not the operator's to stop, so it must not block a local wipe forever.
  check("the local-liveness guard ignores a co-rooted registered mesh",
    localMeshesForRoot(shared).every((m) => m.space !== "elsewhere"), localMeshesForRoot(shared));
  removeMesh("elsewhere");

  // `cotal up --space <name>` reclaims a dead holder's name. It must not reclaim a REGISTERED one:
  // unreachable is not proof that mesh is gone, and the reclaim happens BEFORE the broker starts,
  // so an `up` that then fails would leave the operator with neither mesh and no way back.
  const { claimSpace } = await import("../src/commands/up.js");
  recordMesh({ space: "claimed", server: DEAD, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  let claimError: Error | undefined;
  await claimSpace("claimed", LIVE, localRoot).catch((e: Error) => void (claimError = e));
  check("`up` refuses to reclaim a registered space rather than deleting it", claimError !== undefined, claimError?.message);
  check("…and the registration survives the refusal", findMesh("claimed") !== undefined, loadMeshes());
  check("…naming `cotal meshes rm` as the way through", claimError?.message.includes("cotal meshes rm claimed") === true, claimError?.message);
  // A LIVE registered holder must reach the SAME refusal. Deciding liveness first sent the operator
  // to `cotal down`, which cannot stop a mesh this machine does not run.
  recordMesh({ space: "claimed-live", server: LIVE, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  let liveClaimError: Error | undefined;
  await claimSpace("claimed-live", DEAD, localRoot).catch((e: Error) => void (liveClaimError = e));
  check("a LIVE registered holder gets the same refusal, not `cotal down`",
    liveClaimError?.message.includes("cotal meshes rm claimed-live") === true && !liveClaimError.message.includes("cotal down"),
    liveClaimError?.message);
  check("…and it survives", findMesh("claimed-live") !== undefined, loadMeshes());
  recordMesh({ space: "reclaimable", server: DEAD, root: localRoot, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  await claimSpace("reclaimable", LIVE, root);
  check("a dead `up` holder is still reclaimed (unchanged)", findMesh("reclaimable") === undefined, loadMeshes());
  removeMesh("claimed");
  removeMesh("claimed-live");

  // PROVENANCE IS NOT DOWNGRADED BY A REFRESH. Several `up` paths re-record a mesh they did not
  // start (the "a broker is already on this port" branch concludes it is up from reachability
  // alone). Restamping `origin: "up"` there would quietly make a record only the operator can
  // rebuild deletable by the next sweep.
  // …and the distinction is per CALL SITE, not blanket: the refresh branch starts nothing, so it
  // preserves; a branch that actually spawned the broker (or proved a listener it owns) must claim
  // the record, or `cotal down` would leave a stale record behind and `rm` would treat a mesh this
  // machine is running as someone else's.
  const { recordOurMeshForTest } = await import("../src/commands/up.js");
  recordMesh({ space: "refreshed", server: LIVE, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  recordOurMeshForTest({ space: "refreshed", server: LIVE, root, mode: "open", ts: new Date().toISOString() }, "refresh");
  check("an `up` refresh keeps a hand-registered record's origin", findMesh("refreshed")?.origin === "manual", findMesh("refreshed"));
  recordMesh({ space: "started-over", server: LIVE, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  recordOurMeshForTest({ space: "started-over", server: LIVE, root, mode: "open", ts: new Date().toISOString() }, "started");
  check("a launch that STARTED the broker claims the record, even over a manual one",
    findMesh("started-over")?.origin === "up", findMesh("started-over"));
  recordOurMeshForTest({ space: "ours-now", server: LIVE, root, mode: "open", ts: new Date().toISOString() }, "started");
  check("…and still stamps `up` on a record it created", findMesh("ours-now")?.origin === "up", findMesh("ours-now"));
  // The overlay ACCEPTANCE is the same class as origin and was not carried, so a no-op refresh
  // silently erased a consent the operator had given. It is asserted beside origin because the two
  // are the same rule: a refresh starts nothing, so it may not overwrite what only the operator
  // knows. A `started` takeover MAY replace it — that launch really is the mesh now.
  recordMesh({ space: "acked", server: LIVE, root, mode: "open", origin: "manual", unencryptedOverlay: true, ts: new Date(0).toISOString() });
  recordOurMeshForTest({ space: "acked", server: LIVE, root, mode: "open", ts: new Date().toISOString() }, "refresh");
  check("an `up` refresh keeps a recorded overlay acceptance", findMesh("acked")?.unencryptedOverlay === true, findMesh("acked"));
  recordMesh({ space: "acked-taken", server: LIVE, root, mode: "open", origin: "manual", unencryptedOverlay: true, ts: new Date(0).toISOString() });
  recordOurMeshForTest({ space: "acked-taken", server: LIVE, root, mode: "open", ts: new Date().toISOString() }, "started");
  check("…but a launch that STARTED the broker may replace it", findMesh("acked-taken")?.unencryptedOverlay === undefined, findMesh("acked-taken"));
  // The control for the pair above: a refresh must not INVENT an acceptance nobody gave.
  recordMesh({ space: "never-acked", server: LIVE, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  recordOurMeshForTest({ space: "never-acked", server: LIVE, root, mode: "open", ts: new Date().toISOString() }, "refresh");
  check("…and a refresh never invents one", findMesh("never-acked")?.unencryptedOverlay === undefined, findMesh("never-acked"));
  removeMesh("refreshed");
  removeMesh("started-over");
  removeMesh("ours-now");
  removeMesh("acked");
  removeMesh("acked-taken");
  removeMesh("never-acked");

  const listed = await run([]);
  check("list shows the offline registered mesh", listed.out.includes("remote-dead") && listed.out.includes("offline"), listed.out);
  check("list tags it as registered", listed.out.includes("registered"), listed.out);
  check("`meshes list` is the same as bare `meshes`", (await run(["list"])).out === listed.out);

  // ── rm ────────────────────────────────────────────────────────────────────────────────────────
  setCurrent("remote-dead");
  const removed = await run(["rm", "remote-dead"]);
  check("rm drops the record", removed.code === 0 && findMesh("remote-dead") === undefined, loadMeshes());
  check("rm releases a current that pointed at it", getCurrent() === undefined, getCurrent());
  check("rm says the default is gone", removed.out.includes("no default mesh now"), removed.out);

  const unknown = await run(["rm", "never-existed"]);
  check("rm of an unknown mesh exits non-zero", unknown.code === 1 && unknown.out.includes("no mesh named"), unknown.out);

  recordMesh({ space: "a1", server: DEAD, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  recordMesh({ space: "a2", server: DEAD, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  const multi = await run(["rm", "a1", "a2"]);
  check("rm takes several names at once", multi.code === 0 && loadMeshes().length === 0, loadMeshes());

  // A mesh RUNNING here: `rm` is the wrong verb — it would leave a live broker with no record.
  // "Running here" must be LOCAL PROCESS OWNERSHIP, not a reachable address: any broker answers on
  // that port, including a reused one, and refusing on that basis prints a `cotal down` instruction
  // that would stop nothing. So the smoke gives it a real live pid, the way the mesh does.
  const ownedRoot = projectRoot("owned");
  const brokerStandIn = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120_000)"], { stdio: "ignore" });
  writeFileSync(join(ownedRoot, ".cotal", "nats.pid"), String(brokerStandIn.pid), { mode: 0o600 });
  recordMesh({ space: "live-local", server: LIVE, root: ownedRoot, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  const refused = await run(["rm", "live-local"]);
  check("rm refuses a mesh this machine is running", refused.code === 1 && findMesh("live-local") !== undefined, refused.out);
  check("rm points at `cotal down` instead", refused.out.includes("cotal down"), refused.out);
  check("…and names the live process it means", /pid \d+/.test(refused.out), refused.out);
  // THE CO-ROOTED CASE this feature exists for: a registration for a remote mesh shares the root
  // with the local one (that is `add`'s default). Pidfiles are root-scoped, so the local mesh's live
  // pid is visible under that same root — and must not make `rm <remote>` claim the remote mesh is
  // running here. Safe because a mesh this machine really started is stamped `up` and does get
  // checked; only the hand-registered record skips.
  recordMesh({ space: "remote-corooted", server: DEAD, root: ownedRoot, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  const corooted = await run(["rm", "remote-corooted"]);
  check("rm drops a co-rooted registration despite the local mesh's live pid",
    corooted.code === 0 && findMesh("remote-corooted") === undefined, corooted.out);
  check("…and the local mesh sharing that root is still protected",
    (await run(["rm", "live-local"])).code === 1 && findMesh("live-local") !== undefined, loadMeshes());

  // The same record with a reachable broker but NO local process is not this machine's to keep.
  recordMesh({ space: "not-ours", server: LIVE, root: localRoot, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  const foreign = await run(["rm", "not-ours"]);
  check("rm does not refuse merely because something answers on the address",
    foreign.code === 0 && findMesh("not-ours") === undefined, foreign.out);
  // …and a live process that is NOT the broker must not claim ownership: a manager (or a dashboard)
  // under this root can be watching a mesh that runs somewhere else entirely.
  const watcherRoot = projectRoot("watcher");
  const watcher = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120_000)"], { stdio: "ignore" });
  writeFileSync(join(watcherRoot, ".cotal", "manager.pid"), String(watcher.pid), { mode: 0o600 });
  recordMesh({ space: "watched", server: LIVE, root: watcherRoot, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  const watched = await run(["rm", "watched"]);
  check("rm is not blocked by a local process that isn't the broker",
    watched.code === 0 && findMesh("watched") === undefined, watched.out);
  watcher.kill("SIGKILL");

  const dropped = await run(["rm", "live-local"], { force: true });
  check("rm --force drops a running mesh's record", dropped.code === 0 && findMesh("live-local") === undefined, loadMeshes());
  // …and --force must not be defeated by the guard it is meant to skip. The ownership probe reads
  // the root's local process state; on a root it cannot make sense of, that probe throws, and
  // running it anyway would make the documented override unusable exactly when it is needed.
  const brokenRoot = projectRoot("broken");
  saveSpaceAuth(authDir(brokenRoot), await createSpaceAuth("tenant-a"));
  writeFileSync(join(authDir(brokenRoot), "account.deadbeef.json"), "{ not json"); // unreadable tenant
  writeFileSync(join(brokenRoot, ".cotal", "nats.pid"), String(process.pid), { mode: 0o600 });
  recordMesh({ space: "tenant-a", server: LIVE, root: brokenRoot, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  const forcedOnBroken = await run(["rm", "tenant-a"], { force: true });
  check("rm --force works on a root whose space cannot be resolved",
    forcedOnBroken.code === 0 && findMesh("tenant-a") === undefined, forcedOnBroken.out);
  brokerStandIn.kill("SIGKILL");

  // A live mesh registered BY HAND is not this machine's to stop, so `rm` just drops it.
  recordMesh({ space: "live-remote", server: LIVE, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  const remoteRm = await run(["rm", "live-remote"]);
  check("rm drops a live operator-registered record without --force", remoteRm.code === 0 && findMesh("live-remote") === undefined, remoteRm.out);

  const noNames = await run(["rm"]);
  check("rm without a name prints usage", noNames.code === 1 && noNames.out.includes("usage:"), noNames.out);

  // ── the guided form ───────────────────────────────────────────────────────────────────────────
  // The wizard's PROMPTS need a terminal, but its decisions do not: those live in `meshes-add.ts`
  // so the two front ends cannot drift, and they are what a wrong answer would corrupt. Assert the
  // rules directly, plus the one guarantee scripts depend on — no TTY means no prompt, ever.
  const { checkServer, checkRoot, checkMode, checkEnforcement, probeEnforcement, spacesAtRoot } =
    await import("../src/commands/meshes-add.js");
  const { canPrompt } = await import("../src/commands/meshes-wizard.js");

  check("a pipe is never prompted at (scripts and agents keep the fail-loud form)", canPrompt() === false);

  // The wizard's VALUE is its control flow, and every one of these was answered wrong at least once
  // before a reviewer caught it. Driving the real function with scripted answers is the only way a
  // suite can catch that: asserting the rules alone stayed green while `add <already-registered>`
  // silently overwrote a record and "point at a different folder" asked nothing.
  const { addWizard } = await import("../src/commands/meshes-wizard.js");
  interface Asked { kind: "text" | "select" | "confirm"; message: string; initialValue?: boolean }
  /** A scripted terminal: answers in order, and records what it was asked. */
  const driver = (answers: unknown[]) => {
    const asked: Asked[] = [];
    let i = 0;
    // Running out of answers is a FAILURE, not a source of `undefined`: a wizard that loops asks
    // forever, and without this the suite hangs until the CI job times out instead of saying which
    // question it could not answer.
    const nextAnswer = (q: string) => {
      if (i >= answers.length) throw new Error(`wizard asked more than the script answers: "${q}" (after ${asked.length} prompts)`);
      return answers[i++];
    };
    return {
      asked,
      io: {
        intro() {}, outro() {}, note() {}, cancel() {},
        log: { info() {}, warn() {}, error() {} },
        spinner: () => ({ start() {}, stop() {} }),
        async text(o: { message: string }) { asked.push({ kind: "text", message: o.message }); return nextAnswer(o.message) as string; },
        async select<T>(o: { message: string }) { asked.push({ kind: "select", message: o.message }); return nextAnswer(o.message) as T; },
        async confirm(o: { message: string; initialValue?: boolean }) { asked.push({ kind: "confirm", message: o.message, initialValue: o.initialValue }); return nextAnswer(o.message) as boolean; },
      },
    };
  };

  // 0. THE GUIDED OVERLAY CONSENT. It shipped as dead code: both early paths validated the address
  // with acceptance withheld, so an overlay URL was refused before this question could be asked and
  // the operator could never say yes to something the validator had already rejected. These cases
  // exist because "the flag form works" is not the same claim as "the feature works", and this file
  // is the one that holds the two front ends to the same behaviour.
  const OVERLAY = "nats://100.64.0.1:4222"; // an overlay literal; nothing listens there
  const declined = driver([false]);
  // Declining sends the wizard back to the address prompt, which is correct behaviour and means the
  // script runs out. That exhaustion IS the terminator here, and it doubles as proof the decline
  // did not fall through into registration.
  let declineReprompted = false;
  try {
    await addWizard({ server: OVERLAY }, root, declined.io as never);
  } catch (e) {
    declineReprompted = /asked more than the script answers/.test((e as Error).message);
    if (!declineReprompted) throw e;
  }
  const consentAsk = declined.asked.find((a) => a.kind === "confirm" && /accepting that dependency/i.test(a.message));
  check("the wizard ASKS before registering an unencrypted overlay", consentAsk !== undefined, declined.asked);
  check("…and asks it DEFAULT-DENY, so Enter does not accept an unverifiable transport",
    consentAsk?.initialValue === false, consentAsk);
  check("…and declining returns to the address prompt rather than registering", declineReprompted, declined.asked);
  check("…and writes nothing", loadMeshes().every((m) => m.server !== OVERLAY), loadMeshes());

  // …and the ACCEPTING path, which is the half that proves consent is not printed and forgotten:
  // say yes, take the "register it anyway" exit (nothing listens on an overlay literal here), and
  // assert the WRITTEN record carries the acceptance. The wizard shipped asking a question whose
  // answer reached no record at all, so a test that stops at "it asked" would pass over that.
  const accepted = driver([
    true,        // yes, accept the tunnel dependency  (the transport consent)
    "anyway",    // no broker answered -> record it unverified
    "overlaid",  // space name on that broker
    true,        // register this mesh?
  ]);
  const acceptedOut = await addWizard({ server: OVERLAY, root }, root, accepted.io as never);
  check("accepting the dependency carries the wizard through to a record", acceptedOut === true, accepted.asked);
  check("…and the WRITTEN entry carries the acceptance, not just the prompt",
    findMesh("overlaid")?.unencryptedOverlay === true, findMesh("overlaid"));
  removeMesh("overlaid");

  // …and the NEGATIVE CONTROLS, which are what make the acceptance mean something. Consent is
  // evidence ABOUT A TARGET. A boolean that merely remembers the operator once said yes survives
  // "use a different address", so accepting an overlay and finishing on loopback would record a
  // consent nobody gave for the address actually written — and the field exists precisely to feed
  // a future use-time fence, which would read it as authorization.
  const switched = driver([
    true,        // accept the dependency for the OVERLAY
    "retype",    // …then change your mind and use a different address
    LIVE,        // a loopback broker that really answers
    "openmesh",  // space name
    true,        // register
  ]);
  const switchedOut = await addWizard({ server: OVERLAY, root }, root, switched.io as never);
  check("switching to a safe address after accepting still registers", switchedOut === true, switched.asked);
  check("…and the record carries NO acceptance, because the final target needed none",
    findMesh("openmesh") !== undefined && findMesh("openmesh")?.unencryptedOverlay === undefined, findMesh("openmesh"));
  removeMesh("openmesh");

  // …and the case the two cases above CANNOT reach: overlay A -> a DIFFERENT overlay B. Both cases
  // above end on an address that needs no consent (a loopback), so both are satisfied by a wizard
  // that merely CLEARS the acceptance when the address changes. Neither can tell that apart from a
  // wizard that RE-ASKS for the new target — and re-asking is the actual guarantee, because B needs
  // a consent of its own that only the operator can give. Mutating the binding
  // (`ackedFor !== server` -> `ackedFor === undefined`) left the suite 105/105 green with the marker
  // proving the weakened guard ran: the fixtures reached for the case the fix already handled, so
  // the guard shipped unfenced. This case is the fence. Assert on the RECORDED PROMPTS rather than
  // the outcome: under the weakened binding the second question is never asked, and an
  // outcome-only assertion cannot tell "asked and consented" from "never asked".
  const OVERLAY_B = "nats://100.64.0.2:4222"; // a DIFFERENT overlay literal, same unprotectable class
  const reacked = driver([
    true,        // accept the dependency for OVERLAY (A)
    "retype",    // …then change your mind
    OVERLAY_B,   // …to another address that ALSO cannot be protected
    true,        // and consent AGAIN, for B this time — the prompt the binding exists to force
    "anyway",    // nothing answers on an overlay literal -> record it unverified
    "reacked",   // space name
    true,        // register
  ]);
  // A wizard that skips B's question runs off the end of a script written for the correct flow, so
  // catch that and let the prompt-count checks below report it — a throw here is the mutation's
  // signature, not a reason to abort the file.
  let reackedOut: boolean | undefined;
  let reackedThrew: string | undefined;
  try {
    reackedOut = await addWizard({ server: OVERLAY, root }, root, reacked.io as never);
  } catch (e) {
    reackedThrew = (e as Error).message;
  }
  const consentAsks = reacked.asked.filter((a) => a.kind === "confirm" && /accepting that dependency/i.test(a.message));
  check("changing one unprotectable address for another RE-ASKS the consent (a consent for A is not a consent for B)",
    consentAsks.length === 2, { consentAsks: consentAsks.length, threw: reackedThrew, asked: reacked.asked });
  check("…and the second question is asked DEFAULT-DENY too, so Enter cannot carry A's yes onto B",
    consentAsks[1]?.initialValue === false, consentAsks[1]);
  check("…and the record written for B carries B's own acceptance",
    reackedOut === true && findMesh("reacked")?.unencryptedOverlay === true, { reackedOut, entry: findMesh("reacked"), threw: reackedThrew });
  removeMesh("reacked");

  // The same hole reached without any address change: a pre-seeded flag plus a loopback server.
  const seededSafe = driver(["seeded-safe", true]);
  const seededOut = await addWizard({ server: LIVE, root, allowUnencryptedOverlay: true } as never, root, seededSafe.io as never);
  check("a pre-seeded acceptance does not attach itself to a loopback registration",
    seededOut === true && findMesh("seeded-safe")?.unencryptedOverlay === undefined, findMesh("seeded-safe"));
  removeMesh("seeded-safe");

  // 1. A name that came in on the command line must still hit the clash gate.
  recordMesh({ space: "taken", server: LIVE, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  const clash = driver(["cancel"]);
  const clashOut = await addWizard({ space: "taken", server: LIVE }, root, clash.io as never);
  check("the wizard asks before replacing a record named on the command line",
    clashOut === false && clash.asked.some((a) => a.kind === "select" && a.message.includes("already registered")), clash.asked);
  check("…and cancelling there writes nothing", findMesh("taken")?.ts === new Date(0).toISOString(), findMesh("taken"));
  removeMesh("taken"); // this block's fixture; later cases assert on an empty registry

  // 2. "Point at a different folder" must ASK for one, not re-infer the folder it just rejected.
  const noTrust = projectRoot("wiz-notrust");
  const recover = driver(["root", trustRoot, "openbroker", "anyway", true]);
  const recovered = await addWizard({ server: AUTH_LIVE }, noTrust, recover.io as never);
  const askedForFolder = recover.asked.filter((a) => a.kind === "text" && a.message.includes("Local folder"));
  check("the different-folder recovery actually prompts for a folder", askedForFolder.length === 1, recover.asked);
  check("…and does not loop back to the same dead end",
    recover.asked.filter((a) => a.message.includes("holds no credentials")).length === 1, recover.asked);
  check("…and the recovered registration lands on the folder that was named",
    recovered === true && findMesh("openbroker")?.root === trustRoot, findMesh("openbroker"));
  removeMesh("openbroker");

  // 3. A replacement is still VERIFIED — "replace" must not imply "skip the checks".
  //    Asserted where it can FAIL: replacing toward a broker that rejects these credentials must
  //    reach the failure prompt. Pointing it at a broker that accepts them would pass either way,
  //    which is no assertion at all — it would still be green if replace skipped verification.
  recordMesh({ space: "openbroker", server: LIVE, root: trustRoot, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  const replacing = driver(["replace", "cancel"]);
  const replacedOut = await addWizard({ space: "openbroker", server: AUTH_LIVE, root: trustRoot }, trustRoot, replacing.io as never);
  check("replacing a record still runs the checks (it is not a --force)",
    replacedOut === false && replacing.asked.some((a) => a.message.includes("The check did not pass")), replacing.asked);
  check("…and a declined replacement leaves the original record untouched",
    findMesh("openbroker")?.server === LIVE, findMesh("openbroker"));
  removeMesh("openbroker");

  // 4. An unreachable broker must not be read as "open" for a space this root holds trust for.
  const downAuth = driver(["anyway", "openbroker", true]);
  const downOut = await addWizard({ server: DEAD }, trustRoot, downAuth.io as never);
  check("a mesh registered while DOWN keeps the mode its trust implies, not open",
    downOut === true && findMesh("openbroker")?.mode === "auth", findMesh("openbroker"));
  removeMesh("openbroker");
  check("the broker's ENFORCEMENT is read from the broker, not assumed", (await probeEnforcement(LIVE)) === "open");
  check("…and a dead address is 'unreachable', never 'open'", (await probeEnforcement(DEAD)) === "unreachable");
  // (the "unreachable ⇒ not open" rule is asserted by DRIVING the wizard further down — asserting
  // `checkMode` alone here passed with the wizard's fallback deleted, which is no assertion at all)
  const candidates = spacesAtRoot(trustRoot);
  check("the space candidates a guided run offers come from trust on disk",
    candidates.ok && candidates.value.includes("openbroker"), candidates);
  // An auth dir that cannot be ENUMERATED is not an empty one: swallowing that error let the flag
  // form infer `open` for a root whose credentials merely could not be read.
  const unreadable = projectRoot("unreadable");
  writeFileSync(join(unreadable, ".cotal", "auth"), "not a directory");
  check("an unreadable auth dir is reported, never read as 'no accounts'", !spacesAtRoot(unreadable).ok, spacesAtRoot(unreadable));
  const blocked = await run(["add", "blind"], { server: LIVE, root: unreadable });
  check("…and the flag form exits non-zero rather than recording an open mesh",
    blocked.code === 1 && findMesh("blind") === undefined, blocked.out);
  check("checkEnforcement refuses auth-on-open", !checkEnforcement("auth", "open", LIVE, "x", root).ok);
  check("checkEnforcement refuses open-on-auth", !checkEnforcement("open", "auth", LIVE, "x", root).ok);
  check("checkEnforcement passes a matching pair", checkEnforcement("auth", "auth", LIVE, "x", root).ok && checkEnforcement("open", "open", LIVE, "x", root).ok);
  check("the shared URL rule is the one the wizard validates with", !checkServer("nats://alice:pw@h:1").ok && checkServer(LIVE).ok);
  check("the shared root rule is the one the wizard validates with", !checkRoot(join(bare, "a-file"), bare).ok && checkRoot(root, bare).ok);

  // ── surface ───────────────────────────────────────────────────────────────────────────────────
  const bogus = await run(["frobnicate"]);
  check("an unknown subcommand fails loud with the usage line", bogus.code === 1 && bogus.out.includes("unknown subcommand"), bogus.out);
  const empty = await run([]);
  check("an empty registry points at both ways to fill it", empty.out.includes("cotal up") && empty.out.includes("cotal meshes add"), empty.out);

  recordMesh({ space: "tabbed", server: LIVE, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  // The kernel hands a completer the words AFTER the command name (`emitCommandCompletion`).
  check("completion offers the subcommands first", meshesComplete([""]).items.some((i) => i.value === "add"));
  check("completion offers registered spaces after `rm`", meshesComplete(["rm", ""]).items.some((i) => i.value === "tabbed"));
  check("completion offers the modes after `--mode`", meshesComplete(["add", "x", "--mode", ""]).items.map((i) => i.value).join() === "auth,open,user");
} finally {
  process.chdir(cwd);
  broker.kill("SIGKILL");
  authBroker.kill("SIGKILL");
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

console.log(`\nmeshes registry smoke: ${pass} checks passed`);
process.exit(0);
