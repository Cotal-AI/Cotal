/**
 * The `artifacts` endpoint as the delivery daemon serves it (artifact plane 5.1). This revision serves
 * `list`; the put, fetch, confirm and pin commands join it at checkpoint 2.
 *
 * Connections (plan section 1). The serve connection is pure rails (`endpoint-bind.ts`). The handlers
 * use two more, each on its own daemon-only credential the signer holder minted:
 *  - `artifact-data`: point reads and writes of index rows by validated key, and the object store's
 *    chunk and meta subjects. Unused by `list`; opened here so a bind proves it authenticates;
 *  - `artifact-sweeper`: completeness-proven scans of the index buckets (an ordered consumer on the
 *    primary, leader-served). `list` pages one channel with it.
 * The live read ACL rides the daemon's own delivery connection, which holds the ACL KV read.
 *
 * Caller fence (S5): the subject caller's lifecycle token must be the one the live ACL row for its
 * alias names; anything else is the collapsed refusal. Read gate (S7, `readHistory`'s rule): the
 * channel must be in BOTH the live `allowSubscribe` and the mint-time ceiling. The gate runs before
 * any index read, and every refusal before an effect says `not-executed`.
 */
import { Kvm, type KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  AmbiguousAclAlias, ARTIFACTS_CONTRACTS, ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, ARTIFACTS_LIST_PAGE_LIMIT,
  artifactAttachBucket, artifactsClusterArtifacts, assertLifecycleToken, channelInAllow, dialerFor, drainAndClose,
  EpEnvelopeError, liveKvEntries, principalKey, standaloneConnectOpts, watchNativeConnection,
  type ArtifactsListInput, type ArtifactsListOutput, type ArtifactsListRow, type EpCaller, type EpServeContext,
  type NativeConnectionBinding,
} from "@cotal-ai/core";
import { ARTIFACT_DATA_CREDS_KIND, ARTIFACT_SWEEPER_CREDS_KIND, daemonEndpointKey } from "@cotal-ai/workspace";
import { attachmentKeyDigest, channelAttachmentsFilter, concreteChannel } from "./artifact-keys.js";
import type { DaemonServedEndpoint, ServeScope } from "./endpoint-bind.js";
import type { ServedEndpointContext } from "./served-endpoints.js";

/** The largest `list` reply this handler builds. The broker's own payload limit still applies. */
const LIST_REPLY_CEILING = 512 * 1024;

/** One store connection opened from the store material: re-dialed only when the credential changed. */
interface StoreConn {
  creds: string;
  nc: NatsConnection;
  native: { binding(): NativeConnectionBinding };
}

/** A refusal before any effect. */
const notExecuted = (code: "permission-denied" | "bad-request" | "unavailable" | "failed-precondition", message: string): EpEnvelopeError =>
  new EpEnvelopeError(code, message, undefined, "not-executed");

/** The caller fence (S5) and the read gate for one channel (S7). Collapsed: a caller learns only that
 *  it may not read the channel, never which half failed. */
export async function assertMayReadChannel(
  delivery: ServedEndpointContext["delivery"],
  caller: EpCaller,
  channel: string,
  command: string,
): Promise<void> {
  const refused = notExecuted("permission-denied", `${command}: not authorized for that channel`);
  let uid: string;
  try { uid = assertLifecycleToken(caller.uid, "lifecycleUid"); } catch { throw refused; }
  let acl: Awaited<ReturnType<typeof delivery.aclForAlias>>;
  try {
    acl = await delivery.aclForAlias(principalKey(caller.owner, caller.actor).key);
  } catch (e) {
    if (e instanceof AmbiguousAclAlias)
      throw notExecuted("failed-precondition", `${command}: two live lifecycles hold your alias; an operator must retire one`);
    throw notExecuted("unavailable", `${command}: the read ACL is unreadable right now; retry`);
  }
  if (acl === undefined || acl.lifecycleUid !== uid) throw refused;
  if (!channelInAllow(acl.allowSubscribe, channel) || !channelInAllow(acl.issuedAllowSubscribe, channel)) throw refused;
}

/** Parse one attachment row into a `list` row; a row that does not parse is skipped, never listed. */
function listRow(digest: string, raw: unknown): ArtifactsListRow | undefined {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || r.state !== "attached") return undefined;
  const int = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (typeof r.name !== "string" || typeof r.mediaType !== "string" || !int(r.size) || !int(r.createdAt) || typeof r.pinned !== "boolean")
    return undefined;
  if (!r.pinned && !int(r.expiresAt)) return undefined;
  return {
    digest, name: r.name, mediaType: r.mediaType, size: r.size, attachedAt: r.createdAt, pinned: r.pinned,
    ...(r.pinned ? {} : { expiresAt: r.expiresAt as number }),
  };
}

