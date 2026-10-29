/**
 * USER-AUTH LAUNCH live smoke (D4c, the composition-root E2E) — the whole operator story against a
 * REAL broker, a REAL Better Auth IdP, and the REAL `cotal` binary as subprocesses:
 *
 *   A. `cotal up --user-auth --idp <real IdP> --auth-timeout 3 --detach` — provider prepareServer persists the
 *      space-scoped material, the broker preloads the callout account, the auth-service daemon
 *      comes up (callout + exchange/JWKS), the mesh records mode "user".
 *   B. gate-4 surface checks: JWKS served with the explicit cache contract; /exchange rejects
 *      browser-origin requests and requests without the file-ACL capability.
 *   C. a real device-code login (auto-approved) + `cotal actor grant cli --sub …` → a plain
 *      `cotal send -c` connects USER-MODE (login → exchange → bearer → callout) and the message
 *      lands on the wire as the derived `u_….cli` principal (witnessed on a static admin tap);
 *      the ported operator surfaces: `channel` on the plain grant, `history clear --yes`
 *      refused without scope "admin" (naming the purger view + the ADD re-grant) then passing after it.
 *   D. the deny matrix at the operator surface: revoked actor → refused exchange with the reason;
 *      logged-out machine → the exact `cotal login --idp …` line. No fallback anywhere.
 *   E. recovery: a crashed (SIGKILLed) auth service surfaces the exact `cotal up` recovery on a
 *      user connect, a refresh `cotal up` on the RUNNING broker heals it, and a cross-mode flag
 *      (`up --open` on the user mesh) is refused loudly.
 *   E3. `cotal supervise` from another root that holds its own signer for the space is refused as a
 *      refusal: a `Mesh:` heading, PERMISSION_DENIED, the refused credential and broker, and a Next
 *      naming the folder that hosts the space. No bare `Authorization Violation` line.
 *   E4. A prepared second root of the same space under its own home: `manager start` with no sign-in,
 *      or with one the IdP revoked, is refused AUTH_REQUIRED before anything is saved. With the revoked
 *      one, a bare `up` of the running stack and of the stopped stack leaves the manager unattempted,
 *      and a team boot resuming the stopped stack is refused AUTH_REQUIRED before any effect, saying
 *      nothing was started or written, each naming `cotal login --idp <base>`. A manifest without
 *      `auth: user` is refused CONFLICT naming the auth mode, both its values and the `broker.auth`
 *      change, in text and JSON. Signed in again, the manager starts, and a `manager restart`
 *      over it with the sign-in revoked is refused AUTH_REQUIRED before it stops anything, saying the
 *      running manager was left running. A manager left
 *      running after a sign-out is stopped by the folder's owner through `manager stop` and `down`.
 *      `supervise` is refused before it connects, under a `Mesh:` heading with a code and no boot
 *      line, from that stopped root, from a folder with no records (naming the folder that hosts the
 *      space, writing nothing there), and from a stopped static root. A third root is prepared for
 *      a first team as the fresh boot's refusal says, and the `auth grant cli --sub <subject> --full`
 *      it names succeeds. With the IdP's token route answering 503, that boot exits 3, and the next
 *      `down` says the stack start ended with its outcome unconfirmed.
 *   E5. A TLS space behind a local CA, its public exchange behind an HTTPS proxy, joined by a
 *      participant from its bundle: with `NODE_EXTRA_CA_CERTS` set, the participant's `manager start`
 *      comes up and its native child carries the variable; with it unset, the line the refusal quotes
 *      names the TLS reason and ends in the step to set `NODE_EXTRA_CA_CERTS`, quoted whole. With its
 *      sign-in revoked at the IdP, and then with none, its `manager start` is refused AUTH_REQUIRED
 *      before any launch, naming `cotal login --idp <base>`. Signed in again, its manager runs, and a
 *      `manager restart` over it with that sign-in revoked is refused the same way and leaves it running.
 *   F. `cotal down` stops the auth service (space-scoped pid) with the broker; re-`up` WITHOUT
 *      --user-auth on a user-enabled root is refused fail-closed.
 *   G. `clean all`, and `reset space` on a stopped controller stack, name the IdP trust and the
 *      actor ledger they remove and what a later `up` needs; a bare `up` then refuses as they say.
 *
 * COTAL_HOME is sandboxed; kills only what it starts. Needs nats-server on PATH.
 * Run: pnpm smoke:user-auth-launch:live   (pnpm build first — the subprocesses run built dist)
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSmokeSandboxDown, recordSmokeSandbox, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins/jwt";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { bearer } from "better-auth/plugins/bearer";
import { toNodeHandler } from "better-auth/node";
import { pickFreePort } from "./_free-port.js";
const TSX = join(import.meta.dirname, "..", "..", "..", "node_modules", ".bin", "tsx");

const home = mkdtempSync(join(tmpdir(), "cotal-ua-home-"));
const configDir = join(home, "xdg");
process.env.COTAL_HOME = home;
process.env.XDG_CONFIG_HOME = configDir;
const root = mkdtempSync(join(tmpdir(), "cotal-ua-root-"));
const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
// Ambient COTAL_* vars are a seat's environment, not this sandbox's: an inherited
// COTAL_LIFECYCLE_UID silently satisfies `join --creds`'s lifecycle pairing and flips which
// refusal fires, so a cell can pass on an operator's machine and fail in CI's clean env
// (measured, PR #962 shard 3). The child sees only the sandbox's own pins.
const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_")));
const childEnv: Record<string, string | undefined> = { ...inheritedEnv, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" };
// Follow-on assign so a concurrent isolation edit on the object literal does not collide.
// `cotal send` now refuses without a complete identity in this process.
childEnv.COTAL_NAME = "cli";
childEnv.COTAL_ID = "cli_send";

const { connect, credsAuthenticator, tokenAuthenticator } = await import("@nats-io/transport-node");
const { jetstreamManager } = await import("@nats-io/jetstream");
const { channelBucket, chatSubject, isReachable, mintCreds, mintLifecycleUid, newIdentity, presenceBucket } = await import("@cotal-ai/core");
const { authDir, loadSoleSpaceAuth, loadSpaceAuth, readRenewalRecord, spaceKey, spaceSegment, userAuthStateDir, workspaceSecretStore } = await import("@cotal-ai/workspace");
const { cotalAuthProvider, deleteIdpSession, establishIdpSession, INTERACTIVE_RETIRE_PATH, loadActorLedger, loadAuthServiceInfo, loadIdpSession } = await import("../src/index.js");
type CotalMessage = import("@cotal-ai/core").CotalMessage;
type DeviceLoginPrompt = import("../src/index.js").DeviceLoginPrompt;

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
/** Whether a report's `<label>: <value>` row reads exactly `value`. Field labels are padded to one column. */
const field = (out: string, label: string, value: string) =>
  plain(out).split("\n").some((line) => line.trim().startsWith(`${label}:`) && line.trim().slice(label.length + 1).trim() === value);
const until = async (cond: () => boolean, ms = 8000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await wait(100);
  return cond();
};

const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = `ua-launch-${Math.floor(Math.random() * 1e6)}`;
const CLIENT_ID = "cotal-cli";
const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cotal.ts");
const CLAUDE = join(import.meta.dirname, "..", "..", "..", "extensions", "connector-claude-code");

/** Run the REAL binary (built dist through bin/cotal.ts) in the sandboxed workspace. ASYNC on
 *  purpose: a sync child would block this process's event loop — and the in-process IdP with it —
 *  deadlocking any subprocess step that calls back into the IdP (the user-mode send does). */
function cotal(args: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string | undefined>; sandbox?: SmokeSandboxAnchor } = {}): Promise<{ status: number | null; out: string }> {
  return new Promise((resolvePromise) => {
    const options = {
      cwd: opts.cwd ?? root,
      env: { ...childEnv, ...(opts.env ?? {}) },
    };
    assertSmokeSandboxDown(opts.sandbox ?? sandbox, args, options);
    const child = spawn(TSX, [BIN, ...args], options);
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    const t = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
    child.on("close", (status) => { clearTimeout(t); resolvePromise({ status, out }); });
  });
}

