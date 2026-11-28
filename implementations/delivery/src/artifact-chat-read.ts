/**
 * The ONE place the delivery daemon reads a chat entry by sequence (A1, security S3).
 *
 * `confirm-attach` must check that its caller published the post that referenced the artifact. The post
 * is named by the chat sequence its publish acknowledged (`multicastWithAck`), and the delivery
 * credential reads it with a leader-served `STREAM.MSG.GET` on the chat stream, a strict subset of the
 * whole-stream consume the fan-out already holds.
 *
 * Sealed: it returns the subject and the parts' artifact references, never the body, the text or any
 * other part, so nothing read here can reach a reply or a log line. A census cell asserts this module is
 * its only caller of the chat stream's message get.
 */
import type { JetStreamManager } from "@nats-io/jetstream";
import { chatStream, isArtifactPart, parseSubject, type ParsedSubject } from "@cotal-ai/core";

/** What confirm-attach may learn about the entry: who published it, on which channel, and which
 *  artifact digests it referenced. */
export interface ChatEntryForConfirm {
  subject: ParsedSubject;
  artifactDigests: readonly string[];
}

/** Read chat entry `seq`, or `undefined` when there is none, it is not a chat post, or its body does
 *  not parse. Never throws on a missing entry: every one of those is the same collapsed refusal. */
export async function readChatEntryForConfirm(jsm: JetStreamManager, space: string, seq: number): Promise<ChatEntryForConfirm | undefined> {
  if (!Number.isSafeInteger(seq) || seq < 1) return undefined;
  let m;
  try { m = await jsm.streams.getMessage(chatStream(space), { seq }); }
  catch (e) {
    // 10037: no message at that sequence. Anything else is the broker being unreadable, which the
    // caller reports as unavailable rather than as a refusal.
    if ((e as { code?: unknown }).code === 10037) return undefined;
    throw e;
  }
  if (!m) return undefined;
  const subject = parseSubject(m.subject);
  if (subject === null || subject.kind !== "chat") return undefined;
  let parts: unknown;
  try { parts = (JSON.parse(new TextDecoder().decode(m.data)) as { parts?: unknown }).parts; } catch { return undefined; }
  if (!Array.isArray(parts)) return undefined;
  return { subject, artifactDigests: parts.filter(isArtifactPart).map((p) => p.digest) };
}
