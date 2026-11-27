import { randomBytes } from "node:crypto";
import {
  EpEnvelopeError, agentIdentityKey, assertLifecycleToken, contractDigest, decideAgentLink,
  issuanceGateKey, mintAgentUid, mintLifecycleUid, mintedAgentIdentity, parseAgentIdentityRecord,
  uidReservationKey, type AgentIdentityRecord,
} from "@cotal-ai/core";
import { findActorUnified, grantLinkedActor, ledgerAuthorizeAgentExchange, newActorToken, revokeLinkedActor } from "./ledger.js";
import {
  createGateFrozen, observeGate, readLifecycleHeadForOperation, registryScanner, registryStores, resumeActivation,
  retireGate, tryReserveUid, type LifecycleRegistry,
} from "./lifecycle-registry.js";
import { ensureRootCredential } from "./root-credential.js";
import {
  approvalKey, assertLinkedPermissions, auditKey, bindingKey, decodeLinkedRecord, immutableLinkedWrite, journalKey,
  LINK_ENABLE_KEY, linkedRead, linkedWrite, linkRef, markerKey, parseBinding, parseLinkedEnable, parseLinkedJournal,
  parseLinkRef, sameLinkedValue, winnerKey, type LinkedCoordinates, type LinkedGrantAck, type LinkedGrantInput,
  type LinkedJournal, type LinkedTarget, type LinkRef, type Snapshot,
} from "./linked-agent-records.js";

type Secret = LinkedTarget & { actorToken: string; linkOperationId: string };
type Retire = Omit<LinkedTarget, "agentUid">;
type Retired = { retired: boolean; lifecycleUid: string; alreadyRetired?: boolean };
type Dependencies = LinkedCoordinates & {
  reg: LifecycleRegistry; barrierReg: LifecycleRegistry; dir: string; eventPayloadsWithheld?: boolean;
  assertHeld: () => Promise<void>; log: (message: string) => void;
  serializedAlias: <T>(owner: string, actor: string, fn: () => Promise<T>) => Promise<T>;
  provision: (j: LinkedJournal) => Promise<void>;
  deprovision: (j: LinkedJournal) => Promise<void>;
  retire: (target: Retire) => Promise<Retired>;
};

function unavailable(): never { throw new EpEnvelopeError("unavailable", "linked lifecycle evidence is incomplete; retry using the exact lifecycle"); }
function denied(): never { throw new EpEnvelopeError("permission-denied", "linked lifecycle authority does not match the exact run"); }
function occupied(): never { throw new EpEnvelopeError("conflict", "the agent identity is occupied; retire the exact preceding lifecycle first"); }
function need<T>(value: T | undefined): T { return value ?? unavailable(); }
function match(actual: unknown, expected: unknown): void { if (!sameLinkedValue(actual, expected)) denied(); }
const kvFor = (reg: LifecycleRegistry) => registryStores(reg).authKv;

async function readJournal(reg: LifecycleRegistry, ref: LinkRef): Promise<Snapshot<LinkedJournal>> {
  const j = need(await linkedRead(kvFor(reg), journalKey(ref), parseLinkedJournal));
  match(linkRef(j.row), ref);
  if (j.row.space !== registryStores(reg).space) denied();
  return j;
}
async function marker(reg: LifecycleRegistry, uid: string): Promise<Snapshot<LinkRef> | undefined> {
  const entry = await linkedRead(kvFor(reg), markerKey(assertLifecycleToken(uid)), parseLinkRef);
  if (entry && entry.row.lifecycleUid !== uid) denied();
  return entry;
}
export async function assertNoLinkedLifecycle(reg: LifecycleRegistry, uid: string): Promise<void> {
  if (await marker(reg, uid)) denied();
}
async function readCurrent(reg: LifecycleRegistry, target: Omit<LinkedTarget, "agentUid">, credentialId?: string) {
  const [head, gate] = await Promise.all([
    readLifecycleHeadForOperation(reg, target.owner, target.actor), observeGate(reg, target.lifecycleUid),
  ]);
  if (!gate || gate.row.state !== "open" || !head || head.mapping.state !== "active" ||
      head.mapping.lifecycleUid !== target.lifecycleUid || !head.mapping.currentCredentialId ||
      (credentialId !== undefined && credentialId !== head.mapping.currentCredentialId)) return denied();
  return { head, gate };
}
async function identity(reg: LifecycleRegistry, uid: string) {
  const key = agentIdentityKey(uid);
  return linkedRead(kvFor(reg), key, raw => parseAgentIdentityRecord(key, raw));
}
async function winner(reg: LifecycleRegistry, uid: string) {
  return linkedRead(kvFor(reg), winnerKey(uid), raw => {
    const ref = parseLinkRef(raw);
    if (ref.agentUid !== uid) denied();
    return ref;
  });
}

