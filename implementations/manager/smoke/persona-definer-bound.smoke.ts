/**
 * A persona saved over the wire is held to its definer. `define-persona` writes no launch options,
 * from a frontmatter block in the prompt or from a saved file it redefines, and it refuses channel
 * lists the definer does not hold, the way it refuses capabilities and endpoint commands. A later
 * spawn of the persona is still bounded against its own spawner, and persona files the operator
 * writes keep their launch options and channel lists.
 *
 * Static mesh, broker-backed: a real manager serves `define-persona` and `spawn`, and each caller
 * is a real issued agent credential calling over the broker, so the bound measures the caller the
 * broker pinned on the request subject. The connector records the launch options the manager hands
 * it, and the child's minted credential is read for its channel grants. A user-auth manager runs the
 * real auth provider and ledger, whose refusal comes before any broker work.
 * Run with: pnpm smoke:persona-definer-bound
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import {
  createSpaceAuth,
  eventChannel,
  invokeCommand,
  loadAgentFile,
  mintAcceptedToken,
  mintCreds,
  mintGeneration,
  mintLifecycleUid,
  newIdentity,
  principalKey,
  registry,
  resolveService,
  saveAgentFile,
  setupSpaceStreams,
  standaloneConnectOpts,
  withIssuerSession,
  DEV_OWNER,
  type AgentHandle,
  type AuthProvider,
  type Connector,
  type ControlReply,
  type EpCaller,
  type IssuedCaller,
  type LaunchOpts,
} from "@cotal-ai/core";
import { agentLifecycleSecretFilePaths, authDir, mintControlInstrument, recordMesh, saveSpaceAuth, trustProject, userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import { createSuite } from "@cotal-ai/smoke-kit";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT } from "../src/manager-service-contract.js";
import { bootBroker } from "./_boot-broker.js";
import { credAcl } from "./_cred-acl.js";
import { requestDeliveryAdminZeroMemberships } from "./_fake-delivery-admin.js";

const { check, finish } = createSuite();
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];

const space = `definer-bound-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const { servers: SERVERS, stop: stopBroker } = await bootBroker(auth);
const dir = mkdtempSync(join(tmpdir(), "cotal-definer-bound-"));
chmodSync(dir, 0o700);
process.env.COTAL_HOME = join(dir, "home");
process.env.XDG_CONFIG_HOME = join(dir, "config");
mkdirSync(process.env.COTAL_HOME, { recursive: true, mode: 0o700 });
const root = join(dir, "ws");
const agents = join(root, ".cotal", "agents");
mkdirSync(agents, { recursive: true });
saveSpaceAuth(authDir(root), auth);
recordMesh({ space, server: SERVERS, root, mode: "auth", ts: new Date().toISOString() });
const file = (name: string, at = agents) => join(at, `${name}.md`);
// An operator's own file: launch options and a channel only the wide spawner holds.
writeFileSync(file("operator_opts"), "---\nname: operator_opts\nsubscribe: []\nallowSubscribe: [secret]\nallowPublish: [secret]\nlaunchOptions:\n  add-dir: /operator\n---\nbody\n");

// The launch options each seat was built with, by seat name: what the connector would forward.
const launched = new Map<string, LaunchOpts>();
registry.register({
  kind: "connector",
  name: "smoke-definer",
  requires: ["node"],
  eventChannel,
  buildLaunch: (o: LaunchOpts) => {
    launched.set(o.name, o);
    return { command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"], env: {} };
  },
} as Connector);

const until = async (cond: () => boolean, ms = 20_000) => {
  for (let i = 0; i < ms / 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
  return cond();
};

type Reply = { ok: boolean; code?: string; outcome?: string; message: string; data?: { name?: string } };
type Conn = Awaited<ReturnType<typeof connect>>;
const conns: Conn[] = [];
let mgr: InstanceType<typeof Manager> | undefined;

/** A static caller on the served door: an issued agent credential with `spawn` and these channels. */
async function caller(read: string[], post: string[]) {
  const identity = newIdentity();
  const uid = mintLifecycleUid();
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const issued = { generation: mintGeneration(expiresAt), acceptedToken: mintAcceptedToken() };
  const creds = await withIssuerSession({ servers: SERVERS, space, auth, tls: false }, (s) =>
    mintCreds(auth, identity, "agent", {
      lifecycleUid: uid, expiresAt, issued,
      issuance: { mode: "issue", store: s.store, accepted: s.accepted, sources: [] },
      capabilities: ["spawn"], allowSubscribe: read, allowPublish: post,
    }),
  );
  return door(creds, { owner: DEV_OWNER, actor: identity.id, uid, generation: issued.generation });
}

