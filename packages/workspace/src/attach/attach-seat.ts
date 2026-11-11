import { dialerFor, drainAndClose, mintCreds, newIdentity, oneLine, openSessionRail, standaloneConnectOpts, type SessionGrant, type SpaceAuth } from "@cotal-ai/core";
import type { NatsConnection } from "@nats-io/transport-node";
import { divergentCwdAnchor } from "../auth-paths.js";
import { ConnectRefusal, userSessionAuth } from "../connect.js";
import { resolveControlTarget, resolveSeatControlTarget } from "../control-target.js";
import { askManager, managerFailure, type ControlClient, type ManagerPin } from "../control/manager.js";
import { locateSeat, seatMissRefusal, seatNotFoundMessage } from "../control/seat.js";
import { isWorkspaceTargetError } from "../mesh-target.js";
import { CommandFailure, recordOperationSpace } from "../output.js";
import { renderReport } from "../present.js";
import { renderWorkspaceError } from "../render.js";
import { attachClient, detachKey, holdTerminal, isDetachPress, isTransportEnd, meshSessionTransport, writeNotice, type AttachNotice, type TerminalHold } from "./attach-client.js";

/** Re-establishment backoff, in order; the last value is the cap and repeats forever. A seat that
 *  exists is worth waiting for — the operator asked to be attached to it, and the alternative is
 *  the terminal they walked away from being gone when they come back. */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;


/** How long any single wait on a LINK may take before the loop stops waiting on it. Neither
 *  `flush()` nor `drain()` carries a deadline of its own, and `connect`'s `timeout` covers only the
 *  dial: a link that half-opens AFTER connect (the exact slow death this command exists for) would
 *  otherwise pin the loop, and the detach key with it, until the connection's own heartbeat gave up
 *  around two minutes later. */
const LINK_DEADLINE_MS = 5_000;

/** Race a link round trip against a deadline, and answer `no` if the deadline wins. The timer is
 *  deliberately NOT unref'd: it is the only thing keeping the process alive while we wait on a
 *  socket that will never answer, and an unref'd one lets node empty its loop and abort the whole
 *  command on a pending await instead of finishing the wait and printing why. It is cleared as soon
 *  as either side settles, so a healthy link is never held open for the remainder of the deadline. */
export const withDeadline = async (work: Promise<boolean>, ms: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((r) => { timer = setTimeout(() => r(false), ms); });
  try { return await Promise.race([work, deadline]); } finally { clearTimeout(timer); }
};

/** Did a flush RETURN inside the deadline? That, and not the publish, is what says a frame left:
 *  publishing is a local buffer write. A rejection and a timeout are the same answer here, `no`. */
const flushed = (nc: NatsConnection): Promise<boolean> =>
  withDeadline(nc.flush().then(() => true, () => false), LINK_DEADLINE_MS);

/** Give the link its existing grace period, ending early if the broker closes it. */
const closeLink = (nc: NatsConnection): Promise<void> => drainAndClose(nc, LINK_DEADLINE_MS);

/** A session that ran at least this long counts as one that WORKED, whether or not the seat spoke.
 *  Below it, a link that comes up for the control round trip and dies again is a flap, and resetting
 *  the backoff on those re-mints a grant, a credential and a hand-back connection every second. */
const SESSION_WORKED_MS = 5_000;

/** One establishment attempt: the manager's answer, classified by what the CALLER should do about
 *  it rather than by prose. `gone`/`denied` stop the loop; `fatal` is a refusal that retrying can
 *  never fix; everything else is worth another attempt. */
type Established =
  | { ok: true; nc: NatsConnection; grant: SessionGrant; link: RedeemLink; inbox: string; server: string; resumedFrom?: { host: string; source: string } }
  | { ok: false; kind: AttachRefusal | "fatal"; message: string; fromManager?: true; code?: string; noTerminal?: true };

/** What a caller should DO about a manager refusal. `denied` will not change by asking again;
 *  `gone` is the seat the manager no longer knows, so there is nothing left to attach to; anything
 *  else is worth another attempt. */
export type AttachRefusal = "denied" | "gone" | "transient";

/** `inspect` found durable nonterminal state after the live seat disappeared. The manager owns the
 *  detail shape; the CLI keys only on its namespaced discriminator so the manager's rich diagnostic
 *  remains intact for operator commands while reconnect can act on the one fact it needs. */
const STATIC_SLOT_OBSERVATION_DETAIL = "ai.cotal.manager.static-slot-observation";

/** The manager's marker for an attach refused because the seat's runtime opens no terminal stream.
 *  Same arrangement as the detail above: the manager owns the shape and its guidance wording, and
 *  the CLI keys only on the namespaced discriminator. */
const RUNTIME_NO_TERMINAL_DETAIL = "ai.cotal.manager.runtime-no-terminal";

/**
 * Classify a refusal on the manager's structured error, never on its wording. The wording is
 * operator copy and changes; the code and namespaced detail are the contract. Getting this wrong in
 * either direction is a real failure: reading `permission-denied` as transient turns a refusal into
 * an infinite retry loop against a manager that has already said no, and reading `not-found` or an
 * `inspect` static-slot observation as transient does the same to a seat that no longer exists.
 * Other `failed-precondition` refusals remain transient, including the session ceiling.
 */
export function attachRefusal(
  code: string | undefined,
  details?: Array<{ kind: string }>,
): AttachRefusal {
  if (code === "permission-denied") return "denied";
  if (code === "not-found") return "gone";
  // `unimplemented` is the manager saying this runtime does not do attach at all - a seat on an
  // external terminal multiplexer or IDE, or a control instance that spawns nothing. Asking again
  // cannot change it, so a reconnecting attach must stop rather than retry it forever.
  if (code === "unimplemented") return "denied";
  if (code === "failed-precondition" && details?.some((detail) => detail.kind === STATIC_SLOT_OBSERVATION_DETAIL)) return "gone";
  return "transient";
}

