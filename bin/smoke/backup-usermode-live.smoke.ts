/**
 * Live USER-AUTH backup lifecycle (the plan's "user-mode live restore" row) — a REAL Better Auth
 * IdP, a REAL `up --user-auth` mesh, and the REAL `cotal` binary as subprocesses:
 *
 *   A. `cotal up --user-auth --idp <real IdP> --detach` brings up the broker + auth service.
 *   B. user-mode state: a device login, a granted `cli` actor, a retained managed AGENT principal,
 *      a seeded channel registry entry, and a user-mode CHAT message.
 *   C. `cotal down --preserve-state` → a ready journal.
 *   D. `cotal backup create` (full) → the artifact binds to USER authority (the provider-scheme
 *      fingerprint over the root chain + owner secret + IdP pin + issuer + ledger), not static.
 *   E. `cotal up --restore` → an `active` journal; the restored mesh serves a USER-MODE connect
 *      (the identity plane — callout + exchange — not just the broker); the seeded channel and the
 *      seeded message survive; the retained agent principal is adoptable under the SAME principal.
 *   F. drift: ONE mutated user-authority input (the owner secret) before a second restore must fail
 *      CLOSED — journal still ready byte-identical, preserved source dev/ino untouched.
 *
 * COTAL_HOME is sandboxed; a fresh temp root and a free high port; kills only what it starts.
 * Needs nats-server on PATH. Run: pnpm smoke:backup-usermode:live  (pnpm build first — the
 * subprocesses run built dist).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createSocket, type AddressInfo } from "node:net";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const worktree = resolve(import.meta.dirname, "..", "..");

// COTAL_HOME must be sandboxed BEFORE any @cotal-ai module loads (module-level state reads it).
const home = mkdtempSync(join(tmpdir(), "cotal-bum-home-"));
process.env.COTAL_HOME = home;
const root = mkdtempSync(join(tmpdir(), "cotal-bum-root-"));

// better-auth is a dependency of implementations/auth, not of this root package, so it does not
// resolve from bin/. Resolve it from the package that owns it rather than widen root deps.
const authRequire = createRequire(join(worktree, "implementations", "auth", "package.json"));
const fromAuth = async (spec: string): Promise<Record<string, any>> =>
  import(pathToFileURL(authRequire.resolve(spec)).href) as Promise<Record<string, any>>;

const { betterAuth } = await fromAuth("better-auth");
const { memoryAdapter } = await fromAuth("better-auth/adapters/memory");
const { jwt } = await fromAuth("better-auth/plugins/jwt");
const { deviceAuthorization } = await fromAuth("better-auth/plugins/device-authorization");
const { bearer } = await fromAuth("better-auth/plugins/bearer");
const { toNodeHandler } = await fromAuth("better-auth/node");

const { CotalEndpoint, isReachable, mintCreds, mintLifecycleUid, newIdentity, principalKey } = await import("@cotal-ai/core");
const { authDir, loadSoleSpaceAuth, spaceSegment, userAuthStateDir, workspaceSecretStore } = await import("@cotal-ai/workspace");
const { cotalAuthProvider, establishIdpSession, findActorUnified } = await import("@cotal-ai/auth");
type DeviceLoginPrompt = import("@cotal-ai/auth").DeviceLoginPrompt;
type CotalMessage = import("@cotal-ai/core").CotalMessage;

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await wait(100); }
  return false;
};
const freePort = () => new Promise<number>((resolvePort, reject) => {
  const socket = createSocket();
  socket.once("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const port = (socket.address() as AddressInfo).port;
    socket.close((error) => error ? reject(error) : resolvePort(port));
  });
});

const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = `bum_${Math.floor(Math.random() * 1e6)}`;
const CLIENT_ID = "cotal-cli";
const BIN = join(worktree, "bin", "cotal.ts");
const TSX = join(worktree, "node_modules", ".bin", "tsx");
const CHANNEL = "general";
const SEEDED_TEXT = "seeded before the user-mode backup";

/** Run the REAL binary in the sandboxed workspace. ASYNC on purpose: a sync child would block this
 *  process's event loop — and the in-process IdP with it — deadlocking every user-mode step. */
function cotal(args: string[], timeoutMs = 120_000): Promise<{ status: number | null; out: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(TSX, [BIN, ...args], { cwd: root, env: { ...process.env, COTAL_HOME: home } });
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (status) => { clearTimeout(timer); resolveRun({ status, out }); });
  });
}
const must = async (label: string, args: string[], timeoutMs?: number) => {
  const result = await cotal(args, timeoutMs);
  check(label, result.status === 0, result.out);
  return result;
};

