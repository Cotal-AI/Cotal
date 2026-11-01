/**
 * The briefing: the text every connector hands its agent when a session starts, so an agent is told
 * the same things about working on the mesh whichever harness runs it, and the text is written
 * once. Each connector adds only how a peer message shows up in its model's context; everything
 * else (orient first, feedback, mesh-first, durable runs, where to talk, how to reply, attention)
 * is composed here from the shared sentences in `orientation.ts` and `config.ts`.
 *
 * `docs/agent-briefing.mdx` is generated from this module (`pnpm gen:briefingdoc`) so a reviewer
 * reads the text each harness receives, and `pnpm check:docsbundle` fails when the page drifts.
 */
import { feedbackLine, type AgentConfig } from "./config.js";
import { CHANNEL_GUIDANCE, MESH_FIRST_STEER, ORIENTATION_BOOTSTRAP, WORKFLOW_STEER } from "./orientation.js";

/** The harnesses a briefing is rendered for, keyed as each connector tags its tools (`source`).
 *  `gateway` is a conversation that joined through `cotal_connect`; how it hears messages depends on
 *  the embedder, which says so in the connect result, so the briefing leaves that sentence out. */
export const BRIEFING_HARNESSES = ["claude-code", "codex", "jcode", "opencode", "hermes", "pi", "gateway"] as const;
export type BriefingHarness = (typeof BRIEFING_HARNESSES)[number];

/** How a peer message appears in the model's context, the one sentence that differs by harness. */
const ARRIVES: Record<BriefingHarness, string | undefined> = {
  "claude-code":
    'Peer messages may arrive as <channel source="cotal" from="<name>" role="<role>" kind="dm|channel|anycast" ' +
    'channel="<name>">…</channel> blocks pushed into your session, or as a block marked 📨 at the start of a turn.',
  codex: "Peer messages are delivered into your turns as blocks marked 📨.",
  jcode: "Peer messages are delivered into your turns as blocks marked 📨.",
  opencode: "Peer messages are delivered into your turns as blocks marked 📨.",
  hermes: "Peer messages are delivered into your turns as blocks marked 📨.",
  pi: "Peer messages from the Cotal mesh arrive as user messages tagged 📨.",
  gateway: undefined,
};

/** How to answer, the same in every harness: a reply exists only when a tool sends it. */
export const REPLY_GUIDANCE =
  "Your chat output is not delivered to peers. When a reply is warranted, send it with cotal_dm (back to " +
  "that peer), cotal_send (to a channel), or cotal_anycast (to a role). Use cotal_roster to see who is " +
  "present, cotal_inbox to pull anything you may have missed, and cotal_status to report what you are doing.";

/** Attention and per-channel modes, the same in every harness. */
export const ATTENTION_GUIDANCE =
  "If you need to concentrate, cotal_status also sets your attention — dnd (channel chatter stops waking " +
  "you; it still arrives on your next turn) or focus (only DMs and @mentions reach your context — pull the " +
  "held chatter with cotal_inbox). To silence one channel instead of all of them, cotal_channel_mode sets " +
  "it quiet (still buffered but pull-only via cotal_inbox; @mentions still wake and inject) or muted (you " +
  "stop receiving it, @mentions included).";

/** Reply etiquette, the same in every harness. When to mention a peer lives with the channel
 *  guidance, where the wake rule is explained. */
export const REPLY_ETIQUETTE =
  "Reply only when a reply is actually needed: a silent acknowledgement is correct, and " +
  '"agreed/thanks/good point" messages are noise.';

/** The briefing for one agent in one harness, as paragraphs. A connector prepends its persona and
 *  places the text where its harness takes a system prompt; it never edits the paragraphs. */
export function briefing(config: Pick<AgentConfig, "name" | "role" | "space" | "feedbackKey">, harness: BriefingHarness): string {
  const arrives = ARRIVES[harness];
  return [
    `You are connected to the Cotal mesh as "${config.name}"${config.role ? ` (role: ${config.role})` : ""} in space "${config.space}".`,
    ORIENTATION_BOOTSTRAP,
    feedbackLine(config).trim(),
    MESH_FIRST_STEER,
    WORKFLOW_STEER,
    CHANNEL_GUIDANCE,
    `Other agents coordinate with you here as lateral peers. ${arrives ? `${arrives} ` : ""}${REPLY_GUIDANCE}`,
    ATTENTION_GUIDANCE,
    REPLY_ETIQUETTE,
  ].join("\n\n");
}
