/**
 * Manager LOAD harness — what one live seat costs the manager daemon. Capacity, not correctness.
 *
 * Boots a JWT-auth broker and the real delivery daemon (`_boot-broker.ts`, `_boot-delivery.ts`),
 * then runs the REAL `Manager` (pty runtime, the default) in its own process and has it spawn seats
 * through `startAgent`, the same call `cotal spawn` and `cotal_spawn` reach. Every spawn is the
 * product's: the slot reserve and activation saga, `provisionAgent`, the cred file, the pty child,
 * and the presence race that resolves the seat as started.
 *
 * The seats are STUBS, never model processes. The stub connector's launch is a shell that hands its
 * launch env (every `COTAL_*` the manager stamped, including `COTAL_MANAGER_INSTANCE` and the
 * accepted-row token) to a shared seat host and then sleeps, so the manager supervises one real
 * child process per seat in its own pty. The seat host builds each seat exactly as a connector does,
 * `configFromEnv` then `MeshAgent`, so every seat registers presence, binds its durables and arms
 * the turn relay against this manager. One Node process holds every seat; a Node process per seat
 * would cost the field more memory than the manager under test.
 *
 * It spawns in steps (`--steps 10,25,50`) and, at each step, lets the seats settle and then reads
 * the manager process's CPU and RSS over an idle window, so the per-seat slope comes from one
 * manager process rather than across runs. It also reports the manager's CPU per spawn. The
 * manager's own ceiling is `MAX_AGENTS` (50) per manager; a step above it is refused by design and
 * the refusal is reported, not hidden.
 *
 * `--process-memory --seat real` reads process RSS/PSS/USS without heap snapshots. It checks
 * authenticated manager `ps` before and after each idle window against the successful spawn
 * identities and their lifecycle UIDs, and requires current mesh presence and running, unchanged
 * PIDs. Missing samples or failed spawns fail the run. This is sampled mesh readiness, not
 * continuous application health. The mode is Linux-only and cannot be combined with `--ram`.
 * Its `MSL_RESULT` rows include the measured counts and memory; `MSL_DONE` counts the checks.
 * Observer calls and smaps reads sit outside the CPU window, but the observer connection remains.
 *
 * `--ram` adds the manager's memory at every step: RSS, PSS and USS from outside, V8's heap from
 * inside, and a heap snapshot at the first and last step summarised by class.
 *
 * `--shape dist` runs the manager the way an installed `cotal` runs it: plain `node` (this file's
 * types stripped by Node itself, no tsx loader) importing the BUILT `@cotal-ai/manager`. The
 * default `--shape src` is tsx over the source, which is how `deploy/docker` runs it
 * (`tsx bin/cotal.ts`). The difference between the two is the cost of the loader and of
 * transpiling at run time, not of the manager.
 *
 * `--seat real` launches the REAL Claude Code connector process for every seat (the plugin's MCP
 * server through `dist/seat.cjs`, with the node flags its `.mcp.json` passes), in place of the stub and its
 * shared seat host. The shared host is not started in real-seat mode; its metrics are n/a.
 * Per-seat RSS, PSS and USS need `--ram` or `--process-memory`. That process is what one seat
 * costs its host besides the model harness itself; it joins the mesh at start, before any MCP
 * traffic, so no Claude process is needed to drive it. `--real-entry direct` keeps the legacy
 * `mcp.cjs` entry as an explicit comparison arm. Each run owns a fresh HOME; its stock compile
 * cache starts empty, then is shared by subsequent seats in that run. Cache environment
 * overrides refuse rather than measuring an unrelated cache. Results name the entry used.
 *
 * `--spaces N` adds a shared-broker control with N distinct accounts and Managers. It requires
 * dist, real, stock and process-memory; steps are seats per Manager. Each space has a private
 * HOME/cache. Account-scoped native connection observations prove placement on the same server.
 * The parent owns the SYS signer and all Plane-3 contexts; this is a static trusted same-UID
 * fixture, not hostile-tenant, model or Cloud acceptance. The shared broker is counted once.
 *
 * `--initialized-mcp` (with `--spaces`) replaces each Manager's pty runtime with a test-only
 * RuntimeProvider whose handles own one MCP SDK `Client` over `StdioClientTransport` per stock seat
 * child, inside the Manager process. A handle is nonterminal: attach refuses, and there is no exit
 * code. Its `initialized` promise settles after `initialize` and `listTools`; the Manager returns
 * the handle synchronously. `stop({ graceful: false })` and `interrupt()` signal only the pinned
 * PID whose start time still matches, and `waitForExit` resolves on the SDK close callback plus the
 * PID's absence. `--docs-workload index|page|search --docs-oracle <file>` then sends one cold docs
 * call per seat after a parent barrier. `--manager-death-control` kills one Manager at the end.
 * `--initialized-mcp-lifecycle` runs the handle's lifecycle controls without a broker.
 *
 * Run (needs nats-server on PATH):
 *   pnpm -C implementations/manager smoke:manager-seat-load --steps 10,25,50 --seconds 60 [--ram] [--shape dist] [--seat real]
 *   pnpm -C implementations/manager smoke:manager-seat-load --shape dist --seat real --process-memory --steps 10,25,50
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, readlinkSync, rmSync, renameSync, statSync } from "node:fs";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { getHeapSpaceStatistics, writeHeapSnapshot } from "node:v8";
import {
  CotalEndpoint, decodeNatsJwt, composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, connzRequestSubject, MEMBERSHIP_INBOX_PREFIX, mintMembershipObserverCreds, standaloneConnectOpts, createSpaceAuth, mintCreds, mintLifecycleUid, instanceOnlyManagerCapabilities, newIdentity, registry, setupSpaceStreams,
  type AgentHandle, type AttachSession, type Connector, type LaunchOpts, type LaunchSpec, type Runtime, type RuntimeProvider, type SpaceAuth,
} from "@cotal-ai/core";
import { MeshAgent, configFromEnv } from "@cotal-ai/connector-core";
import { authDir, saveSpaceAuth, saveBrokerAuth, saveSpaceAccountAuth, identityRecord, assertRecordIdentity, type ProcessIdentityRecord, workspaceSecretStore } from "@cotal-ai/workspace";
// Every relative and test-only import is dynamic and in the orchestrator, so that `--shape dist`
// can run this file's manager child under plain `node`, which resolves only built packages.

// Scrub any ambient COTAL_* before anything is handed to a child. Whatever runs this harness may
// itself be a managed agent session, and its COTAL_SERVERS / credential variables name a LIVE mesh.
const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
for (const k of Object.keys(cleanEnv)) if (k.startsWith("COTAL_")) delete cleanEnv[k];

const CHANNEL = "general";
const ROLE = "default";
const CONNECTOR = "load-stub";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ipcSend = (m: unknown): Promise<void> => new Promise((r) => { process.send!(m, () => r()); });
const nextCmd = <T>(): Promise<T> => new Promise((r) => process.once("message", (m) => r(m as T)));

interface ManagerJob { kind: "manager"; space: string; servers: string; workspaceRoot: string; seatDir: string; stubToken: string; dist: boolean; realSeat?: string; observeSeats?: boolean; storeRoot?: string; strictStop?: boolean; initializedMcp?: boolean }
interface SeatReceipt { name: string; id: string; lifecycleUid: string }
interface SeatsJob { kind: "seats"; seatDir: string }
type Job = ManagerJob | SeatsJob;

/** The stub seat: hand every COTAL_* the manager stamped to the seat host, then idle. The sleep
 *  carries a per-run token so the run's own children, and only those, can be swept at the end. */
const stubScript = (token: string) =>
  `umask 077; f="$SEAT_HOST_DIR/$COTAL_ID"; env | grep '^COTAL_' > "$f.tmp" && mv "$f.tmp" "$f.seat"; exec sleep 99999.${token}`;
/** The real seat: the Claude Code connector's MCP server, launched with the node flags its
 *  `.mcp.json` passes, a control socket and token of its own, and the run's token as a trailing
 *  argument (ignored by the server) so the sweep can find it. `--heapsnapshot-signal` only arms a
 *  signal handler, so one seat can be snapshotted without changing what any seat holds. */
const realSeatScript = (token: string, mcp: string) =>
  `umask 077; export COTAL_CONTROL_SOCKET="$SEAT_HOST_DIR/$COTAL_ID.sock" COTAL_CONTROL_TOKEN="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \\n')"; ` +
  `exec node --optimize-for-size --max-semi-space-size=1 --heapsnapshot-signal=SIGUSR2 '${mcp}' seatload-${token}`;
const MB = 1048576;
/** V8's view of the manager's memory, in MB. */
const nodeMem = () => {
  const m = process.memoryUsage();
  const code = getHeapSpaceStatistics().filter((x) => x.space_name.startsWith("code")).reduce((a, x) => a + x.space_used_size, 0);
  return { heapUsedMb: m.heapUsed / MB, heapTotalMb: m.heapTotal / MB, externalMb: m.external / MB, codeMb: code / MB };
};

// ---------------------------------------------------------------------------------------------
// initialized-MCP runtime: one SDK Client per stock seat child, inside the Manager
// ---------------------------------------------------------------------------------------------

interface McpSdk {
  Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
  StdioClientTransport: typeof import("@modelcontextprotocol/sdk/client/stdio.js").StdioClientTransport;
  requestTimeoutMs: number;
}
const loadMcpSdk = async (): Promise<McpSdk> => ({
  Client: (await import("@modelcontextprotocol/sdk/client/index.js")).Client,
  StdioClientTransport: (await import("@modelcontextprotocol/sdk/client/stdio.js")).StdioClientTransport,
  requestTimeoutMs: (await import("@modelcontextprotocol/sdk/shared/protocol.js")).DEFAULT_REQUEST_TIMEOUT_MSEC,
});
/** Field 22 of /proc/<pid>/stat: it changes if the PID is ever reused. */
const startTickOf = (pid: number): string | undefined => {
  try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; }
  catch { return undefined; }
};
const epochMs = () => performance.timeOrigin + performance.now();
const OS_ABSENCE_POLL_BOUND_MS = 10_000;

interface McpInit { pid: number; startTick: string; tools: number; initializeMs: number; listToolsMs: number }
/** A nonterminal handle on one MCP child. The Manager gets it synchronously; `initialized` settles
 *  after the SDK has completed `initialize` and `listTools`. Exit is the SDK's own close callback
 *  plus the pinned PID's absence; no exit code is invented, and `exitInfo` is absent. */
