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
  isConsumerNotFound,
  parsePrincipalKey,
  resolvePeer,
  standaloneConnectOpts,
  unicastSubject,
  type ParsedArgs,
  type Presence,
} from "@cotal-ai/core";
import { connectOrExit } from "@cotal-ai/workspace";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";

type Values = { space?: string; server?: string; creds?: string; limit?: string; durable?: string; json?: boolean };

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

function notFoundDurable(durable: string, space: string): never {
  console.error(`✗ not-found: no DM durable "${durable}" in space ${space}`);
  process.exit(1);
}

/** Inverse of {@link dmDurable} for the `dm_<owner>-<actor>-<lifecycleUid>` name form. Owner/actor
 *  tokens ban `-` ({@link assertValidOwnerToken}) and the lifecycleUid token is `[a-z0-9]{26,32}`
 *  (also `-`-free), so splitting the part after the well-known `dm_` prefix on `-` is unambiguous
 *  exactly when it yields three parts each matching its own token grammar; anything else (a name
 *  typed by hand, a different durable kind) is reported as unparseable rather than guessed at. */
function parseDmDurable(durable: string): { owner: string; actor: string } | null {
  if (!durable.startsWith("dm_")) return null;
  const parts = durable.slice(3).split("-");
  if (parts.length !== 3) return null;
  const [owner, actor, uid] = parts;
  if (!/^[A-Za-z0-9_]+$/.test(owner) || !/^[A-Za-z0-9_]+$/.test(actor) || !/^[a-z0-9]{26,32}$/.test(uid)) return null;
  return { owner, actor };
}

export async function runPending(args: ParsedArgs): Promise<void> {
  const values = args.values as Values;
  const name = args.positionals[1];
  if (!name || args.positionals.length > 2) {
    console.error('usage: cotal deliver pending <name> [--limit <n>] [--durable <name>] [--space <s>] [--server <url>] [--creds <file>]');
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

  // `<name>` stays required and is only echoed in error text; `--durable` (the exact consumer
  // name a live read prints, via dmDurable/lifecycleNameKey) skips the presence watch entirely so
  // an old lifecycle's held DMs stay reachable once its card is gone from the roster (a same-name
  // respawn's card can never be steered back to a dead lifecycle's owner/actor by name alone).
  let durable: string;
  let recip: { owner: string; actor: string } | undefined;
  if (values.durable) {
    durable = values.durable;
    recip = parseDmDurable(durable) ?? undefined;
  } else {
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
    let peer: Presence | undefined;
    await ep.start();
    try {
      peer = await pollPresence(ep, name);
    } finally {
      await ep.stop();
    }
    if (!peer?.lifecycleUid) notFound(name, space);
    recip = parsePrincipalKey(peer.card.id) ?? undefined;
    durable = dmDurable(recip?.owner ?? name, recip?.actor ?? name, peer.lifecycleUid);
  }
  const stream = dmStream(space);

  const nc = await dialerFor(server)({ servers: server, ...standaloneConnectOpts({ creds: conn.creds, tls }), maxReconnectAttempts: 0 });
  try {
    const jsm = await jetstreamManager(nc);
    let info;
    try {
      info = await jsm.consumers.info(stream, durable);
    } catch (e) {
      if (isConsumerNotFound(e)) {
        if (values.durable) notFoundDurable(durable, space);
        notFound(name, space);
      }
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
    // Needs owner/actor to filter subjects; skipped (and said so) when neither a resolved card
    // nor an unambiguous --durable parse supplied them.
    if (!recip) {
      console.log("recent candidate ids: not read (no resolved card)");
    } else {
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
