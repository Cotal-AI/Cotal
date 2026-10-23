/**
 * The static-mode chat admission adapter. On a static-auth mesh the local manager admits the
 * session (`chat-session-open`): it draws the `chat_` alias and a fresh nkey identity and mints the
 * session's own leaf. This adapter runs one real `CotalEndpoint` under that leaf and ends the
 * session with `chat-session-retire` at the same manager instance that admitted it, on close or at
 * the leaf's expiry. `cotal chat` opens it for a static-auth target.
 *
 * The leaf never crosses the wire in the clear. The adapter sends a one-time curve key as
 * `sealTo`, and the manager seals the leaf to it, bound to the space, the admitting instance and
 * every reply field; a generic invoke, an agent tool or a browser sees only that ciphertext. The
 * adapter opens it once, checks every bound field, keeps the leaf in memory, and never writes it to
 * a file, a receipt, a log or any output record. Its retire path never sees it.
 *
 * The caller resolves the mesh once, into `target`. Every manager call mints its one-shot
 * instrument from a copy of that target's server, TLS requirement and trust material, so a later
 * `cotal use` or registry change cannot move the retirement to another mesh.
 */
import {
  CotalEndpoint, DEV_OWNER, SealRecipient, assertLifecycleToken, assertValidChannel, idFromCreds, isCurvePublicKey, principalKey, resolveReadAcl,
  type SpaceAuth,
} from "@cotal-ai/core";
import { CommandFailure, isConnectRefusal, mintControlInstrument, preflightOrThrow, type MeshTarget } from "@cotal-ai/workspace";
import { askManager, managerFailure, type ManagerReply } from "../lib/control.js";
import { NativeChatSession } from "./native-session.js";
import type { CloseReport, SessionIdentity } from "./session.js";

/** The leaf's whole life. The manager caps `ttl` here and never renews it. */
export const STATIC_CHAT_TTL_SEC = 900;

/** What `chat-session-open` returned, checked. `actor` is the session's wire authority and
 *  `alias` its routing-only slot name. */
export interface StaticAdmission {
  readonly alias: string;
  readonly actor: string;
  readonly lifecycleUid: string;
  readonly creds: string;
  readonly expiresAt: number;
}

/** The mesh a session was opened against, copied once from the caller's resolved target. */
type PinnedMesh = Readonly<MeshTarget> & { readonly auth: SpaceAuth };

/** Every key the manager seals and no other, sorted and joined for one comparison. */
const SEALED_KEYS = ["v", "space", "managerInstanceId", "alias", "actor", "lifecycleUid", "expiresAt", "sealTo", "creds"].sort().join();

/** Open and check one `chat-session-open` reply. The outer reply must have its contract shape;
 *  the sealed payload must open with `recipient`, which it uses up, must carry exactly the sealed
 *  keys, and must bind the expected space and responding instance, this recipient's own key and
 *  the outer alias, actor, uid and expiry; and its credential must be the identity it names.
 *  Undefined when any part does not hold; the caller never uses a reply that fails here. */
export function readAdmission(data: unknown, recipient: SealRecipient, expected: { readonly space: string; readonly managerInstanceId: string }): StaticAdmission | undefined {
  const sealTo = recipient.publicKey;
  // A reply refused before the open still uses the key up, so it never opens a later one.
  const refuse = (): undefined => {
    recipient.clear();
    return undefined;
  };
  if (typeof data !== "object" || data === null) return refuse();
  const d = data as Record<string, unknown>;
  if (typeof d.alias !== "string" || !/^chat_[a-z2-7]{26}$/.test(d.alias)) return refuse();
  if (typeof d.actor !== "string" || typeof d.lifecycleUid !== "string" || typeof d.sealed !== "string") return refuse();
  if (typeof d.sealer !== "string" || !isCurvePublicKey(d.sealer)) return refuse();
  if (typeof d.expiresAt !== "number" || !Number.isSafeInteger(d.expiresAt)) return refuse();
  if ("creds" in d) return refuse();
  const opened = recipient.openJson(d.sealed, d.sealer);
  if (typeof opened !== "object" || opened === null) return undefined;
  const p = opened as Record<string, unknown>;
  if (Object.keys(p).sort().join() !== SEALED_KEYS) return undefined;
  if (p.v !== 1 || p.space !== expected.space || p.managerInstanceId !== expected.managerInstanceId || p.sealTo !== sealTo) return undefined;
  if (p.alias !== d.alias || p.actor !== d.actor || p.lifecycleUid !== d.lifecycleUid || p.expiresAt !== d.expiresAt) return undefined;
  if (typeof p.creds !== "string") return undefined;
  try {
    assertLifecycleToken(d.lifecycleUid);
    principalKey(DEV_OWNER, d.actor);
    if (idFromCreds(p.creds) !== d.actor) return undefined;
  } catch {
    return undefined;
  }
  return { alias: d.alias, actor: d.actor, lifecycleUid: d.lifecycleUid, creds: p.creds, expiresAt: d.expiresAt };
}