class InitializedMcpHandle implements AgentHandle {
  readonly kind = "initialized-mcp";
  readonly client: InstanceType<McpSdk["Client"]>;
  readonly initialized: Promise<McpInit>;
  initializeError: string | undefined;
  neverStarted = false;
  closeEvents = 0;
  clientErrors = 0;
  signalsSent: string[] = [];
  osAbsenceVerified = false;
  private readonly transport: InstanceType<McpSdk["StdioClientTransport"]>;
  private latched: { pid: number; tick: string } | undefined;
  private closed = false;
  private resolveClosed!: () => void;
  private readonly closedPromise = new Promise<void>((resolve) => { this.resolveClosed = resolve; });
  private exitPromise: Promise<void> | undefined;
  readonly name: string;
  constructor(name: string, sdk: McpSdk, spec: LaunchSpec, cwd: string) {
    this.name = name;
    if (spec.confirm !== undefined || spec.confirmBefore !== undefined || spec.confirmReady !== undefined || spec.confirmBlockers !== undefined
      || (spec.artifacts?.length ?? 0) > 0 || spec.sessionStatePath !== undefined)
      throw new Error("initialized-mcp runtime does not support startup confirmation, launch artifacts or session state files");
    this.transport = new sdk.StdioClientTransport({ command: spec.command, args: spec.args, ...(spec.env ? { env: spec.env } : {}), cwd, stderr: "ignore" });
    this.client = new sdk.Client({ name: "manager-seat-load", version: "0" }, { capabilities: {} });
    this.client.onclose = () => { this.closeEvents++; this.closed = true; this.resolveClosed(); };
    this.client.onerror = () => { this.clientErrors++; };
    const connecting = this.client.connect(this.transport);
    this.latch();
    this.initialized = this.initialize(connecting);
    this.initialized.catch(() => {}); // the barrier awaits it; this only keeps an early failure from being unhandled
  }
  private latch(): void {
    if (this.latched) return;
    const pid = this.transport.pid;
    if (pid === null || pid === undefined) return;
    const tick = startTickOf(pid);
    if (tick) this.latched = { pid, tick };
  }
  private async initialize(connecting: Promise<void>): Promise<McpInit> {
    const t0 = performance.now();
    try {
      await connecting;
      const t1 = performance.now();
      this.latch();
      const listed = await this.client.listTools();
      const t2 = performance.now();
      const names = new Set(listed.tools.map((tool) => tool.name));
      if (!names.has("cotal_docs") || !names.has("cotal_connection_status")) throw new Error("listTools omitted a required cotal tool");
      if (!this.latched) throw new Error("initialized MCP child reported no PID");
      return { pid: this.latched.pid, startTick: this.latched.tick, tools: listed.tools.length, initializeMs: t1 - t0, listToolsMs: t2 - t1 };
    } catch (error) {
      this.initializeError = (error instanceof Error ? error.message : "unreadable failure").slice(0, 200);
      if (!this.latched) { this.neverStarted = true; this.closed = true; this.resolveClosed(); }
      else void this.client.close().catch(() => {});
      throw error;
    }
  }
  get pid(): number | undefined { this.latch(); return this.latched?.pid; }
  status(): "running" | "exited" { return this.closed ? "exited" : "running"; }
  /** Signal only a PID whose recorded start time still matches. Delivery is not exit evidence. */
  private signal(sig: NodeJS.Signals): boolean {
    this.latch();
    if (this.closed || !this.latched || startTickOf(this.latched.pid) !== this.latched.tick) return false;
    process.kill(this.latched.pid, sig);
    this.signalsSent.push(sig);
    return true;
  }
  stop(opts?: { graceful?: boolean }): void {
    if (this.closed) return;
    if (opts?.graceful === false && this.signal("SIGKILL")) return;
    void this.client.close().catch(() => {}); // SDK: end stdin, then SIGTERM, then SIGKILL; completion is not exit proof
  }
  interrupt(): void {
    if (this.closed) return;
    if (!this.signal("SIGINT")) throw new Error("initialized-mcp: no owned process to interrupt");
  }
  waitForExit(): Promise<void> {
    return this.exitPromise ??= (async () => {
      await this.closedPromise;
      if (this.latched) {
        const deadline = performance.now() + OS_ABSENCE_POLL_BOUND_MS;
        while (startTickOf(this.latched.pid) === this.latched.tick) {
          if (performance.now() > deadline) throw new Error("initialized-mcp: SDK reported close but the PID is still present");
          await wait(20);
        }
      }
      this.osAbsenceVerified = true;
    })();
  }
  attach(): AttachSession { throw new Error("initialized-mcp seats have no terminal; use the mesh to talk to the seat"); }
}

const initializedMcpRuntime = (sdk: McpSdk, handles: Map<string, InitializedMcpHandle>): Runtime => ({
  kind: "initialized-mcp",
  streamsTerminal: false,
  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    const handle = new InitializedMcpHandle(name, sdk, spec, cwd);
    handles.set(name, handle);
    return handle;
  },
});

type DocsWorkload = "index" | "page" | "search";
const DOCS_CALLS: Record<DocsWorkload, Record<string, string>> = { index: {}, page: { page: "manifest" }, search: { query: "personaPermissions" } };
const sha256Text = (text: string) => createHash("sha256").update(text).digest("hex");
/** One MCP tool call's text, reduced to a hash and a byte count; the body is never retained. */
const callText = async (handle: InitializedMcpHandle, name: string, args: Record<string, string>) => {
  const sentAtMs = epochMs();
  try {
    const result = await handle.client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type?: string; text?: string }> | undefined;
    const text = content?.length === 1 && content[0]?.type === "text" ? content[0].text : undefined;
    const completedAtMs = epochMs();
    if (typeof text !== "string" || result.isError === true) return { sentAtMs, completedAtMs, error: result.isError === true ? "tool error result" : "unexpected result shape", text: undefined };
    return { sentAtMs, completedAtMs, text };
  } catch (error) {
    return { sentAtMs, completedAtMs: epochMs(), error: (error instanceof Error ? error.message : "unreadable failure").slice(0, 200), text: undefined };
  }
};
/** The structured `cotal_connection_status` document must say ready on a live transport. */
const connectionReady = (text: string | undefined): { ready: boolean; state: string } => {
  try {
    const doc = JSON.parse(text ?? "") as Record<string, unknown>;
    return { ready: doc.state === "ready" && doc.connected === true && doc.transportConnected === true && doc.stopping === false, state: String(doc.state) };
  } catch { return { ready: false, state: "unparseable" }; }
};

// A minimal stdio MCP peer for the lifecycle controls: answers initialize and tools/list, then behaves as its mode says.
type FixtureMode = "idle" | "stubborn" | "exit-after-init" | "exit-at-start";
const runMcpFixture = (mode: FixtureMode): void => {
  if (mode === "exit-at-start") process.exit(3);
  if (mode === "stubborn") { process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); setInterval(() => {}, 1000); }
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: { protocolVersion?: string } };
      if (msg.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "0" } } }) + "\n");
      else if (msg.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: ["cotal_docs", "cotal_connection_status"].map((name) => ({ name, inputSchema: { type: "object" } })) } }) + "\n",
        () => { if (mode === "exit-after-init") process.exit(0); });
    }
  });
  if (mode !== "stubborn") process.stdin.on("end", () => process.exit(0));
  else process.stdin.on("end", () => {});
};

// ---------------------------------------------------------------------------------------------
// manager child: the real Manager, spawning through startAgent
// ---------------------------------------------------------------------------------------------

async function runManager(job: ManagerJob): Promise<void> {
  const { Manager } = (job.dist ? await import("@cotal-ai/manager") : await import("../src/manager.js")) as typeof import("../src/manager.js");
  const stub: Connector = {
    kind: "connector", name: CONNECTOR, requires: ["sh"],
    // The fields a stock connector forwards from LaunchOpts (extensions/connector-claude-code), as
    // COTAL_* env. The manager adds COTAL_MANAGER_INSTANCE itself after buildLaunch.
    buildLaunch: (o: LaunchOpts): LaunchSpec => ({
      command: "sh", args: ["-c", job.realSeat ? realSeatScript(job.stubToken, job.realSeat) : stubScript(job.stubToken)],
      env: {
        PATH: process.env.PATH ?? "", SEAT_HOST_DIR: job.seatDir, HOME: process.env.HOME ?? "",
        COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers), COTAL_NAME: o.name,
        ...(o.id ? { COTAL_ID: o.id } : {}), ...(o.role ? { COTAL_ROLE: o.role } : {}),
        ...(o.creds ? { COTAL_CREDS: o.creds } : {}), ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
        ...(o.acceptedToken ? { COTAL_ACCEPTED_TOKEN: o.acceptedToken } : {}),
        ...(o.subscribe ? { COTAL_SUBSCRIBE: o.subscribe.join(",") } : {}),
        ...(o.allowSubscribe ? { COTAL_ALLOW_SUBSCRIBE: o.allowSubscribe.join(",") } : {}),
        ...(o.allowPublish ? { COTAL_ALLOW_PUBLISH: o.allowPublish.join(",") } : {}),
      },
    }),
  };
  registry.register(stub);
  const handles = new Map<string, InitializedMcpHandle>();
  let unhandled = 0;
  let armedWorkload: DocsWorkload | undefined;
  if (job.initializedMcp) {
    process.on("unhandledRejection", () => { unhandled++; });
    const runtime = initializedMcpRuntime(await loadMcpSdk(), handles);
    const provider: RuntimeProvider = { kind: "runtime", name: runtime.kind, available: () => true, create: () => runtime };
    registry.register(provider);
  }
  const mgr = new Manager({ space: job.space, servers: job.servers, runtime: job.initializedMcp ? "initialized-mcp" : "pty", workspaceRoot: job.workspaceRoot, ...(job.storeRoot ? { secretStore: workspaceSecretStore(job.storeRoot) } : {}) });
  await mgr.start();
  const observation = job.observeSeats ? mgr.localServiceObservation() : undefined;
  if (job.observeSeats && !observation) throw new Error("manager-seat-load: manager service observation is unavailable");
  await ipcSend({ ready: true, ...(observation ? { instanceId: observation.registration.instanceId, epoch: observation.registration.epoch, ...(job.storeRoot ? { principal: observation.registration.principal } : {}) } : {}) });
  for (;;) {
    const cmd = await nextCmd<{ cmd: "spawn"; from: number; to: number } | { cmd: "sample" } | { cmd: "snapshot"; path: string } | { cmd: "stop" }
      | { cmd: "mcp-ready" } | { cmd: "mcp-arm"; workload: DocsWorkload } | { cmd: "mcp-go" }>();
    if (cmd.cmd === "mcp-ready") {
      // Every client must have finished initialize and listTools before any measurement or workload.
      const settled = await Promise.allSettled([...handles.values()].map((h) => h.initialized));
      const inits = settled.flatMap((r) => r.status === "fulfilled" ? [r.value] : []);
      await ipcSend({ mcpReady: { handles: handles.size, initialized: inits.length, failures: settled.flatMap((r) => r.status === "rejected" ? [String((r.reason as Error)?.message ?? "").slice(0, 200)] : []).slice(0, 5),
        inits, unhandled, requestTimeoutMs: (await loadMcpSdk()).requestTimeoutMs } });
      continue;
    }
    if (cmd.cmd === "mcp-arm") {
      armedWorkload = cmd.workload;
      const states = await Promise.all([...handles.values()].map(async (h) => connectionReady((await callText(h, "cotal_connection_status", {})).text)));
      await ipcSend({ mcpArmed: { count: states.length, ready: states.filter((x) => x.ready).length, states: [...new Set(states.map((x) => x.state))] } });
      continue;
    }
    if (cmd.cmd === "mcp-go") {
      if (!armedWorkload) throw new Error("manager-seat-load: mcp-go before mcp-arm");
      const recvAtMs = epochMs();
      const calls = await Promise.all([...handles.values()].map(async (h) => {
        const r = await callText(h, "cotal_docs", DOCS_CALLS[armedWorkload!]);
        return { sentAtMs: r.sentAtMs, completedAtMs: r.completedAtMs, ...(r.error ? { error: r.error } : { sha256: sha256Text(r.text!), bytes: Buffer.byteLength(r.text!) }) };
      }));
      const after = await Promise.all([...handles.values()].map(async (h) => connectionReady((await callText(h, "cotal_connection_status", {})).text)));
      await ipcSend({ mcpDocs: { workload: armedWorkload, recvAtMs, calls, after: { count: after.length, ready: after.filter((x) => x.ready).length, states: [...new Set(after.map((x) => x.state))] }, unhandled } });
      continue;
    }
    if (cmd.cmd === "snapshot") {
      (globalThis as { gc?: () => void }).gc?.();
      await ipcSend({ snapshot: writeHeapSnapshot(cmd.path) });
      continue;
    }
    if (cmd.cmd === "stop") {
      if (job.strictStop) await mgr.stop({ withAgents: true });
      else await Promise.race([mgr.stop({ withAgents: true }).catch(() => {}), wait(30_000)]);
      await ipcSend({ stopped: true });
      return;
    }
    if (cmd.cmd === "sample") {
      const u = process.cpuUsage();
      await ipcSend({ sample: { cpuMs: (u.user + u.system) / 1000, rssMb: process.memoryUsage().rss / MB, mem: nodeMem() } });
      continue;
    }
    let ok = 0;
    const refusals: string[] = [];
    const refusalFacts: Array<{ code: string | null; detailKinds: string[] }> = [];
    const spawnMs: number[] = [];
    const receipts: SeatReceipt[] = [];
    const cpu0 = process.cpuUsage();
    for (let i = cmd.from; i < cmd.to; i++) {
      const t0 = performance.now();
      const r = await mgr.startAgent({ name: `seat${i}`, agent: CONNECTOR, cwd: job.workspaceRoot, events: false });
      spawnMs.push(performance.now() - t0);
      if (r.ok) {
        ok++;
        if (job.observeSeats) {
          const data = r.data as { name?: unknown; id?: unknown; lifecycleUid?: unknown };
          if (typeof data?.name !== "string" || typeof data.id !== "string" || typeof data.lifecycleUid !== "string")
            throw new Error("manager-seat-load: successful spawn omitted its identity receipt");
          receipts.push({ name: data.name, id: data.id, lifecycleUid: data.lifecycleUid });
        }
      }
      else if (refusals.length < 5) {
        refusals.push(String(r.error).slice(0, 200));
        refusalFacts.push({ code: r.code ?? null, detailKinds: r.details?.map((detail) => detail.kind) ?? [] });
      }
    }
    const cpu = process.cpuUsage(cpu0);
    await ipcSend({ spawned: { ok, failed: cmd.to - cmd.from - ok, refusals, ...(job.storeRoot ? { refusalFacts } : {}), spawnMs, cpuMs: (cpu.user + cpu.system) / 1000, receipts } });
  }
}

