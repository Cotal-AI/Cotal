// The dashboard's operator posting, moved verbatim from web.ts: the posting decision, the operator
// credential, the poster and `POST /api/send`. web.ts re-exports the public names.
import { randomUUID } from "node:crypto";
import {
  CotalEndpoint,
  credsClaims,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  mentionsIn,
  type SpaceAuth,
} from "@cotal-ai/core";
import { c } from "@cotal-ai/workspace";
import {
  BadRequest,
  PayloadTooLarge,
  BrokerRefused,
  quoteForOperator,
  escapeForOperator,
  canonicalChannel,
} from "./web-request.js";

/** What the dashboard can post as, decided once at startup and reported in `/api/meta`. A
 *  `participant` posts as one operator for the life of the process and joins the roster on its
 *  first post, on open and static-auth meshes alike. */
export type PostCapability =
  | { mode: "participant" }
  | { mode: "off"; reason: string };
/** Why posting is off on a dashboard started with `--creds`: the file is the only credential it
 *  holds, and it has no seed to mint an operator from. */
export const POST_OFF_CREDS = "This dashboard was started with --creds, which can only read.";
/** Why posting is off on a per-user sign-in mesh. */
export const POST_OFF_USER = "Posting from the dashboard isn't available on a sign-in mesh yet. Use `cotal send`.";
/** Why posting is off on a dashboard run as a service: the service holds a read-only credential. */
export const POST_OFF_SERVICE = "This dashboard runs as a read-only service. Use `cotal send`.";

/** The operator credential's lifetime: 24 days. Core arms a reconnect fence with one `setTimeout`
 *  at the credential's expiry, and Node caps a timer at 2^31-1 ms (about 24.8 days), so a longer
 *  credential turns library reconnect off 1 ms after every connect. */
export const OPERATOR_TTL_SECONDS = 24 * 24 * 3600;

/** The posting decision. `--creds` wins: a raw credential file is all such a dashboard holds. */
export function postCapability(creds: string | undefined, userMode: boolean): PostCapability {
  if (creds !== undefined) return { mode: "off", reason: POST_OFF_CREDS };
  if (userMode) return { mode: "off", reason: POST_OFF_USER };
  return { mode: "participant" };
}

/** The static-mesh operator: its credential, the lifecycle uid its presence registers under, and
 *  the credential's expiry in epoch milliseconds, read from the credential itself. */
export interface OperatorCred { creds: string; lifecycleUid: string; expiresAt: number }

/** Mints the operator for a static-auth mesh with one new identity. Called once, from
 *  {@link connectWithoutSeed}, so every post the process makes carries that one `from.id` and an
 *  agent's replies land in one DM thread. With `consume: false` the uid names no broker resources,
 *  so it needs no provisioning. */
export async function mintOperatorCred(auth: SpaceAuth): Promise<OperatorCred> {
  const creds = await mintCreds(auth, newIdentity(), "operator", { expiresInSeconds: OPERATOR_TTL_SECONDS });
  const exp = credsClaims(creds).exp;
  if (exp === undefined) throw new Error("the operator credential was minted without an expiry");
  return { creds, lifecycleUid: mintLifecycleUid(), expiresAt: exp * 1000 };
}

/** The dashboard's one posting endpoint, built at startup and started on the first post. */
export interface OperatorPoster {
  /** The id the operator posts as, once it is known: from startup on a static mesh, whose
   *  credential names it, and from the first post on an open mesh. */
  operatorId(): string | undefined;
  /** Starts the endpoint once. Concurrent first posts share one start. A failed start is stopped
   *  and dropped, so the next post tries again under the same id. Rejects once the poster has
   *  stopped. */
  ensure(): Promise<CotalEndpoint>;
  /** Whether the operator credential has expired, so a refused post can say why. Never on an open
   *  mesh, which has no credential. */
  expired(): boolean;
  /** Stops the endpoint if it started, so the operator leaves an offline record, and closes the
   *  poster: a start still in flight stops what it started, and a later post is refused. */
  stop(): Promise<void>;
}

/** What `ensure()` rejects with once the poster has stopped. */
export const POSTER_STOPPED = "the dashboard is shutting down, so it no longer posts";

/** Why a post is refused once the operator credential has expired. */
export const POST_OFF_EXPIRED = "The operator credential expired. Restart cotal web to post again.";

/** What `POST /api/send` answers for a post that went out. `seq` is a DM's stored sequence, the
 *  broker's proof that it kept the message; a channel post has none. */
export interface SendAnswer { ok: true; id: string; operatorId: string; seq?: number }

/** `POST /api/send`: posts the body `{kind: "msg", channel, text}` to one channel, or
 *  `{kind: "dm", to, text}` to one roster member, as the operator. Separate from the handler so the
 *  refusals that need a stopped or expired poster can be driven with one.
 *
 *  The body is read before any refusal, so the size cap bounds what a refused post costs: a reply
 *  written over an unread body leaves Node draining the rest of it to keep the connection. Every
 *  check runs before the poster starts, so a refused post never puts the operator on the roster.
 *  Throws `PayloadTooLarge`, `BadRequest` and `BrokerRefused` for the request frame to answer. */