/** Build the `artifacts` served endpoint over its store material. */
export function artifactsServedEndpoint(ctx: ServedEndpointContext): DaemonServedEndpoint {
  const conns: { data?: StoreConn; sweeper?: StoreConn } = {};
  let attachScan: KV | undefined;

  const open = async (label: "artifact-data" | "artifact-sweeper", kind: string): Promise<StoreConn> => {
    const creds = await ctx.store.get(daemonEndpointKey(ctx.space, ARTIFACTS_ENDPOINT, kind));
    if (creds === undefined) throw new Error(`${ARTIFACTS_ENDPOINT}: no ${label} credential in the store; the signer holder has not minted it`);
    const nc = await dialerFor(ctx.servers)({
      servers: ctx.servers, ...standaloneConnectOpts({ creds, tls: ctx.tls }), name: `cotal-delivery-${label}`, maxReconnectAttempts: -1,
    });
    return { creds, nc, native: watchNativeConnection(nc, `delivery ${label} connection`) };
  };
  /** Swap to a re-minted credential: dial the new one and bind what it serves first, and only then
   *  publish it and close the old one, so a failed dial or bind leaves the last-good connection in use.
   *  Store credentials carry no epoch, so a store connection on a newer credential serves a last-good
   *  serve connection unchanged. */
  const refresh = async (slot: "data" | "sweeper", label: "artifact-data" | "artifact-sweeper", kind: string): Promise<boolean> => {
    const current = conns[slot];
    const stored = await ctx.store.get(daemonEndpointKey(ctx.space, ARTIFACTS_ENDPOINT, kind));
    if (current !== undefined && stored === current.creds) return false;
    const next = await open(label, kind);
    let scan: KV | undefined;
    if (slot === "sweeper") {
      try { scan = await new Kvm(next.nc).open(artifactAttachBucket(ctx.space)); }
      catch (e) { await drainAndClose(next.nc).catch(() => {}); throw e; }
    }
    conns[slot] = next;
    if (scan !== undefined) attachScan = scan;
    if (current) await drainAndClose(current.nc).catch(() => {});
    return true;
  };

  const list = (scope: ServeScope) => async (sctx: EpServeContext): Promise<ArtifactsListOutput> => {
    const { generation, fence } = scope;
    const args = (sctx.request.args ?? {}) as unknown as ArtifactsListInput;
    let channel: string;
    try { channel = concreteChannel(args.channel); }
    catch (e) { throw notExecuted("bad-request", `list: ${(e as Error).message}`); }
    await assertMayReadChannel(ctx.delivery, sctx.subject.caller, channel, "list");
    fence.check(generation, "the attachment scan");
    const kv = attachScan;
    if (kv === undefined) throw notExecuted("unavailable", "list: the artifacts store connection is not open; retry");
    const entries = await liveKvEntries(kv, channelAttachmentsFilter(channel));
    const rows: ArtifactsListRow[] = [];
    for (const e of entries) {
      let digest: string;
      try { digest = attachmentKeyDigest(channel, e.key); } catch { continue; }
      let parsed: unknown;
      try { parsed = e.json(); } catch { continue; }
      const row = listRow(digest, parsed);
      if (row !== undefined) rows.push(row);
    }
    rows.sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
    const after = args.after;
    const start = after === undefined ? 0 : rows.findIndex((r) => r.digest > after);
    const remaining = start < 0 ? [] : rows.slice(start);
    const limit = Math.min(args.limit ?? ARTIFACTS_LIST_PAGE_LIMIT, ARTIFACTS_LIST_PAGE_LIMIT);
    let page = remaining.slice(0, limit);
    const fits = (candidate: ArtifactsListRow[]): boolean => {
      const more = candidate.length < remaining.length;
      const out: ArtifactsListOutput = more && candidate.length > 0 ? { rows: candidate, next: candidate[candidate.length - 1].digest } : { rows: candidate };
      return sctx.replyFits ? sctx.replyFits(out, LIST_REPLY_CEILING) : true;
    };
    // Cut the page until it fits one broker message; one row always fits a sane broker.
    while (page.length > 1 && !fits(page)) page = page.slice(0, Math.max(1, Math.floor(page.length / 2)));
    fence.check(generation, "the list reply");
    const more = page.length < remaining.length;
    return more && page.length > 0 ? { rows: page, next: page[page.length - 1].digest } : { rows: page };
  };

  return {
    endpoint: ARTIFACTS_ENDPOINT,
    cluster: artifactsClusterArtifacts(),
    prepare: async () => {
      await refresh("data", "artifact-data", ARTIFACT_DATA_CREDS_KIND);
      await refresh("sweeper", "artifact-sweeper", ARTIFACT_SWEEPER_CREDS_KIND);
    },
    defs: (scope) => [{ command: ARTIFACTS_LIST_COMMAND, contract: ARTIFACTS_CONTRACTS[ARTIFACTS_LIST_COMMAND]!, handler: list(scope) }],
    nativeConnections: () => [
      ...(conns.data ? [{ label: "artifact-data", binding: conns.data.native.binding() }] : []),
      ...(conns.sweeper ? [{ label: "artifact-sweeper", binding: conns.sweeper.native.binding() }] : []),
    ],
    close: async () => {
      const { data, sweeper } = conns;
      conns.data = undefined;
      conns.sweeper = undefined;
      attachScan = undefined;
      await Promise.all([data, sweeper].map((c) => (c ? drainAndClose(c.nc).catch(() => {}) : undefined)));
    },
  };
}
