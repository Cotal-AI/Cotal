import { CotalEndpoint, channelBucket, credsClaims, isPublishPermissionDenied, mintCreds, newIdentity, presenceBucket, subjectMatches } from "@cotal-ai/core";
import { CommandFailure, endpointAuth, type Connection } from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { connectOrExit, connectOrThrow } from "./connect.js";
import { brokerStoreWrite, storeWriteRepair } from "./broker-store-health.js";
import { chatStreamGone, streamsAbsent } from "./space-streams.js";
import { DIAL_TIMEOUT_MS, DialNotAdmitted, dialWithRetry, notAdmittedRefusal } from "./dial-retry.js";

/**
 * A one-shot, write-capable connection for the headless commands that touch the live mesh
 * (`dm`/`msg`/`ask`, and `personas list --running`). Resolution + creds + reachability all go through
 * the shared `connectOrExit` (so these work from any directory, and an explicit `--creds` is a raw
 * off-registry connection). Opens a transient endpoint that never joins the roster, does the one
 * thing, stops. USER-mode meshes ride the same call: `connectOrExit` hands back bearer + sentinel
 * and {@link endpointAuth} spreads whichever material arrived.
 */

export interface ConnectValues {
  space?: string;
  server?: string;
  creds?: string;
}

/** Resolve where to connect + with what credentials (`--creds` → raw off-registry; user-auth mesh →
 *  login/bearer material; else the running mesh's minted least-privilege OPERATOR creds — self-scoped
 *  publish + presence/channel read, no broad manager). Fail-loud — an unresolved registry or an
 *  unreachable/auth-mismatched broker exits with one sentence, never degrades. */
export async function resolveConnect(values: ConnectValues): Promise<Connection> {
  return connectOrExit(values, "operator");
}

/** Whether this connection may read a KV bucket with one batched Direct Get, whose request subject
 *  is the bare stream. An open mesh may. A user bearer may: the auth service mints its connection
 *  with the agent profile, which carries that read on the presence bucket and the channel registry.
 *  A static credential may when its own grant allows that subject: the operator credential this
 *  machine mints and an agent credential from `cotal auth mint` do. */
export function batchedRead(conn: Connection, bucket: string): boolean {
  if (conn.creds === undefined) return true;
  const subject = `$JS.API.DIRECT.GET.KV_${bucket}`;
  const pub = credsClaims(conn.creds).nats?.pub;
  return (pub?.allow ?? []).some((row) => subjectMatches(row, subject)) && !(pub?.deny ?? []).some((row) => subjectMatches(row, subject));
}

/** A JetStream request that no responder answered: the stream it names is not on the broker, or the
 *  broker's JetStream is stopped. */
function noResponders(e: unknown): boolean {
  return e instanceof Error && e.name === "JetStreamStatusError" && String((e as { code?: unknown }).code) === "503";
}

/** Whether the chat stream of `conn`'s space is gone, asked over a connection of its own that reads
 *  nothing else: an endpoint whose start failed keeps no connection to ask on. The stream's info is
 *  an observer's read, which a sender may not ask, so this machine mints an observer from the
 *  space's trust material as `status` does; without it the connection's own credential asks. A
 *  connection that cannot start or ask answers no. */
async function chatStreamGoneAt(conn: Connection): Promise<boolean> {
  let probe: CotalEndpoint | undefined;
  try {
    const id = newIdentity();
    const auth = conn.auth ? { creds: await mintCreds(conn.auth, id, "observer"), ...(conn.tls ? { tls: true } : {}) } : endpointAuth(conn);
    probe = new CotalEndpoint({ space: conn.space, servers: conn.server, ...auth, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false, card: { ...(conn.auth ? { id: id.id } : {}), name: "stream-probe", kind: "endpoint" } });
    probe.on("error", () => {});
    probe.on("warning", () => {});
    await probe.start();
    return await chatStreamGone(probe);
  } catch {
    return false;
  } finally {
    await probe?.stop().catch(() => {});
  }
}

/** The refusal for a space whose broker answered no read of it while its chat stream was not found
 *  missing. nats-server stops JetStream after a store write it could not make and keeps the streams in
 *  its store, so the write failure this machine's broker logged names the cause and the repair. */
function jetStreamUnanswered(conn: Connection): CommandFailure {
  const failed = conn.root ? brokerStoreWrite(conn.root, conn.space) : undefined;
  if (failed?.state === "write-failed")
    return new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the broker of ${conn.space} has answered no JetStream request since it logged a store write failure at ${failed.at}: ${failed.cause}${failed.path ? ` (${failed.path})` : ""}; nats-server stops JetStream after such a write and keeps the streams and their history in its store`, {
      target: { space: conn.space },
      remedy: `${storeWriteRepair(failed, conn.root, conn.space)}, then restart the broker with \`cotal down --yes\` and \`cotal up\` in ${conn.root}, which keeps the history`,
    });
  return new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the broker of ${conn.space} answered no JetStream read, and the space's streams were not found missing`, { target: { space: conn.space }, remedy: "run `cotal status`, which names a store write failure its broker logged on this machine" });
}

