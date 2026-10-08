/**
 * The Cotal OpenCode plugin, OpenCode 2.x adapter. Loaded from the same bundle directory as the
 * 1.x factory (`plugin.ts`) — `plugin.entry.ts`'s default export carries both `server` (1.x) and
 * `setup` (this module's `setupCotal`, 2.x); the 2.x loader calls `setup(context)` only, never
 * `server`. See `fx105/measurements.md` for the measured 2.x plugin context, routes and events this
 * adapter is built against.
 *
 * The smallest port that joins, checks the model, creates ONE session, drives turns into it over
 * the authenticated HTTP API (`/api/session/:id/prompt` — 2.x has no `prompt_async`), registers the
 * cotal_* tools and maps the event stream to presence (M3c). Reuses `plugin.ts`'s exported seams
 * (env config, `MeshAgent` construction, `modelRefusalSentence`, `computeInjection`,
 * `settleWithin`) rather than duplicating them; the model check and session/turn routes are 2.x's
 * own (`/api/model`, `/api/session`, `/api/session/:id/prompt`), measured separately because the
 * 2.x response shapes differ from 1.x's (`{data:...}` wrapping, no `prompt_async`).
 */
import { loadAgentFile, type PresenceStatus } from "@cotal-ai/core";
import {
  configFromEnv,
  envFlag,
  hasIdentity,
  MeshAgent,
  formatInjection,
  scrubLaunchMaterial,
  ORIENTATION_BOOTSTRAP,
  MESH_FIRST_STEER,
  WORKFLOW_STEER,
} from "@cotal-ai/connector-core";
import { modelRefusalSentence, computeInjection, settleWithin } from "./plugin.js";
import type { OpenCode2Context } from "./opencode2-types.js";
import { buildCotalTools2 } from "./tools.js";

function log(msg: string): void {
  process.stderr.write(`[cotal-connector] ${msg}\n`);
}

/** Process-global guard, mirroring `plugin.ts`'s `guard.__cotalOpencodeHooks`: 2.x may call
 *  `setup` more than once per process (per location boot), and we want exactly one mesh agent. */
const guard = globalThis as { __cotalOpencodeSetup?: boolean };

/** The 2.x `/api/session/:id/message` shape is `{data:[{type, text|content, model, agent}]}` and
 *  the `content` element shape was not measured, so `agui-source.ts` cannot read it truthfully —
 *  maintainer's call (fx105/brief.md M3). Refusing loud beats shipping an AG-UI plane that lies. */
const EVENTS_REFUSAL =
  "opencode connector: the AG-UI event plane is not carried on OpenCode 2.x yet; spawn with --no-events";

/** 2.x model check: `GET /api/model` lists the configured model directly (no `/provider.all`
 *  nesting to walk, unlike 1.x's `verifyServerModel`). Same refusal sentence shape, different
 *  route and body — measured in fx105/measurements.md (routes). The server answers `/api/model`
 *  with an empty listing for up to about a second after the location boot its first `/api/config`
 *  triggers (fx105/brief-g.md measurement), so an empty listing is polled every 200 ms until the
 *  provider appears rather than refused on the first read. The wait is bounded: a server that
 *  never lists anything within the deadline is a real refusal, not a hang. */
export const MODEL_LIST_SETTLE_MS = 10_000;

