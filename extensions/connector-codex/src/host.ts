/**
 * Codex host-mode peer: embeds a Cotal {@link MeshAgent} in the same process as an
 * {@link AppServerDriver}, so a Codex session is a full lateral mesh peer. One process,
 * one endpoint, one thread:
 *
 *  • inbound mesh messages become real Codex turns — a batch wakes an idle thread
 *    (`turn/start`); a DIRECTED message (DM / anycast / @mention) arriving mid-turn is
 *    steered INTO the live turn (`turn/steer`, race-safe via expectedTurnId) — ambient
 *    chatter waits for the turn boundary so it can't derail the work in flight;
 *  • the cotal_* tools are served by THIS process over a loopback MCP endpoint (mcp.ts), so the
 *    model replies itself via cotal_send / cotal_dm — and, because the app-server is the MCP
 *    client, they work on a turn someone typed into the attached TUI just as well as on a
 *    mesh-driven one;
 *  • ack-on-completion with EXACT ids: a turn's surfaced messages are drainInboxIds-acked
 *    ONLY when the turn reaches `completed`. A `failed` turn (transient model/upstream error)
 *    leaves them un-acked and retries with bounded backoff; an `interrupted` turn leaves them
 *    for redelivery — matching the OpenCode connector's semantics — and an app-server CRASH
 *    restarts the child in place (same mesh lifecycle) and re-drives them. Attention modes
 *    hold: ambient drives only in `open`; dnd/focus hold it; a focus @mention wakes a pull
 *    turn (latched until a turn accepts it); quiet stays pull-only.
 *  • presence falls out of the app-server event stream (turn → working, approval → waiting,
 *    item detail → activity), never self-guessed;
 *  • the per-agent CODEX_HOME (under `<workspaceRoot>/.cotal/codex/<name>`) isolates the
 *    child from the operator's config.toml / hooks.json / MCP servers, with the operator's
 *    auth.json symlinked in (re-linked every launch, so a rename-over by a token refresh
 *    can't permanently fork auth state).
 *
 * Identity comes from COTAL_* env (the launcher decides once); a missing identity is a
 * broken launch and fails loud — this binary is never run standalone by an operator.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { delimiter, join, resolve, sep } from "node:path";
import { homedir } from "node:os";

/** Is `bin` resolvable on PATH? A cheap cross-platform scan (adds PATHEXT on Windows) for a
 *  friendly missing-binary error, not a full exec-permission check. */
function onPath(bin: string): boolean {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (existsSync(join(dir, bin + ext))) return true;
  }
  return false;
}
import { hardenPrivate, loadAgentFile } from "@cotal-ai/core";
import {
  MeshAgent,
  configFromEnv,
  feedbackLine,
  formatInjection,
  fmtFrom,
  startControlServer,
  ORIENTATION_BOOTSTRAP,
  MESH_FIRST_STEER,
  AguiEmitter,
  AguiEmitterHolder,
  EventWal,
  FileSubjectFrontier,
  JsonlFileSource,
  ensureEventWalDir,
  resolveEventsStateRoot,
  type InboxItem,
} from "@cotal-ai/connector-core";
import { principalKey } from "@cotal-ai/core";
import { randomUUID } from "node:crypto";
import { AppServerDriver, type ThreadItem } from "./app-server.js";
import { createCodexMapper, type CodexMapper, type CodexRecord } from "./agui-map.js";
import { waitForRollout } from "./agui-rollout.js";
import { startCotalMcp, MCP_SERVER_NAME, MCP_TOKEN_ENV, type CotalMcpEndpoint } from "./mcp.js";
import { launchTui } from "./tui.js";

const ERROR_RETRY_INITIAL_MS = 1_000;
const ERROR_RETRY_MAX_MS = 30_000;
/** App-server crash recovery budget: more than MAX_RESTARTS crashes inside the window is a crash
 *  loop, not a blip, and the host dies loudly rather than respawning forever. */
const RESTART_WINDOW_MS = 120_000;
const MAX_RESTARTS = 3;
/** How often a presence update latched while the endpoint was still connecting is retried. */
const STATUS_FLUSH_MS = 500;
/** How long a cooperative shutdown waits for the clean mesh leave before exiting regardless. */
const SHUTDOWN_GRACE_MS = 5_000;
/** Looks the launch spends waiting for a thread's rollout file to appear, at 250ms each. Bounded
 *  because a caller that waits forever cannot report that it is stuck; giving up is not final,
 *  because every later turn boundary looks again (see `bindEvents`). */
const ROLLOUT_ATTEMPTS = 40;

/** Once the Codex TUI owns the terminal, NOTHING else may write to it — a stray log line lands
 *  in the middle of its rendering. From that point the host's own diagnostics go to a file inside
 *  the agent's CODEX_HOME instead. Until then (and in headless mode) they go to stderr, so a
 *  launch that fails before the UI is up still says why, on the terminal. */
let logSink: WriteStream | undefined;

function log(msg: string): void {
  const line = `[cotal-codex] ${msg}\n`;
  if (logSink) logSink.write(line);
  else process.stderr.write(line);
}

/** Say something on the TERMINAL even after the log has moved into the agent's home — for the
 *  moments the operator would otherwise be left staring at a returned shell prompt with no
 *  explanation. Only safe when no TUI is painting (it failed to launch, or it has just died); at
 *  any other moment a stray line lands in the middle of Codex's rendering, which is why the
 *  ordinary {@link log} exists. */
function tellOperator(msg: string): void {
  log(msg);
  if (logSink) process.stderr.write(`[cotal-codex] ${msg}\n`);
}

/** The headless activity feed, for a host with no TUI (a piped stdout — a container or a smoke).
 *  With the TUI attached the feed is redundant, because Codex renders the same events itself, so
 *  it is suppressed rather than interleaved into its output.
 *
 *  Event text (a model message, a command) is arbitrary and often multi-line, so continuations are
 *  indented: every line then reads as either an event (starts in column 0) or part of the one
 *  above it, which is what makes the stream safe to follow — or grep — line by line. */
let feedEnabled = true;
function feed(line: string): void {
  if (feedEnabled) process.stdout.write(`${line.replace(/\r?\n/g, "\n    ")}\n`);
}

/** The persona/mesh briefing injected as `thread/start.developerInstructions` — ADDITIVE to
 *  Codex's base instructions (never a replacement), mirroring the Claude connector's MCP
 *  server instructions + `--append-system-prompt` persona. */
function developerInstructions(config: ReturnType<typeof configFromEnv>, persona: string | undefined): string {
  const mesh =
    `You are connected to the Cotal mesh as "${config.name}"` +
    `${config.role ? ` (role: ${config.role})` : ""} in space "${config.space}". ` +
    `${ORIENTATION_BOOTSTRAP} ` +
    feedbackLine(config) +
    `${MESH_FIRST_STEER} ` +
    `Peer messages are delivered into your turns as blocks marked 📨. Reply with cotal_dm ` +
    `(privately, to the sender), cotal_send (to a channel), or cotal_anycast (to a role); ` +
    `use cotal_roster to see who is present and cotal_status to report what you are doing. ` +
    `Reply only when a reply is actually needed — silent acknowledgement is correct, and ` +
    `@-mention a peer only when you need THAT peer to act now.`;
  return persona ? `${persona}\n\n${mesh}` : mesh;
}