// ---------- the real Better Auth IdP ----------
let handler: ReturnType<typeof toNodeHandler> | undefined;
// While set, the token route answers 503, as an IdP that is down does (E4).
let idpTokenUnavailable = false;
const idpSrv = createServer((req, res) => idpTokenUnavailable && req.method === "GET" && req.url?.split("?")[0] === "/api/auth/token"
  ? void res.writeHead(503, { "content-type": "application/json" }).end('{"error":"unavailable"}')
  : handler!(req, res));
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
    bearer(),
  ],
});
handler = toNodeHandler(ba);
const signup = await ba.api.signUpEmail({
  body: { email: "human@example.test", password: "correct-horse-battery", name: "Human 42" },
  returnHeaders: true,
});
const cookie = signup.headers.get("set-cookie")!.split(";")[0];
const userId = signup.response.user.id;
async function approve(userCode: string): Promise<void> {
  const claim = await fetch(`${base}/device?user_code=${encodeURIComponent(userCode)}`, { headers: { cookie, origin } });
  if (!claim.ok) throw new Error(`device claim failed: HTTP ${claim.status}`);
  const res = await fetch(`${base}/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ userCode }),
  });
  if (!res.ok) throw new Error(`device/approve failed: HTTP ${res.status}`);
}
/** Revoke one cached sign-in from the account's session list, as the account page does. */
async function revokeSignIn(token: string): Promise<void> {
  const res = await fetch(`${base}/revoke-session`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(`revoke-session failed: HTTP ${res.status}`);
}

let witnessNc: Awaited<ReturnType<typeof connect>> | undefined;
// E3's second root, with its own home, so `finally` can stop and remove it.
let other: { root: string; home: string; env: Record<string, string>; sandbox: SmokeSandboxAnchor } | undefined;
// E4's home, its prepared roots and its folder with no records, likewise.
let second: { home: string; env: Record<string, string>; roots: { root: string; sandbox: SmokeSandboxAnchor }[]; bare?: string } | undefined;
// E5's TLS host, its proxy and the participant that joined it, likewise.
let caRig: { hostRoot: string; hostHome: string; hostEnv: Record<string, string>; sandbox: SmokeSandboxAnchor; joinRoot: string; joinHome: string; joinEnv: Record<string, string>; proxy: HttpsServer } | undefined;
try {
  // ---------- A. up --user-auth ----------
  console.log("A) cotal up --user-auth --idp <real IdP> --auth-timeout 3 --detach");
  const up = await cotal(["up", "--user-auth", "--idp", base, "--auth-timeout", "3", "--detach", "--server", SERVER, "--space", SPACE]);
  check("up exits 0", up.status === 0, up.out);
  check("up announces the user-auth service + login line", up.out.includes("user-auth service up") && up.out.includes(`cotal login --idp ${base}`), up.out);
  check(
    "up summary reports the complete user-auth component set",
    /^✓ running in the background: nats-server \(pid \d+\), delivery daemon, user-auth service, manager - stop with: `cotal down`$/m.test(plain(up.out)),
    up.out,
  );
  const stateDir = userAuthStateDir(root, SPACE);
  for (const f of ["callout.json", "issuer.json", "owner-secret.json", "idp.json", "service-keys.json", "auth-service.json"])
    check(`space-scoped state exists: ${f}`, existsSync(join(stateDir, f)));
  check("auth-service pid file is space-scoped", existsSync(join(root, ".cotal", `auth-service.${spaceKey(SPACE)}.pid`)));
  // One value sets both sides: the broker's authorization timeout and the callout's deadline.
  const brokerConf = readFileSync(join(root, ".cotal", "auth", "server.conf"), "utf8");
  check("--auth-timeout renders the broker's authorization block and is recorded in the broker policy",
    brokerConf.includes("\nauthorization { timeout: 3 }\n") && (JSON.parse(readFileSync(join(root, ".cotal", "broker-policy.json"), "utf8")) as { authTimeout?: number }).authTimeout === 3,
    brokerConf.split("\n").filter((line) => line.startsWith("authorization")));
  const authLog = join(root, ".cotal", `auth-service.${spaceKey(SPACE)}.log`);
  const timeoutStarts = () => (readFileSync(authLog, "utf8").match(/ with a 3s authorization timeout,/g) ?? []).length;
  check("…and the auth service it starts takes the same timeout as its callout deadline", timeoutStarts() === 1, readFileSync(authLog, "utf8").split("\n").filter((line) => line.includes("auth service up")));
  const meshFile = join(home, "meshes", `${spaceSegment(SPACE)}.json`);
  const mesh = JSON.parse(readFileSync(meshFile, "utf8")) as { mode: string; userAuth?: { idp?: { url?: string } } };
  check('mesh recorded mode "user" with the IdP trust pin', mesh.mode === "user" && mesh.userAuth?.idp?.url === base, mesh);

  // ---------- B. gate-4 surface: JWKS cache contract + exchange hardening ----------
  console.log("B) auth-service surface: JWKS cache contract, browser/cap rejection");
  const info = loadAuthServiceInfo(stateDir)!;
  const retirementProbe = { owner: "u_" + "a".repeat(26), actor: "cli", lifecycleUid: "a".repeat(26) };
  const retireGet = await fetch(`${info.url}${INTERACTIVE_RETIRE_PATH}`);
  check("interactive lifecycle retirement is POST-only", retireGet.status === 405);
  const retireBrowser = await fetch(`${info.url}${INTERACTIVE_RETIRE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example", authorization: `Bearer ${info.cap}` },
    body: JSON.stringify(retirementProbe),
  });
  check("interactive lifecycle retirement refuses browser-origin requests", retireBrowser.status === 403);
  const retireWrongType = await fetch(`${info.url}${INTERACTIVE_RETIRE_PATH}`, {
    method: "POST",
    headers: { "content-type": "text/plain", authorization: `Bearer ${info.cap}` },
    body: JSON.stringify(retirementProbe),
  });
  check("interactive lifecycle retirement requires JSON", retireWrongType.status === 415);
  const retireWithoutCap = await fetch(`${info.url}${INTERACTIVE_RETIRE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(retirementProbe),
  });
  check("interactive lifecycle retirement refuses a missing operator capability", retireWithoutCap.status === 401);
  const retireExtraField = await fetch(`${info.url}${INTERACTIVE_RETIRE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${info.cap}` },
    body: JSON.stringify({ ...retirementProbe, takeover: true }),
  });
  check("interactive lifecycle retirement body is closed", retireExtraField.status === 400);
  const retireMissingRow = await fetch(`${info.url}${INTERACTIVE_RETIRE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${info.cap}` },
    body: JSON.stringify(retirementProbe),
  });
  check("interactive lifecycle retirement refuses an actor absent from the current ledger", retireMissingRow.status === 404);
  const retireBadOwner = await fetch(`${info.url}${INTERACTIVE_RETIRE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${info.cap}` },
    body: JSON.stringify({ ...retirementProbe, owner: "not_derived" }),
  });
  const badOwnerBody = await retireBadOwner.json().catch(() => undefined) as { outcome?: unknown } | undefined;
  check("an owner that is not a derived token is refused before the barrier and states nothing was retired",
    retireBadOwner.status === 400 && badOwnerBody?.outcome === "not-executed", { status: retireBadOwner.status, body: badOwnerBody });
  // Every refusal above came before the barrier, so each states that it retired nothing (SPEC 13.3).
  const guardRefusals = await Promise.all([retireGet, retireBrowser, retireWrongType, retireWithoutCap, retireExtraField, retireMissingRow]
    .map(async (res) => ({ status: res.status, body: await res.json().catch(() => undefined) as { outcome?: unknown } | undefined })));
  check("each guard refusal of interactive lifecycle retirement states nothing was retired",
    guardRefusals.every((r) => r.body?.outcome === "not-executed"), guardRefusals);
  const jwks = await fetch(`${info.url}/jwks`);
  check("JWKS serves with the explicit cache contract", jwks.ok && /max-age=300/.test(jwks.headers.get("cache-control") ?? ""), jwks.headers.get("cache-control"));
  check("JWKS publishes the Ed25519 key set", Array.isArray(((await jwks.json()) as { keys: unknown[] }).keys));
  const noCap = await fetch(`${info.url}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("exchange without the file-ACL capability is 401", noCap.status === 401);
  const browser = await fetch(`${info.url}/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example", authorization: `Bearer ${info.cap}` },
    body: "{}",
  });
  check("browser-origin exchange is rejected (403)", browser.status === 403);

  // ---------- C. login + grant + USER-MODE send ----------
  console.log("C) device login + actor grant + user-mode `cotal send`");
  const { sub } = await establishIdpSession({
    dir: home, idpUrl: base, clientId: CLIENT_ID,
    onPrompt: (p: DeviceLoginPrompt) => void approve(p.userCode),
  });
  check("device login established (sub = the signed-up user)", sub === userId, { sub, userId });
  const grant = await cotal(["actor", "grant", "cli", "--sub", sub, "--full", "--label", "smoke human"]);
  check("actor grant cli succeeds", grant.status === 0 && grant.out.includes("Actor grant stored"), grant.out);
  const cliRow = loadActorLedger(stateDir).find((row) => row.kind === "interactive" && row.actor === "cli");
  const wrongLifecycleUid = cliRow?.lifecycleUid === "a".repeat(26) ? "b".repeat(26) : "a".repeat(26);
  const retireWrongUid = await fetch(`${info.url}${INTERACTIVE_RETIRE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${info.cap}` },
    body: JSON.stringify({ owner: cliRow?.owner, actor: "cli", lifecycleUid: wrongLifecycleUid }),
  });
  const wrongUidBody = await retireWrongUid.json().catch(() => undefined) as { outcome?: unknown } | undefined;
  check("interactive lifecycle retirement refuses a UID other than the current actor row",
    retireWrongUid.status === 409 && wrongUidBody?.outcome === "not-executed", wrongUidBody);
  // The --full grant is the whole envelope: all channels + spawn + the stock role (the golden path —
  // login, grant --full, spawn just works; narrowing is the operator's explicit act).
  check("--full grant takes the full envelope, scope spawn and role:default",
    field(grant.out, "May read", ">") && field(grant.out, "May post", ">") && field(grant.out, "Capabilities", "spawn, role:default"), grant.out);

  // The ENVELOPE rule on the foreground CLI spawn path: NARROW the cli grant explicitly, then an
  // over-ask beyond it is refused at the grant write — before any broker footprint — and the
  // refusal names the exact widening re-grant for the operator. (`up` seeds no persona, so the
  // pin brings its own role-less probe — the refusal must be purely the read over-ask.)
  const narrow = await cotal(["actor", "grant", "cli", "--sub", sub, "--full", "--allow-subscribe", "general", "--allow-publish", "general", "--label", "smoke human"]);
  check("explicit narrow re-grant (upsert) succeeds", narrow.status === 0 && field(narrow.out, "May read", "general"), narrow.out);
  // The MECHANISM, executed rather than described: the upsert replaces the WHOLE row, so a re-grant
  // that names only --scope would reset the ACLs a narrow row just set back to the wide default.
  // Two refusals used to print exactly this command as their remedy. Without --full the CLI now
  // refuses it, and the narrow row is left as it was.
  //
  // On its OWN actor, never on `cli`: a re-grant rotates the row's lifecycle uid, and the elevated
  // views later in this suite hold bearers minted against `cli`'s. Demonstrating a footgun must not
  // fire it into the rest of the run.
  const wNarrow = await cotal(["actor", "grant", "widenprobe", "--sub", sub, "--scope", "spawn", "--allow-subscribe", "general", "--allow-publish", "general"]);
  check("a probe actor is granted narrow, both ACL flags named", wNarrow.status === 0 && field(wNarrow.out, "May read", "general") && field(wNarrow.out, "May post", "general"), wNarrow.out);
  const wWide = await cotal(["actor", "grant", "widenprobe", "--sub", sub, "--scope", "spawn"]);
  check("a re-grant naming ONLY --scope is refused, naming the flags it left off",
    wWide.status !== 0 && wWide.out.includes("--allow-subscribe, --allow-publish left off"), wWide.out);
  const wList = await cotal(["actor", "list"]);
  check("…and the narrow row is unchanged", wList.status === 0 && /\.widenprobe\s+interactive\s+spawn\s+general\s+general(\s|$)/m.test(plain(wList.out)), wList.out);
  const wBack = await cotal(["actor", "grant", "widenprobe", "--sub", sub, "--scope", "spawn", "--allow-subscribe", "general", "--allow-publish", "general"]);
  check("re-granting with every field named still succeeds",
    wBack.status === 0 && field(wBack.out, "May read", "general") && field(wBack.out, "May post", "general"), wBack.out);
  await cotal(["actor", "revoke", "widenprobe", "--sub", sub]);
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(root, ".cotal", "agents", "probe.md"), "---\nname: probe\nsubscribe: [general]\nallowPublish: [general]\n---\nprobe persona.\n");
  // Isolated XDG + skip-seed: this suite is not a first-run seeder. Foreground
  // spawn still materializes the default `claude` connector, so install THIS
  // WORKTREE's connector into the sandbox prefix, never the operator store.
  const extAdd = await cotal(["ext", "add", CLAUDE]);
  check("sandbox ext add of the worktree claude connector succeeds", extAdd.status === 0, extAdd.out);
  // The read list keeps the persona's own `general` (a spawn whose list omits a channel its persona
  // subscribes to is refused on that alone), so `ops.wide` is the only ask beyond the cli grant.
  // `--foreground`: a bare spawn is a managed launch, which needs a terminal to attach and refuses
  // before any grant is read.
  const overSpawn = await cotal(["spawn", "probe", "--foreground", "--allow-subscribe", "general,ops.wide", "--space", SPACE]);
  check("the envelope: a foreground spawn beyond the cli grant is refused (delegation only narrows)",
    overSpawn.status !== 0 && overSpawn.out.includes("delegation only narrows"), overSpawn.out);
  check("…naming the exact widening re-grant", overSpawn.out.includes("cotal actor grant cli --owner"), overSpawn.out);

  // The witness: a directly-minted static admin tap (pre-flip static+user coexist) on the chat wire.
  const auth = loadSoleSpaceAuth(authDir(root))!;
  witnessNc = await connect({ servers: SERVER, authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, newIdentity(), "admin"))) });
  const got: CotalMessage[] = [];
  witnessNc.subscribe(chatSubject(SPACE, "*", "*", "general"), {
    callback: (err, m) => { if (!err) try { got.push(m.json<CotalMessage>()); } catch { /* skip */ } },
  });
  await witnessNc.flush();

  // #4091: on the user's bearer the one-shot sender reads the roster and the channel registry once,
  // so it leaves no watch consumer on either bucket. Counted on an admin tap of its own, whose reply
  // inbox is the connection-scoped one its grant allows.
  const inspectorId = newIdentity();
  const inspector = await connect({
    servers: SERVER,
    authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, inspectorId, "admin"))),
    inboxPrefix: `_INBOX_${inspectorId.id}`,
  });
  const inspectorJsm = await jetstreamManager(inspector);
  const kvConsumers = async () => ({
    presence: (await inspectorJsm.streams.info(`KV_${presenceBucket(SPACE)}`)).state.consumer_count,
    channels: (await inspectorJsm.streams.info(`KV_${channelBucket(SPACE)}`)).state.consumer_count,
  });
  const consumersBefore = await kvConsumers();

  const send = await cotal(["send", "-c", "general", "hello from user mode", "--space", SPACE]);
  check("user-mode send exits 0 (login → exchange → bearer → callout)", send.status === 0, send.out);
  const consumersAfterSend = await kvConsumers();
  check("a user-mode send leaves no watch consumer on the presence bucket or the channel registry (#4091)",
    consumersAfterSend.presence === consumersBefore.presence && consumersAfterSend.channels === consumersBefore.channels, { before: consumersBefore, after: consumersAfterSend });
  const userList = await cotal(["channel", "--space", SPACE]);
  const consumersAfterList = await kvConsumers();
  check("a user-mode `cotal channel` reads the registry once and leaves no scan consumer (#4091)",
    userList.status === 0 && consumersAfterList.channels === consumersAfterSend.channels, { status: userList.status, out: userList.out.slice(0, 300), before: consumersAfterSend, after: consumersAfterList });
  await inspector.close().catch(() => {});
  const hasText = (g: CotalMessage, text: string) => g.parts?.some((pt) => (pt as { text?: string }).text === text);
  const arrived = await until(() => got.some((g) => hasText(g, "hello from user mode")));
  const frame = got.find((g) => hasText(g, "hello from user mode"));
  check("the witness receives it AS the derived u_….cli principal", arrived && /^u_[a-z2-7]{26}\.cli$/.test(frame?.from.id ?? ""), frame?.from);
  // Own-agent control TIER ROUTING: on a user mesh, `cotal stop`/`attach` ride the operator's own
  // bearer on the SPAWN (privileged) tier — a spawn-scoped grant (no admin) must REACH the manager
  // and get ITS decision back. Before this routing, the CLI published on ctl.admin and the broker
  // dropped it (a timeout + scope hint, never a manager reply); `no agent "ghost"` IS the manager
  // answering. The authorization matrix itself is pinned in user-spawn + own-agent-control smokes.
  const ghostStop = await cotal(["stop", "--name", "ghost", "--space", SPACE]);
  check("spawn-scoped `cotal stop` reaches the manager on the spawn tier (its reply, not a broker drop)", ghostStop.status !== 0 && ghostStop.out.includes('no agent "ghost"'), ghostStop.out);
  const ghostAttach = await cotal(["attach", "--name", "ghost", "--space", SPACE]);
  check("spawn-scoped `cotal attach` reaches the manager the same way", ghostAttach.status !== 0 && ghostAttach.out.includes('no agent "ghost"'), ghostAttach.out);

  // PORTED OPERATOR SURFACES (elevated views): `channel` rides the operator's OWN agent
  // bearer, so the plain grant is enough — no view, no extra scope. `history clear` is
  // destructive, so it asks the exchange for the one-shot "purger" view, which only mints
  // against a FRESH ledger row carrying scope "admin". Without it the classified refusal says the
  // purger view was not issued and nothing was purged, and its remedy is the provider's sentence:
  // the view, the missing scope and the ADD-to-current re-grant, never static mint repair.
  const chList = await cotal(["channel", "--space", SPACE]);
  // A fresh mesh has no registry ENTRIES (only `channel set` writes one), so the proof of the
  // read is the list's title for this space, which prints only after the registry read returned.
  check("`channel` lists user-mode on the plain grant (own agent bearer, no view)", chList.status === 0 && plain(chList.out).includes(`Channels · ${SPACE}`), chList.out);
  const clearNoAdmin = await cotal(["history", "clear", "--yes", "--space", SPACE]);
  check(
    '`history clear --yes` without scope "admin" is refused as PERMISSION_DENIED, naming the purger view + the scope',
    clearNoAdmin.status === 2 && clearNoAdmin.out.includes("PERMISSION_DENIED") && clearNoAdmin.out.includes('view "purger"') && clearNoAdmin.out.includes('needs scope "admin"'),
    clearNoAdmin.out,
  );
  check(
    "…and the ADD-to-current re-grant on the WHOLE row, with no purge submitted and never static mint repair",
    clearNoAdmin.out.includes("ADDED") && clearNoAdmin.out.includes("WHOLE ROW") && clearNoAdmin.out.includes("no history purge was submitted") && !clearNoAdmin.out.includes("cotal mint"),
    clearNoAdmin.out,
  );
  // Every field named, deliberately: this is a re-grant of a row that was narrowed above, and
  // omitting the ACL flags here would widen it back to `>`/`>` as a side effect of adding a scope.
  // The suite used to do exactly that, which is the operator mistake this PR is about.
  const adminGrant = await cotal(["actor", "grant", "cli", "--sub", sub, "--scope", "spawn,role:default,admin", "--allow-subscribe", "general", "--allow-publish", "general", "--label", "smoke human"]);
  check("re-grant with admin ADDED to the current scope succeeds (upsert)", adminGrant.status === 0 && adminGrant.out.includes("admin"), adminGrant.out);

  // Capture a REAL elevated bearer while this lifecycle is current, and prove it connects before
  // using it as the stale credential below. A denial without this positive control could be a bad
  // exchange fixture confirming itself rather than retirement invalidating a bearer that worked.
  const copiedElevated = await cotalAuthProvider.userCredentials({
    store: workspaceSecretStore(root),
    dir: stateDir,
    space: SPACE,
    actor: "cli",
    view: "purger",
  });
  const copiedConnect = () => connect({
    servers: SERVER,
    maxReconnectAttempts: 0,
    timeout: 4_000,
    name: "copied-elevated-probe",
    inboxPrefix: "_INBOX_copied_elevated_probe",
    authenticator: [
      credsAuthenticator(new TextEncoder().encode(copiedElevated.sentinelCreds)),
      tokenAuthenticator(copiedElevated.bearer),
    ],
  });
  let copiedBefore: Awaited<ReturnType<typeof connect>> | undefined;
  let copiedBeforeError = "";
  try {
    copiedBefore = await copiedConnect();
    await copiedBefore.flush();
  } catch (error) {
    copiedBeforeError = error instanceof Error ? error.message : String(error);
  }
  check("copied elevated bearer connects before the authorization update", copiedBefore !== undefined, copiedBeforeError);
  await copiedBefore?.close();

  // Keep the admin gate while changing the row's base channel ACL. A scope-narrowing update would
  // deny the copied purger bearer for a different reason and falsely confirm retirement; this one
  // remains view-eligible, so only lifecycle rotation can make the copied bearer stale.
  const rotateSamePrivilege = await cotal(["actor", "grant", "cli", "--sub", sub, "--scope", "spawn,role:default,admin", "--allow-subscribe", "general,ops", "--allow-publish", "general,ops", "--label", "smoke human"]);
  check("admin-retaining ACL re-grant succeeds (whole-row authorization update)", rotateSamePrivilege.status === 0 && rotateSamePrivilege.out.includes("admin") && rotateSamePrivilege.out.includes("ops"), rotateSamePrivilege.out);
  let copiedAfter: Awaited<ReturnType<typeof connect>> | undefined;
  let copiedAfterError = "";
  try {
    copiedAfter = await copiedConnect();
  } catch (error) {
    copiedAfterError = error instanceof Error ? error.message : String(error);
  }
  check(
    "copied elevated bearer is refused after re-grant rotates its lifecycle",
    copiedAfter === undefined && /authorization|permission|retired|lifecycle/i.test(copiedAfterError),
    copiedAfter === undefined ? copiedAfterError : "copied bearer connected",
  );
  await copiedAfter?.close();

  // Re-grant again BEFORE the successor is used. Its row has a fresh uid while the authority head
  // still names the retired predecessor; that is a legitimate not-started successor, not a foreign
  // active lifecycle. The second rotation must therefore succeed without manufacturing a bearer.
  const rerotateUnused = await cotal(["actor", "grant", "cli", "--sub", sub, "--scope", "spawn,role:default,admin", "--allow-subscribe", "general", "--allow-publish", "general", "--label", "smoke human"]);
  check("an unused successor can be re-granted again after its predecessor retired", rerotateUnused.status === 0 && rerotateUnused.out.includes("admin"), rerotateUnused.out);
  const cleared = await cotal(["history", "clear", "--yes", "--space", SPACE]);
  check("`history clear --yes` passes over the one-shot purger view", cleared.status === 0 && cleared.out.includes("History purge acknowledged"), cleared.out);

  // ---------- D. the deny matrix at the operator surface ----------
  console.log("D) revoke → refused; logout → the exact login line");
  const revoke = await cotal(["actor", "revoke", "cli", "--sub", sub]);
  check("actor revoke succeeds", revoke.status === 0, revoke.out);
  // THE FLIP: revoke wires the live-eviction executor — the output must report the live-window
  // outcome honestly (closed-and-verified here, since no connection is open; or a LOUD skip
  // naming why + the bearer-expiry consequence), never silently leave the window unmentioned.
  check("revoke reports the live-connection outcome (evict wired)", /verified gone|live-connection eviction/i.test(revoke.out), revoke.out);
  const denied = await cotal(["send", "-c", "general", "should be refused", "--space", SPACE]);
  // The ledger's own reason. Every refusal's report is titled "Request refused", so "refused" alone
  // would pass for any refusal, a grammar error included.
  check("revoked actor's send is refused with the ledger reason", denied.status !== 0 && denied.out.includes('actor "cli" is not granted'), denied.out);
  const regrant = await cotal(["actor", "grant", "cli", "--sub", sub, "--full"]);
  check("re-grant succeeds (upsert)", regrant.status === 0);
  deleteIdpSession(home, base);
  const loggedOut = await cotal(["send", "-c", "general", "no session", "--space", SPACE]);
  check("logged-out send prints the exact login action", loggedOut.status !== 0 && loggedOut.out.includes(`cotal login --idp ${base}`), loggedOut.out);

  // ---------- E. crash → refresh heal + cross-mode refusal ----------
  console.log("E) auth-service crash → `cotal up` refresh heals it; cross-mode re-up refused");
  // D left the machine logged out — sign back in so the daemon-liveness failure (not the login
  // gate) is what the dead-service send exercises.
  await establishIdpSession({ dir: home, idpUrl: base, clientId: CLIENT_ID, onPrompt: (p: DeviceLoginPrompt) => void approve(p.userCode) });
  const openUp = await cotal(["up", "--open", "--server", SERVER, "--space", SPACE]);
  check("up --open on the running user mesh is refused (names cotal down)", openUp.status !== 0 && openUp.out.includes("cotal down"), openUp.out);
  // THE FLIP: user-facing static creds are retired on user-auth spaces — `cotal auth mint` must
  // refuse with the login/enrollment recourse, never write a working `local.<nkey>` identity file.
  // A label is one owner token ([A-Za-z0-9_]); a `-` would be refused USAGE_INVALID before the
  // user-mesh check, so these labels use `_`.
  const staticMint = await cotal(["auth", "mint", "flip_probe", "--profile", "agent"]);
  check(
    "the flip: `cotal auth mint` on a user mesh is refused UNSUPPORTED, naming the login/enrollment recourse",
    staticMint.status === 2 && staticMint.out.includes("UNSUPPORTED") && staticMint.out.includes("static credentials are not issued for open or per-user-auth spaces") && staticMint.out.includes("login/enrollment path"),
    staticMint.out,
  );
  // Asserted at the segment `mint` would actually have written to (P1). The flat level is where a
  // pre-segment mint wrote, so checking it now would read absent whatever the refused mint did.
  check("the flip: no creds file was written by the refused mint",
    !existsSync(join(root, ".cotal", "auth", "creds", spaceSegment(SPACE), "flip_probe.creds")));
  // observer/admin are retired too: the refusal covers every fixed profile, not only the agent one.
  const observerMint = await cotal(["auth", "mint", "flip_observer", "--profile", "observer"]);
  check(
    "the flip: `auth mint --profile observer` is refused the same way",
    observerMint.status === 2 && observerMint.out.includes("UNSUPPORTED") && observerMint.out.includes("static credentials are not issued for open or per-user-auth spaces"),
    observerMint.out,
  );
  // The data-account signer is not exported from a user mesh either, by the same refusal.
  const signerDir = mkdtempSync(join(tmpdir(), "cotal-ual-signer-"));
  const signerOut = join(signerDir, "signer.json");
  const signerExport = await cotal(["auth", "signer", "--out", signerOut]);
  check(
    "the flip: `auth signer` on a user mesh is refused UNSUPPORTED as `auth mint` is, and writes nothing",
    signerExport.status === 2 && signerExport.out.includes("UNSUPPORTED") && signerExport.out.includes("static credentials are not issued for open or per-user-auth spaces") && signerExport.out.includes("login/enrollment path") && !existsSync(signerOut),
    signerExport.out,
  );
  rmSync(signerDir, { recursive: true, force: true });
  const oldCredsDir = join(root, ".cotal", "auth", "creds");
  mkdirSync(oldCredsDir, { recursive: true });
  const oldStaticCreds = join(oldCredsDir, "old-static.creds");
  let oldStaticMaterial = "";
  let oldStaticError = "";
  const oldStaticUid = mintLifecycleUid();
  try {
    oldStaticMaterial = await mintCreds(auth, newIdentity(), "agent", {
      lifecycleUid: oldStaticUid,
      allowSubscribe: ["general"],
      allowPublish: ["general"],
    });
  } catch (error) {
    oldStaticError = error instanceof Error ? error.message : String(error);
  }
  check("the legacy static-agent control is a lifecycle-bound credential, not a pre-cut stub",
    oldStaticMaterial.includes("BEGIN NATS USER JWT"), oldStaticError);
  writeFileSync(oldStaticCreds, oldStaticMaterial, { mode: 0o600 });
  // Without its provision-time uid, --creds is refused at the lifecycle-pairing guard BEFORE the
  // user-mesh flip is even consulted — that ordering is what the ambient-env leak masked.
  const joinUnpaired = await cotal(["join", "--creds", oldStaticCreds, "--server", SERVER, "--space", SPACE], { timeoutMs: 15_000 });
  check("`join --creds` without its lifecycle uid is refused as lifecycle-paired (SPEC 13.1)",
    joinUnpaired.status !== 0 && joinUnpaired.out.includes("lifecycle-paired"), joinUnpaired.out);
  const joinOldStatic = await cotal(["join", "--creds", oldStaticCreds, "--lifecycle-uid", oldStaticUid, "--server", SERVER, "--space", SPACE], { timeoutMs: 15_000 });
  check("the flip: `join --creds` with an old static cred is refused on a known user mesh", joinOldStatic.status !== 0 && joinOldStatic.out.includes("per-user-auth") && joinOldStatic.out.includes("cotal spawn"), joinOldStatic.out);
  const sendOldStatic = await cotal(["send", "-c", "general", "old static", "--creds", oldStaticCreds, "--server", SERVER, "--space", SPACE], { timeoutMs: 15_000 });
  check("the flip: raw `--creds` send is refused on a known user mesh", sendOldStatic.status !== 0 && sendOldStatic.out.includes("per-user-auth"), sendOldStatic.out);
  // A live service that refuses the retirement before its barrier says so, so the re-grant is a
  // classified refusal (exit 2) naming the unchanged row. A stale capability in the discovery file
  // is that refusal; the file is put back at once.
  const serviceFile = join(stateDir, "auth-service.json");
  const serviceInfo = readFileSync(serviceFile, "utf8");
  const rowBeforeRefusedRegrant = loadActorLedger(stateDir).find((row) => row.kind === "interactive" && row.actor === "cli");
  writeFileSync(serviceFile, JSON.stringify({ ...JSON.parse(serviceInfo), cap: "stale-capability" }));
  const refusedRegrant = await cotal(["actor", "grant", "cli", "--sub", sub, "--scope", "spawn,role:default,admin", "--allow-subscribe", "general", "--allow-publish", "general", "--label", "must not land"])
    .finally(() => writeFileSync(serviceFile, serviceInfo));
  const rowAfterRefusedRegrant = loadActorLedger(stateDir).find((row) => row.kind === "interactive" && row.actor === "cli");
  check(
    "re-grant the live auth service refuses before retiring is a classified refusal with the row unchanged",
    refusedRegrant.status === 2 && refusedRegrant.out.includes("PERMISSION_DENIED") && refusedRegrant.out.includes("the actor row was not changed")
      && JSON.stringify(rowAfterRefusedRegrant) === JSON.stringify(rowBeforeRefusedRegrant),
    { out: refusedRegrant.out, before: rowBeforeRefusedRegrant, after: rowAfterRefusedRegrant },
  );
  // Crash the daemon (SIGKILL — no clean exit, so its stale discovery file survives too).
  const svcPidPath = join(root, ".cotal", `auth-service.${spaceKey(SPACE)}.pid`);
  const svcPid = Number(readFileSync(svcPidPath, "utf8").trim());
  process.kill(svcPid, "SIGKILL");
  await until(() => { try { process.kill(svcPid, 0); return false; } catch { return true; } });
  const rowBeforeFailedRegrant = loadActorLedger(stateDir).find((row) => row.kind === "interactive" && row.actor === "cli");
  const failedDeadServiceRegrant = await cotal(["actor", "grant", "cli", "--sub", sub, "--scope", "spawn,role:default,admin", "--allow-subscribe", "general", "--allow-publish", "general", "--label", "must not land"]);
  // The dead daemon refuses the connection, so no retirement request was sent: a classified refusal
  // (exit 2) naming the unchanged row and the recovery, never an unknown outcome (exit 3).
  check(
    "re-grant with a dead auth service is refused before changing the row",
    failedDeadServiceRegrant.status === 2 && failedDeadServiceRegrant.out.includes("DEPENDENCY_UNAVAILABLE")
      && failedDeadServiceRegrant.out.includes("the actor row was not changed") && failedDeadServiceRegrant.out.includes("`cotal up`"),
    failedDeadServiceRegrant.out,
  );
  const rowAfterFailedRegrant = loadActorLedger(stateDir).find((row) => row.kind === "interactive" && row.actor === "cli");
  check(
    "failed lifecycle retirement leaves the actor row byte-for-byte unchanged",
    JSON.stringify(rowAfterFailedRegrant) === JSON.stringify(rowBeforeFailedRegrant),
    { before: rowBeforeFailedRegrant, after: rowAfterFailedRegrant },
  );
  const deadSend = await cotal(["send", "-c", "general", "service is dead", "--space", SPACE]);
  check("send with a dead auth service names the `cotal up` recovery", deadSend.status !== 0 && deadSend.out.includes("restart it with `cotal up`"), deadSend.out);
  const startsBeforeHeal = timeoutStarts();
  const heal = await cotal(["up", "--server", SERVER, "--space", SPACE]);
  check("refresh `cotal up` on the running broker heals the auth service", heal.status === 0 && heal.out.includes("already running") && heal.out.includes("user-auth service up"), heal.out);
  check("…with the running broker's recorded auth timeout as its callout deadline, though the refresh named none", timeoutStarts() === startsBeforeHeal + 1, readFileSync(authLog, "utf8").split("\n").filter((line) => line.includes("auth service up")));
  const renewal = readRenewalRecord(root, SPACE);
  check("refresh `cotal up` also ensures the manager renewal owner", renewal?.owner === "manager", renewal);
  const healedSend = await cotal(["send", "-c", "general", "healed", "--space", SPACE]);
  check("user-mode send works again after the heal", healedSend.status === 0, healedSend.out);

  // ---------- E2. the readiness window (#1931): the refresh's wait is bound to the daemon pid ----------
  // A same-root refresh launched right after the old daemon died on a broker reload used to give
  // up at a FIXED 15s clock while the replacement daemon was alive and still binding (its
  // authority-plane open outlasting the clock), then a second identical `up` succeeded — a
  // one-shot false "auth service dead". The wait is now process-bound: it continues past the
  // base clock while the pid the launcher claimed is provably alive (up to a fixed bound), and
  // ends AT ONCE with the exit when that pid is gone. The daemon's smoke-only startup hold
  // (COTAL_SMOKE_AUTH_STARTUP_HOLD_MS, honored between the discovery scrub and the authority
  // plane open) makes each leg deterministic without touching a live daemon's boot order.
  console.log("E2) readiness window: slow-but-alive daemon is waited for, dead daemon refused at once, wedged daemon refused at the bound");
  const pidPath = join(root, ".cotal", `auth-service.${spaceKey(SPACE)}.pid`);
  const readSvcPid = () => Number(readFileSync(pidPath, "utf8").trim());
  const pidGone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };

  // E2a. SLOW BUT ALIVE: the daemon holds its startup 10s inside the readiness window (a slow
  // authority-plane open), alive the whole time. The wait is bound to the launched pid, so the
  // refresh must WAIT for it, not race a clock: it exits 0 once the daemon binds. The hold rides
  // the daemon's env only (the refresh argv is untouched, no test hooks on the caller's side).
  const killAuthDaemon = async () => {
    // The daemon may already be gone (a refused cell leaves a dead pid behind): kill only what
    // still runs, and wait for the record's pid to be absent before the next leg claims the slot.
    try { process.kill(readSvcPid(), "SIGTERM"); } catch { /* already dead */ }
    await until(() => { try { return pidGone(readSvcPid()); } catch { return true; } });
  };
  await killAuthDaemon();
  const slowHold = await cotal(["up", "--user-auth", "--idp", base, "--server", SERVER, "--space", SPACE], {
    timeoutMs: 120_000, // base clock + 10s hold + boot + margin
    env: { COTAL_SMOKE_AUTH_STARTUP_HOLD_MS: "10000" },
  });
  check(
    "a daemon alive but slow to bind is waited for: the same-root up exits 0 once it binds",
    slowHold.status === 0 && slowHold.out.includes("user-auth service up"),
    slowHold.out,
  );
  {
    const info = loadAuthServiceInfo(userAuthStateDir(root, SPACE));
    check("…and the waited-for daemon is the live one (discovery names a pid that is alive)", info !== undefined && !pidGone(info.pid), info);
  }

  // E2b. DEAD: the daemon the refresh launched exits before becoming ready — the wait must end
  // AT ONCE with the exited reason, long before either clock. The hold gives the launched pid a
  // window to be claimed and bound to; the KILL makes that pid exit inside the hold.
  await killAuthDaemon();
  const deadStarted = Date.now();
  const deadChild = spawn(TSX, [BIN, "up", "--user-auth", "--idp", base, "--server", SERVER, "--space", SPACE], {
    cwd: root,
    env: { ...childEnv, COTAL_SMOKE_AUTH_STARTUP_HOLD_MS: "60000" },
  });
  let deadOut = "";
  deadChild.stdout!.on("data", (d: Buffer) => { deadOut += d.toString(); });
  deadChild.stderr!.on("data", (d: Buffer) => { deadOut += d.toString(); });
  // Kill ONLY the daemon, identified by what it IS, not by pid arithmetic: the daemon is the one
  // pid whose /proc cmdline names "auth-service". The pidfile first names the LAUNCHER (the `up`
  // process pre-populates its own pid into the claim; `deadChild.pid` is only the tsx wrapper
  // around it, so a pid-inequality guard cannot protect it), and SIGKILLing the launcher
  // mid-wait kills the reporter before any refusal line while the detached held daemon
  // orphans (observed live: the cell dies with bare output and the orphan later steals the
  // authority plane, cascading red through the suite's later legs). A dead or yet-unborn pid
  // has no readable cmdline: keep polling.
  const killTimer = setInterval(() => {
    let pid = 0;
    try { pid = Number(readFileSync(pidPath, "utf8").trim()); } catch { return; }
    if (!(pid > 0)) return;
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("auth-service")) return;
    } catch { return; }
    try { process.kill(pid, "SIGKILL"); } catch { /* raced its own exit */ }
    clearInterval(killTimer);
  }, 20);
  const deadStatus = await new Promise<number | null>((r) => deadChild.once("close", (c) => r(c)));
  clearInterval(killTimer);
  const deadElapsed = Date.now() - deadStarted;
  const dead = { status: deadStatus, out: deadOut, elapsed: deadElapsed };
  check(
    "a daemon that exits before ready ends the wait at once with the exited reason",
    dead.status !== 0 && dead.out.includes("exited before becoming ready"),
    dead.out,
  );
  check("…the refusal came from the pid observation, not a clock (well under the 15s base budget)", dead.elapsed < 15_000, dead.elapsed);

  // E2c. WEDGED: a daemon alive past the bound must still end in a loud refusal that names the
  // live pid and the still-starting state. The hold outlasts the 60s bound, so the cell's own
  // timeout must allow base+bound+margin while the refusal itself lands at ~bound.
  await killAuthDaemon();
  const wedgedHold = await cotal(["up", "--user-auth", "--idp", base, "--server", SERVER, "--space", SPACE], {
    timeoutMs: 180_000, // the 60s bound + daemon teardown margin on a slow runner
    env: { COTAL_SMOKE_AUTH_STARTUP_HOLD_MS: "120000" },
  });
  check(
    "a daemon alive past the bound is refused loudly as alive-and-still-starting",
    wedgedHold.status !== 0 && wedgedHold.out.includes("alive and still starting"),
    wedgedHold.out,
  );
  check(
    "…the wedged refusal names the pid record and the log path",
    wedgedHold.out.includes(`auth-service.${spaceKey(SPACE)}.pid`) && wedgedHold.out.includes(`auth-service.${spaceKey(SPACE)}.log`),
    wedgedHold.out,
  );
  // The wedged daemon is still holding: stop it so the rest of the suite starts clean.
  try { process.kill(readSvcPid(), "SIGKILL"); } catch { /* already gone */ }
  await until(() => { try { return pidGone(readSvcPid()); } catch { return true; } });
  const reHeal = await cotal(["up", "--user-auth", "--idp", base, "--server", SERVER, "--space", SPACE]);
  check("after the wedge is cleared a plain re-up heals the service", reHeal.status === 0 && reHeal.out.includes("user-auth service up"), reHeal.out);

  // ---------- E3. a manager from another root's signer is refused as a refusal ----------
  console.log("E3) supervise from another root with its own signer for the space: a refusal naming the credential, the broker and the next step");
  // A second root starts the same space on its own broker under its own home, then stops. It keeps a
  // signer for SPACE that the running broker on SERVER does not trust.
  {
    const otherRoot = mkdtempSync(join(tmpdir(), "cotal-ua-other-root-"));
    const otherHome = mkdtempSync(join(tmpdir(), "cotal-ua-other-home-"));
    const env = { COTAL_HOME: otherHome, XDG_CONFIG_HOME: join(otherHome, "xdg") };
    other = { root: otherRoot, home: otherHome, env, sandbox: recordSmokeSandbox({ root: otherRoot, cotalHome: otherHome, xdgConfigHome: env.XDG_CONFIG_HOME }) };
    const otherUp = await cotal(["up", "--user-auth", "--idp", base, "--detach", "--server", `nats://127.0.0.1:${await pickFreePort()}`, "--space", SPACE], { cwd: otherRoot, env });
    check("the second root starts the same space on its own broker", otherUp.status === 0, otherUp.out);
    const otherDown = await cotal(["down"], { cwd: otherRoot, env, sandbox: other.sandbox });
    check("…and stops it, keeping its own signer", otherDown.status === 0 && existsSync(join(otherRoot, ".cotal", "auth")), otherDown.out);
    const refused = await cotal(["supervise", "--space", SPACE, "--server", SERVER], { cwd: otherRoot });
    const text = plain(refused.out);
    check("supervise from that root exits 2 under a Mesh: heading with code PERMISSION_DENIED, keeping the broker's words as the native detail",
      refused.status === 2 && text.includes(`Mesh: ${SPACE}\n`) && text.includes("Request refused") && field(refused.out, "Code", "PERMISSION_DENIED") && field(refused.out, "Native detail", "Authorization Violation") && !text.includes("✗ Authorization Violation"), refused.out);
    check("the message names the refused credential, its root, and the broker",
      text.includes(`the broker at ${SERVER} refused the manager credential this folder's signer for space "${SPACE}" minted (${otherRoot}), so no manager started`), refused.out);
    check("Next starts the manager from the folder that hosts the space, and names the participant sign-in",
      /\nNext\n/.test(text) && text.includes(`start the manager from ${root}, the folder that hosts space "${SPACE}": \`cd ${root} && cotal manager start\``) && text.includes("(`cotal meshes add`, then `cotal login`)"), refused.out);
  }

  // ---------- E4. a second root: manager start, its owner's stop, and pre-connect refusals ----------
  console.log("E4) a second root's manager start needs a sign-in, its owner stops a manager left running without one, and supervise refuses before it connects");
  {
    const home2 = mkdtempSync(join(tmpdir(), "cotal-ua-second-home-"));
    const env = { COTAL_HOME: home2, XDG_CONFIG_HOME: join(home2, "xdg") };
    second = { home: home2, env, roots: [] };
    const prepare = async (space: string): Promise<string> => {
      const at = mkdtempSync(join(tmpdir(), "cotal-ua-second-root-"));
      const created = await cotal(["space", "create", space, "--root", at], { cwd: at, env });
      check(`space create prepares ${space} in a second root under its own home`, created.status === 0, created.out);
      second!.roots.push({ root: at, sandbox: recordSmokeSandbox({ root: at, cotalHome: home2, xdgConfigHome: env.XDG_CONFIG_HOME }) });
      return at;
    };
    const root2 = await prepare(SPACE);
    const sandbox2 = second.roots[0]!.sandbox;
    const managerPid = join(root2, ".cotal", `manager.${spaceKey(SPACE)}.pid`);
    const server2 = `nats://127.0.0.1:${await pickFreePort()}`;
    const up2 = await cotal(["up", "-d", "--user-auth", "--idp", base, "--server", server2], { cwd: root2, env });
    check("with no sign-in, up starts the other members and names cotal login first",
      up2.status === 4 && field(up2.out, "Native code", "AUTH_REQUIRED") && plain(up2.out).includes(`\nNext\n  cotal login --idp ${base}, then`), up2.out);
    const refusedStart = await cotal(["manager", "start"], { cwd: root2, env });
    const refusedText = plain(refusedStart.out);
    check("manager start with no sign-in exits 2 under a Mesh: heading with AUTH_REQUIRED, and Next signs in, then starts it",
      refusedStart.status === 2 && refusedText.includes(`Mesh: ${SPACE}\n`) && field(refusedStart.out, "Code", "AUTH_REQUIRED") && refusedText.includes(`cotal login --idp ${base}, then \`cotal manager start\``), refusedStart.out);
    const shown = await cotal(["service", "show", "manager"], { cwd: root2, env });
    check("…before anything was saved or launched",
      !refusedText.includes("saved manager") && !refusedText.includes("forgot manager") && shown.status === 2 && field(shown.out, "Code", "TARGET_NOT_FOUND") && !existsSync(managerPid), { start: refusedStart.out, show: shown.out });
    // A manager started while signed in keeps running after a sign-out, as one the old start left.
    const { sub: sub2 } = await establishIdpSession({ dir: home2, idpUrl: base, clientId: CLIENT_ID, onPrompt: (p: DeviceLoginPrompt) => void approve(p.userCode) });
    const grant2 = await cotal(["actor", "grant", "cli", "--sub", sub2, "--full"], { cwd: root2, env });
    check("the second root grants its signed-in CLI", grant2.status === 0, grant2.out);
    // A cached sign-in the IdP revoked is refused as no sign-in is, before anything is saved or launched.
    await revokeSignIn(loadIdpSession(home2, base)!.token);
    const revokedStart = await cotal(["manager", "start"], { cwd: root2, env });
    const revokedText = plain(revokedStart.out);
    check("manager start with a sign-in the IdP revoked exits 2 with AUTH_REQUIRED, and Next signs in at that IdP, then starts it",
      revokedStart.status === 2 && revokedText.includes(`Mesh: ${SPACE}\n`) && field(revokedStart.out, "Code", "AUTH_REQUIRED") &&
        revokedText.includes("the IdP rejected this machine's sign-in, which has expired or was revoked") && revokedText.includes(`cotal login --idp ${base}, then \`cotal manager start\``), revokedStart.out);
    const revokedShown = await cotal(["service", "show", "manager"], { cwd: root2, env });
    check("…before anything was saved or launched, so no manager runs",
      !revokedText.includes("saved manager") && revokedShown.status === 2 && field(revokedShown.out, "Code", "TARGET_NOT_FOUND") && !existsSync(managerPid), { start: revokedStart.out, show: revokedShown.out });
    // `up` and a team boot start the manager behind the same confirmation, so neither attempts it. A
    // bare up says so; a team boot, which refuses before any write, says nothing was started.
    const revokedRejection = "the IdP rejected this machine's sign-in, which has expired or was revoked; the manager was not attempted";
    const revokedUp = await cotal(["up"], { cwd: root2, env });
    check("with that sign-in, a bare up keeps the other members, does not attempt the manager, and Next signs in at that IdP, then runs up again",
      revokedUp.status === 4 && field(revokedUp.out, "Native code", "AUTH_REQUIRED") && field(revokedUp.out, "Native detail", revokedRejection) &&
        plain(revokedUp.out).includes(`\nNext\n  cotal login --idp ${base}, then run bare \`cotal up\` again`) && !existsSync(managerPid), revokedUp.out);
    const stoppedForBoot = await cotal(["down", "--yes"], { cwd: root2, env, sandbox: sandbox2 });
    check("…and down stops that stack, whose manager was never attempted", stoppedForBoot.status === 0, stoppedForBoot.out);
    // A manifest that leaves out `auth: user` declares static auth, which this stopped stack was not.
    const staticFile = join(root2, "static.yaml");
    writeFileSync(staticFile, `apiVersion: cotal/v1\nkind: Mesh\nspace: ${SPACE}\nbroker:\n  servers: ${server2}\nchannels:\n  general:\n    description: The general channel.\n`);
    const modeConflict = "the manifest differs from the recorded stopped stack in its auth mode (recorded user auth, declared static auth); nothing was resumed";
    const modeNext = "set `broker.auth` to `user` in the manifest to resume this stack, or boot the manifest as a new space in another folder prepared with `cotal space create <space>`";
    const conflictBoot = await cotal(["team", "boot", staticFile], { cwd: root2, env });
    check("a team boot of a manifest without auth: user is refused CONFLICT, naming only the auth mode with both values, and Next names broker.auth or a new space",
      conflictBoot.status === 2 && field(conflictBoot.out, "Code", "CONFLICT") && plain(conflictBoot.out).includes(modeConflict) && plain(conflictBoot.out).includes(`\nNext\n  ${modeNext}`), conflictBoot.out);
    const conflictJson = await cotal(["team", "boot", staticFile, "--json"], { cwd: root2, env });
    const conflictError = (JSON.parse(conflictJson.out.split("\n").find((line) => line.startsWith("{")) ?? "null") as { error?: { code?: string; message?: string; remedy?: string } } | null)?.error;
    check("…and --json carries the same detail and remedy",
      conflictJson.status === 2 && conflictError?.code === "CONFLICT" && conflictError.message === modeConflict && conflictError.remedy === modeNext, conflictJson.out);
    const teamFile = join(root2, "team.yaml");
    writeFileSync(teamFile, `apiVersion: cotal/v1\nkind: Mesh\nspace: ${SPACE}\nbroker:\n  servers: ${server2}\n  auth: user\n  idp: ${base}\nchannels:\n  general:\n    description: The general channel.\n`);
    const revokedBoot = await cotal(["team", "boot", teamFile], { cwd: root2, env });
    const revokedBootText = plain(revokedBoot.out);
    check("a team boot resuming it is refused AUTH_REQUIRED, exit 2, says nothing was started or written, and Next signs in at that IdP, then boots the team again",
      revokedBoot.status === 2 && field(revokedBoot.out, "Code", "AUTH_REQUIRED") && revokedBootText.includes("the IdP rejected this machine's sign-in, which has expired or was revoked; nothing was started or written") &&
        !revokedBootText.includes("the manager was not attempted") && revokedBootText.includes(`cotal login --idp ${base}, then \`cotal team boot ${teamFile}\``), revokedBoot.out);
    check("…before any effect: no broker answers and no manager runs", !(await isReachable(server2)) && !existsSync(managerPid), revokedBoot.out);
    const restarted = await cotal(["up"], { cwd: root2, env });
    check("a bare up of the stopped stack starts the other members and refuses the manager the same way",
      restarted.status === 4 && field(restarted.out, "Native detail", revokedRejection) && plain(restarted.out).includes(`cotal login --idp ${base}, then run bare \`cotal up\` again`) && !existsSync(managerPid), restarted.out);
    await establishIdpSession({ dir: home2, idpUrl: base, clientId: CLIENT_ID, onPrompt: (p: DeviceLoginPrompt) => void approve(p.userCode) });
    const started = await cotal(["manager", "start"], { cwd: root2, env });
    check("signed in and granted, manager start starts it", started.status === 0 && existsSync(managerPid), started.out);
    const pid2 = Number(readFileSync(managerPid, "utf8").trim());
    // A restart over that running manager, with the sign-in revoked, is refused before anything is
    // stopped, and says that manager was left running.
    const revokedRunning = "the IdP rejected this machine's sign-in, which has expired or was revoked; the running manager was left running";
    await revokeSignIn(loadIdpSession(home2, base)!.token);
    const revokedRestart = await cotal(["manager", "restart", "--yes"], { cwd: root2, env });
    const revokedRestartText = plain(revokedRestart.out);
    check("with the sign-in revoked, manager restart over the running manager exits 2 with AUTH_REQUIRED, says the running manager was left running, and Next signs in at that IdP, then restarts it",
      revokedRestart.status === 2 && field(revokedRestart.out, "Code", "AUTH_REQUIRED") && revokedRestartText.includes(revokedRunning) && !revokedRestartText.includes("the manager was not attempted") &&
        revokedRestartText.includes(`cotal login --idp ${base}, then \`cotal manager restart\``), revokedRestart.out);
    check("…before anything was stopped: the same manager still runs",
      readFileSync(managerPid, "utf8").trim() === String(pid2) && (() => { try { process.kill(pid2, 0); return true; } catch { return false; } })(), revokedRestart.out);
    deleteIdpSession(home2, base);
    const blocked = await cotal(["down", "--yes"], { cwd: root2, env, sandbox: sandbox2 });
    check("signed out, down names the manager's own stop first", blocked.status === 2 && field(blocked.out, "Code", "LIFECYCLE_BLOCKED") && plain(blocked.out).includes("cotal svc stop manager --instance"), blocked.out);
    const stopped = await cotal(["manager", "stop", "--yes"], { cwd: root2, env });
    check("signed out, the folder's owner stops it with manager stop, reading the manager's own local receipt",
      stopped.status === 0 && plain(stopped.out).includes("Service stopped") && plain(stopped.out).includes("the pinned child's own local receipt") && !stopped.out.includes("AUTH_REQUIRED") && await until(() => { try { process.kill(pid2, 0); return false; } catch { return true; } }), stopped.out);
    const down2 = await cotal(["down", "--yes"], { cwd: root2, env, sandbox: sandbox2 });
    check("…and down then stops the stack", down2.status === 0, down2.out);
    // supervise refusals: exit 2, a Mesh: heading and a code, before the manager boots or writes.
    const preConnect = (out: string, code: string) => {
      const text = plain(out);
      return text.includes(`Request refused`) && field(out, "Code", code) && !text.includes("manager boot") && !text.includes("✗ ") && !text.includes("re-`cotal up`");
    };
    const stoppedHere = await cotal(["supervise", "--space", SPACE, "--server", SERVER], { cwd: root2, env });
    check("supervise from that stopped root is refused as stopped, not as stale state to remove",
      stoppedHere.status === 2 && plain(stoppedHere.out).includes(`Mesh: ${SPACE}\n`) && preConnect(stoppedHere.out, "TARGET_UNAVAILABLE") &&
        plain(stoppedHere.out).includes(`"${SPACE}" is stopped; its last operation, \`cotal down\`, completed, so no manager started`) &&
        plain(stoppedHere.out).includes(`start it again with \`cotal up\` in ${root2}, or start the manager from the folder whose \`cotal up\` started the broker at ${SERVER}`), stoppedHere.out);
    second.bare = mkdtempSync(join(tmpdir(), "cotal-ua-no-records-"));
    const elsewhere = await cotal(["supervise", "--space", SPACE, "--server", SERVER], { cwd: second.bare });
    check("supervise from a folder with no records names the folder that hosts the space, and writes nothing there",
      elsewhere.status === 2 && plain(elsewhere.out).includes(`Mesh: ${SPACE}\n`) && preConnect(elsewhere.out, "PERMISSION_DENIED") &&
        plain(elsewhere.out).includes(`start the manager from ${root}, the folder that hosts space "${SPACE}": \`cd ${root} && cotal manager start\``) &&
        !plain(elsewhere.out).includes("cotal down") && !existsSync(join(second.bare, ".cotal")), elsewhere.out);
    const RT = `${SPACE}-rt`;
    const root3 = await prepare(RT);
    const up3 = await cotal(["up", "-d", "--no-manager", "--server", `nats://127.0.0.1:${await pickFreePort()}`], { cwd: root3, env });
    const down3 = await cotal(["down", "--yes"], { cwd: root3, env, sandbox: second.roots[1]!.sandbox });
    check("a static second root starts and stops", up3.status === 0 && down3.status === 0, { up: up3.out, down: down3.out });
    const staticStopped = await cotal(["supervise", "--space", RT, "--server", SERVER], { cwd: root3, env });
    check("supervise from the stopped static root is refused as stopped, naming its own up and the broker's folder",
      staticStopped.status === 2 && plain(staticStopped.out).includes(`Mesh: ${RT}\n`) && preConnect(staticStopped.out, "TARGET_UNAVAILABLE") &&
        plain(staticStopped.out).includes(`start it again with \`cotal up\` in ${root3}, or start the manager from the folder whose \`cotal up\` started the broker at ${SERVER}`), staticStopped.out);
    // A first user-auth team, prepared as the boot's own refusal says. With the IdP's token route
    // answering 503, the boot then ends with its outcome unconfirmed, and the next down says so.
    const TB = `${SPACE}-tb`;
    const rootTb = await prepare(TB);
    const tbSandbox = second.roots.at(-1)!.sandbox;
    const serverTb = `nats://127.0.0.1:${await pickFreePort()}`;
    const tbFile = join(rootTb, "team.yaml");
    writeFileSync(tbFile, `apiVersion: cotal/v1\nkind: Mesh\nspace: ${TB}\nbroker:\n  servers: ${serverTb}\n  auth: user\n  idp: ${base}\nchannels:\n  general:\n    description: The general channel.\n`);
    const unprepared = await cotal(["team", "boot", tbFile], { cwd: rootTb, env });
    check("a team boot of a root with no granted login is refused AUTH_REQUIRED, and Next grants the CLI with --full",
      unprepared.status === 2 && field(unprepared.out, "Code", "AUTH_REQUIRED") && plain(unprepared.out).includes("then `cotal login`, then `cotal auth grant cli --sub <subject> --full`, then `cotal down`") && !existsSync(join(rootTb, ".cotal", "stack-controller.json")), unprepared.out);
    const tbUp = await cotal(["up", "-d", "--user-auth", "--idp", base, "--server", serverTb], { cwd: rootTb, env });
    const { sub: tbSub } = await establishIdpSession({ dir: home2, idpUrl: base, clientId: CLIENT_ID, onPrompt: (p: DeviceLoginPrompt) => void approve(p.userCode) });
    const tbGrant = await cotal(["auth", "grant", "cli", "--sub", tbSub, "--full"], { cwd: rootTb, env });
    const tbDown = await cotal(["down", "--yes"], { cwd: rootTb, env, sandbox: tbSandbox });
    check("following it, up prepares the space, the grant it names succeeds, and down stops the stack",
      tbUp.status === 4 && tbGrant.status === 0 && plain(tbGrant.out).includes("Actor grant stored") && tbDown.status === 0, { up: tbUp.out, grant: tbGrant.out, down: tbDown.out });
    idpTokenUnavailable = true;
    const unconfirmed = await cotal(["team", "boot", tbFile], { cwd: rootTb, env });
    idpTokenUnavailable = false;
    check("with the IdP's token route answering 503, that team boot exits 3 with its outcome unconfirmed",
      unconfirmed.status === 3 && field(unconfirmed.out, "Code", "OPERATION_UNKNOWN"), unconfirmed.out);
    const settled = await cotal(["down", "--yes"], { cwd: rootTb, env, sandbox: tbSandbox });
    check("the next down says that stack start ended with its outcome unconfirmed, and not that it was interrupted",
      settled.status === 0 && /^! the earlier stack start \S+ ended with its outcome unconfirmed; every member is running \(broker, auth, delivery, manager\)$/m.test(plain(settled.out)) && !plain(settled.out).includes("was interrupted"), settled.out);
  }

  // ---------- E5. a participant joined by bundle starts a manager behind a local CA ----------
  console.log("E5) a participant that joined a TLS space by its bundle starts a manager with NODE_EXTRA_CA_CERTS, and names the TLS refusal without it");
  {
    const hostHome = mkdtempSync(join(tmpdir(), "cotal-ua-ca-host-home-")), hostRoot = mkdtempSync(join(tmpdir(), "cotal-ua-ca-host-root-"));
    const joinHome = mkdtempSync(join(tmpdir(), "cotal-ua-ca-join-home-")), joinRoot = mkdtempSync(join(tmpdir(), "cotal-ua-ca-join-root-"));
    // A throwaway CA and the 127.0.0.1 certificate it signs, which the broker and the proxy serve.
    const pki = join(hostHome, "pki");
    mkdirSync(pki, { mode: 0o700 });
    const caFile = join(pki, "ca.pem"), caKey = join(pki, "ca.key"), srvCert = join(pki, "srv.pem"), srvKey = join(pki, "srv.key"), srvExt = join(pki, "srv.ext");
    const openssl = (args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
    openssl(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", caKey, "-out", caFile, "-days", "2", "-subj", "/CN=cotal-smoke-ca",
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-addext", "subjectKeyIdentifier=hash"]);
    openssl(["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", srvKey, "-out", join(pki, "srv.csr"), "-subj", "/CN=127.0.0.1"]);
    writeFileSync(srvExt, "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n");
    openssl(["x509", "-req", "-in", join(pki, "srv.csr"), "-CA", caFile, "-CAkey", caKey, "-CAcreateserial", "-out", srvCert, "-days", "2", "-extfile", srvExt]);
    for (const key of [caKey, srvKey]) chmodSync(key, 0o600);
    // The HTTPS reverse proxy an operator puts in front of the public exchange face.
    const exchangePort = await pickFreePort();
    const proxy = createHttpsServer({ key: readFileSync(srvKey), cert: readFileSync(srvCert) }, (req, res) => {
      req.pipe(httpRequest({ host: "127.0.0.1", port: exchangePort, path: req.url, method: req.method, headers: req.headers }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      }).on("error", () => res.writeHead(502).end()));
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const proxyUrl = `https://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const hostEnv = { COTAL_HOME: hostHome, XDG_CONFIG_HOME: join(hostHome, "xdg"), NODE_EXTRA_CA_CERTS: caFile };
    const joinEnv = { COTAL_HOME: joinHome, XDG_CONFIG_HOME: join(joinHome, "xdg"), NODE_EXTRA_CA_CERTS: caFile };
    const hostSandbox = recordSmokeSandbox({ root: hostRoot, cotalHome: hostHome, xdgConfigHome: hostEnv.XDG_CONFIG_HOME });
    caRig = { hostRoot, hostHome, hostEnv, sandbox: hostSandbox, joinRoot, joinHome, joinEnv, proxy };
    const CA_SPACE = `${SPACE}-ca`;
    const hostUp = await cotal(["up", "-d", "--user-auth", "--idp", base, "--space", CA_SPACE, "--server", `tls://127.0.0.1:${await pickFreePort()}`,
      "--tls-cert", srvCert, "--tls-key", srvKey, "--exchange-public-port", String(exchangePort), "--exchange-public-url", proxyUrl], { cwd: hostRoot, env: hostEnv });
    check("a TLS user-auth space behind a local CA starts, its public exchange behind an HTTPS proxy", hostUp.status === 0, hostUp.out);
    const bundleFile = join(hostHome, "bundle.json");
    writeFileSync(bundleFile, await (await fetch(`http://127.0.0.1:${exchangePort}/.well-known/cotal-mesh`)).text());
    const added = await cotal(["space", "add", "--file", bundleFile, "--root", joinRoot], { cwd: joinRoot, env: joinEnv });
    check("a participant under its own home registers the space from its bundle", added.status === 0, added.out);
    const { sub: joinSub } = await establishIdpSession({ dir: joinHome, idpUrl: base, clientId: CLIENT_ID, onPrompt: (p: DeviceLoginPrompt) => void approve(p.userCode) });
    const joinGrant = await cotal(["actor", "grant", "cli", "--sub", joinSub, "--full", "--scope", "spawn,role:default,supervise"], { cwd: hostRoot, env: hostEnv });
    check("the host grants the participant's signed-in CLI supervise", joinGrant.status === 0, joinGrant.out);
    const trusted = await cotal(["manager", "start", "--name", "joined"], { cwd: joinRoot, env: joinEnv });
    check("with NODE_EXTRA_CA_CERTS set, as docs/cli.md says, the participant's manager start comes up",
      trusted.status === 0 && plain(trusted.out).includes("Owned process running"), trusted.out);
    const childPid = /^\s*PID:\s+(\d+)$/m.exec(plain(trusted.out))?.[1];
    const childEnvironment = childPid ? readFileSync(`/proc/${childPid}/environ`, "utf8").split("\0") : [];
    check("…and the native child it launched carries NODE_EXTRA_CA_CERTS from that command", childEnvironment.includes(`NODE_EXTRA_CA_CERTS=${caFile}`), { childPid, names: childEnvironment.map((entry) => entry.split("=")[0]) });
    const joinStop = await cotal(["manager", "stop", "--yes"], { cwd: joinRoot, env: joinEnv });
    check("…and the participant stops it", joinStop.status === 0 && plain(joinStop.out).includes("Service stopped"), joinStop.out);
    const untrusted = await cotal(["manager", "start", "--name", "joined"], { cwd: joinRoot, env: { ...joinEnv, NODE_EXTRA_CA_CERTS: undefined } });
    const quoted = /the last line it logged is: (.*)$/m.exec(plain(untrusted.out))?.[1] ?? "";
    check("with NODE_EXTRA_CA_CERTS unset, manager start exits 5 and the line it quotes names the TLS reason the authority call failed on",
      untrusted.status === 5 && quoted.includes(`did not answer at ${proxyUrl}/manager-service-authority (fetch failed); cause: `) && quoted.includes("UNABLE_TO_VERIFY_LEAF_SIGNATURE"), untrusted.out);
    const logsCommand = /`cotal service logs (\S+) --instance (\S+) --space \S+`/.exec(plain(untrusted.out));
    const untrustedLog = await cotal(["service", "logs", logsCommand?.[1] ?? "manager", "--instance", logsCommand?.[2] ?? "none", "--space", CA_SPACE], { cwd: joinRoot, env: joinEnv });
    const logged = /^ *(✗ the manager did not start: .*)$/m.exec(plain(untrustedLog.out))?.[1] ?? "";
    check("…and that line keeps Node's own message as the cause and ends in the step to trust the CA with NODE_EXTRA_CA_CERTS",
      logged.includes("UNABLE_TO_VERIFY_LEAF_SIGNATURE: unable to verify the first certificate")
        && logged.endsWith("; next: trust the certificate's CA, or a self-signed certificate itself, by setting `NODE_EXTRA_CA_CERTS` to that PEM file for the command that starts the manager, then start it again"), untrustedLog.out);
    check("…and the refusal quotes that line whole, over 400 characters as it is, so the quote ends in its next step",
      [...logged].length > 400 && quoted === logged, { quoted, logged });
    // The participant's cached sign-in, revoked at the IdP and then removed, is refused before any launch.
    const joinManagerPid = join(joinRoot, ".cotal", `manager.${spaceKey(CA_SPACE)}.pid`);
    const joinManagerRuns = () => { try { process.kill(Number(readFileSync(joinManagerPid, "utf8").trim()), 0); return true; } catch { return false; } };
    await revokeSignIn(loadIdpSession(joinHome, base)!.token);
    const revokedJoin = await cotal(["manager", "start"], { cwd: joinRoot, env: joinEnv });
    const revokedJoinText = plain(revokedJoin.out);
    check("with its sign-in revoked at the IdP, the participant's manager start exits 2 with AUTH_REQUIRED, and Next signs in at that IdP, then starts it",
      revokedJoin.status === 2 && field(revokedJoin.out, "Code", "AUTH_REQUIRED") && revokedJoinText.includes("the IdP rejected this machine's sign-in, which has expired or was revoked; the manager was not attempted") &&
        revokedJoinText.includes(`cotal login --idp ${base}, then \`cotal manager start\``), revokedJoin.out);
    deleteIdpSession(joinHome, base);
    const signedOutJoin = await cotal(["manager", "start"], { cwd: joinRoot, env: joinEnv });
    const signedOutJoinText = plain(signedOutJoin.out);
    check("signed out, the participant's manager start refuses the same way",
      signedOutJoin.status === 2 && field(signedOutJoin.out, "Code", "AUTH_REQUIRED") && signedOutJoinText.includes("no user is signed in for this space; the manager was not attempted") &&
        signedOutJoinText.includes(`cotal login --idp ${base}, then \`cotal manager start\``), signedOutJoin.out);
    check("…and neither start left a manager running", !joinManagerRuns(), { pidFile: existsSync(joinManagerPid) ? readFileSync(joinManagerPid, "utf8") : "absent" });
    // Signed in again, its manager runs; a restart over it with that sign-in revoked is refused the same
    // way and leaves it running.
    await establishIdpSession({ dir: joinHome, idpUrl: base, clientId: CLIENT_ID, onPrompt: (p: DeviceLoginPrompt) => void approve(p.userCode) });
    const joinRunning = await cotal(["manager", "start"], { cwd: joinRoot, env: joinEnv });
    check("signed in again, the participant's manager start starts it", joinRunning.status === 0 && joinManagerRuns(), joinRunning.out);
    const joinRunningPid = readFileSync(joinManagerPid, "utf8").trim();
    await revokeSignIn(loadIdpSession(joinHome, base)!.token);
    const revokedJoinRestart = await cotal(["manager", "restart", "--yes"], { cwd: joinRoot, env: joinEnv });
    const revokedJoinRestartText = plain(revokedJoinRestart.out);
    check("with that sign-in revoked, the participant's manager restart exits 2 with AUTH_REQUIRED, says the running manager was left running, and Next signs in at that IdP, then restarts it",
      revokedJoinRestart.status === 2 && field(revokedJoinRestart.out, "Code", "AUTH_REQUIRED") && revokedJoinRestartText.includes("the IdP rejected this machine's sign-in, which has expired or was revoked; the running manager was left running") &&
        revokedJoinRestartText.includes(`cotal login --idp ${base}, then \`cotal manager restart\``), revokedJoinRestart.out);
    check("…and leaves the running manager as it was", joinManagerRuns() && readFileSync(joinManagerPid, "utf8").trim() === joinRunningPid, revokedJoinRestart.out);
    await establishIdpSession({ dir: joinHome, idpUrl: base, clientId: CLIENT_ID, onPrompt: (p: DeviceLoginPrompt) => void approve(p.userCode) });
    const joinStopped = await cotal(["manager", "stop", "--yes"], { cwd: joinRoot, env: joinEnv });
    check("signed in again, the participant stops it", joinStopped.status === 0 && await until(() => !joinManagerRuns()), joinStopped.out);
    const hostDown = await cotal(["down", "--yes"], { cwd: hostRoot, env: hostEnv, sandbox: hostSandbox });
    check("…and the TLS host stops", hostDown.status === 0, hostDown.out);
  }

  // ---------- F. down + fail-closed re-up ----------
  console.log("F) down stops the auth service; re-up without --user-auth is refused");
  const down = await cotal(["down"]);
  check("down exits 0 and stops the user-auth service", down.status === 0 && down.out.includes("user-auth service"), down.out);
  check("auth-service pid file is gone", !existsSync(join(root, ".cotal", `auth-service.${spaceKey(SPACE)}.pid`)));
  let brokerGone = false;
  for (let i = 0; i < 30 && !brokerGone; i++) { brokerGone = !(await isReachable(SERVER)); if (!brokerGone) await wait(200); }
  check("broker is gone", brokerGone);
  const reup = await cotal(["up", "--detach", "--server", SERVER, "--space", SPACE]);
  check(
    "re-up WITHOUT --user-auth is refused fail-closed, as a refusal (CONFLICT, exit 2, names --user-auth)",
    reup.status === 2 && reup.out.includes("Request refused") && reup.out.includes("CONFLICT") && reup.out.includes("nothing was started") && reup.out.includes("add --user-auth"),
    reup.out,
  );
  // THE FLIP, open-boot edition: `--open` skips authSetup, so it needs its own fail-closed guard —
  // otherwise it would boot a CREDLESS broker over the user space's existing JetStream store and
  // re-record the mesh "open" over its user entry.
  const openReup = await cotal(["up", "--open", "--detach", "--server", SERVER, "--space", SPACE]);
  check(
    "the flip: `up --open` on a downed user-auth root is refused (no credless boot over the store), as a refusal (CONFLICT, exit 2)",
    openReup.status === 2 && openReup.out.includes("Request refused") && openReup.out.includes("CONFLICT") && openReup.out.includes("--open would serve its streams without auth") && openReup.out.includes("replace --open with --user-auth"),
    openReup.out,
  );

  // ---------- G. a reset names the IdP trust and the actor ledger it removes ----------
  console.log("G) clean all and reset space name the IdP trust and the actor ledger they remove");
  const userAuthDir = `.cotal/auth/${spaceSegment(SPACE)} (IdP trust and actor ledger)`;
  const cleanPreview = await cotal(["clean", "all", "--dry-run"]);
  check("clean all --dry-run names the IdP trust and the actor ledger, and what a later up needs",
    cleanPreview.status === 0 && cleanPreview.out.includes(`would remove ${userAuthDir}`) && cleanPreview.out.includes("every actor grant would be lost") && cleanPreview.out.includes("cotal up --user-auth --idp <auth base URL>"), cleanPreview.out);
  const cleaned = await cotal(["clean", "all", "--force"]);
  check("…and its receipt names them the same way",
    cleaned.status === 0 && cleaned.out.includes(`removed ${userAuthDir}`) && cleaned.out.includes("every actor grant is lost") && cleaned.out.includes("minted on the next `cotal up --user-auth --idp <auth base URL>`"), cleaned.out);
  const STACK = `${SPACE}-stack`;
  const created = await cotal(["space", "create", STACK]);
  check("space create prepares a controller stack in the cleaned root", created.status === 0, created.out);
  // No login exists for this space, so the manager is not attempted and up reports a known partial.
  const stackUp = await cotal(["up", "--user-auth", "--idp", base, "--server", SERVER]);
  check("the controller stack starts with user auth", stackUp.status === 0 || stackUp.status === 4, stackUp.out);
  const stackDown = await cotal(["down", "--yes"]);
  check("down --yes stops the controller stack", stackDown.status === 0, stackDown.out);
  const resetPreview = await cotal(["reset", "space", STACK, "--dry-run"]);
  check("reset space --dry-run names the IdP trust and the actor ledger, and what a later up needs",
    resetPreview.status === 0 && plain(resetPreview.out).includes("Removes the IdP trust and the actor ledger of this user-auth space, so every actor grant is lost. A later up needs `cotal up --user-auth --idp <auth base URL>`") && !resetPreview.out.includes("a later up starts it with a new identity"), resetPreview.out);
  const reset = await cotal(["reset", "space", STACK, "--yes"]);
  check("…and its receipt names them the same way",
    reset.status === 0 && plain(reset.out).includes(`.cotal/auth/${spaceSegment(STACK)} (IdP trust and actor ledger)`) && plain(reset.out).includes("Removed the IdP trust and the actor ledger of this user-auth space") && !reset.out.includes("A later up creates a new local identity"), reset.out);
  const bareUp = await cotal(["up"]);
  check("a bare up then refuses and names --user-auth --idp, as the reset said",
    bareUp.status === 1 && bareUp.out.includes("needs the IdP it trusts") && bareUp.out.includes("cotal up --user-auth --idp <auth base URL>"), bareUp.out);

  console.log(`\nUSER-AUTH LAUNCH SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await witnessNc?.close(); } catch { /* */ }
  await cotal(["down"], { timeoutMs: 30_000 }); // idempotent — kills by ITS OWN pid files only
  await cotal(["down", "--yes"], { timeoutMs: 30_000 }); // the controller stack of G, if it is still up
  if (other) {
    await cotal(["down"], { cwd: other.root, env: other.env, sandbox: other.sandbox, timeoutMs: 30_000 }); // E3's second root, if it is still up
    rmSync(other.home, { recursive: true, force: true });
    rmSync(other.root, { recursive: true, force: true });
  }
  if (second) {
    for (const { root: at, sandbox: anchor } of second.roots) {
      await cotal(["down", "--yes"], { cwd: at, env: second.env, sandbox: anchor, timeoutMs: 30_000 }); // E4's roots, if still up
      rmSync(at, { recursive: true, force: true });
    }
    if (second.bare) rmSync(second.bare, { recursive: true, force: true });
    rmSync(second.home, { recursive: true, force: true });
  }
  if (caRig) {
    await cotal(["manager", "stop", "--yes"], { cwd: caRig.joinRoot, env: caRig.joinEnv, timeoutMs: 30_000 }); // E5's participant manager, if it still runs
    await cotal(["down", "--yes"], { cwd: caRig.hostRoot, env: caRig.hostEnv, sandbox: caRig.sandbox, timeoutMs: 30_000 }); // E5's TLS host, if still up
    caRig.proxy.close();
    for (const dir of [caRig.hostHome, caRig.hostRoot, caRig.joinHome, caRig.joinRoot]) rmSync(dir, { recursive: true, force: true });
  }
  idpSrv.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
