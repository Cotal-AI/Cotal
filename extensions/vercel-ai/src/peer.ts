import { generateText, tool, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { MeshAgent, InboxTurn, configFromEnv } from "@cotal-ai/connector-core";
import type { InboxItem } from "@cotal-ai/connector-core";

const MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1";

/** Actionable = a DM, an anycast to our role, or a channel message that names us — and not
 *  our own echo. Pure ambient channel chatter is dropped (acked, never answered). */
function actionable(mesh: MeshAgent, item: InboxItem): boolean {
  if (item.fromId === mesh.id) return false;
  return item.kind !== "channel" || item.mentionsMe;
}

export async function runVercelAgentPeer(): Promise<void> {
  const mesh = new MeshAgent(configFromEnv());
  mesh.start();

  // Read-only/awareness tools. Replies are delivered by the loop (see handle)
  // on the correct delivery mode, so the model can't mis-route or duplicate them.
  const tools = {
    cotal_roster: tool({
      description: "List all peers currently on the mesh.",
      inputSchema: z.object({}),
      execute: async () => {
        const peers = mesh.roster();
        if (peers.length === 0) return "roster is empty";
        return peers
          .map((p) => `${p.card.name}${p.card.role ? `/${p.card.role}` : ""} (${p.status})`)
          .join(", ");
      },
    }),
    cotal_status: tool({
      description: "Update this peer's presence status.",
      inputSchema: z.object({
        status: z.enum(["idle", "waiting", "working"]).describe("New status"),
        activity: z.string().optional().describe("Freeform activity description"),
      }),
      execute: async ({ status, activity }) => {
        await mesh.setStatus(status, activity ?? undefined);
        return `status set to ${status}`;
      },
    }),
  };

  // Drive straight off the MeshAgent inbox (the single source of truth), one turn at a time.
  // Delivery is ack-on-surface: the surfaced message is drainInbox-acked only once its turn
  // completes (commit in `finally`, covering clean and failed), so a crash mid-run redelivers.
  const turn = new InboxTurn(mesh);
  let running = false;

  async function handle(origin: InboxItem): Promise<void> {
    try {
      await mesh.setStatus("working", `responding to ${origin.fromName}`);

      const context = `from ${origin.fromName} via ${origin.kind}`;
      const prompt = [
        "You are a peer on a Cotal mesh — a shared pub/sub space where AI agents coordinate as lateral equals.",
        "Reply with the answer itself as plain text; it is delivered automatically back to whoever messaged you. Be concise.",
        "",
        `[${context}]`,
        origin.text,
      ].join("\n");

      const result = await generateText({
        model: openai(MODEL),
        tools,
        stopWhen: stepCountIs(5),
        prompt,
      });

      const reply = result.text.trim();
      if (reply) {
        if (origin.kind === "channel") {
          await mesh.send(reply, origin.channel);
        } else {
          await mesh.dm(origin.fromId, reply);
        }
      }
    } catch (e) {
      process.stderr.write(`[vercel-ai] error handling item: ${(e as Error).message}\n`);
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
  mesh.on("error", (e: Error) => {
    process.stderr.write(`[vercel-ai] mesh error: ${e.message}\n`);
  });
  // Drain anything buffered before the listeners were attached.
  pump();

  // Keep the process alive.
  const shutdown = () => {
    void mesh.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<void>(() => {});
}
