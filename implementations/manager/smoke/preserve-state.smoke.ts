import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEV_OWNER,
  createSpaceAuth,
  mintCreds,
  newIdentity,
  principalKey,
  registry,
  type AgentHandle,
  type AttachSession,
  type AuthProvider,
  type Connector,
  type LaunchOpts,
  type LaunchSpec,
} from "@cotal-ai/core";
import { authDir, agentLifecycleSecretFilePaths } from "@cotal-ai/workspace";
import { Manager, type ManagerResumeAgent, type ManagerResumeInventory } from "../src/manager.js";
import { MAX_RESUME_CONTROL_BYTES } from "../src/resume.js";

let failures = 0;
function check(label: string, condition: boolean, extra?: unknown): void {
  console.log(`${condition ? "ok" : "not ok"} - ${label}${condition ? "" : `: ${String(extra ?? "")}`}`);
  if (!condition) failures++;
}

interface FakeHandle extends AgentHandle {
  stops: number;
}

function fakeHandle(name: string, opts: { throwOnStop?: boolean } = {}): FakeHandle {
  let state: "running" | "exited" = "running";
  const exits = new Set<() => void>();
  const session: AttachSession = {
    cols: 80,
    rows: 24,
    backlog: () => Buffer.alloc(0),
    onData: () => () => {},
    onExit: (fn) => { exits.add(fn); return () => exits.delete(fn); },
    write: () => {},
    resize: () => {},
  };
  const handle: FakeHandle = {
    name,
    kind: "fake",
    stops: 0,
    status: () => state,
    stop: () => {
      handle.stops++;
      if (opts.throwOnStop) throw new Error("simulated stop failure");
      state = "exited";
      for (const fn of exits) fn();
    },
    waitForExit: () => state === "exited"
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const done = (): void => { exits.delete(done); resolve(); };
          exits.add(done);
        }),
    interrupt: () => {},
    attach: () => session,
  };
  return handle;
}

/** A handle whose stop leaves the child DYING: `waitForExit` stays pending until `finishExit`. A
 *  real pty exits on its own clock, so this is the only shape that separates an accepted stop from
 *  its exit proof — `fakeHandle` exits inside `stop()`, which hides that gap entirely. */
function lingeringHandle(name: string): AgentHandle & { finishExit(): void } {
  let state: "running" | "exited" = "running";
  let release = (): void => {};
  const exited = new Promise<void>((resolve) => { release = resolve; });
  return {
    name,
    kind: "fake",
    status: () => state,
    stop: () => {},
    waitForExit: () => exited,
    interrupt: () => {},
    attach: () => { throw new Error("lingering handle has no attach stream"); },
    finishExit: () => { state = "exited"; release(); },
  };
}

function silentExitHandle(name: string): AgentHandle & { exitSilently(): void } {
  let state: "running" | "exited" = "running";
  return {
    name,
    kind: "fake",
    status: () => state,
    stop: () => { state = "exited"; },
    waitForExit: async () => {},
    interrupt: () => {},
    attach: () => { throw new Error("external runtime has no attach stream"); },
    exitSilently: () => { state = "exited"; },
  };
}

const root = mkdtempSync(join(tmpdir(), "cotal-preserve-"));
const agentsDir = join(root, ".cotal", "agents");
const runDir = join(root, ".cotal", "run");
const runAgentsDir = join(runDir, "r1", "agents");
mkdirSync(agentsDir, { recursive: true });
mkdirSync(runAgentsDir, { recursive: true });
const personaPath = join(agentsDir, "worker.md");
const runPersonaPath = join(runAgentsDir, "worker.md");
writeFileSync(personaPath, "---\nname: worker\n---\nworker persona\n");
writeFileSync(runPersonaPath, "---\nname: worker\n---\nworker persona\n");
writeFileSync(join(runDir, "r1.json"), JSON.stringify({
  apiVersion: "cotal-launch/v1",
  space: "preserve-smoke",
  runId: "r1",
  agents: [{
    name: "worker",
    agent: "preserve-connector",
    subscribe: ["general"],
    allowSubscribe: ["general"],
    allowPublish: [],
    hash: "abc123",
  }],
}));
const digest = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const inventoryOf = (...agents: ManagerResumeAgent[]): ManagerResumeInventory => ({
  version: "cotal-manager-resume/v1",
  space: "preserve-smoke",
  createdAt: new Date().toISOString(),
  agents,
});

function managerWith(
  runtimeSpawn: (name: string, spec: LaunchSpec, cwd: string) => AgentHandle,
  opts: { resumeAttemptId?: string; resumeDurableCommitToken?: string } = {},
): Manager {
  const manager = new Manager({
    space: "preserve-smoke",
    runtime: "pty",
    workspaceRoot: root,
    preserveStopTimeoutMs: 50,
    resumeAttemptId: opts.resumeAttemptId,
    resumeDurableCommitToken: opts.resumeDurableCommitToken,
  });
  const agents = (manager as unknown as { agents: Map<string, { id: string; name: string; userOwner?: string; lifecycleUid?: string }> }).agents;
  (manager as unknown as { runtime: unknown }).runtime = { kind: "fake", spawn: runtimeSpawn };
  (manager as unknown as { probeStaticCredential: () => Promise<{ ok: true }> }).probeStaticCredential = async () => ({ ok: true });
  (manager as unknown as { ep: unknown }).ep = {
    ref: () => ({ id: "local.manager", name: "manager", role: "manager" }),
    // The real endpoint publishes the incarnation's lifecycleUid in presence whenever it has one
    // (endpoint.ts publishPresence); the readiness lifecycle fence matches on it, so the fake roster
    // must carry it too or a resumed agent (which now recovers its uid) never reports STARTED.
    getRoster: () => [...agents.values()].map((a) => ({
      card: { id: a.userOwner ? a.id : principalKey(DEV_OWNER, a.id).key, name: a.name },
      lifecycleUid: a.lifecycleUid,
      status: "idle",
    })),
    waitForPresenceSnapshot: async () => {},
    on: () => {},
    off: () => {},
    releaseManagerLease: async () => {},
    stop: async () => {},
  };
  (manager as unknown as { attach: unknown }).attach = { stop: async () => {} };
  return manager;
}

type Reply = { ok: boolean; data?: unknown; error?: string };
// 1d: the manager `ctl` `handle` router is deleted; each op is a door-shared method the ep serve
// path calls. This test helper drives the SAME methods with the SAME framing the ep door uses:
//  - the resume/preservation FAMILY bypasses the admission fence (the ep door wraps them in
//    `adminGated`, not `serveGated`, so they run WHILE `resumeRequired` fences ordinary work);
//  - ordinary ops (`models`, `stop`) ride the shared `admitControl` fence (serveGated's core — the
//    drain gate preserveState waits on). The admin authority is now the ep credential boundary +
//    `adminGated` (proven in manager-split/manager-service-ops), not a tier arg here.
const control = async (manager: Manager, _tier: string, op: string, args: Record<string, unknown>): Promise<Reply> => {
  const m = manager as unknown as {
    opResumePreserved: (a: unknown) => Promise<Reply>;
    opCommitResume: (a: unknown) => Promise<Reply>;
    opFinalizeResume: (a: unknown) => Promise<Reply>;
    opPreservationCtl: (op: string, a: unknown) => Promise<Reply>;
    opModels: (a: Record<string, unknown>) => Promise<Reply>;
    opStop: (a: Record<string, unknown>, caller: string, admin: boolean) => Promise<Reply>;
    list: (filter?: string) => unknown[];
    psOwnerFilter: (caller: string, admin: boolean) => Promise<string | undefined>;
    admitControl: (caller: string) => { refusal?: string; release?: () => void };
  };
  if (op === "resumePreserved") return m.opResumePreserved(args);
  if (op === "commitResume") return m.opCommitResume(args);
  if (op === "finalizeResume") return m.opFinalizeResume(args);
  if (op === "preparePreservation" || op === "commitPreservation" || op === "abortPreservation") return m.opPreservationCtl(op, args);
  // Ordinary op: run through the admission fence (the ep door's serveGated core).
  const admission = m.admitControl("local.operator");
  if (admission.refusal !== undefined) return { ok: false, error: admission.refusal };
  try {
    if (op === "models") return await m.opModels(args);
    if (op === "stop") return await m.opStop(args, "local.operator", true);
    if (op === "ps") return { ok: true, data: m.list(await m.psOwnerFilter("local.operator", true)) };
    return { ok: false, error: `unknown op: ${op}` };
  } finally {
    admission.release?.();
  }
};