// ---------------------------------------------------------------------------------------------
// seat host child: every stub seat's session, built as a connector builds one
// ---------------------------------------------------------------------------------------------

async function runSeats(job: SeatsJob): Promise<void> {
  const seats = new Map<string, MeshAgent>();
  let failed = 0;
  const firstErrors: string[] = [];
  let stopping = false;
  const scan = async () => {
    for (const f of readdirSync(job.seatDir)) {
      if (!f.endsWith(".seat")) continue;
      const path = join(job.seatDir, f);
      const env: NodeJS.ProcessEnv = {};
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
      }
      renameSync(path, `${path}.taken`);
      try {
        const agent = new MeshAgent(configFromEnv(env), env, { withholdProcessCwd: true });
        agent.on("error", () => {});
        seats.set(f, agent);
        void agent.start().catch((e: Error) => { failed++; if (firstErrors.length < 5) firstErrors.push(e.message.slice(0, 200)); });
      } catch (e) {
        failed++;
        if (firstErrors.length < 5) firstErrors.push((e as Error).message.slice(0, 200));
      }
    }
  };
  const poll = setInterval(() => { if (!stopping) void scan(); }, 100);
  await ipcSend({ ready: true });
  for (;;) {
    const cmd = await nextCmd<{ cmd: "sample" } | { cmd: "stop" }>();
    if (cmd.cmd === "stop") break;
    const u = process.cpuUsage();
    await ipcSend({ sample: { seats: seats.size, connected: [...seats.values()].filter((a) => a.connected).length, failed, firstErrors, cpuMs: (u.user + u.system) / 1000, rssMb: process.memoryUsage().rss / 1048576 } });
  }
  stopping = true;
  clearInterval(poll);
  await Promise.all([...seats.values()].map((a) => Promise.race([a.stop().catch(() => {}), wait(5000)])));
  await ipcSend({ stopped: true });
}

if (process.argv[2] === "mcp-fixture") {
  runMcpFixture(process.argv[3] as FixtureMode);
  await new Promise<never>(() => {}); // the fixture ends through process.exit or a signal
}
if (process.argv[2] === "mcp-holder") {
  // A stand-in for a Manager that dies: it owns one SDK-launched fixture child and reports its identity.
  const handles = new Map<string, InitializedMcpHandle>();
  const handle = initializedMcpRuntime(await loadMcpSdk(), handles).spawn("held", { command: process.execPath, args: [...process.execArgv, import.meta.filename, "mcp-fixture", "idle"], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } }, process.cwd());
  const init = await (handle as InitializedMcpHandle).initialized;
  await ipcSend({ held: { pid: init.pid, startTick: init.startTick } });
  await new Promise<never>(() => {});
}
if (process.argv[2] === "child") {
  const job = await nextCmd<Job>();
  if (job.kind === "manager") await runManager(job);
  else await runSeats(job);
  process.exit(0);
}

async function observeManagerMemory(
  memoryObserver: CotalEndpoint | undefined, instanceId: unknown, epoch: unknown,
  receipts: Map<string, SeatReceipt>, managerPid: number, observationErrors: () => number,
  processMemory: (pid: number) => { pid: number; rssMiB: number; pssMiB: number; ussMiB: number },
  verify: (condition: boolean, detail: string) => void,
) {
  if (!memoryObserver || typeof instanceId !== "string") throw new Error("manager-seat-load: memory observer not started");
  const reply = await memoryObserver.invokeService("manager", "ps", undefined, { instanceId, deadlineMs: 10_000 });
  verify(reply.responder.endpoint === "manager" && reply.responder.instanceId === instanceId
    && reply.responder.epoch === epoch && reply.reply.ok === true, "ps did not answer from this manager incarnation");
  const rows = reply.reply.data;
  verify(Array.isArray(rows) && rows.length === receipts.size, "ps row count differs from successful spawn receipts");
  const records = rows as Array<Record<string, unknown>>;
  const seats = [...receipts.values()].map((receipt) => {
    const matches = records.filter((r) => r.name === receipt.name && r.id === receipt.id && r.lifecycleUid === receipt.lifecycleUid);
    verify(matches.length === 1, "ps did not return one matching spawn identity");
    const row = matches[0]!;
    verify(row.meshView === "current" && row.presenceIdentityVerified === true
      && row.mesh === "idle" && row.instanceId === instanceId
      && typeof row.presenceObservedAt === "number" && Number.isSafeInteger(row.presenceObservedAt) && row.presenceObservedAt >= 0
      && row.status === "running", "seat does not have current verified mesh presence and a running process");
    verify(typeof row.pid === "number" && Number.isSafeInteger(row.pid) && row.pid > 0, "seat process PID unavailable");
    return processMemory(row.pid as number);
  });
  verify(new Set(seats.map((s) => s.pid)).size === seats.length, "seat PIDs are not distinct");
  verify(observationErrors() === 0, "memory observer reported endpoint errors or warnings");
  return { observedAt: new Date().toISOString(), expected: receipts.size, joined: seats.length,
    manager: processMemory(managerPid), seats };
}


// ---------------------------------------------------------------------------------------------
// orchestrator
// ---------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string, dflt?: string): string => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) return argv[i + 1];
  if (dflt === undefined) throw new Error(`manager-seat-load: --${name} is required`);
  return dflt;
};
const requestedSteps = flag("steps", "10,25,50").split(",").map(Number);
const STEPS = requestedSteps.filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
const SECONDS = Number(flag("seconds", "60"));
const SETTLE_S = Number(flag("settle", "20"));
const RAM = argv.includes("--ram");
const PROCESS_MEMORY = argv.includes("--process-memory");
const SHAPE = flag("shape", "src");
/** Extra node flags for the manager child under `--shape dist`, comma-separated and without their
 *  dashes (a flag's value may not start with "--"), e.g. the seat's own
 *  "optimize-for-size,max-semi-space-size=1", to measure what they save. */
const MANAGER_NODE_FLAGS = flag("manager-node-flags", "").split(",").map((f) => f.trim().replace(/^-*/, "")).filter(Boolean).map((f) => `--${f}`);
const REAL_SEATS = flag("seat", "stub") === "real";
const realEntryIndex = argv.indexOf("--real-entry");
if (realEntryIndex !== -1 && (!argv[realEntryIndex + 1] || argv[realEntryIndex + 1]!.startsWith("--")))
  throw new Error("manager-seat-load: real-entry needs an explicit value");
const REAL_ENTRY = flag("real-entry", "stock");
if (REAL_ENTRY !== "stock" && REAL_ENTRY !== "direct") throw new Error("manager-seat-load: real-entry is stock or direct");
if (!REAL_SEATS && argv.includes("--real-entry")) throw new Error("manager-seat-load: real-entry requires --seat real");
if (REAL_SEATS && (cleanEnv.NODE_COMPILE_CACHE || cleanEnv.NODE_DISABLE_COMPILE_CACHE))
  throw new Error("manager-seat-load: unset NODE_COMPILE_CACHE and NODE_DISABLE_COMPILE_CACHE; this fixture owns its cache");
if (SHAPE !== "src" && SHAPE !== "dist") throw new Error("manager-seat-load: --shape is src or dist");
if (PROCESS_MEMORY) {
  if (RAM || !REAL_SEATS || process.platform !== "linux")
    throw new Error("manager-seat-load: --process-memory requires Linux, --seat real and no --ram");
  if (requestedSteps.length !== STEPS.length || !STEPS.length || new Set(STEPS).size !== STEPS.length
    || !STEPS.every(Number.isSafeInteger) || !Number.isFinite(SECONDS) || SECONDS <= 0
    || !Number.isFinite(SETTLE_S) || SETTLE_S < 0)
    throw new Error("manager-seat-load: process-memory steps must be distinct positive safe integers, seconds positive and settle nonnegative");
}
if (argv.some((arg) => arg.startsWith("--spaces=")))
  throw new Error("manager-seat-load: use --spaces followed by one positive integer");
