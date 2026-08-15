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
 *      an anycast to the role arrives on the svc_board queue
 *   3. the command prints the principal and the lifecycle uid the credential actually carries
 *   4. --provision / --role off the agent profile           → exit 1, one sentence, nothing minted
 *   5. --provision on an OPEN mesh                          → exit 1, names why (nothing to provision)
 *
 * OS-assigned loopback port; needs `nats-server` on PATH.
 * Run: pnpm smoke:mint-provision:auth
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "cotal-mint-prov-home-"));
process.env.COTAL_HOME = home;
process.env.COTAL_NO_PROMPT = "1";

// The composition root, exactly as the binary imports it (registers the command surface).
await import("../src/index.js");
const {
  CotalEndpoint, createSpaceAuth, jwtFromCreds, mintCreds, newIdentity, setupSpaceStreams,
  seedChannelRegistry, provisionAgent, mintLifecycleUid, principalKey, DEV_OWNER,
} = await import("@cotal-ai/core");
type CotalMessage = import("@cotal-ai/core").CotalMessage;
const { authDir, saveSpaceAuth, recordMesh } = await import("@cotal-ai/workspace");
const { mint } = await import("../src/commands/mint.js");
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

/** Run `cotal mint …` in-process: captured output, the exit code the operator would get. */
class ExitSignal extends Error {}
async function runMint(positionals: string[], values: Record<string, unknown>): Promise<{ out: string; code: number }> {
  const lines: string[] = [];
  const [log, err, exit] = [console.log, console.error, process.exit];
  let code = 0;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  process.exit = ((c?: number) => { code = c ?? 0; throw new ExitSignal(); }) as never;
  try {
    await mint({ positionals, values, raw: [] } as never);
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
  } finally {
    console.log = log; console.error = err; process.exit = exit;
  }
  // Colour codes stripped: the cells below read values off the lines, not decoration.
  return { out: lines.join("\n").replace(/\x1b\[[0-9;]*m/g, ""), code };
}

/** What a client recovers from the credential without connecting: the principal tag and the
 *  lifecycle uid its dm/dlv/chathist grants are named for (SPEC 13.1). */
function facts(creds: string): { principal?: string; uids: string[] } {
  const jwt = jwtFromCreds(creds)!;
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as {
    nats?: { tags?: string[]; pub?: { allow?: string[] } };
  };
  const principal = (payload.nats?.tags ?? []).find((t) => t.startsWith("principal:"))?.slice("principal:".length);
  const uids = new Set<string>();
  for (const s of payload.nats?.pub?.allow ?? []) {
    const m = /(?:^|\.)(?:dm|dlv|chathist)_([^.]+)/.exec(s);
    if (m) uids.add(m[1]!.split("-").pop()!);
  }
  return { principal, uids: [...uids] };
}

const SPACE = "main";
const root = mkdtempSync(join(tmpdir(), "cotal-mint-prov-root-"));
mkdirSync(join(root, ".cotal"), { recursive: true });
const auth = await createSpaceAuth(SPACE);
const broker = await bootBroker(auth);
const cleanup: Array<() => Promise<void> | void> = [() => broker.stop()];
const cwd0 = process.cwd();

try {
  // The space, provisioned as `cotal up` leaves it: trust material in the root, streams and the
  // channel registry on the broker, and a registry entry so the target resolves to THIS broker.
  saveSpaceAuth(authDir(root), auth);
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: broker.servers, space: SPACE, creds: provisioner });
  await seedChannelRegistry({ servers: broker.servers, space: SPACE, creds: provisioner, file: { channels: { general: {} } } });
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
    subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"], lifecycleUid: mintLifecycleUid(),
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
    const r = await runMint(["plain"], { profile: "agent", out });
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
    const r = await runMint(["board"], { profile: "agent", provision: true, role: "board", out });
    check("mint --provision --role board succeeds", r.code === 0 && existsSync(out), r.out);
    check("  it says so", /provisioned its durables/.test(r.out), r.out);
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

  // ── 4. off the agent profile: refused, nothing written ──────────────────────────────────────
  {
    const out = join(root, "obs.creds");
    const r1 = await runMint(["obs"], { profile: "observer", provision: true, out });
    check("--provision on the observer profile exits 1 with the reason", r1.code === 1 && /agent profile only/.test(r1.out), r1.out);
    check("  and mints nothing", !existsSync(out));
    const r2 = await runMint(["obs2"], { profile: "admin", role: "board", out });
    check("--role on the admin profile exits 1 with the reason", r2.code === 1 && /agent profile only/.test(r2.out), r2.out);
    check("  and mints nothing", !existsSync(out));
  }

  // ── 5. the wrong mesh, and an OPEN mesh ─────────────────────────────────────────────────────
  {
    // A second space registered as open, with its own root holding ITS trust material. Neither
    // refusal below connects anywhere (the server is a dead port on purpose): the space check and
    // the mode check both fire before the provisioner is minted.
    const OPEN = "sandbox";
    const openRoot = mkdtempSync(join(tmpdir(), "cotal-mint-prov-open-"));
    mkdirSync(join(openRoot, ".cotal"), { recursive: true });
    saveSpaceAuth(authDir(openRoot), await createSpaceAuth(OPEN));
    recordMesh({ space: OPEN, server: "nats://127.0.0.1:1", root: openRoot, mode: "open", ts: new Date().toISOString(), origin: "manual" });
    cleanup.push(() => rmSync(openRoot, { recursive: true, force: true }));

    // From the main root, naming the other space: the root's auth and the target disagree.
    const out = join(root, "wrong.creds");
    const r = await runMint(["x"], { profile: "agent", provision: true, space: OPEN, out });
    check("--provision naming a mesh this root's auth is not for exits 1", r.code === 1 && /auth is for space "main"/.test(r.out), r.out);
    check("  and mints nothing", !existsSync(out));

    // From the open root: the mode itself is the refusal.
    process.chdir(openRoot);
    const out2 = join(openRoot, "open.creds");
    const r2 = await runMint(["x"], { profile: "agent", provision: true, out: out2 });
    process.chdir(root);
    check("--provision on an open mesh exits 1 naming why (peers self-create there)", r2.code === 1 && /open mesh/.test(r2.out), r2.out);
    check("  and mints nothing", !existsSync(out2));
  }

  console.log(`\nMINT-PROVISION SMOKE OK ✅  (${pass} passed)`);
} finally {
  for (const fn of cleanup.reverse()) await fn();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