/** Build the per-agent CODEX_HOME and (re-)link the operator's auth.json into it. The directory
 *  is ONE filesystem component derived from space+name: a readable slug plus a hash of the raw
 *  `space\0name` pair. Valid Cotal names include `.` and `..`, so raw path components would let
 *  an agent named `..` collapse out of its directory and clobber/replace SHARED state (the
 *  sibling homes, the auth link) — the hash keeps hostile or colliding names contained and
 *  distinct, and a containment assert backstops the construction. Hardened private — it holds
 *  an auth link plus session rollouts. */
function prepareCodexHome(space: string, name: string): string {
  const dataRoot = process.env.COTAL_CODEX_HOME?.trim();
  if (!dataRoot) throw new Error("COTAL_CODEX_HOME is not set — the connector must pin the agent's data root");
  const slug = `${space}-${name}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const key = createHash("sha256").update(`${space}\0${name}`).digest("hex").slice(0, 12);
  const root = join(dataRoot, ".cotal", "codex");
  const agentHome = join(root, `${slug || "agent"}-${key}`);
  if (!resolve(agentHome).startsWith(resolve(root) + sep))
    throw new Error(`codex home ${agentHome} escapes ${root} — refusing`);
  // The data root is agent-writable workspace: a prior (or sibling) agent could have PLANTED a
  // symlink at any managed level, redirecting the mkdir/harden/rm/link below into the operator's
  // real CODEX_HOME (worst case: deleting their real auth.json through the link). Refuse a
  // symlink at every managed component, fail closed, before touching anything.
  for (const p of [join(dataRoot, ".cotal"), root, agentHome]) {
    try {
      if (lstatSync(p).isSymbolicLink()) throw new Error(`refusing symlinked managed path: ${p}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  mkdirSync(agentHome, { recursive: true });
  hardenPrivate(agentHome, "dir");
  // The operator's real codex home: their CODEX_HOME if set (forwarded by the connector), else
  // ~/.codex. auth.json is SYMLINKED (not copied): ChatGPT-plan auth rotates its refresh token,
  // so a copy would fork the token chain and break whichever side refreshes second. Re-linked
  // fresh on every launch — if a codex write replaced the link with a regular file mid-session,
  // the next launch heals it. Absent auth.json is not fatal HERE: OPENAI_API_KEY is still a valid
  // way in, and codex stays the auth authority — the account probe after thread/start is what
  // refuses an unauthenticated launch. (A keyring-stored credential does NOT survive into the
  // isolated home; managed agents need the file store or the env key. See docs/connect-codex.md.)
  const operatorHome = resolve(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
  const operatorAuth = join(operatorHome, "auth.json");
  // ALWAYS clear the managed auth entry first: a codex rename-over can have turned the link
  // into a stale regular credential, and if the operator has since logged out (source auth
  // removed) that stale copy must NOT survive to authenticate this agent. Only then re-link
  // to a source that currently exists.
  if (resolve(agentHome) !== operatorHome) {
    rmSync(join(agentHome, "auth.json"), { force: true });
    if (existsSync(operatorAuth)) symlinkSync(operatorAuth, join(agentHome, "auth.json"));
  }
  return agentHome;
}

/** The `-c key=value` override list for the codex child: the operator's launch options first
 *  (verbatim), then the selectors and autonomy defaults ONLY where the operator didn't set that
 *  key — one rail, so an explicit `--opt approval_policy=…` naturally wins. */
function configOverrides(model: string | undefined, variant: string | undefined): [string, string][] {
  const overrides: [string, string][] = [];
  const raw = process.env.COTAL_CODEX_CONFIG?.trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("COTAL_CODEX_CONFIG must be a JSON object of config-key → value");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("COTAL_CODEX_CONFIG must be a JSON object of config-key → value");
    for (const [k, v] of Object.entries(parsed)) overrides.push([k, String(v)]);
  }
  const has = (key: string): boolean => overrides.some(([k]) => k === key);
  if (model && !has("model")) overrides.push(["model", `"${model}"`]);
  if (variant && !has("model_reasoning_effort")) overrides.push(["model_reasoning_effort", `"${variant}"`]);
  // Autonomy: a headless host has no one to answer an approval prompt, so an interactive
  // approval_policy cannot be HONORED — the driver would have to auto-answer, silently
  // nullifying the operator's stated policy. Refuse anything but `never` rather than pretend.
  const approval = overrides.find(([k]) => k === "approval_policy");
  if (approval && approval[1].replace(/"/g, "") !== "never")
    throw new Error(
      `codex connector: approval_policy=${approval[1]} is not supported — the headless host cannot ` +
        `answer interactive approvals; only "never" (the default) is honest here. Tighten the sandbox ` +
        `(sandbox_mode) instead to restrict what the agent may do.`,
    );
  if (!approval) overrides.push(["approval_policy", '"never"']);
  // `never` means never ASK, not never allow: the agent runs its commands, and what bounds it is
  // the sandbox below, not a prompt nobody would be there to answer.
  const sandbox = overrides.find(([k]) => k === "sandbox_mode");
  const sandboxMode = sandbox ? sandbox[1].replace(/"/g, "") : "workspace-write";
  if (!sandbox) overrides.push(["sandbox_mode", '"workspace-write"']);
  // ...and inside that sandbox, network ON. Codex defaults workspace-write to no network, which
  // silently breaks most real work an agent is asked to do (installing a dependency, pushing a
  // branch, calling an API) with a failure that reads as the task being impossible rather than
  // the sandbox saying no. Filesystem containment is the part worth keeping — a peer's message is
  // a REMOTE input that can make this agent run commands, so it should not be able to write
  // outside its workspace.
  //
  // Scoped to the mode it actually describes rather than emitted always and assumed inert: under
  // `read-only` or `danger-full-access` this key has nothing to say, and shipping it anyway would
  // put a network permission in the argv of a launch the operator deliberately tightened — a claim
  // about codex's precedence we would be making without proving it.
  if (sandboxMode === "workspace-write" && !has("sandbox_workspace_write"))
    overrides.push(["sandbox_workspace_write", "{network_access=true}"]);
  // The connector OWNS the `mcp_servers.cotal.*` namespace — it is where this agent's own mesh
  // voice is wired up, not a tunable. A later `-c` wins in codex, so an operator key here would
  // be silently overridden; refuse instead, so a bad launch says so rather than half-applying.
  // The whole `mcp_servers` namespace, not just our dotted keys. A launch option cannot even
  // express a dotted key (the key grammar refuses `.`), so the reachable shape is a TOP-LEVEL
  // `mcp_servers` inline table — which would merge against ours and leave last-`-c`-wins to sort
  // out a half-applied result. Refuse the whole namespace instead, matching the loud refusal
  // tool-sharing already gets.
  const stolen = overrides.find(([k]) => k === "mcp_servers" || k.startsWith("mcp_servers."));
  if (stolen)
    throw new Error(
      `codex connector: ${stolen[0]} is reserved — mcp_servers is how this agent reaches the mesh and ` +
        `cannot be set through launch options. Tool-sharing (connectors.codex.mcpServers) is the ` +
        `supported way to add servers, and is not implemented yet.`,
    );
  return overrides;
}

/** Point the child at the cotal_* tools this host is serving (mcp.ts). Appended LAST, and codex
 *  resolves a repeated key to the last `-c`, so this is authoritative over anything else. */
function mcpOverrides(mcp: CotalMcpEndpoint): [string, string][] {
  const p = `mcp_servers.${MCP_SERVER_NAME}`;
  return [
    [`${p}.url`, `"${mcp.url}"`],
    // By NAME, never by value: a token on argv is world-readable in the process table.
    [`${p}.bearer_token_env_var`, `"${MCP_TOKEN_ENV}"`],
    // Pre-approve this server's tools. Codex otherwise raises an elicitation ("Allow the cotal
    // MCP server to run tool X?") per call, which for a mesh-driven turn nobody is watching would
    // hang the turn forever. These are the agent's own mesh voice — the same surface every other
    // connector exposes ungated — so standing approval is the honest setting, not a loosening.
    [`${p}.default_tools_approval_mode`, '"approve"'],
  ];
}

export async function runCodexHost(): Promise<void> {
  const config = configFromEnv(); // throws without an identity — a host launch is always managed
  config.connector = "codex";
  const def = process.env.COTAL_AGENT_FILE?.trim() ? loadAgentFile(process.env.COTAL_AGENT_FILE.trim()) : undefined;
  const persona = def?.persona || undefined;
  const model = config.model;
  const variant = config.variant;

  // The endpoint is CONSTRUCTED here (handlers below bind to it) but NOT started until the
  // app-server thread is up AND auth is validated — starting it connects and publishes idle
  // presence, and a peer must never advertise online before we know it can actually run a turn
  // (a later auth failure can't retract a presence interval already seen by the roster).
  const agent = new MeshAgent(config);

  const codexHome = prepareCodexHome(config.space, config.name);
  const codexBin = process.env.COTAL_CODEX_BIN?.trim() || undefined;
  // Validate the operator's launch config BEFORE anything is listening, so a bad launch throws
  // with nothing left behind to reap.
  const baseOverrides = configOverrides(model, variant);
  // The cotal_* tools must be LISTENING before the child spawns: the child's config names this
  // URL and codex dials it while starting the thread.
  const mcp = await startCotalMcp(agent, config, log);
  const driver = new AppServerDriver({
    cwd: process.cwd(),
    codexHome,
    configOverrides: [...baseOverrides, ...mcpOverrides(mcp)],
    developerInstructions: developerInstructions(config, persona),
    extraEnv: { [MCP_TOKEN_ENV]: mcp.token },
    bin: codexBin,
    log,
  });

  /** Publishes this thread's activity as AG-UI events on `events.<owner>.<actor>`.
   *
   *  Armed by the launch (`COTAL_EVENTS`), so a seat the operator did not arm never reaches the
   *  broker for an event plane it has no grant for. The emitter is built LAZILY on the first
   *  adopt, because its source is the rollout file, whose path is not known until the thread
   *  exists, and because `start()` reaches the broker, work that must not run for a thread that
   *  never publishes. */
  const eventsArmed = /^(1|true|yes|on)$/i.test(process.env.COTAL_EVENTS ?? "");
  let events: AguiEmitterHolder<CodexRecord> | undefined;
  let mapper: CodexMapper | undefined;
  /** The adopted rollout path. A holder binds to ONE path and dies on a second, so every flush
   *  names the file the emitter is already reading rather than re-deriving it, and a NEW thread
   *  gets a new holder rather than a second adopt (see `bindEvents`). */
  let rollout: string | undefined;
  const newEventHolder = (startCursor: string): AguiEmitterHolder<CodexRecord> =>
    new AguiEmitterHolder<CodexRecord>(
      async (rolloutPath: string) => {
        // Throws rather than defaulting to the working directory: a write-ahead log written
        // somewhere no later start looks is a silent loss.
        const workspaceRoot = resolveEventsStateRoot(process.env);
        // The thread id is the rollout filename key, MEASURED equal to `session_meta.payload.id`
        // and to the `thread/start` id on a real app-server thread. Taken from the path this
        // emitter actually reads, so the log cannot be keyed to one thread while consuming
        // another's bytes.
        const threadId = (rolloutPath.match(/rollout-.*?-([0-9a-f-]{36})\.jsonl$/)?.[1]) ?? "";
        if (threadId === "") throw new Error(`cannot derive a thread id from rollout path ${rolloutPath}`);
        const principal = principalKey(agent.ep.principal.owner, agent.ep.principal.actor).key;
        const { walPath, subjectPath } = await ensureEventWalDir({ workspaceRoot, space: config.space, principal, threadId });
        const subjectFrontier = await FileSubjectFrontier.open(subjectPath, { space: config.space, principal });
        const wal = await EventWal.open(walPath, { space: config.space, threadId, principal, subjectMayExist: false });
        // THE STREAM STARTS WHERE THE BIND WAS TAKEN, NOT WHERE THIS SETUP FINISHED.
        //
        // A fresh WAL carries no cursor, so the emitter's first read positions the source at the
        // last complete record AS OF THAT READ. That read happens after everything above: the WAL
        // directory, the subject frontier, the log itself, and then a channel resolve and a
        // single-replica preflight, all of them filesystem and broker work. Every record the child
        // appends while that runs lands BEHIND the cursor and is then treated as "already written",
        // so a turn that completes inside the window is dropped, permanently and silently, under a
        // line that has already announced the stream as started. Measured at 17ms and 36ms on an
        // idle machine and reproduced end to end by widening it: the connector's own cell, "from
        // the bind onward the seat publishes normally", fails with nothing added.
        //
        // `startCursor` is the boundary captured at the BIND, before the announcement. Seeding it
        // here makes the announced fact true at the moment it is announced, and it is a cursor-only
        // advance because that is exactly what it means: consumed up to here, emitted nothing.
        // GUARDED ON A FRESH FRONTIER, because a WAL that already carries a cursor is a RESUME and
        // its own cursor is the honest one; overwriting it would re-read or skip a live session's
        // records depending on which way the two disagreed.
        if (wal.frontier.sourceCursor === undefined) await wal.advanceCursorOnly(startCursor);
        mapper = createCodexMapper({ threadId, mintRunId: () => randomUUID() });
        return AguiEmitter.start<CodexRecord>({
          endpoint: agent.ep,
          wal,
          subjectFrontier,
          source: new JsonlFileSource<CodexRecord>(rolloutPath),
          map: mapper.map,
        });
      },
      // Required, and not defaulted to a swallow. The holder is terminal on error and does not
      // retry, so this line is the whole record of why events stopped.
      (e: Error) => log(`AG-UI emitter stopped: ${e.message}`),
      // A turn terminal closes a run the record stream never described. Without this the mapper
      // would attribute the next records to a run the published stream has already finished.
      (runId: string) => mapper?.forgetOpenRun(runId),
    );

  // Presence is best-effort and must never throw into the turn loop — but it must also never
  // LIE. The mesh connect runs in the background, so an auto-prompt (`--prompt`) can open a real
  // turn while the endpoint is still connecting; dropping that "working" would leave the roster
  // showing the default `idle` for the whole first turn. So the latest desired status is latched
  // and replayed once the endpoint is up (last write wins — a stale one is never resurrected).
  type Presence = { status: "idle" | "working" | "waiting" | "offline"; activity?: string };
  let desired: Presence | undefined;
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  function armStatusFlush(): void {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
      if (!desired || !agent.connected) {
        if (!desired) {
          clearInterval(flushTimer);
          flushTimer = undefined;
        }
        return;
      }
      const want = desired;
      desired = undefined;
      clearInterval(flushTimer);
      flushTimer = undefined;
      agent.setStatus(want.status, want.activity).catch(() => {
        if (!desired) desired = want; // nothing newer intervened — keep trying
        armStatusFlush();
      });
    }, STATUS_FLUSH_MS);
    flushTimer.unref?.();
  }
  const safeStatus = async (status: Presence["status"], activity?: string): Promise<void> => {
    desired = { status, activity };
    if (!agent.connected) return armStatusFlush();
    const want = desired;
    desired = undefined;
    try {
      await agent.setStatus(status, activity);
    } catch {
      if (!desired) desired = want;
      armStatusFlush();
    }
  };

  // ---- the turn loop -------------------------------------------------------
  let ready = false; // thread up — never drive before then
  let agentStarted = false; // the mesh endpoint has been connected (once per process, ever)
  let shuttingDown = false; // a retirement owns the rest of this process (see shutdown() below);
  // declared here, with the rest of the loop's state, because the launch/restart tails read it to
  // decide whether they are still allowed to act — long before shutdown() itself is defined
  let driving = false; // re-entrancy guard around an in-flight turn/start
  let steering = false; // serialize steer batches
  let awaitingTurnEnd = false; // a driven turn is open — its surfaced ids ack at the boundary
  let surfaced: string[] = []; // EXACT ids fed into the open turn (start + steered)
  let briefed = false; // the boot channel briefing is prepended once
  let pendingPullHint: string | undefined; // focus @mention latch: its body was ack-dropped at
  // ingest, so a wake that can't run NOW must be remembered until a turn can carry it
  let steerSettled: Promise<unknown> = Promise.resolve(); // the last in-flight steer RPC — the
  // terminal handler waits on it so an accepted-but-unrecorded steer can never mis-ack
  let errorRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let errorRetryMs = ERROR_RETRY_INITIAL_MS;

  function clearErrorRetry(resetDelay = false): void {
    if (errorRetryTimer) clearTimeout(errorRetryTimer);
    errorRetryTimer = undefined;
    if (resetDelay) errorRetryMs = ERROR_RETRY_INITIAL_MS;
  }

  function scheduleErrorRetry(): void {
    if (shuttingDown || errorRetryTimer || (agent.pendingWake() === 0 && !pendingPullHint)) return;
    const delay = errorRetryMs;
    errorRetryMs = Math.min(errorRetryMs * 2, ERROR_RETRY_MAX_MS);
    errorRetryTimer = setTimeout(() => {
      errorRetryTimer = undefined;
      if (driver.busy) return;
      // The latched pull hint has NO buffered inbox copy (its body was ack-dropped at ingest), so
      // pendingWake() can't see it — retry it explicitly, ahead of ordinary batches.
      if (pendingPullHint) void drive(pendingPullHint);
      else if (agent.pendingWake() > 0) void drive();
    }, delay);
    errorRetryTimer.unref?.();
  }

  /** Start a turn carrying the current automatic inbox batch (or `override` — a bare nudge that
   *  surfaces nothing to ack). Ack happens at the turn boundary, never here. */
  async function drive(override?: string): Promise<void> {
    // `shuttingDown` first: interrupting the live turn ends it, and that boundary would otherwise
    // re-drive the un-acked batch into a child we are in the middle of stopping — an endless
    // "app-server not running" retry that outlives the shutdown. The batch stays un-acked in the
    // stream instead (see the shutdown note below on what that does and does not promise).
    if (shuttingDown || !ready || driving || driver.busy || awaitingTurnEnd) return;
    driving = true;
    try {
      const parts: string[] = [];
      let ids: string[] = [];
      if (override) {
        parts.push(override);
      } else {
        const items = agent.peekInbox("automatic");
        if (items.length === 0) return;
        ids = items.map((i) => i.id);
        const inj = formatInjection(items);
        if (inj) parts.push(inj);
      }
      if (parts.length === 0) return;
      if (!briefed) {
        briefed = true;
        const brief = agent.channelBriefing();
        if (brief) parts.unshift(brief);
      }
      surfaced = ids;
      // Arm BEFORE the await: the turn's end can race the turn/start response, and completeTurn
      // bails unless armed — arming after would drop the ack and wedge the loop.
      awaitingTurnEnd = true;
      await driver.startTurn(parts.join("\n\n"));
      // The turn ACCEPTED the pull hint — only now is the latch consumed. (A failed start keeps
      // it latched; the retry rail re-drives it, since no inbox copy can.)
      if (override && override === pendingPullHint) pendingPullHint = undefined;
    } catch (e) {
      surfaced = [];
      awaitingTurnEnd = false;
      log(`drive failed: ${(e as Error).message}`);
      scheduleErrorRetry();
    } finally {
      driving = false;
    }
  }

  /** Steer DIRECTED (DM / anycast / @mention) automatic items into the live turn. Ambient waits
   *  for the boundary so channel chatter can't derail the work in flight. Exact-id acks mean the
   *  steered set need not be front-contiguous. A declined steer (the turn just ended) leaves the
   *  items buffered — completeTurn's drive picks them up. */
  async function steerPending(): Promise<void> {
    if (steering || !driver.busy || !awaitingTurnEnd) return;
    steering = true;
    try {
      for (;;) {
        const surfacedSet = new Set(surfaced);
        const items = agent
          .peekInbox("automatic")
          .filter((i) => !surfacedSet.has(i.id) && (i.kind !== "channel" || i.mentionsMe));
        if (items.length === 0 || !driver.busy) return;
        const inj = formatInjection(items);
        if (!inj) return;
        // The steer RPC and the turn's terminal notification can race in one stdout chunk. The
        // terminal handler awaits `steerSettled`, so the accept/decline outcome is always
        // recorded before the ack set is decided; and ids are promoted into `surfaced` only
        // while the turn is STILL open — an accept that lands after the boundary leaves them
        // in the inbox (redelivered next turn: the at-least-once side of the race).
        const rpc = driver.steer(inj);
        steerSettled = rpc.catch(() => false);
        if (!(await rpc)) return; // declined — the boundary drive handles them
        if (!awaitingTurnEnd) return; // turn closed while the accept was in flight — redeliver
        surfaced.push(...items.map((i) => i.id));
      }
    } finally {
      steering = false;
    }
  }

  /** The single turn-boundary site. Ack ONLY a `completed` turn's surfaced ids (exact-id drain:
   *  an overflow-evicted id is reported missing, never mis-acked positionally). `failed` (a
   *  transient model/upstream error) and `interrupted` (an operator/shutdown cancel) both leave
   *  the ids un-acked so the batch redelivers — failed with backoff, so a permanently failing
   *  batch can't hot-loop. Waits for any in-flight steer RPC first, so the ack set is settled. */
  let boundaryGen = 0; // bumped per turn boundary: a boundary's ASYNC tail (flush/status/pump)
  // must no-op once a newer boundary exists, or T1's stale tail would overwrite T2's presence
  // and pump T2's failed batch past its backoff.
  function completeTurn(status: string, owned: boolean): void {
    // A turn this host did not start (the operator typed into the attached TUI) is NOT our
    // boundary. It carried none of our surfaced ids, so acking on it would drop peer messages
    // outright, and closing our accounting on it would strand the turn we really are waiting on.
    // Observe it for presence only.
    if (!owned) {
      void (async () => {
        if (driver.busy) return; // another turn (ours or theirs) is still running
        await safeStatus("idle");
        // ...but the boundary still has to PUMP. Traffic that arrived while the human's turn was
        // running was buffered (steerPending declines when we have no turn of our own), and if
        // this is the last live turn nothing else will come along to drive it. Without this a DM
        // delivered during a standalone TUI turn sits in the inbox until unrelated traffic
        // happens to wake the loop. `drive()` is self-guarding, so this cannot double-drive.
        if (driver.busy) return;
        if (pendingPullHint) void drive(pendingPullHint);
        else if (agent.pendingWake() > 0) void drive();
      })();
      return;
    }
    const settle = steerSettled;
    void settle.finally(() => {
      const gen = ++boundaryGen;
      const wasOpen = awaitingTurnEnd;
      awaitingTurnEnd = false;
      const ids = surfaced;
      surfaced = [];
      if (wasOpen && ids.length > 0 && status === "completed") agent.drainInboxIds(ids); // the sole ack site
      if (status === "failed") scheduleErrorRetry();
      else clearErrorRetry(true);
      void (async () => {
        if (gen !== boundaryGen) return; // a newer turn boundary owns presence + the next drive
        await safeStatus("idle");
        if (gen !== boundaryGen) return;
        if (pendingPullHint) {
          void drive(pendingPullHint); // the latched focus pull — drive() consumes the latch only on ACCEPT
        } else if (status !== "failed" && agent.pendingWake() > 0) {
          void drive(); // failed batches wait for the backoff timer instead of hot-looping
        }
      })();
    });
  }

  // ---- events --------------------------------------------------------------

  /** The thread the plane should be publishing. Set at every `comeOnline`, so a restart's new
   *  thread is what a retry binds to rather than the dead one. */
  let eventsThread: string | undefined;
  /** One bind at a time. `bindEvents` awaits a file that may not exist yet, and every turn
   *  boundary can call it, so without this a slow resolve would be re-entered per boundary. */
  let binding = false;
  /** A boundary that arrived while a bind was in flight. It is REMEMBERED rather than dropped: the
   *  boundary is the signal that the thread just did something, and the file it was waiting for may
   *  have appeared during exactly that window. Without this the retry has to win a race with the
   *  flag, and a turn whose start and end land in one burst would lose it. */
  let missedBind = false;
  /** Flush what the current binding settled, close the run it left open, and wait for both to land.
   *
   *  ORDER MATTERS: closing first would terminate a run the flushed records still belong to. This is
   *  the same drain the OpenCode connector runs when a new session replaces the one it publishes. */
  async function drainBinding(): Promise<void> {
    if (events === undefined) return;
    if (rollout !== undefined) events.flush(rollout);
    events.closeRun(Date.now());
    await events.settled();
  }

  /** Bind the plane to a thread's rollout, DRAINING and REPLACING any previous binding.
   *
   *  A holder binds one path and dies on a second, so a restarted app-server, which always brings
   *  up a NEW thread and therefore a new rollout, cannot be handed to the old holder: that killed
   *  the plane for the rest of the process, and a recovery mechanism that permanently disables what
   *  it recovers is worse than none, because the first crash is survivable and looks survived.
   *
   *  DRAIN THEN SWAP, the same order the OpenCode connector uses when a `/new` session replaces the
   *  one it was publishing: flush what the old thread settled, close the run it left open, wait for
   *  both to land, and only then start a new holder with its own write-ahead log keyed to the new
   *  thread. Closing first would terminate a run the flushed records still belong to.
   *
   *  `attempts` is the resolve budget. The launch spends the full one because `thread/start` writes
   *  nothing to disk and the primer inject is what materializes the file; a turn boundary spends
   *  one look, because it is a retry rather than a wait. */
  async function bindEvents(threadId: string, attempts: number): Promise<void> {
    if (!eventsArmed) return;
    if (binding) {
      missedBind = true;
      return;
    }
    binding = true;
    try {
      const path = await waitForRollout(codexHome, threadId, { attempts, intervalMs: attempts > 1 ? 250 : 0 });
      if (eventsThread !== threadId) return; // a newer thread arrived while this one waited
      if (path === undefined) {
        // THE PREDECESSOR IS STILL ENDED. Giving up on the new thread's file says nothing about the
        // old thread, which is gone: its process is dead, no record will ever be appended to it
        // again, and a run left open on the wire is a reader waiting forever for an end that cannot
        // come. So the old binding is drained and closed HERE rather than only on the happy path.
        //
        // THE CLEAR IS LOAD-BEARING FOR EVERY BOUNDARY BELOW, and that is why it is not merely
        // tidying up after the drain. A boundary asks whether ANYTHING is bound, and a retry fires
        // only when nothing is; both are correct only because a binding that no longer belongs to
        // the thread the seat is on stops existing HERE. Keep the drain and drop these two lines and
        // the plane feeds a dead thread forever while the live one publishes nothing, which is the
        // defect this whole path exists to close.
        if (events !== undefined) {
          await drainBinding();
          events = undefined;
          rollout = undefined;
        }
        // NOT terminal, and that is the fix for a one-shot bind: an armed seat whose file was slow
        // to appear would otherwise publish nothing for its whole life, with this line as the only
        // trace. The next turn boundary looks again.
        log(`AG-UI: no rollout file yet for thread ${threadId}, will look again at the next turn`);
        return;
      }
      if (rollout === path && events !== undefined) return; // already publishing this thread
      if (events !== undefined) await drainBinding();
      // CAPTURED HERE, BEFORE THE ANNOUNCEMENT, and that placement is the fix. See the seeding note
      // in `newEventHolder` for why the emitter cannot be left to position itself later.
      const startCursor = (await new JsonlFileSource<CodexRecord>(path).read(undefined)).cursor;
      events = newEventHolder(startCursor);
      rollout = path;
      events.adopt(path);
      // `adopt` starts the emitter, it does not read. Without this the first records wait for a
      // turn boundary that a seat sitting idle never reaches.
      events.flush(path);
      // SAID OUT LOUD, because it is a limit and not an implementation detail: the stream starts at
      // the boundary captured just above, the file's last COMPLETE record as of the bind and never
      // byte zero, so whatever the thread had already written before this moment is not republished. On the ordinary path that is nothing
      // (the file is created by the primer inject and bound immediately after). On a late bind it
      // is the turns that ran while the file did not exist, and a reader comparing the panel to the
      // terminal deserves to know why they differ rather than to guess.
      log(`AG-UI: publishing thread ${threadId} from ${path} (the stream starts here, anything already written is not republished)`);
    } finally {
      binding = false;
      const retry = missedBind;
      missedBind = false;
      // Two things were refused while this bind held the flag, and both are kicked from here
      // because nothing else will: a NEWER thread (a restart landed mid-bind), and a boundary that
      // arrived while this one was still looking.
      if (eventsThread !== undefined && eventsThread !== threadId) void bindEvents(eventsThread, attempts);
      else if (retry && rollout === undefined && eventsThread !== undefined) void bindEvents(eventsThread, 1);
    }
  }

  /** Ask the emitter to read what codex has appended. The rollout is written by the child, so
   *  nothing tells this process a record landed; the driver's own boundaries are the closest
   *  signal there is, and a flush is cheap and idempotent (the cursor decides what is new). */
  const flushEvents = (): void => {
    // A DEAD HOLDER IS NOT A BINDING. The holder is TERMINAL on error, and one error it can take is
    // the one that matters most here: `AguiEmitter.start` refuses an endpoint with no connection,
    // and `agent.start()` connects in the BACKGROUND, so an armed seat whose broker was not up yet
    // kills its own plane at launch. Nothing after that publishes, the mesh side recovers around it
    // and looks healthy, and one line in the seat's own log is the whole trace. Flushing a corpse is
    // silence with a heartbeat, so a death is treated as NO BINDING and the next boundary builds a
    // new one. What the dead holder had not yet published is not recovered: a fresh adopt starts at
    // the file's last complete record, which is the same stated limit a late bind carries.
    if (events?.failure !== undefined) {
      log(`AG-UI: the emitter stopped (${events.failure.message}), rebinding at this boundary`);
      events = undefined;
      rollout = undefined;
    }
    if (rollout !== undefined) {
      events?.flush(rollout);
      return;
    }
    if (eventsArmed && eventsThread !== undefined) void bindEvents(eventsThread, 1);
  };

  driver.on("turnStarted", () => {
    flushEvents();
    // Invalidate any prior turn's still-pending async boundary tail: a new turn owning presence
    // now means T(n-1)'s flush/status/pump must no longer publish a stale `idle` over this
    // `working`, nor pump this turn's batch past its backoff.
    boundaryGen++;
    void safeStatus("working");
    void steerPending(); // anything directed that landed while the turn spun up
  });
  driver.on("waiting", (detail: string) => void safeStatus("waiting", detail));
  driver.on("turnCompleted", ({ status, owned }: { status: string; owned: boolean }) => {
    flushEvents();
    feed(`— turn ${status}`);
    completeTurn(status, owned);
  });
  driver.on("itemStarted", (item: ThreadItem) => {
    if (item.type === "commandExecution" && typeof item.command === "string") {
      feed(`$ ${item.command}`);
      void safeStatus("working", item.command.slice(0, 120));
    } else if (item.type === "mcpToolCall") {
      feed(`⚒ ${item.tool ?? "?"}`);
      void safeStatus("working", String(item.tool ?? ""));
    }
  });
  driver.on("itemCompleted", (item: ThreadItem) => {
    flushEvents();
    if (item.type === "agentMessage" && item.text?.trim()) feed(`● ${item.text.trim()}`);
  });
  /** Has a restart overtaken the incarnation `gen` names? A launch/restart tail is a long chain of
   *  awaits, and at any of them its own app-server can die and the crash rail can bring up a
   *  replacement. From that moment the tail owns NOTHING: continuing would set the context id,
   *  mark ready, replace the TUI and drive on a generation it no longer speaks for, and its
   *  failure branch would `die()` — killing the very child that is replacing it. Stale tails
   *  return silently and let the live one finish the job. */
  const superseded = (gen: number): boolean => {
    // `shuttingDown` is checked separately from the driver's own terminal flag because there is a
    // window between the two: `shutdown()` sets this first and only reaches `driver.stop()` after
    // retiring the UI and interrupting the live turn. A tail resuming inside that window would
    // still see a live, current driver and carry on into a mesh that is already leaving.
    if (shuttingDown) {
      log(`app-server incarnation ${gen} stood down — a shutdown owns the rest of this process`);
      return true;
    }
    if (driver.isCurrent(gen)) return false;
    log(`app-server incarnation ${gen} was superseded — leaving the rest to the current one`);
    return true;
  };

  /** Bring the mesh side online: adopt the thread as the context id and, the first time only,
   *  connect the endpoint. Whichever incarnation gets here first completes the launch — normally
   *  the initial one, but a crash DURING the initial launch hands that job to the restart rail,
   *  whose tail would otherwise mark a never-connected agent "ready" and drive into a mesh it
   *  never joined. */
  async function comeOnline(threadId: string): Promise<void> {
    agent.setContextId(threadId);
    // Bind the thread's rollout as the event plane's durable source. `thread/start` writes
    // nothing to disk, so the file only exists once the driver's primer inject has landed; the
    // wait is bounded, and giving up is not final, because an emitter with no source publishes
    // nothing and would otherwise do so silently for the rest of the process. A RESTART ARRIVES
    // HERE TOO, with a new thread, and `bindEvents` drains the old binding rather than adopting a
    // second path into a holder that would die on it.
    if (eventsArmed) {
      eventsThread = threadId;
      void bindEvents(threadId, ROLLOUT_ATTEMPTS);
    }
    if (agentStarted) return;
    agentStarted = true;
    agent.start(); // background connect with retry
    if (driver.model) await agent.setModel(driver.model, variant).catch(() => {});
  }

  /** Fatal: no Codex behind this endpoint and no way back. Go offline and exit nonzero rather
   *  than linger "connected but dead", soaking redeliveries no turn can ever run. */
  async function die(reason: string): Promise<never> {
    log(`fatal: ${reason}`);
    await safeStatus("offline");
    // Take the app-server (and the UI) down with us. A listening app-server is NOT tied to this
    // process's lifetime the way a stdio child was — nothing closes when our pipes do — so an
    // exit that skipped this would strand an orphaned codex holding a port and this agent's
    // isolated home, once per fatal launch.
    stopTui();
    try {
      await driver.stop();
    } catch {
      /* leaving anyway */
    }
    try {
      await mcp.close();
    } catch {
      /* leaving anyway */
    }
    try {
      await agent.stop();
    } catch {
      /* leaving anyway */
    }
    process.exit(1);
  }

  // App-server crash recovery. The manager RETIRES a lifecycle when its process exits
  // (freeSlot → deprovision); it never restarts one, and a later same-name spawn is a successor
  // with its own delivery frontier. So exiting here would strand the un-acked in-flight batch.
  // The host owns the child, so it restarts the CHILD instead: the mesh endpoint stays connected
  // on the SAME lifecycle, credential, and durable, the batch's ids are still un-acked in this
  // agent's inbox, and clearing `surfaced` (never acking it) is what makes them re-drive into the
  // new thread. Bounded — a crash LOOP is fatal, never an endless silent respawn.
  let restartAt: number[] = [];
  driver.on("closed", (code: number) => {
    // During a cooperative shutdown the child's death is EXPECTED — `shutdown()` killed it — and
    // that single promise owns the rest: offline presence, the clean mesh leave, then exit.
    // Exiting here instead would win the race against its own `driver.stop()` and terminate
    // before the endpoint ever departed, which is exactly what the control-socket path exists
    // to prevent.
    // A DELIBERATE teardown owns the rest of this process's life: `shuttingDown` for a
    // cooperative stop, and `driver.stopped` for a fatal or a failed startup, where the child's
    // death is our own SIGTERM coming back. Recovering from either would spawn a REPLACEMENT
    // app-server while the caller is exiting, and that listening child would outlive us.
    if (shuttingDown || driver.stopped) return;
    // FIRST, synchronously: the UI was attached to a listener that no longer exists, so its own
    // exit is imminent and is NOT an operator quit. Retiring it here (rather than after the
    // replacement is up) is what stops that exit from racing recovery into a full shutdown and
    // destroying the very lifecycle this handler exists to preserve.
    stopTui();
    ready = false;
    driving = false;
    awaitingTurnEnd = false;
    surfaced = []; // deliberately NOT acked — these ids re-drive on the new thread
    boundaryGen++; // the dead turn's async tail must not drive or re-present the new one
    clearErrorRetry(true);
    const now = Date.now();
    restartAt = restartAt.filter((t) => now - t < RESTART_WINDOW_MS);
    restartAt.push(now);
    if (restartAt.length > MAX_RESTARTS) {
      void die(`app-server exited (${code}) — ${restartAt.length} crashes in ${RESTART_WINDOW_MS / 1000}s`);
      return;
    }
    log(`app-server exited (${code}) — restarting it (${restartAt.length}/${MAX_RESTARTS})`);
    void safeStatus("waiting", "restarting codex");
    void (async () => {
      // This replacement's own incarnation id. Every await below is a point where IT can die and
      // a further restart can overtake this tail; from there on nothing here may touch host state
      // or tear anything down, or it would act on — and `die()` over — its own successor.
      const launch = driver.start();
      const gen = driver.gen;
      let tid: string;
      try {
        tid = await launch;
      } catch (e) {
        if (superseded(gen)) return;
        // A respawn that never comes up is terminal (a crashed child re-emits `closed` and is
        // handled above; this path is a spawn/handshake failure with no retry left in it).
        await die(`app-server restart failed: ${(e as Error).message}`);
        return;
      }
      try {
        await driver.awaitMcpReady(MCP_SERVER_NAME, gen);
      } catch (e) {
        if (superseded(gen)) return;
        // A restarted app-server that cannot reach the tools is no better than one that never
        // started: it would run tool-less turns on a peer the roster believes is healthy.
        await die(`app-server restarted without the cotal tools: ${(e as Error).message}`);
        return;
      }
      // A crash DURING the initial launch lands here with the mesh side never brought up at all
      // (the launch tail died before `agent.start()`), so this is also the completion path for it.
      await comeOnline(tid);
      if (superseded(gen)) return;
      // A restarted thread is a NEW Codex context: it never saw the channel briefing.
      briefed = false;
      ready = true;
      log(`app-server restarted — thread ${tid}`);
      // The old UI was retired synchronously above; bring one up on the new listener.
      startTui();
      await safeStatus("idle");
      if (superseded(gen)) return;
      // Unconditional re-drive: the crashed turn's ids were never acked, so they are still in the
      // inbox — `drive()` picks them up (and no-ops when the inbox is genuinely empty).
      if (pendingPullHint) void drive(pendingPullHint);
      else void drive();
    })();
  });
  driver.on("error", (e: Error) => log(`app-server error: ${e.message}`));

  // Inbound mesh traffic. Busy: steer directed items into the live turn, buffer ambient. Idle: a
  // directed message always drives; ambient drives only in `open` (dnd/focus hold it for the next
  // boundary). Receive-time pull-only never reaches "incoming" as automatic; `muted` never at all.
  agent.on("incoming", (item: InboxItem) => {
    const automatic = agent.inboxScope(item.id) === "automatic";
    if (!automatic) return;
    const directed = item.kind !== "channel" || item.mentionsMe;
    if (driver.busy || awaitingTurnEnd) {
      if (directed) void steerPending();
      return;
    }
    if (directed || agent.attention === "open") void drive();
  });
  agent.on("mention-wake", (item: InboxItem) => {
    // Focus: the @mention body was acked-and-dropped at ingest — wake a turn to PULL it. The
    // event is one-shot and contributes nothing to pendingWake(), so mid-turn it must be
    // LATCHED: steer it into the live turn if possible, and keep the latch until some turn
    // actually carried it (completeTurn consumes the latch at the boundary).
    const hint = `📨 You were mentioned by ${fmtFrom(item)} on #${item.channel ?? "?"} — read it with cotal_inbox.`;
    pendingPullHint = hint; // latched until a turn ACCEPTS it (steer accept / startTurn success)
    if (driver.busy || awaitingTurnEnd) {
      // Ride the SAME settlement rail as batch steers, so a turn boundary racing this steer
      // waits for its outcome before deciding anything — an accept means the live turn saw the
      // hint (accept happened-before the terminal on the wire), so the latch clears.
      const rpc = driver.steer(hint);
      steerSettled = rpc.catch(() => false);
      void rpc.then((accepted) => {
        if (accepted && pendingPullHint === hint) pendingPullHint = undefined;
      });
    } else {
      void drive(hint);
    }
  });
  agent.on("wake", () => {
    if (!driver.busy) void drive();
  });

  // ---- the Codex TUI -------------------------------------------------------
  // `cotal spawn --agent codex` opens Codex's own TUI, attached to the very thread this host
  // drives (see tui.ts), so mesh turns render as they happen and anything typed is a real user
  // turn on the same thread. Detached, the manager's pty is that terminal, which is exactly what
  // `cotal attach` streams.
  //
  // It needs a terminal to own. With a piped stdout (a container, `deploy/`, a smoke) there is
  // none, so the host stays headless and keeps its line feed instead — the same peer either way,
  // only the UI differs. COTAL_CODEX_TUI decides explicitly when set (1/0), for callers that know
  // better than the tty check.
  const tuiPref = process.env.COTAL_CODEX_TUI?.trim();
  const wantTui = tuiPref ? /^(1|true|yes|on)$/i.test(tuiPref) : process.stdout.isTTY === true;
  let tuiChild: ChildProcess | undefined;
  let tuiGen = 0; // bumped whenever an exit becomes EXPECTED (restart or shutdown)

  function stopTui(): void {
    const child = tuiChild;
    tuiChild = undefined;
    if (!child) return;
    tuiGen++;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }

  /** Attach the TUI to the current app-server + thread. Re-callable: an app-server restart is a
   *  new listener, a new token, and a new thread, so the old UI is replaced rather than left
   *  pointing at a dead endpoint. */
  function startTui(): void {
    if (!wantTui || shuttingDown) return;
    const remote = driver.remote;
    const threadId = driver.thread;
    if (!remote || !threadId) return;
    // From here the terminal belongs to Codex: move our own output off it before it paints. Say
    // WHERE it went while stderr is still the terminal — everything after this point (an
    // app-server restart, a fatal, a UI that never launched) lands in that file, and a path nobody
    // was told about is a path nobody finds. Codex paints on the alternate screen, so this line is
    // on screen until it starts and back again the moment it exits.
    const logPath = join(codexHome, "host.log");
    if (!logSink) {
      process.stderr.write(`[cotal-codex] handing the terminal to Codex — host log continues in ${logPath}\n`);
      logSink = createWriteStream(logPath, { flags: "a" });
      feedEnabled = false;
      log(`codex TUI attached to ${remote.url} thread ${threadId}`);
    }
    const gen = ++tuiGen;
    const child = launchTui({ url: remote.url, token: remote.token, threadId, codexHome, cwd: process.cwd(), bin: codexBin });
    tuiChild = child;
    child.on("error", (e: Error) => tellOperator(`codex TUI failed to launch: ${e.message} (host log: ${logPath})`));
    child.on("exit", (code) => {
      if (gen !== tuiGen) return; // superseded: a restart or shutdown already owns this exit
      tuiChild = undefined;
      // Quitting the UI ends the session, matching every other connector: the pty's process
      // exiting is what retires the agent. Leave the mesh cleanly rather than lingering headless.
      //
      // But a UI that CRASHED is not someone quitting, and reporting it as a clean retirement is
      // how an operator ends up back at a shell prompt concluding they must have hit the wrong
      // key. Say so on the terminal (the TUI is gone, so it is ours again), and carry the failure
      // out in the exit code rather than exiting 0 over a crash.
      if (code === 0) {
        log(`codex TUI exited (0) — leaving the mesh`);
        void shutdown();
        return;
      }
      tellOperator(`codex TUI exited unexpectedly (${code}) — leaving the mesh; details in ${logPath}`);
      void shutdown(1);
    });
  }

  // Cooperative shutdown: the manager's authed {op:"shutdown"} on a signal-less runtime, plus
  // SIGINT/SIGTERM. Interrupt the live turn, leave the mesh cleanly, then exit. The interrupted
  // batch stays un-acked in the stream — but this is a RETIREMENT, not a restart: the manager
  // frees the slot and deprovisions, and a later same-name spawn is a successor with its own
  // delivery frontier, so redelivery to it is NOT promised. (Unlike the in-place app-server
  // restart above, which keeps the lifecycle and really does re-drive the batch.)
  /** `code` carries out what actually happened: 0 for a retirement someone asked for, nonzero when
   *  the session is ending because something broke (a crashed UI), so the manager and the operator
   *  see a failure rather than a clean goodbye. */
  const shutdown = async (code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // A clean leave is best-effort, not unbounded. Once the child is stopped this process has no
    // reason to exist, and the departure can hang forever on an unreachable broker (the endpoint
    // retries) — a peer that never exits just waits for the manager to SIGKILL it, and the mesh
    // sees the same missing departure with extra delay. Try, then leave regardless.
    const forced = setTimeout(() => {
      log(`clean mesh leave did not finish in ${SHUTDOWN_GRACE_MS}ms — exiting anyway`);
      process.exit(code);
    }, SHUTDOWN_GRACE_MS);
    forced.unref?.();
    clearErrorRetry();
    try {
      controlServer?.close();
      stopTui(); // the UI goes with the session it was attached to
    } catch {
      /* ignore */
    }
    try {
      await driver.interrupt();
      await driver.stop();
    } catch {
      /* ignore */
    }
    // THE PLANE IS DRAINED ON THE WAY OUT, and the order is the whole content of it. `interrupt()`
    // returns when the RPC is acknowledged, NOT when codex has written `turn_aborted` to the
    // rollout, so the flush may still not see the record that ends the turn; `closeRun` is the
    // backstop for exactly that run. Without both, a mid-turn exit publishes `RUN_STARTED` and
    // nothing else, and an observer holds a run that never ends, because the next process is a new
    // thread with a new write-ahead log and no one ever reads those bytes again.
    //
    // This connector has no per-turn `closeRun`, and that is not an omission: on Claude and
    // OpenCode the record stream never says the turn ended so the harness must close the run,
    // while a Codex `task_complete` IS the terminal and the mapper closes from it. Shutdown is the
    // one boundary the records cannot describe.
    try {
      flushEvents();
      events?.closeRun(Date.now());
      await events?.settled();
    } catch {
      /* leaving anyway: the forced-exit timer above still owns the deadline */
    }
    try {
      await mcp.close(); // the tools existed only for the codex we just stopped
    } catch {
      /* ignore */
    }
    try {
      await safeStatus("offline");
      await agent.stop();
    } finally {
      clearTimeout(forced);
      process.exit(code);
    }
  };
  let controlServer: ReturnType<typeof startControlServer> | undefined;
  const controlPath = process.env.COTAL_CONTROL_SOCKET?.trim();
  const controlToken = process.env.COTAL_CONTROL_TOKEN?.trim();
  if (controlPath && controlToken) {
    controlServer = startControlServer(
      agent,
      { path: controlPath, token: controlToken },
      async () => ({ ok: false, error: "codex runs cotal in-process; only the shutdown control op is supported" }),
      { fatalBind: true, onShutdown: () => void shutdown() },
    );
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // PATH preflight (parity with the manager's `requires` check, for a foreground `--live-only`
  // launch that bypasses it): fail with a clear message naming the binary rather than a raw
  // ENOENT from the spawn. An absolute COTAL_CODEX_BIN override (tests) skips the PATH scan.
  const bin = process.env.COTAL_CODEX_BIN?.trim() || "codex";
  if (!bin.includes(sep) && !onPath(bin)) {
    await mcp.close();
    throw new Error(`the codex connector needs \`${bin}\` on PATH — install the Codex CLI and authenticate it`);
  }

  // From here on TWO things outlive a thrown error unless we take them down: the MCP endpoint
  // this process is serving, and (once started) the app-server — a LISTENING server, not a stdio
  // child that dies with our pipes. A refused launch (the auth check below is the common one)
  // would otherwise leave an orphaned codex holding a port and this agent's isolated home.
  // This launch's incarnation id, captured before the first await so the failure path below has
  // it too: a child that dies mid-launch hands recovery to the crash rail, and from that moment
  // the teardown in the catch would be tearing down the REPLACEMENT.
  let gen = -1;
  try {
    const launch = driver.start();
    gen = driver.gen;
    const threadId = await launch;
    // Auth honesty: `thread/start` succeeds even UNAUTHENTICATED (Codex builds the session
    // locally), so without this probe the peer would advertise online, soak deliveries, and only
    // fail on its first model turn. A definitive "no credentials" is fatal NOW, before presence.
    // A probe the running codex can't answer is logged, not fatal — codex stays the auth
    // authority and its first turn surfaces the error instead.
    try {
      const acct = await driver.readAccount();
      if (acct.requiresOpenaiAuth !== false && !acct.account && !process.env.OPENAI_API_KEY)
        throw new Error(
          "codex reports no credentials (account/read: none) and OPENAI_API_KEY is not set — " +
            "run `codex login` (file-backed store) or provide OPENAI_API_KEY; refusing to join the mesh unauthenticated",
        );
    } catch (e) {
      if ((e as Error).message.includes("no credentials")) throw e;
      log(`auth probe unavailable (${(e as Error).message}) — auth errors will surface on the first turn`);
    }
    // The cotal_* tools must actually be REACHABLE before this peer claims to be online. codex
    // treats an MCP server it cannot reach as a warning and runs on without it, which here would
    // mean a peer that soaks deliveries and answers none of them. Fatal instead.
    await driver.awaitMcpReady(MCP_SERVER_NAME, gen);
    // NOW connect the endpoint — thread is up, tools are live, and auth is validated, so the
    // FIRST presence this peer ever publishes is a truthful "ready". A fatal failure above exits
    // before this line, so the roster never sees a false-ready peer.
    await comeOnline(threadId);
    if (superseded(gen)) return;
    ready = true;
    await safeStatus("idle");
    if (superseded(gen)) return;
    log(`ready — space="${config.space}" name="${config.name}"${config.role ? ` role="${config.role}"` : ""}`);
    // Hand the terminal to Codex. Everything above this line still reports to stderr, so a launch
    // that fails (missing binary, no credentials, a broker refusal) says why on the terminal
    // instead of into a log file nobody knows to read.
    startTui();

    // An auto-submitted first prompt (`cotal spawn --prompt`), then anything buffered during boot.
    const prompt = process.env.COTAL_CODEX_PROMPT?.trim();
    if (prompt) await drive(prompt);
    else if (agent.pendingWake() > 0) void drive();
  } catch (e) {
    // A crash mid-launch is the crash rail's to recover, and it has already started a
    // replacement. Tearing down here would kill it and close the MCP endpoint out from under it.
    if (gen >= 0 && superseded(gen)) {
      log(`initial launch did not finish (${(e as Error).message}) — the restart is completing it`);
      return;
    }
    stopTui();
    await driver.stop().catch(() => {});
    await mcp.close().catch(() => {});
    throw e;
  }
}
