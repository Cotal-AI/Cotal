import { assertLifecycleToken, canonicalJson, type ConversationGrant } from "@cotal-ai/core";
import { ledgerAuthorizeAgentExchange } from "./ledger.js";

/** Confirm an exact existing approval without issuing, changing or extending a credential. */
export async function checkConversationResumeExchange(dir: string, owner: string, actor: string, actorToken: string, value: unknown, readRouting: () => Promise<{ enabled: boolean }>) {
  const resume = value as { v?: unknown; lifecycleUid?: unknown; grant?: ConversationGrant } | null;
  const bad = { status: 400, body: { error: "invalid conversation resume request" } };
  if (!resume || Object.keys(resume).length !== 3 || resume.v !== 1 || typeof resume.lifecycleUid !== "string" || !resume.grant ||
      !/^pa_[a-z2-7]{26}$/.test(actor)) return bad;
  const lifecycleUid = resume.lifecycleUid;
  try { assertLifecycleToken(lifecycleUid); } catch { return bad; }
  const refused = { status: 401, body: { v: 1, lifecycleUid, status: "refused" } };
  let live: Awaited<ReturnType<typeof ledgerAuthorizeAgentExchange>>;
  try { live = await ledgerAuthorizeAgentExchange(dir, owner, actor, actorToken, readRouting); }
  catch { return refused; }
  if (live.lifecycleUid !== lifecycleUid || canonicalJson(resume.grant) !== canonicalJson({
    scope: live.scope, role: live.role ?? null, allowSubscribe: live.allowSubscribe, allowPublish: live.allowPublish, subscribe: [], endpoints: [],
  })) return refused;
  return { status: 200, body: { v: 1, lifecycleUid, status: "resumed" } };
}