/** The close report for a `chat-session-retire` reply. The adapter asks only after its own
 *  endpoint stopped, so `connectionClosed` is that observed stop, and `NativeChatSession`
 *  downgrades it when the stop failed. The retirement outcome is reported apart from it and never
 *  changes it. A static mesh has no broker-side revocation, so no outcome here ends the leaf at
 *  the broker: a copy of it still authenticates until `validUntil`. */
export function retireReport(reply: ManagerReply, managerInstanceId: string, validUntil: number): CloseReport {
  const base = { connectionClosed: "confirmed", credentialValidUntil: validUntil } as const;
  const valid = `The broker accepts the session's credential until ${new Date(validUntil).toISOString()}; a static mesh cannot revoke it sooner.`;
  if (!reply.ok) {
    const failure = managerFailure(reply, "chat-session-retire", null);
    return failure.outcome === "refused"
      ? { ...base, retirement: "requested", message: `Manager ${managerInstanceId} refused the retirement; the session is not retired: ${reply.error ?? failure.message}. ${valid}` }
      : { ...base, retirement: "unknown", message: `${failure.message}. The session may still be admitted at manager ${managerInstanceId}. ${valid}` };
  }
  const data = reply.data as { outcome?: unknown; reason?: unknown } | undefined;
  if (data?.outcome === "retired")
    return { ...base, retirement: "retired", message: `Static session retired at manager ${managerInstanceId}: its slot is retired, its credential row is marked revoked, and its principal had no broker connection left when it retired. ${valid}` };
  if (data?.outcome === "alreadyRetired")
    return { ...base, retirement: "retired", message: `Static session was already retired at manager ${managerInstanceId}. ${valid}` };
  if (data?.outcome === "failed")
    return { ...base, retirement: "requested", message: `Manager ${managerInstanceId} did not finish the retirement: ${typeof data.reason === "string" ? data.reason : "retirement pending"}. ${valid}` };
  return { ...base, retirement: "unknown", message: `Manager ${managerInstanceId} answered the retirement without a recognized outcome. ${valid}` };
}

/** Ask the pinned mesh's manager `op` under a fresh one-shot instrument minted from the pinned
 *  trust material. When the mint or the dial throws, nothing reached the manager, and a read-only
 *  preflight of the same target classifies the cause as `connectOrThrow` does; it prunes nothing. */
async function askPinned(mesh: PinnedMesh, op: string, args: Record<string, unknown>, instanceId: string | undefined): Promise<ManagerReply> {
  try {
    const instrument = await mintControlInstrument(mesh, "privileged", instanceId);
    return await askManager(mesh.space, mesh.server, op, args, { ...instrument, tls: mesh.tlsRequired }, "owner", undefined, instanceId !== undefined ? { instanceId } : undefined);
  } catch (e) {
    await preflightOrThrow(mesh, undefined, true);
    throw e;
  }
}

/** Open one static chat session on `target`, which the caller resolved once. The three lists are
 *  a spawn's, under its rules: `subscribe` the initial channels, `allowSubscribe` the read ceiling
 *  (empty means `subscribe`), `allowPublish` the post list (empty means none). `instanceId`
 *  (`--on`) chooses the admitting manager; retirement always goes to the instance that answered
 *  the open. */