async function door(creds: string, who: EpCaller | IssuedCaller) {
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  conns.push(nc);
  const svc = await resolveService(nc, space, MANAGER_ENDPOINT, who, { deadlineMs: 8_000, commands: ["spawn", "define-persona"] });
  const call = async (command: string, args: Record<string, unknown>): Promise<Reply> => {
    try {
      const r = await invokeCommand(nc, space, svc, command, args, { deadlineMs: 20_000 });
      const reply = (r as { reply?: { ok?: boolean; data?: { name?: string }; error?: { code?: string; outcome?: string; message?: string } } }).reply;
      return { ok: reply?.ok === true, code: reply?.error?.code, outcome: reply?.error?.outcome, message: reply?.error?.message ?? "", data: reply?.data };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false, code: err.code, message: err.message ?? String(e) };
    }
  };
  return {
    define: (name: string, persona: string, extra: Record<string, unknown> = {}) => call("define-persona", { name, persona, ...extra }),
    spawn: (name: string, extra: Record<string, unknown> = {}) => call("spawn", { name, agent: "smoke-definer", events: false, ...extra }),
  };
}

const seats = () => [...(mgr as unknown as { agents: Map<string, { name: string; lifecycleUid: string }> }).agents.values()];
/** The seat a spawn started, once the manager has launched it. */
const seat = async (name: string) => {
  await until(() => launched.has(name) && seats().some((a) => a.name === name));
  return seats().find((a) => a.name === name);
};
const aclOf = (s: { name: string; lifecycleUid: string } | undefined) => s ? credAcl(agentLifecycleSecretFilePaths(root, space, s.name, s.lifecycleUid).creds) : undefined;
const reads = (acl: { sub: string[] } | undefined, ch: string) => acl !== undefined && acl.sub.some((s) => s.endsWith(`.${ch}`));
const posts = (acl: { pub: string[] } | undefined, ch: string) => acl !== undefined && acl.pub.some((s) => s.endsWith(`.${ch}`));
const optsOf = (name: string) => launched.get(name)?.launchOptions;
const frontmatter = (lines: string[]) => ["---", ...lines, "---", "You help."].join("\n");
const noRead = { subscribe: [], allowSubscribe: [] };
const noPost = { allowPublish: [] };
const readRemedy = /`subscribe: \[\]` and `allowSubscribe: \[\]`/;
const postRemedy = /`allowPublish: \[\]`/;

