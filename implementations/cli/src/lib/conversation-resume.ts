import { createHash, randomBytes } from "node:crypto";
import { canonicalJson, retryAfterSeconds, type ConversationSelection } from "@cotal-ai/core";
import { conversationResumeToken, type ConversationResumeProof } from "@cotal-ai/workspace/conversation-resume";
import type { ConversationMaterial } from "./conversation-identity.js";

/** An authority failure that keeps the original saved request or approval for exact recovery. */
export class ConversationRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "ConversationRequestError";
  }
}

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

interface ConversationBinding {
  trust: string;
  session: string;
  label: string;
  requestId: string;
  selection?: ConversationSelection;
}

const bindingOf = (r: ConversationBinding): string => hash(canonicalJson([r.trust, r.session, r.label, r.requestId, r.selection ?? null]));
export const matchesResumeBinding = (r: ConversationBinding, proof: ConversationResumeProof): boolean => proof.binding === bindingOf(r);

export function createResumeProof(r: ConversationBinding): { proof: ConversationResumeProof; tokenHash: string } | undefined {
  const proof = { v: 1 as const, salt: randomBytes(32).toString("base64url"), binding: bindingOf(r) };
  try { return { proof, tokenHash: hash(conversationResumeToken(proof, true)) }; }
  catch { return undefined; } // An unsupported or unwritable device still uses ordinary approval.
}

/** Compare the original commitment before sending anything to the authority. */
export function resumeToken(r: ConversationBinding & { token: string; proof: ConversationResumeProof }): string | undefined {
  if (!matchesResumeBinding(r, r.proof)) return undefined;
  try {
    const token = conversationResumeToken(r.proof);
    return hash(token) === r.token ? token : undefined;
  } catch { return undefined; }
}

/** Only a lifecycle-bound answer from the pinned exchange decides the saved approval. A transport
 * error or malformed answer leaves the saved approval untouched for exact retry. */
export async function confirmConversationResume(m: ConversationMaterial, actorToken: string): Promise<boolean> {
  const url = new URL(m.exchangeUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/exchange`;
  url.search = "";
  const response = await fetch(url, {
    redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(15_000),
    method: "POST", headers: { "content-type": "application/json", "Cotal-Conversation-Resume": "1" },
    body: JSON.stringify({ owner: m.owner, actor: m.actor, actorToken, conversationResume: { v: 1, lifecycleUid: m.lifecycleUid, grant: m.grant } }),
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (response.status === 200 && canonicalJson(body ?? null) === canonicalJson({ v: 1, lifecycleUid: m.lifecycleUid, status: "resumed" })) return true;
  if (response.status === 401 && canonicalJson(body ?? null) === canonicalJson({ v: 1, lifecycleUid: m.lifecycleUid, status: "refused" })) return false;
  const retryable = response.status === 429 || response.status >= 500;
  const seconds = response.status === 429 ? retryAfterSeconds(response.headers.get("retry-after")) : undefined;
  const hint = seconds !== undefined ? ` Wait at least ${seconds} seconds before trying again.` : retryable ? " Wait before trying again." : "";
  throw new ConversationRequestError(`the conversation resume exchange did not confirm its approval (HTTP ${response.status}); the saved identity was retained.${hint}`, retryable);
}