const spacesIndex = argv.indexOf("--spaces");
if (spacesIndex !== -1 && (!argv[spacesIndex + 1] || argv[spacesIndex + 1]!.startsWith("--") || argv.lastIndexOf("--spaces") !== spacesIndex))
  throw new Error("manager-seat-load: --spaces needs one explicit positive integer");
const SPACES = Number(flag("spaces", "1"));
if (!Number.isSafeInteger(SPACES) || SPACES < 1 || !/^[1-9][0-9]*$/.test(flag("spaces", "1")))
  throw new Error("manager-seat-load: --spaces needs one explicit positive integer");
if (SPACES > 1 && (!PROCESS_MEMORY || !REAL_SEATS || REAL_ENTRY !== "stock" || SHAPE !== "dist" || RAM))
  throw new Error("manager-seat-load: shared spaces require dist, real, stock and process-memory without ram");
if (!Number.isSafeInteger(SPACES * STEPS[STEPS.length - 1]!))
  throw new Error("manager-seat-load: total requested seats exceeds a safe integer");
const INITIALIZED_MCP = argv.includes("--initialized-mcp");
const MCP_LIFECYCLE = argv.includes("--initialized-mcp-lifecycle");
const MANAGER_DEATH = argv.includes("--manager-death-control");
const DOCS_WORKLOAD = (argv.includes("--docs-workload") ? flag("docs-workload") : undefined) as DocsWorkload | undefined;
const DOCS_ORACLE = argv.includes("--docs-oracle") ? flag("docs-oracle") : undefined;
if (MCP_LIFECYCLE && argv.length !== 1) throw new Error("manager-seat-load: --initialized-mcp-lifecycle takes no other option");
if (INITIALIZED_MCP && SPACES < 2) throw new Error("manager-seat-load: --initialized-mcp requires --spaces N with N above 1");
if (MANAGER_DEATH && !INITIALIZED_MCP) throw new Error("manager-seat-load: --manager-death-control requires --initialized-mcp");
if ((DOCS_WORKLOAD !== undefined || DOCS_ORACLE !== undefined) && (!INITIALIZED_MCP || DOCS_WORKLOAD === undefined || DOCS_ORACLE === undefined))
  throw new Error("manager-seat-load: --docs-workload and --docs-oracle go together and require --initialized-mcp");
if (DOCS_WORKLOAD !== undefined && !(DOCS_WORKLOAD in DOCS_CALLS)) throw new Error("manager-seat-load: --docs-workload is index, page or search");
const REPO = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", cwd: import.meta.dirname }).trim();
const SHA = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: REPO }).trim();
const SOURCE_DIRTY = PROCESS_MEMORY && execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", cwd: REPO }).trim() !== "";

const CLK_TCK = 100; // Linux x86_64; this harness is Linux-only, like the rest of the load path.
const procCpuMs = (pid: number): number => {
  const s = readFileSync(`/proc/${pid}/stat`, "utf8");
  const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
  return ((Number(f[11]) + Number(f[12])) / CLK_TCK) * 1000;
};
const procRssMb = (pid: number): number => {
  const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
  return m ? Number(m[1]) / 1024 : NaN;
};
/** The manager's own pty children: every live process whose parent is the manager. */
const childCount = (pid: number): number => {
  try { return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).length; }
  catch { return NaN; }
};


