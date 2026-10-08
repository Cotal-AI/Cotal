import {
  EpEnvelopeError,
  assertDerivedOwnerToken,
  assertLifecycleToken,
  type RemoteManagerAuthorityMaterial,
  type RemoteManagerAuthorityRequest,
} from "@cotal-ai/core";
import { parseRemoteManagerAuthorityRequest } from "./manager-authority.js";

/** Host-recorded authority for one owner's manager. No human row or bearer is created. */
export interface PlatformSupervisorAssignment {
  v: 1;
  kind: "platform-supervisor";
  owner: string;
  space: string;
  accountPublicKey: string;
  instanceId: string;
  lifecycleUid: string;
  revision: number;
  state: "assigned" | "ended";
  expiresAt: number;
  scope: ["supervise"];
}

/** One owner-bound call over the platform's authenticated worker channel. */
export interface PlatformSupervisorAuthorityRequest {
  v: 1;
  kind: "platform-supervisor-authority";
  owner: string;
  assignmentRevision: number;
  request: RemoteManagerAuthorityRequest;
}

/** Administrative authorization belongs to the trusted composition, never the worker body. */
export interface PlatformSupervisorInput {
  authorizePlatformAdmin(owner: string): Promise<boolean>;
  observeAssignment(owner: string): Promise<PlatformSupervisorAssignment | null>;
}

/** The refusal every door gives once the platform has ended an owner's assignment. */
export function platformSupervisorEnded(owner: string, cause?: string): EpEnvelopeError {
  return new EpEnvelopeError("permission-denied", `platform supervisor assignment for owner ${owner} has ended; its lifecycle has ended and material issued under it authorizes nothing${cause === undefined ? "" : ` (${cause})`}`);
}

/** The recorded assignment matches this owner, space and account, at any revision. */
function namesAssignment(assignment: PlatformSupervisorAssignment | null, owner: string, space: string, accountPublicKey: string): assignment is PlatformSupervisorAssignment {
  return !!assignment && assignment.v === 1 && assignment.kind === "platform-supervisor" &&
    assignment.owner === owner && assignment.space === space && assignment.accountPublicKey === accountPublicKey;
}

export async function requirePlatformSupervisorAdmin(input: PlatformSupervisorInput, owner: string): Promise<void> {
  if (await input.authorizePlatformAdmin(owner) !== true)
    throw new EpEnvelopeError("permission-denied", `platform-admin authority is required for supervisor owner ${owner}`);
}

/** The request is closed before any administrative callback or issuer is reached. */
export function parsePlatformSupervisorAuthorityRequest(raw: unknown): PlatformSupervisorAuthorityRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("bad-request", "platform supervisor request must be an object");
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o))
    if (!["v", "kind", "owner", "assignmentRevision", "request"].includes(key))
      throw new EpEnvelopeError("bad-request", `platform supervisor request carries unknown field ${JSON.stringify(key)}`);
  if (o.v !== 1 || o.kind !== "platform-supervisor-authority" || typeof o.owner !== "string" ||
      !Number.isSafeInteger(o.assignmentRevision) || (o.assignmentRevision as number) < 0)
    throw new EpEnvelopeError("bad-request", "platform supervisor request requires version, owner and assignmentRevision");
  assertDerivedOwnerToken(o.owner);
  const request = parseRemoteManagerAuthorityRequest(o.request);
  if (request.actor !== "cli")
    throw new EpEnvelopeError("bad-request", 'platform supervisor request actor must be "cli"');
  return { v: 1, kind: "platform-supervisor-authority", owner: o.owner, assignmentRevision: o.assignmentRevision as number, request };
}