export async function sendAsOperator(
  post: PostCapability,
  poster: OperatorPoster | undefined,
  onRoster: (id: string) => boolean,
  readRequest: () => Promise<unknown>,
): Promise<{ status: number; body: SendAnswer | { error: string } }> {
  const read = await readRequest().then(
    (value) => ({ value }),
    (e: unknown) => {
      if (e instanceof PayloadTooLarge) throw e;
      return undefined;
    },
  );
  if (post.mode === "off") return { status: 403, body: { error: post.reason } };
  if (!poster) throw new Error("posting is on but no operator poster was built");
  if (poster.expired()) return { status: 403, body: { error: POST_OFF_EXPIRED } };
  const body = read?.value;
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("the request body must be a JSON object");
  const { kind, channel, to, text: raw } = body as Record<string, unknown>;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) throw new BadRequest("text required");
  let target: { channel: string } | { to: string };
  if (kind === "msg") {
    if (typeof channel !== "string") throw new BadRequest("channel required");
    const name = canonicalChannel(channel);
    if (name.includes("*") || name.includes(">")) throw new BadRequest(`${quoteForOperator(name)} is not one channel`);
    target = { channel: name };
  } else if (kind === "dm") {
    if (typeof to !== "string") throw new BadRequest("to required");
    if (!onRoster(to)) throw new BadRequest(`no agent with id ${quoteForOperator(to)} is on the roster`);
    target = { to };
  } else throw new BadRequest('kind must be "msg" or "dm"');

  let sender: CotalEndpoint;
  try {
    sender = await poster.ensure();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (why === POSTER_STOPPED) return { status: 503, body: { error: why } };
    throw new BrokerRefused(escapeForOperator(why));
  }
  const refused = (e: unknown): never => {
    throw new BrokerRefused(escapeForOperator(e instanceof Error ? e.message : String(e)));
  };
  if ("channel" in target) {
    const msg = await sender.multicast(text, { channel: target.channel, mentions: mentionsIn(text) }).catch(refused);
    return { status: 200, body: { ok: true, id: msg.id, operatorId: sender.card.id } };
  }
  const { msg, ack } = await sender.unicastAttributed(target.to, text).catch(refused);
  return { status: 200, body: { ok: true, id: msg.id, operatorId: sender.card.id, seq: ack.seq } };
}

/** Builds the operator poster: a presence-registering endpoint with the card
 *  `{ name: "operator", role: "operator", kind: "endpoint" }`, on the static operator credential
 *  when there is one. The id is fixed here. The credential names it on a static mesh, and an open
 *  mesh pins one, so a start retried after a failure keeps it. */
export function operatorPoster(target: { space: string; server: string; tls: boolean }, operator: OperatorCred | undefined): OperatorPoster {
  const card = { ...(operator ? {} : { id: randomUUID().replace(/-/g, "") }), name: "operator", role: "operator", kind: "endpoint" as const };
  const build = (): CotalEndpoint => {
    const e = new CotalEndpoint({
      space: target.space,
      servers: target.server,
      tls: target.tls,
      ...(operator ? { creds: operator.creds, lifecycleUid: operator.lifecycleUid } : {}),
      card,
      channels: [],
      consume: false,
      registerPresence: true,
      watchPresence: false,
    });
    e.on("error", (err: Error) => console.error(c.red("! operator: " + err.message)));
    e.on("warning", (err: Error) => console.error(c.yellow("! operator: " + err.message)));
    return e;
  };
  let endpoint = build();
  let live: CotalEndpoint | undefined;
  let starting: Promise<CotalEndpoint> | undefined;
  let closed = false;
  const start = async (): Promise<CotalEndpoint> => {
    const e = endpoint;
    try {
      await e.start();
    } catch (err) {
      // Dropped quietly, the way the console drops a peer that never started, and stopped before
      // the next post may start its successor, so this one's offline record cannot land after the
      // successor's online one.
      e.removeAllListeners("error");
      e.removeAllListeners("warning");
      e.on("error", () => {});
      await e.stop().catch(() => undefined);
      endpoint = build();
      starting = undefined;
      throw err;
    }
    if (closed) {
      await e.stop();
      throw new Error(POSTER_STOPPED);
    }
    return (live = e);
  };
  return {
    operatorId: () => (operator || live ? endpoint.card.id : undefined),
    ensure() {
      if (closed) return Promise.reject(new Error(POSTER_STOPPED));
      starting ??= start();
      return starting;
    },
    expired: () => operator !== undefined && Date.now() >= operator.expiresAt,
    async stop() {
      closed = true;
      await starting?.catch(() => undefined);
      await live?.stop();
    },
  };
}
