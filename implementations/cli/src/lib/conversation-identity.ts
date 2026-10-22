import { assertLifecycleToken, eventChannel, principalKey } from "@cotal-ai/core";
import { checkUserBundle, discoveryDocumentUrl, type MeshTarget, type UserBundle } from "@cotal-ai/workspace";

export interface ConversationAuthority {
  url: string;
  bundle: UserBundle;
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
  const capability = JSON.parse(raw)?.cloudCapabilities?.conversationIdentity;
  if (capability?.version !== 1 || typeof capability.url !== "string")
    throw new Error("the selected mesh does not advertise conversation identity v1; no identity was requested");
  const authority = secureUrl(capability.url);
  if (authority.origin !== url.origin || authority.pathname !== `/api/spaces/${encodeURIComponent(target.space)}/conversation-identities` || authority.search)
    throw new Error("conversation identity authority does not name the selected origin and space");
  return { url: authority.href, bundle };
}

export interface ConversationMaterial {
  v: 1;
  requestId: string;
  space: string;
  owner: string;
  actor: string;
  lifecycleUid: string;
  grant: { scope: []; role: null; allowSubscribe: []; allowPublish: [string]; subscribe: [] };
  policy?: { events: "required" };
  sentinelCreds: string;
  exchangeUrl: string;
  retire: { url: string };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid conversation identity response");
  return value as Record<string, unknown>;
}

function empty(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function secureUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.href !== value)
    throw new Error("conversation identity URL must be canonical HTTPS without userinfo or a fragment");
  return url;
}

/** A successful HTTP status is not authority: require the accepted event-only grant and exact pins. */
export function checkConversationMaterial(value: unknown, authority: ConversationAuthority, requestId: string): ConversationMaterial {
  const body = object(value);
  const known = ["v", "requestId", "space", "owner", "actor", "lifecycleUid", "grant", "policy", "sentinelCreds", "exchangeUrl", "retire"];
  if (Object.keys(body).some((key) => !known.includes(key)) || body.v !== 1 || body.requestId !== requestId ||
      body.space !== authority.bundle.space || typeof body.owner !== "string" || typeof body.actor !== "string" ||
      !/^pa_[a-z2-7]{26}$/.test(body.actor) || typeof body.lifecycleUid !== "string")
    throw new Error("conversation identity response does not match the saved request");
  principalKey(body.owner, body.actor);
  assertLifecycleToken(body.lifecycleUid);
  const channel = eventChannel({ owner: body.owner, actor: body.actor });
  const grant = object(body.grant);
  if (Object.keys(grant).length !== 5 || !empty(grant.scope) || grant.role !== null || !empty(grant.allowSubscribe) ||
      !empty(grant.subscribe) || !Array.isArray(grant.allowPublish) || grant.allowPublish.length !== 1 || grant.allowPublish[0] !== channel)
    throw new Error("conversation identity grant is not the exact own-event-only grant");
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

/** Pending, malformed and unconfirmed retirement all keep the saved identity for an exact retry. */
export function conversationRetired(status: number, value: unknown, material: ConversationMaterial): boolean {
  const body = object(value);
  if (body.v !== 1 || body.actor !== material.actor || body.lifecycleUid !== material.lifecycleUid)
    throw new Error("conversation retirement response does not match the saved lifecycle");
  if (status === 200 && body.complete === true && body.phase === "terminal") return true;
  if (status === 202 && body.complete === false && typeof body.phase === "string" && body.phase !== "terminal") return false;
  throw new Error("conversation retirement is unconfirmed; its saved identity was retained");
}