async function verifyServerModel2(
  serverUrl: string,
  serverAuth: string,
  selectedModel: string,
  settleMs = MODEL_LIST_SETTLE_MS,
): Promise<void> {
  const slash = selectedModel.indexOf("/");
  const provider = selectedModel.slice(0, slash);
  const model = selectedModel.slice(slash + 1);
  const deadline = Date.now() + settleMs;
  for (;;) {
    const response = await fetch(`${serverUrl}/api/model`, {
      headers: { authorization: serverAuth },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(`opencode connector: server /api/model returned HTTP ${response.status} while checking model ${selectedModel}`);
    const listing = (await response.json()) as { data?: Array<{ providerID?: string; modelID?: string }> };
    if (slash < 1 || !model) throw new Error(modelRefusalSentence(selectedModel, "GET /api/model does not list it"));
    const data = listing.data ?? [];
    if (data.some((m) => m.providerID === provider && m.modelID === model)) return;
    if (data.some((m) => m.providerID === provider))
      throw new Error(modelRefusalSentence(selectedModel, "GET /api/model does not list it"));
    if (Date.now() >= deadline)
      throw new Error(modelRefusalSentence(selectedModel, `GET /api/model listed no provider within ${settleMs / 1000} s`));
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** How long the detached event loop's in-flight iteration may be waited on at teardown before it
 *  is abandoned out loud — the same bounded-settle shape `plugin.ts`'s `quiesce` uses, via its
 *  exported `settleWithin`, rather than a second copy of the tradeoff (see that file's note). */
const EVENT_QUIESCE_MS = 10_000;

/** The 2.x `setup(context)` entry point. */
export async function setupCotal(ctx: OpenCode2Context): Promise<(() => Promise<void>) | void> {
  if (!hasIdentity()) return; // no COTAL_* env — a plain `opencode`, stay inert (same rule as 1.x)
  if (guard.__cotalOpencodeSetup) return; // one agent; a later boot in this process is a no-op
  guard.__cotalOpencodeSetup = true;

  if (envFlag(process.env, "COTAL_EVENTS")) {
    log(EVENTS_REFUSAL);
    process.exit(1);
  }

  const config = configFromEnv();
  // Both readers of the launch material have now read it (the same rule as 1.x — see plugin.ts).
  scrubLaunchMaterial();
  config.connector = "opencode";
  const serverUrl = process.env.COTAL_OPENCODE_SERVER_URL?.trim();
  const serverUsername = process.env.OPENCODE_SERVER_USERNAME?.trim() || "opencode";
  const serverPassword = process.env.OPENCODE_SERVER_PASSWORD?.trim();
  if (!serverUrl || !serverPassword) throw new Error("opencode connector: missing COTAL_OPENCODE_SERVER_URL/OPENCODE_SERVER_PASSWORD");
  const serverAuth = `Basic ${Buffer.from(`${serverUsername}:${serverPassword}`).toString("base64")}`;

  const selectedModel = process.env.COTAL_MODEL?.trim();
  const settleOverride = Number(process.env.COTAL_MODEL_LIST_SETTLE_MS);
  const settleMs = Number.isFinite(settleOverride) && settleOverride > 0 ? settleOverride : MODEL_LIST_SETTLE_MS;
  const modelReady = (async () => {
    if (!selectedModel) return;
    await verifyServerModel2(serverUrl, serverAuth, selectedModel, settleMs);
  })();

  const agent = new MeshAgent(config);
  // Same non-blocking shape as plugin.ts: awaiting the model check INSIDE setup would deadlock the
  // server if setup is running while answering the very request the check's fetch targets. Refuse
  // loud and exit rather than wait forever or join with an unverified model.
  void modelReady.then(
    () => agent.start(),
    (error: Error) => {
      log(error.message);
      process.exit(1);
    },
  );

  async function opencodeApi<T>(path: string, init?: RequestInit, timeoutMs = 10_000): Promise<T> {
    const res = await fetch(`${serverUrl}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
      headers: { authorization: serverAuth, "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`OpenCode HTTP ${res.status} ${res.statusText} for ${path}`);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  const def = process.env.COTAL_AGENT_FILE?.trim() ? loadAgentFile(process.env.COTAL_AGENT_FILE.trim()) : undefined;
  const persona = def?.persona || undefined;

  // The operator's --prompt (`buildLaunch` in extension.ts), held until the boot task below opens
  // the gate. `bootPending` mirrors plugin.ts's own predicate: the text outlives a failed attempt,
  // only `drive` clears it, and only once the submission has landed.
  let bootPrompt = process.env.COTAL_OPENCODE_PROMPT?.trim() || undefined;
  let bootReady = false;
  const bootPending = (): boolean => bootReady && bootPrompt !== undefined;

  let sessionID: string | undefined;
  let busy = false; // a turn is running → don't submit another (2.x coalesces natively submitted ones)
  let primed = false; // persona goes out as `system` on the first connector-submitted turn, once
  let briefed = false; // channel briefing goes out once, same rule as 1.x
  let surfaced: string[] = []; // receive keys surfaced into the current turn, acked on completion

  /** Create the session this agent owns and announce its id to the serve shim, exactly as
   *  plugin.ts's `sessionReady` does (the shim scans stderr for this exact line to find which
   *  session to open). 2.x wraps the response in `{data:...}` (measured), unlike 1.x's bare
   *  `{id:...}`. */
  const sessionReady: Promise<string | undefined> = (async () => {
    try {
      await modelReady;
      const res = await opencodeApi<{ data?: { id?: string } }>(
        "/api/session",
        { method: "POST", body: JSON.stringify({ title: `cotal:${config.space}:${config.name}` }) },
        10_000,
      );
      const id = res.data?.id;
      if (id) {
        sessionID = id;
        agent.setContextId(id);
        process.stderr.write(`[cotal-session] ${id}\n`);
      } else log("session.create returned no id");
    } catch (e) {
      log(`session.create failed: ${(e as Error).message}`);
    }
    return sessionID;
  })();

  async function ensureSession(): Promise<string | undefined> {
    return sessionID ?? (await sessionReady);
  }

  /** Make `ids` the surfaced batch, held in flight so the agent keeps the deliveries owned until the
   *  turn ends (mirrors `plugin.ts`'s `surface`). */
  function surface(ids: string[]): boolean {
    if (!agent.holdInFlight(ids)) return false;
    agent.releaseInFlight(surfaced);
    surfaced = ids;
    return true;
  }

  /** Ack exactly the surfaced deliveries by their receive keys (mirrors `plugin.ts`'s
   *  `ackSurfaced`). */
  function ackSurfaced(): void {
    if (surfaced.length === 0) return;
    agent.drainInboxDeliveries(surfaced);
    abandonSurfaced();
  }

  function abandonSurfaced(): void {
    agent.releaseInFlight(surfaced);
    surfaced = [];
  }

  const safeStatus = async (status: PresenceStatus, activity?: string): Promise<void> => {
    try {
      if (agent.connected) await agent.setStatus(status, activity);
    } catch {
      /* presence is best-effort — never throw into opencode, same rule as plugin.ts's safeStatus */
    }
  };

  /** Drive a turn carrying the current inbox batch into the owned session, via
   *  `POST /api/session/:id/prompt` (2.x has no `prompt_async` — measured 404). Never prompts into
   *  a running turn (busy), matching 1.x's coalesce-avoidance. `override` is a bare nudge body (a
   *  focus @mention pull); it surfaces nothing to ack. */
  async function drive(override?: string): Promise<void> {
    if (busy) return;
    const id = await ensureSession();
    if (!id) return; // no visible session yet — the boot task above retries via sessionReady
    if (busy) return; // rechecked after the await, same reason as plugin.ts's `drive`
    // The floor: while boot text exists and its gate is closed, nothing else goes out (the 1.x
    // boot floor in `drive` without the `pendingWake` slot, which 2.x does not have).
    const boot = bootPending() ? bootPrompt : undefined;
    if (bootPrompt !== undefined && boot === undefined) return;
    const parts: string[] = [];
    let ids: string[] = [];
    let turnIds: string[] = [];
    const turnPeek = agent.peekPendingTurns();
    if (boot !== undefined) {
      parts.push(boot);
    } else if (override !== undefined) {
      parts.push(override);
    } else {
      const items = agent.peekInbox("automatic");
      if (items.length === 0 && !turnPeek) return;
      if (items.length > 0) {
        ids = items.map((i) => i.recvKey);
        const inj = formatInjection(items);
        if (inj) parts.push(inj);
      }
    }
    if (turnPeek) {
      turnIds = turnPeek.goalIds;
      parts.push(turnPeek.text);
    }
    const brief = briefed ? undefined : agent.channelBriefing();
    if (brief) parts.unshift(brief);
    if (parts.length === 0) return;
    const text = parts.join("\n\n");
    const system = !primed && persona ? `${persona}\n\n${ORIENTATION_BOOTSTRAP}\n\n${MESH_FIRST_STEER}\n\n${WORKFLOW_STEER}` : undefined;
    if (!surface(ids)) return; // at the in-flight ceiling: the batch stays queued for a later turn
    busy = true;
    briefed = true;
    try {
      await opencodeApi(
        `/api/session/${encodeURIComponent(id)}/prompt`,
        { method: "POST", body: JSON.stringify({ text, ...(system ? { system } : {}) }) },
        10_000,
      );
      if (turnIds.length) agent.commitSurfacedTurns(turnIds);
      if (system) primed = true;
      if (boot !== undefined) bootPrompt = undefined;
    } catch (e) {
      busy = false;
      abandonSurfaced();
      log(`drive failed: ${(e as Error).message}`);
    }
  }

  // Inbound mesh → drive (never interrupt a running turn). Mirrors plugin.ts's `agent.on`
  // wiring, trimmed to this adapter's simpler single-session, no-swap scope (M3c's event stream
  // is what actually clears `busy`; these wakes only ask "is there anything to submit now").
  agent.on("incoming", (item: { kind: string; mentionsMe?: boolean; recvKey: string }) => {
    if (busy) return;
    const automatic = agent.inboxScope(item.recvKey) === "automatic";
    const directed = item.kind !== "channel" || item.mentionsMe;
    if (automatic && (directed || agent.attention === "open")) void drive();
  });
  agent.on("mention-wake", () => {
    void drive("📨 You were mentioned — read it with cotal_inbox.");
  });
  agent.on("wake", () => {
    if (!busy) void drive();
  });

  // `e.prompt` is `DeepMutable` (measured) — mutate the text part directly, same composition as
  // 1.x's `injectIntoPrompt`, via the shared `computeInjection` seam so the two callers can't drift.
  await ctx.session.hook("prompt", (e) => {
    if (sessionID && e.sessionID !== sessionID) return;
    const computed = computeInjection(agent);
    if (!computed || !surface(computed.surfacedIds)) return;
    e.prompt.text = `${computed.prefix}\n\n${e.prompt.text}`;
    if (computed.turnIds.length) agent.commitSurfacedTurns(computed.turnIds);
  });

  // Measured: `model.request` fires `{model:{id,providerID}, kind:"primary"|"title", agent}` with
  // no `sessionID` field, so there is nothing to scope an `ours()` check against — this adapter
  // drives exactly one session, so every `primary` request is ours by construction.
  await ctx.session.hook("model.request", (e) => {
    if (e.kind !== "primary") return;
    void agent.setModel(`${e.model.providerID}/${e.model.id}`);
  });

  // Surface the running tool as presence activity — parity with 1.x's `tool.execute.before`.
  await ctx.tool.hook("execute.before", (e) => {
    if (sessionID && e.sessionID !== sessionID) return;
    void safeStatus("working", e.tool);
  });

  // Register the shared cotal_* tools, rendered by `buildCotalTools2` from the SAME specs
  // `buildCotalTools` renders for 1.x (`./tools.ts`).
  await ctx.tool.transform((ed) => {
    for (const t of buildCotalTools2(agent, config)) ed.add(t);
  });

  // The event stream — a detached loop, never awaited here (setup must return). Maps the measured
  // event names (fx105/measurements.md) to presence and turn-end/ack the same way plugin.ts's own
  // event switch does, trimmed to this adapter's single-session scope (no swap, no `/new` reset).
  const controller = new AbortController();
  const eventLoop = (async () => {
    try {
      for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
        const data = ev.data ?? {};
        switch (ev.type) {
          case "session.created": {
            // Adopt the first session id we see if none is set yet (mirrors `ours()` in plugin.ts);
            // this adapter owns exactly one top-level session, created above, so there is normally
            // nothing to adopt here — this only covers a session created before ours resolved.
            if (data.parentID) break;
            const id = data.sessionID as string | undefined;
            if (id && !sessionID) {
              sessionID = id;
              agent.setContextId(id);
            }
            break;
          }
          case "session.execution.started": {
            if (sessionID && data.sessionID !== sessionID) break;
            busy = true;
            await safeStatus("working");
            break;
          }
          case "session.execution.succeeded": {
            if (sessionID && data.sessionID !== sessionID) break;
            busy = false;
            ackSurfaced(); // our driven turn ended cleanly: ack the surfaced batch (the sole ack site)
            await safeStatus("idle");
            break;
          }
          case "session.execution.failed": {
            if (sessionID && data.sessionID !== sessionID) break;
            busy = false;
            abandonSurfaced(); // leave the inbox unacked so the batch can retry on a later safe turn
            await safeStatus("idle");
            break;
          }
          case "session.execution.interrupted": {
            if (sessionID && data.sessionID !== sessionID) break;
            busy = false;
            ackSurfaced(); // explicit user Stop: treat the surfaced batch as dismissed, not failed
            await safeStatus("idle");
            break;
          }
          case "permission.asked": {
            const p = data as { sessionID?: string; title?: string };
            if (!p.sessionID || !sessionID || p.sessionID === sessionID) await safeStatus("waiting", p.title);
            break;
          }
          case "session.deleted": {
            const id = (data as { info?: { id?: string } }).info?.id;
            if (id && (!sessionID || id === sessionID)) await safeStatus("offline");
            break;
          }
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) log(`event loop ended: ${(e as Error).message}`);
    }
  })();

  // Opens the boot floor once the session exists and the mesh link is up, then lets `drive`
  // carry and clear the text. Orders the connector's own submissions against each other, not
  // the host's native turns against the connector's — that window is not closed here either.
  void (async () => {
    if (bootPrompt === undefined) return;
    const id = await sessionReady;
    while (!controller.signal.aborted && !agent.connected) await new Promise((r) => setTimeout(r, 100).unref?.());
    if (controller.signal.aborted || bootPrompt === undefined) return;
    if (!id) {
      log("initial prompt not submitted — this session was never created");
      bootPrompt = undefined;
      return;
    }
    bootReady = true;
    await drive();
  })();

  return async () => {
    controller.abort();
    await settleWithin(eventLoop, EVENT_QUIESCE_MS, "opencode 2.x event loop at teardown");
    await agent.stop();
  };
}
