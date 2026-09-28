/**
 * `cotal deliver pending <name>` — an operator inspection read over one recipient's DM durable.
 * Never starts the daemon. Answers exactly the question issue #417 asks after a suspected drop:
 * what does the broker hold for this recipient right now. Reads only; never acks, never creates
 * a durable, never claims delivery — the only truthful facts here are what JetStream reports about
 * a consumer that already exists.
 */
import {
  CotalEndpoint,
  dialerFor,
  dmDurable,
  dmStream,
  parsePrincipalKey,
  resolvePeer,
  standaloneConnectOpts,
  unicastSubject,
  type ParsedArgs,
  type Presence,
} from "@cotal-ai/core";
import { connectOrExit } from "@cotal-ai/workspace";
import { jetstream, jetstreamManager, JetStreamApiCodes, JetStreamApiError } from "@nats-io/jetstream";

type Values = { space?: string; server?: string; creds?: string; limit?: string; uid?: string; json?: boolean };

/** A short presence watch, the shape `send.ts` polls: an `offline` card still counts as a resolved
 *  peer (the recipient may be dead, that is exactly what this verb exists to inspect). */
async function pollPresence(ep: CotalEndpoint, target: string): Promise<Presence | undefined> {
  let peer: Presence | undefined;
  for (let i = 0; i < 20 && !peer; i++) {
    peer = resolvePeer(ep.getRoster(), target);
    if (!peer) await new Promise((r) => setTimeout(r, 100));
  }
  return peer;
}

function notFound(name: string, space: string): never {
  console.error(`✗ not-found: no agent "${name}" and no DM durable for it in space ${space}`);
  process.exit(1);
}

export async function runPending(args: ParsedArgs): Promise<void> {
  const values = args.values as Values;
  const name = args.positionals[1];
  if (!name || args.positionals.length > 2) {
    console.error('usage: cotal deliver pending <name> [--limit <n>] [--uid <lifecycle>] [--space <s>] [--server <url>] [--creds <file>]');
    process.exit(1);
  }
  const limit = values.limit ? Number(values.limit) : 20;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    console.error(`✗ --limit must be a positive integer, got ${JSON.stringify(values.limit)}`);
    process.exit(1);
  }

  // Admin-only, static-mesh route (the same route `cotal mint --profile admin` takes): this verb
  // grants no new authority, it rides the existing admin profile's STREAM.INFO/CONSUMER.INFO rows.
  // A user-mode mesh has no equivalent read authority yet (see brief "Maintainer's calls"); refuse
  // naming that rather than widening any other profile.
  const conn = await connectOrExit(values, "admin");
  const { server, space, tls } = conn;

  // Resolve <name> via a short presence watch (offline counts, resolvePeer admits it) unless the
  // card is gone entirely, in which case --uid is the only route to the durable.
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds: conn.creds,
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: true,
    card: { name: "deliver-pending", kind: "endpoint" },
  });
  await ep.start();
  let uid: string | undefined;
  let peer: Presence | undefined;
  try {
    peer = await pollPresence(ep, name);
    uid = peer?.lifecycleUid ?? values.uid;
  } finally {
    await ep.stop();
  }
  if (!uid) notFound(name, space);

  const recip = peer ? parsePrincipalKey(peer.card.id) : undefined;
  // Without a live card (e.g. --uid on a gone lifecycle) the durable's owner/actor tokens must
  // come from the target name itself; a candidate-id read additionally needs owner/actor to filter
  // subjects, so that half is skipped when there is no resolved peer.
  const durable = dmDurable(recip?.owner ?? name, recip?.actor ?? name, uid);
  const stream = dmStream(space);

  const nc = await dialerFor(server)({ servers: server, ...standaloneConnectOpts({ creds: conn.creds, tls }), maxReconnectAttempts: 0 });
  try {
    const jsm = await jetstreamManager(nc);
    let info;
    try {
      info = await jsm.consumers.info(stream, durable);
    } catch (e) {
      if (e instanceof JetStreamApiError && e.code === JetStreamApiCodes.ConsumerNotFound) notFound(name, space);
      throw e;
    }
    const streamInfo = await jsm.streams.info(stream);
    const frontier = Math.max(0, (info.config.opt_start_seq ?? 1) - 1);
    const facts = {
      durable,
      pending: info.num_pending,
      ackPending: info.num_ack_pending,
      delivered: info.delivered.stream_seq,
      ackFloor: info.ack_floor.stream_seq,
      created: info.created,
      frontier,
      max_age: streamInfo.config.max_age,
      max_msgs_per_subject: streamInfo.config.max_msgs_per_subject,
      discard: streamInfo.config.discard,
    };
    if (values.json) {
      console.log(JSON.stringify(facts));
    } else {
      console.log(durable);
      console.log(`pending ${facts.pending}`);
      console.log(`ack-pending ${facts.ackPending}`);
      console.log(`delivered ${facts.delivered}`);
      console.log(`ack-floor ${facts.ackFloor}`);
      console.log(`created ${facts.created}`);
      console.log(`frontier ${facts.frontier}`);
      console.log(`max_age ${facts.max_age} max_msgs_per_subject ${facts.max_msgs_per_subject} discard ${facts.discard}`);
    }

    // Bounded read of recent candidate ids from the ack floor - an ephemeral ordered consumer,
    // never acked, never durable. Not proof of a hole: it names what is there, nothing more.
    if (recip) {
      const js = jetstream(nc);
      const subjects = [unicastSubject(space, recip.owner, recip.actor, "*", "*")];
      const start = facts.ackFloor + 1;
      const consumer = await js.consumers.get(stream, { filter_subjects: subjects, opt_start_seq: start });
      try {
        const cinfo = await consumer.info(true);
        const pendingCandidates = Math.min(cinfo.num_pending, limit);
        console.log("recent candidate ids (from the ack floor; not proof of a hole)");
        if (pendingCandidates > 0) {
          const iter = await consumer.consume({ max_messages: pendingCandidates });
          let seen = 0;
          try {
            for await (const m of iter) {
              const body = JSON.parse(new TextDecoder().decode(m.data)) as { id: string; from: string; ts: number };
              console.log(`  ${body.id}  from=${body.from}  ts=${body.ts}`);
              seen++;
              if (seen >= pendingCandidates) break;
            }
          } finally {
            iter.stop();
          }
        }
      } finally {
        try { await consumer.delete(); } catch { /* ephemeral, best-effort cleanup */ }
      }
    }
  } finally {
    await nc.drain();
  }
}