// ---------- the dev IdP (the bootstrap the user-mode live smokes use) ----------
let handler: ReturnType<typeof toNodeHandler> | undefined;
const idpSrv = createServer((req, res) => handler!(req, res));
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
    deviceAuthorization({ expiresIn: "2m", interval: "1s", validateClient: (id: string) => id === CLIENT_ID }),
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

const stateDir = userAuthStateDir(root, SPACE);
const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");
const sourcePath = join(root, ".cotal", "nats");
const artifact = join(root, "full-backup");
const readJournal = () => JSON.parse(readFileSync(journalPath, "utf8")) as {
  state: string;
  restore?: { attemptId: string };
};

/** Read the stored CHAT backlog back through a directly-minted static admin tap — the sanctioned
 *  witness on a user mesh (only the `cotal mint` VERB is retired, not in-process minting). The read
 *  rides the product's own ephemeral-consumer history path: the admin profile grants
 *  CONSUMER.CREATE on CHAT but NOT STREAM.MSG.GET, so a direct get would be denied. */
async function chatHistory(): Promise<CotalMessage[]> {
  const auth = loadSoleSpaceAuth(authDir(root))!;
  const witness = new CotalEndpoint({
    space: SPACE,
    servers: SERVER,
    creds: await mintCreds(auth, newIdentity(), "admin"),
    card: { name: "backup-witness", kind: "agent" },
    registerPresence: false, watchPresence: false, watchChannels: false, consume: false,
  });
  await witness.start();
  try {
    return await witness.channelHistory(CHANNEL, { limit: 100 });
  } finally {
    await witness.stop().catch(() => {});
  }
}
const textsOf = (msgs: CotalMessage[]): string[] =>
  msgs.flatMap((m) => (m.parts ?? []).map((p) => (p as { text?: string }).text).filter((t): t is string => typeof t === "string"));