/**
 * A re-establishment that threw, classified. A connect refusal that asking again cannot fix (a
 * missing seed, refused credentials, a user-auth mesh offered static creds) is `fatal`, so the loop
 * exits with the refusal's own sentence and hint instead of retrying it in silence. The control
 * resolver's mode peek rethrows a broken mesh record as a raw target error before the connect
 * helper can wrap it, and it only rethrows the codes that are not "no mesh found", so that is fatal
 * too. Anything else, including a broker that is not reachable yet, is transient.
 */
class SeatAttachCallerUnavailable extends Error {
  constructor() { super("the launching seat could not re-establish its own caller; no operator identity was substituted"); }
}

function thrownEstablishment(e: unknown): { ok: false; kind: "fatal" | "transient"; message: string } {
  if (e instanceof SeatAttachCallerUnavailable) return { ok: false, kind: "fatal", message: e.message };
  if (e instanceof ConnectRefusal && e.kind === "permanent")
    return { ok: false, kind: "fatal", message: [e.rendered.replace(/^✗ /, ""), e.hint].filter(Boolean).join("\n") };
  if (isWorkspaceTargetError(e))
    return { ok: false, kind: "fatal", message: renderWorkspaceError({ kind: "target", error: e }).replace(/^✗ /, "") };
  return { ok: false, kind: "transient", message: (e as Error).message };
}

/**
 * What a re-establishment TELLS the operator while it keeps trying, and what it keeps to itself.
 * Returns the line to print, or undefined for silence.
 *
 * Only the MANAGER's own refusal is relayed, and only when it changes. An operator watching
 * `reconnecting` for ten minutes cannot otherwise tell a sleeping laptop from a manager that is at
 * its session ceiling, and the ceiling is the one a person can act on. Repeating a steady refusal
 * on every attempt would bury it.
 *
 * A LOCAL failure to reach anything is deliberately silent: it is already what `connection lost,
 * reconnecting` says, and the copy on this path is written for someone who just typed a command
 * ("no mesh running at X - run `cotal up`"), which is the wrong thing to tell someone whose wifi
 * dropped.
 */
export function reconnectNotice(est: { fromManager?: true; message: string }, alreadySaid: string): string | undefined {
  if (!est.fromManager || est.message === alreadySaid) return undefined;
  return `[cotal: ${est.message}]`;
}

/**
 * The line an exit owes an operator about sessions this attach could not hand back, or nothing.
 *
 * Suppressed on `gone`, and that is not tidiness. That verdict exists only when the manager proves
 * the live seat is absent: either `not-found`, or the namespaced durable static-slot observation
 * after its process is gone. Freeing a seat ends every session bound to it (`freeSlot` into
 * `endForTarget`, on despawn, self-stop, reap and natural exit alike). The sessions this would name
 * have already been collected, so naming them would be inventing work for someone who is about to
 * close their terminal.
 */
export function heldSessionNotice(pending: number, verdict: AttachVerdict["kind"]): string | undefined {
  if (pending < 1 || verdict === "gone") return undefined;
  const what = pending === 1 ? "a session" : `${pending} sessions`;
  return `[cotal: the manager still holds ${what} from the lost link; each frees when the seat or the manager ends it]`;
}

/**
 * Ask the manager for a session and open it: a FRESH grant, a FRESH per-session caller credential,
 * a FRESH connection, every time. Nothing is carried over from a previous attempt, so a reconnect
 * re-runs the manager's whole authorization path (`serveGated` → `authorizeNamed` → a one-use
 * holder-bound grant with its own TTL) exactly as the first attach did. A revoked or expired grant
 * cannot be kept alive by reconnecting, because no grant is ever presented twice. `v` carries the
 * caller's {@link AttachCaller} choices beside the seat.
 */