export async function openStaticChatSession(target: MeshTarget, options: {
  readonly label: string;
  readonly subscribe?: readonly string[];
  readonly allowSubscribe?: readonly string[];
  readonly allowPublish?: readonly string[];
  readonly instanceId?: string;
}): Promise<NativeChatSession> {
  if (target.mode !== "auth" || !target.auth)
    throw new CommandFailure("refused", "UNSUPPORTED", "the static chat adapter requires a recorded static-auth target with its trust material; no other admission was attempted", { target: { space: target.space } });
  const subscribe = [...(options.subscribe ?? [])];
  const allowPublish = [...(options.allowPublish ?? [])];
  let allowSubscribe: string[];
  try {
    if (!options.label || options.label.length > 128) throw new Error("the label must be 1 to 128 characters");
    for (const channel of [...subscribe, ...(options.allowSubscribe ?? []), ...allowPublish]) assertValidChannel(channel);
    allowSubscribe = resolveReadAcl(subscribe, [...(options.allowSubscribe ?? [])]);
  } catch (e) {
    throw new CommandFailure("refused", "USAGE_INVALID", `chat could not be opened: ${(e as Error).message}`);
  }
  const mesh: PinnedMesh = Object.freeze({ ...target, auth: target.auth });
  // The one-time key the leaf is sealed to. Its private half stays in this object and is cleared
  // once the reply is opened or the open fails.
  const recipient = new SealRecipient();
  let reply: ManagerReply;
  try {
    reply = await askPinned(mesh, "chatSessionOpen", {
      subscribe, allowSubscribe: [...(options.allowSubscribe ?? [])], allowPublish, label: options.label, ttl: STATIC_CHAT_TTL_SEC, sealTo: recipient.publicKey,
    }, options.instanceId);
  } catch (e) {
    recipient.clear();
    if (isConnectRefusal(e)) throw e.failure();
    throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the control instrument could not be minted or connected, so chat-session-open was not sent: ${(e as Error).message}`, { target: { space: mesh.space } });
  }
  if (!reply.ok) {
    recipient.clear();
    throw managerFailure(reply, "chat-session-open", { space: mesh.space });
  }
  const managerInstanceId = reply.managerInstanceId;
  const admission = managerInstanceId === undefined ? undefined : readAdmission(reply.data, recipient, { space: mesh.space, managerInstanceId });
  if (admission === undefined || managerInstanceId === undefined) {
    recipient.clear();
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the manager answered chat-session-open with a reply this CLI could not open or verify; the session was not used and could not be retired from here", {
      target: { space: mesh.space },
      native: { outcome: "unknown", detail: { managerInstanceId: managerInstanceId ?? null } },
      remedy: "list the manager's slots with cotal ps --slots; the admitting manager retires an unretired chat_ slot at its expiry, at its stop, or at its next start",
    });
  }
  // The retire path never sees the credential bytes.
  const { creds, ...slot } = admission;
  const identity: SessionIdentity = {
    mode: "static", space: mesh.space, principal: principalKey(DEV_OWNER, slot.actor).key, lifecycleUid: slot.lifecycleUid, label: options.label,
    allowSubscribe, allowPublish, expiresAt: slot.expiresAt,
  };
  const retire = async (): Promise<CloseReport> => {
    let answer: ManagerReply;
    try {
      answer = await askPinned(mesh, "chatSessionRetire", { alias: slot.alias, actor: slot.actor, lifecycleUid: slot.lifecycleUid }, managerInstanceId);
    } catch (e) {
      const cause = isConnectRefusal(e) ? e.failure().message : (e as Error).message;
      return { retirement: "unknown", connectionClosed: "confirmed", credentialValidUntil: slot.expiresAt, message: `The retire request was not sent to manager ${managerInstanceId}: ${cause}. That manager retires the session at its expiry or its stop if it is still running.` };
    }
    return retireReport(answer, managerInstanceId, slot.expiresAt);
  };
  const endpoint = new CotalEndpoint({
    space: mesh.space,
    servers: mesh.server,
    tls: mesh.tlsRequired,
    creds,
    card: { owner: DEV_OWNER, actor: slot.actor, name: options.label, kind: "endpoint", meta: { sessionKind: "chat" } },
    lifecycleUid: slot.lifecycleUid,
    // A copy: the endpoint edits its list on /leave and /join, and the read grant may be this array.
    channels: [...subscribe],
  });
  // The participant listeners are installed here, before the endpoint starts.
  const session = new NativeChatSession({ endpoint, identity, retire });
  if (slot.expiresAt <= Date.now()) {
    const close = await session.close();
    throw new CommandFailure("failed", "OPERATION_FAILED", "the admitted session had already expired when its reply arrived, so it was closed without connecting", {
      target: { space: mesh.space, principal: identity.principal, lifecycleUid: slot.lifecycleUid },
      native: { detail: { close } },
    });
  }
  try {
    await endpoint.start();
    // The leaf is never renewed, so the session ends at its expiry. Closing is memoized, so an
    // earlier close by the front end makes this a no-op.
    setTimeout(() => void session.close(), Math.max(0, slot.expiresAt - Date.now())).unref();
    return session;
  } catch {
    const close = await session.close();
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the static chat opening did not finish; no automatic retry was made", {
      target: { space: mesh.space, principal: identity.principal, lifecycleUid: slot.lifecycleUid },
      native: { outcome: "unknown", detail: { close } },
      remedy: "the close report in the error cause says whether the session was retired; the admitting manager retires an unretired chat_ slot at its expiry, at its stop, or at its next start",
    });
  }
}