/** Lifecycle controls for the initialized-MCP handle, with no broker: each case owns its child and proves it gone. */
async function runLifecycleControls(): Promise<void> {
  const sdk = await loadMcpSdk();
  const handles = new Map<string, InitializedMcpHandle>();
  const runtime = initializedMcpRuntime(sdk, handles);
  let unhandled = 0;
  process.on("unhandledRejection", () => { unhandled++; });
  let checks = 0;
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (ok) checks++; else failures.push(label); };
  const pinned: Array<{ pid: number; tick: string }> = [];
  const fixtureSpec = (mode: FixtureMode): LaunchSpec => ({ command: process.execPath, args: [...process.execArgv, import.meta.filename, "mcp-fixture", mode], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
  const open = (name: string, spec: LaunchSpec) => {
    const handle = runtime.spawn(name, spec, process.cwd()) as InitializedMcpHandle;
    check(`${name}: spawn returned a handle synchronously`, handle.status() === "running" && handle.kind === "initialized-mcp");
    return handle;
  };
  const settleInit = async (handle: InitializedMcpHandle) => { try { return await handle.initialized; } catch { return undefined; } };
  const record = (label: string, extra: Record<string, unknown>) => console.log(`IMC_CONTROL ${JSON.stringify({ label, ...extra })}`);
  const gone = async (name: string, handle: InitializedMcpHandle, init: McpInit | undefined) => {
    const started = performance.now();
    await handle.waitForExit();
    check(`${name}: waitForExit resolved with exited status`, handle.status() === "exited" && handle.closeEvents + (handle.neverStarted ? 1 : 0) >= 1);
    check(`${name}: no invented exit code`, (handle as AgentHandle).exitInfo === undefined);
    if (init) { pinned.push({ pid: init.pid, tick: init.startTick }); check(`${name}: PID absent after close`, startTickOf(init.pid) !== init.startTick && handle.osAbsenceVerified); }
    return performance.now() - started;
  };

  // surface contract
  check("streamsTerminal is false", runtime.streamsTerminal === false);
  check("no reserve, adopt, spawnDelegated", runtime.reserve === undefined && runtime.adopt === undefined && runtime.spawnDelegated === undefined);
  let refused = 0;
  for (const spec of [{ confirm: "x" }, { confirmBefore: [] }, { confirmReady: [] }, { confirmBlockers: [] }, { artifacts: ["a"] }, { sessionStatePath: "/x" }] as Array<Partial<LaunchSpec>>) {
    try { runtime.spawn("unsupported", { command: "true", args: [], ...spec }, process.cwd()); } catch { refused++; }
  }
  check("every unsupported launch feature is refused before spawn", refused === 6 && handles.size === 0);

  // malformed launch: no process ever exists
  { const h = open("malformed", { command: "/nonexistent/initialized-mcp-control", args: [], env: { PATH: process.env.PATH ?? "" } });
    check("malformed: initialization rejects", await settleInit(h) === undefined && h.initializeError !== undefined);
    const ms = await gone("malformed", h, undefined);
    check("malformed: no PID and the process never started", h.pid === undefined && h.neverStarted);
    check("malformed: stop and interrupt are no-ops after exit", (() => { h.stop({ graceful: false }); h.interrupt(); return true; })());
    check("malformed: attach refuses", (() => { try { h.attach(); return false; } catch { return true; } })());
    record("malformed-launch", { initializeError: h.initializeError, exitedAfterMs: Math.round(ms) }); }

  // child that exits before answering initialize
  { const h = open("init-failure", fixtureSpec("exit-at-start"));
    const init = await settleInit(h);
    check("init-failure: initialization rejects", init === undefined && h.initializeError !== undefined);
    const pid = h.pid;
    const ms = await gone("init-failure", h, pid === undefined ? undefined : { pid, startTick: "unknown", tools: 0, initializeMs: 0, listToolsMs: 0 });
    record("init-failure", { initializeError: h.initializeError, pidLatched: pid !== undefined, closeEvents: h.closeEvents, exitedAfterMs: Math.round(ms) }); }

  // natural exit after a successful initialize
  { const h = open("natural-exit", fixtureSpec("exit-after-init"));
    const init = await settleInit(h);
    check("natural-exit: initialized", init !== undefined && init.tools === 2);
    const ms = await gone("natural-exit", h, init);
    record("natural-exit", { closeEvents: h.closeEvents, signalsSent: h.signalsSent, exitedAfterMs: Math.round(ms) }); }

  // graceful stop: the SDK closes stdin and the child ends on EOF
  { const h = open("graceful-eof", fixtureSpec("idle"));
    const init = await settleInit(h);
    check("graceful-eof: initialized", init !== undefined);
    h.stop();
    const ms = await gone("graceful-eof", h, init);
    check("graceful-eof: no signal was sent by the handle", h.signalsSent.length === 0);
    record("graceful-eof", { exitedAfterMs: Math.round(ms), signalsSent: h.signalsSent }); }

  // graceful stop of a child that ignores EOF and SIGTERM: the SDK escalates, the close event is the proof
  { const h = open("graceful-escalation", fixtureSpec("stubborn"));
    const init = await settleInit(h);
    check("graceful-escalation: initialized", init !== undefined);
    h.stop();
    const ms = await gone("graceful-escalation", h, init);
    record("graceful-escalation", { exitedAfterMs: Math.round(ms), note: "SDK closes stdin, waits, sends SIGTERM, waits, then SIGKILL" }); }

  // hard stop: immediate SIGKILL of the pinned PID
  { const h = open("hard-stop", fixtureSpec("stubborn"));
    const init = await settleInit(h);
    check("hard-stop: initialized", init !== undefined);
    h.stop({ graceful: false });
    const ms = await gone("hard-stop", h, init);
    check("hard-stop: the handle sent SIGKILL", h.signalsSent.join() === "SIGKILL");
    check("hard-stop: a repeated stop after exit sends nothing", (() => { h.stop({ graceful: false }); return h.signalsSent.length === 1; })());
    record("hard-stop", { exitedAfterMs: Math.round(ms), signalsSent: h.signalsSent }); }

  // interrupt: SIGINT to the pinned PID, then the genuine close
  { const h = open("interrupt", fixtureSpec("idle"));
    const init = await settleInit(h);
    check("interrupt: initialized", init !== undefined);
    h.interrupt();
    const ms = await gone("interrupt", h, init);
    check("interrupt: the handle sent SIGINT", h.signalsSent.join() === "SIGINT");
    record("interrupt", { exitedAfterMs: Math.round(ms), signalsSent: h.signalsSent }); }

  // identity guard: a handle never signals a PID whose start time changed
  { const h = open("pid-guard", fixtureSpec("idle"));
    const init = await settleInit(h);
    check("pid-guard: initialized", init !== undefined);
    (h as unknown as { latched: { pid: number; tick: string } }).latched.tick = "0";
    let threw = false;
    try { h.interrupt(); } catch { threw = true; }
    check("pid-guard: interrupt refuses when the start time differs, and sends nothing", threw && h.signalsSent.length === 0);
    (h as unknown as { latched: { pid: number; tick: string } }).latched.tick = init!.startTick;
    h.stop();
    await gone("pid-guard", h, init); }

  // Manager death: the owner of an SDK-launched child is killed without cleanup
  { const holder = spawn(process.execPath, [...process.execArgv, import.meta.filename, "mcp-holder"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const held = await new Promise<{ pid: number; startTick: string }>((resolve, reject) => {
      holder.once("message", (m) => resolve((m as { held: { pid: number; startTick: string } }).held));
      holder.once("exit", () => reject(new Error("holder exited before reporting")));
    });
    pinned.push({ pid: held.pid, tick: held.startTick }); pinned.push({ pid: holder.pid!, tick: startTickOf(holder.pid!) ?? "gone" });
    holder.kill("SIGKILL");
    await new Promise<void>((resolve) => holder.once("exit", () => resolve()));
    let exitedByEof = false;
    for (let i = 0; i < 200 && !exitedByEof; i++) { exitedByEof = startTickOf(held.pid) !== held.startTick; if (!exitedByEof) await wait(50); }
    if (!exitedByEof && startTickOf(held.pid) === held.startTick) process.kill(held.pid, "SIGKILL");
    check("manager-death: the owner was killed without cleanup", holder.signalCode === "SIGKILL");
    record("manager-death", { childExitedWhenOwnerDied: exitedByEof, note: exitedByEof ? "the child ended on stdin EOF" : "the child survived the owner and was killed by the controller" });
    for (let i = 0; i < 100 && startTickOf(held.pid) === held.startTick; i++) await wait(50);
    check("manager-death: no residual child", startTickOf(held.pid) !== held.startTick); }

  check("no unhandled promise rejection", unhandled === 0);
  check("no residual pinned process", pinned.every((p) => startTickOf(p.pid) !== p.tick));
  console.log(`IMC_CONTROLS_DONE ${JSON.stringify({ checks, failures, unhandled, pinnedProcesses: pinned.length, handles: handles.size })}`);
  if (failures.length) process.exitCode = 1;
}

if (MCP_LIFECYCLE) {
  await runLifecycleControls();
  process.exit(process.exitCode ?? 0);
}

if (SPACES > 1) {
  if (Buffer.byteLength(join(tmpdir(), "sXXXXXX", `${"U".repeat(56)}.sock`)) >= 108)
    throw new Error("manager-seat-load: shared spaces need a shorter private TMPDIR for control sockets");
  await runSharedSpaces();
  process.exit(process.exitCode ?? 0);
}

const tag = randomUUID().slice(0, 8);
const stubToken = String(Date.now() % 1_000_000).padStart(6, "0");
const space = `mgrload-${tag}`;
const dir = mkdtempSync(join(tmpdir(), "mgr-seat-load-"));
const workspaceRoot = join(dir, "ws");
const seatDir = join(dir, "seats");
const home = join(dir, "home");
const seatRoot = mkdtempSync(join(tmpdir(), "s"));
for (const d of [join(workspaceRoot, ".cotal", "agents"), seatDir, home]) mkdirSync(d, { recursive: true });
const maxSeats = STEPS[STEPS.length - 1];
for (let i = 0; i < maxSeats; i++)
  writeFileSync(join(workspaceRoot, ".cotal", "agents", `seat${i}.md`), `---\nname: seat${i}\nrole: ${ROLE}\nsubscribe: [${CHANNEL}]\nallowSubscribe: [${CHANNEL}]\nallowPublish: [${CHANNEL}]\n---\n`);

const { bootBroker } = await import("./_boot-broker.js");
const { bootDeliveryDaemon } = await import("./_boot-delivery.js");
const { procMem, heapSnapshotTop } = await import("@cotal-ai/smoke-kit");
/** The stock wrapper is beside the exported MCP bundle in the installed package. */
const realSeat = REAL_SEATS ? fileURLToPath(new URL(REAL_ENTRY === "stock" ? "seat.cjs" : "mcp.cjs", import.meta.resolve("@cotal-ai/connector-claude-code/mcp"))) : undefined;
const auth = await createSpaceAuth(space);
saveSpaceAuth(authDir(workspaceRoot), auth); // the FS composition the manager's start() reads
const broker = await bootBroker(auth, { monitor: true });
const brokerPid = broker.pid;

const children: ChildProcess[] = [];
let stopping = false;
let abort!: (e: Error) => void;
const aborted = new Promise<never>((_, reject) => { abort = reject; });
aborted.catch(() => {});
const guard = <T>(p: Promise<T>): Promise<T> => Promise.race([p, aborted]);
const startChild = (job: Job, env: NodeJS.ProcessEnv): ChildProcess => {
  // `--shape dist`: the manager child runs under plain node, without the tsx loader this process has.
  const plain = job.kind === "manager" && job.dist;
  const child = spawn(process.execPath, [...(plain ? ["--disable-warning=ExperimentalWarning", ...MANAGER_NODE_FLAGS] : process.execArgv), import.meta.filename, "child"], { stdio: ["ignore", "inherit", "inherit", "ipc"], env });
  children.push(child);
  child.on("exit", (code, signal) => { if (!stopping) abort(new Error(`${job.kind} child ${child.pid} exited (${code ?? signal}) mid-run`)); });
  child.send(job);
  return child;
};
type Cmd = { cmd: "spawn"; from: number; to: number } | { cmd: "sample" } | { cmd: "snapshot"; path: string } | { cmd: "stop" }
  | { cmd: "mcp-ready" } | { cmd: "mcp-arm"; workload: DocsWorkload } | { cmd: "mcp-go" };
const ask = (child: ChildProcess, cmd: Cmd | undefined, key: string): Promise<Record<string, unknown>> => guard(new Promise((resolve) => {
  const on = (m: Record<string, unknown>) => { if (key in m) { child.off("message", on); resolve(m); } };
  child.on("message", on);
  if (cmd) child.send(cmd);
}));

const table: string[][] = [];
const ramTable: string[][] = [];
const snapshots: string[] = [];
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let memoryObserver: CotalEndpoint | undefined;
let observationErrors = 0, measurementChecks = 0;
const receipts = new Map<string, SeatReceipt>();
const verify = (condition: boolean, detail: string): void => {
  if (!condition) throw new Error(`manager-seat-load: ${detail}`);
  measurementChecks++;
};
try {
  await setupSpaceStreams({ servers: broker.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space, servers: broker.servers, auth, reloadStoreIdentity: workspaceSecretStore(workspaceRoot).identity });

  const childEnv = { ...cleanEnv, HOME: home, DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off", COTAL_HOME: home, COTAL_SEAT_ROOT: seatRoot };
  const seatHost = REAL_SEATS ? undefined : startChild({ kind: "seats", seatDir }, childEnv);
  if (seatHost) await ask(seatHost, undefined, "ready");
  const manager = startChild({ kind: "manager", space, servers: broker.servers, workspaceRoot, seatDir, stubToken, dist: SHAPE === "dist", ...(realSeat ? { realSeat } : {}), observeSeats: PROCESS_MEMORY }, childEnv);
  const managerReady = await ask(manager, undefined, "ready");
  const instanceId = managerReady.instanceId, epoch = managerReady.epoch;
  if (PROCESS_MEMORY) {
    verify(typeof instanceId === "string" && instanceId.length > 0, "manager instance identity missing");
    verify(typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0, "manager epoch missing");
    const expiresInSeconds = Math.ceil((SECONDS + SETTLE_S) * (STEPS.length + 1) + maxSeats * 30 + 120);
    verify(Number.isSafeInteger(expiresInSeconds), "observation lifetime exceeds a safe integer");
    const identity = newIdentity(), lifecycleUid = mintLifecycleUid();
    // This private fixture caller gets only describe/ps beyond the agent baseline, pinned to
    // the manager that just started. No spawn/admin grant, private manager access or raw rail.
    memoryObserver = new CotalEndpoint({
      space, servers: broker.servers, lifecycleUid,
      creds: await mintCreds(auth, identity, "agent", { lifecycleUid, expiresInSeconds, allowSubscribe: [], allowPublish: [], capabilities: [], endpointCapabilities:
        instanceOnlyManagerCapabilities(["describe", "ps"].map((command) => ({ endpoint: "manager", command })), instanceId as string) }),
      card: { id: identity.id, name: "memory-observer", role: "observer", kind: "endpoint" },
      channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
    });
    memoryObserver.on("error", () => { observationErrors++; });
    memoryObserver.on("warning", () => { observationErrors++; });
    await memoryObserver.start();
  }
  const processMemory = (pid: number) => {
    const mem = procMem(pid);
    verify(Object.values(mem).every((n) => Number.isFinite(n) && n >= 0) && mem.rssMb > 0, "process memory sample missing or invalid");
    return { pid, rssMiB: mem.rssMb, pssMiB: mem.pssMb, ussMiB: mem.ussMb };
  };
  const observe = async () => ({
    ...await observeManagerMemory(memoryObserver, instanceId, epoch, receipts, manager.pid!, () => observationErrors, processMemory, verify),
    broker: processMemory(brokerPid),
  });

  const measure = async (seatsNow: number, spawn?: { ok: number; failed: number; refusals: string[]; spawnMs: number[]; cpuMs: number; receipts: SeatReceipt[] }) => {
    if (PROCESS_MEMORY && spawn) {
      verify(spawn.failed === 0 && spawn.receipts.length === spawn.ok, "not every requested connector started with an identity receipt");
      for (const receipt of spawn.receipts) {
        verify(!receipts.has(receipt.name), "duplicate spawn receipt");
        receipts.set(receipt.name, receipt);
      }
      verify(receipts.size === seatsNow, "successful connector count differs from requested cohort");
    }
    await wait(SETTLE_S * 1000);
    const before = PROCESS_MEMORY ? await observe() : undefined;
    const m0 = procCpuMs(manager.pid!), h0 = seatHost ? procCpuMs(seatHost.pid!) : undefined, b0 = brokerPid ? procCpuMs(brokerPid) : NaN;
    const t0 = performance.now();
    if (before) console.log(`MSL_WINDOW ${JSON.stringify({ seats: seatsNow, managerPid: manager.pid, seatPids: before.seats.map((s) => s.pid) })}`);
    await wait(SECONDS * 1000);
    const s = (performance.now() - t0) / 1000;
    const m1 = procCpuMs(manager.pid!), h1 = seatHost ? procCpuMs(seatHost.pid!) : undefined, b1 = procCpuMs(brokerPid);
    const mgrCores = (m1 - m0) / 1000 / s;
    const after = PROCESS_MEMORY ? await observe() : undefined;
    if (before && after) {
      verify(before.seats.every((seat, i) => seat.pid === after.seats[i]?.pid), "a connector process changed during the idle window");
      console.log(`MSL_RESULT ${JSON.stringify({ source: SHA, sourceDirty: SOURCE_DIRTY, requested: seatsNow, windowSeconds: s, shape: SHAPE,
        seatMode: "real", seatEntry: REAL_ENTRY, stubHostStarted: Boolean(seatHost), heapSnapshots: false, observationErrors, checks: measurementChecks,
        brokerCpuCores: (b1 - b0) / 1000 / s, managerCpuCores: mgrCores, before, after })}`);
    }
    const host = seatHost ? (await ask(seatHost, { cmd: "sample" }, "sample")).sample as { seats: number; connected: number; failed: number; firstErrors: string[]; rssMb: number } : undefined;
    if (seatHost && !host) throw new Error("manager-seat-load: stub host omitted its sample");
    const spawnMs = spawn?.spawnMs.slice().sort((a, b) => a - b) ?? [];
    table.push([
      String(seatsNow),
      `${host ? host.connected : "n/a"} / ${childCount(manager.pid!)}`,
      (mgrCores * 1000).toFixed(2),
      procRssMb(manager.pid!).toFixed(1),
      spawn ? `${spawn.ok} / ${spawn.failed}` : "",
      spawn && spawn.ok ? (spawn.cpuMs / spawn.ok).toFixed(0) : "",
      spawnMs.length ? `${spawnMs[Math.floor(spawnMs.length / 2)].toFixed(0)} / ${spawnMs[spawnMs.length - 1].toFixed(0)}` : "",
      h0 !== undefined && h1 !== undefined ? (((h1 - h0) / 1000 / s) * 1000).toFixed(2) : "n/a",
      host ? host.rssMb.toFixed(0) : "n/a",
      brokerPid ? (((b1 - b0) / 1000 / s) * 1000).toFixed(2) : "n/a",
    ]);
    if (RAM) {
      const mgr = procMem(manager.pid!);
      const mem = ((await ask(manager, { cmd: "sample" }, "sample")).sample as { mem: { heapUsedMb: number; heapTotalMb: number; externalMb: number; codeMb: number } }).mem;
      // The manager's own children are the seats' pty processes; under `--seat real` each is a seat.
      let kids: number[] = [];
      try { kids = readFileSync(`/proc/${manager.pid}/task/${manager.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number); } catch { /* none */ }
      const seatMem = kids.map((pid) => { try { return procMem(pid); } catch { return undefined; } }).filter((m) => m !== undefined);
      const sum = (k: "rssMb" | "pssMb" | "ussMb") => seatMem.reduce((a, m) => a + m[k], 0);
      ramTable.push([
        String(seatsNow), mgr.rssMb.toFixed(1), mgr.pssMb.toFixed(1), mgr.ussMb.toFixed(1),
        mem.heapUsedMb.toFixed(1), mem.heapTotalMb.toFixed(1), mem.externalMb.toFixed(1), mem.codeMb.toFixed(1),
        realSeat ? `${seatMem.length} real` : "stub, shared host",
        realSeat && seatMem.length ? `${(sum("rssMb") / seatMem.length).toFixed(1)} / ${(sum("pssMb") / seatMem.length).toFixed(1)} / ${(sum("ussMb") / seatMem.length).toFixed(1)}` : "",
        seatHost ? (() => { const h = procMem(seatHost.pid!); return `${h.rssMb.toFixed(1)} / ${h.pssMb.toFixed(1)} / ${h.ussMb.toFixed(1)}`; })() : "n/a",
      ]);
      if (realSeat && kids.length && seatsNow === STEPS[STEPS.length - 1]) {
        // One real seat's heap: the signal makes node write Heap.*.heapsnapshot into its cwd.
        const seatCwd = readlinkSync(`/proc/${kids[0]}/cwd`);
        const before = new Set(readdirSync(seatCwd));
        process.kill(kids[0], "SIGUSR2");
        let file: string | undefined, size = -1;
        for (let i = 0; i < 120; i++) {
          await wait(500);
          const f = readdirSync(seatCwd).find((n) => n.endsWith(".heapsnapshot") && !before.has(n));
          if (!f) continue;
          const now = statSync(join(seatCwd, f)).size;
          if (now === size && now > 0) { file = join(seatCwd, f); break; }
          size = now;
        }
        if (file) {
          const top = heapSnapshotTop(file, 5);
          rmSync(file, { force: true });
          snapshots.push(`one real seat process heap snapshot: ${(top.totalBytes / MB).toFixed(1)} MB of objects; top classes by self size: ` + top.top.map((t) => `${t.name} ${(t.bytes / MB).toFixed(1)} MB (${t.count})`).join(", ")
            + `; script source ${(top.sources.bytes / MB).toFixed(1)} MB in ${top.sources.scripts} scripts, largest by package: ` + top.sources.byPackage.map((t) => `${t.name} ${(t.bytes / MB).toFixed(1)} MB (${t.count})`).join(", "));
        } else snapshots.push("one real seat process heap snapshot: not written within 60s");
      }
      if (seatsNow === 0 || seatsNow === STEPS[STEPS.length - 1]) {
        const file = (await ask(manager, { cmd: "snapshot", path: join(dir, `manager-${seatsNow}.heapsnapshot`) }, "snapshot")).snapshot as string;
        const top = heapSnapshotTop(file, 5);
        rmSync(file, { force: true });
        snapshots.push(`manager heap snapshot at ${seatsNow} seats: ${(top.totalBytes / MB).toFixed(1)} MB of objects; top classes by self size: ` + top.top.map((t) => `${t.name} ${(t.bytes / MB).toFixed(1)} MB (${t.count})`).join(", ")
          + `; script source ${(top.sources.bytes / MB).toFixed(1)} MB in ${top.sources.scripts} scripts, largest by package: ` + top.sources.byPackage.map((t) => `${t.name} ${(t.bytes / MB).toFixed(1)} MB (${t.count})`).join(", "));
      }
    }
    console.error(`  … step ${seatsNow}: manager ${(mgrCores * 1000).toFixed(2)} millicores, RSS ${procRssMb(manager.pid!).toFixed(1)} MB, ${host ? `${host.connected} stub-host seats connected` : "stub host not started (real-seat mode)"}`);
    if (spawn?.refusals.length) for (const r of spawn.refusals) console.error(`    refusal: ${r}`);
    if (host && host.firstErrors.length) for (const e of host.firstErrors) console.error(`    seat error: ${e}`);
  };

  await measure(0);
  let have = 0;
  for (const step of STEPS) {
    const r = (await ask(manager, { cmd: "spawn", from: have, to: step }, "spawned")).spawned as { ok: number; failed: number; refusals: string[]; spawnMs: number[]; cpuMs: number; receipts: SeatReceipt[] };
    have = step;
    await measure(step, r);
  }

  if (PROCESS_MEMORY) console.log(`MSL_DONE checks=${measurementChecks} steps=${STEPS.length + 1}`);
  const head = ["seats requested", "stub connected / manager children", "manager millicores", "manager RSS MB", "spawned ok / refused", "manager CPU ms per spawn", "spawn wall p50 / max ms", "seat host millicores", "seat host RSS MB", "broker millicores"];
  console.log(`\nmanager-seat-load  git ${SHA}  host ${availableParallelism()} cores, ${(totalmem() / 1073741824).toFixed(1)} GB  idle window ${SECONDS}s after ${SETTLE_S}s settle  manager shape ${SHAPE === "dist" ? `dist (plain node${MANAGER_NODE_FLAGS.length ? ` ${MANAGER_NODE_FLAGS.join(" ")}` : ""}, built package)` : "src (tsx over source)"}  seats ${realSeat ? `REAL connector processes (${REAL_ENTRY} entry)` : "stub"}\n`);
  console.log(`| ${head.join(" | ")} |`);
  console.log(`|${head.map(() => "---").join("|")}|`);
  for (const r of table) console.log(`| ${r.join(" | ")} |`);
  console.log("");
  if (RAM) {
    // Real seats own their connections; their shared stub-host columns are n/a.
    const ramHead = ["seats", "manager RSS MB", "manager PSS MB", "manager USS MB", "JS heap used MB", "JS heap total MB", "external MB", "compiled code MB", "seat processes", "per seat process RSS / PSS / USS MB", "shared seat host RSS / PSS / USS MB"];
    console.log(`| ${ramHead.join(" | ")} |`);
    console.log(`|${ramHead.map(() => "---").join("|")}|`);
    for (const r of ramTable) console.log(`| ${r.join(" | ")} |`);
    console.log("");
    for (const l of snapshots) console.log(`- ${l}`);
    console.log("");
  }

  stopping = true;
  await memoryObserver?.stop();
  memoryObserver = undefined;
  await ask(manager, { cmd: "stop" }, "stopped").catch(() => undefined);
  if (seatHost) await ask(seatHost, { cmd: "stop" }, "stopped").catch(() => undefined);
} catch (e) {
  console.error("  ✗ manager-seat-load threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  stopping = true;
  await memoryObserver?.stop().catch(() => {});
  for (const c of children) { try { c.kill("SIGKILL"); } catch { /* already gone */ } }
  // The pty children outlive a killed manager; this run's carry its token and nothing else does.
  try { execFileSync("pkill", ["-f", `sleep 99999.${stubToken}`]); } catch { /* none left */ }
  try { execFileSync("pkill", ["-f", `seatload-${stubToken}`]); } catch { /* none left */ }
  await delivery?.stop().catch(() => {});
  await broker.stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(seatRoot, { recursive: true, force: true });
  await new Promise<void>((r) => { process.stdout.write("", () => r()); });
  process.exit(process.exitCode ?? 0);
}

/** Shared-account variant of this fixture; the ordinary single-space controls above stay intact. */
async function runSharedSpaces(): Promise<void> {
  const { bootBrokerAccounts } = await import("./_boot-broker.js");
  const { bootDeliveryDaemon } = await import("./_boot-delivery.js");
  const { procMem, killAndAwaitExit } = await import("@cotal-ai/smoke-kit");
  const { connect } = await import("@nats-io/transport-node");
  const root = mkdtempSync(join(tmpdir(), "mgr-shared-load-"));
  const storeRoot = join(root, "store");
  const tag = randomUUID().slice(0, 8);
  const brokerAuth = await createBrokerAuth(`shared-${tag}`);
  const accounts = await Promise.all(Array.from({ length: SPACES }, (_, i) => createSpaceAccountAuth(brokerAuth, `mgrload-${tag}-${i}`)));
  const auths = accounts.map((account) => composeSpaceAuth(brokerAuth, account));
  const operator = decodeNatsJwt<{ sub: string }>(brokerAuth.operator.jwt).sub;
  saveBrokerAuth(authDir(storeRoot), brokerAuth);
  for (const account of accounts) saveSpaceAccountAuth(authDir(storeRoot), account);
  const storeIdentity = workspaceSecretStore(storeRoot).identity;
  const realSeat = fileURLToPath(new URL("seat.cjs", import.meta.resolve("@cotal-ai/connector-claude-code/mcp")));
  const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const runtimeHashes = {
    fixture: hash(import.meta.filename), brokerHelper: hash(fileURLToPath(new URL("./_boot-broker.ts", import.meta.url))),
    deliveryHelper: hash(fileURLToPath(new URL("./_boot-delivery.ts", import.meta.url))),
    manager: hash(fileURLToPath(new URL("manager.js", import.meta.resolve("@cotal-ai/manager")))),
    seat: hash(realSeat), mcp: hash(fileURLToPath(import.meta.resolve("@cotal-ai/connector-claude-code/mcp"))),
    node: hash(process.execPath),
  };
  let checks = 0, observationErrors = 0;
  const verify = (ok: boolean, detail: string) => {
    if (!ok) throw new Error(`manager-seat-load shared: ${detail}`);
    checks++;
  };
  const pins = new Map<number, ProcessIdentityRecord>();
  const pin = (pid: number) => {
    const existing = pins.get(pid);
    if (existing) { verify(assertRecordIdentity(existing).kind === "match", "a measured process changed identity"); return; }
    const record = identityRecord(pid);
    verify("token" in record, "process start identity is unavailable");
    pins.set(pid, record as ProcessIdentityRecord);
  };
  const processMemory = (pid: number) => {
    if (pid !== process.pid) pin(pid);
    const mem = procMem(pid);
    verify(Object.values(mem).every((n) => Number.isFinite(n) && n >= 0) && mem.rssMb > 0, "process memory sample missing or invalid");
    return { pid, rssMiB: mem.rssMb, pssMiB: mem.pssMb, ussMiB: mem.ussMb };
  };
  type Group = {
    auth: SpaceAuth; manager: ChildProcess; workspaceRoot: string; seatRoot: string;
    instanceId: string; epoch: number; managerUser: string; observer?: CotalEndpoint;
    receipts: Map<string, SeatReceipt>; delivery?: Awaited<ReturnType<typeof bootDeliveryDaemon>>;
  };
  const groups: Group[] = [];
  const children: ChildProcess[] = [];
  const deliveries: Array<Awaited<ReturnType<typeof bootDeliveryDaemon>>> = [];
  const seatRoots: string[] = [];
  let broker: Awaited<ReturnType<typeof bootBrokerAccounts>> | undefined;
  let serverId: string | undefined;
  let stopping = false;
  const expectedDeaths = new Set<number>();
  let abort!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => { abort = reject; });
  aborted.catch(() => {});
  const guard = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, aborted]);
  const request = (child: ChildProcess, command: Cmd | undefined, key: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) { reject(new Error("owned manager already exited")); return; }
    const timer = command?.cmd === "stop" ? setTimeout(() => finish(new Error("owned manager stop did not finish in 30s")), 30_000) : undefined;
    const onExit = () => finish(new Error("owned manager exited before its reply"));
    const onMessage = (message: Record<string, unknown>) => { if (key in message) finish(undefined, message); };
    function finish(error?: Error, message?: Record<string, unknown>) {
      clearTimeout(timer); child.off("message", onMessage); child.off("exit", onExit);
      if (error) reject(error); else resolve(message!);
    }
    child.on("message", onMessage); child.once("exit", onExit);
    if (command) child.send(command, (error: Error | null) => { if (error) finish(error); });
  });
  const placement = async (group: Group) => {
    const nc = await connect({ servers: broker!.servers, ...standaloneConnectOpts({
      creds: await mintMembershipObserverCreds(group.auth, newIdentity()), tls: false,
    }), inboxPrefix: MEMBERSHIP_INBOX_PREFIX });
    try {
      const connectedServer = nc.info?.server_id;
      verify(typeof connectedServer === "string" && connectedServer.length > 0, "native server identity missing");
      if (serverId === undefined) serverId = connectedServer;
      verify(connectedServer === serverId, "accounts reached different broker servers");
      const reply = await nc.request(connzRequestSubject(group.auth.account.pub), JSON.stringify({ auth: true, limit: 1024 }), { timeout: 5000 });
      const body = reply.json<{ server?: { id?: string }; data?: { total?: number; connections?: Array<{ cid?: number; authorized_user?: string }> } }>();
      verify(body.server?.id === connectedServer, "account observation came from another server");
      const connections = body.data?.connections;
      verify(Array.isArray(connections) && connections.length < 1024
        && (body.data?.total === undefined || body.data.total === connections.length), "native account connection inventory missing or truncated");
      const users = connections!.map((row) => row.authorized_user);
      verify(users.every((user) => typeof user === "string"), "native account connection identities missing");
      const expected = [group.managerUser, ...[...group.receipts.values()].map((receipt) => receipt.id)];
      for (const user of expected) verify(users.includes(user), "manager or connector not observed in its assigned account");
      for (const sibling of groups.filter((g) => g !== group))
        for (const user of [sibling.managerUser, ...[...sibling.receipts.values()].map((receipt) => receipt.id)])
          verify(!users.includes(user), "a sibling manager or connector was attributed to this account");
      return { account: group.auth.account.pub, operator, serverId: connectedServer, expectedUsers: expected, connections: connections!.length };
    } finally { await nc.close(); }
  };
  try {
    verify(new Set(accounts.map((a) => a.account.pub)).size === SPACES, "data accounts are not distinct");
    verify(typeof operator === "string" && operator.startsWith("O"), "broker operator identity missing");
    for (const account of accounts)
      verify(decodeNatsJwt<{ iss: string }>(account.account.jwt).iss === operator, "account is not signed by this broker operator");
    broker = await bootBrokerAccounts(brokerAuth, accounts, { monitor: true });
    pin(broker.pid);
    for (let i = 0; i < SPACES; i++) {
      const auth = auths[i]!;
      const workspaceRoot = join(root, `space-${i}`, "ws"), home = join(root, `space-${i}`, "home");
      const seatRoot = mkdtempSync(join(tmpdir(), "s")); seatRoots.push(seatRoot);
      const seatDir = seatRoot; // Nkey-named control sockets must stay below the Unix path limit.
      for (const path of [join(workspaceRoot, ".cotal", "agents"), home, seatDir]) mkdirSync(path, { recursive: true, mode: 0o700 });
      for (let j = 0; j < STEPS[STEPS.length - 1]!; j++)
        writeFileSync(join(workspaceRoot, ".cotal", "agents", `seat${j}.md`), `---\nname: seat${j}\nrole: ${ROLE}\nsubscribe: [${CHANNEL}]\nallowSubscribe: [${CHANNEL}]\nallowPublish: [${CHANNEL}]\n---\n`, { mode: 0o600 });
      await setupSpaceStreams({ servers: broker.servers, space: auth.space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
      const delivery = await bootDeliveryDaemon({ space: auth.space, servers: broker.servers, auth, reloadStoreIdentity: storeIdentity });
      deliveries.push(delivery);
      const env = { ...cleanEnv, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
        XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state"),
        DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off", COTAL_HOME: home, COTAL_SEAT_ROOT: seatRoot };
      const manager = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ...MANAGER_NODE_FLAGS, import.meta.filename, "child"], {
        stdio: ["ignore", "inherit", "inherit", "ipc"], env,
      });
      children.push(manager); pin(manager.pid!);
      manager.on("exit", () => { if (!stopping && !expectedDeaths.has(manager.pid!)) abort(new Error("owned shared-fixture manager exited mid-run")); });
      const ready = request(manager, undefined, "ready");
      manager.send({ kind: "manager", space: auth.space, servers: broker.servers, workspaceRoot, seatDir,
        stubToken: tag, dist: true, realSeat, observeSeats: true, storeRoot, strictStop: true, ...(INITIALIZED_MCP ? { initializedMcp: true } : {}) } satisfies ManagerJob);
      const observed = await guard(ready);
      verify(typeof observed.instanceId === "string" && observed.instanceId.length > 0, "manager instance identity missing");
      verify(typeof observed.epoch === "number" && Number.isSafeInteger(observed.epoch) && observed.epoch >= 0, "manager epoch missing");
      const principal = observed.principal as { actor?: unknown; uid?: unknown } | undefined;
      verify(typeof principal?.actor === "string" && principal.actor.startsWith("U") && typeof principal.uid === "string", "static manager identity missing");
      const group: Group = { auth, manager, workspaceRoot, seatRoot, instanceId: observed.instanceId as string,
        epoch: observed.epoch as number, managerUser: principal!.actor as string, receipts: new Map(), delivery };
      groups.push(group);
      const expiresInSeconds = Math.ceil((SECONDS + SETTLE_S) * (STEPS.length + 1) + STEPS[STEPS.length - 1]! * SPACES * 30 + 120);
      verify(Number.isSafeInteger(expiresInSeconds), "observation lifetime exceeds a safe integer");
      const identity = newIdentity(), lifecycleUid = mintLifecycleUid();
      group.observer = new CotalEndpoint({ space: auth.space, servers: broker.servers, lifecycleUid,
        creds: await mintCreds(auth, identity, "agent", { lifecycleUid, expiresInSeconds, allowSubscribe: [], allowPublish: [], capabilities: [], endpointCapabilities:
          instanceOnlyManagerCapabilities(["describe", "ps"].map((command) => ({ endpoint: "manager", command })), group.instanceId) }),
        card: { id: identity.id, name: "memory-observer", role: "observer", kind: "endpoint" },
        channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
      });
      group.observer.on("error", () => { observationErrors++; }); group.observer.on("warning", () => { observationErrors++; });
      await group.observer.start();
    }
    verify(new Set(groups.map((g) => g.instanceId)).size === SPACES, "manager instance identities are not distinct");
    const observe = async () => {
      const spaces = [];
      for (const group of groups) spaces.push({ space: group.auth.space, instanceId: group.instanceId, epoch: group.epoch,
        ...await observeManagerMemory(group.observer, group.instanceId, group.epoch, group.receipts, group.manager.pid!, () => observationErrors, processMemory, verify),
        placement: await placement(group) });
      const processes = spaces.flatMap((space) => [space.manager, ...space.seats]);
      verify(new Set(processes.map((p) => p.pid)).size === processes.length, "a process belongs to more than one cohort");
      const brokerMemory = processMemory(broker!.pid);
      verify(!processes.some((p) => p.pid === brokerMemory.pid), "broker was counted as a cohort process");
      const parent = processMemory(process.pid);
      const unique = [parent, brokerMemory, ...processes];
      return { observedAt: new Date().toISOString(), parent, broker: brokerMemory, spaces,
        totals: { processes: unique.length, rssMiB: unique.reduce((n, p) => n + p.rssMiB, 0),
          pssMiB: unique.reduce((n, p) => n + p.pssMiB, 0), ussMiB: unique.reduce((n, p) => n + p.ussMiB, 0) } };
    };
    const oracle = DOCS_ORACLE ? JSON.parse(readFileSync(DOCS_ORACLE, "utf8")) as { version: string; workloads: Record<DocsWorkload, { sha256: string; bytes: number }> } : undefined;
    if (oracle) verify(typeof oracle.version === "string" && /^[0-9a-f]{64}$/.test(oracle.workloads?.[DOCS_WORKLOAD!]?.sha256 ?? "") && Number.isSafeInteger(oracle.workloads[DOCS_WORKLOAD!].bytes), "docs oracle is malformed");
    let have = 0;
    let lastObserved: Awaited<ReturnType<typeof observe>> | undefined;
    /** One settle-and-hold window over the common cohort, reported as a labeled MSL_WINDOW and MSL_RESULT. */
    const window = async (step: number, phase: string | undefined, settleSeconds: number) => {
      await guard(wait(settleSeconds * 1000));
      const before = await guard(observe());
      const cpu = [broker!.pid, ...groups.map((g) => g.manager.pid!), process.pid].map(procCpuMs);
      console.log(`MSL_WINDOW ${JSON.stringify({ topology: "shared-broker", ...(phase ? { phase } : {}), requestedPerSpace: step, requestedTotal: step * SPACES,
        brokerPid: broker!.pid, managers: groups.map((g) => g.manager.pid), seatPids: before.spaces.flatMap((g) => g.seats.map((s) => s.pid)) })}`);
      const started = performance.now(), deadline = started + SECONDS * 1000;
      do { await guard(wait(Math.max(1, deadline - performance.now()))); } while (performance.now() < deadline);
      const seconds = (performance.now() - started) / 1000;
      const afterCpu = [broker!.pid, ...groups.map((g) => g.manager.pid!), process.pid].map(procCpuMs);
      const after = await guard(observe());
      lastObserved = after;
      verify(before.spaces.every((group, i) => group.seats.every((seat, j) => seat.pid === after.spaces[i]?.seats[j]?.pid)), "connector process changed during the common window");
      console.log(`MSL_RESULT ${JSON.stringify({ source: SHA, sourceDirty: SOURCE_DIRTY, runtime: process.version, runtimeHashes,
        topology: "shared-broker", ...(phase ? { phase, seatTopology: "initialized-mcp-sdk-client-in-manager" } : {}), spaceCount: SPACES, requested: step * SPACES, requestedPerSpace: step, requestedTotal: step * SPACES,
        shape: SHAPE, seatMode: "real", seatEntry: "stock", cacheScope: "private-home-per-space", stubHostStarted: false,
        heapSnapshots: false, fixtureLayout: "static trusted same-UID managers; parent holds all Plane-3 contexts", operator, serverId,
        windowSeconds: seconds, observationErrors, checks, brokerCpuCores: (afterCpu[0]! - cpu[0]!) / 1000 / seconds,
        parentCpuCores: (afterCpu[groups.length + 1]! - cpu[groups.length + 1]!) / 1000 / seconds,
        managerCpuCores: groups.map((group, i) => ({ instanceId: group.instanceId, cores: (afterCpu[i + 1]! - cpu[i + 1]!) / 1000 / seconds })), before, after })}`);
    };
    for (const step of [0, ...STEPS]) {
      if (step > 0) for (const group of groups) {
        const answer = await guard(request(group.manager, { cmd: "spawn", from: have, to: step }, "spawned"));
        const spawned = answer.spawned as { ok: number; failed: number; receipts: SeatReceipt[]; refusalFacts: Array<{ code: string | null; detailKinds: string[] }> };
        verify(spawned.failed === 0 && spawned.ok === step - have && spawned.receipts.length === spawned.ok,
          `not every requested connector started with a receipt: ${JSON.stringify({ ok: spawned.ok, failed: spawned.failed, refusals: spawned.refusalFacts })}`);
        for (const receipt of spawned.receipts) { verify(!group.receipts.has(receipt.name), "duplicate spawn receipt"); group.receipts.set(receipt.name, receipt); }
        verify(group.receipts.size === step, "successful cohort differs from requested seats");
      }
      have = step;
      if (INITIALIZED_MCP && step > 0) {
        // Barrier: every client has completed initialize and listTools, with no docs call yet.
        const ready = await guard(Promise.all(groups.map(async (group) => (await request(group.manager, { cmd: "mcp-ready" }, "mcpReady")).mcpReady as
          { handles: number; initialized: number; failures: string[]; inits: Array<{ pid: number; startTick: string; tools: number; initializeMs: number; listToolsMs: number }>; unhandled: number; requestTimeoutMs: number })));
        for (const [i, group] of ready.entries()) {
          verify(group.handles === step && group.initialized === step && group.failures.length === 0 && group.unhandled === 0,
            `initialize or listTools barrier incomplete: ${JSON.stringify({ handles: group.handles, initialized: group.initialized, failures: group.failures })}`);
          const spaceSeats = [...groups[i]!.receipts.values()].length;
          verify(group.inits.every((init) => init.tools >= 2) && new Set(group.inits.map((init) => init.pid)).size === spaceSeats, "initialized client PIDs are not one distinct PID per seat");
          for (const init of group.inits) pin(init.pid);
        }
        console.log(`MSL_MCP_INIT ${JSON.stringify({ requestedPerSpace: step, spaces: ready.map((g) => ({ handles: g.handles, initialized: g.initialized,
          initializeMs: g.inits.map((x) => x.initializeMs), listToolsMs: g.inits.map((x) => x.listToolsMs) })), sdkRequestTimeoutMs: ready[0]!.requestTimeoutMs, docsPreloaded: false })}`);
      }
      await window(step, INITIALIZED_MCP ? (step === 0 ? "baseline-no-seats" : "initialized-docs-cold") : undefined, SETTLE_S);
    }
    if (INITIALIZED_MCP && DOCS_WORKLOAD) {
      const armed = await guard(Promise.all(groups.map(async (group) => (await request(group.manager, { cmd: "mcp-arm", workload: DOCS_WORKLOAD }, "mcpArmed")).mcpArmed as { count: number; ready: number; states: string[] })));
      verify(armed.every((a) => a.count === have && a.ready === have), `connection status was not ready before the docs workload: ${JSON.stringify(armed)}`);
      // The barrier: every Manager is armed and quiet; this loop sends the go command to all of them back to back.
      const goSentAt: number[] = [];
      const answers = await guard(Promise.all(groups.map((group) => { goSentAt.push(epochMs()); return request(group.manager, { cmd: "mcp-go" }, "mcpDocs"); })));
      const results = answers.map((a) => a.mcpDocs as { workload: DocsWorkload; recvAtMs: number; calls: Array<{ sentAtMs: number; completedAtMs: number; error?: string; sha256?: string; bytes?: number }>;
        after: { count: number; ready: number; states: string[] }; unhandled: number });
      const calls = results.flatMap((r) => r.calls);
      const expected = oracle!.workloads[DOCS_WORKLOAD];
      const matching = calls.filter((c) => c.error === undefined && c.sha256 === expected.sha256 && c.bytes === expected.bytes).length;
      const sent = calls.map((c) => c.sentAtMs), done = calls.map((c) => c.completedAtMs);
      console.log(`MSL_MCP_DOCS ${JSON.stringify({ workload: DOCS_WORKLOAD, oracleVersion: oracle!.version, expectedSha256: expected.sha256, expectedBytes: expected.bytes,
        calls: calls.length, completed: calls.filter((c) => c.error === undefined).length, errors: calls.filter((c) => c.error !== undefined).map((c) => c.error), matchingOracle: matching,
        goSentAtMs: goSentAt, managerReceivedAtMs: results.map((r) => r.recvAtMs), managerDispatchSkewMs: Math.max(...results.map((r) => r.recvAtMs)) - Math.min(...results.map((r) => r.recvAtMs)),
        callSendSkewMs: Math.max(...sent) - Math.min(...sent), firstSentAtMs: Math.min(...sent), lastCompletedAtMs: Math.max(...done), callDurationsMs: calls.map((c) => c.completedAtMs - c.sentAtMs),
        connectionAfter: results.map((r) => r.after), unhandled: results.map((r) => r.unhandled) })}`);
      verify(calls.length === have * SPACES && matching === calls.length, "docs workload did not complete with the oracle response on every seat");
      verify(results.every((r) => r.after.count === have && r.after.ready === have && r.unhandled === 0), "connection status was not ready after the docs workload");
      const point = await guard(observe());
      console.log(`MSL_RESULT ${JSON.stringify({ phase: "after-workload", note: "single observation, not a window", observedAt: point.observedAt, requestedPerSpace: have, requestedTotal: have * SPACES, before: point })}`);
      await window(have, "after-hold", 0);
    }
    if (MANAGER_DEATH) {
      // Last step: kill one Manager without cleanup. Its seat children hold the other end of SDK pipes.
      const victim = groups[0]!;
      const seatPids = [...pins.keys()].filter((pid) => { try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[3] === String(victim.manager.pid); } catch { return false; } });
      verify(seatPids.length === have, "the victim Manager's seat children were not found");
      expectedDeaths.add(victim.manager.pid!);
      process.kill(victim.manager.pid!, "SIGKILL");
      await new Promise<void>((resolve) => victim.manager.once("exit", () => resolve()));
      let remaining = seatPids.length;
      for (let i = 0; i < 300 && remaining > 0; i++) { remaining = seatPids.filter((pid) => assertRecordIdentity(pins.get(pid)!).kind === "match").length; if (remaining > 0) await wait(50); }
      console.log(`MSL_MANAGER_DEATH ${JSON.stringify({ seats: seatPids.length, remainingAfterOwnerDeath: remaining, note: remaining === 0 ? "seat children ended on pipe EOF" : "seat children survived; the pinned cleanup below removes them" })}`);
    }
  } catch (error) {
    process.exitCode = 1;
    console.error(`manager-seat-load shared failed: ${error instanceof Error ? error.message : "unreadable failure"}`);
  } finally {
    stopping = true;
    // Pin direct pty children before stopping a Manager, including a partially completed spawn.
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const record = pins.get(child.pid!);
      verify(record !== undefined && assertRecordIdentity(record).kind === "match", "manager identity unavailable during cleanup");
      for (const pid of readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number)) pin(pid);
    }
    for (const group of groups) await group.observer?.stop();
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      try { await request(child, { cmd: "stop" }, "stopped"); }
      catch { process.exitCode = 1; console.error("manager-seat-load shared: graceful Manager stop failed; terminating only pinned fixture processes"); }
    }
    // No argv scan or process-name sweep: signal only processes whose recorded start still matches.
    for (const [pid, record] of pins) {
      if (pid === broker?.pid) continue;
      const state = assertRecordIdentity(record).kind;
      verify(state === "gone" || state === "match", "owned process custody is uncertain; preserving fixture");
      if (state === "match") process.kill(pid, "SIGKILL");
    }
    for (const child of children) await killAndAwaitExit(child);
    for (let attempt = 0; attempt < 50; attempt++) {
      if ([...pins].filter(([pid]) => pid !== broker?.pid).every(([, record]) => assertRecordIdentity(record).kind === "gone")) break;
      await wait(100);
    }
    verify([...pins].filter(([pid]) => pid !== broker?.pid).every(([, record]) => assertRecordIdentity(record).kind === "gone"), "fixture processes remain; broker and directories retained");
    for (const delivery of deliveries) await delivery.stop();
    await broker?.stop();
    if (broker) verify(assertRecordIdentity(pins.get(broker.pid)!).kind === "gone", "owned broker remains after stop");
    for (const seatRoot of seatRoots) rmSync(seatRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    console.log(`MSL_TEARDOWN ${JSON.stringify({ brokerPid: broker?.pid, managers: children.length, pinnedProcessesGone: pins.size, directoriesRemoved: true })}`);
  }
  if (!process.exitCode) console.log(`MSL_DONE checks=${checks} steps=${STEPS.length + 1} spaces=${SPACES}`);
}