// A deterministic valid incarnation uid ([a-z0-9]{26,32}) per agent, so preserved inventory carries
// the exact value a real ManagedAgent would (spawn mints it, resume recovers it) and the smoke can
// assert it threads inventory -> LaunchOpts unchanged.
const uidFor = (name: string): string => (name.replace(/[^a-z0-9]/g, "") + "0".repeat(26)).slice(0, 26);

function managed(name: string, id: string, handle: AgentHandle, source: "manifest" | "persona" = "manifest") {
  return {
    name,
    role: "worker",
    agent: "preserve-connector",
    id,
    lifecycleUid: uidFor(name),
    seed: "TOP-SECRET-SEED",
    spawner: "local.manager",
    startedAt: 1_700_000_000_000,
    handle,
    control: { path: "/tmp/control.sock", token: "TOP-SECRET-CONTROL" },
    launch: {
      source: source === "manifest"
        ? { kind: "manifest", runId: "r1", requested: "worker", hash: "abc123", configPath: runPersonaPath, configSha256: digest(runPersonaPath), manifestSha256: digest(join(runDir, "r1.json")) }
        : { kind: "persona", ref: "worker", configPath: personaPath, configSha256: digest(personaPath) },
      cwd: root,
      model: "test-model",
      subscribe: ["general"],
      allowSubscribe: ["general"],
      allowPublish: [],
      capabilities: ["spawn"],
      events: false,
    },
  };
}

let capturedLaunch: LaunchOpts | undefined;
const connector: Connector = {
  kind: "connector",
  name: "preserve-connector",
  buildLaunch: (opts) => {
    capturedLaunch = opts;
    return { command: "true", args: [], env: {} };
  },
};
registry.register(connector);

let retainedValidationCalls = 0;
let retainedGrantCalls = 0;
let afterRetainedValidation: (() => void) | undefined;
let lastRetainedInput: { actorToken?: string; sentinelCreds?: string } | undefined;
let retainedAuthority = {
  owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  actor: "worker",
  // Must equal the user entry's inventory uid: the manager binds the two before any spawn.
  lifecycleUid: uidFor("userworker"),
  scope: [] as string[],
  allowSubscribe: ["general"],
  allowPublish: [] as string[],
  role: "worker",
  parent: undefined as string | undefined,
};
registry.register({
  kind: "auth-provider",
  name: "preserve-auth",
  agentBearerCommand: "agent-bearer",
  validateRetainedAgent: async (input) => {
    retainedValidationCalls++;
    lastRetainedInput = input;
    const result = { ...retainedAuthority };
    afterRetainedValidation?.();
    return result;
  },
  grantAgent: async () => {
    retainedGrantCalls++;
    throw new Error("grantAgent must not run during resume");
  },
} as unknown as AuthProvider);

