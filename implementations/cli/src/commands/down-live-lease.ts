/** A manager or delivery daemon whose pidfile is gone while its lease is still live.
 *  A daemon that is running keeps renewing, and `down` must not stop the broker under it. A daemon
 *  that exited without releasing, such as one whose broker stalled past its broker-gone window,
 *  leaves a row that nobody renews, so a row counts only once it is written again within the bucket
 *  TTL. A bucket that does not exist, or a broker that does not answer, is not a
 *  live daemon. */
import { existsSync } from "node:fs";
import { jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";

/** Direct Get one KV subject's last value without creating any consumer. `allowEmpty` treats a
 *  DEL/PURGE tombstone as absence instead of an error. */
export async function directKvValue<T>(
  nc: NatsConnection,
  stream: string,
  subject: string,
  allowEmpty = false,
): Promise<T | undefined> {
  const response = await nc.request(
    `$JS.API.STREAM.MSG.GET.${stream}`,
    JSON.stringify({ last_by_subj: subject }),
    { timeout: 5_000 },
  );
  const body = JSON.parse(new TextDecoder().decode(response.data)) as {
    message?: { data?: string; hdrs?: string };
    error?: { description?: string };
  };
  if (body.error) throw new Error(`maintenance inventory read failed: ${body.error.description ?? "JetStream error"}`);
  if (!body.message?.data) {
    const headers = body.message?.hdrs ? Buffer.from(body.message.hdrs, "base64").toString("utf8") : "";
    if (allowEmpty && /^KV-Operation:\s*(?:DEL|PURGE)\s*$/im.test(headers)) return undefined;
    throw new Error(`maintenance inventory is missing ${subject}`);
  }
  return JSON.parse(Buffer.from(body.message.data, "base64").toString("utf8")) as T;
}


import { awaitLeaseExpiry, dialerFor, deliveryBucket, isReachable, LEASE_EXPIRY_GRACE_MS, LEASE_TTL_MS, leaseRemainingMs, MANAGER_LEASE_KEY, MANAGER_LEASE_TTL_MS, managerBucket, standaloneConnectOpts } from "@cotal-ai/core";
import { CommandFailure, findMesh, localProcessPath, type LocalProcess, type LocalProcessContext } from "@cotal-ai/workspace";
import { connectOrExit, userViewAuthOrExit } from "../lib/connect.js";
import { c } from "../ui.js";

/** One KV subject's last row as its revision and broker write time, without creating a consumer.
 *  A missing subject or a DEL/PURGE tombstone is no row. */
async function directKvRow(nc: NatsConnection, stream: string, subject: string): Promise<{ revision: number; created: number } | undefined> {
  const response = await nc.request(`$JS.API.STREAM.MSG.GET.${stream}`, JSON.stringify({ last_by_subj: subject }), { timeout: 5_000 });
  const body = JSON.parse(new TextDecoder().decode(response.data)) as {
    message?: { seq: number; time: string; hdrs?: string };
    error?: { code?: number; description?: string };
  };
  if (body.error?.code === 404) return undefined;
  if (body.error) throw new Error(`lease read failed: ${body.error.description ?? "JetStream error"}`);
  const headers = body.message?.hdrs ? Buffer.from(body.message.hdrs, "base64").toString("utf8") : "";
  if (!body.message || /^KV-Operation:\s*(?:DEL|PURGE)\s*$/im.test(headers)) return undefined;
  return { revision: body.message.seq, created: Date.parse(body.message.time) };
}

export async function refuseLiveUnrecordedDaemons(
  components: readonly LocalProcess[],
  context: LocalProcessContext,
): Promise<void> {
  const live = await liveUnrecordedDaemonNames(components, context);
  if (!live.length) return;
  const them = live.join(" and ");
  throw new CommandFailure(
    "refused",
    "LIFECYCLE_BLOCKED",
    `${them} ${live.length === 1 ? "has" : "have"} no pidfile and ${live.length === 1 ? "is" : "are"} still renewing a lease, so the broker was not stopped`,
    {
      target: { root: context.root, space: context.space, daemons: live },
      remedy: "stop that process, or put its pidfile back, then run `cotal down` again",
    },
  );
}

async function liveUnrecordedDaemonNames(
  components: readonly LocalProcess[],
  context: LocalProcessContext,
): Promise<string[]> {
  // The pidfile is the stop record. A sibling artifact (the delivery-aware marker, a spare
  // capability) can outlive it and must not hide a daemon that is still renewing.
  const watched = components.filter((component) => (component.name === "manager" || component.name === "delivery") && !existsSync(localProcessPath(component.pidFile, context)));
  if (!watched.length) return [];
  const mesh = findMesh(context.space);
  if (!mesh?.server || !(await isReachable(mesh.server))) return [];
  const resolved = await connectOrExit({ space: context.space, server: mesh.server }, "deployer");
  const user = resolved.bearer ? await userViewAuthOrExit(resolved, "deployer") : undefined;
  const nc = await dialerFor(mesh.server)({
    servers: mesh.server,
    ...standaloneConnectOpts({ ...(user ?? { creds: resolved.creds }), tls: resolved.tls }),
    maxReconnectAttempts: 0,
  });
  try {
    const jsm = await jetstreamManager(nc);
    const live = async (label: string, bucket: string, leasePrefix: string | undefined, ttlMs: number): Promise<boolean> => {
      let subjects: string[];
      try {
        const info = await jsm.streams.info(`KV_${bucket}`, { subjects_filter: `$KV.${bucket}.>` });
        subjects = Object.keys(info.state.subjects ?? {});
      } catch (error) {
        if (/stream not found/i.test((error as Error).message)) return false;
        throw error;
      }
      // The manager bucket also holds mesh config. Only a current `lease.<instance>` is a daemon.
      const leases = leasePrefix === undefined ? subjects : subjects.filter((subject) => subject.startsWith(`$KV.${bucket}.${leasePrefix}.`));
      for (const subject of leases) {
        const read = () => directKvRow(nc, `KV_${bucket}`, subject);
        const row = await read();
        if (row === undefined) continue;
        console.error(c.dim(`• ${label} has no pidfile; waiting up to ${Math.ceil((leaseRemainingMs(row.created, ttlMs) + LEASE_EXPIRY_GRACE_MS) / 1000)}s to see whether its lease is renewed`));
        // A row the broker is late to expire but nobody wrote for a whole TTL has no renewer either.
        if (await awaitLeaseExpiry({ read, ...row, ttlMs }) === "rewritten") return true;
      }
      return false;
    };
    const found: string[] = [];
    for (const component of watched) {
      const manager = component.name === "manager";
      const bucket = manager ? managerBucket(context.space) : deliveryBucket(context.space);
      if (await live(component.label, bucket, manager ? MANAGER_LEASE_KEY : undefined, manager ? MANAGER_LEASE_TTL_MS : LEASE_TTL_MS)) found.push(component.label);
    }
    // Both daemons, when both are live. Object key order must not drop the manager behind delivery.
    const order = ["manager", "delivery daemon"];
    return order.filter((label) => found.includes(label)).concat(found.filter((label) => !order.includes(label)));
  } finally {
    await nc.drain().catch(() => {});
  }
}
