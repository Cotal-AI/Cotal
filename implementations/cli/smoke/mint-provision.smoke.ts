/**
 * `cotal mint --provision`: an out-of-band identity that can CONSUME, not only publish.
 *
 * On an authed mesh the DM and TASK consumers are provisioner-pre-created and bind-only (SPEC
 * section 9), so a credential minted with `cotal mint` alone can publish within its post ACL but
 * its first consuming connect dies on the broker's "consumer not found" — measured live before
 * this flag existed. `--provision` performs the same pre-create `cotal spawn` does for its seats,
 * from a provisioner cred that is minted, used and dropped inside the command.
 *
 *   1. mint WITHOUT --provision, connect with consume on   → start fails on the missing inbox
 *      (the repro, kept as the negative control so cell 2 cannot green vacuously)
 *   2. mint WITH --provision --role board, connect          → starts; a DM from another peer arrives;
 *      an anycast to the role arrives on the svc_board queue; the provisioner connection the
 *      command opened is gone before it returns
 *   3. the command prints the principal and the lifecycle uid the credential actually carries
 *   4. --provision --allow-subscribe fix.x                  → the read grant is fix.x and NOT general
 *      (the pre-created filter rides the ACL, never widened to the launcher default), and the
 *      identity reads fix.x live but cannot join general
 *   5. --provision / --role / --allow-subscribe / --allow-publish off the agent profile, and the
 *      footprint flags with --signer → exit 1, one sentence, nothing written; and the control that
 *      the same ACL flag on the agent profile still works
 *   6. --provision from a root whose auth is for another space; from a FRESH open root (no auth on
 *      disk, as `cotal up` leaves one); from a root holding its OWN auth for a mesh of the same
 *      name that runs on another trust root → exit 1 each, naming why, nothing minted
 *   7. --expires-in bounds the credential: the JWT's exp is iat + the flag, within a second; a
 *      bare mint carries no exp (the unbounded default, kept)
 *   8. --identity <creds> re-mints for the SAME nkey: the new credential's principal equals the
 *      original's; the seed file is read by core's own loader
 *   9. the refusals: both lifetime flags at once; --expires-in the seam would refuse (0, negative,
 *      fractional); --identity on a file with no seed; --identity with a missing path → exit 1
 *      each, one sentence, nothing written
 *
 * Every cell dispatches real argv through `runCli` (the binary's entry: spec parsing, then the
 * registered runner), never a hand-built ParsedArgs.
 * OS-assigned loopback port; needs `nats-server` on PATH.
 * Run: pnpm smoke:mint-provision:auth
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "cotal-mint-prov-home-"));
process.env.COTAL_HOME = home;
process.env.COTAL_NO_PROMPT = "1";

// The composition root, exactly as the binary imports it (registers the command surface).
await import("../src/index.js");
const {
  CotalEndpoint, createSpaceAuth, jwtFromCreds, mintCreds, newIdentity, setupSpaceStreams,
  seedChannelRegistry, provisionAgent, mintLifecycleUid, principalKey, DEV_OWNER, registry,
} = await import("@cotal-ai/core");
type CotalMessage = import("@cotal-ai/core").CotalMessage;
const { authDir, canonicalRoot, saveSpaceAuth, recordMesh } = await import("@cotal-ai/workspace");
const { credsClaims } = await import("@cotal-ai/core");
const { runCli } = await import("../src/command.js");
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

/** Run `cotal mint <argv…>` in-process THROUGH THE BINARY'S DISPATCH (`runCli`: the command's declared
 *  flag specs parse the argv, then its registered runner runs): captured output, the exit code the
 *  operator would get. The first `process.exit` wins (the dispatcher re-exits after a refusal). */
