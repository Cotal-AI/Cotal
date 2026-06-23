/**
 * Codex host-mode peer: embeds a Cotal {@link MeshAgent} in the same process as an
 * {@link AppServerDriver}, so a Codex session is a full lateral peer that can be
 * DRIVEN live. Inbound mesh messages become real Codex turns — a directed message
 * wakes an idle session (turn/start) or steers one already mid-turn (turn/steer);
 * presence is derived from the app-server's turn events, not self-reported. Each
 * turn's final agent message is routed back to whoever prompted it.
 *
 * The standalone host-mode path (no plugin, no cmux/send-key). Two correctness
 * properties it holds (the ones the embed adapters converged on):
 *  - **ack-on-completion** — it drives off the mesh inbox and `drainInbox()`-acks a
 *    turn's surfaced messages when the turn ends un-interrupted, so an interrupt or a
 *    crash mid-turn leaves them on the stream to redeliver (never silently lost, never
 *    double-answered after a restart). A model-`failed` turn DOES ack (drop, don't
 *    retry-loop — matching opencode); only `interrupted` redelivers.
 *  - **scope isolation** — a message is only steered into the live turn when it shares
 *    that turn's reply audience (`scopeKey`), so a private DM is never folded into, and
 *    broadcast by, a channel turn (and vice-versa).
 */
import { MeshAgent, configFromEnv, fmtFrom, type InboxItem } from "@cotal-ai/connector-core";
import { AppServerDriver } from "./app-server.js";

/** Render an inbox item as the prompt text fed into a turn (mirrors the cotal_inbox formatting). */
function render(it: InboxItem): string {
  const who = fmtFrom(it);
  if (it.kind === "dm") return `[DM from ${who}] ${it.text}`;
  if (it.kind === "anycast") return `[@${it.service} request from ${who}] ${it.text}`;
  return `[#${it.channel} from ${who}] ${it.text}`;
}

/** A message's reply audience. A channel mention's audience is the channel (which already saw it);
 *  a DM/anycast is private to its sender. Only same-scope messages may share a turn. */
function scopeKey(it: InboxItem): string {
  return it.kind === "channel" ? `channel:${it.channel ?? ""}` : `dm:${it.fromId}`;
}

