/**
 * The `artifacts` endpoint as the delivery daemon serves it (artifact plane 5.1): `list` here, and the
 * put, fetch, confirm and pin commands from `artifact-verbs.ts`.
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
import { jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  AmbiguousAclAlias, ARTIFACTS_COMMANDS, ARTIFACTS_CONTRACTS, ARTIFACTS_ENDPOINT, ARTIFACTS_LIST_COMMAND, ARTIFACTS_LIST_PAGE_LIMIT,
  ARTIFACTS_CONFIRM_ATTACH_COMMAND, ARTIFACTS_FETCH_BEGIN_COMMAND, ARTIFACTS_FETCH_CHUNK_COMMAND, ARTIFACTS_PIN_COMMAND,
  ARTIFACTS_PUT_BEGIN_COMMAND, ARTIFACTS_PUT_CHUNK_COMMAND, ARTIFACTS_PUT_COMMIT_COMMAND, type EpCommandDef,
  artifactAttachBucket, artifactBucket, artifactIndexStreamNames, artifactPossessBucket, artifactReserveBucket,
  artifactsClusterArtifacts, assertLifecycleToken, channelInAllow, dialerFor, drainAndClose,
  EpEnvelopeError, liveKvEntries, objectStoreStream, principalKey, standaloneConnectOpts, watchNativeConnection,
  type ArtifactsListInput, type ArtifactsListOutput, type ArtifactsListRow, type EpCaller, type EpServeContext,
  type NativeConnectionBinding,
} from "@cotal-ai/core";
import { ARTIFACT_DATA_CREDS_KIND, ARTIFACT_SWEEPER_CREDS_KIND, daemonEndpointKey } from "@cotal-ai/workspace";
import { attachmentKeyDigest, channelAttachmentsFilter, concreteChannel } from "./artifact-keys.js";
import { ArtifactIndex } from "./artifact-index.js";
import { ArtifactObjects } from "./artifact-objects.js";
import { ArtifactVerbs, DigestLocks, fenceCallerWith } from "./artifact-verbs.js";
import { readChatEntryForConfirm } from "./artifact-chat-read.js";
import { startSweeps, UNCONFIRMED_COMMIT_EVENT } from "./artifact-sweep.js";
import type { DaemonServedEndpoint, ServeScope, StagedStores } from "./endpoint-bind.js";
import type { ServedEndpointContext } from "./served-endpoints.js";

/** How often the lease holder sweeps. The lifetimes it enforces are hours and days long. */
const ARTIFACT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

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

/** Parse one attachment row into a `list` row; a row that does not parse, is not attached, or is
 *  unpinned and past its expiry at `now` is skipped, never listed. */
function listRow(digest: string, raw: unknown, now: number): ArtifactsListRow | undefined {
  const r = raw as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || r.state !== "attached") return undefined;
  const int = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (typeof r.name !== "string" || typeof r.mediaType !== "string" || !int(r.size) || !int(r.createdAt) || typeof r.pinned !== "boolean")
    return undefined;
  if (!r.pinned && (!int(r.expiresAt) || (r.expiresAt as number) <= now)) return undefined;
  return {
    digest, name: r.name, mediaType: r.mediaType, size: r.size, attachedAt: r.createdAt, pinned: r.pinned,
    ...(r.pinned ? {} : { expiresAt: r.expiresAt as number }),
  };
}

