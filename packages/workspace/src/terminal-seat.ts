/**
 * Issued authority for an agent seat a terminal starts on a static mesh: foreground `cotal spawn`,
 * `cotal join` and `cotal mint` (SPEC 13.15). The seat's §13.1 lifecycle is activated before the
 * mint, so the issuance names the lifecycle's issuance gate as its source, and the terminal retires
 * that gate when the seat leaves cleanly. Nothing renews the credential: it ends at the expiry the
 * person set, or at the furthest horizon a generation can name. A seat that dies without a clean
 * exit keeps an open gate, so its evidence stays live until that expiry.
 */
import {
  DEV_OWNER,
  epAuthBucket,
  gateFreeze,
  gateObserve,
  gateRetire,
  headBeginRetirement,
  headCandidate,
  headCompleteRetirement,
  mintAcceptedToken,
  mintGeneration,
  mintLifecycleUid,
  resumeActivationSaga,
  runActivationSagaAtUid,
  withIssuerSession,
  withLifecycleExecutorSession,
  type IssuanceSeam,
  type LifecycleStateTransport,
  type SpaceAuth,
} from "@cotal-ai/core";
import { CommandFailure } from "./output.js";

/** The furthest horizon a generation id can name, its first eight hex digits: 2106-02-07. */
export const TERMINAL_SEAT_HORIZON_SEC = 0xffffffff;

/** The expiry `--expires-in <seconds>` or `--expires-at <unix-seconds>` asks for, in unix seconds,
 *  or `undefined` when neither is given. */
export function seatExpiryAt(flags: { "expires-in"?: string; "expires-at"?: string }): number | undefined {
  const inS = flags["expires-in"], atS = flags["expires-at"];
  if (inS === undefined && atS === undefined) return undefined;
  if (inS !== undefined && atS !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "choose --expires-in or --expires-at, not both");
  const raw = (inS ?? atS)!;
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new CommandFailure("refused", "USAGE_INVALID", `--${inS !== undefined ? "expires-in" : "expires-at"} must be a positive integer`);
  const now = Math.floor(Date.now() / 1000);
  const at = inS !== undefined ? now + Number(raw) : Number(raw);
  if (at <= now) throw new CommandFailure("refused", "USAGE_INVALID", "--expires-at must be in the future");
  if (at > TERMINAL_SEAT_HORIZON_SEC) throw new CommandFailure("refused", "USAGE_INVALID", `a seat's expiry can be no later than ${new Date(TERMINAL_SEAT_HORIZON_SEC * 1000).toISOString()}`);
  return at;
}

/** The minting authority a terminal seat's lifecycle records. */
const TERMINAL_MINTER = "terminal";

export interface TerminalSeatTarget {
  server: string;
  space: string;
  tlsRequired: boolean;
  auth: SpaceAuth;
}

/** One seat: its allocated nkey, the name it runs under, and its lifecycle uid. */
export interface TerminalSeat {
  actor: string;
  alias: string;
  lifecycleUid: string;
}

/** What an issuing agent mint takes, and the token the seat reads its generation with. */
export interface TerminalSeatIssuance {
  expiresAt: number;
  issued: { generation: string; acceptedToken: string };
  issuance: IssuanceSeam;
}

/** One §13.1 operation on the seat's lifecycle, over a lifecycle-executor connection pinned to it. */
function withSeatExecutor<T>(target: TerminalSeatTarget, seat: TerminalSeat, fn: (t: LifecycleStateTransport) => Promise<T>): Promise<T> {
  return withLifecycleExecutorSession({ servers: target.server, space: target.space, auth: target.auth, tls: target.tlsRequired },
    { owner: DEV_OWNER, actor: seat.actor, lifecycleUid: seat.lifecycleUid, alias: seat.alias }, fn);
}

/** Activate the seat's lifecycle and open its issuance gate, before anything is minted. */
export async function activateTerminalSeat(target: TerminalSeatTarget, seat: TerminalSeat): Promise<void> {
  await withSeatExecutor(target, seat, (t) =>
    runActivationSagaAtUid(t, { owner: DEV_OWNER, actor: seat.actor, lifecycleUid: seat.lifecycleUid, managerInstance: TERMINAL_MINTER }));
}