type BoundRun = LinkedTarget & { credentialId?: string; linkOperationId: string };
async function readyEvidence(reg: LifecycleRegistry, target: BoundRun, accountPublicKey: string) {
  const uid = target.lifecycleUid, pending = need(await marker(reg, uid)), ref = pending.row;
  if (ref.owner !== target.owner || ref.actor !== target.actor || ref.agentUid !== target.agentUid || ref.linkOperationId !== target.linkOperationId) denied();
  const [j, w, binding, i, current] = await Promise.all([
    readJournal(reg, ref), winner(reg, ref.agentUid), linkedRead(kvFor(reg), bindingKey(uid), parseBinding),
    identity(reg, ref.agentUid), readCurrent(reg, target, target.credentialId),
  ]);
  const { head, gate } = current;
  if (j.row.stage !== "ready" || !j.row.commit || j.row.accountPublicKey !== accountPublicKey ||
      i?.row.owner !== ref.owner || i.row.current.lifecycleUid !== uid || i.row.current.actor !== ref.actor ||
      head.mapping.currentCredentialId !== j.row.commit.credentialId || head.mapping.processEpoch !== j.row.commit.processEpoch ||
      gate.row.generation !== j.row.commit.generation) return denied();
  const active = need(w), bound = need(binding);
  match(active.row, ref);
  match(bound.row, { ...ref, accountPublicKey, space: j.row.space, ...j.row.commit });
  const evidence = contractDigest([pending.revision, j.revision, active.revision, bound.revision, head.revision, gate.row.generation]);
  return { evidence, gate };
}

export async function readVerifiedAgentLink(reg: LifecycleRegistry, target: BoundRun, accountPublicKey: string): Promise<string> {
  return (await readyEvidence(reg, target, accountPublicKey)).evidence;
}

function ownsGrant(dir: string, j: LinkedJournal): boolean {
  const row = findActorUnified(dir, j.owner, j.actor);
  if (!row) return false;
  if (row.lifecycleUid !== j.lifecycleUid) return false;
  if (row.kind !== "managed-agent" || row.agentUid !== j.agentUid || row.linkOperationId !== j.linkOperationId ||
      row.tokenHash !== j.tokenHash || row.custody?.kind !== "foreground" || row.parent !== undefined || row.role !== undefined ||
      row.eventPayloads !== j.eventPayloads) return denied();
  match([row.scope, row.allowSubscribe, row.allowPublish], [j.scope, j.allowSubscribe, j.allowPublish]);
  return true;
}

class LinkedAgentAuthority {
  constructor(private readonly d: Dependencies) {}

  private readonly serial = new Map<string, Promise<unknown>>();
  private async exclusive<T>(uid: string, owner: string, actor: string, run: () => Promise<T>): Promise<T> {
    const { serial, d } = this;
    const previous = serial.get(uid) ?? Promise.resolve();
    const flight = previous.catch(() => {}).then(() => d.serializedAlias(owner, actor, run));
    serial.set(uid, flight);
    try { return await flight; } finally { if (serial.get(uid) === flight) serial.delete(uid); }
  }
  private writeJournal(j: Snapshot<LinkedJournal>, patch: Partial<LinkedJournal>) {
    return linkedWrite(kvFor(this.d.reg), journalKey(j.row), { ...j.row, ...patch }, j.revision);
  }
  private mintedBy(j: LinkedJournal) { return `agent-link:${j.linkOperationId}`; }
  private linkAudit(j: LinkedJournal) {
    return immutableLinkedWrite(kvFor(this.d.reg), auditKey(j.linkOperationId, "link"), {
      accountPublicKey: j.accountPublicKey, space: j.space, ...linkRef(j), kind: "link",
      at: need(j.commit ?? undefined).at, by: "owner", approvalId: j.approvalId,
    });
  }