/** Build the `artifacts` served endpoint over its store material. */
export function artifactsServedEndpoint(ctx: ServedEndpointContext): DaemonServedEndpoint {
  /** The installed set: what the handlers read and write now. Replaced only by a committed stage. */
  let installed: StoreSet | undefined;
  const locks = new DigestLocks();
  const verbs = new ArtifactVerbs({
    space: ctx.space,
    stores: () => installed,
    fenceCaller: (caller, command) => fenceCallerWith((p) => ctx.delivery.aclForAlias(p), caller, command),
    mayReadChannel: (caller, channel, command) => assertMayReadChannel(ctx.delivery, caller, channel, command),
    readChatEntry: (seq) => readChatEntryForConfirm(ctx.deliveryJsm(), ctx.space, seq),
    locks,
  });
  /** The scope of the bound generation the installed set was installed with: the sweep writes under
   *  its fence, so a quiesce or a lost lease ends every sweep write until the next bind. Set only by
   *  `install`, together with the set, never by `defs` (E19). */
  let sweepScope: ServeScope | undefined;
  const stopSweeps = startSweeps({
    intervalMs: ARTIFACT_SWEEP_INTERVAL_MS, log: ctx.log,
    current: () => {
      const set = installed, scope = sweepScope;
      if (set === undefined || scope === undefined) return undefined;
      return {
        space: ctx.space, nc: set.sweeper.nc, kv: set.sweepKv, locks,
        fence: (what: string) => scope.fence.check(scope.generation, what),
        emit: (event) => ctx.log(`${UNCONFIRMED_COMMIT_EVENT} ${JSON.stringify(event)}`),
      };
    },
  });

  const open = async (label: "artifact-data" | "artifact-sweeper", kind: string): Promise<StoreConn> => {
    const creds = await ctx.store.get(daemonEndpointKey(ctx.space, ARTIFACTS_ENDPOINT, kind));
    if (creds === undefined) throw new Error(`${ARTIFACTS_ENDPOINT}: no ${label} credential in the store; the signer holder has not minted it`);
    const nc = await dialerFor(ctx.servers)({
      servers: ctx.servers, ...standaloneConnectOpts({ creds, tls: ctx.tls }), name: `cotal-delivery-${label}`, maxReconnectAttempts: -1,
    });
    return { creds, nc, native: watchNativeConnection(nc, `delivery ${label} connection`) };
  };

  /** Open a candidate set from the store material and prove it, without touching the installed set
   *  (E12, E13). The proof is one STREAM.INFO per stream the handlers need, each on the credential
   *  that will use it: the three index buckets and the object stream on `artifact-data`, the three
   *  index buckets on `artifact-sweeper`. A missing stream or an under-granted credential refuses here,
   *  before the serve candidate dials. A credential that has not changed reuses its live connection. */
  const stage = async (): Promise<StagedStores> => {
    const opened: NatsConnection[] = [];
    const reuseOrOpen = async (slot: "data" | "sweeper", label: "artifact-data" | "artifact-sweeper", kind: string): Promise<StoreConn> => {
      const current = installed?.[slot];
      const stored = await ctx.store.get(daemonEndpointKey(ctx.space, ARTIFACTS_ENDPOINT, kind));
      if (current !== undefined && stored === current.creds) return current;
      const next = await open(label, kind);
      opened.push(next.nc);
      return next;
    };
    try {
      const data = await reuseOrOpen("data", "artifact-data", ARTIFACT_DATA_CREDS_KIND);
      const sweeper = await reuseOrOpen("sweeper", "artifact-sweeper", ARTIFACT_SWEEPER_CREDS_KIND);
      await proveStreams(data.nc, [...artifactIndexStreamNames(ctx.space), objectStoreStream(artifactBucket(ctx.space))], "artifact-data");
      await proveStreams(sweeper.nc, artifactIndexStreamNames(ctx.space), "artifact-sweeper");
      const kvmData = new Kvm(data.nc);
      const set: StoreSet = {
        data, sweeper,
        attachScan: await new Kvm(sweeper.nc).open(artifactAttachBucket(ctx.space)),
        sweepKv: {
          attach: await new Kvm(sweeper.nc).open(artifactAttachBucket(ctx.space)),
          possess: await new Kvm(sweeper.nc).open(artifactPossessBucket(ctx.space)),
          reserve: await new Kvm(sweeper.nc).open(artifactReserveBucket(ctx.space)),
        },
        index: new ArtifactIndex({
          attach: await kvmData.open(artifactAttachBucket(ctx.space)),
          possess: await kvmData.open(artifactPossessBucket(ctx.space)),
          reserve: await kvmData.open(artifactReserveBucket(ctx.space)),
        }),
        objects: new ArtifactObjects(data.nc, ctx.space),
      };
      return {
        install: (scope) => {
          const previous = installed;
          installed = set;
          sweepScope = scope;
          // Retire only connections the new set does not reuse, after the transition.
          const retiring = [previous?.data, previous?.sweeper].filter((c): c is StoreConn => c !== undefined && c !== set.data && c !== set.sweeper);
          return async () => { for (const conn of retiring) await drainAndClose(conn.nc).catch(() => {}); };
        },
        discard: async () => { for (const nc of opened) await drainAndClose(nc).catch(() => {}); },
      };
    } catch (e) {
      for (const nc of opened) await drainAndClose(nc).catch(() => {});
      throw new Error(`${ARTIFACTS_ENDPOINT}: the store credentials do not prove: ${(e as Error).message}`);
    }
  };

  const list = listHandler(ctx, () => installed?.attachScan);

  return {
    endpoint: ARTIFACTS_ENDPOINT,
    cluster: artifactsClusterArtifacts(),
    stage,
    // Every contract command has its handler (SPEC 13.9). Building them installs nothing (E19).
    defs: (scope) => {
      const handlers: Record<string, EpCommandDef["handler"]> = {
        [ARTIFACTS_LIST_COMMAND]: list(scope),
        [ARTIFACTS_PUT_BEGIN_COMMAND]: verbs.putBegin(scope),
        [ARTIFACTS_PUT_CHUNK_COMMAND]: verbs.putChunk(scope),
        [ARTIFACTS_PUT_COMMIT_COMMAND]: verbs.putCommit(scope),
        [ARTIFACTS_FETCH_BEGIN_COMMAND]: verbs.fetchBegin(scope),
        [ARTIFACTS_FETCH_CHUNK_COMMAND]: verbs.fetchChunk(scope),
        [ARTIFACTS_CONFIRM_ATTACH_COMMAND]: verbs.confirmAttach(scope),
        [ARTIFACTS_PIN_COMMAND]: verbs.pin(scope),
      };
      return ARTIFACTS_COMMANDS.map((command) => {
        const handler = handlers[command];
        if (handler === undefined) throw new Error(`${ARTIFACTS_ENDPOINT}: no handler for contract command ${command}`);
        return { command, contract: ARTIFACTS_CONTRACTS[command]!, handler };
      });
    },
    nativeConnections: () => [
      ...(installed ? [{ label: "artifact-data", binding: installed.data.native.binding() }] : []),
      ...(installed ? [{ label: "artifact-sweeper", binding: installed.sweeper.native.binding() }] : []),
    ],
    sweepGeneration: () => sweepScope?.generation,
    close: async () => {
      stopSweeps();
      sweepScope = undefined;
      verbs.dropStaged();
      const set = installed;
      installed = undefined;
      if (set) for (const conn of [set.data, set.sweeper]) await drainAndClose(conn.nc).catch(() => {});
    },
  };
}