async function establishAttachSession(
  v: AttachTarget & AttachCaller,
  on: string | undefined,
  reconnect: boolean,
  firstAttempt: boolean,
): Promise<Established> {
  // A reconnect must never cross a path that can END THE PROCESS. The mesh resolve and its
  // preflight are written to do exactly that ("no mesh running at X - run `cotal up`"), which is
  // the right answer for a person who just typed a command and the wrong one for a link that is
  // coming back. So a RE-ESTABLISHMENT asks for the throwing form, and the loop retries a refusal
  // whose kind is transient and stops on a permanent one.
  //
  // Keyed off `first`, NOT off the reconnect flag, and the difference is user-visible. A refusal
  // that escapes as an exception is rendered by the dispatcher's generic handler, which prints
  // `✗ ${message}` over a sentence that already opens with `✗` and drops the refusal's hint line.
  // The reconnect flag is on by DEFAULT, so keying on it sent the very first attach down that path
  // and turned today's "no mesh running at X - run `cotal up`" into a double mark with no remedy.
  // The first attempt is not a re-establishment and has nothing to survive for.
  //
  // Seat locality is deliberately not crossed here: it is resolved ONCE, before the loop, and the
  // pin is carried in. On the command path it is the other step that exits.
  // Same reach routing as stop: static mesh → any-mode on the `control-caller-admin` instrument;
  // user mesh → the operator's own bearer with owner reach, the manager deciding (own owner-domain
  // passes with "spawn", cross-owner needs ledger "admin").
  // The console asks for the throwing form on the FIRST attempt as well (`onRefusal` on the
  // target): inside a TUI a printed sentence and a `process.exit` would blank the operator's screen
  // mid-session, and the refusal becomes a status-line notice instead. So "first" here means the
  // first attempt of a command that wants the exit.
  const first = firstAttempt && v.onRefusal === "exit";
  const seat = v.asSeat ? await resolveSeatControlTarget(v, on) : undefined;
  if (v.asSeat && !seat) throw new SeatAttachCallerUnavailable();
  const t = seat ?? await resolveControlTarget(v, "control-caller-admin", on, first ? {} : { onRefusal: "throw" });
  recordOperationSpace(t.space);
  const reach = t.auth.bearer ? "owner" : "any";
  // A refusal's report names the mesh in its heading, so this block names it once, in a field.
  if (first) console.error(renderReport({ sections: [{ title: "Attach", blocks: [{ kind: "fields", rows: [["Space", t.space], ["Agent", v.name], ["Manager", on ?? t.auth.managerInstanceId ?? "native selection"]] }] }] }, "rich", process.stderr));
  const reply = await askManager(v.control, t.space, t.server, "attach", { name: v.name }, t.auth, reach, undefined, { instanceId: on, expectedTarget: v.expectedTarget });
  if (!reply.ok) {
    // The one refusal no attach can work around: this seat's runtime streams no terminal. It is
    // said once, with the runtime's own guidance for watching the agent where it really runs, and
    // the Next names what does reach the seat - never "inspect and reattach", which cannot succeed
    // here and is the advice this refusal exists to replace.
    const noTerminal = reply.details?.some((detail) => detail.kind === RUNTIME_NO_TERMINAL_DETAIL) === true;
    if (first && noTerminal)
      throw new CommandFailure("refused", "UNSUPPORTED", reply.error ? oneLine(reply.error) : "the seat's runtime streams no terminal, so there is none to attach", {
        target: { space: t.space, agent: v.name, managerInstanceId: reply.managerInstanceId ?? on ?? null },
        native: { code: reply.code, outcome: reply.nativeOutcome },
        ...(v.noTerminalRemedy ? { remedy: v.noTerminalRemedy({ space: t.space, name: v.name }) } : {}),
      });
    if (first && (reply.preSubmitRefusal || reply.nativeOutcome === "not-executed"))
      throw managerFailure(reply, "terminal attach", { space: t.space, agent: v.name, managerInstanceId: reply.managerInstanceId ?? on ?? null });
    return { ok: false, kind: attachRefusal(reply.code, reply.details), message: reply.error ?? "error", fromManager: true, code: reply.code, ...(noTerminal ? { noTerminal: true } : {}) };
  }
  // P2 item 6: the reply is the holder-bound §13.6 session GRANT (no ws:// URL). Redeem it over the
  // mesh. A static-auth mesh mints a per-session, rails-only caller cred from the resolved root's
  // seed. A registered open mesh has no seed: the same bare connection `askManagerEp` already used
  // for the control round trip opens the caller rail. USER mesh (bearer, no local seed): refuse LOUD
  // — the 2-step user-mode redemption callout is the #29 follow-up, deliberately not wired here.
  const { grant, resumedFrom } = reply.data as { grant: SessionGrant; resumedFrom?: { host: string; source: string } };
  // The trust material the TARGET resolved, not a second answer walked up from the cwd. This used
  // to be `loadSpaceAuth(authDir(findCotalRoot()), t.space)`, which is the defect behind issue #722:
  // resolution had already picked a root from the registry and connected with it, and then this line
  // asked the current directory the same question and got a different answer. On any machine that is
  // not a hypothetical: `~/.cotal` exists because the registry lives there, `findCotalRoot` accepts
  // any directory merely NAMED `.cotal`, so every cwd under $HOME outside a project resolves here to
  // the home directory - whose trust chain for the same space differs from the resolved root's in
  // account, signing, sys and operator material. The result was a credential minted from a mesh the
  // broker never trusted, surfacing as a bare `Authorization Violation` that named nothing.
  // `control.ts` already stated the rule this restores: trust is carried forward rather than
  // re-loaded, because a second load is a second answer to "which space's seed" for one command.
  // A cwd anchor holding a DIFFERENT chain for this space is reported, never obeyed. It cannot
  // change what this command does any more - the seed above comes from the resolution, not the walk
  // - but staying silent is how issue #722 stayed a mystery: the operator had no way to learn that
  // the directory they were standing in carried another mesh's trust. Reported on the way past, so
  // it is said whether or not the attach then succeeds.
  const shadow = t.root === undefined ? undefined : divergentCwdAnchor(t.root, t.space);
  if (shadow)
    (v.notice ?? writeNotice)({
      tone: "warning",
      text:
        `! this directory resolves to ${shadow.cwdRoot}, whose .cotal/auth holds a DIFFERENT trust chain for space "${t.space}".\n` +
        `  attach used ${t.root}, the root this mesh resolved to. The other one is not being used, and is worth a look.`,
    });
  const tls = t.auth.tls === true;
  const id = newIdentity();
  // WHICH CONTRACT redeems this grant is decided ONCE, by the recorded mesh mode, and the answer is
  // a value this function then carries. It is never re-derived from the absence of a seed: that
  // inference is issue #1205 itself, where an open mesh (which holds no seed BY DESIGN) was read as
  // a static mesh whose seed had gone missing, and every open attach was refused.
  const material = attachSessionMaterial(t);
  if (material.kind === "fatal") return { ok: false, kind: "fatal", message: material.message };
  let link: RedeemLink;
  if (material.kind === "redeem") {
    // #2312, USER mesh: present this login's identity together with the grant to the identity
    // plane, which decides whether this principal holds the session and answers with a bearer the
    // callout turns into the SAME session-caller rows and grant expiry the static arm mints. No seed
    // is read or written, and nothing on this side decides who may hold the session.
    let auth: { bearer: string; sentinelCreds: string };
    try {
      auth = await userSessionAuth(t, grant);
    } catch (e) {
      return { ok: false, kind: "fatal", message: e instanceof Error ? e.message : String(e) };
    }
    link = { mode: "session-bearer", tls, ...auth };
  } else link =
    material.kind === "bare"
      // An open mesh has no credential system: the same bare connection the control round trip
      // already used opens the caller rail. Nothing is minted and nothing is invented.
      ? { mode: "bare", tls }
      : {
          mode: "session-caller",
          tls,
          creds: await mintCreds(material.auth, id, "session-caller", {
            sessionCaller: { endpoint: grant.endpoint, sessionId: grant.sessionId, epoch: grant.serving.epoch },
            expiresAt: Math.floor(grant.exp / 1000), // grant.exp is ms (now+ttlMs); the JWT exp is seconds
          }),
        };
  // maxReconnectAttempts is the whole difference between the two modes, and it is deliberate.
  // ONE-SHOT keeps the old -1: the NATS layer redials forever under a single session.
  // RECONNECTING uses 0, because that redial is what breaks the attach rather than saving it — the
  // session is already dead by the time the link comes back (the serving rail either kept
  // advancing `seq` into a subject nobody was subscribed to, so the restored subscription faults
  // with `gap`, or it stalled out and closed while this side was away, so nothing ever arrives
  // again). Owning re-establishment here means the link coming back produces a real session with a
  // real repaint, instead of a restored socket over a session that ended without us.
  const nc = await dialerFor(t.server)({
    servers: t.server,
    inboxPrefix: `_INBOX_${id.id}`,
    // After the default: a bearer link's callout scopes the inbox on its own connect nonce.
    ...redeemConnectOpts(link),
    maxReconnectAttempts: reconnect ? 0 : -1,
    // Detection latency is part of the defect, not a detail of it. A laptop waking from sleep does
    // not always get a socket error: the connection can sit half-open, and on the stock two-minute
    // ping with two misses the client would not learn its link was dead for about four minutes,
    // with the terminal frozen the whole time. Ten seconds puts that in tens of seconds. Only on
    // the reconnecting path, so `--no-reconnect` keeps today's timing along with today's exit.
    //
    // NOT MEASURED by this change's suite, and said so rather than implied: the smoke severs the
    // link by destroying sockets, so every number it prints is close detection. A fault model that
    // half-opens a link is what would grade this line, and it does not exist here yet.
    ...(reconnect ? { pingInterval: 10_000 } : {}),
  });
  return { ok: true, nc, grant, link, inbox: id.id, server: t.server, ...(resumedFrom ? { resumedFrom } : {}) };
}