/** Run one issuing agent mint for the seat inside an issuer session. The evidence names the seat's
 *  gate as its source, and the credential and its generation end at `expiresAt`, or at the furthest
 *  horizon when the person set none. */
export async function issueTerminalSeat<T>(
  target: TerminalSeatTarget,
  seat: TerminalSeat,
  expiresAt: number | undefined,
  mint: (opts: TerminalSeatIssuance) => Promise<T>,
): Promise<T> {
  const horizon = expiresAt ?? TERMINAL_SEAT_HORIZON_SEC;
  if (!Number.isSafeInteger(horizon) || horizon <= Math.floor(Date.now() / 1000) || horizon > TERMINAL_SEAT_HORIZON_SEC)
    throw new Error(`a seat's expiry must be a future time no later than ${new Date(TERMINAL_SEAT_HORIZON_SEC * 1000).toISOString()}`);
  const issued = { generation: mintGeneration(horizon), acceptedToken: mintAcceptedToken() };
  return withIssuerSession({ servers: target.server, space: target.space, auth: target.auth, tls: target.tlsRequired }, (session) =>
    mint({
      expiresAt: horizon,
      issued,
      issuance: {
        mode: "issue",
        store: session.store,
        accepted: session.accepted,
        sources: [{ space: target.space, bucket: epAuthBucket(target.space), key: `cred.${seat.lifecycleUid}` }],
      },
    }));
}

/** Retire the seat's lifecycle: freeze its issuance gate, retire every issuance that named it,
 *  then retire the gate and the head. An activation that stopped part way is finished or burned
 *  first. A seat never activated, or already retired, is left as it is. */
export async function retireTerminalSeat(target: TerminalSeatTarget, seat: TerminalSeat): Promise<void> {
  const owner = DEV_OWNER, { actor, lifecycleUid } = seat;
  await withSeatExecutor(target, seat, async (t) => {
    let gate = await gateObserve(t, lifecycleUid);
    if (gate === undefined || gate.row.state === "retired") return;
    if (gate.row.state === "frozen" && gate.row.op.kind === "activation") {
      const head = await headCandidate(t, owner, actor);
      if (head?.mapping.lifecycleUid !== lifecycleUid) {
        await gateRetire(t, { lifecycleUid, revision: gate.revision, opId: gate.row.op.opId });
        return;
      }
      await resumeActivationSaga(t, { owner, actor, lifecycleUid, opId: gate.row.op.opId });
      gate = (await gateObserve(t, lifecycleUid))!;
    }
    if (gate.row.state === "frozen" && gate.row.op.kind !== "retirement")
      throw new Error(`the issuance gate for ${lifecycleUid} is frozen by a ${gate.row.op.kind} (op ${gate.row.op.opId}); it was not retired`);
    const opId = gate.row.state === "frozen" ? gate.row.op.opId : mintLifecycleUid();
    if (gate.row.state === "open") await gateFreeze(t, { lifecycleUid, revision: gate.revision, op: { opId, kind: "retirement" } });
    const head = await headCandidate(t, owner, actor);
    if (head !== undefined && head.mapping.lifecycleUid === lifecycleUid && head.mapping.state !== "retired")
      await headBeginRetirement(t, { owner, actor, lifecycleUid, opId });
    // With the gate frozen, retire every issuance indexed to the seat's family, so no attempt row
    // stays active on a lifecycle that has gone (SPEC 13.15).
    await withIssuerSession({ servers: target.server, space: target.space, auth: target.auth, tls: target.tlsRequired }, (session) =>
      session.store.retireSource({ space: target.space, bucket: epAuthBucket(target.space), key: `cred.${lifecycleUid}` }));
    await gateRetire(t, { lifecycleUid, revision: (await gateObserve(t, lifecycleUid))!.revision, opId });
    const after = await headCandidate(t, owner, actor);
    if (after !== undefined && after.mapping.lifecycleUid === lifecycleUid && after.mapping.state !== "retired")
      await headCompleteRetirement(t, { owner, actor, lifecycleUid, opId });
  });
}
