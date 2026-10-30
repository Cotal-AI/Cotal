/**
 * An inline persona on `spawn` (SPEC 13.7): the helper's definition carried on the spawn instead of
 * read from the catalog. The record is validated like a file, bounded like a file, written to a
 * private snapshot only after the grant, launched from that snapshot, and removed with the seat.
 * `save: true` also writes a create-only catalog copy of the grant that was checked.
 *
 * Broker-backed on a STATIC mesh, as `spawn-grant-bound` is: the spawners are real managed seats
 * whose issued evidence the real issuer recorded, and each cell passes the spawner's issued caller
 * to `startAgent` the way the served door does. The runtime and the endpoint are fakes, so no seat
 * process starts; a fake seat's exit is fired by hand, which drives the real exit watcher. An open
 * mesh manager covers the paths a static mesh does not take, the public preservation cut and resume
 * included, and a user-auth manager runs the real auth provider and ledger, whose refusal comes
 * before any broker work. Run with: pnpm smoke:spawn-inline-persona
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager, type FreeSlotCause, type ManagerResumeAgent, type ManagerResumeInventory } from "../src/manager.js";
import { inlinePersonaDir, inlineSnapshotPath } from "../src/launch.js";
import { readSeatRecord } from "../src/resume.js";
import {
  createSpaceAuth,
  eventChannel,
  loadAgentFile,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  principalKey,
  registry,
  setupSpaceStreams,
  DEV_OWNER,
  type AgentDef,
  type AgentHandle,
  type Connector,
  type ControlReply,
  type EpCaller,
  type IssuedCaller,
  type LaunchSpec,
} from "@cotal-ai/core";
import { agentLifecycleSecretFilePaths, userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import { bootBroker } from "./_boot-broker.js";
import { credAcl } from "./_cred-acl.js";
import { requestDeliveryAdminZeroMemberships } from "./_fake-delivery-admin.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`); }
};
const until = async (cond: () => boolean, ms = 30_000) => {
  for (let i = 0; i < ms / 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
  return cond();
};

const space = `inline-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const { servers: SERVERS, stop: stopBroker } = await bootBroker(auth);

const scratch = mkdtempSync(join(tmpdir(), "cotal-inline-persona-"));
const workspaceRoot = join(scratch, "static");
const agentsDir = join(workspaceRoot, ".cotal", "agents");
mkdirSync(agentsDir, { recursive: true });
const persona = (file: string, body: string) => writeFileSync(join(agentsDir, `${file}.md`), `---\nname: ${file}\n${body}---\nbody\n`);
// The spawner: reads review and ops, posts review, may spawn. A narrower one reads and posts review.
persona("lead", "allowSubscribe: [review, ops]\nallowPublish: [review]\ncapabilities: [spawn]\n");
persona("narrow", "allowSubscribe: [review]\nallowPublish: [review]\ncapabilities: [spawn]\n");

/** A fake seat whose exit the cell fires: the real exit watcher subscribes through `attach`. */
type FakeSeat = AgentHandle & { exit: () => void };
const fakeSeat = (name: string, kind: string): FakeSeat => {
  let exited = false;
  const listeners: Array<() => void> = [];
  const session = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: (cb: () => void) => { listeners.push(cb); return () => {}; }, write: () => {}, resize: () => {} };
  return {
    name, kind, status: () => (exited ? "exited" : "running"), stop: () => { exited = true; }, interrupt: () => {}, attach: () => session, waitForExit: async () => {},
    exit: () => { exited = true; for (const l of listeners.splice(0)) l(); },
  } as unknown as FakeSeat;
};

type Seat = { id: string; name: string; lifecycleUid: string; issued?: { generation: string }; launch: { source: { kind: string; ref: string; configPath: string; configSha256: string } }; suppressCleanup?: boolean };
type Internals = {
  managerInstanceId: string;
  agents: Map<string, Seat>;
  retiring: Map<string, { lastError?: string }>;
  freeSlot: (a: unknown, floor: boolean, cause: FreeSlotCause) => void;
  deprovision: (a: unknown) => Promise<void>;
  deprovisioningFlight: Map<string, Promise<void>>;
  driveStaticRetirement: (a: unknown, surfaceFailure?: boolean) => Promise<void>;
  inventoryReferenceError: (entry: ManagerResumeAgent) => string | undefined;
  resumeEntryOf: (a: Seat) => ManagerResumeAgent;
  spawnPersona: (opts: Record<string, unknown>, spawner: string | undefined, caller: EpCaller | undefined) => Promise<{ error?: string }>;
  opDefinePersona: (args: Record<string, unknown>, caller: string, admin: boolean, authenticated?: EpCaller) => Promise<ControlReply>;
};

/** A manager over a fake endpoint and runtime. `spawned` counts launches per seat name; a name in
 *  `failLaunch` throws at launch, after the grant and the snapshot, and `beforeLaunch` runs first. */
function managerAt(root: string, opts: { auth?: boolean }) {
  const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot: root, preserveStopTimeoutMs: 2_000 });
  if (opts.auth) (mgr as unknown as { auth: unknown }).auth = auth;
  const M = mgr as unknown as Internals;
  M.managerInstanceId = mintLifecycleUid();
  const seats = new Map<string, FakeSeat>();
  const spawned = new Map<string, number>();
  const failLaunch = new Set<string>();
  const beforeLaunch = new Map<string, () => void>();
  (mgr as unknown as { runtime: unknown }).runtime = {
    kind: "pty",
    spawn: (name: string, _spec: LaunchSpec) => {
      spawned.set(name, (spawned.get(name) ?? 0) + 1);
      beforeLaunch.get(name)?.();
      if (failLaunch.has(name)) throw new Error(`smoke: launch of ${name} refused`);
      const seat = fakeSeat(name, "pty");
      seats.set(name, seat);
      return seat;
    },
  };
  (mgr as unknown as { staticLifecycleEvict?: (principal: string) => Promise<unknown> }).staticLifecycleEvict = async (principal) =>
    ({ principal, kicked: 1, remaining: 0, scanComplete: true, verifiedGone: true });
  (mgr as unknown as { ep: Record<string, unknown> }).ep = {
    ref: () => ({ id: "smoke-mgr" }),
    on: () => {},
    off: () => {},
    waitForPresenceSnapshot: async () => {},
    chatFrontier: async () => 0,
    requestDeliveryAdmin: requestDeliveryAdminZeroMemberships,
    // A user-mode seat's id is already its principal; a static one is the nkey under the dev owner.
    getRoster: () => [...M.agents.values()].map((a) => ({ card: { id: a.id.includes(".") ? a.id : principalKey(DEV_OWNER, a.id).key, name: a.name }, status: "idle", lifecycleUid: a.lifecycleUid, ts: 1 })),
  };
  return { mgr, M, seats, spawned, failLaunch, beforeLaunch };
}