/** Open a transient endpoint: it holds the roster and channel registry on return but never registers
 *  itself, binds no inbox, and consumes no channels. The caller stops it. A connection that may read
 *  both buckets with a batched Direct Get ({@link batchedRead}) reads them once, leaving no watch
 *  consumer behind. Any other, such as a user bearer or an agent credential passed with `--creds`,
 *  watches them and waits for the presence replay; the consumer lasts until the broker's inactive
 *  threshold. `presenceOnly` holds the roster alone and opens no channel registry, so only the
 *  presence bucket's grant decides whether it is read once. `watch` keeps both watches for every
 *  credential, for a caller that reports the watch's own state (`cotal who`); that caller waits for
 *  the presence replay itself, on its own bound. `throwOnRefusal` hands connection refusals to the
 *  command kernel, and `report` takes endpoint errors and warnings instead of printing them. A
 *  credential the broker will not let read a bucket is refused with `PERMISSION_DENIED`. */
export async function openTransient(
  values: ConnectValues,
  name: string,
  opts: { throwOnRefusal?: boolean; watch?: boolean; presenceOnly?: boolean; report?: (level: "error" | "warning", e: Error) => void } = {},
): Promise<{ ep: CotalEndpoint; space: string; connection: Connection }> {
  const conn = opts.throwOnRefusal ? await connectOrThrow(values, "operator") : await resolveConnect(values);
  const readOnce = batchedRead(conn, presenceBucket(conn.space)) && batchedRead(conn, channelBucket(conn.space));
  const once = !opts.watch && (opts.presenceOnly ? batchedRead(conn, presenceBucket(conn.space)) : readOnce);
  const report = opts.report ?? ((level, e) => console.error(level === "error" ? c.red("! " + e.message) : c.yellow("! " + e.message)));
  // A connect the broker refuses or does not complete in time sends nothing, so it is tried again
  // with a new endpoint. What a failed attempt reported is dropped with it; a failure after the
  // connection opened is not retried and reaches the handling below as it was.
  let ep!: CotalEndpoint;
  try {
    ep = await dialWithRetry(async () => {
      let opened = false;
      const held: ["error" | "warning", Error][] = [];
      const attempt = new CotalEndpoint({
        space: conn.space,
        servers: conn.server,
        ...endpointAuth(conn),
        channels: [],
        consume: false,
        registerPresence: false,
        watchPresence: true,
        watchChannels: !opts.presenceOnly,
        readOnce: once,
        transportConnectTimeoutMs: DIAL_TIMEOUT_MS,
        onConnection: () => { opened = true; },
        // Display name only. The wire principal comes from the resolved static credential or user
        // bearer; on an open mesh the endpoint self-mints it. Process environment never supplies
        // authority for an operator command.
        card: { name, kind: "endpoint" },
      });
      attempt.on("error", (e: Error) => { if (opened) report("error", e); else held.push(["error", e]); });
      attempt.on("warning", (e: Error) => { if (opened) report("warning", e); else held.push(["warning", e]); });
      try {
        await attempt.start();
        if (!once && !opts.watch) await attempt.waitForPresenceSnapshot();
      } catch (e) {
        await attempt.stop().catch(() => {});
        throw opened ? new AfterOpen(e) : e;
      }
      for (const [level, e] of held) report(level, e);
      return attempt;
    });
  } catch (raw) {
    if (raw instanceof DialNotAdmitted) throw notAdmittedRefusal(raw, `space "${conn.space}"`, "nothing was sent", { space: conn.space }, conn.mode === "user");
    const e = raw instanceof AfterOpen ? raw.cause : raw;
    if (conn.bearer === undefined && !opts.watch && isPublishPermissionDenied(e))
      throw new CommandFailure("refused", "PERMISSION_DENIED", `this identity may not read the presence or channel registry of ${conn.space}: ${(e as Error).message}`, {
        target: { space: conn.space },
        remedy: values.creds === undefined ? `use a credential that may read both in ${conn.space}` : `run it without --creds to use the credential this machine records for ${conn.space}, or use one that may read both`,
      });
    // The user's connection is minted by the space's auth service. One that refuses the batched read
    // predates the agent profile row that grants it; the command never falls back to a watch.
    if (conn.bearer !== undefined && once && isPublishPermissionDenied(e))
      throw new CommandFailure("refused", "PERMISSION_DENIED", `the connection the auth service of ${conn.space} minted for your user may not read ${opts.presenceOnly ? "the presence bucket" : "the presence bucket or the channel registry"} with one batched read: ${(e as Error).message}`, {
        target: { space: conn.space },
        remedy: `update the auth service of ${conn.space} to a release whose agent profile grants $JS.API.DIRECT.GET.KV_${(opts.presenceOnly ? presenceBucket : channelBucket)(conn.space)}`,
      });
    // A one-time read is a Direct Get, which nothing answers when the bucket's stream is gone, and
    // nothing answers either while the broker's JetStream is stopped, as nats-server stops it after a
    // store write it could not make. Only the chat stream's own not-found says the streams are gone.
    if (once && noResponders(e)) throw await chatStreamGoneAt(conn) ? streamsAbsent(conn) : jetStreamUnanswered(conn);
    throw e;
  }
  return { ep, space: conn.space, connection: conn };
}

/** A failure after the transient endpoint's connection opened, which is not a refused or timed-out
 *  connect and is not retried. */
class AfterOpen extends Error {
  constructor(override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}