  private async predecessor(record: AgentIdentityRecord): Promise<"settled" | "live" | "unknown"> {
    const { reg } = this.d;
    const ref = await marker(reg, record.current.lifecycleUid);
    if (!ref || ref.row.owner !== record.owner || ref.row.agentUid !== record.agentUid || ref.row.actor !== record.current.actor) return "unknown";
    const j = await readJournal(reg, ref.row);
    if (j.row.stage !== "ended") return "live";
    if (!j.row.identityCommitted || (await observeGate(reg, j.row.lifecycleUid))?.row.state !== "retired") return "unknown";
    return "settled";
  }

  async admit(input: LinkedGrantInput): Promise<LinkedGrantAck> {
    const d = this.d, { reg, dir, accountPublicKey, space } = d;
    const kv = kvFor(reg), coordinates = { accountPublicKey, space };
    assertLinkedPermissions(input);
    const selection = input.agentLink;
    for (let attempt = 0; attempt < 4; attempt++) {
      const agentUid = selection.mode === "select" ? selection.agentUid : mintAgentUid();
      const result = await this.exclusive(agentUid, input.owner, input.actor, async () => {
        await d.assertHeld();
        if (!(await linkedRead(kv, LINK_ENABLE_KEY, raw => parseLinkedEnable(raw, coordinates)))?.row)
          throw new EpEnvelopeError("unimplemented", "linked foreground admission is disabled");
        const lifecycleUid = mintLifecycleUid(), linkOperationId = randomBytes(16).toString("hex");
        const prior = await identity(reg, agentUid), active = await winner(reg, agentUid);
        if (selection.mode === "create" && (prior || active || await linkedRead(kv, journalKey({ mode: selection.mode, agentUid, linkOperationId }), parseLinkedJournal))) return undefined;
        if (selection.mode === "select") {
          if (!prior || prior.row.owner !== input.owner) return denied();
          decideAgentLink(prior.row, { agentUid, owner: input.owner, actor: input.actor, lifecycleUid,
            now: Date.now(), authority: "owner", predecessor: await this.predecessor(prior.row) });
        }
        if (active && (await readJournal(reg, active.row)).row.stage !== "ended") return occupied();
        const head = await readLifecycleHeadForOperation(reg, input.owner, input.actor);
        if ((head && head.mapping.state !== "retired") || findActorUnified(dir, input.owner, input.actor))
          throw new EpEnvelopeError("conflict", "the actor alias already has a grant or a live lifecycle");
        const now = Date.now();
        if (input.approvalExpiresAtMs <= now) return denied();
        const { actorToken, tokenHash } = newActorToken();
        const j = parseLinkedJournal({ ...coordinates, v: 1, owner: input.owner, actor: input.actor, lifecycleUid, agentUid,
          linkOperationId, mode: selection.mode, requestId: input.requestId, approvalId: input.approvalId, stage: "intent",
          admittedAt: now, expectedIdentityRevision: prior?.revision ?? 0, identityCommitted: false, tokenHash,
          scope: input.scope, allowSubscribe: input.allowSubscribe, allowPublish: input.allowPublish, commit: null, end: null,
          ...(d.eventPayloadsWithheld ? { eventPayloads: false } : {}),
        });
        await linkedWrite(kv, approvalKey(j.approvalId), { ...coordinates, ...linkRef(j), requestId: j.requestId, at: now }, 0);
        const journal = await linkedWrite(kv, journalKey(j), j, 0);
        await linkedWrite(kv, winnerKey(agentUid), linkRef(j), active?.revision ?? 0);
        if (await tryReserveUid(reg, lifecycleUid, { owner: j.owner, actor: j.actor, mintedBy: this.mintedBy(j) }) !== "won") return unavailable();
        await linkedWrite(kv, markerKey(lifecycleUid), linkRef(j), 0);
        await d.assertHeld();
        grantLinkedActor(dir, { owner: j.owner, actor: j.actor, lifecycleUid, agentUid, linkOperationId, tokenHash,
          scope: j.scope, allowSubscribe: j.allowSubscribe, allowPublish: j.allowPublish,
          custody: { kind: "foreground" }, ...(j.eventPayloads === false ? { eventPayloads: false } : {}) });
        await d.provision(j);
        if (!ownsGrant(dir, j)) return denied();
        await this.writeJournal(journal, { stage: "pending" });
        await d.assertHeld();
        return { v: 1, state: "pending", owner: j.owner, actor: j.actor, lifecycleUid,
          agentLink: { mode: j.mode, agentUid }, actorToken } satisfies LinkedGrantAck;
      });
      if (result) return result;
    }
    return unavailable();
  }