class ExitSignal extends Error {}
async function runMint(argv: string[]): Promise<{ out: string; code: number }> {
  const lines: string[] = [];
  const [log, err, exit] = [console.log, console.error, process.exit];
  let code: number | undefined;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  process.exit = ((c?: number) => { code ??= c ?? 0; throw new ExitSignal(`exit ${c ?? 0}`); }) as never;
  try {
    await runCli(registry, ["mint", ...argv]);
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
  } finally {
    console.log = log; console.error = err; process.exit = exit;
  }
  code ??= 0;
  // Colour codes stripped: the cells below read values off the lines, not decoration.
  return { out: lines.join("\n").replace(/\x1b\[[0-9;]*m/g, ""), code };
}

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
  process.chdir(root); // `mint` finds the root's `.cotal/` by walking up from cwd, like the binary
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
    check("  and says the credential cannot consume until provisioned", /--provision/.test(r.out), r.out);
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
    check("  it says so", /provisioned its durables/.test(r.out), r.out);
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
    const printedUid = /lifecycle uid:\s+(\S+)/.exec(r.out)?.[1];
    const printedPrincipal = /principal:\s+(\S+)/.exec(r.out)?.[1];
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
    check("--provision on the observer profile exits 1 with the reason", r1.code === 1 && /agent profile only/.test(r1.out), r1.out);
    check("  and mints nothing", !existsSync(out));
    const r2 = await runMint(["obs2", "--profile", "admin", "--role", "board", "--out", out]);
    check("--role on the admin profile exits 1 with the reason", r2.code === 1 && /agent profile only/.test(r2.out), r2.out);
    check("  and mints nothing", !existsSync(out));
    // `--signer` returns early with account-signing material; the footprint flags must not slip past
    // it (an operator who typed --provision asked for an identity, not a signer file).
    const signerOut = join(root, "signer.json");
    const r3 = await runMint(["--signer", "--provision", "--role", "board", "--out", signerOut]);
    check("--signer with --provision/--role exits 1 with the reason", r3.code === 1 && /agent profile only.*--signer/.test(r3.out), r3.out);
    check("  and writes no signer file", !existsSync(signerOut));
    // THE TWO ACL FLAGS, WHICH USED TO BE IGNORED HERE RATHER THAN REFUSED, AND THAT COST AN
    // OPERATOR A CREDENTIAL. `permissionsFor`'s observer/admin arm emits a FIXED read set over the
    // whole chat plane, and the command read `--allow-subscribe` only inside its agent branch. So
    // `--profile observer --allow-subscribe <one channel>` exited 0, printed a success line, and
    // handed out a reader of every channel in the space: an operator asking to NARROW got the
    // opposite, silently. Found by running the command and decoding the credential, not by reading
    // it. These cells are the refusal, on the same footing as `--role` and `--provision` above.
    const aclOut = join(root, "acl.creds");
    const r4 = await runMint(["obs3", "--profile", "observer", "--allow-subscribe", "events.local.UVICTIM", "--out", aclOut]);
    check("--allow-subscribe on the observer profile exits 1 with the reason", r4.code === 1 && /agent profile only/.test(r4.out), r4.out);
    check("  and mints nothing, rather than a credential that reads the whole chat plane", !existsSync(aclOut));
    const r5 = await runMint(["obs4", "--profile", "admin", "--allow-publish", "general", "--out", aclOut]);
    check("--allow-publish on the admin profile exits 1 with the reason", r5.code === 1 && /agent profile only/.test(r5.out), r5.out);
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
    // refusal must name BOTH roots and BOTH authorities, or it does not describe the mix it
    // refuses to make.
    check("--provision naming a mesh on another trust root exits 1 naming both roots and both authorities",
      r.code === 1
        && /authorities disagree/.test(r.out)
        && (r.out.includes(openRoot) || r.out.includes(canonicalRoot(openRoot)))
        && (r.out.includes(root) || r.out.includes(canonicalRoot(root)))
        && /sandbox\/no-account/.test(r.out)
        && /main\//.test(r.out),
      r.out);
    check("  and mints nothing", !existsSync(out));

    // From the fresh open root: the mode itself is the refusal, said as such (not "run cotal up first"
    // to an operator whose open mesh is up).
    process.chdir(openRoot);
    const out2 = join(openRoot, "open.creds");
    const r2 = await runMint(["x", "--profile", "agent", "--provision", "--out", out2]);
    process.chdir(root);
    check("--provision on a fresh open mesh (no auth on disk) exits 1 naming why (peers self-create there)", r2.code === 1 && /open mesh/.test(r2.out), r2.out);
    check("  and does not say to run cotal up", !/run `cotal up` first/.test(r2.out), r2.out);
    check("  and mints nothing", !existsSync(out2));

    // Two roots that each ran `cotal up` for a space called "same": root B's mesh is the registered
    // one, root A holds its OWN, independently generated trust material for the same label. Minting
    // under B's key from A's folder would silently move the authority `cotal mint` takes from the
    // folder it runs in.
    //
    // mint resolves like spawn and personas now, so a BARE `--provision` names no other mesh and
    // stays local to A: it reaches A's own default server and stops there. The operator never named
    // B, and spawn from A would not reach B either. Naming the two accounts is the job of the case
    // where the operator DOES name it, which is asserted separately below. Both directions must
    // mint nothing.
    const SAME = "same";
    const rootA = mkdtempSync(join(tmpdir(), "cotal-mint-prov-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "cotal-mint-prov-b-"));
    for (const d of [rootA, rootB]) mkdirSync(join(d, ".cotal"), { recursive: true });
    saveSpaceAuth(authDir(rootA), await createSpaceAuth(SAME));
    saveSpaceAuth(authDir(rootB), await createSpaceAuth(SAME));
    recordMesh({ space: SAME, server: "nats://127.0.0.1:1", root: rootB, mode: "auth", ts: new Date().toISOString(), origin: "manual" });
    cleanup.push(() => { rmSync(rootA, { recursive: true, force: true }); rmSync(rootB, { recursive: true, force: true }); });
    process.chdir(rootA);
    const out3 = join(rootA, "same.creds");
    const r3 = await runMint(["x", "--profile", "agent", "--provision", "--out", out3]);
    process.chdir(root);
    check("bare --provision from an unrecorded root stays local and exits 1 without reaching the other mesh",
      r3.code === 1 && /no mesh running at nats:\/\/127\.0\.0\.1:4222/.test(r3.out) && /mesh "same" is recorded at/.test(r3.out) && (r3.out.includes(rootA) || r3.out.includes(canonicalRoot(rootA))) && /not running/.test(r3.out) && !r3.out.includes(rootB), r3.out);
    check("  and mints nothing", !existsSync(out3));
    check("  and does not mint under the other root's authority", !r3.out.includes(rootB), r3.out);

    // Naming the other mesh IS the two-account case: the operator asked for B from A's folder, so
    // the refusal must name both roots and both authorities rather than silently choosing one.
    process.chdir(rootA);
    const out4 = join(rootA, "same-named.creds");
    const r4 = await runMint(["x", "--profile", "agent", "--provision", "--space", SAME, "--out", out4]);
    process.chdir(root);
    check("--provision naming a same-named mesh on another trust root exits 1 naming both roots and both authorities",
      r4.code === 1
        && /authorities disagree/.test(r4.out)
        && (r4.out.includes(rootA) || r4.out.includes(canonicalRoot(rootA)))
        && (r4.out.includes(rootB) || r4.out.includes(canonicalRoot(rootB))),
      r4.out);
    check("  and mints nothing", !existsSync(out4));
  }

  // ── 7. --expires-in bounds the credential ─────────────────────────────────────────────────
  {
    // THE UNBOUNDED DEFAULT, KEPT (the repro half 1): a plain observer mint carries no exp at all,
    // so the bounded cell below cannot green vacuously against a matrix that bounds everything.
    const bareOut = join(root, "bare-obs.creds");
    const rb = await runMint(["bareobs", "--profile", "observer", "--out", bareOut]);
    check("a bare mint stays unbounded (no exp in the JWT - the default, not the fix's business)",
      rb.code === 0 && existsSync(bareOut) && credsClaims(readFileSync(bareOut, "utf8")).exp === undefined, rb.out);

    const out = join(root, "bounded-obs.creds");
    const before = Math.floor(Date.now() / 1000);
    const r = await runMint(["bounded", "--profile", "observer", "--expires-in", "3600", "--out", out]);
    const after = Math.floor(Date.now() / 1000);
    check("mint --expires-in 3600 succeeds", r.code === 0 && existsSync(out), r.out);
    const { exp, iat } = credsClaims(readFileSync(out, "utf8"));
    check("  the JWT's exp is iat + the flag, computed within the command's own second",
      typeof exp === "number" && typeof iat === "number" && exp === iat + 3600 && exp >= before + 3600 && exp <= after + 3600,
      { exp, iat, before, after });
    // --provision rides the same lifetime through the seam (the durable mint is bounded too).
    const pout = join(root, "bounded-agent.creds");
    const rp = await runMint(["bounded-agent", "--profile", "agent", "--provision", "--expires-in", "3600", "--out", pout]);
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
    check("--expires-in with --expires-at exits 1 with the reason", r1.code === 1 && /mutually exclusive/.test(r1.out), r1.out);
    check("  and mints nothing", !existsSync(out));
    for (const bad of ["0", "-5", "1.5", "abc"]) {
      // A leading-dash value needs the `=` form to get past parseArgs' strict token parser; the
      // point is that it reaches THE COMMAND's validation and is refused there, naming the value.
      const r = await runMint(["x", "--profile", "observer", bad.startsWith("-") ? `--expires-in=${bad}` : "--expires-in", ...(bad.startsWith("-") ? [] : [bad]), "--out", out]);
      check(`--expires-in ${bad} exits 1 naming the value (a TTL the seam would refuse)`,
        r.code === 1 && new RegExp(`--expires-in must be a positive integer.*${bad === "abc" ? "abc" : bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(r.out), r.out);
      check("  and mints nothing", !existsSync(out));
    }
    const noSeed = join(root, "no-seed.txt");
    writeFileSync(noSeed, "just some text, no creds structure at all\n");
    const r2 = await runMint(["x", "--profile", "observer", "--identity", noSeed, "--out", out]);
    check("--identity on a file with no seed exits 1 refusing it BY NAME",
      r2.code === 1 && /no user nkey seed/.test(r2.out) && r2.out.includes(noSeed), r2.out);
    check("  and mints nothing", !existsSync(out));
    const r3 = await runMint(["x", "--profile", "observer", "--identity", join(root, "missing.creds"), "--out", out]);
    check("--identity on a missing path exits 1 naming it", r3.code === 1 && /not found/.test(r3.out) && r3.out.includes("missing.creds"), r3.out);
    check("  and mints nothing", !existsSync(out));
  }

  console.log(`\nMINT-PROVISION SMOKE OK ✅  (${pass} passed)`);
} finally {
  for (const fn of cleanup.reverse()) await fn();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