// Fence and drain: an accepted async control request completes before children stop, while later
// lifecycle work is rejected immediately. The exit watcher fires from stop() but must not clean up.
{
  let releaseModels!: () => void;
  const modelsGate = new Promise<void>((resolve) => { releaseModels = resolve; });
  registry.register({
    kind: "connector",
    name: "preserve-slow-models",
    listModels: async () => { await modelsGate; return { models: [] }; },
    buildLaunch: () => ({ command: "true", args: [] }),
  } satisfies Connector);
  const manager = managerWith((name) => fakeHandle(name));
  const handle = fakeHandle("worker");
  const map = (manager as unknown as { agents: Map<string, unknown> }).agents;
  map.set("worker", managed("worker", "open_principal_1", handle));
  let deprovisions = 0;
  (manager as unknown as { deprovision: () => Promise<void> }).deprovision = async () => { deprovisions++; };
  (manager as unknown as { watchExit: (a: unknown) => void }).watchExit(map.get("worker"));

  const accepted = control(manager, "admin", "models", { agent: "preserve-slow-models" });
  let persistenceStarted!: () => void;
  let releasePersistence!: () => void;
  const persisting = new Promise<void>((resolve) => { persistenceStarted = resolve; });
  const persisted = new Promise<void>((resolve) => { releasePersistence = resolve; });
  const preserving = manager.preserveState({
    attemptId: "fence",
    persistInventory: async () => { persistenceStarted(); await persisted; },
  });
  const rejected = await manager.startAgent({ name: "worker", agent: "preserve-connector" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  check("fence rejects lifecycle work after preservation begins", !rejected.ok && /fenced/.test(rejected.error ?? ""), rejected.error);
  check("preservation waits for accepted in-flight work before stopping", handle.stops === 0, handle.stops);
  releaseModels();
  await accepted;
  await persisting;
  check("no child stops before the coordinator durably persists inventory", handle.stops === 0, handle.stops);
  releasePersistence();
  const result = await preserving;
  check("preservation completes after in-flight drain", result.ok && result.state === "preserved", result);
  check("preservation hard-stops the child", handle.stops === 1, handle.stops);
  check("preservation and its exit watcher never deprovision", deprovisions === 0, deprovisions);
  const json = JSON.stringify(result.inventory);
  check("inventory is JSON-persistable", JSON.parse(json).version === "cotal-manager-resume/v1");
  check("inventory records the exact same principal", result.inventory.agents[0]?.identity.mode === "open" && result.inventory.agents[0].identity.id === "open_principal_1", result.inventory.agents[0]);
  check("inventory records effective connector/runtime/cwd references", result.inventory.agents[0]?.launch.connector === "preserve-connector" && result.inventory.agents[0]?.launch.runtime === "fake" && result.inventory.agents[0]?.launch.cwd === root, result.inventory.agents[0]?.launch);
  check("inventory preserves .cotal/run dependencies", result.inventory.agents[0]?.dependencies.includes(join(runDir, "r1.json")) === true && result.inventory.agents[0]?.dependencies.includes(runPersonaPath) === true, result.inventory.agents[0]?.dependencies);
  check("inventory excludes seed and control token values", !json.includes("TOP-SECRET-SEED") && !json.includes("TOP-SECRET-CONTROL"), json);
  check("same preservation attempt is idempotent", (await manager.preparePreservation("fence")).state === "preserved");
  let refusedDifferent = false;
  try { await manager.preparePreservation("different"); } catch { refusedDifferent = true; }
  check("different preservation attempt is refused after fencing", refusedDifferent);
}

// An abandoned prepare can return to active only before commit starts.
{
  const manager = managerWith((name) => fakeHandle(name));
  (manager as unknown as { lifecycleInFlight: number }).lifecycleInFlight = 1;
  const preparing = manager.preparePreservation("abandon");
  let refusedPreparingAbort = false;
  try { manager.abortPreservation("abandon"); } catch (e) {
    refusedPreparingAbort = /still preparing or draining/.test((e as Error).message);
  }
  check("abort refuses while preparation is draining in-flight lifecycle work", refusedPreparingAbort);
  (manager as unknown as { releaseLifecycle: () => void }).releaseLifecycle();
  const prepared = await preparing;
  check("empty abandoned attempt prepares without stopping", prepared.ok && prepared.state === "prepared");
  const abandonedGeneration = (manager as unknown as { preservationGeneration: number }).preservationGeneration;
  manager.abortPreservation("abandon");
  const next = await manager.preparePreservation("replacement");
  check("pre-commit abort permits a new preservation attempt", next.ok && next.attemptId === "replacement");
  let staleRejected = false;
  try {
    await (manager as unknown as { runPreparation: (attemptId: string, generation: number) => Promise<unknown> })
      .runPreparation("abandon", abandonedGeneration);
  } catch (e) {
    staleRejected = /abandoned/.test((e as Error).message);
  }
  check("an abandoned generation cannot publish inventory into its replacement", staleRejected);
  manager.abortPreservation("replacement");
}

// An accepted pre-fence destructive stop includes its detached deprovision in the drain. The
// preserved inventory is taken only after that operation has fully completed.
{
  const manager = managerWith((name) => fakeHandle(name));
  const handle = fakeHandle("precut");
  const map = (manager as unknown as { agents: Map<string, unknown> }).agents;
  map.set("precut", managed("precut", "precut_id", handle, "persona"));
  let releaseDeprovision!: () => void;
  let deprovisionStarted!: () => void;
  const started = new Promise<void>((resolve) => { deprovisionStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseDeprovision = resolve; });
  (manager as unknown as { deprovision: () => Promise<void> }).deprovision = async () => {
    deprovisionStarted();
    await blocked;
  };
  const stop = control(manager, "admin", "stop", { name: "precut", graceful: false });
  const preserving = manager.preserveState({ attemptId: "precut", persistInventory: async () => {} });
  await started;
  let settled = false;
  void preserving.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  check("preservation drains detached cleanup from accepted pre-fence work", !settled);
  releaseDeprovision();
  await stop;
  const result = await preserving;
  check("completed pre-fence stop is absent from resume inventory", result.ok && result.inventory.agents.length === 0, result.inventory.agents);
}

// Partial failure: every child is attempted, successful children are retained without cleanup, and
// the manager stays fenced in preserving state so a caller cannot publish a ready cut.
{
  const manager = managerWith((name) => fakeHandle(name));
  const good = fakeHandle("good");
  const bad = fakeHandle("bad", { throwOnStop: true });
  const map = (manager as unknown as { agents: Map<string, unknown> }).agents;
  map.set("good", managed("good", "open_good", good, "persona"));
  map.set("bad", managed("bad", "open_bad", bad, "persona"));
  let deprovisions = 0;
  (manager as unknown as { deprovision: () => Promise<void> }).deprovision = async () => { deprovisions++; };
  const result = await manager.preserveState({ attemptId: "partial", persistInventory: async () => {} });
  check("partial stop reports failure and no preserved state", !result.ok && result.state === "preserving", result);
  check("partial stop attempts every child", good.stops === 1 && bad.stops === 1, `${good.stops}/${bad.stops}`);
  check("partial stop names the failed child", result.failures.length === 1 && result.failures[0]?.name === "bad", result.failures);
  check("partial stop retains the full pre-stop inventory", result.inventory.agents.length === 2, result.inventory.agents);
  check("partial stop performs no deprovision", deprovisions === 0, deprovisions);
}

// A runtime without an authoritative wait contract is never accepted as a completed cut, even if
// its synchronous status happens to change after stop.
{
  const manager = managerWith((name) => fakeHandle(name));
  const handle = fakeHandle("unverified");
  delete (handle as { waitForExit?: () => Promise<void> }).waitForExit;
  (manager as unknown as { agents: Map<string, unknown> }).agents.set(
    "unverified",
    managed("unverified", "unverified_id", handle, "persona"),
  );
  const result = await manager.preserveState({ attemptId: "unverified", persistInventory: async () => {} });
  check("runtime without waitForExit fails the cut closed", !result.ok && /cannot prove child exit/.test(result.failures[0]?.error ?? ""), result.failures);
}

// Recursive reap never frees a descendant until stop+wait proves it exited. If descendants remain
// running, preservation drains the reap, reports the failed proof, and inventories every live slot.
{
  const manager = managerWith((name) => fakeHandle(name));
  const stuck = (name: string): FakeHandle => {
    const handle = fakeHandle(name);
    handle.stop = () => { handle.stops++; };
    handle.waitForExit = () => new Promise<void>(() => {});
    return handle;
  };
  const child = stuck("reap-child");
  const grandchild = stuck("reap-grandchild");
  const map = (manager as unknown as { agents: Map<string, unknown> }).agents;
  const deadParent = principalKey(DEV_OWNER, "dead_parent").key;
  const childPrincipal = principalKey(DEV_OWNER, "reap_child").key;
  map.set("reap-child", { ...managed("reap-child", "reap_child", child, "persona"), spawner: deadParent });
  map.set("reap-grandchild", { ...managed("reap-grandchild", "reap_grandchild", grandchild, "persona"), spawner: childPrincipal });
  (manager as unknown as { reapChildrenOf: (id: string) => void }).reapChildrenOf(deadParent);
  check("recursive reap starts every descendant stop", child.stops === 1 && grandchild.stops === 1, `${child.stops}/${grandchild.stops}`);
  check("recursive reap retains slots while descendants may still live", map.has("reap-child") && map.has("reap-grandchild"), [...map.keys()]);
  const plan = await manager.preparePreservation("reap-live");
  check("preservation fails closed when recursive descendants cannot prove exit", !plan.ok && plan.failures.filter((f) => /accepted stop could not prove exit/.test(f.error)).length === 2, plan.failures);
  check("still-running recursive descendants remain in preservation inventory", plan.inventory.agents.map((a) => a.name).sort().join(",") === "reap-child,reap-grandchild", plan.inventory.agents);
}

// Same-principal open resume: a fresh active manager adopts the retained id exactly, without
// provisioning or name auto-numbering, and resolves manifest launch options from the retained run.
let openInventory: ManagerResumeAgent;
{
  openInventory = {
    space: "preserve-smoke",
    name: "worker",
    role: "worker",
    identity: { mode: "open", id: "open_principal_resume", lifecycleUid: uidFor("resume") },
    launch: {
      connector: "preserve-connector",
      runtime: "fake",
      cwd: root,
      source: { kind: "manifest", runId: "r1", requested: "worker", hash: "abc123", configPath: runPersonaPath, configSha256: digest(runPersonaPath), manifestSha256: digest(join(runDir, "r1.json")) },
      subscribe: ["general"],
      allowSubscribe: ["general"],
      allowPublish: [],
      events: false,
    },
    dependencies: [join(runDir, "r1.json"), runPersonaPath],
    spawner: "local.manager",
    startedAt: new Date().toISOString(),
  };
  const manager = managerWith((name) => fakeHandle(name));
  capturedLaunch = undefined;
  const result = await manager.resumePreserved(inventoryOf(openInventory));
  const reply = result.agents[0]?.reply;
  check("open resume succeeds under the exact retained name", result.ok && reply?.ok && (reply.data as { name?: string })?.name === "worker", JSON.stringify(result));
  check("open resume reuses the exact retained principal", capturedLaunch?.id === "open_principal_resume", capturedLaunch?.id);
  // The recovered incarnation uid MUST reach the child launch (never a fresh mint): its lifecycle-keyed
  // durables are named by it, and the readiness fence matches presence on it.
  check("open resume threads the recovered incarnation uid into launch", capturedLaunch?.lifecycleUid === uidFor("resume"), capturedLaunch?.lifecycleUid);
}

// ── WHERE THE WRITER ACTUALLY PUTS THE PER-AGENT FLAG ──
//
// This cell exists so the migration and its fixture cannot drift back into agreeing with each other
// while both disagree with the disk. The v1→v2 migration originally rewrote the resume document's
// TOP-LEVEL `launch`, and its fixture put the flag there too — one author, one mental model, two
// artifacts that agreed and neither of which matched what `cotal down --preserve-state` writes. The
// document stamped itself v2 and migrated nothing.
//
// So: assert the LOCATION against a real retained inventory, here in the manager where the type is
// real. If `down.ts` ever moves the flag, this cell fails — and the migration cell in the workspace
// suite, which reads from that same location, fails with it. Neither is checking anyone's memory of
// the format.
{
  // openInventory is a real `ManagerResumeAgent` — the same type `down.ts` persists as
  // `replan.inventory` — so this reads the writer's shape, not a literal written here.
  const asJson = JSON.parse(JSON.stringify(inventoryOf(openInventory))) as {
    agents: { launch: Record<string, unknown> }[];
    launch?: Record<string, unknown>;
  };
  check("the per-agent events flag lives at inventory.agents[].launch, NOT at the document's top level",
    "events" in asJson.agents[0].launch && !("events" in (asJson.launch ?? {})),
    { agentLaunchKeys: Object.keys(asJson.agents[0].launch), topLevel: Object.keys(asJson.launch ?? {}) });
}

// ── RESUME MUST PREFLIGHT THE EVENT GRANT, NOT ADOPT IT UNCHECKED ──
//
// A retained entry carries both its provisioned `allowPublish` and its `events` bit. Adopting both
// without checking produces the same false-success launch the foreground spawn path used to: the
// agent returns with COTAL_EVENTS armed on a credential that was never granted the channel, the
// broker denies every frame, and `resume` reports success. Nothing surfaces a denied publish to the
// operator who ran it.
//
// This state is reachable ONLY on resume and outlives the spawn-path fix: an inventory preserved
// BEFORE that fix existed still carries the old grant list, on every machine holding a preserved cut.
// fmae-rev-test proved no fixture covered it — it inserted this very refusal and the whole suite
// still passed. A refusal nothing reddens without is indistinguishable from no refusal.
{
  const eventsConnector: Connector = {
    kind: "connector",
    name: "preserve-events-connector",
    eventChannel: (n: string) => `events.${n.toLowerCase()}`,
    buildLaunch: (opts) => { capturedLaunch = opts; return { command: "true", args: [], env: {} }; },
  };
  registry.register(eventsConnector);

  const entryWith = (allowPublish: string[]): ManagerResumeAgent => ({
    ...openInventory,
    launch: { ...openInventory.launch, connector: "preserve-events-connector", allowPublish, events: true },
  });

  // (a) events enabled, grant MISSING -> refuse, and name the channel so an operator can act
  const denied = await managerWith((name) => fakeHandle(name)).resumePreserved(inventoryOf(entryWith([])));
  const deniedReply = denied.agents[0]?.reply;
  check("resume REFUSES an events-enabled entry whose retained grant lacks the event channel",
    deniedReply?.ok === false, JSON.stringify(denied));
  check("and the refusal names the exact channel that is missing, not just 'invalid'",
    /events\.worker/.test(String(deniedReply?.ok === false ? deniedReply.error : "")), deniedReply);

  // (b) CONTROL — same entry WITH the grant proceeds. Without this, (a) would pass for a wrapper
  // that refused every events-enabled resume, which is a different bug wearing the same green.
  capturedLaunch = undefined;
  const allowed = await managerWith((name) => fakeHandle(name)).resumePreserved(inventoryOf(entryWith(["events.worker"])));
  check("CONTROL: the same entry WITH the grant resumes, so the refusal is specific",
    allowed.agents[0]?.reply?.ok === true && capturedLaunch?.events === true, JSON.stringify(allowed));

  // (c) WILDCARD GRANTS. The first version of this preflight used `allowPublish.includes(required)`
  // — an exact string match, i.e. a LOCAL COPY of the grant rule, and a wrong one. A legitimate
  // `events.>` or `>` genuinely covers `events.worker`, so a check added to prevent a mute stream
  // would instead have REFUSED healthy resumes. The suite could not see it because every fixture
  // granted the exact literal; the fixture only built the case the implementation handled.
  // Found by fmae-rev-sec. These drive `channelInAllow`, the shipped matcher.
  for (const grant of ["events.>", ">", "events.*"]) {
    capturedLaunch = undefined;
    const wild = await managerWith((name) => fakeHandle(name)).resumePreserved(inventoryOf(entryWith([grant])));
    check(`a WILDCARD grant "${grant}" covers the event channel and resumes`,
      wild.agents[0]?.reply?.ok === true, JSON.stringify(wild.agents[0]?.reply));
  }

  // …and a wildcard that does NOT cover it must still refuse, so (c) is not just "accept anything
  // with a dot in it".
  const wrongWild = await managerWith((name) => fakeHandle(name)).resumePreserved(inventoryOf(entryWith(["other.>"])));
  check("a wildcard that does NOT cover the event channel still refuses",
    wrongWild.agents[0]?.reply?.ok === false, JSON.stringify(wrongWild.agents[0]?.reply));
}

// A manager replacement after the coordinator fsyncs commit evidence re-adopts the inventory,
// returns the exact same token, and can finalize without releasing cleanup early.
{
  const attemptId = "restart_after_commit";
  const first = managerWith((name) => fakeHandle(name), { resumeAttemptId: attemptId });
  await control(first, "admin", "resumePreserved", { attemptId, inventory: inventoryOf(openInventory) });
  const committed = await control(first, "admin", "commitResume", { attemptId });
  const durableCommitToken = (committed.data as { durableCommitToken?: string }).durableCommitToken!;
  await first.stop();

  const replacement = managerWith((name) => fakeHandle(name), { resumeAttemptId: attemptId, resumeDurableCommitToken: durableCommitToken });
  const resumed = await control(replacement, "admin", "resumePreserved", { attemptId, inventory: inventoryOf(openInventory) });
  const recommitted = await control(replacement, "admin", "commitResume", { attemptId });
  const finalized = await control(replacement, "admin", "finalizeResume", { attemptId, durableCommitToken });
  check("replacement manager re-adopts retained agents", resumed.ok, resumed.error);
  check("replacement manager returns the fsynced commit token", recommitted.ok && (recommitted.data as { durableCommitToken?: string }).durableCommitToken === durableCommitToken, recommitted);
  check("replacement manager finalizes the original commit", finalized.ok && (finalized.data as { state?: string }).state === "active", finalized);
}

// Abrupt manager death can leave an external-runtime child alive. A replacement must not spawn a
// duplicate process under that exact principal and then mistake the survivor for its own readiness.
{
  const attemptId = "restart_with_survivor";
  let spawns = 0;
  let spawned = false;
  let survivorOffline = false;
  const replacement = managerWith((name) => { spawns++; spawned = true; return fakeHandle(name); }, {
    resumeAttemptId: attemptId,
    resumeDurableCommitToken: "1".repeat(64),
  });
  const survivorInventory = inventoryOf(openInventory);
  const ep = (replacement as unknown as { ep: { getRoster: () => unknown[]; waitForPresenceSnapshot: () => Promise<void> } }).ep;
  let releaseSnapshot!: () => void;
  ep.waitForPresenceSnapshot = () => new Promise<void>((resolveSnapshot) => { releaseSnapshot = resolveSnapshot; });
  ep.getRoster = () => [{
    card: { id: principalKey(DEV_OWNER, openInventory.identity.mode === "open" ? openInventory.identity.id : "").key, name: openInventory.name },
    lifecycleUid: openInventory.identity.mode === "open" ? openInventory.identity.lifecycleUid : undefined,
    status: spawned || !survivorOffline ? "idle" : "offline",
  }];
  const resumePending = control(replacement, "admin", "resumePreserved", { attemptId, inventory: survivorInventory });
  await new Promise((resolveTick) => setTimeout(resolveTick, 0));
  check("replacement waits for the initial presence snapshot before spawn", spawns === 0, spawns);
  releaseSnapshot();
  const resumed = await resumePending;
  check("replacement refuses an already-live retained principal before spawn", !resumed.ok && /already live/.test(resumed.error ?? "") && spawns === 0, resumed.error);
  ep.waitForPresenceSnapshot = async () => {};
  survivorOffline = true;
  const retried = await control(replacement, "admin", "resumePreserved", { attemptId, inventory: survivorInventory });
  check("replacement retry ignores an offline survivor ghost", retried.ok && spawns === 1, retried.error);
}

// Wire resume is admin-only, attempt-bound, and relaunches the exact retained principal.
{
  let spawns = 0;
  const manager = managerWith((name) => { spawns++; return fakeHandle(name); });
  const result = await control(manager, "admin", "resumePreserved", {
    attemptId: "unbound",
    inventory: inventoryOf(openInventory),
  });
  check("wire resume requires a construction-bound startup attempt", !result.ok && /--resume-attempt/.test(result.error ?? "") && spawns === 0, result.error);
}

{
  let spawns = 0;
  const manager = managerWith((name) => { spawns++; return fakeHandle(name); }, { resumeAttemptId: "restore_1" });
  const args = { attemptId: "restore_1", inventory: inventoryOf(openInventory) };
  const gated = await manager.startAgent({ name: "worker", agent: "preserve-connector" });
  check("startup resume gate fences ordinary lifecycle work", !gated.ok && /waiting for resume attempt/.test(gated.error ?? ""), gated.error);
  // 1d: `resumePreserved` is admin-only via the ep credential boundary (the `manager.admin` ep row
  // is minted only into operator instruments — manager-split) + serve-time `adminGated`
  // (manager-service-ops); a merely spawn-capable caller is broker-denied before the handler. There
  // is no in-handler tier reject to assert here anymore, so this section drives the admin path only.
  check("no resume launched before the admin call", spawns === 0, spawns);
  capturedLaunch = undefined;
  const resumed = await control(manager, "admin", "resumePreserved", args);
  check("admin wire resume succeeds", resumed.ok, resumed.error);
  check("wire resume uses the exact retained principal", capturedLaunch?.id === "open_principal_resume", capturedLaunch?.id);
  const data = resumed.data as { attemptId?: string; state?: string; agents?: Array<{ name: string; reply: { ok: boolean } }> };
  check("wire response is attempt-bound with per-agent results", data.attemptId === "restore_1" && data.state === "awaitingCommit" && data.agents?.length === 1 && data.agents[0]?.reply.ok === true, resumed.data);
  const repeated = await control(manager, "admin", "resumePreserved", args);
  check("same attempt and inventory is idempotent", repeated.ok && spawns === 1, `spawns=${spawns}`);
  const changedInventory = { ...args.inventory, createdAt: new Date(Date.now() + 1_000).toISOString() };
  const changed = await control(manager, "admin", "resumePreserved", { attemptId: "restore_1", inventory: changedInventory });
  check("same attempt rejects a different inventory", !changed.ok && /different inventory/.test(changed.error ?? ""), changed.error);
  const wrongAttempt = await control(manager, "admin", "resumePreserved", { ...args, attemptId: "restore_2" });
  check("wire resume rejects a different attempt", !wrongAttempt.ok && /expects resume attempt/.test(wrongAttempt.error ?? ""), wrongAttempt.error);
  const stillGated = await manager.startAgent({ name: "worker", agent: "preserve-connector" });
  check("ordinary lifecycle remains fenced until durable activation commit", !stillGated.ok && /waiting for resume attempt/.test(stillGated.error ?? ""), stillGated.error);
  // `commitResume` is admin-only by the same ep credential boundary (see the resumePreserved note).
  const [committed, committedAgain] = await Promise.all([
    control(manager, "admin", "commitResume", { attemptId: "restore_1" }),
    control(manager, "admin", "commitResume", { attemptId: "restore_1" }),
  ]);
  const commitData = committed.data as { state?: string; durableCommitToken?: string };
  check("admin commit returns durable evidence without releasing the gate", committed.ok && commitData.state === "awaitingFinalize" && /^[a-f0-9]{64}$/.test(commitData.durableCommitToken ?? ""), committed);
  check("concurrent resume commit retries are idempotent with one durable token", committedAgain.ok && (committedAgain.data as { durableCommitToken?: string }).durableCommitToken === commitData.durableCommitToken, committedAgain);
  const stillCommitted = await control(manager, "admin", "models", { agent: "preserve-connector" });
  check("ordinary lifecycle remains fenced after commit", !stillCommitted.ok && /waiting for resume attempt/.test(stillCommitted.error ?? ""), stillCommitted.error);
  // `finalizeResume` is admin-only by the same ep credential boundary (see the resumePreserved note).
  const wrongToken = await control(manager, "admin", "finalizeResume", { attemptId: "restore_1", durableCommitToken: "0".repeat(64) });
  check("resume finalize is bound to commit evidence", !wrongToken.ok && /does not match/.test(wrongToken.error ?? ""), wrongToken.error);
  const finalized = await control(manager, "admin", "finalizeResume", { attemptId: "restore_1", durableCommitToken: commitData.durableCommitToken });
  check("token-bound finalize releases the startup resume gate", finalized.ok && (finalized.data as { state?: string }).state === "active", finalized);
  const finalizedAgain = await control(manager, "admin", "finalizeResume", { attemptId: "restore_1", durableCommitToken: commitData.durableCommitToken });
  check("resume finalize is idempotent", finalizedAgain.ok, finalizedAgain.error);
  const released = await control(manager, "admin", "models", { agent: "preserve-connector" });
  check("ordinary lifecycle is active only after finalize", !/waiting for resume attempt/.test(released.error ?? ""), released.error);
}

// A signal or singleton-lease loss after commit but before finalize remains non-destructive.
{
  const handle = fakeHandle("worker");
  const manager = managerWith(() => handle, { resumeAttemptId: "signal_gap" });
  let deprovisions = 0;
  (manager as unknown as { deprovision: () => Promise<void> }).deprovision = async () => { deprovisions++; };
  await control(manager, "admin", "resumePreserved", { attemptId: "signal_gap", inventory: inventoryOf(openInventory) });
  const committed = await control(manager, "admin", "commitResume", { attemptId: "signal_gap" });
  await manager.stop();
  check("SIGTERM-equivalent stop after commit-before-finalize stops the child", committed.ok && handle.stops === 1, handle.stops);
  check("SIGTERM-equivalent stop after commit-before-finalize preserves retained footprint", deprovisions === 0, deprovisions);
}

{
  const handle = fakeHandle("worker");
  const manager = managerWith(() => handle, { resumeAttemptId: "lease_gap" });
  let deprovisions = 0;
  (manager as unknown as { deprovision: () => Promise<void> }).deprovision = async () => { deprovisions++; };
  await control(manager, "admin", "resumePreserved", { attemptId: "lease_gap", inventory: inventoryOf(openInventory) });
  const committed = await control(manager, "admin", "commitResume", { attemptId: "lease_gap" });
  const ep = (manager as unknown as { ep: Record<string, unknown> }).ep;
  ep.renewManagerLease = async () => { throw new Error("simulated lease loss"); };
  (manager as unknown as { leaseInfo: unknown; leaseRevision: number }).leaseInfo = {
    holder: "local.manager", runtime: "fake", root, pid: process.pid,
  };
  (manager as unknown as { leaseRevision: number }).leaseRevision = 1;
  const originalExit = process.exit;
  let exitCode: number | undefined;
  (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
    exitCode = code;
    return undefined as never;
  });
  try {
    await (manager as unknown as { renewLease: () => Promise<void> }).renewLease();
  } finally {
    (process as unknown as { exit: typeof process.exit }).exit = originalExit;
  }
  check("lease loss after commit-before-finalize exits fail-closed and stops the child", committed.ok && exitCode === 1 && handle.stops === 1, `${exitCode}/${handle.stops}`);
  check("lease loss after commit-before-finalize preserves retained footprint", deprovisions === 0, deprovisions);
}

{
  const handle = silentExitHandle("worker");
  const manager = managerWith(() => handle, { resumeAttemptId: "exit_before_finalize" });
  await control(manager, "admin", "resumePreserved", { attemptId: "exit_before_finalize", inventory: inventoryOf(openInventory) });
  const committed = await control(manager, "admin", "commitResume", { attemptId: "exit_before_finalize" });
  handle.exitSilently();
  const finalized = await control(manager, "admin", "finalizeResume", {
    attemptId: "exit_before_finalize",
    durableCommitToken: (committed.data as { durableCommitToken?: string }).durableCommitToken,
  });
  check("finalize refuses to release suppression if a committed handle stopped", !finalized.ok && /not live at finalize/.test(finalized.error ?? ""), finalized.error);
  const stillFenced = await control(manager, "admin", "models", { agent: "preserve-connector" });
  check("failed finalize keeps ordinary lifecycle fenced", !stillFenced.ok && /waiting for resume attempt/.test(stillFenced.error ?? ""), stillFenced.error);
}

// The strict wire parser rejects secret-bearing unknown fields and oversized payloads before launch.
{
  let spawns = 0;
  const secretManager = managerWith((name) => { spawns++; return fakeHandle(name); });
  const secretInventory = JSON.parse(JSON.stringify(inventoryOf(openInventory))) as Record<string, unknown> & { agents: Array<Record<string, unknown>> };
  secretInventory.agents[0].seed = "must-not-cross-wire";
  const secret = await control(secretManager, "admin", "resumePreserved", { attemptId: "secret", inventory: secretInventory });
  check("wire inventory rejects secret/unknown fields", !secret.ok && /Unrecognized key/.test(secret.error ?? ""), secret.error);
  check("secret-bearing inventory launches nothing", spawns === 0, spawns);

  const largeManager = managerWith((name) => { spawns++; return fakeHandle(name); });
  const largeInventory = JSON.parse(JSON.stringify(inventoryOf(openInventory))) as { agents: Array<{ launch: { model?: string } }> };
  largeInventory.agents[0].launch.model = "x".repeat(MAX_RESUME_CONTROL_BYTES);
  const large = await control(largeManager, "admin", "resumePreserved", { attemptId: "large", inventory: largeInventory });
  check("wire inventory enforces the payload byte bound", !large.ok && /exceed/.test(large.error ?? ""), large.error);
  check("oversized inventory launches nothing", spawns === 0, spawns);
}

// The whole inventory is preflighted before the first child launch.
{
  let spawns = 0;
  const manager = managerWith((name) => { spawns++; return fakeHandle(name); }, { resumeAttemptId: "all_preflight" });
  const missing = join(root, ".cotal", "run", "missing.md");
  const invalid: ManagerResumeAgent = {
    ...openInventory,
    name: "invalid-second",
    identity: { mode: "open", id: "invalid_second", lifecycleUid: uidFor("invalidsecond") },
    launch: {
      ...openInventory.launch,
      source: { kind: "persona", ref: "missing", configPath: missing, configSha256: "0".repeat(64) },
    },
    dependencies: [missing],
  };
  const result = await control(manager, "admin", "resumePreserved", {
    attemptId: "all_preflight",
    inventory: inventoryOf(openInventory, invalid),
  });
  const data = result.data as { agents?: Array<{ name: string; reply: { ok: boolean; error?: string } }> } | undefined;
  check("invalid later inventory entry prevents every launch", !result.ok && spawns === 0, `${result.error} / spawns=${spawns}`);
  check("preflight failure returns one result per agent", data?.agents?.length === 2 && data.agents[0]?.reply.ok === true && data.agents[1]?.reply.ok === false, result.data);
}

// A launch-phase partial failure reports every agent and keeps already activated identities retained.
{
  let spawns = 0;
  const manager = managerWith((name) => {
    spawns++;
    if (spawns === 2) throw new Error("simulated resume launch failure");
    return fakeHandle(name);
  }, { resumeAttemptId: "partial_resume" });
  let deprovisions = 0;
  (manager as unknown as { deprovision: () => Promise<void> }).deprovision = async () => { deprovisions++; };
  const second: ManagerResumeAgent = {
    ...openInventory,
    name: "worker-two",
    identity: { mode: "open", id: "open_principal_two", lifecycleUid: uidFor("workertwo") },
  };
  const result = await control(manager, "admin", "resumePreserved", {
    attemptId: "partial_resume",
    inventory: inventoryOf(openInventory, second),
  });
  const data = result.data as { state?: string; agents?: Array<{ name: string; reply: { ok: boolean; error?: string } }> } | undefined;
  check("launch failure returns one result per inventory agent", !result.ok && data?.state === "degraded" && data.agents?.length === 2 && data.agents[0]?.reply.ok === true && data.agents[1]?.reply.ok === false, result.data);
  const commit = await control(manager, "admin", "commitResume", { attemptId: "partial_resume" });
  check("failed activation cannot be committed", !commit.ok && /no successful activation/.test(commit.error ?? ""), commit.error);
  await manager.stop();
  check("partial resume shutdown does not deprovision retained principals", deprovisions === 0, deprovisions);
}

// A degraded uncertain attempt remains retained even if exact presence arrives later.
{
  const handle = fakeHandle("worker");
  const manager = managerWith(() => handle, { resumeAttemptId: "late_presence" });
  (manager as unknown as { readinessTimeoutMs: number }).readinessTimeoutMs = 5;
  let roster: Array<{ card: { id: string; name: string }; status: string }> = [];
  const presenceListeners = new Set<() => void>();
  (manager as unknown as { ep: unknown }).ep = {
    ref: () => ({ id: "local.manager", name: "manager", role: "manager" }),
    getRoster: () => roster,
    waitForPresenceSnapshot: async () => {},
    on: (event: string, fn: () => void) => { if (event === "presence") presenceListeners.add(fn); },
    off: (_event: string, fn: () => void) => { presenceListeners.delete(fn); },
    releaseManagerLease: async () => {},
    stop: async () => {},
  };
  let deprovisions = 0;
  (manager as unknown as { deprovision: () => Promise<void> }).deprovision = async () => { deprovisions++; };
  const result = await control(manager, "admin", "resumePreserved", {
    attemptId: "late_presence",
    inventory: inventoryOf(openInventory),
  });
  check("uncertain attempt is degraded and non-committable", !result.ok && /uncertain/.test(JSON.stringify(result.data)), result.data);
  roster = [{ card: { id: principalKey(DEV_OWNER, "open_principal_resume").key, name: "worker" }, status: "idle" }];
  for (const listener of [...presenceListeners]) listener();
  handle.stop({ graceful: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check("late adoption cannot release cleanup before commit", deprovisions === 0, deprovisions);
}

// Late adoption is incarnation-exact: a wrong/absent-uid presence under the reused alias must NOT
// adopt an uncertain resume (that would undo the incarnation-exact readiness fence after a timeout);
// only the exact recovered uid does. No resumeAttemptId => resumeRequired false => adoption may release.
{
  const handle = fakeHandle("worker");
  const manager = managerWith(() => handle);
  (manager as unknown as { readinessTimeoutMs: number }).readinessTimeoutMs = 5;
  let roster: Array<{ card: { id: string; name: string }; lifecycleUid?: string; status: string }> = [];
  const presenceListeners = new Set<() => void>();
  (manager as unknown as { ep: unknown }).ep = {
    ref: () => ({ id: "local.manager", name: "manager", role: "manager" }),
    getRoster: () => roster,
    waitForPresenceSnapshot: async () => {},
    on: (event: string, fn: () => void) => { if (event === "presence") presenceListeners.add(fn); },
    off: (_event: string, fn: () => void) => { presenceListeners.delete(fn); },
    releaseManagerLease: async () => {},
    stop: async () => {},
  };
  const uncertain = await manager.resumePreserved(inventoryOf(openInventory));
  const managed = (manager as unknown as { agents: Map<string, { suppressCleanup?: boolean }> }).agents.get("worker");
  check("adoption setup: an uncertain resume is retained with cleanup suppressed", !uncertain.ok && managed?.suppressCleanup === true, { ok: uncertain.ok, suppress: managed?.suppressCleanup });
  const alias = principalKey(DEV_OWNER, "open_principal_resume").key;
  roster = [{ card: { id: alias, name: "worker" }, lifecycleUid: uidFor("ghostuid"), status: "idle" }];
  for (const listener of [...presenceListeners]) listener();
  check("late adoption ignores a wrong-incarnation presence under the reused alias", managed?.suppressCleanup === true, managed?.suppressCleanup);
  roster = [{ card: { id: alias, name: "worker" }, status: "idle" }]; // absent uid is also not the incarnation
  for (const listener of [...presenceListeners]) listener();
  check("late adoption ignores an absent-incarnation presence", managed?.suppressCleanup === true, managed?.suppressCleanup);
  roster = [{ card: { id: alias, name: "worker" }, lifecycleUid: uidFor("resume"), status: "idle" }];
  for (const listener of [...presenceListeners]) listener();
  check("late adoption accepts the exact recovered incarnation", managed?.suppressCleanup === false, managed?.suppressCleanup);
}

// Commit proves runtime and exact-principal liveness, not merely retained map membership.
{
  const handle = silentExitHandle("worker");
  const manager = managerWith(() => handle, { resumeAttemptId: "exit_before_commit" });
  const resumed = await control(manager, "admin", "resumePreserved", {
    attemptId: "exit_before_commit",
    inventory: inventoryOf(openInventory),
  });
  check("external-style resume activates before silent exit", resumed.ok, resumed.error);
  handle.exitSilently();
  const commit = await control(manager, "admin", "commitResume", { attemptId: "exit_before_commit" });
  check("commit rejects an exited handle still present in manager map", !commit.ok && /runtime is not running/.test(commit.error ?? ""), commit.error);
}

// Commit proves the EXACT incarnation the readiness fence proved, not just the principal: a
// wrong-uid presence under the reused alias (a ghost after the true incarnation drops) cannot
// satisfy the late commit gate.
{
  const handle = fakeHandle("worker");
  const manager = managerWith(() => handle, { resumeAttemptId: "commit_wrong_uid" });
  const resumed = await control(manager, "admin", "resumePreserved", { attemptId: "commit_wrong_uid", inventory: inventoryOf(openInventory) });
  check("commit-uid setup: resume activated on the exact incarnation", resumed.ok, resumed.error);
  // Swap the roster to a ghost: same alias, DIFFERENT incarnation (the true uid presence is gone).
  (manager as unknown as { ep: { getRoster: () => unknown[] } }).ep.getRoster = () => [{
    card: { id: principalKey(DEV_OWNER, "open_principal_resume").key, name: "worker" },
    lifecycleUid: uidFor("ghostuid"),
    status: "idle",
  }];
  const commit = await control(manager, "admin", "commitResume", { attemptId: "commit_wrong_uid" });
  check("commit refuses a wrong-incarnation presence under the reused alias", !commit.ok && /is not exactly present/.test(commit.error ?? ""), commit.error);
}

// Static resume validates the credential's embedded nkey against inventory and never mints another.
{
  const auth = await createSpaceAuth("preserve-smoke");
  const identity = newIdentity();
  const credsDir = join(authDir(root), "creds");
  mkdirSync(credsDir, { recursive: true });
  const credsPath = join(credsDir, "static-worker.creds");
  const retainedCreds = await mintCreds(auth, identity, "agent", { lifecycleUid: uidFor(identity.id) });
  writeFileSync(credsPath, retainedCreds, { mode: 0o600 });
  const manager = managerWith((name) => fakeHandle(name));
  (manager as unknown as { auth: unknown }).auth = auth;
  const entry: ManagerResumeAgent = {
    ...openInventory,
    name: "static-worker",
    identity: { mode: "static", id: identity.id, lifecycleUid: uidFor(identity.id), credential: { kind: "file", path: credsPath, sha256: digest(credsPath) } },
    launch: { ...openInventory.launch, source: { kind: "persona", ref: "worker", configPath: personaPath, configSha256: digest(personaPath) } },
    dependencies: [personaPath],
  };
  capturedLaunch = undefined;
  const ok = await manager.resumePreserved(inventoryOf(entry));
  check("static resume accepts matching retained credential", ok.ok && capturedLaunch?.id === identity.id && capturedLaunch?.creds === credsPath, ok);
  check("static resume threads the recovered incarnation uid into launch", capturedLaunch?.lifecycleUid === uidFor(identity.id), capturedLaunch?.lifecycleUid);

  // ── THE CREDENTIAL IS THE AUTHORITY, NOT THE INVENTORY'S CLAIM ABOUT IT ──
  //
  // `launch.allowPublish` records what was REQUESTED at spawn; the minted JWT records what was
  // GRANTED. They can differ, and the preflight used to read the record — so a credential minted
  // WITHOUT the event channel resumed successfully whenever the inventory claimed it, producing a
  // mute stream reported as success. Same class as verifying a preflight function's behaviour
  // without checking that anything calls it. Found by fmae-rev-sec, reproduced live against a real
  // JWT. `retainedCreds` was minted with no allowPublish, so the credential genuinely lacks the
  // channel while the inventory below claims it — the exact contradiction.
  {
    const claimManager = managerWith((n) => fakeHandle(n));
    (claimManager as unknown as { auth: unknown }).auth = auth;
    const lying: ManagerResumeAgent = {
      ...entry,
      // MUST use the events-capable connector: with `preserve-connector` the refusal comes from the
      // no-eventChannel branch and the credential check is never reached — the first cell would then
      // pass vacuously, which is exactly what the message cell caught.
      launch: { ...entry.launch, connector: "preserve-events-connector", events: true, allowPublish: ["events.static-worker"] },
    };
    const denied = await claimManager.resumePreserved(inventoryOf(lying));
    const reply = denied.agents[0]?.reply;
    check("static resume REFUSES when the CREDENTIAL lacks the event channel the inventory claims",
      reply?.ok === false, JSON.stringify(reply));
    // THE REVERSE ARM — owed to fmae-rev-test's discriminator: "mutate inventory and credential
    // independently and prove the decision follows the credential actually presented, not the
    // inventory claim." One arm alone would pass for an implementation that refused whenever the
    // inventory claimed anything, which is a different bug wearing the same green. It also caught a
    // real defect: both checks used to run for static mode, so a credential that DID grant the
    // channel was still refused when the inventory omitted it — a false refusal on a healthy agent,
    // and proof the decision was not following the credential at all.
    // The credential must live at the manager-owned path for this agent — a differently-named file
    // is refused by an earlier check and the cell would never reach the grant decision at all.
    const grantingCreds = await mintCreds(auth, identity, "agent", { lifecycleUid: uidFor(identity.id), allowPublish: ["events.static-worker"] });
    const grantingPath = credsPath;
    writeFileSync(grantingPath, grantingCreds, { mode: 0o600 });
    const reverseManager = managerWith((n) => fakeHandle(n));
    (reverseManager as unknown as { auth: unknown }).auth = auth;
    const reverse = await reverseManager.resumePreserved(inventoryOf({
      ...entry,
      identity: { mode: "static", id: identity.id, lifecycleUid: uidFor(identity.id), credential: { kind: "file", path: grantingPath, sha256: digest(grantingPath) } },
      // inventory OMITS the channel; the credential GRANTS it
      launch: { ...entry.launch, connector: "preserve-events-connector", events: true, allowPublish: [] },
    }));
    check("REVERSE: the credential GRANTS it while the inventory omits it — resume PROCEEDS, so the decision follows the credential",
      reverse.agents[0]?.reply?.ok === true, JSON.stringify(reverse.agents[0]?.reply));

    check("and the refusal names the CREDENTIAL as what does not grant it, not the inventory",
      /CREDENTIAL does not grant/.test(String(reply && reply.ok === false ? reply.error : "")), String(reply && reply.ok === false ? reply.error : "(ok)"));
  }

  const mismatchManager = managerWith((name) => fakeHandle(name));
  (mismatchManager as unknown as { auth: unknown }).auth = auth;
  const mismatch = await mismatchManager.resumePreserved(inventoryOf({ ...entry, identity: { mode: "static", id: newIdentity().id, lifecycleUid: uidFor("mismatch"), credential: { kind: "file", path: credsPath, sha256: digest(credsPath) } } }));
  check("static resume fails closed on credential/principal mismatch", !mismatch.ok && /does not match inventory principal/.test(mismatch.agents[0]?.reply.error ?? ""), mismatch.agents);

  const replacementCreds = await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: uidFor("replacement") });
  writeFileSync(credsPath, retainedCreds, { mode: 0o600 });
  const spawnDriftEntry: ManagerResumeAgent = {
    ...entry,
    identity: { mode: "static", id: identity.id, lifecycleUid: uidFor(identity.id), credential: { kind: "file", path: credsPath, sha256: digest(credsPath) } },
  };
  let driftSpawns = 0;
  let probeCalls = 0;
  const spawnDriftManager = managerWith((name) => { driftSpawns++; return fakeHandle(name); });
  (spawnDriftManager as unknown as { auth: unknown }).auth = auth;
  (spawnDriftManager as unknown as { probeStaticCredential: (creds: string) => Promise<{ ok: true }> }).probeStaticCredential = async () => {
    probeCalls++;
    if (probeCalls === 1) writeFileSync(credsPath, replacementCreds, { mode: 0o600 });
    return { ok: true };
  };
  const spawnDrift = await spawnDriftManager.resumePreserved(inventoryOf(spawnDriftEntry));
  check("static credential drift after batch preflight is caught before spawn", !spawnDrift.ok && driftSpawns === 0 && /changed after the cut/.test(spawnDrift.error ?? ""), spawnDrift);

  writeFileSync(credsPath, retainedCreds, { mode: 0o600 });
  const commitEntry: ManagerResumeAgent = {
    ...entry,
    identity: { mode: "static", id: identity.id, lifecycleUid: uidFor(identity.id), credential: { kind: "file", path: credsPath, sha256: digest(credsPath) } },
  };
  const secondIdentity = newIdentity();
  const secondCredsPath = join(credsDir, "static-worker-two.creds");
  const secondCreds = await mintCreds(auth, secondIdentity, "agent", { lifecycleUid: uidFor(secondIdentity.id) });
  writeFileSync(secondCredsPath, secondCreds, { mode: 0o600 });
  const secondCommitEntry: ManagerResumeAgent = {
    ...commitEntry,
    name: "static-worker-two",
    identity: { mode: "static", id: secondIdentity.id, lifecycleUid: uidFor(secondIdentity.id), credential: { kind: "file", path: secondCredsPath, sha256: digest(secondCredsPath) } },
  };
  const commitDriftManager = managerWith((name) => fakeHandle(name), {
    resumeAttemptId: "static_commit_drift",
    resumeDurableCommitToken: "2".repeat(64),
  });
  (commitDriftManager as unknown as { auth: unknown }).auth = auth;
  await control(commitDriftManager, "admin", "resumePreserved", { attemptId: "static_commit_drift", inventory: inventoryOf(commitEntry, secondCommitEntry) });
  writeFileSync(secondCredsPath, replacementCreds, { mode: 0o600 });
  const commitDrift = await control(commitDriftManager, "admin", "commitResume", { attemptId: "static_commit_drift" });
  check("replacement recommit revalidates every static entry and refuses later-entry drift", !commitDrift.ok && /static-worker-two/.test(commitDrift.error ?? ""), commitDrift.error);
  const cannotFinalize = await control(commitDriftManager, "admin", "finalizeResume", { attemptId: "static_commit_drift", durableCommitToken: "0".repeat(64) });
  check("a failed static authority commit cannot be finalized", !cannotFinalize.ok && /no successful commit/.test(cannotFinalize.error ?? ""), cannotFinalize.error);
}

// User mode delegates to the provider's read-only retained validator and never grants a replacement.
{
  const manager = managerWith((name) => fakeHandle(name));
  (manager as unknown as { userMode: boolean }).userMode = true;
  const credsDir = join(authDir(root), "creds");
  mkdirSync(credsDir, { recursive: true });
  const actorTokenPath = join(credsDir, "worker.actor-token");
  const sentinelPath = join(credsDir, "worker.sentinel.creds");
  const healthPath = join(credsDir, "worker.auth-health.json");
  writeFileSync(actorTokenPath, "retained-token", { mode: 0o600 });
  writeFileSync(sentinelPath, "retained-sentinel", { mode: 0o600 });
  const entry: ManagerResumeAgent = {
    ...openInventory,
    identity: {
      mode: "user",
      owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      actor: "worker",
      lifecycleUid: uidFor("userworker"),
      actorToken: { kind: "file", path: actorTokenPath, sha256: digest(actorTokenPath) },
      sentinelCredential: { kind: "file", path: sentinelPath, sha256: digest(sentinelPath) },
      health: { kind: "file", path: healthPath },
    },
  };
  retainedValidationCalls = 0;
  retainedGrantCalls = 0;
  capturedLaunch = undefined;
  const result = await manager.resumePreserved(inventoryOf(entry));
  check("user resume validates retained authority at preflight and immediately before spawn", result.ok && retainedValidationCalls === 2, `${result.error} / calls=${retainedValidationCalls}`);
  check("provider receives retained token and sentinel contents", lastRetainedInput?.actorToken === "retained-token" && lastRetainedInput?.sentinelCreds === "retained-sentinel", lastRetainedInput);
  check("user resume never calls grantAgent", retainedGrantCalls === 0, retainedGrantCalls);
  check("user resume reuses exact owner/actor in launch", capturedLaunch?.userAuth?.owner === entry.identity.owner && capturedLaunch.userAuth.actor === entry.identity.actor, capturedLaunch?.userAuth);
  check("user resume threads the recovered incarnation uid into launch", capturedLaunch?.lifecycleUid === uidFor("userworker"), capturedLaunch?.lifecycleUid);
  check("user bearer command is reconstructed from provider command", capturedLaunch?.userAuth?.bearerCmd.includes("agent-bearer") === true, capturedLaunch?.userAuth?.bearerCmd);

  // A retained inventory must pin the WHOLE secret family as ONE unit — {actorToken, sentinel,
  // health} all the lifecycle triple OR all the legacy triple. Two negatives, both must refuse
  // BEFORE any spawn (a rejected resume records nothing, so teardown never deletes a foreign file):
  //
  // (1) FOREIGN HEALTH PATH — the delete gadget: health is not a hashed retained reference, so a
  //     corrupt inventory could once point it at an arbitrary workspace file that flowed into the
  //     bearer argv and was rmSync'd at terminal teardown. The atomic pin refuses it.
  {
    const victim = join(root, "operator-owned-secret.txt");
    writeFileSync(victim, "DO NOT DELETE ME", { mode: 0o600 });
    const foreignHealth: ManagerResumeAgent = { ...entry, identity: { ...entry.identity, health: { kind: "file", path: victim } } };
    let foreignHealthSpawns = 0;
    const m = managerWith((name) => { foreignHealthSpawns++; return fakeHandle(name); });
    (m as unknown as { userMode: boolean }).userMode = true;
    const r = await m.resumePreserved(inventoryOf(foreignHealth));
    check("user resume refuses a FOREIGN health path (delete gadget) before any spawn", !r.ok && foreignHealthSpawns === 0 && /one manager-owned secret family|foreign health/.test(JSON.stringify(r)), JSON.stringify(r));
    check("the foreign (operator-owned) file SURVIVES the refused resume", existsSync(victim));
  }
  //
  // (2) MIXED FAMILY — a lifecycle-keyed actor token paired with a legacy sentinel/health. Both
  //     files exist and each is individually manager-owned, but they are not ONE family; the pin
  //     refuses the mix (the old per-file OR-pin accepted it).
  {
    const lifecycleActor = agentLifecycleSecretFilePaths(root, "worker", uidFor("userworker")).actorToken;
    writeFileSync(lifecycleActor, "retained-token", { mode: 0o600 });
    const mixed: ManagerResumeAgent = { ...entry, identity: { ...entry.identity, actorToken: { kind: "file", path: lifecycleActor, sha256: digest(lifecycleActor) } } };
    let mixedSpawns = 0;
    const m = managerWith((name) => { mixedSpawns++; return fakeHandle(name); });
    (m as unknown as { userMode: boolean }).userMode = true;
    const r = await m.resumePreserved(inventoryOf(mixed));
    check("user resume refuses a MIXED secret family (lifecycle token + legacy sentinel/health)", !r.ok && mixedSpawns === 0 && /one manager-owned secret family/.test(JSON.stringify(r)), JSON.stringify(r));
  }

  // A retained authority row whose incarnation uid differs from the inventory is refused BEFORE any
  // spawn (the pre-effect uid binding), not left to broker-fail after the child is already running.
  retainedAuthority = { ...retainedAuthority, lifecycleUid: uidFor("wronguid") };
  let uidDriftSpawns = 0;
  const uidMismatchManager = managerWith((name) => { uidDriftSpawns++; return fakeHandle(name); });
  (uidMismatchManager as unknown as { userMode: boolean }).userMode = true;
  const uidMismatch = await uidMismatchManager.resumePreserved(inventoryOf(entry));
  check("user resume refuses a retained authority whose incarnation uid differs from the inventory, before any spawn",
    !uidMismatch.ok && uidDriftSpawns === 0 && /not the inventory's/.test(JSON.stringify(uidMismatch)), JSON.stringify(uidMismatch));
  retainedAuthority = { ...retainedAuthority, lifecycleUid: uidFor("userworker") };

  retainedAuthority = { ...retainedAuthority, allowSubscribe: ["other"] };
  const mismatchManager = managerWith((name) => fakeHandle(name));
  (mismatchManager as unknown as { userMode: boolean }).userMode = true;
  const mismatch = await mismatchManager.resumePreserved(inventoryOf(entry));
  check("user authority drift fails before launch", !mismatch.ok && /failed preflight/.test(mismatch.error ?? ""), mismatch);
  retainedAuthority = { ...retainedAuthority, allowSubscribe: ["general"] };

  let userDriftSpawns = 0;
  const userSpawnDriftManager = managerWith((name) => { userDriftSpawns++; return fakeHandle(name); });
  (userSpawnDriftManager as unknown as { userMode: boolean }).userMode = true;
  afterRetainedValidation = () => {
    afterRetainedValidation = undefined;
    retainedAuthority = { ...retainedAuthority, allowSubscribe: ["other"] };
  };
  const userSpawnDrift = await userSpawnDriftManager.resumePreserved(inventoryOf(entry));
  check("user ledger/token authority drift after batch preflight is caught before spawn", !userSpawnDrift.ok && userDriftSpawns === 0 && /no longer matches/.test(userSpawnDrift.error ?? ""), userSpawnDrift);
  retainedAuthority = { ...retainedAuthority, allowSubscribe: ["general"] };

  const userCommitDriftManager = managerWith((name) => fakeHandle(name), {
    resumeAttemptId: "user_commit_drift",
    resumeDurableCommitToken: "3".repeat(64),
  });
  (userCommitDriftManager as unknown as { userMode: boolean }).userMode = true;
  const resumed = await control(userCommitDriftManager, "admin", "resumePreserved", {
    attemptId: "user_commit_drift",
    inventory: inventoryOf(entry),
  });
  retainedAuthority = { ...retainedAuthority, allowSubscribe: ["other"] };
  const commitDrift = await control(userCommitDriftManager, "admin", "commitResume", { attemptId: "user_commit_drift" });
  check("replacement recommit revalidates every user authority row and refuses drift", resumed.ok && !commitDrift.ok && /retained authority changed/.test(commitDrift.error ?? ""), commitDrift.error);
  const cannotFinalize = await control(userCommitDriftManager, "admin", "finalizeResume", { attemptId: "user_commit_drift", durableCommitToken: "0".repeat(64) });
  check("a failed user authority commit cannot be finalized", !cannotFinalize.ok && /no successful commit/.test(cannotFinalize.error ?? ""), cannotFinalize.error);
  retainedAuthority = { ...retainedAuthority, allowSubscribe: ["general"] };
}

// Regression: active-mode stop remains the existing destructive shutdown path.
{
  const manager = managerWith((name) => fakeHandle(name));
  const handle = fakeHandle("normal");
  const map = (manager as unknown as { agents: Map<string, unknown> }).agents;
  map.set("normal", managed("normal", "normal_id", handle, "persona"));
  let deprovisions = 0;
  (manager as unknown as { deprovision: () => Promise<void> }).deprovision = async () => { deprovisions++; };
  await manager.stop();
  check("normal stop still hard-stops managed agents", handle.stops === 1, handle.stops);
  check("normal stop still deprovisions managed agents", deprovisions === 1, deprovisions);
}

// Regression: an accepted control stop frees the slot AT ONCE — `stop` replying ✓ has to mean `ps`
// no longer lists the agent, even while the child is still dying. The exit proof holds the
// lifecycle drain instead, so a cut still cannot fence ahead of that child.
{
  const manager = managerWith((name) => fakeHandle(name));
  const handle = lingeringHandle("dying");
  const map = (manager as unknown as { agents: Map<string, unknown> }).agents;
  map.set("dying", managed("dying", "dying_id", handle, "persona"));
  (manager as unknown as { deprovision: () => Promise<void> }).deprovision = async () => {};
  const stopped = await control(manager, "admin", "stop", { name: "dying" });
  check("an accepted stop replies without waiting for the child to die", stopped.ok === true, stopped.error);
  const listed = await control(manager, "admin", "ps", {});
  check(
    "an accepted stop frees the slot before ps reads it",
    (listed.data as { name: string }[]).every((a) => a.name !== "dying"),
    listed.data,
  );
  let prepared = false;
  const preparation = manager.preparePreservation("accepted_stop").then((plan) => { prepared = true; return plan; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  check("a cut still drains the dying child's exit proof before it inventories", !prepared);
  handle.finishExit();
  const plan = await preparation;
  check(
    "the drained cut omits the stopped child",
    plan.inventory.agents.every((a) => a.name !== "dying"),
    plan.inventory.agents.map((a) => a.name),
  );
}

console.log(`\nPRESERVE-STATE SMOKE ${failures === 0 ? "OK" : "FAILED"} (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