  private async isIdentityCommit(j: LinkedJournal, current?: Snapshot<AgentIdentityRecord>): Promise<boolean> {
    const found = current ?? await identity(this.d.reg, j.agentUid);
    return j.commit !== null && found !== undefined && found.row.owner === j.owner && found.row.current.actor === j.actor &&
      found.row.current.lifecycleUid === j.lifecycleUid && found.row.current.linkedAt === j.commit.at &&
      found.row.current.via === (j.mode === "create" ? "mint" : "owner");
  }

  private async commit(j: Snapshot<LinkedJournal>): Promise<Snapshot<LinkedJournal>> {
    const d = this.d, { reg, accountPublicKey, space } = d;
    const kv = kvFor(reg);
    const row = j.row, mint = need(row.commit ?? undefined);
    const current = await identity(reg, row.agentUid);
    if (!await this.isIdentityCommit(row, current)) {
      if ((current?.revision ?? 0) !== row.expectedIdentityRevision) return occupied();
      const binding = { accountPublicKey, space, ...linkRef(row), ...mint };
      await immutableLinkedWrite(kv, bindingKey(row.lifecycleUid), binding);
      const candidate = row.mode === "create" ? mintedAgentIdentity({ ...row, now: mint.at }) :
        decideAgentLink(need(current).row, { ...row, now: mint.at, authority: "owner", predecessor: await this.predecessor(need(current).row) }).record;
      await d.assertHeld();
      await linkedWrite(kv, agentIdentityKey(row.agentUid), candidate, row.expectedIdentityRevision);
    }
    await this.linkAudit(row);
    return this.writeJournal(j, { stage: "ready", identityCommitted: true });
  }

  async exchange<T>(target: Secret, sign: (claims: { agentUid: string; credentialId: string }) => Promise<T>): Promise<T> {
    const d = this.d, { reg, dir, accountPublicKey } = d;
    return this.exclusive(target.agentUid, target.owner, target.actor, async () => {
      await d.assertHeld();
      const ref = need(await marker(reg, target.lifecycleUid)).row;
      if (ref.linkOperationId !== target.linkOperationId || ref.agentUid !== target.agentUid || ref.owner !== target.owner || ref.actor !== target.actor) return denied();
      let j = await readJournal(reg, ref);
      match(need(await winner(reg, target.agentUid)).row, ref);
      if (j.row.accountPublicKey !== accountPublicKey || !ownsGrant(dir, j.row)) return denied();
      ledgerAuthorizeAgentExchange(dir, target.owner, target.actor, target.actorToken);
      if (j.row.stage !== "pending" && j.row.stage !== "committing" && j.row.stage !== "ready") return denied();
      const credentialId = await ensureRootCredential(reg, { ...target, managerInstance: this.mintedBy(j.row) });
      const { head, gate } = await readCurrent(reg, target, credentialId);
      if (j.row.stage === "pending") j = await this.writeJournal(j, { stage: "committing", commit: {
        at: Date.now(), credentialId, generation: gate.row.generation, processEpoch: head.mapping.processEpoch,
      } });
      if (j.row.stage === "committing") {
        if (j.row.commit?.credentialId !== credentialId || j.row.commit.generation !== gate.row.generation || j.row.commit.processEpoch !== head.mapping.processEpoch) return denied();
        j = await this.commit(j);
      }
      const proof = await readyEvidence(reg, { ...target, credentialId }, accountPublicKey);
      const output = await sign({ agentUid: target.agentUid, credentialId });
      if (!ownsGrant(dir, j.row)) return denied();
      const after = await readyEvidence(reg, { ...target, credentialId }, accountPublicKey);
      if (proof.evidence !== after.evidence) return unavailable();
      await d.assertHeld();
      await linkedWrite(kvFor(reg), issuanceGateKey(target.lifecycleUid), after.gate.row, after.gate.revision);
      await d.assertHeld();
      return output;
    });
  }

