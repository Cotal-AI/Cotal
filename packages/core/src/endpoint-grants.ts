/**
 * v0.4 endpoint control-surface grant grammar (SPEC §13.9 matrix, caller + serve rows) — the
 * capability → exact allow-list builders `permissionsFor` mints from. Default-deny throughout:
 * every row is an exact-arity literal form from the §13.9 matrix; no builder emits a wildcard
 * that admits subjects outside the §13.2 grammar.
 *
 * SCOPE: the SUBJECT-space rows (core publish/subscribe grants). The `$JS.API` rows of the
 * matrix (canonicalizer/effects/pool/reader durables) bind to the §13.12 stream names and land
 * with that binding; the serve PROFILE that carries these rows to an endpoint daemon lands with
 * the service registry machinery.
 */
import { spacePrefix } from "./subjects.js";
import {
  endpointToken, assertCommandToken, assertLifecycleToken, type EpCaller, type EpTarget,
  epCallerReplyFilter, epResponderReplyPattern, epClassQueueGroup,
} from "./endpoint-subjects.js";

/** A minted request capability: one endpoint command a caller may invoke, on the named rails.
 *  `routes` defaults to `["one"]`; `instanceId` additionally pins the instance form to exactly
 *  that instance. A TARGETED capability carries its authorization mode with the target tokens
 *  LITERAL as minted (§13.2): `owner`/`child` pin the caller's own owner; `any`/`ledger` may pin
 *  `"*"` (mintable only under operator/admin policy — enforced by the minting authority, not
 *  here); `handle` pins the full redemption triple and is never a standing capability. */
export interface EpCapability {
  endpoint: string;
  command: string;
  routes?: ("one" | "all")[];
  instanceId?: string;
  target?: EpTarget;
  /** Also grant the matching journal-submission append row (`epj`, §13.9 matrix). */
  journal?: boolean;
}

/** Grant-row token block for a capability's authz/target segment. Unlike the request builder,
 *  `any`/`ledger` accept a `"*"` target owner here (a grant row, not a concrete subject). */
function targetGrantTokens(target: EpTarget): string[] {
  if (target.mode === "self") return ["self"];
  if (target.mode === "handle")
    return ["handle", target.tOwner, target.tActor, assertLifecycleToken(target.tUid, "target lifecycleUid")];
  if (target.tOwner === "*" && target.mode !== "any" && target.mode !== "ledger")
    throw new Error(`a "${target.mode}"-mode grant is never minted with a wildcard target owner (SPEC 13.2)`);
  return [target.mode, target.tOwner];
}

function callerBlock(caller: EpCaller): string {
  return `${caller.owner}.${caller.actor}.${assertLifecycleToken(caller.uid, "caller lifecycleUid")}`;
}

/** Request-publish rows for one capability (§13.9 "Request publish"): per route,
 *  `ep.{one,all}.<endpoint>.<command>[.<mode>[.<target…>]].<cO>.<cA>.<cUid>.*` and the
 *  instance-pinned form when `instanceId` is set. The nonce is the only wildcard token. */
export function epRequestGrantRows(space: string, cap: EpCapability, caller: EpCaller): string[] {
  const e = endpointToken(cap.endpoint);
  const cmd = assertCommandToken(cap.command);
  const mid = cap.target ? `.${targetGrantTokens(cap.target).join(".")}` : "";
  const tail = `${mid}.${callerBlock(caller)}.*`;
  const rows = (cap.routes ?? ["one"]).map((r) => `${spacePrefix(space)}.ep.${r}.${e}.${cmd}${tail}`);
  if (cap.instanceId)
    rows.push(`${spacePrefix(space)}.ep.inst.${e}.${assertLifecycleToken(cap.instanceId, "instanceId")}.${cmd}${tail}`);
  return rows;
}

/** Journal-submission append row (§13.9 "Journal submission append"): the same authz/target
 *  block as the request forms, caller-pinned, no nonce. Explicitly untrusted input (§13.4). */
export function epJournalGrantRow(space: string, cap: EpCapability, caller: EpCaller): string {
  const mid = cap.target ? `.${targetGrantTokens(cap.target).join(".")}` : "";
  return `${spacePrefix(space)}.epj.${endpointToken(cap.endpoint)}.${assertCommandToken(cap.command)}${mid}.${callerBlock(caller)}`;
}

