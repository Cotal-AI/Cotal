import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";
import { MeshAgent, InboxTurn, configFromEnv } from "@cotal-ai/connector-core";
import type { InboxItem } from "@cotal-ai/connector-core";

const DEFAULT_MODEL = "gpt-4o-mini";

/** Actionable = a DM, an anycast to our role, or a channel message that names us — and not
 *  our own echo. Pure ambient channel chatter is dropped (acked, never answered). */
function actionable(mesh: MeshAgent, item: InboxItem): boolean {
  if (item.fromId === mesh.id) return false;
  return item.kind !== "channel" || item.mentionsMe;
}

/**
 * Read-only/awareness tools. Replies are NOT sent by the model — the run loop
 * delivers the agent's final text on the right delivery mode (see processNext),
 * so the model can't mis-route or duplicate a reply. These tools just let it see
 * who is present and report its own status.
 */
function buildTools(mesh: MeshAgent) {
  const cotal_roster = tool({
    name: "cotal_roster",
    description: "List the peers currently present on the Cotal mesh.",
    parameters: z.object({}),
    execute: async () => {
      const peers = mesh.roster();
      if (!peers.length) return "roster is empty";
      return peers
        .map((p) => `${p.card.name}${p.card.role ? `/${p.card.role}` : ""} [${p.status}]`)
        .join("\n");
    },
  });

  const cotal_status = tool({
    name: "cotal_status",
    description: "Update this peer's presence status on the mesh.",
    parameters: z.object({
      status: z.enum(["idle", "waiting", "working"]).describe("Presence status"),
      activity: z.string().optional().describe("Optional freeform activity description"),
    }),
    execute: async ({ status, activity }) => {
      await mesh.setStatus(status, activity ?? undefined);
      return `status set to ${status}`;
    },
  });

  return [cotal_roster, cotal_status];
}

export async function runOpenAIAgentPeer(): Promise<void> {
  const mesh = new MeshAgent(configFromEnv());
  mesh.start();

  const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;

  const agent = new Agent({
    name: mesh.config.name,
    model,
    instructions:
      "You are a peer on a Cotal mesh — a shared pub/sub space where agents coordinate laterally. " +
      "Reply with the answer itself as plain text; it is delivered automatically back to whoever " +
      "messaged you. Be concise. Call cotal_roster if you need to see who is present.",
    tools: buildTools(mesh),
  });

  // Drive straight off the MeshAgent inbox (the single source of truth), one turn at a time.
  // Delivery is ack-on-surface: the surfaced message is drainInbox-acked only once its turn
  // completes (commit in `finally`, covering clean and failed), so a crash mid-run redelivers.
  const turn = new InboxTurn(mesh);
  let running = false;

  async function handle(origin: InboxItem): Promise<void> {
    try {
      await mesh.setStatus("working", `handling ${origin.kind} from ${origin.fromName}`);
      const result = await run(agent, `from ${origin.fromName} via ${origin.kind}: ${origin.text}`);
      const output =
        typeof result.finalOutput === "string"
          ? result.finalOutput
          : JSON.stringify(result.finalOutput);
      if (output) {
        if (origin.kind === "channel") {
          await mesh.send(output, origin.channel);
        } else {
          await mesh.dm(origin.fromId, output);
        }
      }
    } catch (e) {
      process.stderr.write(`[openai-peer] error handling item: ${(e as Error).message}\n`);
    } finally {
      turn.commit(); // ack on completion — clean or failed both consume (no retry-loop)
      await mesh.setStatus("idle");
      running = false;
      pump();
    }
  }

  /** Start the next turn on the front actionable message, ack-dropping leading
   *  non-actionable (own echoes, ambient chatter) first. No-op while a turn runs. */
  function pump(): void {
    if (running) return;
    turn.drop((i) => !actionable(mesh, i));
    const origin = turn.start();
    if (!origin) return;
    running = true;
    void handle(origin);
  }

  mesh.on("incoming", () => pump());
  mesh.on("wake", () => pump());
  // Drain anything buffered before the listeners were attached.
  pump();

  function shutdown() {
    mesh.stop().then(() => process.exit(0)).catch(() => process.exit(1));
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep alive.
  await new Promise<void>(() => {});
}
