/**
 * The delegation bound through the SERVED spawn door on a static mesh. `spawn-grant-bound` proves
 * the bound when `startAgent` is handed a caller; this proves the door hands it one. A real manager
 * serves `spawn`, and a real issued agent credential calls it over the broker on the versioned rail,
 * so the caller the bound measures is the one the broker pinned on the request subject. Nothing here
 * builds a caller by hand for the manager.
 *
 * The spawner is minted the way a foreground seat would be once issued: an agent credential with
 * `spawn`, reading and posting `review`, its evidence recorded with no source and a fixed expiry.
 * The same door carries an inline persona (SPEC 13.7): the bound reads the record, the helper joins
 * and its goal ends succeeded, and a repeated goal returns its first acceptance instead of a second
 * spawn. `define-persona` is bounded at the same door: a definer puts only capabilities it holds
 * into a persona, and a definition that waited on its definer's evidence writes only against the
 * catalog as it found it after that wait: never over a persona another principal defined meanwhile,
 * and never bringing back a persona removed meanwhile. A static owner is a live seat of this manager,
 * whose ceiling a renewal keeps and whose respawn is a new principal, so a static definer is never
 * demoted while it owns a persona; the demoted redefine is a ledger case, in spawn-inline-persona.
 * Run with: pnpm smoke:spawn-grant-door
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import {
  createSpaceAuth,
  grantOverreach,
  invokeCommand,
  mintAcceptedToken,
  mintCreds,
  mintGeneration,
  mintLifecycleUid,
  newIdentity,
  registry,
  resolveService,
  setupSpaceStreams,
  standaloneConnectOpts,
  withIssuerSession,
  DEV_OWNER,
  type Connector,
  type IssuedCaller,
  type LaunchOpts,
} from "@cotal-ai/core";
import { agentLifecycleSecretFilePaths, authDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { inlinePersonaDir, inlineSnapshotPath } from "../src/launch.js";
import { MANAGER_ENDPOINT } from "../src/manager-service-contract.js";
import { bootBroker } from "./_boot-broker.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`); }
};

const space = `grant-door-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const { servers: SERVERS, stop: stopBroker } = await bootBroker(auth);
const dir = mkdtempSync(join(tmpdir(), "cotal-grant-door-"));
const prevHome = process.env.COTAL_HOME;
process.env.COTAL_HOME = join(dir, "home");
mkdirSync(process.env.COTAL_HOME, { recursive: true });
const root = join(dir, "ws");
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(root), auth);
recordMesh({ space, server: SERVERS, root, mode: "auth", ts: new Date().toISOString() });
const persona = (file: string, body: string) => writeFileSync(join(root, ".cotal", "agents", `${file}.md`), `---\nname: ${file}\n${body}---\nbody\n`);
persona("inside", "allowSubscribe: [review]\nallowPublish: [review]\n");
persona("reader", "allowSubscribe: [general]\n");

// A seat that stays up and never joins: the cells read the door's answer and the minted seat.
registry.register({
  kind: "connector",
  name: "smoke-door",
  requires: ["node"],
  buildLaunch: () => ({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"], env: {} }),
} as Connector);
// A seat that joins with its minted credential and idles, so a spawn's goal reaches its terminal.
// The copy runs outside the package tree, so its core import is baked to this checkout's built core.
const coreDist = new URL("../../../packages/core/dist/index.js", import.meta.url).href;
writeFileSync(join(dir, "seat.mjs"), readFileSync(new URL("./_persona-role-seat.mjs", import.meta.url), "utf8").replace("CORE_DIST_URL_PLACEHOLDER", JSON.stringify(coreDist)));
registry.register({
  kind: "connector",
  name: "smoke-door-join",
  requires: ["node"],
  buildLaunch: (o: LaunchOpts) => ({
    command: process.execPath,
    args: [join(dir, "seat.mjs")],
    env: { COTAL_SPACE: o.space, COTAL_SERVERS: o.servers ?? "", COTAL_CREDS: o.creds ?? "", COTAL_ID: o.id ?? "", COTAL_NAME: o.name, COTAL_ROLE: o.role ?? "", COTAL_LIFECYCLE_UID: o.lifecycleUid ?? "" },
  }),
} as Connector);

let mgr: InstanceType<typeof Manager> | undefined;
let nc: Awaited<ReturnType<typeof connect>> | undefined;
let rivalNc: Awaited<ReturnType<typeof connect>> | undefined;
let definerNc: Awaited<ReturnType<typeof connect>> | undefined;
try {
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot: root });
  await mgr.start();

  const identity = newIdentity();
  const uid = mintLifecycleUid();
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const issued = { generation: mintGeneration(expiresAt), acceptedToken: mintAcceptedToken() };
  const creds = await withIssuerSession({ servers: SERVERS, space, auth, tls: false }, (s) =>
    mintCreds(auth, identity, "agent", {
      lifecycleUid: uid,
      expiresAt,
      issued,
      issuance: { mode: "issue", store: s.store, accepted: s.accepted, sources: [] },
      capabilities: ["spawn"],
      allowSubscribe: ["review"],
      allowPublish: ["review"],
    }),
  );
  const caller = { owner: DEV_OWNER, actor: identity.id, uid, generation: issued.generation } as IssuedCaller;
  nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  const svc = await resolveService(nc, space, MANAGER_ENDPOINT, caller, { deadlineMs: 8_000 });
  const spawn = async (name: string, extra: Record<string, unknown> = {}, id?: string): Promise<{ ok: boolean; message: string; code?: string; outcome?: string; data?: { name?: string; uid?: string; goalId?: string } }> => {
    try {
      const r = await invokeCommand(nc!, space, svc, "spawn", { name, agent: "smoke-door", events: false, ...extra }, { deadlineMs: 20_000, ...(id ? { id } : {}) });
      const reply = (r as { reply?: { ok?: boolean; data?: { name?: string; uid?: string; goalId?: string }; error?: { code?: string; message?: string; outcome?: string } } }).reply;
      return { ok: reply?.ok === true, message: reply?.error?.message ?? "", code: reply?.error?.code, outcome: reply?.error?.outcome, data: reply?.data };
    } catch (e) {
      const err = e as { code?: string; message?: string; outcome?: string };
      return { ok: false, message: err.message ?? String(e), code: err.code, outcome: err.outcome };
    }
  };
  // The caller's own terminal, read through the manager's goal-result command as a connector's
  // follow reads it.
  const goalSvc = await resolveService(nc, space, MANAGER_ENDPOINT, caller, { deadlineMs: 8_000, commands: ["goal-result"] });
  type Terminal = { state: string; data?: { name?: string; lifecycleUid?: string } };
  const terminal = async (goalId: string): Promise<Terminal | undefined> => {
    for (let i = 0; i < 300; i++) {
      const r = await invokeCommand(nc!, space, goalSvc, "goal-result", { goalId }, { deadlineMs: 5_000 });
      const result = (r as { reply?: { data?: { result?: Terminal } } }).reply?.data?.result;
      if (result) return result;
      await new Promise((res) => setTimeout(res, 100));
    }
    return undefined;
  };
  const snapshots = () => (existsSync(inlinePersonaDir(root)) ? readdirSync(inlinePersonaDir(root)) : []);
  const seats = () => [...(mgr as unknown as { agents: Map<string, { name: string; lifecycleUid: string }> }).agents.values()];

  console.log("served spawn door");
  const wide = await spawn("reader");
  check("a served spawn wider than the spawner is refused at the door, naming the part", !wide.ok && /more than the spawner holds: allowSubscribe general/.test(wide.message), wide);
  check("the refusal says it did not run", wide.outcome === "not-executed", wide);
  check("and allocates no seat", !seats().some((a) => a.name === "reader"), seats().map((a) => a.name));
  const inside = await spawn("inside");
  check("control: a served spawn inside the spawner's grant is accepted", inside.ok, inside);
  // The door replies at acceptance, before provisioning, so the seat appears after the reply.
  for (let i = 0; i < 200 && !seats().some((a) => a.name === "inside"); i++) await new Promise((r) => setTimeout(r, 100));
  const seat = seats().find((a) => a.name === "inside");
  check("control: and its seat was minted", seat !== undefined && existsSync(agentLifecycleSecretFilePaths(root, space, "inside", seat.lifecycleUid).creds), seats().map((a) => a.name));

  console.log("inline persona through the served door");
  const record = { prompt: "You review.", allowSubscribe: ["review"], allowPublish: ["review"] };
  const over = await spawn("overreach", { persona: { prompt: "x", allowSubscribe: ["general"] } });
  check("an inline record wider than the spawner is refused at the door, naming the part", !over.ok && /more than the spawner holds: allowSubscribe general/.test(over.message), over);
  check("the refusal says it did not run, and wrote no snapshot", over.outcome === "not-executed" && snapshots().length === 0, { over, snapshots: snapshots() });
  const withConfig = await spawn("confused", { persona: record, config: join(root, ".cotal", "agents", "inside.md") });
  check("an inline record with config is refused at the door", !withConfig.ok && /takes no config, identity or manifest launch/.test(withConfig.message), withConfig);
  const withIdentity = await spawn("confused", { persona: record, identity: "someone" });
  check("an inline record with identity is refused at the door", !withIdentity.ok && /takes no config, identity or manifest launch/.test(withIdentity.message), withIdentity);
  const goal = randomUUID();
  const joining = { agent: "smoke-door-join", persona: { ...record, save: true } };
  const first = await spawn("notes", joining, goal);
  check("an inline record inside the spawner's grant is accepted", first.ok && first.data?.name === "notes" && first.data.goalId !== undefined, first);
  // The door replies at acceptance, before provisioning; the goal's terminal comes once the helper joins.
  const done = first.data?.goalId ? await terminal(first.data.goalId) : undefined;
  check("its goal ends succeeded once the helper joins, naming the seat", done?.state === "succeeded" && done.data?.name === "notes" && done.data.lifecycleUid !== undefined, done);
  const notes = seats().find((a) => a.name === "notes");
  check("the seat the terminal names runs from its snapshot, and its copy is saved", notes !== undefined && notes.lifecycleUid === done?.data?.lifecycleUid && existsSync(inlineSnapshotPath(root, notes.lifecycleUid)) && existsSync(join(root, ".cotal", "agents", "notes.md")), { seats: seats().map((a) => a.name), snapshots: snapshots() });
  const again = await spawn("notes", joining, goal);
  check("the same goal again returns its first acceptance", again.ok && again.data?.uid !== undefined && again.data.uid === first.data?.uid, again);
  check("and starts no second seat and no second snapshot", seats().filter((a) => a.name.startsWith("notes")).length === 1 && snapshots().length === 1, { seats: seats().map((a) => a.name), snapshots: snapshots() });
  const changed = await spawn("notes", { ...joining, persona: { ...joining.persona, prompt: "changed" } }, goal);
  check("the same goal with a changed record is refused as a different submission", !changed.ok && changed.code === "failed-precondition" && changed.outcome === "not-executed" && /was accepted under a different submission/.test(changed.message), changed);
  check("and starts nothing", seats().filter((a) => a.name.startsWith("notes")).length === 1 && snapshots().length === 1, { seats: seats().map((a) => a.name), snapshots: snapshots() });

  console.log("define-persona through the served door");
  const defineSvc = await resolveService(nc, space, MANAGER_ENDPOINT, caller, { deadlineMs: 8_000, commands: ["define-persona"] });
  type Door = { conn: NonNullable<typeof nc>; svc: typeof defineSvc };
  const define = async (name: string, capabilities: string[], door: Door = { conn: nc!, svc: defineSvc }, persona = "You help."): Promise<{ ok: boolean; code?: string; message: string }> => {
    try {
      const r = await invokeCommand(door.conn, space, door.svc, "define-persona", { name, persona, capabilities }, { deadlineMs: 10_000 });
      const reply = (r as { reply?: { ok?: boolean; error?: { code?: string; message?: string } } }).reply;
      return { ok: reply?.ok === true, code: reply?.error?.code, message: reply?.error?.message ?? "" };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message ?? String(e) };
    }
  };
  const file = (name: string) => join(root, ".cotal", "agents", `${name}.md`);
  // A missing file reads as empty, so a broken handler fails the cell instead of the suite.
  const bytes = (name: string) => (existsSync(file(name)) ? readFileSync(file(name), "utf8") : "");
  const held = await define("delegate", ["spawn"]);
  check("a definer may put a capability it holds into a persona", held.ok && /capabilities:\s*\n\s*- spawn/.test(readFileSync(file("delegate"), "utf8")), held);
  const admin = await define("usurper", ["admin"]);
  check("a define-persona capability the definer does not hold is refused at the door, naming it", !admin.ok && admin.code === "permission-denied" && /grants more than the definer holds: capabilities admin/.test(admin.message), admin);
  const run = await define("runner", ["run"]);
  check("and so is run for a definer that holds only spawn", !run.ok && /capabilities run/.test(run.message), run);
  check("and neither refusal wrote a file", !existsSync(file("usurper")) && !existsSync(file("runner")));

  // Two served definitions of one name from two principals. The first names a capability, so it
  // waits while the manager reads its definer's evidence. A test hook holds that read open until the
  // rival's definition, served on its own connection, has landed. The first must not write over it.
  const rivalId = newIdentity();
  const rivalUid = mintLifecycleUid();
  const rivalIssued = { generation: mintGeneration(expiresAt), acceptedToken: mintAcceptedToken() };
  const rivalCreds = await withIssuerSession({ servers: SERVERS, space, auth, tls: false }, (s) =>
    mintCreds(auth, rivalId, "agent", {
      lifecycleUid: rivalUid,
      expiresAt,
      issued: rivalIssued,
      issuance: { mode: "issue", store: s.store, accepted: s.accepted, sources: [] },
      capabilities: ["spawn"],
      allowSubscribe: [],
      allowPublish: [],
    }),
  );
  const rivalCaller = { owner: DEV_OWNER, actor: rivalId.id, uid: rivalUid, generation: rivalIssued.generation } as IssuedCaller;
  rivalNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: rivalCreds, tls: false }), maxReconnectAttempts: 0 });
  const rivalDoor = { conn: rivalNc, svc: await resolveService(rivalNc, space, MANAGER_ENDPOINT, rivalCaller, { deadlineMs: 8_000, commands: ["define-persona"] }) };
  // Holds `who`'s next evidence read open until `release`; any other caller's read passes. `inside`
  // is false if no definition reached the read within its window.
  const holdEvidence = (who: IssuedCaller) => {
    const hooked = mgr as unknown as { staticSpawnBound: (c?: IssuedCaller) => Promise<unknown> };
    const evidence = hooked.staticSpawnBound.bind(mgr);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const reached = new Promise<void>((r) => { entered = r; });
    hooked.staticSpawnBound = async (c) => {
      if (c?.actor !== who.actor || c.uid !== who.uid) return evidence(c);
      entered();
      await gate;
      return evidence(c);
    };
    const inside = Promise.race([reached.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]);
    return { inside, release: () => { release(); delete (hooked as { staticSpawnBound?: unknown }).staticSpawnBound; } };
  };
  /** What `meanwhile` returned, the waiting definition's reply, and whether that definition was still
   *  pending when `meanwhile` settled. */
  const overlapping = async <T, M>(waiting: Promise<T>, meanwhile: () => Promise<M>) => {
    let settled = false;
    void waiting.then(() => { settled = true; });
    const during = await meanwhile();
    return { pendingThroughout: !settled, during, reply: await waiting };
  };
  const rivalHold = holdEvidence(caller);
  const waiting = define("contested", ["spawn"]);
  const rivalInside = await rivalHold.inside;
  const rivalRace = await overlapping(waiting, async () => {
    const reply = await define("contested", [], rivalDoor, "The rival's persona.");
    const written = bytes("contested");
    rivalHold.release();
    return { reply, written };
  });
  check("control: the first definition waits on its evidence, and the rival's served definition lands before it settles",
    rivalInside && rivalRace.pendingThroughout && rivalRace.during.reply.ok && rivalRace.during.written.includes("The rival's persona."), { rivalInside, rivalRace });
  check("a served definition that waited on its evidence does not overwrite a persona another principal defined meanwhile",
    !rivalRace.reply.ok && /not authorized to redefine contested/.test(rivalRace.reply.message) && bytes("contested") === rivalRace.during.written, rivalRace.reply);

  // A served removal in the same gap. A static persona records an owner only for a seat this manager
  // runs, so the definer here is one: started by the manager, calling with its own minted credential.
  // The waiting redefine composes against the catalog it writes to, so the removed file's role does
  // not come back with it.
  const started = await mgr.startAgent({ name: "definer", agent: "smoke-door-join", events: false, persona: { prompt: "You define.", capabilities: ["spawn"] } });
  for (let i = 0; i < 200 && !seats().some((a) => a.name === "definer"); i++) await new Promise((r) => setTimeout(r, 100));
  const definerSeat = (seats() as Array<{ name: string; id?: string; lifecycleUid: string; issued?: { generation: string } }>).find((a) => a.name === "definer");
  const definer = { owner: DEV_OWNER, actor: definerSeat?.id, uid: definerSeat?.lifecycleUid, generation: definerSeat?.issued?.generation } as IssuedCaller;
  definerNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: readFileSync(agentLifecycleSecretFilePaths(root, space, "definer", definer.uid).creds, "utf8"), tls: false }), maxReconnectAttempts: 0 });
  const definerDoor = { conn: definerNc, svc: await resolveService(definerNc, space, MANAGER_ENDPOINT, definer, { deadlineMs: 8_000, commands: ["define-persona", "remove-persona"] }) };
  const withRole = await define("removed", [], definerDoor, "---\nrole: auditor\n---\nYou help.");
  const firstFile = bytes("removed");
  const removalHold = holdEvidence(definer);
  const redefining = define("removed", ["spawn"], definerDoor);
  const removalInside = await removalHold.inside;
  const removalRace = await overlapping(redefining, async () => {
    const removedOk = await invokeCommand(definerNc!, space, definerDoor.svc, "remove-persona", { name: "removed" }, { deadlineMs: 10_000 })
      .then((r) => (r as { reply?: { ok?: boolean } }).reply?.ok === true, () => false);
    const gone = !existsSync(file("removed"));
    removalHold.release();
    return { removedOk, gone };
  });
  const removed = bytes("removed");
  check("control: a seat the manager runs defines a persona at the door with a role, which records it as the owner",
    started.ok && definerSeat?.issued !== undefined && withRole.ok && /role: auditor/.test(firstFile) && firstFile.includes(`owner: ${DEV_OWNER}.${definer.actor}`), { started, withRole, firstFile });
  check("control: it removes the persona at the door while its redefine waits on its evidence",
    removalInside && removalRace.during.removedOk && removalRace.during.gone && removalRace.pendingThroughout, { removalInside, removalRace });
  check("a served definition that waited on its evidence is composed against the catalog it writes to, not a removed file",
    removalRace.reply.ok && !/role: auditor/.test(removed) && /capabilities:\s*\n\s*- spawn/.test(removed), { reply: removalRace.reply, removed });
} finally {
  await rivalNc?.drain().catch(() => rivalNc?.close());
  await definerNc?.drain().catch(() => definerNc?.close());
  await nc?.drain().catch(() => nc?.close());
  await mgr?.stop({ withAgents: true }).catch(() => {});
  await stopBroker();
  if (prevHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nSPAWN-GRANT-DOOR SMOKE ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
