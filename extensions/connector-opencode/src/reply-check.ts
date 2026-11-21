/**
 * One re-prompt when a turn that carried a direct message, a role request or an @mention ends
 * cleanly with no Cotal reply sent. Some models answer such a turn in chat only, which reaches
 * nobody. The re-prompt leaves the choice with the model, because a silent acknowledgement is often
 * correct. The connector never sends anything on the model's behalf. A failed or interrupted turn
 * is not re-prompted. The re-prompt turn carries no directed message, so it cannot start another.
 */
import { MESH_ACTIONS, type InboxItem } from "@cotal-ai/connector-core";

const REPLY_TOOLS: ReadonlySet<string> = new Set([MESH_ACTIONS.replyChannel, MESH_ACTIONS.replyPrivate, MESH_ACTIONS.askRole]);

export const replyCheckPrompt = (senders: readonly string[]): string =>
  `📨 Your last turn ended without a Cotal reply, and your chat output is not delivered to peers. ` +
  `If a reply to ${senders.join(", ")} is warranted, send it now with cotal_dm / cotal_send. ` +
  `If none is warranted, end this turn without one.`;

export class ReplyCheck {
  /** Senders of the directed messages the running submission carries. */
  private directed: string[] = [];
  private replied = false;
  /** Senders of a turn that ended with no reply, until a submission carries the re-prompt. */
  private waiting: string[] | undefined;

  get pending(): boolean {
    return this.waiting !== undefined;
  }

  /** A submission goes out carrying these items. */
  submitted(items: readonly InboxItem[]): void {
    const senders = items.filter((i) => !i.historical && (i.kind !== "channel" || i.mentionsMe)).map((i) => i.fromName);
    this.directed = [...new Set(senders)];
    this.replied = false;
  }

  /** A cotal_* tool returned without an error. */
  toolSucceeded(name: string): void {
    if (REPLY_TOOLS.has(name)) this.replied = true;
  }

  /** The running turn ended. Only a clean end with no reply sent waits for the re-prompt. */
  ended(succeeded: boolean): void {
    if (succeeded && this.directed.length > 0 && !this.replied) this.waiting = this.directed;
    this.directed = [];
  }

  /** The re-prompt for the next submission, taken out of waiting. */
  take(): { text: string; restore(): void } | undefined {
    const senders = this.waiting;
    if (senders === undefined) return undefined;
    this.waiting = undefined;
    return { text: replyCheckPrompt(senders), restore: () => void (this.waiting ??= senders) };
  }
}