/** The mesh contract that decides how attach redeems a session grant. The mode is the REGISTERED
 *  one (`MeshTarget.mode`), carried forward from the resolve. It is the only input to the decision:
 *  `spaceAuth` says whether a SEALED mesh's seed is present, and is never consulted to decide which
 *  kind of mesh this is. */
export type AttachSessionTarget = {
  space: string;
  server: string;
  root?: string;
  spaceAuth?: SpaceAuth;
  mode?: "auth" | "open" | "user";
  auth: { bearer?: unknown };
};

/**
 * HOW this mesh's session grant is redeemed, as a closed union with no optional credential.
 *
 * `bare` and `session-caller` are structurally distinct rather than "session-caller, but the creds
 * may be missing". That distinction is the whole fix for #1205. An optional `creds?: string` on the
 * redeem path invites exactly one question at every call site — "is the seed there?" — and answering
 * it with `!creds` is the defect: an OPEN mesh has no seed BY DESIGN, so absence means "bare",
 * while on a SEALED mesh the same absence means "refuse". One field cannot carry both meanings, so
 * the mode is named and the compiler makes every consumer read the name.
 */
export type RedeemLink =
  | { mode: "bare"; tls: boolean }
  | { mode: "session-caller"; tls: boolean; creds: string }
  // #2312: a user mesh. The identity plane minted the bearer for ONE session; the callout turns it
  // into the session-caller rows. Never a seed.
  | { mode: "session-bearer"; tls: boolean; bearer: string; sentinelCreds: string };

/** The ONE place a {@link RedeemLink} becomes NATS connect options. Both connections on the redeem
 *  path (the session link and the abandoned-session hand-back) go through here, so neither can
 *  invent a credential for an open mesh or drop one on a sealed mesh, and a third caller gets the
 *  same two arms for free. */
export function redeemConnectOpts(link: RedeemLink): ReturnType<typeof standaloneConnectOpts> {
  if (link.mode === "session-bearer")
    return standaloneConnectOpts({ bearer: link.bearer, sentinelCreds: link.sentinelCreds, tls: link.tls });
  return link.mode === "bare"
    ? standaloneConnectOpts({ tls: link.tls })
    : standaloneConnectOpts({ creds: link.creds, tls: link.tls });
}

/**
 * Which redeem contract this target gets: a bare open-mesh connection, a seed-backed mint, or a
 * loud refusal. Graded by `smoke:attach-open-mode`, whose mutations flip each arm in turn.
 *
 * EXHAUSTIVE over the three recorded modes on purpose, with `user` named rather than reached by
 * fallthrough. A `user` entry holds no local seed by design and its two-step redemption is not
 * wired, so it must refuse even on the day a user-mode root happens to carry static material on
 * disk; letting it fall through to the seed test would silently mint on the wrong identity plane.
 * An UNRECORDED mode (a raw off-registry connection) is the conservative arm: it is not known to be
 * open, so it takes the sealed test and refuses without a seed.
 */
export function attachSessionMaterial(t: AttachSessionTarget):
  | { kind: "bare" }
  | { kind: "mint"; auth: SpaceAuth }
  | { kind: "redeem" }
  | { kind: "fatal"; message: string } {
  switch (t.mode) {
    // An OPEN mesh: no credential system at all, so there is no seed to be missing and nothing to
    // mint. This is the arm issue #1205 did not have.
    case "open":
      return { kind: "bare" };
    // A USER mesh: the identity plane redeems the grant for the bearer (#2312), EVEN IF a seed is
    // present, because the bearer plane is the control surface there and static material would be
    // the wrong identity. `spaceAuth` is never consulted on this arm.
    case "user":
      return { kind: "redeem" };
    // SEALED (`auth`) and unrecorded: the seed is required, and its absence is a refusal. A sealed
    // mesh must never be rescued by the open arm — that is the failure a fix for #1205 is most
    // likely to introduce, and `smoke:attach-open-mode` asserts the refusal by name against a live
    // sealed broker.
    default:
      return t.spaceAuth ? { kind: "mint", auth: t.spaceAuth } : { kind: "fatal", message: attachNoSeedMessage(t) };
  }
}

/** Why attach cannot redeem a session grant, said in terms of what the command actually resolved.
 *
 *  Three distinct states, kept distinct because the remedy differs and a single sentence covering
 *  all three is the defect issue #722 opened on (its old text named an internal work item and no
 *  root at all). A USER-AUTH mesh holds no local seed by design. A REGISTERED static mesh has a
 *  root and it is named, so an operator can see which directory the command used rather than
 *  guessing at their cwd.
 *
 *  The third arm is an INVARIANT, not advice, and is written that way on purpose. A connection with
 *  no resolved root is what the type allows, and no supported route reaches redemption in that
 *  state: both off-registry routes are refused earlier, which `smoke:attach-auth-root` measures
 *  rather than assumes. So that arm says what its own existence would mean instead of offering a
 *  remedy for a situation that cannot currently arise. */