try {
  // ---------- A. a real user-auth mesh ----------
  console.log("A) cotal up --user-auth --idp <real IdP> --detach");
  const up = await must("up --user-auth exits 0",
    ["up", "--user-auth", "--idp", base, "--detach", "--server", SERVER, "--space", SPACE]);
  check("up announces the user-auth service", up.out.includes("user-auth service up"), up.out);
  const mesh = JSON.parse(readFileSync(join(home, "meshes", `${spaceSegment(SPACE)}.json`), "utf8")) as { mode: string };
  check('mesh is recorded mode "user"', mesh.mode === "user", mesh);

  // ---------- B. user-mode state ----------
  console.log("B) login + grant + retained agent + seeded channel + a user-mode message");
  const { sub } = await establishIdpSession({
    dir: home, idpUrl: base, clientId: CLIENT_ID,
    onPrompt: (p: DeviceLoginPrompt) => void approve(p.userCode),
  });
  check("device login established", sub === userId, { sub, userId });
  // The operator actor needs scope "admin": `channels set` rides the "channel-writer" view and the
  // preserve cut speaks ctl.admin. EVERY ledger write happens BEFORE the backup — the ledger is an
  // authority input, so a re-grant after the artifact would itself be trust drift.
  await must("actor grant cli (scope incl. admin)",
    ["actor", "grant", "cli", "--sub", sub, "--scope", "spawn,role:default,admin", "--label", "smoke human"]);
  const OWNER = await cotalAuthProvider.ownerForLogin({ store: workspaceSecretStore(root), dir: stateDir, space: SPACE });
  // A retained MANAGED agent principal: real user-mode agent authority (ledger row + sentinel +
  // actor token), the material a same-principal resume must reuse rather than replace.
  // The uid is minted into a NAMED value rather than inline, because the assertion below compares
  // against it. See the comment on that cell for why nothing weaker works.
  const RETAINED_UID = mintLifecycleUid();
  const retained = await cotalAuthProvider.grantAgent({
    store: workspaceSecretStore(root), dir: stateDir, space: SPACE, owner: OWNER, actor: "worker",
    scope: [], allowSubscribe: [CHANNEL], allowPublish: [CHANNEL], role: "worker", parent: `${OWNER}.cli`,
    lifecycleUid: RETAINED_UID,
  });
  check("retained managed agent principal provisioned", !!retained.actorToken && !!retained.sentinelCreds);
  // ...and the provisioning cell above CANNOT SEE the field the retention actually rests on. It
  // reads the grant's return value, which is `{ actorToken, sentinelCreds }` and carries no uid, so
  // it passes identically whether or not the grant was given one. `lifecycleUid` is what SPEC 13.1's
  // predecessor-bearer defence is built on: it is stamped into the bearer so a predecessor
  // incarnation's still-unexpired bearer can never be minted the successor's broker authority at
  // connect. A cell that provisions a retained principal and reports success without ever observing
  // that field proves nothing about the property the field exists for.
  //
  // Presence on the row is NOT the assertion either, and this is the trap worth naming: the ledger
  // writes `row.lifecycleUid ?? mintLifecycleUid()`, so a row ALWAYS carries one. Stripping the
  // field from the grant above would leave the row populated with a uid the ledger invented, and a
  // presence check would stay green while the caller's value was silently discarded. Only the uid
  // THIS caller minted can fail, so that is what is compared. `grantAgent`'s options do declare
  // `lifecycleUid` required and the `??` exists for the ledger's other writer, but that declaration
  // is not what makes this cell safe: no build type-checks this file, so a call that drops the
  // field still runs, and a review dropped it and watched it run. The runtime equality is the
  // enforcement; the signature is only where the intent is written down.
  const retainedRow = findActorUnified(stateDir, OWNER, "worker");
  check("the retained agent's ledger row carries the lifecycle uid THIS grant minted",
    retainedRow?.lifecycleUid === RETAINED_UID, { row: retainedRow?.lifecycleUid, minted: RETAINED_UID });
  await must("seed channel registry",
    ["channels", "set", "preserved", "--desc", "survives user-mode restore", "--space", SPACE]);
  await must("user-mode send seeds a CHAT message", ["send", "msg", CHANNEL, SEEDED_TEXT, "--space", SPACE]);
  const seededTexts = textsOf(await chatHistory());
  check("the seeded message is on the wire before the cut", seededTexts.includes(SEEDED_TEXT), seededTexts);

  // ---------- C. the preserve cut ----------
  console.log("C) down --preserve-state");
  await must("preserve cut", ["down", "--preserve-state"]);
  const ready = readJournal();
  check("preserve cut reaches a ready journal", ready.state === "ready", ready);
  check("broker is offline after the cut", !(await isReachable(SERVER)));

  // ---------- D. the full backup ----------
  console.log("D) backup create (full)");
  await must("full backup on a user mesh", ["backup", "create", artifact]);
  const manifest = JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf8")) as {
    mode: string; selection: string; authority?: { mode: string; scheme: string; authoritySha256: string };
  };
  check("artifact records auth mode user + full selection", manifest.mode === "user" && manifest.selection === "full", manifest);
  // The artifact binds to USER authority: the provider scheme over the root chain AND the user
  // trust inputs (owner secret, IdP pin, issuer, callout/sentinel, ledger) — never the static scheme.
  check("artifact binds to the USER authority fingerprint (not static)",
    manifest.authority?.mode === "user" && /^cotal-user-authority\/v2:/.test(manifest.authority.scheme ?? ""),
    manifest.authority);
  check("the authority fingerprint is a sha256 value", /^[0-9a-f]{64}$/.test(manifest.authority?.authoritySha256 ?? ""));

  // ---------- E. restore ----------
  console.log("E) up --restore → active journal, live identity plane, surviving state");
  await must("restore the user-mode artifact",
    ["up", "--restore", artifact, "--detach", "--server", SERVER, "--space", SPACE]);
  const active = readJournal();
  check("restore completes to an active journal", active.state === "active", active);

  // THE IDENTITY PLANE, not just the broker: a user-mode connect has to go login → exchange →
  // bearer → callout on the RESTORED mesh, and land on the wire as the derived principal.
  const afterText = "posted after the user-mode restore";
  await must("the restored mesh serves a USER-MODE connect", ["send", "msg", CHANNEL, afterText, "--space", SPACE]);
  const restored = await chatHistory();
  const restoredTexts = textsOf(restored);
  check("the seeded message survived the restore", restoredTexts.includes(SEEDED_TEXT), restoredTexts);
  check("the post-restore user-mode message is on the restored wire", restoredTexts.includes(afterText), restoredTexts);
  // The identity plane, proven on the wire: the post-restore frame carries the DERIVED principal
  // (owner.actor), so the callout really minted a scoped user JWT — not just a reachable broker.
  const afterFrame = restored.find((m) => textsOf([m]).includes(afterText));
  check("the post-restore message lands as the derived u_….cli principal",
    /^u_[a-z2-7]{26}\.cli$/.test(afterFrame?.from.id ?? ""), afterFrame?.from);
  check("…and that principal is the logged-in owner's cli actor",
    afterFrame?.from.id === principalKey(OWNER, "cli").key, { got: afterFrame?.from.id, want: principalKey(OWNER, "cli").key });
  const listed = await must("channels list on the restored mesh", ["channels", "list", "--space", SPACE]);
  check("the seeded channel registry entry survived the restore", /#preserved/.test(listed.out), listed.out);

  // Same-principal resume of the retained agent's AUTHORITY: the preserved material must still
  // adopt the SAME principal with the SAME envelope, and never mint a replacement.
  const adopted = await cotalAuthProvider.validateRetainedAgent({
    store: workspaceSecretStore(root), dir: stateDir, space: SPACE, owner: OWNER, actor: "worker",
    actorToken: retained.actorToken, sentinelCreds: retained.sentinelCreds,
  }).then((a: any) => ({ ok: true as const, a }), (e: Error) => ({ ok: false as const, e }));
  check("retained agent material resumes under the SAME principal after the restore",
    adopted.ok && adopted.a.owner === OWNER && adopted.a.actor === "worker" && adopted.a.role === "worker" &&
      adopted.a.parent === `${OWNER}.cli`,
    adopted.ok ? adopted.a : adopted.e.message);
  check("…and the resumed principal is the derived owner.actor key",
    adopted.ok && principalKey(OWNER, "worker").key === `${OWNER}.worker`);

  // ---------- F. one drift refusal, on a second restore ----------
  console.log("F) owner-secret drift before a second restore must fail CLOSED");
  await must("retire the first restore's fallback",
    ["clean", "restore-fallback", "--attempt", active.restore!.attemptId, "--force"]);
  await must("second preserve cut", ["down", "--preserve-state"]);
  check("the second cut is ready", readJournal().state === "ready");
  const journalBefore = readFileSync(journalPath, "utf8");
  const sourceBefore = lstatSync(sourcePath, { bigint: true });
  const ownerSecretPath = join(stateDir, "owner-secret.json");
  const ownerSecretText = readFileSync(ownerSecretPath, "utf8");
  try {
    // ONE user-authority input, drifted: a different owner secret re-derives every principal, so
    // the artifact's authority fingerprint can no longer match the current trust state.
    writeFileSync(ownerSecretPath, JSON.stringify({ ver: 1, secretB64: Buffer.alloc(32, 7).toString("base64") }, null, 2));
    const drifted = await cotal(["up", "--restore", artifact, "--detach", "--server", SERVER, "--space", SPACE]);
    check("owner-secret drift refuses the restore", drifted.status !== 0, drifted.out);
    check("…naming the authority-fingerprint mismatch",
      /authority fingerprint does not match current trust state/.test(drifted.out), drifted.out);
    check("…leaving the ready journal byte-identical", readFileSync(journalPath, "utf8") === journalBefore);
    const sourceAfter = lstatSync(sourcePath, { bigint: true });
    check("…leaving the preserved source untouched (same dev/ino)",
      sourceAfter.dev === sourceBefore.dev && sourceAfter.ino === sourceBefore.ino,
      { before: `${sourceBefore.dev}/${sourceBefore.ino}`, after: `${sourceAfter.dev}/${sourceAfter.ino}` });
    check("…and no broker was exposed by the refused restore", !(await isReachable(SERVER)));
  } finally {
    writeFileSync(ownerSecretPath, ownerSecretText);
  }
  // The control: with the SAME artifact and the drift reverted, the restore passes — so the refusal
  // above was the mutated authority input alone, not incidental state.
  await must("the same restore passes once the drift is reverted",
    ["up", "--restore", artifact, "--detach", "--server", SERVER, "--space", SPACE]);
  check("the reverted restore reaches an active journal", readJournal().state === "active", readJournal());

  console.log(`\nBACKUP USER-MODE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  await cotal(["down"], 60_000); // idempotent — kills by ITS OWN pid files only
  idpSrv.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.exit(process.exitCode ?? 0);