  private async closeUid(j: LinkedJournal): Promise<void> {
    const d = this.d, { reg } = d;
    const uid = j.lifecycleUid;
    const pending = await marker(reg, uid);
    if (pending) match(pending.row, linkRef(j));
    const owned = await linkedRead(registryStores(reg).recordsKv, uidReservationKey(uid), raw => raw);
    if (!owned || !sameLinkedValue(owned.row, { owner: j.owner, actor: j.actor, mintedBy: this.mintedBy(j) })) {
      if (!pending && !j.commit) return;
      return unavailable();
    }
    const head = await readLifecycleHeadForOperation(reg, j.owner, j.actor);
    let gate = await observeGate(reg, uid);
    const wasHead = head?.mapping.lifecycleUid === uid;
    if (gate?.row.state === "frozen" && gate.row.op.kind === "activation") {
      await resumeActivation(reg, { owner: j.owner, actor: j.actor, lifecycleUid: uid, opId: gate.row.op.opId });
      gate = await observeGate(reg, uid);
    }
    if (wasHead) {
      if (!(await d.retire(j)).retired) return unavailable();
      const terminal = await readLifecycleHeadForOperation(reg, j.owner, j.actor);
      if (terminal?.mapping.lifecycleUid === uid && terminal.mapping.state !== "retired") return unavailable();
    } else if (!gate && !j.commit) {
      const opId = mintLifecycleUid();
      const unborn = await createGateFrozen(reg, { lifecycleUid: uid, op: { kind: "activation", opId } });
      await retireGate(reg, { lifecycleUid: uid, revision: unborn.revision, opId });
    } else if (gate?.row.state !== "retired") return unavailable();
    if ((await observeGate(reg, uid))?.row.state !== "retired") return unavailable();
    if (pending) await d.deprovision(j);
  }

  private async end(j: Snapshot<LinkedJournal>, by: "owner" | "recovery"): Promise<Retired> {
    const d = this.d, { accountPublicKey, space, reg, dir } = d;
    await d.assertHeld();
    if (j.row.accountPublicKey !== accountPublicKey) return denied();
    const lifecycleUid = j.row.lifecycleUid;
    if (j.row.stage === "ended") return { retired: true, lifecycleUid, alreadyRetired: true };
    const committed = j.row.identityCommitted || await this.isIdentityCommit(j.row);
    if (j.row.stage !== "retiring") j = await this.writeJournal(j, { stage: "retiring", identityCommitted: committed, end: { at: Date.now(), by } });
    if (committed) await this.linkAudit(j.row);
    if (ownsGrant(dir, j.row)) revokeLinkedActor(dir, j.row);
    await this.closeUid(j.row);
    await immutableLinkedWrite(kvFor(reg), auditKey(j.row.linkOperationId, "unlink"), { accountPublicKey, space, ...linkRef(j.row),
      kind: "unlink", ...j.row.end, linked: committed });
    await d.assertHeld();
    await this.writeJournal(j, { stage: "ended" });
    return { retired: true, lifecycleUid };
  }

  async retire(target: Retire): Promise<Retired> {
    const { reg } = this.d;
    const ref = (await marker(reg, target.lifecycleUid))?.row;
    if (!ref || ref.owner !== target.owner || ref.actor !== target.actor) return denied();
    return this.exclusive(ref.agentUid, ref.owner, ref.actor, async () => this.end(await readJournal(reg, ref), "owner"));
  }

  async recover(): Promise<void> {
    const d = this.d, { reg, barrierReg, space, accountPublicKey } = d;
    for (const entry of await registryScanner(barrierReg).scanLinkedAgentJournals()) {
      if (entry.op !== undefined && entry.op !== "PUT") return unavailable();
      const row = parseLinkedJournal(decodeLinkedRecord(entry.data));
      if (entry.key !== journalKey(row) || row.space !== space || row.accountPublicKey !== accountPublicKey) return denied();
      if (row.stage === "ready" || row.stage === "ended") continue;
      await this.exclusive(row.agentUid, row.owner, row.actor, async () => {
        const j = await readJournal(reg, linkRef(row));
        if (j.row.stage === "committing" && await this.isIdentityCommit(j.row)) {
          await this.linkAudit(j.row);
          // A committed but unreleased link is advanced forward; the owner can exchange or end it.
          await this.writeJournal(j, { stage: "ready", identityCommitted: true });
        } else await this.end(j, "recovery");
      }).catch(e => d.log(`auth-service: linked lifecycle ${row.lifecycleUid} remains fenced: ${e instanceof Error ? e.message : "recovery refused"}`));
    }
  }

}

export function linkedAgentAuthority(deps: Dependencies) {
  const authority = new LinkedAgentAuthority(deps);
  return { admit: authority.admit.bind(authority), exchange: authority.exchange.bind(authority),
    retire: authority.retire.bind(authority), recover: authority.recover.bind(authority) };
}