const con: Connector = { kind: "connector", name: "smoke-inline", requires: ["node"], eventChannel, readinessTimeoutMs: 2_000, buildLaunch: () => ({ command: "true", args: [], env: {} }) };
registry.register(con);

const S = managerAt(workspaceRoot, { auth: true });
const spawnAs = (caller: EpCaller | undefined, name: string, extra: Record<string, unknown> = {}, hooks?: Record<string, unknown>): Promise<ControlReply> =>
  S.mgr.startAgent({ name, agent: "smoke-inline", events: false, ...extra }, caller ? principalKey(caller.owner, caller.actor).key : undefined, hooks, caller);
const okData = (r: ControlReply) => (r.ok ? (r.data as { name: string; lifecycleUid: string }) : undefined);
const minted = (r: ControlReply) => {
  const d = okData(r);
  return d ? credAcl(agentLifecycleSecretFilePaths(workspaceRoot, space, d.name, d.lifecycleUid).creds) : undefined;
};
const reads = (acl: { sub: string[] } | undefined, ch: string) => acl !== undefined && acl.sub.some((s) => s.endsWith(`.${ch}`));
const posts = (acl: { pub: string[] } | undefined, ch: string) => acl !== undefined && acl.pub.some((s) => s.endsWith(`.${ch}`));
const refused = (r: ControlReply, part: RegExp) => r.ok === false && part.test(r.error ?? "");
const seatOf = (M: Internals, name: string) => [...M.agents.values()].find((x) => x.name === name);
const issuedCallerOf = (name: string): IssuedCaller => {
  const a = seatOf(S.M, name)!;
  return { owner: DEV_OWNER, actor: a.id, uid: a.lifecycleUid, generation: a.issued!.generation } as IssuedCaller;
};
const snapshots = (root: string) => (existsSync(inlinePersonaDir(root)) ? readdirSync(inlinePersonaDir(root)).sort() : []);
const catalog = (name: string) => join(agentsDir, `${name}.md`);
const retire = async (M: Internals, seats: Map<string, FakeSeat>, name: string) => {
  seats.get(name)!.exit();
  await until(() => seatOf(M, name) === undefined && !M.retiring.has(name));
};
/** Exit a seat and wait for its teardown to settle, however it ends. */
const exitAndSettle = async (M: Internals, seats: Map<string, FakeSeat>, name: string) => {
  seats.get(name)!.exit();
  await until(() => seatOf(M, name) === undefined);
  await Promise.allSettled([...M.deprovisioningFlight.values()]);
};
/** What `console.error` printed while `run` ran: a teardown reports there. */
const errorsDuring = async <T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); original(...args); };
  try {
    return { value: await run(), lines };
  } finally {
    console.error = original;
  }
};
/** Give a fake-endpoint manager what a public stop calls. */
const stoppable = (mgr: Manager) => {
  Object.assign((mgr as unknown as { ep: Record<string, unknown> }).ep, { releaseManagerLease: async () => {}, releaseDaemonRenewalLease: async () => {}, stop: async () => {} });
  (mgr as unknown as { attach: unknown }).attach = { stop: async () => {} };
};
/** Swap the inline directory for a link to `target`. The returned function puts the real one back. */
const linkedInlineDir = (root: string, target: string) => {
  const dir = inlinePersonaDir(root);
  renameSync(dir, `${dir}.real`);
  symlinkSync(target, dir);
  return () => { rmSync(dir); renameSync(`${dir}.real`, dir); };
};

