/**
 * A helper's persona `endpoints` on the wire, end to end on a static mesh (SPEC 13.7, 13.15).
 *
 * Live: a JWT-auth scratch broker, the real delivery daemon, the real Manager in a child process on
 * the real tmux runtime (its own tmux server under a private TMUX_TMPDIR), and a served third-party
 * endpoint, `com.example.orders`, with `list` and `create`. The spawner is an issued agent
 * credential that holds `spawn` and `com.example.orders list`, and it calls the manager's served
 * `spawn` command over the broker. One helper gets `list` from an inline persona and one from its
 * agent file. Each helper's own credential then calls `list`, and the endpoint's handler receives
 * and answers it; the broker refuses `create`, and the handler never receives one.
 *
 * Each seat's environment carries the list in COTAL_ENDPOINTS. The spawner is then issued again
 * with `create`, and the suite renews the inline helper's credential through the manager's own
 * renewal, which keeps `list` alone. It crashes the manager, lets a successor adopt the seat, and
 * renews again there. At each step the credential calls `list` and is refused `create`. A despawn ends the lifecycle: every ledger row of the
 * helper's credentials reads revoked, and a live connection made with a copy of its credential is
 * evicted. That cell grades the eviction only: a static credential copied off disk stays valid until
 * it expires, so a copy that reconnects is let back in (SPEC 13.15 names that residual).
 *
 * Last, a pinned entry through the agent tools. The spawner also holds `list` on one instance of the
 * endpoint, a second instance not yet serving, and hands that pin to a helper. The real
 * `cotal_describe` and `cotal_invoke` handlers run over an endpoint on the helper's own credential.
 * While only the first instance serves, an unpinned invoke and then an unpinned describe resolve
 * there, which the class baseline allows, and fill both of the helper's class caches with that
 * instance; the invoke itself is refused, since the helper holds no class row. Once the pinned
 * instance serves, a call naming it reaches it and leaves both caches as they were; a call naming the
 * other instance is refused by the broker and that handler receives nothing; an unpinned call never
 * runs on the other instance; and with the pinned instance stopped, a pinned call goes unanswered and
 * the other instance receives nothing.
 *
 * Run: pnpm smoke:persona-endpoints-served   (needs nats-server, tmux and node on PATH)
 */
import { randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  DEV_OWNER, SERVICE_READY, VOID_SCHEMA, authorizeServeGrant, contractArtifactCanonicalBytes, contractStoreContext,
  createSpaceAuth, credRowKey, endpointRegistrationBarrier, epAuthBucket, epCall, isReachable, mintAcceptedToken,
  mintConnectionEvictorCreds, mintCreds, mintGeneration, mintLifecycleUid, mintMembershipObserverCreds, newIdentity,
  RECORD_KINDS, parseLedgerRow, principalKey, provisionEndpointGateOpen, publishContractArtifact, readAcceptedRow, readEndpointGateGeneration,
  recordSpecKey, recordsBucket, registerServiceInstance, serveEndpoint, serveIssuanceGateKv, serverConfig, serviceContractTable, setupSpaceStreams,
  singleDocumentClosure, standaloneConnectOpts, withIssuerSession, writeServiceStatus,
  CotalEndpoint, lowerPersonaEndpoints,
  type CredentialLedgerRow, type EpCaller, type IssuedCaller,
} from "@cotal-ai/core";
import { cotalToolSpecs, type AgentConfig, type MeshAgent } from "@cotal-ai/connector-core";
import { agentLifecycleSecretFilePaths, authDir, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, emitSentinel, freePort, skipSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { MANAGER_CONTRACTS, MANAGER_ENDPOINT } from "../src/manager-service-contract.js";
import { readSeatRecord } from "../src/resume.js";
import { readStaticSlot, staticLifecycleTransport } from "../src/static-lifecycle.js";
import { bootDeliveryDaemon, type DeliveryDaemon } from "./_boot-delivery.js";

if (spawnSync("tmux", ["-V"]).status !== 0) skipSuite("tmux is not installed");
// A seat's launch environment is read from /proc.
if (process.platform !== "linux") skipSuite("reads a seat's environment from /proc, which only Linux has");

// Every cell, in order. A cell an earlier failure left unreachable is graded failed, so the suite
// always reaches its completion line.
const CELLS = [
  "the served endpoint answers the spawner's own list call",
  "a served spawn whose inline persona names a command the spawner lacks is refused by name",
  "a served spawn whose inline persona hands on list starts the helper",
  "a served spawn of an agent file that hands on list starts the helper",
  "each helper's session is launched with COTAL_ENDPOINTS naming list alone",
  "each helper's credential carries the list request row and no create row",
  "each helper's credential calls list, and the endpoint's handler receives and answers it",
  "the broker refuses each helper's create call, and the handler never receives one",
  "the spawner is issued again with create, and its own create call reaches the handler",
  "a renewal after that gain re-signs the inline helper's credential with the same endpoint rows",
  "the renewed credential calls list, and create is still refused",
  "the helper's seat outlives the manager's crash and the successor adopts it",
  "after adoption the helper's credential calls list, and create is still refused",
  "a renewal through the successor keeps list and leaves out create",
  "a despawn revokes every ledger row of the helper's lifecycle",
  "the despawn evicts a live connection made with a copy of the helper's credential",
  "a served spawn hands on list pinned to one instance, as that instance's list and describe rows and no class row",
  "while only the other instance serves, an unpinned cotal_invoke of list resolves there and never runs there",
  "an unpinned cotal_describe is answered by the other instance, which the class baseline allows, and both class caches hold it",
  "naming the pinned instance, cotal_describe and cotal_invoke reach it, its handler answers, and both class caches still hold the other instance",
  "naming the other instance, the broker refuses the call and that handler receives nothing",
  "an unpinned cotal_invoke, with both instances serving, never runs the command on the other instance",
  "with the pinned instance stopped, a pinned call goes unanswered rather than refused, and the other instance receives nothing",
];
let pass = 0, fail = 0;
const graded = new Set<string>();
const check = (name: string, condition: boolean, extra?: unknown) => {
  if (!CELLS.includes(name)) throw new Error(`unlisted cell: ${name}`);
  graded.add(name);
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra === undefined ? "" : JSON.stringify(extra)); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (read: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await read()) return true; await wait(200); }
  return read();
};
type Reply = { ok?: boolean; data?: { orders?: string[] }; error?: { code?: string; message?: string } };
/** A thrown call error, read in the shape of a refused reply. */
const asValue = (e: unknown): Reply => ({ ok: false, error: { code: (e as { code?: string }).code, message: String((e as Error).message).slice(0, 400) } });
const stopGroup = (pid?: number) => { if (!pid) return; try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} } };
const here = dirname(fileURLToPath(import.meta.url)); const repo = resolve(here, "../../.."); const host = join(here, "_tmux-adopt-host.ts"); const tsx = join(repo, "node_modules", ".bin", "tsx");
const ambientEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(ambientEnv)) if (key.startsWith("COTAL_") || key === "TMUX" || key === "TMUX_PANE") delete ambientEnv[key];
// A private tmux server, so the suite never touches the operator's. The socket path must stay short.
const tmuxDir = mkdtempSync("/tmp/ctmx-");
ambientEnv.TMUX_TMPDIR = tmuxDir;
const tmux = (...args: string[]) => execFileSync("tmux", args, { env: ambientEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const ORDERS = "com.example.orders";
const port = await freePort(); const servers = `nats://127.0.0.1:${port}`; const space = `pepserve-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space); const observerCreds = await mintMembershipObserverCreds(auth, newIdentity()); const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN)); const root = join(dir, "ws");
mkdirSync(join(root, ".cotal", "agents"), { recursive: true }); saveSpaceAuth(authDir(root), auth);
writeFileSync(join(root, ".cotal", "agents", "helper_file.md"), `---\nname: helper_file\nrole: worker\nsubscribe: []\nallowSubscribe: []\nallowPublish: []\nendpoints:\n  - endpoint: ${ORDERS}\n    commands: [list]\n---\n`);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" }); const releaseBroker = teardownOnSignal(broker, dir);
let daemon: DeliveryDaemon | undefined; const managers: ChildProcess[] = [];
const conns: NatsConnection[] = [];
const serving: Array<ReturnType<typeof serveEndpoint>> = [];
const stoppers: Array<() => Promise<void>> = [];

type Host = { child: ChildProcess; stdout: () => string; stderr: () => string };
/** Start one manager process. A successor started while the dead one's lease still stands exits on
 *  the lease refusal, so that one exit is retried until the lease lapses. */
async function startHost(): Promise<Host> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const child = spawn(tsx, [host], { cwd: repo, env: { ...ambientEnv, REPRO_ROOT: root, REPRO_SPACE: space, REPRO_SERVERS: servers, REPRO_OBSERVER_CREDS: observerCreds, REPRO_EVICTOR_CREDS: evictorCreds, REPRO_ACCOUNT_ID: auth.account.pub, REPRO_RENEW_ON_STDIN: "1", COTAL_SERVER: "", COTAL_SERVERS: "", COTAL_CREDS: "", NATS_URL: "" }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    managers.push(child);
    let out = "", err = "";
    child.stdout?.on("data", (b) => out += String(b)); child.stderr?.on("data", (b) => err += String(b));
    while (Date.now() < deadline) {
      if (out.includes("REPRO_MANAGER ")) return { child, stdout: () => out, stderr: () => err };
      if (child.exitCode !== null) break;
      await wait(100);
    }
    if (child.exitCode === null) throw new Error(`manager readiness timeout: ${err}`);
    if (!/already serves space/.test(err) || Date.now() >= deadline) throw new Error(`manager exited ${child.exitCode}: ${err}`);
    await wait(2_000);
  }
}
/** Run the manager's own renewal of one seat in `h` and return its answer. A renewal in the same
 *  second as the credential it replaces signs the same bytes, so it waits for the next second. */
async function renew(h: Host, name: string, current: string): Promise<string> {
  const iat = (JSON.parse(Buffer.from(jwtOf(current).split(".")[1]!, "base64url").toString()) as { iat: number }).iat;
  await until(() => Math.floor(Date.now() / 1000) > iat, 3_000);
  const marker = `REPRO_RENEWED ${name} `;
  const seen = h.stdout().split(marker).length;
  h.child.stdin!.write(`RENEW ${name}\n`);
  await until(() => h.stdout().split(marker).length > seen, 30_000);
  return h.stdout().split(marker).at(-1)!.split("\n")[0]!;
}
const connectWith = async (creds: string): Promise<NatsConnection> => {
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  conns.push(nc);
  return nc;
};
const close = async (nc: NatsConnection) => { await nc.drain().catch(() => nc.close()); };
const jwtOf = (creds: string) => /BEGIN NATS USER JWT-+\s+(\S+)/.exec(creds)![1]!;
/** The publish rows a credential's JWT carries. */
const pubRows = (creds: string): string[] =>
  (JSON.parse(Buffer.from(jwtOf(creds).split(".")[1]!, "base64url").toString()) as { nats: { pub: { allow: string[] } } }).nats.pub.allow;
const rowFor = (rows: string[], command: string) => rows.some((r) => r.startsWith(`cotal.${space}.ep.v1.one.com_example_orders.${command}.`));

try {
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await wait(50);
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  daemon = await bootDeliveryDaemon({ space, servers, auth, reloadStoreIdentity: workspaceSecretStore(root).identity });

  // The third-party endpoint, registered and served the way a static operator serves one (the
  // Linear endpoint's path): an `endpoint-serve-executor` connection publishes the contracts, opens
  // the issuance gate, registers through the registration barrier and marks the instance ready, and
  // the serve credential is minted through that gate from the serve grant.
  const OUTPUT = { type: "object", properties: { orders: { type: "array", items: { type: "string" } } }, required: ["orders"], additionalProperties: false };
  const table = serviceContractTable(["list", "create"].map((name) => ({ name, input: VOID_SCHEMA, output: OUTPUT })));
  const doc = { urn: "com.example.orders", revision: 1, attributes: [], events: [], commands: ["list", "create"].map((name) =>
    ({ name, class: "ephemeral" as const, targeted: false, capability: "orders.call", inputDigest: singleDocumentClosure(VOID_SCHEMA).closureDigest, outputDigest: singleDocumentClosure(OUTPUT).closureDigest })) };
  const { manifest, closureDigest } = singleDocumentClosure(doc);
  const artifacts = new Map<string, unknown>([[manifest.root, doc], [closureDigest, manifest]]);
  const readClusterArtifact = (d: string) => artifacts.get(d);
  const authority = { authorize: (name: string, who: string) => ({ authorized: name === ORDERS && who === DEV_OWNER, revision: 0 }) };
  // What each handler received, by instance, command and the caller the broker pinned on the
  // subject: the observed arrival of each request.
  const received: Array<{ instance: string; command: string; actor: string }> = [];
  let published = false;
  const serveOrders = async (instanceId: string) => {
    const serveIdentity = newIdentity();
    const executorNc = await connectWith(await mintCreds(auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint: ORDERS, instanceId } }));
    const ekvm = new Kvm(executorNc);
    const recordsKv = await ekvm.open(recordsBucket(space)), authKv = await ekvm.open(epAuthBucket(space));
    if (!published) {
      const storeCtx = await contractStoreContext(executorNc, space);
      for (const value of [...table.artifactValues(), doc, manifest]) await publishContractArtifact(storeCtx, contractArtifactCanonicalBytes(value));
      published = true;
    }
    await provisionEndpointGateOpen(authKv, { endpoint: ORDERS, instanceId, principal: principalKey(DEV_OWNER, serveIdentity.id).key });
    const { registrationRevision } = await registerServiceInstance(recordsKv, {
      space, spec: { endpoint: ORDERS, owner: DEV_OWNER, clusterDigests: [closureDigest], protocol: { v: 1 } }, instanceId, registrant: { owner: DEV_OWNER }, authority,
      barrier: endpointRegistrationBarrier(authKv, space, { endpoint: ORDERS, instanceId, opId: mintLifecycleUid() }), readClusterArtifact,
      observeHolderGeneration: (holder) => readEndpointGateGeneration(authKv, { endpoint: ORDERS, instanceId: holder }),
    });
    const fence = serveIssuanceGateKv(authKv, space, { endpoint: ORDERS, instanceId });
    const readProcessEpoch = async () => (await fence.observe())!.processEpoch;
    const epoch = await readProcessEpoch();
    const grant = await authorizeServeGrant(recordsKv, { space, endpoint: ORDERS, instanceId, epoch, holder: { owner: DEV_OWNER }, authority, readClusterArtifact, readProcessEpoch });
    await writeServiceStatus(recordsKv, { endpoint: ORDERS, instanceId, epoch, status: { state: SERVICE_READY, epoch, observedSpecRevision: registrationRevision }, readProcessEpoch });
    const serveNc = await connectWith(await mintCreds(auth, serveIdentity, "endpoint-serve", { serveIssuance: fence, endpointServe: grant }));
    const handle = serveEndpoint(serveNc, space, grant, ["list", "create"].map((command) => ({
      command, contract: table.contracts[command]!,
      handler: (ctx) => {
        received.push({ instance: instanceId, command, actor: ctx.subject.caller.actor });
        return { orders: command === "list" ? ["o-1"] : [] };
      },
    })), { public: true });
    serving.push(handle);
    await serveNc.flush();
    return { instanceId, epoch, handle };
  };
  // The instance every class call reaches. The second instance, PINNED, is served near the end.
  const classInstance = await serveOrders(mintLifecycleUid());
  const epoch = classInstance.epoch;
  const PINNED = mintLifecycleUid();
  const call = (nc: NatsConnection, caller: EpCaller, command: "list" | "create") =>
    epCall(nc, space, { mode: "one" }, { endpoint: ORDERS, command, contract: table.contracts[command]!, caller }, { deadlineMs: 8_000, currentEpoch: () => epoch })
      .then((r) => r.reply as Reply, asValue);
  /** Call `list` and `create` with one credential. Returns whether list was answered by the
   *  handler, and whether the broker refused create while the handler received none. */
  const probe = async (creds: string, who: { actor: string; uid: string; acceptedToken: string }) => {
    const nc = await connectWith(creds);
    const violations: string[] = [];
    void (async () => { for await (const s of nc.status()) { const t = JSON.stringify(s); if (/permission/i.test(t)) violations.push(t); } })().catch(() => {});
    try {
      const generation = (await readAcceptedRow(nc, space, who.acceptedToken)).generation;
      const caller = { owner: DEV_OWNER, actor: who.actor, uid: who.uid, generation } as IssuedCaller;
      const listsBefore = received.filter((r) => r.command === "list" && r.actor === who.actor).length;
      const list = await call(nc, caller, "list");
      const listed = list.ok === true && list.data?.orders?.[0] === "o-1" && received.filter((r) => r.command === "list" && r.actor === who.actor).length === listsBefore + 1;
      const create = await call(nc, caller, "create");
      await until(() => violations.some((v) => v.includes(".com_example_orders.create.")), 3_000);
      const refused = create.ok !== true && create.error?.code === "permission-denied" && violations.some((v) => v.includes(".com_example_orders.create.")) && !received.some((r) => r.command === "create" && r.actor === who.actor);
      return { listed, refused, list, create, violations };
    } finally {
      await close(nc);
    }
  };

  // The spawner: an issued agent credential holding `spawn`, the worker role and `list`, on the
  // class rail and pinned to PINNED, as an operator persona naming both entries would mint it.
  const sid = newIdentity(), suid = mintLifecycleUid();
  const sIssued = { generation: mintGeneration(Math.floor(Date.now() / 1000) + 3600), acceptedToken: mintAcceptedToken() };
  const spawnerEndpoints = lowerPersonaEndpoints([{ endpoint: ORDERS, commands: ["list"] }, { endpoint: ORDERS, commands: ["list"], instanceId: PINNED }]);
  const spawnerCreds = await withIssuerSession({ servers, space, auth, tls: false }, (s) =>
    mintCreds(auth, sid, "agent", { lifecycleUid: suid, capabilities: ["spawn", "role:worker"], endpointCapabilities: spawnerEndpoints, expiresInSeconds: 3600, issued: sIssued, issuance: { mode: "issue", store: s.store, accepted: s.accepted, sources: [] } }));
  const spawner = { owner: DEV_OWNER, actor: sid.id, uid: suid, generation: sIssued.generation } as IssuedCaller;
  const spawnerNc = await connectWith(spawnerCreds);
  const own = await call(spawnerNc, spawner, "list");
  check("the served endpoint answers the spawner's own list call", own.ok === true && own.data?.orders?.[0] === "o-1" && received.some((r) => r.command === "list" && r.actor === sid.id), own);

  let first = await startHost();
  // The successor registers the same manager instance at the next epoch.
  let managerEpoch = 0;
  const manager = (command: string, args: Record<string, unknown>, target?: { actor: string; lifecycleUid: string }) =>
    epCall(spawnerNc, space, { mode: "one" }, {
      endpoint: MANAGER_ENDPOINT, command, contract: MANAGER_CONTRACTS[command], caller: spawner, args,
      ...(target ? { target: { mode: "owner" as const, owner: DEV_OWNER, actor: target.actor, lifecycleUid: target.lifecycleUid } } : {}),
    }, { deadlineMs: 20_000, currentEpoch: async () => managerEpoch }).then((r) => r.reply as Reply, asValue);
  const persona = (commands: string[]) => ({ prompt: "You list orders.", endpoints: [{ endpoint: ORDERS, commands }] });

  const wide = await manager("spawn", { name: "helper_wide", agent: "tmux-adopt-stub", cwd: repo, events: false, persona: persona(["create", "list"]) });
  check("a served spawn whose inline persona names a command the spawner lacks is refused by name",
    wide.ok !== true && /com\.example\.orders create/.test(wide.error?.message ?? "") && !/com\.example\.orders list/.test(wide.error?.message ?? ""), wide);

  const seats: Record<string, { actor: string; uid: string; acceptedToken: string }> = {};
  const started = async (name: string, reply: { ok?: boolean }): Promise<boolean> => {
    let record: ReturnType<typeof readSeatRecord>;
    await until(() => (record = readSeatRecord(root, space, name)) !== undefined, 60_000);
    const identity = record?.agent.identity;
    if (identity?.mode === "static") seats[name] = { actor: identity.id, uid: identity.lifecycleUid, acceptedToken: identity.issued?.acceptedToken ?? "" };
    return reply.ok === true && seats[name] !== undefined && JSON.stringify(record?.agent.launch.endpoints) === JSON.stringify([{ endpoint: ORDERS, commands: ["list"] }]);
  };
  const inline = await manager("spawn", { name: "helper_inline", agent: "tmux-adopt-stub", cwd: repo, events: false, persona: persona(["list"]) });
  check("a served spawn whose inline persona hands on list starts the helper", await started("helper_inline", inline), { inline, stderr: first.stderr().slice(-1500) });
  const fromFile = await manager("spawn", { name: "helper_file", agent: "tmux-adopt-stub", cwd: repo, events: false });
  check("a served spawn of an agent file that hands on list starts the helper", await started("helper_file", fromFile), { fromFile, stderr: first.stderr().slice(-1500) });

  // The seat process's own environment: what the connector wrote at launch, as the session reads it.
  const launchedEndpoints = (name: string): string | undefined => {
    const pane = tmux("list-panes", "-a", "-F", "#{window_name} #{pane_pid}").split("\n").map((l) => l.split(" ")).find(([w]) => w === name)?.[1];
    if (pane === undefined) return undefined;
    return readFileSync(`/proc/${pane}/environ`, "utf8").split("\0").find((kv) => kv.startsWith("COTAL_ENDPOINTS="))?.slice("COTAL_ENDPOINTS=".length);
  };
  const handed = { helper_inline: launchedEndpoints("helper_inline"), helper_file: launchedEndpoints("helper_file") };
  check("each helper's session is launched with COTAL_ENDPOINTS naming list alone",
    Object.values(handed).every((v) => v === JSON.stringify([{ endpoint: ORDERS, commands: ["list"] }])), handed);
  const credsOf = (name: string) => readFileSync(agentLifecycleSecretFilePaths(root, space, name, seats[name]!.uid).creds, "utf8");
  const helpers = ["helper_inline", "helper_file"];
  check("each helper's credential carries the list request row and no create row",
    helpers.every((n) => rowFor(pubRows(credsOf(n)), "list") && !rowFor(pubRows(credsOf(n)), "create")), helpers.map((n) => pubRows(credsOf(n)).filter((r) => r.includes("orders"))));
  const probes = [];
  for (const n of helpers) probes.push(await probe(credsOf(n), seats[n]!));
  check("each helper's credential calls list, and the endpoint's handler receives and answers it", probes.every((p) => p.listed), probes);
  check("the broker refuses each helper's create call, and the handler never receives one", probes.every((p) => p.refused), probes);

  // The spawner gains create: it is issued again on a fresh generation, and its own call reaches
  // the handler. The helper's renewal below reads the helper's record, never the spawner's grant.
  const sWider = { generation: mintGeneration(Math.floor(Date.now() / 1000) + 3600), acceptedToken: mintAcceptedToken() };
  const widerSpawnerNc = await connectWith(await withIssuerSession({ servers, space, auth, tls: false }, (s) =>
    mintCreds(auth, sid, "agent", { lifecycleUid: suid, capabilities: ["spawn", "role:worker"], endpointCapabilities: [{ endpoint: ORDERS, command: "list" }, { endpoint: ORDERS, command: "create" }], expiresInSeconds: 3600, issued: sWider, issuance: { mode: "issue", store: s.store, accepted: s.accepted, sources: [] } })));
  const gainedCreate = await call(widerSpawnerNc, { ...spawner, generation: sWider.generation } as IssuedCaller, "create");
  check("the spawner is issued again with create, and its own create call reaches the handler",
    gainedCreate.ok === true && received.some((r) => r.command === "create" && r.actor === sid.id), gainedCreate);
  const helper = seats.helper_inline!;
  const beforeRenew = credsOf("helper_inline");
  const renewed = await renew(first, "helper_inline", beforeRenew);
  const afterRenew = credsOf("helper_inline");
  check("a renewal after that gain re-signs the inline helper's credential with the same endpoint rows",
    renewed === "ok" && jwtOf(afterRenew) !== jwtOf(beforeRenew) && JSON.stringify(pubRows(afterRenew).sort()) === JSON.stringify(pubRows(beforeRenew).sort()),
    { renewed, resigned: jwtOf(afterRenew) !== jwtOf(beforeRenew), gained: pubRows(afterRenew).filter((r) => !pubRows(beforeRenew).includes(r)), lost: pubRows(beforeRenew).filter((r) => !pubRows(afterRenew).includes(r)) });
  const renewedProbe = await probe(afterRenew, helper);
  check("the renewed credential calls list, and create is still refused", renewedProbe.listed && renewedProbe.refused, renewedProbe);

  process.kill(Number(JSON.parse(first.stdout().split("REPRO_MANAGER ")[1]!.split("\n")[0]!).managerPid), "SIGKILL");
  await new Promise((r) => first.child.exitCode !== null ? r(undefined) : first.child.once("exit", r));
  first = await startHost();
  managerEpoch = 1;
  const adopted = await until(() => first.stderr().includes("helper_inline: adopted the seat its previous manager left"), 90_000);
  check("the helper's seat outlives the manager's crash and the successor adopts it", adopted, first.stderr().slice(-3000));
  const adoptedProbe = await probe(credsOf("helper_inline"), helper);
  check("after adoption the helper's credential calls list, and create is still refused", adoptedProbe.listed && adoptedProbe.refused, adoptedProbe);
  const renewedAgain = await renew(first, "helper_inline", afterRenew);
  const afterAdoptRenew = credsOf("helper_inline");
  const againProbe = renewedAgain === "ok" ? await probe(afterAdoptRenew, helper) : undefined;
  check("a renewal through the successor keeps list and leaves out create",
    renewedAgain === "ok" && jwtOf(afterAdoptRenew) !== jwtOf(afterRenew) && rowFor(pubRows(afterAdoptRenew), "list") && !rowFor(pubRows(afterAdoptRenew), "create") && againProbe?.listed === true && againProbe.refused, { renewedAgain, againProbe });

  // The ledger is read through a lifecycle-executor credential pinned to the helper's lifecycle,
  // the profile the manager itself uses. The slot row names every credential the lifecycle minted.
  const executor = await connectWith(await mintCreds(auth, newIdentity(), "lifecycle-executor", { lifecycleExecutor: { owner: DEV_OWNER, actor: helper.actor, lifecycleUid: helper.uid, alias: "helper_inline" } }));
  const kvm = new Kvm(executor);
  const t = staticLifecycleTransport(await kvm.open(recordsBucket(space)), await kvm.open(epAuthBucket(space)));
  const credentialIds = (await readStaticSlot(t, DEV_OWNER, "helper_inline"))?.row.credentialIds ?? [];
  const ledger = async (): Promise<CredentialLedgerRow[]> => {
    const rows: CredentialLedgerRow[] = [];
    for (const id of credentialIds) { const e = await t.getAuth(credRowKey(helper.uid, id)); if (e !== undefined) rows.push(parseLedgerRow(e.value, credRowKey(helper.uid, id))); }
    return rows;
  };
  const activeBefore = (await ledger()).filter((r) => r.state === "active").length;
  // A copy of the helper's credential, connected before the despawn. It does not reconnect, so
  // the broker's kick closes it for good. A static mesh would let a reconnecting copy back in with
  // its unexpired credential; this cell grades the eviction only.
  const copy = await connect({ servers, ...standaloneConnectOpts({ creds: afterAdoptRenew, tls: false }), reconnect: false, maxReconnectAttempts: 0 });
  conns.push(copy);
  await copy.flush();
  let copyClosed = false;
  void copy.closed().then(() => { copyClosed = true; });
  const despawned = await manager("despawn", { graceful: false }, { actor: helper.actor, lifecycleUid: helper.uid });
  let after: CredentialLedgerRow[] = [];
  const revoked = await until(async () => (after = await ledger()).length === 3 && after.every((r) => r.state === "revoked"), 60_000);
  check("a despawn revokes every ledger row of the helper's lifecycle",
    despawned.ok === true && activeBefore === 3 && revoked, { despawned, activeBefore, states: after.map((r) => r.state), stderr: first.stderr().slice(-3000) });
  // The terminal writes its audit record, with the broker's answer to its eviction, once the
  // verify re-scan finds the principal gone, which is after the kick closed the copy.
  const closedByKick = await until(() => copyClosed, 30_000);
  let audit: { broker?: { kicked?: number; remaining?: number; verifiedGone?: boolean } } | undefined;
  await until(async () => {
    const entry = await t.getRecord(recordSpecKey(RECORD_KINDS.lifecycle, [DEV_OWNER, helper.actor, helper.uid]));
    if (entry) audit = JSON.parse(new TextDecoder().decode(entry.value));
    return audit !== undefined;
  }, 30_000);
  check("the despawn evicts a live connection made with a copy of the helper's credential",
    closedByKick && (audit?.broker?.kicked ?? 0) >= 1 && audit?.broker?.remaining === 0 && audit.broker.verifiedGone === true, { despawned, audit, stderr: first.stderr().slice(-2000) });

  // A pinned entry, through the agent tools. PINNED is not serving yet.
  const pinnedList = [{ endpoint: ORDERS, commands: ["list"], instanceId: PINNED }];
  const pinnedReply = await manager("spawn", { name: "helper_pinned", agent: "tmux-adopt-stub", cwd: repo, events: false, persona: { prompt: "You list orders on one instance.", endpoints: pinnedList } });
  let pinnedRecord: ReturnType<typeof readSeatRecord>;
  await until(() => (pinnedRecord = readSeatRecord(root, space, "helper_pinned")) !== undefined, 60_000);
  const pinnedIdentity = pinnedRecord?.agent.identity;
  const pinnedSeat = pinnedIdentity?.mode === "static" ? { actor: pinnedIdentity.id, uid: pinnedIdentity.lifecycleUid, acceptedToken: pinnedIdentity.issued?.acceptedToken ?? "" } : undefined;
  const pinnedCreds = pinnedSeat ? readFileSync(agentLifecycleSecretFilePaths(root, space, "helper_pinned", pinnedSeat.uid).creds, "utf8") : "";
  const pinnedRows = pinnedCreds ? pubRows(pinnedCreds) : [];
  const instRow = (command: string) => pinnedRows.some((r) => r.startsWith(`cotal.${space}.ep.v1.inst.com_example_orders.${PINNED}.${command}.`));
  check("a served spawn hands on list pinned to one instance, as that instance's list and describe rows and no class row",
    pinnedReply.ok === true && pinnedSeat !== undefined && JSON.stringify(pinnedRecord?.agent.launch.endpoints) === JSON.stringify(pinnedList)
      && instRow("list") && instRow("describe") && !pinnedRows.some((r) => r.includes(".one.com_example_orders.")),
    { pinnedReply, endpoints: pinnedRecord?.agent.launch.endpoints, rows: pinnedRows.filter((r) => r.includes("orders")), stderr: first.stderr().slice(-1500) });
  if (!pinnedSeat) throw new Error("the pinned helper did not start");

  // The real tool handlers, over an endpoint that connects with the helper's own credential.
  const helperEp = new CotalEndpoint({ space, servers, tls: false, creds: pinnedCreds, lifecycleUid: pinnedSeat.uid, acceptedToken: pinnedSeat.acceptedToken, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false, card: { id: pinnedSeat.actor, name: "helper_pinned_tools", kind: "endpoint" } });
  stoppers.push(() => helperEp.stop());
  // A broker refusal is reported on the endpoint's error event as well as to the caller, as it is to
  // a connector's agent, which listens for it.
  const helperErrors: string[] = [];
  helperEp.on("error", (e: unknown) => { helperErrors.push(String((e as Error).message).slice(0, 200)); });
  await helperEp.start();
  const toolConfig: AgentConfig = { space, name: "helper_pinned_tools", servers, tls: false, creds: pinnedCreds, kind: "agent", id: pinnedSeat.actor, lifecycleUid: pinnedSeat.uid, subscribe: [], allowSubscribe: [], allowPublish: [] };
  const tools = cotalToolSpecs(toolConfig, "smoke");
  const tool = async (name: "cotal_describe" | "cotal_invoke", args: Record<string, unknown>) => {
    const r = await tools.find((t) => t.name === name)!.run({ ep: helperEp } as unknown as MeshAgent, toolConfig, args);
    return { text: r.text, isError: r.isError === true };
  };
  const helperGot = (instance: string) => received.filter((r) => r.instance === instance && r.actor === pinnedSeat.actor).length;
  const other = classInstance.instanceId;
  // The endpoint's two class caches: the full discovery handle a describe stores, and the
  // command-specific handle an unpinned invoke stores. A pinned call reads and writes neither.
  const caches = helperEp as unknown as { resolvedServices: Map<string, { responder: { instanceId: string } }>; resolvedCommandServices: Map<string, Map<string, { responder: { instanceId: string } }>> };
  const cached = () => ({ full: caches.resolvedServices.get(ORDERS)?.responder.instanceId, list: caches.resolvedCommandServices.get(ORDERS)?.get("list")?.responder.instanceId });
  const refusedByBroker = (text: string) => /no caller grant|permission-denied|REFUSED BY THE BROKER/.test(text);

  // Only the other instance serves. An unpinned invoke resolves there and stores that handle before
  // its class publish is refused; the helper holds no class row, and the retry on that instance's
  // rail is refused too. The describe after it stores the full handle, also from there.
  const warmInvoke = await tool("cotal_invoke", { endpoint: ORDERS, command: "list", timeoutMs: 8_000 });
  check("while only the other instance serves, an unpinned cotal_invoke of list resolves there and never runs there",
    warmInvoke.isError && refusedByBroker(warmInvoke.text) && cached().list === other && helperGot(other) === 0, { warmInvoke, cached: cached(), otherGot: helperGot(other) });
  const unpinnedDescribe = await tool("cotal_describe", { endpoint: ORDERS });
  check("an unpinned cotal_describe is answered by the other instance, which the class baseline allows, and both class caches hold it",
    !unpinnedDescribe.isError && unpinnedDescribe.text.includes(`instance ${other}`) && cached().full === other && cached().list === other, { unpinnedDescribe: unpinnedDescribe.text.slice(0, 300), cached: cached() });

  const pinned = await serveOrders(PINNED);
  const pinnedDescribe = await tool("cotal_describe", { endpoint: ORDERS, instance: PINNED });
  const afterDescribe = cached();
  const pinnedInvoke = await tool("cotal_invoke", { endpoint: ORDERS, command: "list", instance: PINNED, timeoutMs: 8_000 });
  const afterInvoke = cached();
  check("naming the pinned instance, cotal_describe and cotal_invoke reach it, its handler answers, and both class caches still hold the other instance",
    !pinnedDescribe.isError && pinnedDescribe.text.includes(`instance ${PINNED}`)
      && !pinnedInvoke.isError && pinnedInvoke.text.includes(`answered by instance ${PINNED}`) && pinnedInvoke.text.includes("o-1") && helperGot(PINNED) === 1
      && afterDescribe.full === other && afterDescribe.list === other && afterInvoke.full === other && afterInvoke.list === other,
    { pinnedDescribe: pinnedDescribe.text.slice(0, 300), pinnedInvoke, pinnedGot: helperGot(PINNED), afterDescribe, afterInvoke });

  const toOther = await tool("cotal_invoke", { endpoint: ORDERS, command: "list", instance: other, timeoutMs: 8_000 });
  check("naming the other instance, the broker refuses the call and that handler receives nothing",
    toOther.isError && refusedByBroker(toOther.text) && helperGot(other) === 0, { toOther, otherGot: helperGot(other) });

  const unpinnedInvoke = await tool("cotal_invoke", { endpoint: ORDERS, command: "list", timeoutMs: 8_000 });
  check("an unpinned cotal_invoke, with both instances serving, never runs the command on the other instance",
    !unpinnedInvoke.text.includes(`answered by instance ${other}`) && helperGot(other) === 0, { unpinnedInvoke, otherGot: helperGot(other) });

  // A valid instance the helper holds rows for, but that no longer serves, is unanswered: a
  // different fault from the broker refusing an instance the helper holds no row for.
  await pinned.handle.stop();
  const pinnedGotBefore = helperGot(PINNED);
  const stoppedCall = await tool("cotal_invoke", { endpoint: ORDERS, command: "list", instance: PINNED, timeoutMs: 3_000 });
  check("with the pinned instance stopped, a pinned call goes unanswered rather than refused, and the other instance receives nothing",
    stoppedCall.isError && /deadline-exceeded|unavailable|no describe reply/.test(stoppedCall.text) && !refusedByBroker(stoppedCall.text) && helperGot(other) === 0 && helperGot(PINNED) === pinnedGotBefore,
    { stoppedCall, otherGot: helperGot(other), helperErrors });
} catch (error) {
  console.log(`  the suite stopped early: ${(error as Error).stack ?? String(error)}`);
  for (const name of CELLS) if (!graded.has(name)) check(name, false, "not reached");
} finally {
  for (const stop of stoppers) await stop().catch(() => {});
  for (const handle of serving) await handle.stop().catch(() => {});
  for (const nc of conns) await close(nc);
  const managerExits = managers.map((child) => child.exitCode === null ? new Promise<void>((r) => child.once("exit", () => r())) : Promise.resolve());
  for (const child of managers) if (child.exitCode === null) stopGroup(child.pid);
  await Promise.all(managerExits);
  try { tmux("kill-server"); } catch { /* already gone */ }
  rmSync(tmuxDir, { recursive: true, force: true });
  await daemon?.stop().catch(() => {});
  broker.kill("SIGKILL");
  await wait(300);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}

if (pass + fail !== CELLS.length) throw new Error(`expected ${CELLS.length} cells, ran ${pass + fail}; a cell was graded twice or skipped`);
console.log(`\nPERSONA ENDPOINTS SERVED SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"} (${pass} passed, ${fail} failed)`);
emitSentinel({ passed: pass, failed: fail });
if (fail) process.exitCode = 1;