/** Build a door scoped to a fresh assignment and the existing fixed registration profiles. */
export function makePlatformSupervisorAuthority(args: PlatformSupervisorInput & {
  owner: string;
  space: string;
  accountPublicKey: string;
  ready(): void;
  observePrincipal(instanceId: string): Promise<string | undefined>;
  issue(owner: string, expiresAt: number, request: RemoteManagerAuthorityRequest): Promise<RemoteManagerAuthorityMaterial>;
}) {
  return async (raw: PlatformSupervisorAuthorityRequest): Promise<RemoteManagerAuthorityMaterial> => {
    args.ready();
    const envelope = parsePlatformSupervisorAuthorityRequest(raw);
    if (envelope.owner !== args.owner)
      throw new EpEnvelopeError("permission-denied", `platform supervisor for owner ${args.owner} refuses requested owner ${envelope.owner}`);
    await requirePlatformSupervisorAdmin(args, envelope.owner);
    const assignment = await args.observeAssignment(envelope.owner);
    if (!namesAssignment(assignment, envelope.owner, args.space, args.accountPublicKey))
      throw new EpEnvelopeError("permission-denied", `platform supervisor assignment does not name owner ${envelope.owner} in this account and revision`);
    if (assignment.state === "ended") throw platformSupervisorEnded(envelope.owner);
    if (assignment.state !== "assigned" || assignment.revision !== envelope.assignmentRevision)
      throw new EpEnvelopeError("permission-denied", `platform supervisor assignment does not name owner ${envelope.owner} in this account and revision`);
    if (!Number.isSafeInteger(assignment.expiresAt) || assignment.expiresAt <= Math.floor(Date.now() / 1000))
      throw new EpEnvelopeError("permission-denied", `platform supervisor lifecycle has ended for owner ${envelope.owner}`);
    if (!Array.isArray(assignment.scope) || assignment.scope.length !== 1 || assignment.scope[0] !== "supervise")
      throw new EpEnvelopeError("permission-denied", `platform supervisor scope must be only supervise for owner ${envelope.owner}`);
    assertLifecycleToken(assignment.instanceId);
    assertLifecycleToken(assignment.lifecycleUid);
    const request = envelope.request;
    if (request.space !== args.space || request.instanceId !== assignment.instanceId || request.managerLifecycleUid !== assignment.lifecycleUid)
      throw new EpEnvelopeError("permission-denied", `platform supervisor request names another instance or lifecycle for owner ${envelope.owner}`);
    // No enrollment, mint, exchange, arbitrary profile, or participant control request crosses here.
    if (!["prepare", "activate", "renew", "renewStandingBundle"].includes(request.operation))
      throw new EpEnvelopeError("permission-denied", `platform supervisor operation ${request.operation} is outside manager registration and renewal for owner ${envelope.owner}`);
    const principal = await args.observePrincipal(request.instanceId);
    if (principal !== undefined && !principal.startsWith(`${envelope.owner}.`))
      throw new EpEnvelopeError("permission-denied", `platform supervisor instance belongs to another owner than ${envelope.owner}`);
    return await args.issue(envelope.owner, assignment.expiresAt, request);
  };
}

/** Record that the platform ended one owner's assignment. The host's own record must already read
 *  `ended`; the auth service never ends an assignment on a caller's claim. */
export function makePlatformSupervisorEnd(args: PlatformSupervisorInput & {
  space: string;
  accountPublicKey: string;
  ready(): void;
  end(owner: string, instanceId: string, lifecycleUid: string): Promise<void>;
}) {
  return async (owner: string): Promise<void> => {
    args.ready();
    assertDerivedOwnerToken(owner);
    await requirePlatformSupervisorAdmin(args, owner);
    const assignment = await args.observeAssignment(owner);
    if (!namesAssignment(assignment, owner, args.space, args.accountPublicKey))
      throw new EpEnvelopeError("permission-denied", `platform supervisor assignment does not name owner ${owner} in this account`);
    if (assignment.state !== "ended")
      throw new EpEnvelopeError("failed-precondition", `platform supervisor assignment for owner ${owner} is still ${String(assignment.state)}; record it ended before ending its issuance`);
    assertLifecycleToken(assignment.instanceId);
    assertLifecycleToken(assignment.lifecycleUid);
    await args.end(owner, assignment.instanceId, assignment.lifecycleUid);
  };
}