try {
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  check("control: the composition root spawns the spawners", (await spawnAs(undefined, "lead")).ok && (await spawnAs(undefined, "narrow")).ok);
  const lead = issuedCallerOf("lead");
  const narrow = issuedCallerOf("narrow");

  console.log("the record");
  {
    const before = snapshots(workspaceRoot);
    const shape = async (p: unknown, extra: Record<string, unknown> = {}) => spawnAs(undefined, "shape", { persona: p, ...extra });
    check("a persona that is not an object is refused", refused(await shape("be helpful"), /persona: expected an object/));
    check("an unknown key in the persona is refused by name", refused(await shape({ prompt: "x", owner: "someone" }), /persona: unknown key owner/));
    check("a persona without a prompt is refused", refused(await shape({ role: "r" }), /persona\.prompt: required/));
    check("a blank prompt is refused", refused(await shape({ prompt: "   " }), /persona\.prompt: expected a non-blank string/));
    check("a channel list item that is not a string is refused", refused(await shape({ prompt: "x", allowSubscribe: ["review", 7] }), /persona\.allowSubscribe: expected an array of strings/));
    check("a save that is not a boolean is refused", refused(await shape({ prompt: "x", save: "yes" }), /persona\.save: expected a boolean/));
    check("a read set outside the persona's read ACL is refused as a file load refuses it", refused(await shape({ prompt: "x", subscribe: ["ops"], allowSubscribe: ["review"] }), /persona: .*ops/));
    check("a persona with config is refused", refused(await shape({ prompt: "x" }, { config: join(agentsDir, "lead.md") }), /takes no config, identity or manifest launch/));
    check("a persona with identity is refused", refused(await shape({ prompt: "x" }, { identity: "other" }), /takes no config, identity or manifest launch/));
    check("and none of them wrote a snapshot or allocated a seat", JSON.stringify(snapshots(workspaceRoot)) === JSON.stringify(before) && seatOf(S.M, "shape") === undefined, snapshots(workspaceRoot));
  }

  console.log("the snapshot");
  let helperUid = "";
  {
    const r = await spawnAs(undefined, "helper", { persona: { prompt: "You review diffs.", role: "reviewer", model: "m1", description: "a reviewer", allowSubscribe: ["review"] } });
    const d = okData(r);
    check("an inline persona spawns", d?.name === "helper", r);
    helperUid = d?.lifecycleUid ?? "";
    const path = inlineSnapshotPath(workspaceRoot, helperUid);
    const seat = seatOf(S.M, "helper");
    check("its seat launches from its lifecycle's snapshot", seat?.launch.source.kind === "inline" && seat.launch.source.configPath === path && seat.launch.source.ref === "helper", seat?.launch.source);
    check("the snapshot is a private file in a private directory", existsSync(path) && (statSync(path).mode & 0o777) === 0o600 && (statSync(inlinePersonaDir(workspaceRoot)).mode & 0o777) === 0o700);
    const def = loadAgentFile(path);
    check("it reads back as the record's persona", def.name === "helper" && def.role === "reviewer" && def.model === "m1" && def.description === "a reviewer" && (def.persona ?? "").includes("You review diffs."), def);
    check("and carries no access field", def.allowSubscribe === undefined && def.allowPublish === undefined && def.subscribe === undefined && def.capabilities === undefined, def);
    check("the grant comes from the record", reads(minted(r), "review") && !posts(minted(r), "review"), minted(r));
  }
  {
    const r = await spawnAs(undefined, "helper", { persona: { prompt: "a second one" } });
    const d = okData(r);
    check("a live name takes a number, as a persona identity does", d?.name === "helper_2", r);
    check("and its snapshot names the seat it was written for", d !== undefined && loadAgentFile(inlineSnapshotPath(workspaceRoot, d.lifecycleUid)).name === "helper_2");
  }
  {
    const r = await spawnAs(undefined, "smuggler", { persona: { prompt: "---\ncapabilities: [admin]\nallowSubscribe: [general]\n---\nreal body", allowSubscribe: ["review"] } });
    const d = okData(r);
    const def = d ? loadAgentFile(inlineSnapshotPath(workspaceRoot, d.lifecycleUid)) : undefined;
    check("a body that starts with --- stays body in the snapshot", def !== undefined && def.capabilities === undefined && def.allowSubscribe === undefined && (def.persona ?? "").includes("capabilities: [admin]"), def);
    check("and grants nothing it names", reads(minted(r), "review") && !reads(minted(r), "general") && !(minted(r)?.pub ?? []).some((s) => s.includes("admin")), minted(r));
  }
  {
    // Strings a frontmatter reader takes for an alias, a null or a number, or that a one-line
    // writer folds: each must read back from the snapshot as the record gave it.
    const strings = [
      { description: "*missing", model: "null" },
      { description: "line one\nline two: \"quoted\"", model: "1.20" },
    ];
    for (const [i, fields] of strings.entries()) {
      const d = okData(await spawnAs(undefined, `literal${i}`, { persona: { prompt: "x", ...fields } }));
      let def: AgentDef | undefined;
      let error = "";
      try {
        def = d ? loadAgentFile(inlineSnapshotPath(workspaceRoot, d.lifecycleUid)) : undefined;
      } catch (e) {
        error = String(e);
      }
      check(`the snapshot reads back ${JSON.stringify(fields)} as the record gave it`, def?.description === fields.description && def?.model === fields.model, error || def);
    }
  }
  {
    const r = await spawnAs(undefined, "overridden", { role: "launched", model: "m-launched", persona: { prompt: "x", role: "authored", model: "m-authored" } });
    const d = okData(r);
    const def = d ? loadAgentFile(inlineSnapshotPath(workspaceRoot, d.lifecycleUid)) : undefined;
    check("control: the spawn's role wins over the record's", (r.ok ? (r.data as { role?: string }).role : undefined) === "launched", r);
    check("the snapshot carries the role and model the seat launched with", def?.role === "launched" && def.model === "m-launched", def);
  }

  console.log("omission and [] (bounded spawner)");
  const callerAcl = { allowSubscribe: ["review", "ops"], allowPublish: ["review"] };
  {
    const r = await spawnAs(lead, "defaulted", { persona: { prompt: "x" }, callerAcl });
    check("a record that names no channel takes the spawner's clamped default", reads(minted(r), "review") && reads(minted(r), "ops") && posts(minted(r), "review"), minted(r));
  }
  {
    const r = await spawnAs(lead, "declined", { persona: { prompt: "x", allowSubscribe: [] }, callerAcl });
    const acl = minted(r);
    check("a record that names [] takes no default", acl !== undefined && acl.sub.length === 0 && acl.pub.length === 0, acl);
  }

  console.log("the bound reads the record");
  {
    const before = snapshots(workspaceRoot);
    check("an inline channel the spawner cannot read is refused by name", refused(await spawnAs(lead, "wide", { persona: { prompt: "x", allowSubscribe: ["general"] } }), /more than the spawner holds: allowSubscribe general/));
    check("an inline capability the spawner does not hold is refused by name", refused(await spawnAs(lead, "boss", { persona: { prompt: "x", capabilities: ["admin"] } }), /capabilities admin/));
    const unissued = { owner: DEV_OWNER, actor: newIdentity().id, uid: "u-unissued" } as EpCaller;
    check("a spawner with no evidence hands the record nothing", refused(await spawnAs(unissued, "orphaned", { persona: { prompt: "x", allowSubscribe: ["review"] } }), /holds no issued evidence/));
    check("and a refused record writes no snapshot", JSON.stringify(snapshots(workspaceRoot)) === JSON.stringify(before), snapshots(workspaceRoot));
    const define = S.M.opDefinePersona({ name: "orphan_def", persona: "x", capabilities: ["spawn"] }, principalKey(DEV_OWNER, unissued.actor).key, false, unissued);
    check("a definer with no evidence puts no capability into a persona", refused(await define, /definer holds no issued evidence.*capabilities spawn/) && !existsSync(catalog("orphan_def")));
  }

  console.log("save");
  {
    const r = await spawnAs(lead, "scribe", { persona: { prompt: "You take notes.", role: "scribe", save: true }, callerAcl });
    check("a saved inline persona spawns", r.ok, r);
    const seat = seatOf(S.M, "scribe");
    check("and its seat still runs from its snapshot", seat?.launch.source.kind === "inline", seat?.launch.source);
    const path = catalog("scribe");
    const def = existsSync(path) ? loadAgentFile(path) : undefined;
    check("the catalog copy is private and named as requested", def?.name === "scribe" && (statSync(path).mode & 0o777) === 0o600, def);
    check("it keeps the grant that was checked, every channel field named", JSON.stringify(def?.subscribe) === "[]" && JSON.stringify(def?.allowSubscribe) === JSON.stringify(["review", "ops"]) && JSON.stringify(def?.allowPublish) === JSON.stringify(["review"]), def);
    check("it records the spawner as its owner", def?.owner === principalKey(DEV_OWNER, lead.actor).key, def?.owner);
    check("and the body and role", def?.role === "scribe" && (def?.persona ?? "").includes("You take notes."), def);
  }
  {
    const r = await spawnAs(narrow, "scribe", { callerAcl: { allowSubscribe: ["review"], allowPublish: ["review"] } });
    check("a later narrower spawner is refused the channels the saved copy names", refused(r, /more than the spawner holds: allowSubscribe ops/), r);
    const again = await spawnAs(lead, "scribe");
    check("and the saved copy spawns by name for a spawner that holds it", reads(minted(again), "review") && reads(minted(again), "ops"), minted(again));
  }
  {
    const r = await spawnAs(lead, "hush", { persona: { prompt: "x", allowSubscribe: [], allowPublish: [], save: true }, callerAcl });
    const def = r.ok ? loadAgentFile(catalog("hush")) : undefined;
    check("a saved [] stays [] in the catalog copy", JSON.stringify(def?.allowSubscribe) === "[]" && JSON.stringify(def?.allowPublish) === "[]" && JSON.stringify(def?.subscribe) === "[]", def);
    const later = minted(await spawnAs(lead, "hush", { callerAcl }));
    check("and a later spawn of it takes no default", later !== undefined && later.sub.length === 0 && later.pub.length === 0, later);
  }
  {
    const r = await spawnAs(undefined, "herald", { persona: { prompt: "x", allowPublish: ["review"], save: true }, events: true });
    const seat = seatOf(S.M, "herald");
    const own = seat ? eventChannel({ owner: DEV_OWNER, actor: seat.id }) : "";
    const def = r.ok ? loadAgentFile(catalog("herald")) : undefined;
    check("control: the herald's own event row is minted", seat !== undefined && (minted(r)?.pub ?? []).some((s) => s.endsWith(own)), minted(r));
    check("but the catalog copy leaves the helper's own event row out", def !== undefined && JSON.stringify(def.allowPublish) === JSON.stringify(["review"]), def?.allowPublish);
  }
  {
    const bytes = readFileSync(catalog("scribe"), "utf8");
    const before = snapshots(workspaceRoot);
    let effect = false;
    const r = await spawnAs(lead, "scribe", { persona: { prompt: "another", save: true }, callerAcl }, { onEffect: () => { effect = true; } });
    check("a save under a name the catalog holds is refused, naming both exits", refused(r, /already holds a persona named "scribe".*Spawn that persona by name, or pick another name/), r);
    check("before anything starts", !effect && JSON.stringify(snapshots(workspaceRoot)) === JSON.stringify(before));
    check("and the catalog file keeps its bytes", readFileSync(catalog("scribe"), "utf8") === bytes);
  }
  {
    const before = snapshots(workspaceRoot);
    const r = await spawnAs(lead, "overreach", { persona: { prompt: "x", allowSubscribe: ["general"], save: true } });
    check("a save the bound refuses writes no catalog copy and no snapshot", !r.ok && !existsSync(catalog("overreach")) && JSON.stringify(snapshots(workspaceRoot)) === JSON.stringify(before), r);
  }
  {
    // The clash check passed; a copy appears before the create-only write, so the write loses.
    const planted = "---\nname: racer\nsubscribe: []\n---\nplanted\n";
    const before = snapshots(workspaceRoot);
    const r = await spawnAs(lead, "racer", { persona: { prompt: "x", save: true }, callerAcl }, { onAccepted: () => writeFileSync(catalog("racer"), planted) });
    check("a copy that loses the create race fails the spawn", !r.ok && /EEXIST/.test(r.error ?? ""), r);
    check("and leaves the file that won as it was", readFileSync(catalog("racer"), "utf8") === planted);
    check("and removes its snapshot and its seat", JSON.stringify(snapshots(workspaceRoot)) === JSON.stringify(before) && seatOf(S.M, "racer") === undefined, snapshots(workspaceRoot));
  }

  console.log("custody");
  {
    const path = inlineSnapshotPath(workspaceRoot, helperUid);
    const twin = okData(await spawnAs(undefined, "helper", { persona: { prompt: "a third" } }));
    await retire(S.M, S.seats, "helper");
    check("a retired inline seat's snapshot is removed", !existsSync(path));
    check("and another seat's snapshot survives it", twin !== undefined && existsSync(inlineSnapshotPath(workspaceRoot, twin.lifecycleUid)));
    const next = okData(await spawnAs(undefined, "helper", { persona: { prompt: "the successor" } }));
    check("a successor under the retired name writes its own snapshot", next?.name === "helper" && existsSync(inlineSnapshotPath(workspaceRoot, next.lifecycleUid)) && next.lifecycleUid !== helperUid, next);
  }
  {
    // A seat the manager lost track of, retired the way the boot sweep retires a slot: by its row.
    const d = okData(await spawnAs(undefined, "lost", { persona: { prompt: "x" } }));
    const seat = seatOf(S.M, "lost")!;
    S.M.agents.delete("lost");
    await S.M.driveStaticRetirement({ id: seat.id, name: "lost", lifecycleUid: d!.lifecycleUid }, true);
    check("the static retirement terminal removes a snapshot by its lifecycle uid", !existsSync(inlineSnapshotPath(workspaceRoot, d!.lifecycleUid)));
  }
  {
    const d = okData(await spawnAs(undefined, "kept", { persona: { prompt: "x" } }));
    const seat = seatOf(S.M, "kept")!;
    seat.suppressCleanup = true;
    S.M.freeSlot(seat, false, "process-exit");
    check("a preservation cut keeps the snapshot", existsSync(inlineSnapshotPath(workspaceRoot, d!.lifecycleUid)));
  }
  {
    // A file already at the accepted uid's path is not this spawn's snapshot. The write refuses it,
    // and neither the rollback nor the retirement terminal it drives may delete it.
    const planted = "planted at this path before the spawn wrote\n";
    let path = "";
    let uid = "";
    const r = await spawnAs(undefined, "squatter", { persona: { prompt: "x" } }, {
      onAccepted: (a: { lifecycleUid: string }) => { uid = a.lifecycleUid; path = inlineSnapshotPath(workspaceRoot, uid); writeFileSync(path, planted); },
    });
    check("a snapshot write that finds a file at its path fails the spawn", !r.ok && /EEXIST/.test(r.error ?? ""), r);
    await Promise.allSettled([...S.M.deprovisioningFlight.values()]);
    check("control: the rollback's retirement ran", uid !== "" && !existsSync(agentLifecycleSecretFilePaths(workspaceRoot, space, "squatter", uid).creds));
    check("and it leaves the file the write refused", existsSync(path) && readFileSync(path, "utf8") === planted);
  }
  {
    // A crash between the refused write and its rollback, observed. The slot row alone then retires
    // the lifecycle, and that retirement cannot tell the planted file from a snapshot its spawn wrote.
    const planted = "planted at this path before the spawn wrote\n";
    let accepted = { uid: "", actor: "" };
    const internals = S.M as unknown as { trackDeprovision: (...args: unknown[]) => void };
    const track = internals.trackDeprovision;
    internals.trackDeprovision = () => {}; // the process died before its rollback's teardown ran
    await spawnAs(undefined, "crashed", { persona: { prompt: "x" } }, {
      onAccepted: (a: { lifecycleUid: string; identity: { id: string } }) => {
        accepted = { uid: a.lifecycleUid, actor: a.identity.id };
        writeFileSync(inlineSnapshotPath(workspaceRoot, a.lifecycleUid), planted);
      },
    });
    internals.trackDeprovision = track;
    const path = inlineSnapshotPath(workspaceRoot, accepted.uid);
    check("control: the refused write left the planted file", existsSync(path) && readFileSync(path, "utf8") === planted);
    await S.M.driveStaticRetirement({ id: accepted.actor, name: "crashed", lifecycleUid: accepted.uid }, true);
    check("a retirement known only by the slot row removes a file planted at the uid's path, a stated limit", !existsSync(path));
  }
  {
    const before = snapshots(workspaceRoot);
    S.failLaunch.add("doomed");
    const r = await spawnAs(undefined, "doomed", { persona: { prompt: "x" } });
    check("a launch that fails after the snapshot removes it", !r.ok && JSON.stringify(snapshots(workspaceRoot)) === JSON.stringify(before) && (S.spawned.get("doomed") ?? 0) === 1, r);
  }
  {
    // A snapshot the rollback cannot remove. The grant's teardown must still run, and the terminal
    // it drives retries the file and reports it.
    const dir = inlinePersonaDir(workspaceRoot);
    let accepted = { uid: "", actor: "" };
    S.failLaunch.add("stuck");
    S.beforeLaunch.set("stuck", () => chmodSync(dir, 0o500));
    const { value: r, lines } = await errorsDuring(async () => {
      const reply = await spawnAs(undefined, "stuck", { persona: { prompt: "x" } }, {
        onAccepted: (a: { lifecycleUid: string; identity: { id: string } }) => { accepted = { uid: a.lifecycleUid, actor: a.identity.id }; },
      }).catch((e: unknown): ControlReply => ({ ok: false, error: `the spawn threw: ${String(e)}` }));
      await Promise.allSettled([...S.M.deprovisioningFlight.values()]);
      return reply;
    });
    chmodSync(dir, 0o700);
    const path = inlineSnapshotPath(workspaceRoot, accepted.uid);
    check("a spawn whose snapshot cannot be removed still returns its launch failure", refused(r, /launch of stuck refused/), r);
    check("and still tears its grant down", accepted.uid !== "" && !existsSync(agentLifecycleSecretFilePaths(workspaceRoot, space, "stuck", accepted.uid).creds));
    check("and its terminal reports the snapshot it could not remove", existsSync(path) && lines.some((l) => /cleanup failed/.test(l) && l.includes(path)), lines.filter((l) => l.includes("stuck")));
    await S.M.driveStaticRetirement({ id: accepted.actor, name: "stuck", lifecycleUid: accepted.uid }, true);
    check("and a later terminal by the slot row removes it", !existsSync(path));
  }
  {
    // A seat whose snapshot cannot be removed when it retires.
    const dir = inlinePersonaDir(workspaceRoot);
    const d = okData(await spawnAs(undefined, "pinned", { persona: { prompt: "x" } }));
    const seat = seatOf(S.M, "pinned")!;
    const path = inlineSnapshotPath(workspaceRoot, d!.lifecycleUid);
    chmodSync(dir, 0o500);
    await exitAndSettle(S.M, S.seats, "pinned");
    chmodSync(dir, 0o700);
    const held = S.M.retiring.get("pinned");
    check("a retirement that cannot remove the snapshot keeps the name held and says why", existsSync(path) && (held?.lastError ?? "").includes(path), held);
    await S.M.driveStaticRetirement({ id: seat.id, name: "pinned", lifecycleUid: d!.lifecycleUid }, true);
    check("and the retried terminal removes it and frees the name", !existsSync(path) && !S.M.retiring.has("pinned"));
  }
  {
    // The inline directory replaced by a link to another directory that holds a file of the same name.
    const d = okData(await spawnAs(undefined, "linked", { persona: { prompt: "x" } }));
    const seat = seatOf(S.M, "linked")!;
    const outside = join(scratch, "outside-free");
    mkdirSync(outside);
    const bait = join(outside, `${d!.lifecycleUid}.md`);
    writeFileSync(bait, "not a snapshot\n");
    const restore = linkedInlineDir(workspaceRoot, outside);
    await exitAndSettle(S.M, S.seats, "linked");
    restore();
    check("a seat's retirement never removes through a linked inline directory", existsSync(bait), d);
    check("and it keeps the name held, saying why", /symlink/.test(S.M.retiring.get("linked")?.lastError ?? ""), S.M.retiring.get("linked"));
    await S.M.driveStaticRetirement({ id: seat.id, name: "linked", lifecycleUid: d!.lifecycleUid }, true);
    check("control: once the directory is real again, the terminal removes the snapshot", !existsSync(inlineSnapshotPath(workspaceRoot, d!.lifecycleUid)));
  }
  {
    let accepted = { uid: "", actor: "" };
    let restore = () => {};
    const outside = join(scratch, "outside-rollback");
    mkdirSync(outside);
    S.failLaunch.add("linkfail");
    S.beforeLaunch.set("linkfail", () => {
      writeFileSync(join(outside, `${accepted.uid}.md`), "not a snapshot\n");
      restore = linkedInlineDir(workspaceRoot, outside);
    });
    await spawnAs(undefined, "linkfail", { persona: { prompt: "x" } }, {
      onAccepted: (a: { lifecycleUid: string; identity: { id: string } }) => { accepted = { uid: a.lifecycleUid, actor: a.identity.id }; },
    }).catch(() => undefined);
    await Promise.allSettled([...S.M.deprovisioningFlight.values()]);
    restore();
    check("a failed spawn's rollback never removes through a linked inline directory", accepted.uid !== "" && existsSync(join(outside, `${accepted.uid}.md`)));
    await S.M.driveStaticRetirement({ id: accepted.actor, name: "linkfail", lifecycleUid: accepted.uid }, true);
    check("control: once the directory is real again, the terminal removes the snapshot the spawn wrote", !existsSync(inlineSnapshotPath(workspaceRoot, accepted.uid)));
  }

  console.log("stop with agents");
  {
    // The public stop: each inline seat's snapshot goes, and a snapshot it cannot remove is reported
    // from the terminal while that seat's grant still goes.
    const root = join(scratch, "stop");
    mkdirSync(join(root, ".cotal"), { recursive: true });
    const T = managerAt(root, { auth: true });
    stoppable(T.mgr);
    const start = (name: string) => T.mgr.startAgent({ name, agent: "smoke-inline", events: false, persona: { prompt: "x" } });
    const owned = okData(await start("stop_owned"));
    const blocked = okData(await start("stop_blocked"));
    check("control: two inline seats run before the stop", owned !== undefined && blocked !== undefined);
    // The blocked seat's snapshot path holds a directory, which a removal refuses.
    const blockedPath = inlineSnapshotPath(root, blocked!.lifecycleUid);
    rmSync(blockedPath);
    mkdirSync(blockedPath);
    writeFileSync(join(blockedPath, "inside"), "x");
    const { value: stopped, lines } = await errorsDuring(() => T.mgr.stop({ withAgents: true }).then(() => "stopped", (e: unknown) => String(e)));
    check("control: the stop with agents completes", stopped === "stopped", stopped);
    check("a stop with agents removes an inline seat's snapshot", !existsSync(inlineSnapshotPath(root, owned!.lifecycleUid)));
    check("and tears down the grant of a seat whose snapshot it cannot remove", !existsSync(agentLifecycleSecretFilePaths(root, space, "stop_blocked", blocked!.lifecycleUid).creds));
    check("and reports that snapshot from its terminal", lines.some((l) => l.includes("static retirement stop_blocked") && l.includes(blockedPath)), lines.filter((l) => l.includes("stop_blocked")));
    rmSync(blockedPath, { recursive: true });
  }

  console.log("the door guard");
  {
    const d = okData(await spawnAs(undefined, "guarded", { persona: { prompt: "x" } }));
    const path = inlineSnapshotPath(workspaceRoot, d!.lifecycleUid);
    check("a config path at a live snapshot is refused", refused(await spawnAs(undefined, "thief", { config: path }), /is an inline persona's snapshot/));
    symlinkSync(path, catalog("alias"));
    check("so is a catalog entry that links to one", refused(await spawnAs(undefined, "alias"), /is an inline persona's snapshot/));
    const resolveAgent = await S.M.spawnPersona({ name: "thief", config: path }, undefined, undefined);
    check("and the resolve-agent door refuses it the same way", /is an inline persona's snapshot/.test(resolveAgent.error ?? ""), resolveAgent);
    check("control: a catalog persona still spawns", (await spawnAs(undefined, "lead", { identity: "lead-again" })).ok);
  }

  console.log("restart and resume");
  {
    const supervise = { restarts: 3, windowMs: 60_000 };
    const keeper = okData(await spawnAs(undefined, "keeper", { persona: { prompt: "x" }, supervise }));
    const steady = okData(await spawnAs(undefined, "steady", { persona: { prompt: "x" }, supervise }));
    check("control: supervised inline seats spawn", keeper !== undefined && steady !== undefined);
    const record = readSeatRecord(workspaceRoot, space, "keeper");
    check("a supervised inline seat's record reads back through the resume schema", record?.agent.launch.source.kind === "inline", record?.agent.launch.source);
    const path = inlineSnapshotPath(workspaceRoot, keeper!.lifecycleUid);
    writeFileSync(path, readFileSync(path, "utf8") + "\nedited\n");
    S.seats.get("keeper")!.exit();
    await until(() => seatOf(S.M, "keeper") === undefined);
    check("a changed snapshot retires a supervised inline seat instead of restarting it", seatOf(S.M, "keeper") === undefined && S.spawned.get("keeper") === 1, S.spawned.get("keeper"));
    check("and its snapshot goes with it", !existsSync(path));
    S.seats.get("steady")!.exit();
    await until(() => (S.spawned.get("steady") ?? 0) > 1);
    check("control: an unchanged snapshot restarts", (S.spawned.get("steady") ?? 0) > 1, S.spawned.get("steady"));
    // A seat whose recorded path, or whose relaunch path, names another file. Each is refused alone.
    // The recorded path moves and keeps the digest of the file the relaunch reads.
    const foreign = join(scratch, "foreign.md");
    writeFileSync(foreign, "---\nname: swapped\n---\nnot the persona this spawn accepted\n", { mode: 0o600 });
    const pair = ["recorded", "relaunched"];
    for (const name of pair) await spawnAs(undefined, name, { persona: { prompt: "x" }, supervise });
    type Supervised = Seat & { restart?: { opts: { configPath?: string } } };
    const recorded = seatOf(S.M, "recorded") as Supervised | undefined;
    const relaunched = seatOf(S.M, "relaunched") as Supervised | undefined;
    check("control: both supervised seats spawned", recorded?.restart !== undefined && relaunched?.restart !== undefined);
    if (recorded) recorded.launch.source.configPath = foreign;
    if (relaunched?.restart) relaunched.restart.opts.configPath = foreign;
    for (const name of pair) S.seats.get(name)!.exit();
    await until(() => pair.every((n) => seatOf(S.M, n) === undefined || (S.spawned.get(n) ?? 0) > 1));
    check("a restart refuses a recorded snapshot path that is not the lifecycle's own", seatOf(S.M, "recorded") === undefined && S.spawned.get("recorded") === 1, S.spawned.get("recorded"));
    check("and a relaunch path that is not the lifecycle's own", seatOf(S.M, "relaunched") === undefined && S.spawned.get("relaunched") === 1, S.spawned.get("relaunched"));
  }
  {
    const d = okData(await spawnAs(undefined, "cut", { persona: { prompt: "x" } }));
    const entry = S.M.resumeEntryOf(seatOf(S.M, "cut")!);
    check("an inline seat's resume entry passes the resume cut", S.M.inventoryReferenceError(entry) === undefined, S.M.inventoryReferenceError(entry));
    const elsewhere = join(scratch, "elsewhere.md");
    writeFileSync(elsewhere, readFileSync(entry.launch.source.configPath));
    const moved = { ...entry, dependencies: [elsewhere], launch: { ...entry.launch, source: { ...entry.launch.source, configPath: elsewhere } } };
    check("a resume entry whose inline snapshot is not its lifecycle's path is refused", /is not this lifecycle's snapshot path/.test(S.M.inventoryReferenceError(moved) ?? ""), S.M.inventoryReferenceError(moved));
    writeFileSync(entry.launch.source.configPath, "---\nname: cut\n---\nchanged\n");
    check("a changed snapshot fails the resume cut", /launch config changed since it became effective/.test(S.M.inventoryReferenceError(entry) ?? ""), d);
  }

  console.log("open mesh");
  {
    const root = join(scratch, "open");
    mkdirSync(join(root, ".cotal"), { recursive: true });
    const O = managerAt(root, {});
    const d = okData(await O.mgr.startAgent({ name: "free", agent: "smoke-inline", events: false, persona: { prompt: "x" } }));
    const path = d ? inlineSnapshotPath(root, d.lifecycleUid) : "";
    check("control: an open-mesh inline seat has a snapshot", d !== undefined && existsSync(path), d);
    O.seats.get("free")!.exit();
    await until(() => !existsSync(path));
    check("an open-mesh inline seat's snapshot goes when its seat exits", !existsSync(path));
    O.failLaunch.add("fragile");
    const r = await O.mgr.startAgent({ name: "fragile", agent: "smoke-inline", events: false, persona: { prompt: "x" } });
    check("an open-mesh spawn that fails after its snapshot removes it", !r.ok && snapshots(root).length === 0, snapshots(root));
    // An open mesh runs no teardown that could retry: the failure is logged with the path, and the
    // operator removes the file.
    const stuck = okData(await O.mgr.startAgent({ name: "unremovable", agent: "smoke-inline", events: false, persona: { prompt: "x" } }));
    const stuckPath = stuck ? inlineSnapshotPath(root, stuck.lifecycleUid) : "";
    chmodSync(inlinePersonaDir(root), 0o500);
    const { lines } = await errorsDuring(async () => {
      O.seats.get("unremovable")!.exit();
      await until(() => seatOf(O.M, "unremovable") === undefined);
    });
    chmodSync(inlinePersonaDir(root), 0o700);
    check("an open-mesh retirement that cannot remove the snapshot logs its path and leaves the file", existsSync(stuckPath) && lines.some((l) => l.includes("could not be removed") && l.includes(stuckPath)), lines);
    rmSync(stuckPath);
    const last = okData(await O.mgr.startAgent({ name: "last", agent: "smoke-inline", events: false, persona: { prompt: "x" } }));
    stoppable(O.mgr);
    const stopped = await O.mgr.stop({ withAgents: true }).then(() => "stopped", (e: unknown) => String(e));
    check("an open-mesh stop with agents removes an inline seat's snapshot", stopped === "stopped" && last !== undefined && !existsSync(inlineSnapshotPath(root, last.lifecycleUid)), stopped);
  }

  console.log("preserve, resume, retire");
  {
    // The public cut, stop and resume on an open mesh: the snapshot survives the cut and its stop,
    // the replacement launches from it, and the resumed seat's retirement removes it.
    const root = join(scratch, "preserve");
    mkdirSync(join(root, ".cotal"), { recursive: true });
    const A = managerAt(root, {});
    stoppable(A.mgr);
    const d = okData(await A.mgr.startAgent({ name: "carried", agent: "smoke-inline", events: false, persona: { prompt: "carried across" } }));
    const path = d ? inlineSnapshotPath(root, d.lifecycleUid) : "";
    let inventory: ManagerResumeInventory | undefined;
    const cut = await A.mgr.preserveState({ attemptId: "inline-cut", persistInventory: async (inv) => { inventory = inv; } });
    const stopped = await A.mgr.stop().then(() => "stopped", (e: unknown) => String(e));
    check("control: the preservation cut and its stop complete", cut.ok && stopped === "stopped" && inventory !== undefined, { cut, stopped });
    check("a preservation cut and its stop keep the inline snapshot", existsSync(path));
    const B = managerAt(root, {});
    const resumed = await B.mgr.resumePreserved(inventory!);
    const seat = seatOf(B.M, "carried");
    check("a replacement manager resumes the inline seat from its snapshot", resumed.ok && seat?.launch.source.kind === "inline" && seat.launch.source.configPath === path && B.spawned.get("carried") === 1, resumed);
    await exitAndSettle(B.M, B.seats, "carried");
    check("and the resumed seat's retirement removes the snapshot", !existsSync(path));
  }

  console.log("user-auth mesh");
  {
    // The ledger is the bound on a user-auth mesh, and it runs inside the grant: the real provider,
    // with the spawner's row reading review only and the record asking for general.
    const { ensureCalloutAuth, findActorUnified, grantActor } = await import("@cotal-ai/auth");
    const root = join(scratch, "user");
    mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
    const U = managerAt(root, {});
    (U.mgr as unknown as { userMode: boolean }).userMode = true;
    await ensureCalloutAuth(workspaceSecretStore(root), { space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
    const owner = "u_smokeownersmokeownersmokeo";
    const ledger = userAuthStateDir(root, space);
    grantActor(ledger, { owner, actor: "parent", scope: ["spawn"], allowSubscribe: ["review"], allowPublish: [], label: "smoke spawner" });
    const spawner = principalKey(owner, "parent").key;
    const r = await U.mgr.startAgent({ name: "wide", agent: "smoke-inline", events: false, persona: { prompt: "x", allowSubscribe: ["general"], save: true } }, spawner);
    check("the ledger refuses an inline record wider than its spawner's row", refused(r, /would exceed its spawner's grant.*read \[general\] beyond \[review\]/), r);
    check("control: and writes no row for it", findActorUnified(ledger, owner, "wide") === undefined);
    check("a refused user-auth grant leaves no catalog file", !existsSync(join(root, ".cotal", "agents", "wide.md")));
    check("and no snapshot", snapshots(root).length === 0, snapshots(root));
    // define-persona reads the same row: the definer puts only capabilities its scope carries.
    const defineAs = (who: string, name: string, capabilities: string[]) => U.M.opDefinePersona({ name, persona: "x", capabilities }, who, false);
    const definedPath = (name: string) => join(root, ".cotal", "agents", `${name}.md`);
    const kept = await defineAs(spawner, "scoped", ["spawn"]);
    check("a user-auth definer may put a capability its row holds into a persona", kept.ok && JSON.stringify(loadAgentFile(definedPath("scoped")).capabilities) === JSON.stringify(["spawn"]), kept);
    const over = await defineAs(spawner, "runner", ["run"]);
    check("and is refused one its row does not hold, by name, writing nothing", refused(over, /grants more than the definer holds: capabilities run beyond \[spawn\]/) && !existsSync(definedPath("runner")), over);
    const stranger = await defineAs(principalKey(owner, "stranger").key, "foreign", ["spawn"]);
    check("a user-auth definer with no row puts no capability into a persona", refused(stranger, /has no grant in this space/) && !existsSync(definedPath("foreign")), stranger);
    // A grant can settle on another uid than the one the spawn allocated: a hosted enrollment picks
    // its own. The spawn rebinds to the returned uid on both user-auth arms, so a grant that returns
    // a different one stands in for the host.
    const hostUid = mintLifecycleUid();
    (U.mgr as unknown as { provisionUserAgent: (name: string) => Promise<unknown> }).provisionUserAgent = async (name: string) => ({
      owner,
      lifecycleUid: hostUid,
      files: agentLifecycleSecretFilePaths(root, space, name, hostUid),
      launch: { owner, actor: name, sentinelCredsPath: join(root, "sentinel.creds"), bearerCmd: ["true"] },
    });
    const hosted = await U.mgr.startAgent({ name: "hosted", agent: "smoke-inline", events: false, persona: { prompt: "x" } }, spawner);
    check("control: the user-auth spawn settles on the grant's uid", okData(hosted)?.lifecycleUid === hostUid, hosted);
    check("a user-auth snapshot is keyed by the uid the grant settled on", JSON.stringify(snapshots(root)) === JSON.stringify([`${hostUid}.md`]) && seatOf(U.M, "hosted")?.launch.source.configPath === inlineSnapshotPath(root, hostUid), snapshots(root));
    // The user-auth teardown does not remove snapshots, so a failed removal at the free is logged with
    // the path and the operator removes the file.
    const hostedPath = inlineSnapshotPath(root, hostUid);
    chmodSync(inlinePersonaDir(root), 0o500);
    const { lines } = await errorsDuring(async () => {
      U.seats.get("hosted")!.exit();
      await until(() => seatOf(U.M, "hosted") === undefined);
    });
    chmodSync(inlinePersonaDir(root), 0o700);
    check("a user-auth retirement that cannot remove the snapshot logs its path and leaves the file", existsSync(hostedPath) && lines.some((l) => l.includes("could not be removed") && l.includes(hostedPath)), lines);
  }
} finally {
  await stopBroker();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\nSPAWN-INLINE-PERSONA SMOKE ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