function attachNoSeedMessage(t: AttachSessionTarget): string {
  const shadow = t.root === undefined ? undefined : divergentCwdAnchor(t.root, t.space);
  const shadowLine = shadow
    ? `\n  NOTE this directory resolves to ${shadow.cwdRoot}, which holds a DIFFERENT trust chain for "${t.space}"; it was NOT used.`
    : "";
  const head = `mesh attach needs this space's local seed to redeem the session grant, and the mesh resolved for "${t.space}" does not provide one.`;
  if (t.root === undefined)
    return `${head}\n  broker ${t.server}\n  This connection resolved NO checkout root, and no supported route reaches redemption in that state: an off-registry \`--server\` on an unregistered space is refused for missing credentials, and \`--creds\` is refused at the control surface, both before a session grant is asked for. Reaching this sentence means a route now exists that skips both refusals.${shadowLine}`;
  return `${head}\n  broker ${t.server}\n  resolved root ${t.root}\n  This is a static-auth mesh. Attach still needs this space's seed under ${t.root}/.cotal/auth. Restore the seed at that checkout. This mesh is not open, so attach will not connect without the seed.${shadowLine}`;
}

/** A session this side can no longer reach, plus the caller material that can still speak for it.
 *  It carries the SAME {@link RedeemLink} the session came up on, so the hand-back cannot re-decide
 *  the mesh contract from what it happens to hold. */
type Abandoned = { grant: SessionGrant; link: RedeemLink; inbox: string; server: string };

/**
 * Tell the manager a session is over, so it gets its slot back.
 *
 * NOTHING on the serving side reaps a session whose caller went away while the seat is quiet: the
 * rail's stall watchdog only arms once the send window FILLS (`endpoint-session-rail.ts`), an idle
 * seat never fills it, and the bridge has no expiry timer of its own. Measured against a manager
 * with an idle seat: 45s of dead link left the live-session count at 1, and the reconnect took it
 * to 2 — one slot per outage, held until the seat or the manager ends it, against a ceiling of 64.
 *
 * The mechanism is the advisory close frame the rail already defines; the manager's bridge ends on
 * it. On a static-auth mesh it has to be published with THIS session's caller credential, the only
 * one scoped to this session's subjects, so a re-establishment cannot send it on the abandoned
 * session's behalf. On a registered open mesh there is no session-caller seed: the same bare
 * connection the session used hands the slot back. Hence a short-lived connection minted from the
 * abandoned session's own material, never an invented seed.
 */
async function releaseAbandonedSession(s: Abandoned): Promise<void> {
  const nc = await dialerFor(s.server)({
    servers: s.server,
    inboxPrefix: `_INBOX_${s.inbox}`,
    ...redeemConnectOpts(s.link),
    maxReconnectAttempts: 0,
    timeout: LINK_DEADLINE_MS,
    // The same short ping the reconnecting session uses. This connection exists BECAUSE a link died,
    // so it is the last one that should be left waiting on the stock two-minute heartbeat to find
    // out that the replacement died too.
    pingInterval: 10_000,
  });
  try {
    // The rail is opened only because `close()` is the public way to speak the framing; no timers,
    // and it tears itself down on the same call.
    openSessionRail({ nc, grant: s.grant, role: "caller", onData: () => {}, idleCreditMs: 0, stallTimeoutMs: 0 }).close();
    // Throwing is what keeps the record: the caller holds the session until a flush RETURNS.
    if (!(await flushed(nc))) throw new Error(`the close frame for session ${s.grant.sessionId} never left`);
  } finally {
    await closeLink(nc);
  }
}

/** Watch stdin for the detach key while there is NO session reading it. Without this the key is
 *  dead for as long as a reconnect takes, which is exactly when an operator is most likely to give
 *  up and press it. Non-detach keystrokes are dropped: there is no seat to send them to, and
 *  buffering them would replay a burst into the agent on reconnect. */
