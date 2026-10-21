import { createHash, randomBytes } from "node:crypto";
import {
  CotalEndpoint,
  EpEnvelopeError,
  channelInAllow,
  isConcreteChannel,
  registry,
  type AuthProvider,
  type ChatSessionOpened,
} from "@cotal-ai/core";
import { CommandFailure, userAuthStateDir, workspaceSecretStore, type MeshTarget, type RefusalCode } from "@cotal-ai/workspace";
import { NativeChatSession } from "./native-session.js";
import type { CloseReport, SessionIdentity } from "./session.js";

/** Native refusal codes the auth service answers before any effect. */
const REFUSED: Readonly<Record<string, RefusalCode>> = {
  "bad-request": "USAGE_INVALID",
  "unauthenticated": "AUTH_REQUIRED",
  "permission-denied": "PERMISSION_DENIED",
  "not-found": "TARGET_NOT_FOUND",
  "failed-precondition": "LIFECYCLE_BLOCKED",
  "unimplemented": "UNSUPPORTED",
  "unavailable": "TARGET_UNAVAILABLE",
  "conflict": "CONFLICT",
  "resource-exhausted": "TARGET_UNAVAILABLE",
};

/** A provider failure as the command's outcome, by the effect outcome the service stated: a
 *  `not-executed` refusal keeps its code, an `executed` one failed after writing, and anything else
 *  is unknown and never retried here. A plain provider error was raised before the request left this
 *  machine (sign-in, discovery, transport setup). */
function providerFailure(e: unknown, target: unknown): CommandFailure {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof EpEnvelopeError) {
    const native = { code: e.code, outcome: e.outcome ?? "unknown" };
    if (e.outcome === "not-executed")
      return new CommandFailure("refused", REFUSED[e.code] ?? "DEPENDENCY_UNAVAILABLE", message, { target, native });
    if (e.outcome === "executed")
      return new CommandFailure("failed", "OPERATION_FAILED", message, { target, native });
    return new CommandFailure("unknown", "OPERATION_UNKNOWN", message, {
      target,
      native,
      remedy: "no automatic retry was made; an admission that landed without an answer is reclaimed by the auth service's sweep",
    });
  }
  const credential = (e as { code?: unknown } | undefined)?.code;
  return new CommandFailure("refused", credential === "signed-out" ? "AUTH_REQUIRED" : credential === "refused" ? "PERMISSION_DENIED" : "DEPENDENCY_UNAVAILABLE", message, { target });
}