try {
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot: root });
  await mgr.start();
  // The definer holds review. The spawner holds review and secret.
  const definer = await caller(["review"], ["review"]);
  const spawner = await caller(["review", "secret"], ["review", "secret"]);

  console.log("static mesh: channel lists are bounded against the definer");
  const inside = await definer.define("inside", frontmatter(["subscribe: [review]", "allowSubscribe: [review]", "allowPublish: [review]"]));
  check("control: a definer saves a persona whose channels it holds", inside.ok && JSON.stringify(loadAgentFile(file("inside")).allowSubscribe) === JSON.stringify(["review"]), inside);
  const plantedRead = await definer.define("planted_read", frontmatter(["subscribe: []", "allowSubscribe: [review, secret]"]));
  check("a read channel the definer does not hold, from the prompt's frontmatter, is refused by name",
    !plantedRead.ok && plantedRead.code === "permission-denied" && /grants more than the definer holds: allowSubscribe secret/.test(plantedRead.message), plantedRead);
  check("and writes no file", !existsSync(file("planted_read")));
  const plantedPost = await definer.define("planted_post", "You help.", { subscribe: [], allowPublish: ["secret"] });
  check("a post channel the definer does not hold, as an argument, is refused by name",
    !plantedPost.ok && plantedPost.code === "permission-denied" && /grants more than the definer holds: allowPublish secret/.test(plantedPost.message), plantedPost);
  check("and writes no file", !existsSync(file("planted_post")));
  const plantedSub = await definer.define("planted_sub", "You help.", { subscribe: ["secret"] });
  check("a read set the definer does not hold is refused by name", !plantedSub.ok && /allowSubscribe secret/.test(plantedSub.message) && !existsSync(file("planted_sub")), plantedSub);
  const readFixed = await definer.define("planted_read", frontmatter(["subscribe: []", "allowSubscribe: [review, secret]"]), noRead);
  check("the printed read override saves the definition without reads", readRemedy.test(plantedRead.message) && readFixed.ok && !loadAgentFile(file("planted_read")).allowSubscribe?.length, readFixed);
  const postFixed = await definer.define("planted_post", "You help.", { subscribe: [], ...noPost });
  check("the printed post override saves the definition without posts", postRemedy.test(plantedPost.message) && postFixed.ok && !loadAgentFile(file("planted_post")).allowPublish?.length, postFixed);
  const subFixed = await definer.define("planted_sub", "You help.", noRead);
  check("clearing both read fields also works when the startup list set the ACL", readRemedy.test(plantedSub.message) && subFixed.ok && !loadAgentFile(file("planted_sub")).subscribe?.length, subFixed);

  const unissuedIdentity = newIdentity();
  const unissuedUid = mintLifecycleUid();
  const unissuedCreds = await mintCreds(auth, unissuedIdentity, "agent", {
    lifecycleUid: unissuedUid, capabilities: ["spawn"], allowSubscribe: ["review"], allowPublish: ["review"],
  });
  const unissued = await door(unissuedCreds, { owner: DEV_OWNER, actor: unissuedIdentity.id, uid: unissuedUid });
  const unissuedGrant = await unissued.define("unissued", "You help.", { subscribe: ["review"], allowPublish: ["review"] });
  check("an unissued caller cannot save even channels its credential carries",
    unissuedGrant.code === "permission-denied" && unissuedGrant.outcome === "not-executed" &&
    /holds no issued evidence.*allowSubscribe review, allowPublish review/.test(unissuedGrant.message) && !existsSync(file("unissued")), unissuedGrant);
  const unissuedPlain = await unissued.define("unissued", "You help.", { ...noRead, ...noPost });
  check("an unissued caller can still save content without grants", unissuedPlain.ok && existsSync(file("unissued")), unissuedPlain);

  console.log("static mesh: a wire persona carries no launch options");
  const opts = await definer.define("planted_opts", frontmatter(["subscribe: [review]", "launchOptions:", "  add-dir: /workspace/review"]));
  check("control: a persona whose prompt names launch options is saved", opts.ok, opts);
  check("its file carries no launch options", existsSync(file("planted_opts")) && loadAgentFile(file("planted_opts")).launchOptions === undefined && !readFileSync(file("planted_opts"), "utf8").includes("/workspace/review"));
  const wideSpawn = await spawner.spawn("planted_opts");
  const planted = await seat("planted_opts");
  check("control: a wider spawner starts it", wideSpawn.ok && planted !== undefined, wideSpawn);
  check("and the child is launched with none of the definer's options", launched.has("planted_opts") && optsOf("planted_opts")?.["add-dir"] === undefined, optsOf("planted_opts"));
  const insideSpawn = await spawner.spawn("inside", { launchOptions: { "add-dir": "/spawner" } });
  const insideSeat = await seat("inside");
  check("control: the spawner's own launch options still reach the connector", insideSpawn.ok && optsOf("inside")?.["add-dir"] === "/spawner", { insideSpawn, opts: optsOf("inside") });
  check("control: and the child holds the persona's channels and not the spawner's others", reads(aclOf(insideSeat), "review") && !reads(aclOf(insideSeat), "secret") && !posts(aclOf(insideSeat), "secret"), aclOf(insideSeat));

  console.log("static mesh: operator files in a trusted project keep both");
  trustProject(root);
  const opSpawn = await spawner.spawn("operator_opts");
  const opSeat = await seat("operator_opts");
  check("an operator file's launch options reach the connector", opSpawn.ok && optsOf("operator_opts")?.["add-dir"] === "/operator", { opSpawn, opts: optsOf("operator_opts") });
  check("and its channels reach the child", reads(aclOf(opSeat), "secret") && posts(aclOf(opSeat), "secret"), aclOf(opSeat));
  const narrowSpawn = await definer.spawn("operator_opts");
  check("a spawn is still bounded against its spawner", !narrowSpawn.ok && /more than the spawner holds: allowSubscribe secret/.test(narrowSpawn.message), narrowSpawn);

  console.log("static mesh: an operator instrument");
  const instrument = await mintControlInstrument({ server: SERVERS, space, tlsRequired: false, auth }, "privileged");
  const operator = await door(instrument.creds, instrument.epCaller);
  const opWire = await operator.define("op_wire", frontmatter(["subscribe: []", "allowSubscribe: [secret]", "launchOptions:", "  add-dir: /instrument"]));
  check("an operator instrument may save channels no agent holds", opWire.ok && JSON.stringify(loadAgentFile(file("op_wire")).allowSubscribe) === JSON.stringify(["secret"]), opWire);
  check("and its wire persona carries no launch options either", existsSync(file("op_wire")) && loadAgentFile(file("op_wire")).launchOptions === undefined);
} finally {
  for (const nc of conns) await nc.drain().catch(() => nc.close());
  await mgr?.stop({ withAgents: true }).catch(() => {});
}

