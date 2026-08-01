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
  transcriptChannel,
  ORIENTATION_BOOTSTRAP,
  MESH_FIRST_STEER,
  type InboxItem,
} from "@cotal-ai/connector-core";
import { AppServerDriver, type ThreadItem } from "./app-server.js";
import { startCotalMcp, MCP_SERVER_NAME, MCP_TOKEN_ENV, type CotalMcpEndpoint } from "./mcp.js";
import { createTranscriptMirror } from "./transcript.js";
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

/** The headless activity feed: one line per event, for a host with no TUI (a piped stdout — a
 *  container, `deploy/`, or a smoke). With the TUI attached the feed is redundant, because Codex
 *  renders the same events itself, so it is suppressed rather than interleaved into its output. */
let feedEnabled = true;
function feed(line: string): void {
  if (feedEnabled) process.stdout.write(`${line}\n`);
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
  if (!has("sandbox_mode")) overrides.push(["sandbox_mode", '"workspace-write"']);
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

  // Transcript mirror → `tr-<name>`, opt-in via COTAL_TRANSCRIPT (the connector sets it for
  // `--transcript` spawns; the manager grants pub rights on the same channel).
  const transcript = /^(1|true|yes|on)$/i.test(process.env.COTAL_TRANSCRIPT ?? "")
    ? createTranscriptMirror(agent, transcriptChannel(config.name))
    : undefined;

  // ---- the turn loop -------------------------------------------------------
  let ready = false; // thread up — never drive before then
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
        if (transcript) await transcript.flush().catch((e) => log(`transcript publish failed: ${(e as Error).message}`));
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

  driver.on("turnStarted", () => {
    // Invalidate any prior turn's still-pending async boundary tail: a new turn owning presence
    // now means T(n-1)'s flush/status/pump must no longer publish a stale `idle` over this
    // `working`, nor pump this turn's batch past its backoff.
    boundaryGen++;
    void safeStatus("working");
    void steerPending(); // anything directed that landed while the turn spun up
  });
  driver.on("waiting", (detail: string) => void safeStatus("waiting", detail));
  driver.on("turnCompleted", ({ status, owned }: { status: string; owned: boolean }) => {
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
    if (item.type === "agentMessage" && item.text?.trim()) feed(`● ${item.text.trim()}`);
    transcript?.observe(item);
  });
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
      let tid: string;
      try {
        tid = await driver.start();
      } catch (e) {
        // A respawn that never comes up is terminal (a crashed child re-emits `closed` and is
        // handled above; this path is a spawn/handshake failure with no retry left in it).
        await die(`app-server restart failed: ${(e as Error).message}`);
        return;
      }
      try {
        await driver.awaitMcpReady(MCP_SERVER_NAME);
      } catch (e) {
        // A restarted app-server that cannot reach the tools is no better than one that never
        // started: it would run tool-less turns on a peer the roster believes is healthy.
        await die(`app-server restarted without the cotal tools: ${(e as Error).message}`);
        return;
      }
      agent.setContextId(tid);
      // A restarted thread is a NEW Codex context: it never saw the channel briefing, and the
      // dead thread's partial transcript must not merge into its first flush.
      briefed = false;
      await transcript?.flush().catch(() => {});
      ready = true;
      log(`app-server restarted — thread ${tid}`);
      // The old UI was retired synchronously above; bring one up on the new listener.
      startTui();
      await safeStatus("idle");
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
  // `cotal spawn --agent codex` puts you in Codex proper rather than a log tail: the real TUI
  // attaches to the very thread this host drives (see tui.ts), so mesh turns render as they
  // happen and anything typed is a real user turn on the same thread. Detached, the manager's pty
  // is that terminal, which is exactly what `cotal attach` streams.
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
    // From here the terminal belongs to Codex: move our own output off it before it paints.
    if (!logSink) {
      logSink = createWriteStream(join(codexHome, "host.log"), { flags: "a" });
      feedEnabled = false;
      log(`codex TUI attached to ${remote.url} thread ${threadId} — host log continues here`);
    }
    const gen = ++tuiGen;
    const child = launchTui({ url: remote.url, token: remote.token, threadId, codexHome, cwd: process.cwd(), bin: codexBin });
    tuiChild = child;
    child.on("error", (e: Error) => log(`codex TUI failed to launch: ${e.message}`));
    child.on("exit", (code) => {
      if (gen !== tuiGen) return; // superseded: a restart or shutdown already owns this exit
      tuiChild = undefined;
      // Quitting the UI ends the session, matching every other connector: the pty's process
      // exiting is what retires the agent. Leave the mesh cleanly rather than lingering headless.
      log(`codex TUI exited (${code}) — leaving the mesh`);
      void shutdown();
    });
  }

  // Cooperative shutdown: the manager's authed {op:"shutdown"} on a signal-less runtime, plus
  // SIGINT/SIGTERM. Interrupt the live turn, leave the mesh cleanly, then exit. The interrupted
  // batch stays un-acked in the stream — but this is a RETIREMENT, not a restart: the manager
  // frees the slot and deprovisions, and a later same-name spawn is a successor with its own
  // delivery frontier, so redelivery to it is NOT promised. (Unlike the in-place app-server
  // restart above, which keeps the lifecycle and really does re-drive the batch.)
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // A clean leave is best-effort, not unbounded. Once the child is stopped this process has no
    // reason to exist, and the departure can hang forever on an unreachable broker (the endpoint
    // retries) — a peer that never exits just waits for the manager to SIGKILL it, and the mesh
    // sees the same missing departure with extra delay. Try, then leave regardless.
    const forced = setTimeout(() => {
      log(`clean mesh leave did not finish in ${SHUTDOWN_GRACE_MS}ms — exiting anyway`);
      process.exit(0);
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
      process.exit(0);
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
  try {
    const threadId = await driver.start();
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
    await driver.awaitMcpReady(MCP_SERVER_NAME);
    // NOW connect the endpoint — thread is up, tools are live, and auth is validated, so the
    // FIRST presence this peer ever publishes is a truthful "ready". A fatal failure above exits
    // before this line, so the roster never sees a false-ready peer.
    agent.setContextId(threadId);
    agent.start(); // background connect with retry
    if (driver.model) await agent.setModel(driver.model, variant).catch(() => {});
    ready = true;
    await safeStatus("idle");
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
    stopTui();
    await driver.stop().catch(() => {});
    await mcp.close().catch(() => {});
    throw e;
  }
}