export async function runCodexHost(): Promise<void> {
  const config = configFromEnv();
  const mesh = new MeshAgent(config);
  mesh.start(); // background connect with retry

  const driver = new AppServerDriver({ cwd: process.cwd(), model: process.env.COTAL_MODEL });

  // Presence is meaningless before we've connected; never let a status push throw.
  const status = (s: "idle" | "working" | "waiting", activity?: string): void => {
    if (mesh.connected) void mesh.setStatus(s, activity).catch(() => {});
  };

  // We only act on *directed* traffic (DM, anycast, or an @mention of us); ambient channel chatter
  // isn't answered. A message we should process must be directed and not our own echo.
  const actionable = (it: InboxItem): boolean =>
    it.fromId !== mesh.id && (it.kind === "dm" || it.kind === "anycast" || it.mentionsMe);

  // How to reply to a turn started by `it` — to its channel, or privately to its sender.
  const deliverTo = (it: InboxItem) => (text: string): Promise<unknown> =>
    it.kind === "channel" ? mesh.send(text, it.channel) : mesh.dm(it.fromId, text);

  // The turn in progress: its scope + where its reply goes. `surfaced` is the count of inbox
  // front-items fed into it (the starting message + same-scope messages steered in), which is
  // exactly what `drainInbox(surfaced)` acks on clean completion. The inbox IS the queue — we never
  // copy messages into a parallel buffer, so the stream's ack is the single source of truth.
  let active: { scope: string; deliver: (text: string) => Promise<unknown>; originId: string } | undefined;
  let surfaced = 0;
  let absorbing = false;
  let ready = false; // the app-server thread is up — don't surface a turn before then

  function pump(): void {
    if (!ready || active || driver.busy) return;
    const pending = mesh.peekInbox();
    let i = 0;
    while (i < pending.length && !actionable(pending[i])) i++;
    if (i >= pending.length) return; // nothing actionable; leave ambient on the stream (capped)
    if (i > 0) mesh.drainInbox(i); // drop the leading non-actionable run so our item is front[0]
    const item = pending[i];
    active = { scope: scopeKey(item), deliver: deliverTo(item), originId: item.id };
    surfaced = 1;
    status("working", `handling ${item.kind} from ${item.fromName}`);
    driver.startTurn(render(item)).catch((e) => {
      process.stderr.write(`[cotal-codex-host] turn/start failed: ${(e as Error).message}\n`);
      active = undefined;
      surfaced = 0;
      status("idle");
    });
  }

  // Steer every front-contiguous same-scope message (beyond the ones already surfaced) into the live
  // turn. Stops at the first non-matching front-item, which keeps the surfaced run contiguous so the
  // completion-time `drainInbox(surfaced)` acks exactly what was fed in. Serialised by `absorbing`.
  async function absorb(): Promise<void> {
    if (absorbing) return;
    absorbing = true;
    try {
      while (active && driver.busy) {
        const it = mesh.peekInbox()[surfaced];
        if (!it || !actionable(it) || scopeKey(it) !== active.scope) break;
        if (!(await driver.steer(render(it)))) break; // turn ended mid-absorb — next pump handles it
        surfaced++;
      }
    } finally {
      absorbing = false;
    }
  }

  driver.on("turnStarted", () => {
    status("working");
    void absorb();
  });
  driver.on("waiting", () => status("waiting", "approval"));
  driver.on("turnCompleted", (r: { text: string; status: string }) => {
    const turn = active;
    const consumed = surfaced;
    // Ack (and reply) on any terminal status EXCEPT interrupt: a 'completed' or model-'failed' turn
    // acks its surfaced run (failed drops rather than retry-loops, like opencode); only 'interrupted'
    // skips the ack so the run redelivers. A crash before this event never acked → redelivers too.
    const acked = r.status !== "interrupted";
    active = undefined;
    surfaced = 0;
    // Ack the surfaced front-run — but ONLY if our origin is still front[0]. MeshAgent force-evicts+
    // acks from the front at MAX_INBOX, so a 200+ msg burst mid-turn can evict our in-flight prefix;
    // a position-based drainInbox(consumed) would then ack the wrong (newer) items. If the origin is
    // gone, the overflow already acked the prefix → skip the drain (front-id guard, like hermes').
    if (turn && acked && consumed > 0 && mesh.peekInbox()[0]?.id === turn.originId)
      mesh.drainInbox(consumed); // sole ack site
    const text = r.text?.trim();
    process.stderr.write(`[cotal-codex-host] turn ${r.status}: reply ${text ? `${text.length}c` : "(empty)"}\n`);
    void (async () => {
      if (turn && acked && text) {
        try {
          await turn.deliver(text);
        } catch (e) {
          process.stderr.write(`[cotal-codex-host] reply route failed: ${(e as Error).message}\n`);
        }
      }
      status("idle");
      pump();
    })();
  });
  driver.on("closed", () => void mesh.stop().then(() => process.exit(0)).catch(() => process.exit(1)));

  // New mesh traffic: feed it into the live turn if it fits the scope, else start the next turn.
  mesh.on("incoming", () => {
    void absorb();
    pump();
  });

  await driver.start();
  ready = true;
  status("idle");
  pump(); // drain anything that arrived while the app-server thread was starting
  process.stderr.write(
    `[cotal-codex-host] ready (app-server) — space="${config.space}" name="${config.name}"${config.role ? ` role="${config.role}"` : ""}\n`,
  );

  const shutdown = async (): Promise<void> => {
    try {
      await driver.interrupt();
      await driver.stop();
    } catch {
      /* ignore */
    }
    try {
      await mesh.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await new Promise<void>(() => {}); // keep alive
}
