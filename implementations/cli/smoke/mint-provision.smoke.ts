/**
 * `cotal auth mint --provision`: an out-of-band identity that can CONSUME, not only publish.
 *
 * On an authed mesh the DM and TASK consumers are provisioner-pre-created and bind-only (SPEC
 * section 9), so a credential minted with `cotal auth mint` alone can publish within its post ACL but
 * its first consuming connect dies on the broker's "consumer not found" — measured live before
 * this flag existed. `--provision` performs the same pre-create `cotal spawn` does for its seats,
 * from a provisioner cred that is minted, used and dropped inside the command.
 *
 *   1. mint WITHOUT --provision, connect with consume on   → start fails on the missing inbox
 *      (the repro, kept as the negative control so cell 2 cannot green vacuously)
 *   2. mint WITH --provision --role board, connect          → starts; a DM from another peer arrives;
 *      an anycast to the role arrives on the svc_board queue; the provisioner connection the
 *      command opened is gone before it returns
 *   3. the receipt shows the principal and the lifecycle uid the credential actually carries
 *   4. --provision --allow-subscribe fix.x                  → the read grant is fix.x and NOT general
 *      (the pre-created filter rides the ACL, never widened to the launcher default), and the
 *      identity reads fix.x live but cannot join general
 *   5. --provision / --role / --allow-subscribe / --allow-publish off the agent profile, --signer on
 *      mint, and the footprint flags on `auth signer` → exit 1, one sentence, nothing written; `auth
 *      signer` into a missing folder → exit 2 naming it, nothing created; and
 *      the control that the same ACL flag on the agent profile still works
 *   6. --provision naming a mesh on another trust root; from a FRESH open root (no auth on disk, as
 *      `cotal up` leaves one), where mint and signer export refuse as unsupported; from a root holding
 *      its OWN auth for a mesh of the same name that runs on another trust root → refused (exit 2)
 *      each, naming why, nothing minted
 *   7. --expires-in bounds the credential: the JWT's exp is iat + the flag, within a second; a
 *      bare mint carries the 24-hour default; --no-expiry carries no exp and records the request
 *      beside its file
 *   8. --identity <creds> re-mints for the SAME nkey: the new credential's principal equals the
 *      original's; the seed file is read by core's own loader
 *   9. the refusals: both lifetime flags at once, or --no-expiry with either; --expires-in the seam would refuse (0, negative,
 *      fractional) without echoing it; an expiry past the last representable date; --identity on a file with no seed; --identity with a missing
 *      path → refused each, one sentence, nothing written
 *  10. --replace: an existing label refuses CONFLICT, naming --replace; --replace swaps an expired
 *      standing credential and an unbounded one, whose no-expiry record goes with it; a still-valid
 *      one refuses CONFLICT naming its expiry and stays as it was; --replace with --out is refused
 *  11. an agent mint lists its grants; --identity keeps them unless a flag replaces one; doctor auth
 *      lists each --out file with its state, and an expired one's repair re-mints it in place
 *
 * Every cell dispatches real argv through `runCli` (the binary's entry: spec parsing, then the
 * registered runner), never a hand-built ParsedArgs. It runs in a child, because the kernel writes a
 * refusal straight to the stderr descriptor and exits.
 * OS-assigned loopback port; needs `nats-server` on PATH. No cell dials the default broker address,
 * 127.0.0.1:4222: a root with no registration resolves to it, and on a shared host another broker can
 * be listening there and accept a provisioning attempt. The cell that mints from such a root names a
 * port this suite holds instead.
 * Run: pnpm smoke:mint-provision:auth
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The child `runCotal` starts: the composition root as the binary imports it (the CLI and the
// `auth` command register themselves), one command line through `runCli`, then its exit code.
if (process.argv[2] === "cotal-child") {
  await import("../src/index.js");
  await import("@cotal-ai/auth");
  const { registry } = await import("@cotal-ai/core");
  const { runCli } = await import("../src/command.js");
  await runCli(registry, process.argv.slice(3));
  process.exit(process.exitCode ?? 0);
}

for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
const home = mkdtempSync(join(tmpdir(), "cotal-mint-prov-home-"));
process.env.COTAL_HOME = home;
process.env.COTAL_NO_PROMPT = "1";

const {
  CotalEndpoint, createSpaceAuth, jwtFromCreds, mintCreds, newIdentity, setupSpaceStreams,
  seedChannelRegistry, provisionAgent, mintLifecycleUid, principalKey, DEV_OWNER,
} = await import("@cotal-ai/core");
type CotalMessage = import("@cotal-ai/core").CotalMessage;
const { agentSecretFilePaths, authDir, canonicalRoot, saveSpaceAuth, recordMesh } = await import("@cotal-ai/workspace");
const { credsClaims } = await import("@cotal-ai/core");
const { bootBroker } = await import("../../manager/smoke/_boot-broker.js");

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, timeoutMs = 8000, stepMs = 50): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await wait(stepMs);
  return cond();
};

/** Run `cotal <words…>` THROUGH THE BINARY'S DISPATCH (`runCli`: the command's declared flag specs
 *  parse the argv, then its registered runner runs) in a child from the current folder: its stdout
 *  and stderr together, and the exit code the operator would get. */
async function runCotal(words: string[]): Promise<{ out: string; code: number }> {
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "cotal-child", ...words], { stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => void chunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => void chunks.push(chunk));
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve(status ?? -1));
  });
  // Colour codes stripped: the cells below read values off the lines, not decoration.
  return { out: Buffer.concat(chunks).toString("utf8").replace(/\x1b\[[0-9;]*m/g, ""), code };
}
const runMint = (argv: string[]) => runCotal(["auth", "mint", ...argv]);

/** What a client recovers from the credential without connecting: the principal tag and the
 *  lifecycle uid its dm/dlv/chathist grants are named for (SPEC 13.1). */
function facts(creds: string): { principal?: string; uids: string[]; subAllow: string[] } {
  const jwt = jwtFromCreds(creds)!;
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as {
    nats?: { tags?: string[]; pub?: { allow?: string[] }; sub?: { allow?: string[] } };
  };
  const principal = (payload.nats?.tags ?? []).find((t) => t.startsWith("principal:"))?.slice("principal:".length);
  const uids = new Set<string>();
  for (const s of payload.nats?.pub?.allow ?? []) {
    const m = /(?:^|\.)(?:dm|dlv|chathist)_([^.]+)/.exec(s);
    if (m) uids.add(m[1]!.split("-").pop()!);
  }
  return { principal, uids: [...uids], subAllow: payload.nats?.sub?.allow ?? [] };
}

