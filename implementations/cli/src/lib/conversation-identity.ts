import {
  assertLifecycleToken, canonicalJson, conversationGrant, principalKey,
  type ConversationGrant, type ConversationSelection,
} from "@cotal-ai/core";
import { checkUserBundle, discoveryDocumentUrl, type MeshTarget, type UserBundle } from "@cotal-ai/workspace";

export interface ConversationAuthority {
  url: string;
  bundle: UserBundle;
  /** The authority advertises selection v1, so a request may carry a {@link ConversationSelection}. */
  selection: boolean;
}

/** Discover without human proof, then bind every returned trust pin to the selected registration. */
export async function discoverConversationAuthority(target: MeshTarget): Promise<ConversationAuthority> {
  const pinned = target.userAuth;
  if (!pinned?.endpoints?.url) throw new Error("the selected mesh has no pinned user-auth exchange");
  const url = discoveryDocumentUrl(new URL(pinned.endpoints.url));
  secureUrl(url.href);
  const response = await fetch(url, { redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`conversation identity discovery answered HTTP ${response.status}; no identity was requested`);
  const raw = await response.text();
  const checked = checkUserBundle(raw);
  if (!checked.ok) throw new Error("conversation identity discovery returned an invalid registration");
  const bundle = checked.value;
  if (bundle.space !== target.space || bundle.server !== target.server || bundle.tlsRequired !== target.tlsRequired ||
      bundle.userAuth.provider !== pinned.provider || bundle.userAuth.idp.url !== pinned.idp.url || bundle.userAuth.idp.issuer !== pinned.idp.issuer ||
      bundle.userAuth.idp.audience !== pinned.idp.audience || bundle.userAuth.endpoints?.url !== pinned.endpoints.url)
    throw new Error("conversation identity discovery changed the selected registration's trust pins");
  const capabilities = JSON.parse(raw)?.cloudCapabilities;
  const capability = capabilities?.conversationIdentity;
  if (capability?.version !== 1 || typeof capability.url !== "string")
    throw new Error("the selected mesh does not advertise conversation identity v1; no identity was requested");
  const authority = secureUrl(capability.url);
  if (authority.origin !== url.origin || authority.pathname !== `/api/spaces/${encodeURIComponent(target.space)}/conversation-identities` || authority.search)
    throw new Error("conversation identity authority does not name the selected origin and space");
  return { url: authority.href, bundle, selection: capabilities?.conversationIdentitySelection?.version === 1 };
}

export interface ConversationMaterial {
  v: 1;
  requestId: string;
  space: string;
  owner: string;
  actor: string;
  lifecycleUid: string;
  grant: ConversationGrant;
  policy?: { events: "required" };
  sentinelCreds: string;
  exchangeUrl: string;
  retire: { url: string };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid conversation identity response");
  return value as Record<string, unknown>;
}

function secureUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.href !== value)
    throw new Error("conversation identity URL must be canonical HTTPS without userinfo or a fragment");
  return url;
}

/** A successful HTTP status is not authority: require exactly the grant the request implies, the
 *  own-event-only grant without a selection, and the exact pins. */
export function checkConversationMaterial(value: unknown, authority: ConversationAuthority, requestId: string, selection?: ConversationSelection): ConversationMaterial {
  const body = object(value);
  const known = ["v", "requestId", "space", "owner", "actor", "lifecycleUid", "grant", "policy", "sentinelCreds", "exchangeUrl", "retire"];
  if (Object.keys(body).some((key) => !known.includes(key)) || body.v !== 1 || body.requestId !== requestId ||
      body.space !== authority.bundle.space || typeof body.owner !== "string" || typeof body.actor !== "string" ||
      !/^pa_[a-z2-7]{26}$/.test(body.actor) || typeof body.lifecycleUid !== "string")
    throw new Error("conversation identity response does not match the saved request");
  principalKey(body.owner, body.actor);
  assertLifecycleToken(body.lifecycleUid);
  if (canonicalJson(object(body.grant)) !== canonicalJson(conversationGrant({ owner: body.owner, actor: body.actor }, selection)))
    throw new Error(selection ? "conversation identity grant is not the exact grant its selection asked for"
      : "conversation identity grant is not the exact own-event-only grant");
  if (JSON.stringify(body.policy ?? null) !== JSON.stringify(authority.bundle.policy ?? null))
    throw new Error("conversation identity response changed the selected event policy");
  if (body.sentinelCreds !== authority.bundle.sentinelCreds || body.exchangeUrl !== authority.bundle.userAuth.endpoints?.url)
    throw new Error("conversation identity response changed the sentinel or exchange pin");
  const retire = object(body.retire);
  if (Object.keys(retire).length !== 1 || typeof retire.url !== "string") throw new Error("conversation identity has no exact retirement URL");
  const expected = new URL(`${authority.url}/${body.actor}`);
  expected.searchParams.set("lifecycleUid", body.lifecycleUid);
  if (secureUrl(retire.url).href !== expected.href) throw new Error("conversation identity retirement names another lifecycle");
  return body as unknown as ConversationMaterial;
}

/** How many refused items one refusal line names. */
const REFUSED_SHOWN = 8;

/** The items a 409 says exceed the caller's own access, as one bounded line, or undefined when the
 *  answer is not that refusal. The authority wrote nothing for such a request. */
export function selectionRefusal(status: number, value: unknown): string | undefined {
  if (status !== 409 || !value || typeof value !== "object") return undefined;
  const body = value as Record<string, unknown>;
  if (body.error !== "selection exceeds your own access" || !Array.isArray(body.refused) || !body.refused.length) return undefined;
  const text = (value: unknown) => JSON.stringify(typeof value === "string" ? value.slice(0, 160) : "");
  const items = body.refused.slice(0, REFUSED_SHOWN).map((entry) => {
    const { kind, item } = (entry ?? {}) as { kind?: unknown; item?: unknown };
    if (kind === "channel" && item && typeof item === "object") {
      const { channel, access } = item as { channel?: unknown; access?: unknown };
      return `channel ${text(channel)} (${access === "read-post" ? "read-post" : "read"})`;
    }
    return `${kind === "role" ? "role" : "capability"} ${text(item)}`;
  });
  const more = body.refused.length - items.length;
  return `the selection exceeds your own access: ${items.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/** Pending, malformed and unconfirmed retirement all keep the saved identity for an exact retry. */
export function conversationRetired(status: number, value: unknown, material: ConversationMaterial): boolean {
  const body = object(value);
  if (body.v !== 1 || body.actor !== material.actor || body.lifecycleUid !== material.lifecycleUid)
    throw new Error("conversation retirement response does not match the saved lifecycle");
  if (status === 200 && body.complete === true && body.phase === "terminal") return true;
  if (status === 202 && body.complete === false && typeof body.phase === "string" && body.phase !== "terminal") return false;
  throw new Error("conversation retirement is unconfirmed; its saved identity was retained");
}