/** The caller's reply-rail read row (§13.9 "Reply subscribe"): its own rail only, exact arity. */
export function epCallerReplyGrantRow(space: string, caller: EpCaller): string {
  return epCallerReplyFilter(space, caller);
}

/** Per-goal live progress read row (§13.9 "Live event progress", reserved `goal` topic):
 *  `epe.<endpoint>.*.*.goal.<cO>.<cA>.<cUid>.>` — the caller identity in the subject gives
 *  mint-time read containment; delivered on the caller's own core subscription only. */
export function epGoalProgressGrantRow(space: string, endpoint: string, caller: EpCaller): string {
  return `${spacePrefix(space)}.epe.${endpointToken(endpoint)}.*.*.goal.${callerBlock(caller)}.>`;
}

/** All caller-side rows for a capability set: request-publish (+ optional journal) into
 *  `pub.allow`, the reply rail into `sub.allow`. Deliberately NOT included: `epe` event
 *  subtrees beyond the per-goal row — read grants are minted per read capability by the
 *  granting authority (Appendix B), not implied by an invoke capability. */
export function epCallerGrantRows(
  space: string,
  caps: EpCapability[],
  caller: EpCaller,
): { pub: string[]; sub: string[] } {
  const pub: string[] = [];
  for (const cap of caps) {
    pub.push(...epRequestGrantRows(space, cap, caller));
    if (cap.journal) pub.push(epJournalGrantRow(space, cap, caller));
  }
  return { pub, sub: caps.length ? [epCallerReplyGrantRow(space, caller)] : [] };
}

/** One registered command's serve-subscribe rows (§13.9 "Serve subscribe"), per registered
 *  command and never a cross-command `>`:
 *   - class rail: `"ep.one.<endpoint>.<command>.> <queue>"` — QUEUE-QUALIFIED ONLY (the NATS
 *     `subject queue` grant form): no credential can plain-subscribe the class rail, which is
 *     what keeps per-request nonces visible only to the queue-selected instance;
 *   - scatter rail: `ep.all.<endpoint>.<command>.>` plain;
 *   - instance rail: `ep.inst.<endpoint>.<instanceId>.<command>.>` exact.
 *  The epoch is deliberately absent from serve subscriptions (§13.1's barrier is the fence). */
export function epServeSubscribeRows(space: string, endpoint: string, instanceId: string, command: string): string[] {
  const e = endpointToken(endpoint);
  const cmd = assertCommandToken(command);
  return [
    `${spacePrefix(space)}.ep.one.${e}.${cmd}.> ${epClassQueueGroup(endpoint)}`,
    `${spacePrefix(space)}.ep.all.${e}.${cmd}.>`,
    `${spacePrefix(space)}.ep.inst.${e}.${assertLifecycleToken(instanceId, "instanceId")}.${cmd}.>`,
  ];
}

/** A serving instance's egress rows (§13.9 matrix): reply publish (attribution-pinned instance
 *  triple + epoch), events, timer SCHEDULE requests (never `.armed`/`.fire`), and the epoch-pinned
 *  record-write ingress. Every row pins the instance's own identity and epoch. */
export function epServePublishRows(space: string, endpoint: string, instanceId: string, epoch: number): string[] {
  const e = endpointToken(endpoint);
  const iId = assertLifecycleToken(instanceId, "instanceId");
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error(`epoch ${epoch} is not an unsigned integer`);
  return [
    epResponderReplyPattern(space, endpoint, instanceId, epoch),
    `${spacePrefix(space)}.epe.${e}.${iId}.${epoch}.>`,
    `${spacePrefix(space)}.ept.${e}.${iId}.${epoch}.*.schedule`,
    `${spacePrefix(space)}.epr.${e}.${iId}.${epoch}.>`,
  ];
}

/** All serve-credential subject-space rows for an instance serving `commands`. The `$JS.API`
 *  bind rows (effects/pool durables) ride the §13.12 stream binding, not this builder. */
export function epServeGrantRows(
  space: string,
  serve: { endpoint: string; instanceId: string; epoch: number; commands: string[] },
): { pub: string[]; sub: string[] } {
  if (serve.commands.length === 0) throw new Error(`serve grant for "${serve.endpoint}" needs at least one registered command`);
  const sub: string[] = [];
  for (const cmd of serve.commands) sub.push(...epServeSubscribeRows(space, serve.endpoint, serve.instanceId, cmd));
  return { pub: epServePublishRows(space, serve.endpoint, serve.instanceId, serve.epoch), sub };
}