console.log("user-auth mesh");
try {
  const { cotalAuthProvider, ensureCalloutAuth, grantActor } = await import("@cotal-ai/auth");
  const userRoot = join(dir, "user");
  const userAgents = join(userRoot, ".cotal", "agents");
  mkdirSync(userAgents, { recursive: true });
  const U = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot: userRoot });
  const M = U as unknown as {
    userMode: boolean;
    config: { remoteAuthority?: unknown };
    managerInstanceId: string;
    agents: Map<string, { name: string }>;
    opDefinePersona: (args: Record<string, unknown>, caller: string, admin: boolean) => Promise<ControlReply>;
  };
  M.userMode = true;
  M.managerInstanceId = mintLifecycleUid();
  (U as unknown as { runtime: unknown }).runtime = {
    kind: "pty",
    supportsWorkClosure: true,
    spawn: (name: string) => ({ name, kind: "pty", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => ({ cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} }), waitForExit: async () => {}, waitForWorkExit: async () => {} }) as unknown as AgentHandle,
  };
  (U as unknown as { ep: Record<string, unknown> }).ep = {
    ref: () => ({ id: "smoke-mgr" }), on: () => {}, off: () => {}, waitForPresenceSnapshot: async () => {}, chatFrontier: async () => 0,
    requestDeliveryAdmin: requestDeliveryAdminZeroMemberships, getRoster: () => [],
  };
  await ensureCalloutAuth(workspaceSecretStore(userRoot), { space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
  const owner = "u_smokeownersmokeownersmokeo";
  const ledger = userAuthStateDir(userRoot, space);
  grantActor(ledger, { owner, actor: "definer", scope: ["spawn"], allowSubscribe: ["review"], allowPublish: ["review"], label: "smoke definer" });
  grantActor(ledger, { owner, actor: "boss", scope: ["admin"], allowSubscribe: [], allowPublish: [], label: "smoke operator" });
  const definerKey = principalKey(owner, "definer").key;
  const define = (who: string, name: string, args: Record<string, unknown>) => M.opDefinePersona({ name, persona: "You help.", ...args }, who, false);
  const refused = (r: ControlReply, part: RegExp) => r.ok === false && part.test(r.error ?? "");
  const fixed = (refusal: ControlReply, part: RegExp, result: ControlReply) =>
    refusal.outcome === "not-executed" && refused(refusal, part) && result.ok;
  check("control: the provider reads the definer's row", JSON.stringify(await cotalAuthProvider.actorScope({ dir: ledger, owner, actor: "definer" })) === JSON.stringify(["spawn"]));

  const within = await define(definerKey, "u_inside", { subscribe: ["review"], allowPublish: ["review"] });
  check("control: a user-auth definer saves channels its row holds", within.ok && existsSync(file("u_inside", userAgents)), within);
  const overRead = await define(definerKey, "u_read", { subscribe: [], allowSubscribe: ["secret"] });
  check("a read channel beyond the definer's row is refused by name, writing nothing",
    refused(overRead, /grants more than the definer holds: allowSubscribe secret beyond \[review\]/) && !existsSync(file("u_read", userAgents)), overRead);
  const overPost = await define(definerKey, "u_post", { persona: frontmatter(["subscribe: []", "allowPublish: [secret]"]) });
  check("a post channel beyond the definer's row, from the prompt, is refused by name, writing nothing",
    refused(overPost, /allowPublish secret beyond \[review\]/) && !existsSync(file("u_post", userAgents)), overPost);
  const userReadFixed = await define(definerKey, "u_read", noRead);
  check("the printed read override works on a local user-auth manager", fixed(overRead, readRemedy, userReadFixed), userReadFixed);
  const userPostFixed = await define(definerKey, "u_post", { persona: frontmatter(["subscribe: []", "allowPublish: [secret]"]), ...noPost });
  check("the printed post override also replaces a prompt grant", fixed(overPost, postRemedy, userPostFixed), userPostFixed);
  const stranger = await define(principalKey(owner, "stranger").key, "u_stranger", { subscribe: ["review"] });
  check("a user-auth definer with no row puts no channel into a persona", refused(stranger, /has no grant in this space/) && !existsSync(file("u_stranger", userAgents)), stranger);
  const strangerFixed = await define(principalKey(owner, "stranger").key, "u_stranger", noRead);
  check("clearing reads saves content without a channel grant", fixed(stranger, readRemedy, strangerFixed), strangerFixed);
  const { actorGrant: _actorGrant, ...legacyProvider } = cotalAuthProvider;
  registry.unregister("auth-provider", cotalAuthProvider.name);
  registry.register(legacyProvider as AuthProvider);
  try {
    const legacyGrant = await define(definerKey, "u_legacy", { subscribe: ["review"] });
    check("a provider missing actorGrant gives a named refusal without a write",
      legacyGrant.code === "permission-denied" && legacyGrant.outcome === "not-executed" &&
      refused(legacyGrant, /auth provider does not implement `actorGrant`/) && !existsSync(file("u_legacy", userAgents)), legacyGrant);
    const legacyPlain = await define(definerKey, "u_legacy", noRead);
    check("a provider missing actorGrant still allows content without grants", legacyPlain.ok && existsSync(file("u_legacy", userAgents)), legacyPlain);
  } finally {
    registry.unregister("auth-provider", legacyProvider.name);
    registry.register(cotalAuthProvider);
  }
  const boss = await define(principalKey(owner, "boss").key, "u_boss", { subscribe: [], allowSubscribe: ["secret"] });
  check("a definer whose row holds admin is exempt", boss.ok && existsSync(file("u_boss", userAgents)), boss);
  const userOpts = await define(definerKey, "u_opts", { persona: frontmatter(["subscribe: [review]", "launchOptions:", "  add-dir: /planted"]) });
  check("a user-auth wire persona carries no launch options", userOpts.ok && loadAgentFile(file("u_opts", userAgents)).launchOptions === undefined, userOpts);
  // A saved file's launch options do not survive its owner's redefine.
  if (existsSync(file("u_opts", userAgents))) saveAgentFile(file("u_opts", userAgents), { ...loadAgentFile(file("u_opts", userAgents)), launchOptions: { "add-dir": "/saved" } });
  const kept = existsSync(file("u_opts", userAgents)) ? loadAgentFile(file("u_opts", userAgents)).launchOptions?.["add-dir"] : undefined;
  const redefined = await define(definerKey, "u_opts", { persona: "Again." });
  check("a redefine writes no launch options the saved file held", kept === "/saved" && redefined.ok && loadAgentFile(file("u_opts", userAgents)).launchOptions === undefined, { kept, redefined });
  // A redefine that omits a channel list keeps the saved one, so the saved list is checked too.
  grantActor(ledger, { owner, actor: "demoted", scope: [], allowSubscribe: ["review", "secret"], allowPublish: [], label: "smoke definer" });
  const demoted = principalKey(owner, "demoted").key;
  const saved = await define(demoted, "u_saved", { subscribe: ["secret"] });
  grantActor(ledger, { owner, actor: "demoted", scope: [], allowSubscribe: ["review"], allowPublish: [], label: "smoke definer" });
  const resaved = await define(demoted, "u_saved", { persona: "New body." });
  check("a redefine that keeps a saved channel its definer no longer holds is refused, naming the saved list, writing nothing",
    saved.ok && refused(resaved, /allowSubscribe secret beyond \[review\].*`allowSubscribe` comes from the saved persona/) && loadAgentFile(file("u_saved", userAgents)).persona === "You help.", { saved, resaved });
  const savedFixed = await define(demoted, "u_saved", { persona: "New body.", ...noRead });
  check("the printed overrides clear an inherited read grant and allow redefine",
    fixed(resaved, readRemedy, savedFixed) && loadAgentFile(file("u_saved", userAgents)).persona === "New body." && !loadAgentFile(file("u_saved", userAgents)).subscribe?.length, savedFixed);

  M.config.remoteAuthority = {};
  const hosted = await define(definerKey, "u_hosted", { subscribe: ["review"] });
  const hostedPlain = await define(definerKey, "u_hosted_plain", {});
  check("a hosted manager reads no ledger, so its definer puts no channel into a persona", refused(hosted, /user authority is hosted/) && !existsSync(file("u_hosted", userAgents)), hosted);
  check("control: a hosted definer still saves a persona that names no channel", hostedPlain.ok, hostedPlain);
  const hostedFixed = await define(definerKey, "u_hosted", { ...noRead, capabilities: [] });
  check("the printed overrides work while authority is still hosted", fixed(hosted, readRemedy, hostedFixed), hostedFixed);
  M.config.remoteAuthority = undefined;

  // The spawn is bounded against its own spawner by the ledger, for a file whatever its source.
  writeFileSync(file("u_wide", userAgents), "---\nname: u_wide\nsubscribe: []\nallowSubscribe: [secret]\n---\nbody\n");
  const spawned = await U.startAgent({ name: "u_wide", agent: "smoke-definer", events: false }, definerKey);
  check("a user-auth spawn wider than its spawner's row is refused by the ledger", refused(spawned, /would exceed its spawner's grant.*read \[secret\] beyond \[review\]/) && M.agents.size === 0, spawned);
} finally {
  await stopBroker();
  rmSync(dir, { recursive: true, force: true });
}

finish();
process.exit(process.exitCode ?? 0);