/** The principal a minted bearer names, read without verification (the broker verifies). */
function bearerPrincipal(bearer: string): { owner: string; actor: string; lifecycleUid: string } {
  const payload = JSON.parse(Buffer.from(bearer.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown; act?: { actor?: unknown; lifecycleUid?: unknown } };
  if (typeof payload.sub !== "string" || typeof payload.act?.actor !== "string" || typeof payload.act.lifecycleUid !== "string")
    throw new Error("the chat bearer does not name a principal and lifecycle");
  return { owner: payload.sub, actor: payload.act.actor, lifecycleUid: payload.act.lifecycleUid };
}

/**
 * User mode: each opening is its own principal `<owner>.chat_<…>` at a fresh lifecycle UID, which the
 * space's auth service draws and admits under the signed-in human's own `cli` grant, confined to the
 * given read and post lists and to `ttlSec`. No `cli`, managed or other borrowed identity connects.
 *
 * The holder secret lives in this process's memory only: admission receives its SHA-256, and each
 * bearer exchange and the retirement present the secret itself. No bearer, sentinel or holder secret
 * is returned, printed or written. Mode, server, TLS and space come from the one resolved target,
 * and the open names that target's IdP and exchange position so the provider cannot follow a
 * re-registered entry; the session's later requests reuse the route its open resolved.
 */
export async function openUserChatSession(target: MeshTarget, options: {
  readonly label: string;
  readonly channels: readonly string[];
  readonly read: readonly string[];
  readonly post: readonly string[];
  readonly ttlSec: number;
}): Promise<NativeChatSession> {
  const space = target.space;
  if (target.mode !== "user" || target.userAuth === undefined)
    throw new CommandFailure("refused", "UNSUPPORTED", "the user-mode chat adapter requires a recorded user-auth target; no other authentication was attempted", { target: { space } });
  if (!options.label || options.label.length > 128 || options.channels.some((channel) => !isConcreteChannel(channel)))
    throw new CommandFailure("refused", "USAGE_INVALID", "chat requires a label of 1 to 128 characters and concrete initial channels");
  if (options.channels.some((channel) => !channelInAllow([...options.read], channel)))
    throw new CommandFailure("refused", "USAGE_INVALID", "every initial channel must sit within the session's read list");
  if (!Number.isSafeInteger(options.ttlSec) || options.ttlSec <= 0)
    throw new CommandFailure("refused", "USAGE_INVALID", "a chat session lifetime is a positive whole number of seconds");
  const userAuth = target.userAuth;
  const providerName = userAuth.provider;
  let provider: AuthProvider;
  try {
    provider = registry.resolve<AuthProvider>("auth-provider", providerName);
  } catch {
    throw new CommandFailure("refused", "UNSUPPORTED", `space "${space}" uses the "${providerName}" auth provider, which this build does not register`, { target: { space } });
  }
  const openChat = provider.openChatSession?.bind(provider);
  const bearerFor = provider.chatSessionBearer?.bind(provider);
  const retireChat = provider.retireChatSession?.bind(provider);
  if (!openChat || !bearerFor || !retireChat)
    throw new CommandFailure("refused", "UNSUPPORTED", `the "${providerName}" auth provider cannot serve user-mode chat; no other identity or auth mode was tried`, { target: { space } });

  const auth = { store: workspaceSecretStore(target.root), dir: userAuthStateDir(target.root, space), space };
  const holderProof = randomBytes(32).toString("base64url");
  const holderHash = createHash("sha256").update(holderProof, "utf8").digest("hex");
  let opened: ChatSessionOpened;
  try {
    // The provider refuses before sending anything when its own resolution is not this target's.
    const exchangeUrl = userAuth.remote === true ? userAuth.endpoints?.url : undefined;
    const expect = { idpUrl: userAuth.idp.url, ...(exchangeUrl !== undefined ? { exchangeUrl } : {}) };
    opened = await openChat({ ...auth, holderHash, label: options.label, read: [...options.read], post: [...options.post], ttlSec: options.ttlSec, expect });
  } catch (e) {
    throw providerFailure(e, { space });
  }
  const { actor, lifecycleUid } = opened;
  const expiresAtMs = opened.expiresAt * 1000;

  // The last bearer this process received: it stays broker-valid until its expiry unless the
  // retirement's eviction completes.
  let credentialValidUntil = 0;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const validUntil = (): { credentialValidUntil?: number } => (credentialValidUntil > 0 ? { credentialValidUntil } : {});
  const retire = async (): Promise<CloseReport> => {
    clearTimeout(expiry);
    try {
      const r = await retireChat({ ...auth, actor, lifecycleUid, holderProof });
      if (r.outcome === "failed")
        return { retirement: "requested", connectionClosed: "not-confirmed", ...validUntil(), message: `Chat session retirement is pending: ${r.pending ?? "the authority gave no reason"}. Its last bearer stays usable until its expiry unless eviction completes.` };
      const what = r.outcome === "alreadyRetired" ? "was already retired" : r.outcome === "notStarted" ? "had nothing left to retire" : "retired";
      return { retirement: "retired", connectionClosed: "confirmed", message: `Chat session ${what}; its connections were evicted and no bearer can be minted for it.` };
    } catch (e) {
      const unknown = !(e instanceof EpEnvelopeError) || (e.outcome !== "not-executed" && e.outcome !== "executed");
      return {
        retirement: unknown ? "unknown" : "requested",
        connectionClosed: "not-confirmed",
        ...validUntil(),
        message: `Chat session retirement was not confirmed (${e instanceof Error ? e.message : String(e)}). The auth service retires it at its expiry; its last bearer stays usable until then unless evicted.`,
      };
    }
  };

  let first: { bearer: string; sentinelCreds: string; exp: number };
  let owner: string;
  try {
    first = await bearerFor({ ...auth, actor, holderProof });
    const principal = bearerPrincipal(first.bearer);
    if (principal.actor !== actor || principal.lifecycleUid !== lifecycleUid)
      throw new Error("the chat bearer names another session than the one admitted");
    owner = principal.owner;
  } catch (e) {
    const close = await retire();
    const f = providerFailure(e, { space, actor, lifecycleUid });
    throw new CommandFailure(f.outcome, f.code, f.message, { target: { space, actor, lifecycleUid }, native: { ...(f.native ?? {}), detail: { close } }, ...(f.remedy ? { remedy: f.remedy } : {}) });
  }
  credentialValidUntil = first.exp * 1000;
  let prefetched: string | undefined = first.bearer;
  // Each renewal is a fresh holder-proof exchange; the service re-checks the parent pin and the
  // holder index for every one, and refuses once the session has expired or been retired.
  const bearerSource = async (): Promise<string> => {
    if (prefetched !== undefined) {
      const bearer = prefetched;
      prefetched = undefined;
      return bearer;
    }
    const next = await bearerFor({ ...auth, actor, holderProof });
    credentialValidUntil = Math.max(credentialValidUntil, next.exp * 1000);
    return next.bearer;
  };

  const endpoint = new CotalEndpoint({
    space,
    servers: target.server,
    tls: target.tlsRequired,
    card: { owner, actor, name: options.label, kind: "endpoint", meta: { sessionKind: "chat" } },
    lifecycleUid,
    channels: [...options.channels],
    bearer: bearerSource,
    sentinelCreds: first.sentinelCreds,
  });
  const identity: SessionIdentity = {
    mode: "user", space, principal: `${owner}.${actor}`, lifecycleUid, label: options.label,
    allowSubscribe: [...options.read], allowPublish: [...options.post], expiresAt: expiresAtMs,
  };
  // Register the participant listeners before the endpoint starts; the session owns them until close.
  const session = new NativeChatSession({ endpoint, identity, retire });
  try {
    await endpoint.start();
  } catch (e) {
    const close = await session.close();
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", `the user-mode chat session was admitted but did not connect (${e instanceof Error ? e.message : String(e)}); no automatic retry was made`, {
      target: { space, principal: identity.principal, lifecycleUid },
      native: { outcome: "unknown", detail: { close } },
      remedy: "open a new session; this one was asked to retire",
    });
  }
  // The session ends at its admitted expiry: the authority refuses every later bearer, so close
  // here rather than let the connection lapse silently.
  expiry = setTimeout(() => void session.close(), Math.max(0, expiresAtMs - Date.now()));
  expiry.unref?.();
  return session;
}
