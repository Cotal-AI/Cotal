import { CotalEndpoint, channelBucket, credsClaims, isPublishPermissionDenied, presenceBucket, subjectMatches } from "@cotal-ai/core";
import { CommandFailure, endpointAuth, type Connection } from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { connectOrExit, connectOrThrow } from "./connect.js";

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
 *  is the bare stream. An open mesh may, and a user bearer holds no such row. A static credential may
 *  when its own grant allows that subject: the operator credential this machine mints does, and an
 *  agent credential from `cotal auth mint` does not. */
export function batchedRead(conn: Connection, bucket: string): boolean {
  if (conn.bearer !== undefined) return false;
  if (conn.creds === undefined) return true;
  const subject = `$JS.API.DIRECT.GET.KV_${bucket}`;
  const pub = credsClaims(conn.creds).nats?.pub;
  return (pub?.allow ?? []).some((row) => subjectMatches(row, subject)) && !(pub?.deny ?? []).some((row) => subjectMatches(row, subject));
}

/** Open a transient endpoint: it holds the roster and channel registry on return but never registers
 *  itself, binds no inbox, and consumes no channels. The caller stops it. A connection that may read
 *  both buckets with a batched Direct Get ({@link batchedRead}) reads them once, leaving no watch
 *  consumer behind. Any other, such as a user bearer or an agent credential passed with `--creds`,
 *  watches them and waits for the presence replay; the consumer lasts until the broker's inactive
 *  threshold. `watch` keeps both watches for every
 *  credential, for a caller that reports the watch's own state (`cotal who`); that caller waits for
 *  the presence replay itself, on its own bound. `throwOnRefusal` hands connection refusals to the
 *  command kernel, and `report` takes endpoint errors and warnings instead of printing them. A
 *  credential the broker will not let read a bucket is refused with `PERMISSION_DENIED`. */
export async function openTransient(
  values: ConnectValues,
  name: string,
  opts: { throwOnRefusal?: boolean; watch?: boolean; report?: (level: "error" | "warning", e: Error) => void } = {},
): Promise<{ ep: CotalEndpoint; space: string; connection: Connection }> {
  const conn = opts.throwOnRefusal ? await connectOrThrow(values, "operator") : await resolveConnect(values);
  const readOnce = batchedRead(conn, presenceBucket(conn.space)) && batchedRead(conn, channelBucket(conn.space));
  const ep = new CotalEndpoint({
    space: conn.space,
    servers: conn.server,
    ...endpointAuth(conn),
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: true,
    readOnce: readOnce && !opts.watch,
    // Display name only. The wire principal comes from the resolved static credential or user
    // bearer; on an open mesh the endpoint self-mints it. Process environment never supplies
    // authority for an operator command.
    card: { name, kind: "endpoint" },
  });
  const report = opts.report ?? ((level, e) => console.error(level === "error" ? c.red("! " + e.message) : c.yellow("! " + e.message)));
  ep.on("error", (e: Error) => report("error", e));
  ep.on("warning", (e: Error) => report("warning", e));
  try {
    await ep.start();
    if (!readOnce && !opts.watch) await ep.waitForPresenceSnapshot();
  } catch (e) {
    await ep.stop().catch(() => {});
    if (conn.bearer === undefined && !opts.watch && isPublishPermissionDenied(e))
      throw new CommandFailure("refused", "PERMISSION_DENIED", `this identity may not read the presence or channel registry of ${conn.space}: ${(e as Error).message}`, {
        target: { space: conn.space },
        remedy: values.creds === undefined ? `use a credential that may read both in ${conn.space}` : `run it without --creds to use the credential this machine records for ${conn.space}, or use one that may read both`,
      });
    throw e;
  }
  return { ep, space: conn.space, connection: conn };
}
