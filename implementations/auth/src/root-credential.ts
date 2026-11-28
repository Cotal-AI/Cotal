/**
 * The exchange-time ROOT-credential ensure (R1 i3) — the production issuance seam that makes the
 * connect arm's deny-new enforceable. Every bearer must carry `act.credentialId` naming a LIVE
 * `cred.<uid>.<credid>` row, so the EXCHANGE (the only place bearer bytes are signed) is where the
 * incarnation's root credential is activated and minted, RELEASE-LAST (SPEC 13.1 mint protocol):
 *
 *   activate (head + open gate, at the GRANT's uid) → write the ACTIVE `cred.` row (durable
 *   FIRST) → gate finalize CAS → head `currentCredentialId` CAS LAST → only then does the caller
 *   sign/release the bearer bytes.
 *
 * Crash recovery splits on WHERE the crash landed (the single norm, detailed under INCARNATION-WIDE
 * below): a PRE-head crash (an active `cred.` row the head never stamped) was carried by no bearer
 * — root connects check head equality — so the retry mints a FRESH id and the orphan row is never
 * exported; a POST-head crash re-exports the SAME already-stamped id, which is correct because that
 * id IS the incarnation's live root. There is exactly one root credential per incarnation.
 *
 * NO ROTATION LIVES HERE: an existing head stamp is returned (after proving its row still active
 * and unexpired) or refused loudly — flipping a head's root credential without the full
 * family-revoke barrier would leave the old root's descendants connectable under the leaf check,
 * so a revoked/expired root credential and a uid transition (same-alias re-grant/respawn while
 * the predecessor incarnation is live) both REFUSE the exchange and name the barrier gap (R1:
 * production issuance runs no takeover/retirement barrier).
 *
 * ROOT IS INCARNATION-WIDE (SPEC 13.1, ratified 2026-07-16): ONE root credential per incarnation,
 * re-stamped (the same id returned) on every exchange for the incarnation's whole 90d life — NOT
 * a fresh id per exchange. This is deliberate and is what makes revocation total: one
 * `cred.<uid>.<credid>` row revoke denies EVERY bearer of the incarnation at once (they all carry
 * that id). It also removes the "unobserved fresh-credential release" ambiguity a per-exchange
 * model had: a crash after the head CAS (with the bearer bytes possibly released) re-exports the
 * SAME id on the next exchange, which is CORRECT — that id genuinely IS the incarnation's live
 * root, so there is nothing loose to revoke-and-evict. The only crash pin left is the PRE-head
 * one (an active-but-unstamped row is denied by head equality; the head-CAS loser revokes its
 * never-exported row). Rotation of the incarnation's root remains exclusively a barrier's job.
 */
import { EpEnvelopeError, mintLifecycleUid } from "@cotal-ai/core";
import { grantCommandLine } from "./grant-command.js";
import type { ActorKind, ActorRow } from "./ledger.js";
import {
  assertOrdinaryRegistryMutation,
  activateLifecycleAtUid,
  observeGate,
  readLifecycleHeadForOperation,
  registryStores,
  setCurrentRootCredential,
  type LifecycleRegistry,
} from "./lifecycle-registry.js";
import {
  credRowKey,
  finalizeAgentMint,
  markLedgerRowRevoked,
  parseLedgerRow,
  stageAgentMint,
  type CredentialLedgerRow,
} from "./credential-ledger.js";

/** Root-credential row lifetime (ms — ledger-row `exp` rides milliseconds). LONG by design: a
 *  root credential lives with its incarnation, and its ROTATION is a family-revoke barrier
 *  (takeover/retirement) that production issuance does not run in R1 — an expired root refuses
 *  every new exchange/connect until the actor is re-granted (a fresh incarnation). Named
 *  residual: rotation wiring is the takeover slice's job, not a TTL policy knob here. */
export const ROOT_CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const NO_REPAIR_COORDINATES = "Ask the operator who granted this identity to provision a fresh lifecycle with the same access.";

function rootRepair(row: (ActorRow & { kind: ActorKind }) | undefined, space: string): string {
  const spaceFlag = `--space '${space.replaceAll("'", "'\\''")}'`;
  if (row?.kind === "interactive" && row.eventPayloads !== false) {
    const parent = row.parent ? ` --parent '${row.parent.replaceAll("'", "'\\''")}'` : "";
    return `Ask the space operator to re-grant exactly the same access with \`${grantCommandLine(row.owner, row.actor, row)}${parent} ${spaceFlag}\` on the machine that holds the grant.`;
  }
  if (row?.kind === "interactive") return "Ask the space operator to re-grant this actor with the same access and event payload restriction.";
  if (row?.custody?.kind === "foreground") return "End this foreground launch. In the original `cotal spawn` command, change `--name` to `<new_name>`, or add `--name <new_name>` if it had none. Rerun the command to start a new agent. The old name stays taken, and no command in this release frees it. The old agent's permissions don't move. Messages to its old name and direct messages already queued for it won't reach the new agent.";
  if (row?.custody) return `Find this lifecycle's seat with \`cotal ps --wide --on ${row.custody.instanceId} ${spaceFlag}\` and stop that seat on the same manager. Then rerun its original \`cotal spawn\` command.`;
  return NO_REPAIR_COORDINATES;
}

/** Leader-semantics single-row read on the auth store (the bucket is `allow_direct=false` by
 *  shape, so `kv.get` is leader-served). A DEL/PURGE marker refuses loudly — a revoked
 *  credential is a row with `state:"revoked"`, never a tombstone. */