/** The `list` handler: read gate first, then a filtered scan of the channel's attachment rows on the
 *  sweeper connection, paged so the actual reply fits one broker message. */
function listHandler(ctx: ServedEndpointContext, scan: () => KV | undefined) {
  return (scope: ServeScope) => async (sctx: EpServeContext): Promise<ArtifactsListOutput> => {
    const { generation, fence } = scope;
    const args = (sctx.request.args ?? {}) as unknown as ArtifactsListInput;
    let channel: string;
    try { channel = concreteChannel(args.channel); }
    catch (e) { throw notExecuted("bad-request", `list: ${(e as Error).message}`); }
    await assertMayReadChannel(ctx.delivery, sctx.subject.caller, channel, "list");
    fence.check(generation, "the attachment scan");
    const kv = scan();
    if (kv === undefined) throw notExecuted("unavailable", "list: the artifacts store connection is not open; retry");
    if (!sctx.replyFits) throw notExecuted("unavailable", "list: this serving connection cannot measure a reply, so no page is sent");
    const fitsFn = sctx.replyFits;
    const entries = await liveKvEntries(kv, channelAttachmentsFilter(channel));
    // Expiry is applied at READ time (E14): an unpinned row past its expiresAt is not listed even
    // before the sweep turns it into a tombstone.
    const now = Date.now();
    const rows: ArtifactsListRow[] = [];
    for (const e of entries) {
      let digest: string;
      try { digest = attachmentKeyDigest(channel, e.key); } catch { continue; }
      let parsed: unknown;
      try { parsed = e.json(); } catch { continue; }
      const row = listRow(digest, parsed, now);
      if (row !== undefined) rows.push(row);
    }
    rows.sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
    const after = args.after;
    const start = after === undefined ? 0 : rows.findIndex((r) => r.digest > after);
    const remaining = start < 0 ? [] : rows.slice(start);
    const limit = Math.min(args.limit ?? ARTIFACTS_LIST_PAGE_LIMIT, ARTIFACTS_LIST_PAGE_LIMIT);
    const envelope = (candidate: ArtifactsListRow[]): ArtifactsListOutput =>
      candidate.length < remaining.length && candidate.length > 0 ? { rows: candidate, next: candidate[candidate.length - 1].digest } : { rows: candidate };
    // Cut the page until the ACTUAL envelope (rows plus `next`) fits one broker message. A page that
    // will not fit even as one row is the named floor refusal, never an unchecked send (E14).
    let page = remaining.slice(0, limit);
    while (page.length > 0 && !fitsFn(envelope(page), LIST_REPLY_CEILING)) page = page.slice(0, page.length === 1 ? 0 : Math.max(1, Math.floor(page.length / 2)));
    if (page.length === 0 && remaining.length > 0)
      throw notExecuted("failed-precondition", "list: one row does not fit the broker's message limit, so no page can be sent");
    if (!fitsFn(envelope(page), LIST_REPLY_CEILING))
      throw notExecuted("failed-precondition", "list: an empty page does not fit the broker's message limit");
    fence.check(generation, "the list reply");
    return envelope(page);
  };
}

/** One installed or staged set of store connections and the handles bound on them. */
interface StoreSet {
  data: StoreConn;
  sweeper: StoreConn;
  attachScan: KV;
  /** The three index buckets on the sweeper connection: scans, deletes and tombstones only. */
  sweepKv: { attach: KV; possess: KV; reserve: KV };
  index: ArtifactIndex;
  objects: ArtifactObjects;
}

/** One STREAM.INFO per stream, on this connection: each proves the stream exists and this credential may
 *  reach it. The first failure names the stream. */
async function proveStreams(nc: NatsConnection, streams: readonly string[], label: string): Promise<void> {
  const jsm = await jetstreamManager(nc, { checkAPI: false });
  for (const stream of streams) {
    try { await jsm.streams.info(stream); }
    catch (e) { throw new Error(`${label} cannot read stream ${stream} (${(e as Error).message})`); }
  }
}