/** Broker-side truth: the client names of every OPEN connection, off the monitoring endpoint. The
 *  endpoint connects as `cotal:<card.name>`, so a provisioner the command forgot to drop is an open
 *  connection named `cotal:mint-provisioner` — counted by the BROKER, not by this process's own
 *  socket bookkeeping (which a half-closed neighbour connection can mask either way). */
async function connNames(monitorUrl: string): Promise<string[]> {
  const r = await fetch(`${monitorUrl}/connz`);
  const body = (await r.json()) as { connections?: Array<{ name?: string }> };
  return (body.connections ?? []).map((c) => c.name ?? "");
}

const SPACE = "main";
const root = mkdtempSync(join(tmpdir(), "cotal-mint-prov-root-"));
mkdirSync(join(root, ".cotal"), { recursive: true });
const auth = await createSpaceAuth(SPACE);
const broker = await bootBroker(auth, { monitor: true });
if (!broker.monitorUrl) throw new Error("broker booted without its monitoring endpoint");
const cleanup: Array<() => Promise<void> | void> = [() => broker.stop()];
const cwd0 = process.cwd();

try {
  // The space, provisioned as `cotal up` leaves it: trust material in the root, streams and the
  // channel registry on the broker, and a registry entry so the target resolves to THIS broker.
  saveSpaceAuth(authDir(root), auth);
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: broker.servers, space: SPACE, creds: provisioner });
  await seedChannelRegistry({ servers: broker.servers, space: SPACE, creds: provisioner, file: { channels: { general: {}, "fix.x": {} } } });
  recordMesh({ space: SPACE, server: broker.servers, root, mode: "auth", ts: new Date().toISOString(), origin: "manual" });
  process.chdir(root); // `auth mint` finds the root's `.cotal/` by walking up from cwd, like the binary
  cleanup.push(() => process.chdir(cwd0));

  // A second, ordinary peer that will DM and anycast the minted identity. Provisioned the launcher
  // way (the control): its footprint is what --provision must reproduce for the minted one.
  const peerIdent = newIdentity();
  const prov = new CotalEndpoint({
    space: SPACE, servers: broker.servers, creds: provisioner,
    card: { name: "prov", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false,
  });
  await prov.start();
  const peerCreds = await provisionAgent(prov, auth, peerIdent, {
    subscribe: ["general"], allowSubscribe: ["general", "fix.x"], allowPublish: ["general", "fix.x"], lifecycleUid: mintLifecycleUid(),
  });
  await prov.stop();
  const peerUid = facts(peerCreds).uids[0]!;
  const peer = new CotalEndpoint({
    space: SPACE, servers: broker.servers, creds: peerCreds, lifecycleUid: peerUid,
    card: { name: "peer", kind: "agent" }, channels: ["general"], watchPresence: false, registerPresence: false,
  });
  await peer.start();
  cleanup.push(() => peer.stop());

  // ── 1. the repro: creds only, then a consuming connect ───────────────────────────────────────
  {
    const out = join(root, "plain.creds");
    const r = await runMint(["plain", "--profile", "agent", "--out", out]);
    check("mint without --provision succeeds (creds only)", r.code === 0 && existsSync(out), r.out);
    check("  and says its broker footprint was not provisioned", /Broker footprint:\s+not provisioned by this command/.test(r.out), r.out);
    const creds = readFileSync(out, "utf8");
    const { uids } = facts(creds);
    check("  its grants name exactly one lifecycle uid", uids.length === 1, uids);
    const ep = new CotalEndpoint({
      space: SPACE, servers: broker.servers, creds, lifecycleUid: uids[0],
      card: { name: "plain", kind: "agent", role: "board" }, channels: [], watchChannels: false,
      watchPresence: false, registerPresence: false,
    });
    ep.on("error", () => {});
    let failure = "";
    try {
      await Promise.race([ep.start(), wait(15_000).then(() => { throw new Error("start hung 15s"); })]);
    } catch (e) {
      failure = (e as Error).message;
    }
    await ep.stop().catch(() => {});
    check("  a consuming connect FAILS: the inbox durable was never pre-created (the negative control)",
      /consumer not found|not found/i.test(failure), failure);
  }

  // ── 2. --provision: the same mint, and the identity can consume ─────────────────────────────
  {
    const out = join(root, "board.creds");
    const r = await runMint(["board", "--profile", "agent", "--provision", "--role", "board", "--out", out]);
    check("mint --provision --role board succeeds", r.code === 0 && existsSync(out), r.out);
    check("  it says so", /Broker footprint:\s+native provisioning acknowledged/.test(r.out), r.out);
    // Positive control for the connz reader first: it must SEE a named open connection (the peer's)
    // before its silence about the provisioner can mean anything — a broken reader returns [] for
    // both and would otherwise green the leak cell.
    check("  the broker's connz names the peer's open connection (the leak instrument sees connections)",
      (await connNames(broker.monitorUrl)).includes("cotal:peer"), await connNames(broker.monitorUrl));
    let leaked = await connNames(broker.monitorUrl);
    const gone = async () => { leaked = await connNames(broker.monitorUrl!); return !leaked.includes("cotal:mint-provisioner"); };
    const deadline = Date.now() + 2000;
    let dropped = await gone();
    while (!dropped && Date.now() < deadline) { await wait(50); dropped = await gone(); }
    check("  the provisioner connection the command opened is dropped before it returns (broker-side)", dropped, leaked);
    const creds = readFileSync(out, "utf8");
    const { principal, uids } = facts(creds);
    check("  the credential's grants name exactly one lifecycle uid", uids.length === 1 && principal !== undefined, { uids, principal });

    // ── 3. what the command printed is what the credential carries ────────────────────────────
    const printedUid = /^\s*Lifecycle:\s+(\S+)$/m.exec(r.out)?.[1];
    const printedPrincipal = /^\s*Principal:\s+(\S+)$/m.exec(r.out)?.[1];
    check("  it printed the lifecycle uid the grants are named for", printedUid === uids[0], { printedUid, uids });
    check("  it printed the principal stamped in the JWT", printedPrincipal === principal, { printedPrincipal, principal });

    const seenDm: CotalMessage[] = [];
    const seenAny: CotalMessage[] = [];
    const ep = new CotalEndpoint({
      space: SPACE, servers: broker.servers, creds, lifecycleUid: uids[0],
      card: { name: "board", kind: "agent", role: "board" }, channels: [], watchChannels: false,
      watchPresence: false, registerPresence: true,
    });
    ep.on("message", (m: CotalMessage, _d?: unknown, meta?: { kind?: string }) => {
      if (meta?.kind === "dm") seenDm.push(m);
      if (meta?.kind === "anycast") seenAny.push(m);
    });
    // Recorded, not thrown: a missing durable surfaces as an "error" event on the endpoint (a
    // permission refusal on the bind), and an unhandled one would crash the run before the cell
    // that names it. The cell reads both the throw and the events.
    const errors: string[] = [];
    ep.on("error", (e: Error) => void errors.push(e.message));
    let failure = "";
    try {
      await Promise.race([ep.start(), wait(15_000).then(() => { throw new Error("start hung 15s"); })]);
    } catch (e) {
      failure = (e as Error).message;
    }
    cleanup.push(() => ep.stop().catch(() => {}));
    check("  the consuming connect SUCCEEDS: dm inbox and svc_board queue were pre-created",
      failure === "" && errors.length === 0, { failure, errors });
    check("  the endpoint's wire id is the printed principal", ep.card.id === printedPrincipal, ep.card.id);

    await peer.unicast(ep.card.id, "task.update please");
    check("  a DM from another peer arrives on the minted identity's inbox",
      await until(() => seenDm.length === 1), seenDm.length);
    check("  the DM's from.id is the peer's principal (subject-verified, not the payload's word)",
      seenDm[0]?.from.id === peer.card.id, seenDm[0]?.from.id);
    await peer.anycast("board", "any board: hello");
    check("  an anycast to the role arrives on the role's task queue",
      await until(() => seenAny.length === 1), seenAny.length);
    // The identity is the mint's, end to end: the peer addressed the principal the command
    // derived at mint time, and the durable it consumed from is named for the uid it printed.
    check("  the principal is <owner>.<nkey> for this mint's identity",
      principalKey(DEV_OWNER, printedPrincipal!.split(".").slice(1).join(".")).key === printedPrincipal, printedPrincipal);
  }

  // ── 4. a SCOPED --provision stays scoped ────────────────────────────────────────────────────
  {
    // provisionAgent's `subscribe` defaults to `general` and must sit within the read ACL; a mint
    // that passed a scoped ACL without it would either widen the pre-created filter to general or
    // throw. The grant, the live read and the refused join are all read off the credential itself.
    const out = join(root, "scoped.creds");
    const r = await runMint(["scoped", "--profile", "agent", "--provision", "--allow-subscribe", "fix.x", "--allow-publish", "fix.x", "--out", out]);
    check("mint --provision --allow-subscribe fix.x succeeds", r.code === 0 && existsSync(out), r.out);
    const creds = readFileSync(out, "utf8");
    const { subAllow, uids } = facts(creds);
    check("  its live read grant names fix.x", subAllow.some((s) => /\.chat\.\*\.\*\.fix\.x$/.test(s)), subAllow);
    check("  and NOT general (the ACL was not widened to the launcher default)", !subAllow.some((s) => /\.chat\..*general/.test(s)), subAllow);
    const seen: CotalMessage[] = [];
    const errors: string[] = [];
    const ep = new CotalEndpoint({
      space: SPACE, servers: broker.servers, creds, lifecycleUid: uids[0],
      card: { name: "scoped", kind: "agent" }, channels: ["fix.x"], watchChannels: false,
      watchPresence: false, registerPresence: false,
    });
    ep.on("message", (m: CotalMessage) => void seen.push(m));
    ep.on("error", (e: Error) => void errors.push(e.message));
    await Promise.race([ep.start(), wait(15_000).then(() => { throw new Error("start hung 15s"); })]);
    cleanup.push(() => ep.stop().catch(() => {}));
    check("  a consuming connect on fix.x succeeds", errors.length === 0, errors);
    await peer.multicast("scoped: hello", { channel: "fix.x" });
    check("  a post on fix.x reaches it live", await until(() => seen.some((m) => m.channel === "fix.x")), seen.map((m) => m.channel));
    let joinErr = "";
    try { await ep.joinChannel("general"); } catch (e) { joinErr = (e as Error).message; }
    check("  and joining general is refused by the broker (not within its read ACL)", /not within this agent's read ACL/.test(joinErr), joinErr);
  }

  // ── 5. off the agent profile: refused, nothing written ──────────────────────────────────────
  {
    const out = join(root, "obs.creds");
    const r1 = await runMint(["obs", "--profile", "observer", "--provision", "--out", out]);
    check("--provision on the observer profile exits 1 with the reason", r1.code === 1 && /belong only to the agent profile/.test(r1.out), r1.out);
    check("  and mints nothing", !existsSync(out));
    const r2 = await runMint(["obs2", "--profile", "admin", "--role", "board", "--out", out]);
    check("--role on the admin profile exits 1 with the reason", r2.code === 1 && /belong only to the agent profile/.test(r2.out), r2.out);
    check("  and mints nothing", !existsSync(out));
    // Account-signing material is exported by `auth signer`, so `--signer` is no mint flag, and the
    // footprint flags must not slip past the signer export (an operator who typed --provision asked
    // for an identity, not a signer file).
    const signerOut = join(root, "signer.json");
    const r3 = await runMint(["obs5", "--signer", "--provision", "--role", "board", "--out", signerOut]);
    check("--signer on auth mint exits 1 as an unknown flag", r3.code === 1 && /Unknown option '--signer'/.test(r3.out), r3.out);
    check("  and writes no signer file", !existsSync(signerOut));
    const r3s = await runCotal(["auth", "signer", "--provision", "--role", "board", "--out", signerOut]);
    check("auth signer with --provision/--role exits 1 with the reason", r3s.code === 1 && /use auth signer --out <private-file>/.test(r3s.out), r3s.out);
    check("  and writes no signer file", !existsSync(signerOut));
    // No folder is created for signing material: a missing one is named, with the command that makes it.
    const missingFolder = join(root, "no-such-folder");
    const r3m = await runCotal(["auth", "signer", "--out", join(missingFolder, "signer.json")]);
    check("auth signer into a missing folder exits 2 TARGET_NOT_FOUND naming the folder and how to make it",
      r3m.code === 2 && /^\s*Code:\s+TARGET_NOT_FOUND$/m.test(r3m.out) && r3m.out.includes(`the --out folder ${missingFolder} does not exist; nothing was written`)
        && r3m.out.includes(`(umask 077 && mkdir -p ${missingFolder})`), r3m.out);
    check("  and creates nothing", !existsSync(missingFolder));
    // THE TWO ACL FLAGS, WHICH USED TO BE IGNORED HERE RATHER THAN REFUSED, AND THAT COST AN
    // OPERATOR A CREDENTIAL. `permissionsFor`'s observer/admin arm emits a FIXED read set over the
    // whole chat plane, and the command read `--allow-subscribe` only inside its agent branch. So
    // `--profile observer --allow-subscribe <one channel>` exited 0, printed a success line, and
    // handed out a reader of every channel in the space: an operator asking to NARROW got the
    // opposite, silently. Found by running the command and decoding the credential, not by reading
    // it. These cells are the refusal, on the same footing as `--role` and `--provision` above.
    const aclOut = join(root, "acl.creds");
    const r4 = await runMint(["obs3", "--profile", "observer", "--allow-subscribe", "events.local.UVICTIM", "--out", aclOut]);
    check("--allow-subscribe on the observer profile exits 1 with the reason", r4.code === 1 && /belong only to the agent profile/.test(r4.out), r4.out);
    check("  and mints nothing, rather than a credential that reads the whole chat plane", !existsSync(aclOut));
    const r5 = await runMint(["obs4", "--profile", "admin", "--allow-publish", "general", "--out", aclOut]);
    check("--allow-publish on the admin profile exits 1 with the reason", r5.code === 1 && /belong only to the agent profile/.test(r5.out), r5.out);
    check("  and mints nothing", !existsSync(aclOut));
    // THE CONTROL. Every cell above is satisfied by a command that refuses these flags outright,
    // which would break the scoped reader the manager's own refusal text tells an operator to mint.
    const okOut = join(root, "agentacl.creds");
    const r6 = await runMint(["ag1", "--profile", "agent", "--allow-subscribe", "events.local.UVICTIM", "--out", okOut]);
    check("the SAME flag on the agent profile is accepted, which is the form the manager's refusal prints",
      r6.code === 0 && existsSync(okOut), r6.out);
  }

  // ── 6. the wrong mesh, a FRESH open mesh, and a same-named mesh on another trust root ────────
  {
    // None of these connects anywhere (every recorded server is a dead port on purpose): each
    // refusal fires before a provisioner is minted, let alone connected.
    const OPEN = "sandbox";
    const openRoot = mkdtempSync(join(tmpdir(), "cotal-mint-prov-open-"));
    mkdirSync(join(openRoot, ".cotal"), { recursive: true }); // as `cotal up` (open) leaves it: a root, NO auth on disk
    recordMesh({ space: OPEN, server: "nats://127.0.0.1:1", root: openRoot, mode: "open", ts: new Date().toISOString(), origin: "manual" });
    cleanup.push(() => rmSync(openRoot, { recursive: true, force: true }));

    // From the main root, naming the other space: the root's auth and the target disagree.
    const out = join(root, "wrong.creds");
    const r = await runMint(["x", "--profile", "agent", "--provision", "--space", OPEN, "--out", out]);
    // `--space` moves the persona/ACL/signing/storage root, not just the broker, so this is two
    // roots whose authorities disagree rather than one root holding auth for another space. The
    // refusal must name BOTH roots, or it does not describe the mix it refuses to make.
    check("--provision naming a mesh on another trust root is refused as a conflict naming both roots",
      r.code === 2
        && /^\s*Code:\s+CONFLICT$/m.test(r.out)
        && /disagree about the signing authority/.test(r.out)
        && /^\s*Space:\s+sandbox$/m.test(r.out)
        && (r.out.includes(openRoot) || r.out.includes(canonicalRoot(openRoot)))
        && (r.out.includes(root) || r.out.includes(canonicalRoot(root))),
      r.out);
    check("  and mints nothing", !existsSync(out));

    // From the fresh open root: a space registered as open issues no credentials, so mint and signer
    // export refuse as unsupported and say so (not "run cotal up first" to an operator whose open mesh
    // is up, and not a missing-trust refusal that reads as something to supply).
    process.chdir(openRoot);
    const out2 = join(openRoot, "open.creds");
    const r2 = await runMint(["x", "--profile", "agent", "--provision", "--out", out2]);
    const signerDir = mkdtempSync(join(tmpdir(), "cotal-mint-prov-signer-"));
    cleanup.push(() => rmSync(signerDir, { recursive: true, force: true }));
    const signerOut = join(signerDir, "signer.json");
    const r2s = await runCotal(["auth", "signer", "--out", signerOut]);
    process.chdir(root);
    check("--provision on a registered open mesh is refused as unsupported, saying it issues no credentials",
      r2.code === 2 && /^\s*Code:\s+UNSUPPORTED$/m.test(r2.out) && /this space is open: it authenticates no one and issues no credentials, so nothing was minted/.test(r2.out), r2.out);
    check("  and does not say to run cotal up", !/cotal up/.test(r2.out), r2.out);
    check("  and mints nothing", !existsSync(out2));
    check("auth signer on a registered open mesh is refused as unsupported, saying it has no signer to export",
      r2s.code === 2 && /^\s*Code:\s+UNSUPPORTED$/m.test(r2s.out) && /this space is open: it issues no credentials, so it has no signing authority to export; nothing was written/.test(r2s.out) && !existsSync(signerOut), r2s.out);

    // Two roots that each ran `cotal up` for a space called "same": root B's mesh is the registered
    // one, root A holds its OWN, independently generated trust material for the same label. Minting
    // under B's key from A's folder would silently move the authority `cotal mint` takes from the
    // folder it runs in.
    //
    // mint resolves like spawn and personas now, so a `--provision` that names no mesh stays local
    // to A: it signs with A's own authority and stops at the preflight of the broker it dials. A's
    // own default server is 127.0.0.1:4222, which this suite does not own, so the cell names a port
    // it holds: a listener that closes every connection, so the preflight is refused there. Resolving B instead would be the cross-root conflict below, naming B. The
    // operator never named B, and spawn from A would not reach B either. Naming the two roots is the
    // job of the case where the operator DOES name it, which is asserted separately below. Both
    // directions must mint nothing.
    const SAME = "same";
    const rootA = mkdtempSync(join(tmpdir(), "cotal-mint-prov-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "cotal-mint-prov-b-"));
    for (const d of [rootA, rootB]) mkdirSync(join(d, ".cotal"), { recursive: true });
    saveSpaceAuth(authDir(rootA), await createSpaceAuth(SAME));
    saveSpaceAuth(authDir(rootB), await createSpaceAuth(SAME));
    recordMesh({ space: SAME, server: "nats://127.0.0.1:1", root: rootB, mode: "auth", ts: new Date().toISOString(), origin: "manual" });
    cleanup.push(() => { rmSync(rootA, { recursive: true, force: true }); rmSync(rootB, { recursive: true, force: true }); });
    const holder = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const held = `nats://127.0.0.1:${(holder.address() as AddressInfo).port}`;
    process.chdir(rootA);
    const out3 = join(rootA, "same.creds");
    const r3 = await runMint(["x", "--profile", "agent", "--provision", "--server", held, "--out", out3]);
    process.chdir(root);
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    check("--provision naming no mesh, from an unrecorded root, stays local and is refused at the preflight of the broker it dials",
      r3.code === 2 && /provisioning preflight/.test(r3.out) && /^\s*Space:\s+same$/m.test(r3.out) && !/CONFLICT/.test(r3.out) && !r3.out.includes(rootB), r3.out);
    check("  and mints nothing", !existsSync(out3));
    check("  and does not mint under the other root's authority", !r3.out.includes(rootB), r3.out);

    // Naming the other mesh IS the two-account case: the operator asked for B from A's folder, so
    // the refusal must name both roots rather than silently choosing one.
    process.chdir(rootA);
    const out4 = join(rootA, "same-named.creds");
    const r4 = await runMint(["x", "--profile", "agent", "--provision", "--space", SAME, "--out", out4]);
    process.chdir(root);
    check("--provision naming a same-named mesh on another trust root is refused as a conflict naming both roots",
      r4.code === 2
        && /^\s*Code:\s+CONFLICT$/m.test(r4.out)
        && (r4.out.includes(rootA) || r4.out.includes(canonicalRoot(rootA)))
        && (r4.out.includes(rootB) || r4.out.includes(canonicalRoot(rootB))),
      r4.out);
    check("  and mints nothing", !existsSync(out4));
  }

  // ── 7. --expires-in bounds the credential ─────────────────────────────────────────────────
  {
    // THE DEFAULT LIFETIME: a plain observer mint lasts 24 hours. The bounded cell below asks for a
    // different lifetime, so it cannot green against the default.
    const bareOut = join(root, "bare-obs.creds");
    const rb = await runMint(["bareobs", "--profile", "observer", "--out", bareOut]);
    const bare = existsSync(bareOut) ? credsClaims(readFileSync(bareOut, "utf8")) : undefined;
    const bareGap = typeof bare?.exp === "number" && typeof bare.iat === "number" ? bare.exp - bare.iat : undefined;
    check("a bare mint carries the 24-hour default lifetime",
      rb.code === 0 && bareGap !== undefined && bareGap <= 86_400 && bareGap >= 86_399 && /\(the 24-hour default\)/.test(rb.out), { out: rb.out, bare });
    check("  and writes no no-expiry record", !existsSync(`${bareOut}.no-expiry.json`));

    // --no-expiry: no exp at all, and the request recorded beside the file for doctor auth.
    const openOut = join(root, "open-obs.creds");
    const ro = await runMint(["openobs", "--profile", "observer", "--no-expiry", "--out", openOut]);
    const record = `${openOut}.no-expiry.json`;
    const recorded = existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) as { kind?: string; credsSha256?: string } : undefined;
    check("mint --no-expiry carries no exp and says so",
      ro.code === 0 && existsSync(openOut) && credsClaims(readFileSync(openOut, "utf8")).exp === undefined && ro.out.includes(`no expiry claim, as --no-expiry asked; recorded in ${record}`), ro.out);
    check("  and records the request beside the file, naming its bytes",
      recorded?.kind === "credential-no-expiry" && recorded.credsSha256 === createHash("sha256").update(readFileSync(openOut)).digest("hex") && (statSync(record).mode & 0o777) === 0o600, recorded);

    const out = join(root, "bounded-obs.creds");
    const before = Math.floor(Date.now() / 1000);
    const r = await runMint(["bounded", "--profile", "observer", "--expires-in", "3600", "--out", out]);
    const after = Math.floor(Date.now() / 1000);
    check("mint --expires-in 3600 succeeds", r.code === 0 && existsSync(out), r.out);
    const { exp, iat } = credsClaims(readFileSync(out, "utf8"));
    // `exp` and `iat` are two clock reads and cannot be one: `userValidDates` computes
    // `Math.floor(Date.now() / 1000) + ttl` and the JWT library then stamps
    // `claim.iat = Math.floor(Date.now() / 1000)` itself, overwriting anything a caller passes. When
    // those two reads straddle a second boundary the difference is `ttl - 1`, which is what CI read
    // on 2026-09-30: exp 1790768729, iat 1790765130, before 1790765129. So an exact equality asserts
    // a property the mint cannot provide, and reds at whatever rate the boundary falls between them.
    // One second is the whole mechanism (two floors of reads a few statements apart), so a wider
    // tolerance would hide a real second of latency inside the mint. The flag-was-honoured claim is
    // carried by the `before`/`after` bounds, which pin exp to the command's own execution window and
    // would fail against any default from the lifetime matrix.
    const gap = typeof exp === "number" && typeof iat === "number" ? exp - iat : undefined;
    check("  the JWT's exp is iat + the flag, computed within the command's own second",
      gap !== undefined && gap <= 3600 && gap >= 3599 && exp! >= before + 3600 && exp! <= after + 3600,
      { exp, iat, gap, before, after });
    // --provision rides the same lifetime through the seam (the durable mint is bounded too). A label
    // is one owner token, so it carries no '-'.
    const pout = join(root, "bounded-agent.creds");
    const rp = await runMint(["bounded_agent", "--profile", "agent", "--provision", "--expires-in", "3600", "--out", pout]);
    check("mint --provision --expires-in succeeds and bounds the provisioned credential too",
      rp.code === 0 && existsSync(pout) && credsClaims(readFileSync(pout, "utf8")).exp !== undefined, rp.out);
  }

  // ── 8. --identity re-mints for the SAME nkey ──────────────────────────────────────────────
  {
    // The durable half of the issue: two plain mints churn the principal; --identity must not.
    const first = join(root, "id-first.creds");
    const r1 = await runMint(["idfirst", "--profile", "observer", "--out", first]);
    check("the first plain mint succeeds", r1.code === 0 && existsSync(first), r1.out);
    const sub1 = credsClaims(readFileSync(first, "utf8")).sub;

    const second = join(root, "id-second.creds");
    const r2 = await runMint(["idsecond", "--profile", "observer", "--out", second]);
    const sub2 = credsClaims(readFileSync(second, "utf8")).sub;
    check("  the control: a second plain mint is a DIFFERENT principal (the churn the flag removes)",
      r2.code === 0 && sub2 !== sub1, { sub1, sub2 });

    const remint = join(root, "id-remint.creds");
    const r3 = await runMint(["idremint", "--profile", "observer", "--identity", first, "--expires-in", "3600", "--out", remint]);
    check("re-mint --identity <creds> succeeds", r3.code === 0 && existsSync(remint), r3.out);
    const claims3 = credsClaims(readFileSync(remint, "utf8"));
    check("  the re-minted credential's principal IS the original's (same nkey, so every durable keyed to it survives)",
      claims3.sub === sub1, { sub1, sub3: claims3.sub });
    check("  and it is bounded, so the renewal seam's own remedy now has a CLI form",
      typeof claims3.exp === "number" && claims3.exp > (claims3.iat ?? 0), claims3);
  }

  // ── 9. the refusals ───────────────────────────────────────────────────────────────────────
  {
    const out = join(root, "refused.creds");
    const r1 = await runMint(["x", "--profile", "observer", "--expires-in", "3600", "--expires-at", "2000000000", "--out", out]);
    check("--expires-in with --expires-at exits 1 with the reason", r1.code === 1 && /choose --expires-in or --expires-at, not both/.test(r1.out), r1.out);
    check("  and mints nothing", !existsSync(out));
    // A label or role the grammar does not take is a value refusal: it names the character, the value
    // and the characters allowed, with its own Next and no command help, in text and in JSON.
    const labelTakes = "a label takes only letters, digits and _";
    for (const [words, said, next] of [
      [["p-agent"], `the credential label "p-agent" has "-", which a label cannot hold; ${labelTakes}`, "use letters, digits and _ only, such as p_agent"],
      [["team.lead"], `the credential label "team.lead" has ".", which a label cannot hold; ${labelTakes}`, "use letters, digits and _ only, such as team_lead"],
      [["a\nb"], `the credential label "a\\u000ab" has "\\u000a", which a label cannot hold; ${labelTakes}`, "use letters, digits and _ only, such as a_b"],
      [[""], "the credential label is empty; a label takes letters, digits and _", "use letters, digits and _ only"],
      [["ok1", "--role", "bad role!"], `the --role "bad role!" has " ", which a role cannot hold; a role takes only letters, digits, _ and -`, "use letters, digits, _ and - only, such as bad_role_"],
    ] as const) {
      const text = await runMint([...words, "--out", out]);
      check(`auth mint ${JSON.stringify(words)} names the character and the characters allowed, with its Next and no help`,
        text.code === 1 && text.out.includes(`✗ ${said}\n  ${next}\n`) && !/^Usage$/m.test(text.out) && !existsSync(out), text.out);
      const json = await runMint([...words, "--out", out, "--json"]);
      let envelope: { error?: { code?: string; message?: string; remedy?: string } } = {};
      try { envelope = JSON.parse(json.out); } catch { /* not one envelope; the check below shows it */ }
      check("  and --json carries the same message and Next", json.code === 1 && envelope.error?.code === "USAGE_INVALID" && envelope.error.message === said && envelope.error.remedy === next && !existsSync(out), json.out);
    }
    for (const flag of [["--expires-in", "3600"], ["--expires-at", "2000000000"]]) {
      const r = await runMint(["x", "--profile", "observer", "--no-expiry", ...flag, "--out", out]);
      check(`--no-expiry with ${flag[0]} exits 1 with the reason and mints nothing`, r.code === 1 && /--no-expiry issues a credential with no expiry, so it takes no --expires-in or --expires-at/.test(r.out) && !existsSync(out) && !existsSync(`${out}.no-expiry.json`), r.out);
    }
    // A past or present expiry used to write a credential the broker already refuses.
    for (const at of ["1", String(Math.floor(Date.now() / 1000))]) {
      const r = await runMint(["x", "--profile", "observer", "--expires-at", at, "--out", out]);
      check(`--expires-at ${at === "1" ? "in the past" : "now"} exits 1 with the reason and mints nothing`, r.code === 1 && /--expires-at is not in the future/.test(r.out) && !existsSync(out), r.out);
    }
    // An expiry no date can show used to mint, and every use then overflowed a client timer.
    for (const flags of [["--expires-in", "99999999999999"], ["--expires-at", "8640000000001"]]) {
      const r = await runMint(["x", "--profile", "observer", ...flags, "--out", out]);
      check(`${flags[0]} past the last representable date exits 1 with the reason and mints nothing`,
        r.code === 1 && /the credential would expire after \+275760-09-13T00:00:00\.000Z, the last date Cotal can represent; nothing was written/.test(r.out) && !existsSync(out), r.out);
    }
    for (const bad of ["0", "-5", "1.5", "abc"]) {
      // A leading-dash value needs the `=` form to get past parseArgs' strict token parser; the
      // point is that it reaches THE COMMAND's validation and is refused there. The refusal does not
      // echo the value, so a single digit such as 0 is not looked for in the output.
      const r = await runMint(["x", "--profile", "observer", bad.startsWith("-") ? `--expires-in=${bad}` : "--expires-in", ...(bad.startsWith("-") ? [] : [bad]), "--out", out]);
      check(`--expires-in ${bad} exits 1 without echoing the value (a TTL the seam would refuse)`,
        r.code === 1 && /credential expiry needs an integer in native seconds; the supplied value was not echoed/.test(r.out)
          && (bad.length === 1 || !r.out.includes(bad)), r.out);
      check("  and mints nothing", !existsSync(out));
    }
    // Private, so the protected-reference check passes and the refusal is about the contents.
    const noSeed = join(root, "no-seed.txt");
    writeFileSync(noSeed, "just some text, no creds structure at all\n", { mode: 0o600 });
    const r2 = await runMint(["x", "--profile", "observer", "--identity", noSeed, "--out", out]);
    check("--identity on a file with no seed exits 1 refusing it without printing its contents",
      r2.code === 1 && /no matching native JWT subject and user nkey seed/.test(r2.out) && !r2.out.includes("just some text"), r2.out);
    check("  and mints nothing", !existsSync(out));
    const r3 = await runMint(["x", "--profile", "observer", "--identity", join(root, "missing.creds"), "--out", out]);
    check("--identity on a missing path is refused before anything is read, naming it",
      r3.code === 2 && r3.out.includes(`the referenced credential ${join(root, "missing.creds")} does not exist`), r3.out);
    check("  and mints nothing", !existsSync(out));
    // An --out folder that cannot hold the credential is named, with the cause and the step.
    const real = join(root, "out-real"), link = join(root, "out-link");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, link);
    const linked = await runMint(["x", "--profile", "observer", "--out", join(link, "sub", "x.creds")]);
    check("--out through a symbolic link exits 2 PERMISSION_DENIED, naming the link, where it points and the path without it",
      linked.code === 2 && /^\s*Code:\s+PERMISSION_DENIED$/m.test(linked.out) && linked.out.includes(`the --out path goes through ${link}, a symbolic link to ${real}`)
        && linked.out.includes(`such as ${join(real, "sub", "x.creds")} if that folder is yours`), linked.out);
    check("  and creates nothing through the link", readdirSync(real).length === 0);
    const file = join(root, "out-file");
    writeFileSync(file, "", { mode: 0o600 });
    const notFolder = await runMint(["x", "--profile", "observer", "--out", join(file, "x.creds")]);
    check("--out through a file exits 1, naming the file that is not a folder",
      notFolder.code === 1 && notFolder.out.includes(`the --out path goes through ${file}, which is not a folder; no credential was written`), notFolder.out);
    // An account that bypasses folder permissions cannot be refused this way.
    if (process.getuid?.() !== 0) {
      const locked = join(root, "out-locked");
      mkdirSync(locked, { mode: 0o500 });
      const noAccess = await runMint(["x", "--profile", "observer", "--out", join(locked, "sub", "x.creds")]);
      chmodSync(locked, 0o700);
      check("--out under a folder this account cannot create in exits 2 PERMISSION_DENIED, naming the folder",
        noAccess.code === 2 && /^\s*Code:\s+PERMISSION_DENIED$/m.test(noAccess.out) && noAccess.out.includes(`the --out folder ${join(locked, "sub")} could not be reached or made by this account (EACCES)`), noAccess.out);
      check("  and creates nothing there", readdirSync(locked).length === 0);
    }
  }

  // ── 10. --replace: an expired or unbounded label's standing credential ─────────────────────
  {
    const standing = (label: string) => agentSecretFilePaths(root, SPACE, label).creds;
    const short = await runMint(["kurz", "--expires-in", "1"]);
    check("a label minted to expire in a second", short.code === 0 && existsSync(standing("kurz")), short.out);
    await wait(2_100);
    const taken = await runMint(["kurz"]);
    check("minting that label again refuses CONFLICT and names --replace",
      taken.code === 2 && /^\s*Code:\s+CONFLICT$/m.test(taken.out) && taken.out.includes("replace it with --replace once it has expired, if it has no expiry or if its key was revoked"), taken.out);
    const expired = readFileSync(standing("kurz"), "utf8");
    const swapped = await runMint(["kurz", "--replace", "--expires-in", "3600"]);
    const fresh = credsClaims(readFileSync(standing("kurz"), "utf8"));
    check("--replace swaps the expired standing credential for a valid one and says what it replaced, with its key",
      swapped.code === 0 && new RegExp(`^\\s*Replaced:\\s+a credential that expired at \\S+Z, key ${credsClaims(expired).sub}$`, "m").test(swapped.out) && readFileSync(standing("kurz"), "utf8") !== expired && typeof fresh.exp === "number" && fresh.exp * 1000 > Date.now(), swapped.out);
    check("  and warns of no copy, since an expired credential no longer connects", !swapped.out.includes("stays valid until"), swapped.out);
    const kept = readFileSync(standing("kurz"), "utf8");
    const live = await runMint(["kurz", "--replace"]);
    check("--replace on a still-valid credential refuses CONFLICT, naming its expiry",
      live.code === 2 && /^\s*Code:\s+CONFLICT$/m.test(live.out) && /the standing credential "kurz" is valid until \S+Z, so --replace left it in place/.test(live.out), live.out);
    check("  and leaves it as it was", readFileSync(standing("kurz"), "utf8") === kept);
    const unbounded = await runMint(["ewig", "--no-expiry"]);
    const record = `${standing("ewig")}.no-expiry.json`;
    check("a label minted with --no-expiry records the request", unbounded.code === 0 && existsSync(record), unbounded.out);
    const ewig = credsClaims(readFileSync(standing("ewig"), "utf8")).sub;
    const bounded = await runMint(["ewig", "--replace"]);
    check("--replace bounds the unbounded credential with the 24-hour default, naming the key it replaced",
      bounded.code === 0 && bounded.out.split("\n").some((line) => /^\s*Replaced:\s+a credential with no expiry claim, key /.test(line) && line.endsWith(`key ${ewig}`)) && typeof credsClaims(readFileSync(standing("ewig"), "utf8")).exp === "number", bounded.out);
    check("  and removes the no-expiry record, which named the bytes it replaced", !existsSync(record));
    check("  and warns that a copy of the replaced credential stays valid, naming the revocation that stops it",
      bounded.out.includes(`! the credential this replaced has no expiry claim, so a copy of it stays valid until its key ${ewig} is revoked; to stop it, run cotal down --yes, then cotal auth revoke-credential ${ewig} --yes, then cotal up`), bounded.out);
    await runMint(["ewig2", "--no-expiry"]);
    const ewig2 = credsClaims(readFileSync(standing("ewig2"), "utf8")).sub;
    const boundedJson = await runMint(["ewig2", "--replace", "--json"]);
    const replacedEnvelope = JSON.parse(boundedJson.out.split("\n").find((text) => text.startsWith('{"schemaVersion"')) ?? "{}") as { result?: { replaced?: { state?: string; publicKey?: string } }; warnings?: { code: string; target: { publicKey?: string } }[] };
    check("  --json reports the replaced key, and the warning with that key as its target",
      boundedJson.code === 0 && replacedEnvelope.result?.replaced?.state === "unbounded" && replacedEnvelope.result.replaced.publicKey === ewig2
        && replacedEnvelope.warnings?.length === 1 && replacedEnvelope.warnings[0]!.code === "REPLACED_CREDENTIAL_VALID" && replacedEnvelope.warnings[0]!.target.publicKey === ewig2, boundedJson.out);
    const out = join(root, "replace-out.creds");
    const withOut = await runMint(["kurz", "--replace", "--out", out]);
    check("--replace with --out exits 1 with the reason and writes nothing",
      withOut.code === 1 && /--replace replaces the label's standing credential, so it takes no --out/.test(withOut.out) && !existsSync(out), withOut.out);
    // --profile defaults to agent, so the receipt says when a replacement has another profile.
    await runMint(["blick", "--profile", "observer", "--no-expiry"]);
    const changedProfile = await runMint(["blick", "--replace"]);
    check("--replace of an observer credential without --profile observer warns that the profile changed",
      changedProfile.code === 0 && changedProfile.out.includes("! the credential this replaced was minted with --profile observer, and this one with --profile agent, so it holds that profile's grants instead"), changedProfile.out);
    await runMint(["blick2", "--profile", "observer", "--no-expiry"]);
    const sameProfile = await runMint(["blick2", "--replace", "--profile", "observer"]);
    check("  and warns no change when it names --profile observer again", sameProfile.code === 0 && !sameProfile.out.includes("minted with --profile"), sameProfile.out);
    const unreplaced = await runMint(["neu", "--replace"]);
    check("--replace on a label with no standing credential mints one and warns that it replaced nothing",
      unreplaced.code === 0 && unreplaced.out.includes('! --replace found no standing credential named "neu", so this is a new standing credential and it replaced nothing') && existsSync(standing("neu")), unreplaced.out);
  }

  // ── 11. --identity keeps an agent credential's grants; doctor auth lists each --out file ─────
  {
    type Envelope = { result?: { grants?: unknown; exported?: { path: string; state: string; repair: string | null }[] | null }; warnings?: { code: string; message: string }[] };
    const envelope = (out: string): Envelope => {
      const line = out.split("\n").find((text) => text.startsWith('{"schemaVersion"'));
      try { return line ? JSON.parse(line) as Envelope : {}; } catch { return {}; }
    };
    // The credential's channel rows and TASK role row, which the grants are minted into.
    const grantRows = (path: string) => {
      const nats = credsClaims(readFileSync(path, "utf8")).nats;
      return [...(nats?.pub?.allow ?? []), ...(nats?.sub?.allow ?? [])].filter((row) => row.startsWith("cotal.") && row.includes(".chat.") || row.includes(".svc_")).sort();
    };
    const first = join(root, "grants-first.creds"), again = join(root, "grants-again.creds"), other = join(root, "grants-other.creds");
    const minted = await runMint(["grants", "--allow-subscribe", "general", "--allow-publish", "general", "--role", "board", "--expires-in", "1", "--out", first, "--json"]);
    check("an agent mint's JSON lists its grants",
      minted.code === 0 && JSON.stringify(envelope(minted.out).result?.grants) === JSON.stringify({ read: ["general"], post: ["general"], role: "board", fromIdentity: [] }), minted.out);
    const carried = await runMint(["grants", "--identity", first, "--out", again, "--json"]);
    check("a re-mint with --identity and no grant flag keeps the read, post and role grants and names them carried",
      carried.code === 0 && JSON.stringify(envelope(carried.out).result?.grants) === JSON.stringify({ read: ["general"], post: ["general"], role: "board", fromIdentity: ["read", "post", "role"] }), carried.out);
    check("  and the new credential holds the same channel and role rows", grantRows(again).length > 2 && JSON.stringify(grantRows(again)) === JSON.stringify(grantRows(first)), { first: grantRows(first), again: grantRows(again) });
    const flagged = await runMint(["grants", "--identity", first, "--allow-publish", "ops", "--out", other]);
    check("a grant flag replaces only its own grant, and the receipt marks the carried ones",
      flagged.code === 0 && /^\s*May read:\s+general \(carried from --identity\)$/m.test(flagged.out) && /^\s*May post:\s+ops$/m.test(flagged.out) && /^\s*Role:\s+board \(carried from --identity\)$/m.test(flagged.out), flagged.out);
    await wait(2100);
    const expired = await runCotal(["doctor", "auth", "--space", SPACE, "--json"]);
    const rows = envelope(expired.out).result?.exported ?? [];
    const row = rows.find((entry) => entry.path === first);
    check("doctor auth lists the files auth mint --out wrote, each with its state",
      row?.state === "expired" && rows.some((entry) => entry.path === again && entry.state === "healthy") && rows.some((entry) => entry.path === other), rows);
    check("  an expired one is a warning, and its repair mints the same key into the same file",
      row?.repair?.includes(`auth mint grants --identity ${first} --out ${first}\``) === true && envelope(expired.out).warnings?.some((warning) => warning.code === "EXPORTED_CREDENTIAL_EXPIRED" && warning.message.includes(first)) === true, { row, warnings: envelope(expired.out).warnings });
    const renewed = await runMint(["grants", "--identity", first, "--out", first]);
    const after = envelope((await runCotal(["doctor", "auth", "--space", SPACE, "--json"])).out).result?.exported ?? [];
    check("  following it renews the file with its grants, and doctor then reads it healthy",
      renewed.code === 0 && JSON.stringify(grantRows(first)) === JSON.stringify(grantRows(again)) && after.find((entry) => entry.path === first)?.state === "healthy", { renewed: renewed.out, after });
    // The label has only --out files, so --replace has no standing credential to replace.
    const exportedOnly = await runMint(["grants", "--replace", "--json"]);
    const nothing = envelope(exportedOnly.out).warnings?.find((warning) => warning.code === "NOTHING_REPLACED")?.message ?? "";
    check("--replace on a label with only --out files warns that it replaced nothing, naming each file and the mint that signs its key again",
      exportedOnly.code === 0 && [first, again, other].every((path) => nothing.includes(`the file auth mint --out wrote for this label at ${path} is unchanged, and cotal auth mint grants --identity ${path} --out ${path} signs its key again`)), exportedOnly.out);
  }

  console.log(`\nMINT-PROVISION SMOKE OK ✅  (${pass} passed)`);
} finally {
  for (const fn of cleanup.reverse()) await fn();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