function watchDetachKey(byte: number): { pressed: Promise<void>; hit: () => boolean; stop: (opts?: { pause?: boolean }) => void } {
  const stdin = process.stdin;
  let fire!: () => void;
  let pressedYet = false;
  const pressed = new Promise<void>((r) => { fire = r; });
  const hit = () => { pressedYet = true; fire(); };
  // The whole chunk must be exactly one press of the detach key: the legacy control byte, or the
  // kitty keyboard protocol / xterm modifyOtherKeys encoding of the same press (see
  // `isDetachPress`, #598). A chunk carrying it alongside anything else is NOT a keypress:
  // measured on a pty, a real keypress arrives in a read of its own even at 3ms spacing, and the
  // only two ways the byte arrives with company are a paste and a reader that was not reading.
  // Treating a paste that happens to contain the byte (or the encoded sequence) as a detach would
  // turn data into a control action on input nobody typed; the reader that was not reading is the
  // defect this watcher's new lifetime fixes, not a matching problem.
  // Under the console, Ink has called `stdin.setEncoding("utf8")`, and an encoding persists on the
  // stream after Ink releases raw mode, so data arrives as a STRING there (the standalone command
  // gets Buffers). Normalize first: a one-character string is not the number 0x1d, and the compare
  // below would otherwise never match, making the key dead for as long as a reconnect takes.
  const onData = (d: Buffer) => { if (isDetachPress(d, byte)) hit(); };
  const onChunk = (data: Buffer | string) => onData(Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"));
  stdin.on("data", onChunk);
  stdin.resume();
  // `pause: false` hands the stream to a session's own reader, which resumes it synchronously right
  // after; pausing there and resuming a line later would be a window where a byte has no owner,
  // which is the whole defect.
  // `hit` as well as `pressed`, because the press has TWO consumers and one of them cannot await:
  // the handoff to a session's reader is synchronous, and it has to know whether the byte it is
  // taking the stream over from has already arrived.
  return { pressed, hit: () => pressedYet, stop: ({ pause = true } = {}) => { stdin.off("data", onChunk); if (pause) stdin.pause(); } };
}

/**
 * The attach loop. One session at a time; when the LINK breaks and the operator did not detach, it
 * re-establishes with backoff and keeps going, because the seat is still there and the terminal the
 * operator walked away from should still be theirs when they come back.
 */
async function runAttachLoop(
  vv: AttachTarget & AttachCaller,
  pin: string | undefined,
  reconnect: boolean,
  key: ReturnType<typeof detachKey>,
  hold: TerminalHold,
): Promise<AttachVerdict> {
  const notice = vv.notice ?? writeNotice;
  let first = true;
  let attempt = 0; // consecutive re-establishment attempts since the last live session
  // Sessions the manager still counts, waiting to be told. A LIST rather than one slot: a second
  // link death before the first hand-back lands would overwrite the first and leak it with nothing
  // said. It cannot grow without bound, because every entry needed a successful establishment, and
  // successful establishments are exactly what the manager's own session ceiling counts.
  const abandoned: Abandoned[] = [];
  let saidWhy = ""; // the last transient refusal printed, so a steady reason prints once, not per attempt
  // ONE reader owns stdin for the whole time there is no session: the backoff wait, the round trip
  // that hands the old session back and opens the new one, and the gap in between. It used to exist
  // only for the waits, which left the establishment unread: `stdin` was paused, the stream
  // buffered, and `attachClient`'s `stdin.resume()` flushed whatever had been typed at a terminal
  // with no session straight into the seat's pty. Measured on the code before this change, with the
  // bytes graded at the SEAT rather than on screen: typed during a wait, dropped; during an attempt
  // that failed, dropped; during an attempt that SUCCEEDED, delivered, and a 0x03 typed there
  // arrived as SIGINT at the agent and killed it (the seat recorded the signal and its pid was
  // gone). With the reader installed for the whole period those bytes are read and dropped, which
  // is what the loop always claimed to do, and the detach key works during an attempt as well as
  // during a wait.
  let idle: ReturnType<typeof watchDetachKey> | undefined;
  // A TERMINAL only, and the gate lives HERE rather than at the call sites, because there are three
  // of them and a gate written at one is a promise the other two break silently. `printf 'ls\n' |
  // cotal attach` writes into a PIPE, and those bytes are a script's input rather than an operator
  // giving up on a frozen screen: a reader would eat them with no fault anywhere in sight. That is
  // true in EVERY window, not only before the first session, so a pipe keeps the old contract
  // throughout, paused between sessions and flushed into the next one. Measured with the gate at the
  // first call site alone: a piped attach buffered correctly until its first reconnect and then had
  // the reader installed on it by the backoff, so `tail -f log | cotal attach` lost its feed across a
  // link blip. Cells J and I are the first-session halves, cell L is the reconnect one.
  const ownStdin = (): typeof idle => (process.stdin.isTTY ? (idle ??= watchDetachKey(key.byte)) : undefined);
  // Returns whether the detach key had ALREADY been pressed, which is the one thing the session's
  // own reader cannot find out for itself once this reader is gone.
  const releaseStdin = (opts?: { pause?: boolean }): boolean => {
    const pressed = idle?.hit() ?? false;
    idle?.stop(opts);
    idle = undefined;
    return pressed;
  };
  // Give the manager its slots back. Oldest first, and one failure ends the round rather than
  // skipping ahead, because the reason is the link and the link is the same for all of them.
  const releaseAbandoned = async (): Promise<void> => {
    while (abandoned.length > 0) {
      try {
        await releaseAbandonedSession(abandoned[0]);
        abandoned.shift();
      } catch { break; }
    }
  };
  // Every exit runs through here, so the one thing an operator cannot see for themselves is never
  // swallowed. It TRIES first: an operator who detaches during the backoff may well be doing it
  // because the link came back, and returning straight out would leave a slot held that one dial
  // would have freed. The attempt is bounded exactly like every other, and what it could not
  // deliver is what gets said. What to say, and when to say nothing, is `heldSessionNotice`.
  const done = async (v: AttachVerdict): Promise<AttachVerdict> => {
    // Give the stream back on the way out, on EVERY exit, because this reader resumed it: a resumed
    // stdin is a ref'd handle, and one left behind holds the command open after it has said it
    // detached. That is the same shape as the abandoned backoff timer, and it is why this lives
    // here rather than at the call sites.
    releaseStdin();
    // And drop the process's own claim on the stream, which a PIPE keeps even after a pause. This is
    // the exit path by definition, so nothing here reads stdin again. MEASURED, on a piped attach
    // with the reader correctly not installed: the detach was honoured, the manager freed the slot,
    // `detached from` printed, and the process then sat past 30s with its three stdio pipes as the
    // only resources keeping the loop alive. A pause was not enough on its own.
    //
    // ONLY THE SOCKET KINDS HAVE `unref`, and this is a test of the stream rather than a fallback.
    // Measured: at a terminal stdin is a `tty.ReadStream` and at a pipe a `net.Socket`, both of which
    // have it; given a FILE (`cotal attach < seed.txt`) or a parent that spawns with stdio "ignore",
    // stdin is an `fs.ReadStream` and has no `unref` at all. Calling it there is a TypeError, which
    // is how `smoke:cli-on-instance` caught this: it spawns attach with stdin ignored, and the
    // unguarded call turned a pinned-rail deadline into `process.stdin.unref is not a function`. The
    // same measurement says the other branch needs nothing: a file-backed stdin ends at EOF instead
    // of staying open like a socket, and a process that takes one and releases it exits at once with
    // an empty resource list, where the pipe leaves a PipeWrap behind. So the release exists exactly
    // where there is something to release. Cell N of `smoke:attach-stdin` is the file-backed route.
    if (typeof process.stdin.unref === "function") process.stdin.unref();
    if (v.kind !== "gone") await releaseAbandoned();
    const held = heldSessionNotice(abandoned.length, v.kind);
    if (held) notice({ tone: "status", text: held });
    return v;
  };
  // The FIRST establishment is an attach with no session too, and it is the path every attach takes.
  // Own the keyboard from here rather than from the first reconnect, so a key struck while the
  // command is still resolving the mesh is read and dropped instead of buffered and flushed into the
  // seat when the session opens. Measured before this line existed: a nonce typed at that prompt
  // arrived at the agent.
  //
  // `ownStdin` is a no-op at a pipe; both halves are cells (I and J), so neither is an assumption.
  if (reconnect) ownStdin();
  for (;;) {
    if (!first) {
      // Back off BEFORE the attempt, and stay interruptible: the detach key must work while we
      // wait, not only while a session is up. The timer is CLEARED rather than left to the race,
      // because losing a `Promise.race` does not stop a `setTimeout`: the detach is honoured at
      // once, the terminal comes back and `detached from` prints, and then node holds the process
      // open until the abandoned timer fires. On the 30s rung that is half a minute of a shell that
      // has already said it detached and will not give the prompt back. Measured before this line
      // existed: press to first output 0.1s, press to EXIT 27.0s with the next attempt 26.9s away,
      // and 8.3s with it 8.1s away, tracking the rung rather than the work.
      const ms = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
      const watch = ownStdin(); // and it STAYS installed through the attempt this wait precedes
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<boolean>((r) => { timer = setTimeout(() => r(false), ms); });
      // No watcher at a pipe, and nothing to replace it with: a detach byte a script writes here
      // buffers and reaches the next session's own reader, which is exactly what it did before this
      // change. Racing a promise that can never settle would be the same thing written longer.
      const detached = watch ? await Promise.race([waited, watch.pressed.then(() => true)]) : await waited;
      clearTimeout(timer);
      if (detached) return await done({ kind: "ended", reason: "detached" });
      attempt++;
    }
    // Give the manager its slots back BEFORE claiming another one. The order is load-bearing at the
    // ceiling: a client that claims first is refused by the very sessions it abandoned. A failure
    // is retried on the next attempt and accounted for by `done` if it never lands.
    await releaseAbandoned();
    let est: Established;
    const attempting = establishAttachSession(vv, pin, reconnect, first);
    // A press DURING the round trip ends the attach now, rather than when the round trip returns.
    // The in-flight establishment is still awaited: it is bounded like every other one, and a
    // session that lands after we have stopped looking is a slot the manager still counts, so it
    // goes on the abandoned list and `done` hands it back over the link that is by then up.
    //
    // `idle` is also set on the FIRST establishment at a terminal, where what it buys is the same
    // thing it buys everywhere else: what gets typed at a prompt that has not come up yet is read
    // and dropped rather than delivered later, which is what cell I grades. It is not a second way
    // to abort. Raw mode is entered in `attachClient`'s `onReady`, so before the
    // first session this process has not touched the terminal's mode at all, and Ctrl-C at a cooked
    // tty is how an operator leaves a command that has not attached.
    if (idle) {
      const raced = await Promise.race([
        attempting.then((e) => ({ est: e }) as const, () => ({ est: undefined }) as const),
        idle.pressed.then(() => ({ detached: true }) as const),
      ]);
      if ("detached" in raced) {
        releaseStdin();
        const late = await attempting.catch(() => undefined);
        if (late?.ok) {
          abandoned.push({ grant: late.grant, link: late.link, inbox: late.inbox, server: late.server });
          // And CLOSE the link that session came up on. Nothing here will ever read it, and an open
          // NATS connection is a ref'd handle: measured, the attach printed `detached from` and then
          // sat there forever, because the hand-back mints its own short-lived connection from the
          // abandoned session's own credential and never touches this one. Same shape as the
          // abandoned backoff timer, one layer down.
          await closeLink(late.nc);
        }
        return await done({ kind: "ended", reason: "detached" });
      }
    }
    try {
      est = await attempting;
    } catch (e) {
      // The FIRST attempt throws exactly as it always has — the CLI's top-level handler renders
      // it. Only a reconnect turns a thrown establishment into another attempt. Give the stream
      // back on the way out: this is the one exit from this loop that does not run through `done`,
      // and a resumed stdin is a ref'd handle that would hold the command open after it has already
      // printed why it is giving up.
      if (first) { releaseStdin(); throw e; }
      est = thrownEstablishment(e);
    }
    if (!est.ok) {
      // Nothing changes for the first attach: any refusal is the same loud exit as before.
      if (first || est.kind === "fatal" || est.kind === "denied") return await done({ kind: "failed", message: est.message, ...(est.fromManager ? { refusal: { code: est.code, noTerminal: est.noTerminal === true } } : {}) });
      if (est.kind === "gone") return await done({ kind: "gone" });
      const why = reconnectNotice(est, saidWhy);
      if (why) {
        saidWhy = est.message;
        notice({ tone: "status", text: why });
      }
      continue; // transient: the manager or the link is unreachable right now
    }
    saidWhy = "";
    const from = est.resumedFrom ? ` (resumed from ${est.resumedFrom.host}:${est.resumedFrom.source})` : "";
    notice({ tone: "status", text: first ? `attached to ${vv.name}${from} - ${key.label} to detach` : "[cotal: reconnected]" });
    first = false;
    let outcome;
    const startedAt = Date.now();
    const transport = meshSessionTransport(est.nc, est.grant);
    try {
      // The manager replays its byte-exact backlog snapshot on every open (the `ready` handshake
      // in session/bridge.ts), so the reconnected screen repaints through the path that already
      // exists; there is no second backlog here.
      outcome = await attachClient(transport, hold, () => releaseStdin({ pause: false }), notice);
    } finally {
      // Take the stream back FIRST, ahead of the hand-back's own round trips. A session that ends
      // while its SOCKET is still alive is the case this whole change is about, and everything
      // below it here is a publish, a flush and a close, each bounded by LINK_DEADLINE_MS: placed
      // after them, this line would leave the keyboard unowned for as long as a dying link takes
      // to answer, which is precisely when an operator reaches for the detach key. attachClient's
      // cleanup has already removed its own reader and paused the stream, so the ownerless gap is
      // the width of this statement rather than of two deadlines. `done` releases it again on
      // whichever exit follows, and the backoff wait re-installs the same reader.
      if (reconnect) ownStdin();
      // Hand the session back. With the link still up that is one advisory frame over the
      // connection already open (a rail that broke while the socket lived — a stall, a gap — is
      // exactly this case, and it is idempotent after a detach has already closed it). The FLUSH is
      // what decides whether it left, not the publish: a link can die between the closed-check and
      // the frame, which is the same slow death this whole change is about. Only a flush that
      // returned counts as handed back; anything else keeps the credential for the next attempt,
      // and see releaseAbandonedSession for why no other credential can carry it.
      let handedBack = false;
      if (!est.nc.isClosed()) {
        transport.close();
        handedBack = await flushed(est.nc);
      }
      if (!handedBack && reconnect) {
        abandoned.push({ grant: est.grant, link: est.link, inbox: est.inbox, server: est.server });
      }
      await closeLink(est.nc);
    }
    // The backoff resets on a session that WORKED, not on one that merely opened. `carried` is not
    // enough on its own: a seat that has produced nothing has an empty backlog snapshot, so a
    // perfectly healthy attach to a QUIET agent would never reset and would climb to the 30s cap
    // over a few blips, which is the seat this whole change cares most about. A session that simply
    // lasted is the other half of the same question.
    if (outcome.carried || Date.now() - startedAt >= SESSION_WORKED_MS) attempt = 0;
    if (!reconnect) {
      // One-shot: a faulted session still throws, so `--no-reconnect` exits the way it does today.
      if (outcome.error) throw outcome.error;
      return await done({ kind: "ended", reason: outcome.reason });
    }
    if (!isTransportEnd(outcome.reason)) {
      // A faulted end this classification does not recognise is NOT a detach. Printing
      // `detached from` over it would be the silent swallow this whole change exists to remove,
      // so it exits non-zero carrying the fault. Every `fireEnd` site passes a reason today, so
      // this is a guard against a future one that forgets, not a live path.
      if (outcome.error) return await done({ kind: "failed", message: outcome.error.message });
      return await done({ kind: "ended", reason: outcome.reason });
    }
    notice({ tone: "status", text: "[cotal: connection lost, reconnecting]" });
    // Raw from here on, whether or not the session that just ended reached ready. A first session
    // whose link died inside its opening flush never ran `onReady`, so the terminal is still cooked:
    // the line discipline would echo the detach key as `^]` and hold it until Enter, and the reader
    // below would never see it (#1471). The attach has already said it is attached, so Ctrl-C at a
    // cooked tty is no longer the way out; the detach key is.
    hold.enterRaw();
  }
}

/** How the attach finished, decided inside the loop and acted on outside it — so the terminal is
 *  always given back before anything prints or exits. A failure the manager refused carries that
 *  refusal's code and whether it bore the manager's marker that the seat's runtime streams no
 *  terminal, so a caller can act on it without reading the wording. */
export type AttachVerdict = { kind: "ended"; reason: string } | { kind: "gone" } | { kind: "failed"; message: string; refusal?: { code?: string; noTerminal: boolean } };

/** What an attach needs to know: the mesh coordinates the control commands take, plus the seat.
 *  `expectedTarget` pins the incarnation a picker chose; `asSeat` attaches with the launching seat's
 *  own caller instead of an operator identity. */
export type AttachTarget = { space?: string; server?: string; creds?: string; name: string; expectedTarget?: ManagerPin["expectedTarget"]; asSeat?: boolean };

/** What only the caller of an attach knows. `onRefusal` chooses what an unresolvable mesh or an
 *  absent seat does on the first attempt: `exit` prints and exits as a command does, `throw` returns
 *  a verdict, which a TUI needs because an exit inside it blanks the screen. `verb` is the command a
 *  seat-miss refusal names. `noTerminalRemedy` renders the remedy for a seat whose runtime streams no
 *  terminal; without it that refusal carries none. `notice` receives every line the attach says while
 *  it runs, and defaults to stderr. */
export interface AttachCaller {
  readonly control: ControlClient;
  readonly onRefusal: "exit" | "throw";
  readonly verb: string;
  readonly noTerminalRemedy?: (seat: { space: string; name: string }) => string;
  readonly notice?: (notice: AttachNotice) => void;
}

/**
 * The whole attach, as one call: seat locality, the establish-redeem-drive loop with its reconnect,
 * end-reason classification and abandoned-session hand-back, and the terminal given back before
 * the verdict is returned. `cotal attach` and the console's `a` / `:attach` both run THIS, so the
 * console can never drift into a lesser attach. The pin `on`, when the caller already knows it, is
 * honoured. Otherwise a `throw` caller has the seat located the way `stop` locates it, and an `exit`
 * caller has already located it in its own words, since that step prints and exits.
 */
export async function attachSeat(
  v: AttachTarget,
  opts: AttachCaller & { reconnect: boolean; on?: string },
): Promise<AttachVerdict> {
  const { reconnect, on: pinned, ...caller } = opts;
  let on = pinned;
  if (on === undefined && caller.onRefusal === "throw") {
    const loc = await locateSeat(caller.control, v, v.name, { onRefusal: "throw" });
    if (loc.kind === "absent") return { kind: "failed", message: seatNotFoundMessage(loc, v.name) };
    if (loc.kind === "several") return { kind: "failed", message: seatMissRefusal(v.name, caller.verb, loc) };
    if (loc.kind === "pin") on = loc.instanceId;
  }
  const detach = detachKey();
  const hold = holdTerminal();
  try {
    return await runAttachLoop({ ...v, ...caller }, on, reconnect, detach, hold);
  } catch (e) {
    if (caller.onRefusal === "exit") throw e;
    return { kind: "failed", message: (e as Error).message };
  } finally {
    // The terminal comes back before anything else happens, whatever ended the attach — including
    // a throw out of the one-shot path, which is how `--no-reconnect` keeps its old exit.
    hold.restore();
  }
}