async function readCredRow(reg: LifecycleRegistry, lifecycleUid: string, credentialId: string): Promise<CredentialLedgerRow | undefined> {
  const { authKv } = registryStores(reg);
  const key = credRowKey(lifecycleUid, credentialId);
  const entry = await authKv.get(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the credential row ${key} carries a ${entry.operation} marker; a deletion is never absence (corruption, SPEC 13.12)`);
  return parseLedgerRow(entry.value, key);
}

/**
 * Ensure the incarnation `(owner, actor, lifecycleUid)` has its ACTIVE root credential and return
 * its id for the bearer's `act.credentialId` claim. Idempotent and race-converging: concurrent
 * exchanges for the same virgin alias converge on ONE winning credential (the loser's staged row
 * is revoked before it was ever exported). Refuses loudly (=> the exchange is denied):
 *
 *  - a live predecessor incarnation at a different uid (the R1 takeover gap),
 *  - a retiring alias / a terminally burned uid / a foreign uid reservation,
 *  - a revoked or expired current root credential (rotation is a barrier, not a re-mint),
 *  - any garbled trusted-path state.
 */
export async function ensureRootCredential(
  reg: LifecycleRegistry,
  args: { owner: string; actor: string; lifecycleUid: string; managerInstance: string; now?: () => number },
  repair?: () => readonly [row: (ActorRow & { kind: ActorKind }) | undefined, space: string],
): Promise<string> {
  await assertOrdinaryRegistryMutation(reg, args);
  const now = args.now ?? Date.now;
  const { owner, actor, lifecycleUid } = args;
  const holder = `${owner}.${actor}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await readLifecycleHeadForOperation(reg, owner, actor);
    if (head !== undefined && head.mapping.state === "active" && head.mapping.lifecycleUid === lifecycleUid && head.mapping.currentCredentialId !== undefined) {
      // Fast path: the incarnation already carries its root stamp — prove the row still lives.
      const credid = head.mapping.currentCredentialId;
      const row = await readCredRow(reg, lifecycleUid, credid);
      if (row === undefined)
        throw new EpEnvelopeError("internal", `the head for "${owner}/${actor}" names root credential ${credid} but cred.${lifecycleUid}.${credid} is absent; the row is durable BEFORE the head stamp, so this is corruption (SPEC 13.1)`);
      if (row.state !== "active")
        throw new EpEnvelopeError("permission-denied", `the root credential for "${owner}/${actor}" (${credid}) is ${row.state}; rotating a root credential is the family-revoke barrier's job, never a re-mint - re-grant (respawn) the actor for a fresh incarnation (SPEC 13.1)`);
      if (row.holderPrincipal !== holder || row.lifecycleUid !== lifecycleUid)
        throw new EpEnvelopeError("internal", `the root credential row for "${owner}/${actor}" binds "${row.holderPrincipal}"/${row.lifecycleUid}, not this incarnation; garbled trusted-path state never authorizes (SPEC 13.1)`);
      if (row.exp <= now()) {
        let next = NO_REPAIR_COORDINATES;
        try { if (repair) next = rootRepair(...repair()); } catch { /* A diagnostic read cannot change the refusal. */ }
        throw new EpEnvelopeError("permission-denied", `The root credential for "${owner}/${actor}" expired at ${new Date(row.exp).toISOString()} (UTC). ${next}`);
      }
      return credid;
    }

    // Activation (idempotent; refuses the R1 takeover-gap and every foreign/retiring state).
    await activateLifecycleAtUid(reg, { owner, actor, lifecycleUid, managerInstance: args.managerInstance });

    // Mint RELEASE-LAST under the open gate: active row durable FIRST, gate finalize, head CAS.
    const credentialId = mintLifecycleUid();
    const staged = await stageAgentMint(reg, {
      lifecycleUid,
      credentialId,
      holderPrincipal: holder,
      sourceChain: ["root"],
      exp: now() + ROOT_CREDENTIAL_TTL_MS,
    });
    try {
      await finalizeAgentMint(reg, staged);
    } catch (e) {
      if (!(e instanceof EpEnvelopeError) || e.code !== "permission-denied") throw e;
      // Finalize revokes the losing row. A sibling touch keeps the generation open, but a
      // barrier freezes it or reopens it at a new generation.
      const gate = await observeGate(reg, lifecycleUid);
      if (gate?.row.state === "open" && gate.row.generation === staged.generation) continue;
      throw e;
    }
    try {
      await setCurrentRootCredential(reg, { owner, actor, lifecycleUid, credentialId });
      return credentialId;
    } catch (e) {
      // The stamp lost (a sibling exchange won the head CAS, or the head moved). Our finalized
      // row was NEVER exported (release-last), so revoke it — the family carries no live orphan —
      // and converge on the winner's stamp via the retry read.
      await markLedgerRowRevoked(registryStores(reg).authKv, staged.rowKey);
      if (e instanceof EpEnvelopeError && (e.code === "permission-denied" || e.code === "conflict" || e.code === "failed-precondition")) continue;
      throw e;
    }
  }
  throw new EpEnvelopeError("unavailable", `the root-credential ensure for "${owner}/${actor}" at uid ${lifecycleUid} keeps losing its head stamp to concurrent movement; re-exchange (SPEC 13.1)`);
}
