import * as prompts from "../lib/prompts.js";
import { contractDigest, mintCreds, newIdentity, type ChannelConfig, type ChannelDefaults } from "@cotal-ai/core";
import { brokerAddressForDisplay, canonicalRoot, CommandFailure, connectOrThrow, findMesh, oneLine, presentationOf, readMaintenanceJournal, acquireMaintenanceLock, releaseMaintenanceLock, userViewAuth, writeResult, type Report } from "@cotal-ai/workspace";
import { listLedgerFiles } from "../lib/manifest/ledger.js";
import { personaCatalog } from "../lib/persona-files.js";
import { listAdditiveTeamAttempts, removedAdditiveDeploymentIds, type AdditiveTeamAttempt } from "../lib/team-additive-attempt.js";
import { CARD_TERMINAL_PHASES, openChannelCardRegistry, readChannelMemberImpact, writeChannelRemovalAttempt, writeChannelRemovalReceipt, writeChannelRemovalStep, type CardObservation, type CardReceipt, type ChannelRemovalAttempt, type ChannelRemovalStep, type RemovedChannel } from "../lib/team-channel-removal.js";
import { classifyCard, removedCard, type CardSettlement } from "../lib/team-removal-reconcile.js";
import { listFreshTeamAttempts, listFreshTeamSummaries } from "../lib/team-fresh.js";
import { canPrompt } from "./meshes-wizard.js";
import type { TeamValues } from "./team.js";

type Registry = Awaited<ReturnType<typeof openChannelCardRegistry>>;
export type CardOutcome = RemovedChannel | { name: string; createdRevision: number; outcome: "conflict" | "unknown" | "observed-superseded" };
export interface CardRemovalRun { intentAttempted: boolean; returned: boolean; outcomes: CardOutcome[]; failure?: CommandFailure }

/** The settings each card held explicitly, so a reader sees what falls back to the space defaults. */
function fallback(config: ChannelConfig | null, defaults: ChannelDefaults | null) {
  return {
    deliveryClass: { card: config?.deliveryClass ?? null, after: defaults?.deliveryClass ?? "durable" },
    replay: { card: config?.replay ?? null, after: defaults?.replay ?? true },
    replayWindow: { card: config?.replayWindow ?? null, after: defaults?.replayWindow ?? null },
    describedContextRemoved: config?.description !== undefined || config?.instructions !== undefined,
  };
}

/** The card phase of a team removal: only the registry cards a returned deployment created, each by
 * a native delete conditioned on its returned create revision. This is metadata removal: grants,
 * readers, retained history and the channel subject are untouched, and the space defaults then
 * apply. A mixed card phase is accepted only once the agent-retirement receipt for the same
 * deployment reads back complete at execute time. `close` must run once preparation returned. */
export async function prepareCardRemoval(input: { root: string; space: string; deploymentId: string; original: AdditiveTeamAttempt; receipt: CardReceipt; apply: boolean }) {
  const { root, space, deploymentId, original, receipt, apply } = input, target = { root, space, deploymentId };
  if (!receipt.createdChannels.length || receipt.createdChannels.length > 100) throw new CommandFailure("refused", "UNSUPPORTED", "guarded card removal needs one to 100 returned cards with their create revisions", { target });
  const inventory = listAdditiveTeamAttempts(root);
  // Another recorded deployment naming the same channel shares no authority over this card.
  const names = receipt.createdChannels.map((row) => row.name);
  let legacy: ReturnType<typeof listLedgerFiles>, boots: ReturnType<typeof listFreshTeamAttempts>, summaries: ReturnType<typeof listFreshTeamSummaries>;
  try { legacy = listLedgerFiles(root, { requireReadable: true }); boots = listFreshTeamAttempts(root); summaries = listFreshTeamSummaries(root); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the root's other deployment records could not be read; no exclusive card ownership was inferred", { target }); }
  if (inventory.refused.length || legacy.refused.length || boots.refused.length || summaries.refused.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "another deployment or removal record is unreadable; it may name these cards, so none was deleted", { target });
  if (legacy.valid.some(({ ledger }) => ledger.runId === deploymentId) || boots.valid.some((row) => row.deploymentId === deploymentId) || summaries.valid.some((row) => row.deploymentId === deploymentId)) throw new CommandFailure("refused", "CONFLICT", "a fresh or legacy record shares this deployment ID; no unique card ownership was inferred", { target });
  const removed = removedAdditiveDeploymentIds(inventory);
  const shared = names.filter((name) => inventory.valid.some((row) => row.deploymentId !== deploymentId && !removed.has(row.deploymentId) && row.declaredChannels.includes(name))
    || legacy.valid.some(({ ledger }) => ledger.space === space && ledger.created.channels.includes(name))
    || summaries.valid.some((row) => row.space === space && row.declaredChannels.includes(name)));
  if (shared.length) throw new CommandFailure("refused", "CONFLICT", "another retained deployment record also names one or more of these channels; no card was deleted", { target: { ...target, sharedChannels: shared } });

  const selected = findMesh(space);
  if (!selected || canonicalRoot(selected.root) !== root || selected.server !== original.server || selected.mode !== original.authMode || (selected.tlsRequired === true) !== original.tlsRequired || selected.server.includes(",")) throw new CommandFailure("refused", "CONFLICT", "the registered root, broker, auth mode or transport differs from the original deployment", { target });
  const conn = await connectOrThrow({ space }, "deployer", { readOnly: true });
  if (!conn.root || canonicalRoot(conn.root) !== root || conn.server !== original.server || conn.mode !== original.authMode || conn.tls !== original.tlsRequired) throw new CommandFailure("refused", "CONFLICT", "the scoped connection differs from the original root, broker, auth mode or transport; no card was deleted", { target });
  if (conn.mode === "auth" && !conn.auth) throw new CommandFailure("refused", "PERMISSION_DENIED", "the registered static mesh has no signer for a scoped channel writer; no other credential was substituted", { target });
  // A preview reads with the deployer view only; the channel-writer is issued just for an apply.
  let readAuth: { creds?: string; bearer?: string; sentinelCreds?: string } = { creds: conn.creds };
  let writerAuth: { creds?: string; bearer?: string; sentinelCreds?: string } = { creds: conn.creds };
  if (conn.mode === "user") {
    let read: Awaited<ReturnType<typeof userViewAuth>>, write: Awaited<ReturnType<typeof userViewAuth>> | undefined;
    try { read = await userViewAuth(conn, "deployer"); if (apply) write = await userViewAuth(conn, "channel-writer"); }
    catch (error) {
      const cause = (error as { code?: unknown }).code;
      const code = cause === "signed-out" ? "AUTH_REQUIRED" : cause === "refused" ? "PERMISSION_DENIED" : "DEPENDENCY_UNAVAILABLE";
      throw new CommandFailure("refused", code, "the user-auth deployer or channel-writer view was not issued; no identity or broader credential was substituted", { target });
    }
    if (!conn.epCaller || read.owner !== conn.epCaller.owner || read.actor !== conn.epCaller.actor || write && (write.owner !== read.owner || write.actor !== read.actor)) throw new CommandFailure("refused", "CONFLICT", "the user bearer, deployer view and channel-writer view do not name one caller; no grant was substituted", { target });
    readAuth = { bearer: read.bearer, sentinelCreds: read.sentinelCreds };
    writerAuth = write ? { bearer: write.bearer, sentinelCreds: write.sentinelCreds } : readAuth;
  } else if (conn.mode === "auth" && apply) writerAuth = { creds: await mintCreds(conn.auth!, newIdentity(), "channel-writer") };

  const digest = contractDigest(receipt);
  const unchanged = () => {
    if (JSON.stringify(findMesh(space)) !== JSON.stringify(selected)) throw new CommandFailure("refused", "CONFLICT", "the selected registration changed; no later card delete was submitted", { target });
    const current = listAdditiveTeamAttempts(root), now = current.returned.find((row) => row.deploymentId === deploymentId);
    if (current.refused.length || !now || contractDigest(now) !== digest || JSON.stringify(current.valid.find((row) => row.deploymentId === deploymentId)) !== JSON.stringify(original)) throw new CommandFailure("refused", "CONFLICT", "the original intent, returned receipt or removal records changed; no later card delete was submitted", { target });
  };
  let registry: Registry;
  try { registry = await openChannelCardRegistry({ server: conn.server, space, tls: conn.tls, auth: writerAuth }); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the scoped registry connection could not be opened; no card was deleted", { target }); }
  const observeAll = async () => {
    const rows: CardObservation[] = [];
    for (const row of receipt.createdChannels) rows.push(await registry.observe(row.name, row.revision));
    return rows;
  };
  let closed = false, closeUnconfirmed = false;
  const close = async () => { if (closed) return; closed = true; try { await registry.close(); } catch { closeUnconfirmed = true; } };
  try {
    unchanged();
    let cards: CardObservation[], defaults: ChannelDefaults | null;
    try { cards = await observeAll(); defaults = await registry.defaults(); }
    catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the registry read did not complete; unchanged or missing cards were not inferred", { target }); }
    const members = await readChannelMemberImpact(conn.server, space, conn.tls, readAuth, names);
    const preview = impactOf(original, receipt, cards, defaults, members);
    const changed = cards.filter((row) => row.state === "changed");
    if (changed.length) throw new CommandFailure("refused", "CONFLICT", "one or more cards changed after this deployment created them; changed metadata is not owned and no card was deleted", { target: { ...target, changedChannels: changed.map((row) => row.name) } });
    return { preview, close, closeUnconfirmed: () => closeUnconfirmed, async execute(): Promise<CardRemovalRun> {
      let intent: ChannelRemovalAttempt | undefined, intentAttempted = false, returned = false, failure: CommandFailure | undefined;
      const outcomes: CardOutcome[] = [];
      try {
        unchanged();
        const current = listAdditiveTeamAttempts(root);
        if (readMaintenanceJournal(root) || current.channelRemoval?.attempts.some((row) => row.deploymentId === deploymentId)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "maintenance or another removal attempt appeared before intent publication; no card was deleted", { target });
        if ((await observeAll()).some((row) => row.state === "changed")) throw new CommandFailure("refused", "CONFLICT", "a card changed before intent publication; no card was deleted", { target });
        // The intent names the registry stream incarnation the deletes go to, so a later
        // reconciliation can refuse observations from a recreated or swapped registry.
        let registryIdentity: Awaited<ReturnType<Registry["identity"]>>;
        try { registryIdentity = await registry.identity(); }
        catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the registry stream identity could not be read before intent publication; no card was deleted", { target }); }
        intentAttempted = true;
        intent = writeChannelRemovalAttempt(root, original, receipt, new Set(current.removal?.returned.map((row) => row.deploymentId) ?? []), registryIdentity);
        for (const [ordinal, row] of receipt.createdChannels.entries()) {
          unchanged();
          const before = await registry.observe(row.name, row.revision);
          if (before.state === "absent") {
            writeChannelRemovalStep(root, intent, ordinal, { phase: "absent", markerRevision: before.revision });
            outcomes.push({ name: row.name, createdRevision: row.revision, outcome: "absent", markerRevision: before.revision });
            continue;
          }
          if (before.state === "changed") throw new CommandFailure("refused", "CONFLICT", "a card changed before its delete; it and later cards were not deleted", { target: { ...target, channel: row.name } });
          writeChannelRemovalStep(root, intent, ordinal, { phase: "submitted" });
          outcomes.push({ name: row.name, createdRevision: row.revision, outcome: "unknown" });
          const answer = await registry.deleteAt(row.name, row.revision);
          if (answer === "not-executed") {
            outcomes[outcomes.length - 1] = { name: row.name, createdRevision: row.revision, outcome: "conflict" };
            writeChannelRemovalStep(root, intent, ordinal, { phase: "conflict" });
            throw new CommandFailure("refused", "CONFLICT", "the broker refused the conditioned delete because the card moved; it and later cards were not deleted", { target: { ...target, channel: row.name } });
          }
          const after = await registry.observe(row.name, row.revision);
          if (after.state !== "absent" || after.revision === null || after.revision <= row.revision) throw new Error("the acknowledged delete did not read back as a later removal marker");
          writeChannelRemovalStep(root, intent, ordinal, { phase: "deleted", markerRevision: after.revision });
          outcomes[outcomes.length - 1] = { name: row.name, createdRevision: row.revision, outcome: "deleted", markerRevision: after.revision };
        }
        writeChannelRemovalReceipt(root, intent, outcomes as RemovedChannel[]);
        if (!listAdditiveTeamAttempts(root).channelRemoval?.returned.some((row) => row.deploymentId === deploymentId)) throw new Error("the complete card removal receipt did not read back");
        returned = true;
      } catch (error) {
        failure = error instanceof CommandFailure ? error : new CommandFailure(intentAttempted ? "unknown" : "refused", intentAttempted ? "OPERATION_UNKNOWN" : "TARGET_UNAVAILABLE", intentAttempted ? "not every conditioned delete and durable record was confirmed; no delete was replayed and later cards were not attempted" : "removal preflight did not confirm an unchanged target; no card was deleted", { target });
        if (intentAttempted) {
          const unknown = outcomes.some((row) => row.outcome === "unknown"), done = outcomes.some((row) => row.outcome === "deleted");
          failure = new CommandFailure(unknown ? "unknown" : done ? "partial" : failure.outcome, unknown ? "OPERATION_UNKNOWN" : done ? "OPERATION_PARTIAL" : failure.code, "the card removal stopped before every original card settled; the intent stays retained and nothing was retried", { target, native: { code: failure.code, outcome: failure.outcome }, changed: outcomes.filter((row) => row.outcome === "deleted") });
        }
      }
      return { intentAttempted, returned, outcomes, ...(failure ? { failure } : {}) };
    } };
  } catch (error) { await close(); throw error; }
}

/** One row per original card: its delete, conflict, unknown or unattempted outcome. */
export function cardOutcomeRows(receipt: CardReceipt, outcomes: readonly CardOutcome[]) {
  return receipt.createdChannels.map((row) => { const seen = outcomes.find((item) => item.name === row.name); return { channel: `#${row.name}`, created: String(row.revision), outcome: !seen ? "not attempted" : seen.outcome === "deleted" ? `deleted (marker ${"markerRevision" in seen ? seen.markerRevision : "?"})` : seen.outcome === "absent" ? "already absent; remover unknown" : seen.outcome === "observed-removed" ? "removed after an unconfirmed delete; remover unknown" : seen.outcome === "observed-superseded" ? "replaced after an unconfirmed delete; not owned" : seen.outcome === "conflict" ? "card moved; not deleted" : "delete outcome unknown" }; });
}

export interface CardReconcileRun { recorded: CardSettlement[]; settlements: CardSettlement[]; returned: boolean; failure?: CommandFailure }

/** Reconcile the original card phase of an unsettled intent from native observation only. It reads
 * the registry with the deployer view and writes nothing to the broker: no delete, retry or
 * replacement. Each unconfirmed submission settles only when the card's last message in the
 * intent's own registry stream rules out every other outcome. Never-submitted cards are reported
 * unattempted and are not continued. A receipt is written only when every card counts as removed. */
export async function prepareCardReconcile(input: { root: string; space: string; deploymentId: string; original: AdditiveTeamAttempt; receipt: CardReceipt; intent: ChannelRemovalAttempt }) {
  const { root, space, deploymentId, original, receipt, intent } = input, target = { root, space, deploymentId };
  if (intent.channels.length !== receipt.createdChannels.length || intent.channels.some((row, ordinal) => row.name !== receipt.createdChannels[ordinal]!.name || row.createdRevision !== receipt.createdChannels[ordinal]!.revision)) throw new CommandFailure("refused", "CONFLICT", "the removal intent does not name the original returned cards; nothing was reconciled", { target });
  const selected = findMesh(space);
  if (!selected || canonicalRoot(selected.root) !== root || selected.server !== original.server || selected.server !== intent.server || selected.mode !== original.authMode || (selected.tlsRequired === true) !== original.tlsRequired || selected.server.includes(",")) throw new CommandFailure("refused", "CONFLICT", "the registered root, broker, auth mode or transport differs from the original deployment and its removal intent", { target });
  const conn = await connectOrThrow({ space }, "deployer", { readOnly: true });
  if (!conn.root || canonicalRoot(conn.root) !== root || conn.server !== original.server || conn.mode !== original.authMode || conn.tls !== original.tlsRequired) throw new CommandFailure("refused", "CONFLICT", "the scoped connection differs from the original root, broker, auth mode or transport; nothing was reconciled", { target });
  let auth: { creds?: string; bearer?: string; sentinelCreds?: string } = { creds: conn.creds };
  if (conn.mode === "user") {
    let read: Awaited<ReturnType<typeof userViewAuth>>;
    try { read = await userViewAuth(conn, "deployer"); }
    catch (error) {
      const cause = (error as { code?: unknown }).code;
      throw new CommandFailure("refused", cause === "signed-out" ? "AUTH_REQUIRED" : cause === "refused" ? "PERMISSION_DENIED" : "DEPENDENCY_UNAVAILABLE", "the user-auth deployer view was not issued; no broader credential was substituted", { target });
    }
    if (!conn.epCaller || read.owner !== conn.epCaller.owner || read.actor !== conn.epCaller.actor) throw new CommandFailure("refused", "CONFLICT", "the user bearer and deployer view do not name one caller; no grant was substituted", { target });
    auth = { bearer: read.bearer, sentinelCreds: read.sentinelCreds };
  }
  const digest = contractDigest(receipt), intentText = JSON.stringify(intent);
  const unchanged = () => {
    if (JSON.stringify(findMesh(space)) !== JSON.stringify(selected)) throw new CommandFailure("refused", "CONFLICT", "the selected registration changed; nothing further was recorded", { target });
    const current = listAdditiveTeamAttempts(root), now = current.returned.find((row) => row.deploymentId === deploymentId);
    if (current.refused.length || !now || contractDigest(now) !== digest || JSON.stringify(current.valid.find((row) => row.deploymentId === deploymentId)) !== JSON.stringify(original) || JSON.stringify(current.channelRemoval?.attempts.find((row) => row.deploymentId === deploymentId)) !== intentText || current.channelRemoval?.returned.some((row) => row.deploymentId === deploymentId)) throw new CommandFailure("refused", "CONFLICT", "the original deployment, its removal intent or its removal records changed; nothing further was recorded", { target });
    return current.channelRemoval!.steps.filter((row) => row.deploymentId === deploymentId);
  };
  let registry: Registry;
  try { registry = await openChannelCardRegistry({ server: conn.server, space, tls: conn.tls, auth }); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the scoped registry connection could not be opened; nothing was reconciled", { target }); }
  let closed = false, closeUnconfirmed = false;
  const close = async () => { if (closed) return; closed = true; try { await registry.close(); } catch { closeUnconfirmed = true; } };
  /** Read the stream identity, every submitted card's last message, then the identity again. A
   * changed stream between the two reads refuses, so all messages come from one incarnation. */
  const classify = async (steps: readonly ChannelRemovalStep[]): Promise<CardSettlement[]> => {
    const pending = intent.channels.map((_, ordinal) => steps.some((row) => row.ordinal === ordinal && row.phase === "submitted") && !steps.some((row) => row.ordinal === ordinal && (CARD_TERMINAL_PHASES as readonly string[]).includes(row.phase)));
    if (!pending.some(Boolean) || !intent.registry) return intent.channels.map((_, ordinal) => classifyCard(intent, steps, ordinal, undefined, undefined));
    let before: Awaited<ReturnType<Registry["identity"]>>, after: Awaited<ReturnType<Registry["identity"]>>;
    const messages: (Awaited<ReturnType<Registry["lastMessage"]>> | undefined)[] = [];
    try {
      before = await registry.identity();
      for (const [ordinal, row] of intent.channels.entries()) messages.push(pending[ordinal] ? await registry.lastMessage(row.name) : undefined);
      after = await registry.identity();
    } catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "a registry read did not complete; no card was treated as absent or unchanged", { target }); }
    if (before.stream !== after.stream || before.created !== after.created) throw new CommandFailure("refused", "CONFLICT", "the registry stream changed during the observation; nothing was recorded", { target });
    return intent.channels.map((_, ordinal) => classifyCard(intent, steps, ordinal, messages[ordinal], after));
  };
  try {
    const settlements = await classify(unchanged());
    return { settlements, close, closeUnconfirmed: () => closeUnconfirmed, async execute(): Promise<CardReconcileRun> {
      const recorded: CardSettlement[] = [];
      let returned = false, failure: CommandFailure | undefined, current: CardSettlement[] = settlements;
      try {
        if (readMaintenanceJournal(root)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a maintenance operation is recorded; nothing was reconciled", { target });
        // Re-observe under the lock, so the recorded facts are the ones this holder saw.
        current = await classify(unchanged());
        const contradiction = current.find((row) => row.state === "contradiction");
        if (contradiction) throw new CommandFailure("refused", "CONFLICT", `card #${contradiction.name}: ${contradiction.state === "contradiction" ? contradiction.reason : ""}; nothing was recorded`, { target: { ...target, channel: contradiction.name } });
        for (const row of current) {
          if (row.state !== "record") continue;
          unchanged();
          writeChannelRemovalStep(root, intent, row.ordinal, row.record);
          recorded.push(row);
        }
        // Each recorded card now has its terminal step, so it reads back as settled from the journal.
        const steps = unchanged();
        current = current.map((prior) => prior.state === "record" ? classifyCard(intent, steps, prior.ordinal, undefined, undefined) : prior);
        if (recorded.some((row) => current[row.ordinal]!.state !== "settled")) throw new Error("a recorded card observation did not read back");
        const removedRows = current.map(removedCard);
        if (removedRows.every((row) => row !== null)) {
          writeChannelRemovalReceipt(root, intent, removedRows as RemovedChannel[]);
          if (!listAdditiveTeamAttempts(root).channelRemoval?.returned.some((row) => row.deploymentId === deploymentId)) throw new Error("the reconciled card removal receipt did not read back");
          returned = true;
        }
      } catch (error) {
        failure = error instanceof CommandFailure ? error : new CommandFailure(recorded.length ? "partial" : "unknown", recorded.length ? "OPERATION_PARTIAL" : "OPERATION_UNKNOWN", "not every reconciliation record was confirmed; no native effect was attempted", { target, changed: recorded.map((row) => row.name) });
      }
      return { recorded, settlements: current, returned, ...(failure ? { failure } : {}) };
    } };
  } catch (error) { await close(); throw error; }
}

/** One row per original card for a reconciliation preview or result. */
export function cardSettlementRows(settlements: readonly CardSettlement[]) {
  return settlements.map((row) => ({ channel: `#${row.name}`, created: String(row.createdRevision), state: cardSettlementText(row) }));
}
function cardSettlementText(row: CardSettlement): string {
  if (row.state === "unattempted") return "never submitted; not attempted";
  if (row.state === "contradiction") return `contradiction: ${row.reason}`;
  if (row.state === "unknown") return row.reason === "created-revision-still-current" ? "delete outcome unknown; card still at its create revision" : "delete outcome unknown; the intent names no registry stream";
  const phase = row.state === "record" ? row.record.phase : row.step.phase;
  const source = row.state === "record" ? row.record : row.step;
  const marker = "markerRevision" in source ? source.markerRevision : "currentRevision" in source ? source.currentRevision : null;
  const prefix = row.state === "record" ? "observed now: " : "recorded: ";
  return prefix + (phase === "deleted" ? `deleted (marker ${marker})` : phase === "absent" ? "already absent; remover unknown" : phase === "conflict" ? "card moved; not deleted" : phase === "observed-removed" ? `removed; remover unknown${marker === null ? " (no message left)" : ` (marker ${marker})`}` : `replaced at ${marker}; not owned`);
}

/** Settle the card phase of an unsettled channel-only intent from native observation. */
async function reconcileChannelTeam(input: { root: string; space: string; deploymentId: string; original: AdditiveTeamAttempt; receipt: CardReceipt; intent: ChannelRemovalAttempt; values: TeamValues }): Promise<void> {
  const { root, space, deploymentId, original, receipt, intent, values } = input, target = { root, space, deploymentId };
  const phase = await prepareCardReconcile({ root, space, deploymentId, original, receipt, intent });
  let run: CardReconcileRun | undefined, lockFailure: CommandFailure | undefined;
  try {
    const preview = { kind: "channel-team-removal-reconcile-preview" as const, deploymentId, cards: phase.settlements, recordable: phase.settlements.filter((row) => row.state === "record").length, unattempted: phase.settlements.filter((row) => row.state === "unattempted").length, unknown: phase.settlements.filter((row) => row.state === "unknown").length, effectAttempted: false as const, continuationOffered: false as const };
    if (values["dry-run"] || !values.yes && (!canPrompt() || values.json)) {
      if (!values["dry-run"]) throw new CommandFailure("refused", "USAGE_INVALID", "scripted reconciliation needs --yes after reviewing which observations it records", { target });
      writeResult(presentationOf(values), { command: "team remove", target, result: preview, completeness: "partial", partial: { message: "Card revisions were read from the intent's registry stream. Nothing was recorded, deleted or retried." } }, reconcileView);
      return;
    }
    if (!values.yes) {
      const answer = await prompts.confirm({ message: `Record ${preview.recordable} observed card outcome(s) for this unsettled removal? No card is deleted or retried.`, initialValue: false });
      if (prompts.isCancel(answer) || !answer) { writeResult(presentationOf(values), { command: "team remove", target, result: { kind: "channel-team-removal-reconcile", recorded: 0 }, noOp: true }, () => ({ sections: [{ title: "Nothing recorded", blocks: [{ kind: "lines", lines: ["The unsettled intent is unchanged."] }] }] })); return; }
    }
    let lock: ReturnType<typeof acquireMaintenanceLock>;
    try { lock = acquireMaintenanceLock(root); } catch { throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the root maintenance lock could not be acquired; nothing was reconciled", { target }); }
    try { run = await phase.execute(); }
    finally { try { releaseMaintenanceLock(lock); } catch { lockFailure = new CommandFailure("unknown", "OPERATION_UNKNOWN", "the root maintenance lock release did not confirm; recorded observations stand", { target }); } }
  } finally { await phase.close(); }
  const done = run!, open = done.settlements.filter((row) => row.state !== "settled");
  const failure = done.failure ?? lockFailure ?? (done.returned ? undefined : new CommandFailure(done.recorded.length ? "partial" : "refused", done.recorded.length ? "OPERATION_PARTIAL" : "LIFECYCLE_BLOCKED", "the removal stays unsettled: some original cards are unknown, unattempted or not owned; nothing was deleted or retried", { target: { ...target, openCards: open.map((row) => ({ name: row.name, state: row.state })) } }));
  writeResult(presentationOf(values), { command: "team remove", target, result: { kind: "channel-team-removal-reconcile", deploymentId, returnedReceipt: done.returned, recorded: done.recorded.map((row) => row.name), cards: done.settlements, effectAttempted: false, retryAuthorized: false }, warnings: phase.closeUnconfirmed() ? [{ code: "READER_CLOSE_UNCONFIRMED", target, message: "Closing the registry reader was not confirmed; recorded observations stand." }] : [], ...(failure ? { failure } : {}) }, (data): Report => ({ sections: [{ title: data.returnedReceipt ? "Card removal settled" : "Card removal still unsettled", blocks: [
    { kind: "fields", rows: [["Deployment", deploymentId], ["Recorded now", String(data.recorded.length)], ["Full removal receipt", data.returnedReceipt ? "recorded" : "not recorded"]] },
    { kind: "table", columns: [{ key: "channel", label: "Channel" }, { key: "created", label: "Create revision" }, { key: "state", label: "Outcome" }], rows: cardSettlementRows(data.cards) },
    { kind: "lines", lines: [RECONCILE_NOTE] },
  ] }] }));
}

export const RECONCILE_NOTE = "Reconciliation records only what the original registry stream shows now. A removed card names no remover and does not prove the original delete executed. Nothing was deleted, stopped or retried, and never-submitted members stay unattempted. An unsettled intent stays blocking.";

function reconcileView(data: { deploymentId: string; cards: CardSettlement[]; recordable: number; unattempted: number; unknown: number }): Report {
  return { sections: [{ title: "Unsettled card removal", blocks: [
    { kind: "fields", rows: [["Deployment", data.deploymentId], ["Would record", String(data.recordable)], ["Unknown", String(data.unknown)], ["Never submitted", String(data.unattempted)]] },
    { kind: "table", columns: [{ key: "channel", label: "Channel" }, { key: "created", label: "Create revision" }, { key: "state", label: "Observation" }], rows: cardSettlementRows(data.cards) },
    { kind: "lines", lines: [RECONCILE_NOTE] },
  ] }] };
}

/** Remove only the cards of a returned channel-only deployment. */
export async function removeChannelTeam(deploymentId: string, values: TeamValues): Promise<void> {
  const catalog = personaCatalog(values), root = canonicalRoot(catalog.root), space = catalog.space;
  const target = { root, space, deploymentId };
  let inventory: ReturnType<typeof listAdditiveTeamAttempts>;
  try { inventory = listAdditiveTeamAttempts(root); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the additive and removal records could not be read; no card was deleted", { target }); }
  if (inventory.refused.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "unreadable deployment or removal records remain; no card target was inferred", { target, remedy: "inspect team show <deployment-id> and the listed records before any removal" });
  const original = inventory.valid.find((row) => row.deploymentId === deploymentId);
  const receipt = inventory.returned.find((row) => row.deploymentId === deploymentId);
  if (!original || !receipt || receipt.kind !== "additive-channel-receipt" || original.requestedAgents.length || !receipt.createdChannels.length || receipt.createdChannels.length > 100) throw new CommandFailure("refused", "UNSUPPORTED", "guarded card removal needs one full returned channel-only receipt with at most 100 cards; mixed, agent, legacy and unsettled deployments were not routed here", { target });
  if (original.space !== space || canonicalRoot(original.root) !== root) throw new CommandFailure("refused", "CONFLICT", "the deployment belongs to another selected root or space; it was not rebound", { target });
  const prior = inventory.channelRemoval?.returned.find((row) => row.deploymentId === deploymentId);
  if (prior) {
    writeResult(presentationOf(values), { command: "team remove", target, result: { kind: "channel-team-removal", recordedState: "removal-returned", noOp: true, removal: prior, currentCardState: "not-rechecked" }, noOp: true }, (data): Report => ({ sections: [{ title: "Channel card removal already recorded", blocks: [{ kind: "fields", rows: [["Deployment", deploymentId], ["Removed cards", String(data.removal.removedChannels.length)], ["Current registry", "not rechecked"]] }, { kind: "lines", lines: ["The original cards have a complete historical removal receipt. No delete was repeated and no later card of the same name was selected."] }] }] }));
    return;
  }
  const unsettled = inventory.channelRemoval?.attempts.find((row) => row.deploymentId === deploymentId);
  if (unsettled) return reconcileChannelTeam({ root, space, deploymentId, original, receipt, intent: unsettled, values });
  const phase = await prepareCardRemoval({ root, space, deploymentId, original, receipt, apply: values["dry-run"] !== true });
  let run: CardRemovalRun | undefined, lockFailure: CommandFailure | undefined;
  try {
    const preview = phase.preview;
    if (values["dry-run"]) { writeResult(presentationOf(values), { command: "team remove", target, result: preview, completeness: "partial", partial: { message: "Current card revisions were compared with the returned create revisions. The membership feed is display-only. Nothing was deleted." } }, previewView); return; }
    if (!values.yes) {
      if (!canPrompt() || values.json) throw new CommandFailure("refused", "USAGE_INVALID", "scripted card removal needs --yes after reviewing its policy fallback and impact", { target });
      const answer = await prompts.confirm({ message: `Remove ${receipt.createdChannels.length} recorded channel card(s) from ${oneLine(space)}? The space defaults then apply (delivery ${preview.defaults.deliveryClass}). History, grants and readers are not changed.`, initialValue: false });
      if (prompts.isCancel(answer) || !answer) { writeResult(presentationOf(values), { command: "team remove", target, result: { kind: "channel-team-removal", removed: false }, noOp: true }, () => ({ sections: [{ title: "Channel cards kept", blocks: [{ kind: "lines", lines: ["No removal intent or card delete was submitted."] }] }] })); return; }
    }
    let lock: ReturnType<typeof acquireMaintenanceLock>;
    try { lock = acquireMaintenanceLock(root); } catch { throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the root maintenance lock could not be acquired; no removal intent or delete was submitted", { target }); }
    try { run = await phase.execute(); }
    finally { try { releaseMaintenanceLock(lock); } catch { lockFailure = new CommandFailure(run?.returned ? "partial" : "unknown", run?.returned ? "OPERATION_PARTIAL" : "OPERATION_UNKNOWN", "the root maintenance lock release did not confirm; no native effect was repeated", { target }); } }
  } finally { await phase.close(); }
  if (!run!.intentAttempted && run!.failure) throw run!.failure;
  const done = run!, failure = done.failure ?? lockFailure;
  writeResult(presentationOf(values), { command: "team remove", target, result: { kind: "channel-team-removal", deploymentId, server: brokerAddressForDisplay(original.server) ?? "not displayable", authMode: original.authMode, returnedReceipt: done.returned, channels: done.outcomes, impact: phase.preview, retainedIntent: done.intentAttempted, historyPurged: false, grantsChanged: false, readersStopped: false, readerExclusivity: "not-established", completeCleanup: false, retryAuthorized: false }, warnings: phase.closeUnconfirmed() ? [{ code: "WRITER_CLOSE_UNCONFIRMED", target, message: "Closing the scoped registry writer was not confirmed; recorded outcomes stand." }] : [], ...(failure ? { failure } : {}) }, (data): Report => ({ sections: [{ title: data.returnedReceipt ? "Channel cards removed" : "Channel card removal incomplete", blocks: [
    { kind: "fields", rows: [["Deployment", deploymentId], ["Auth mode", data.authMode], ["Removed or already absent", `${data.channels.filter((row) => row.outcome === "deleted" || row.outcome === "absent").length} of ${receipt.createdChannels.length}`], ["Full removal receipt", data.returnedReceipt ? "recorded" : "not confirmed"], ["Retained history", "kept"], ["Grants and readers", "unchanged"]] },
    { kind: "table", columns: [{ key: "channel", label: "Channel" }, { key: "created", label: "Create revision" }, { key: "outcome", label: "Outcome" }], rows: cardOutcomeRows(receipt, data.channels) },
    { kind: "lines", lines: [CARD_SCOPE_NOTE] },
  ] }] }));
}

export const CARD_SCOPE_NOTE = "Only the registry cards were removed. The channel stays addressable, its retained history and every read/post grant are unchanged, and current readers were not stopped or proven absent. The space defaults now apply to these names. An unsettled intent stays blocking and is not retry authority.";

function impactOf(original: AdditiveTeamAttempt, receipt: CardReceipt, cards: CardObservation[], defaults: ChannelDefaults | null, members: Awaited<ReturnType<typeof readChannelMemberImpact>>) {
  return {
    kind: "channel-team-removal-preview" as const, deploymentId: original.deploymentId, space: original.space, root: original.root,
    server: brokerAddressForDisplay(original.server) ?? "not displayable", authMode: original.authMode, tlsRequired: original.tlsRequired,
    defaults: { deliveryClass: defaults?.deliveryClass ?? "durable", replay: defaults?.replay ?? true, replayWindow: defaults?.replayWindow ?? null },
    channels: receipt.createdChannels.map((row, index) => ({ name: row.name, createdRevision: row.revision, observedRevision: cards[index]!.revision, state: cards[index]!.state, fallback: fallback(cards[index]!.config, defaults), observedMembers: members?.channels[index]?.observedMembers ?? null })),
    membershipFeed: members ? (members.asOf === null ? "no-heartbeat" as const : "display-only-observed" as const) : "unavailable" as const, membershipObservedAt: members?.asOf ?? null,
    scope: "registry-card-metadata-only" as const, historyPurged: false, grantsChanged: false, readersStopped: false, readerExclusivity: "not-established" as const, effectAttempted: false as const,
  };
}
export type CardImpact = ReturnType<typeof impactOf>;

/** The card table and disclosure lines, shared by the channel-only and mixed previews. */
export function cardImpactBlocks(data: CardImpact): Report["sections"][number]["blocks"] {
  return [
    { kind: "fields", rows: [["Scope", "registry cards only"], ["Space default delivery", data.defaults.deliveryClass], ["Space default replay", data.defaults.replay ? "on" : "off"], ["Membership feed", `${data.membershipFeed.replaceAll("-", " ")}; never authority`]] },
    { kind: "table", columns: [{ key: "channel", label: "Channel" }, { key: "state", label: "Card" }, { key: "delivery", label: "Delivery after" }, { key: "replay", label: "Replay after" }, { key: "members", label: "Observed members" }], rows: data.channels.map((row) => ({ channel: `#${row.name}`, state: row.state === "same-revision" ? `unchanged at ${row.createdRevision}` : row.state === "absent" ? "already absent" : `changed (${row.observedRevision})`, delivery: `${row.fallback.deliveryClass.card ?? "default"} -> ${row.fallback.deliveryClass.after}`, replay: `${row.fallback.replay.card === null ? "default" : row.fallback.replay.card ? "on" : "off"} -> ${row.fallback.replay.after ? "on" : "off"}`, members: row.observedMembers === null ? "unknown" : String(row.observedMembers.length) })) },
    { kind: "lines", lines: ["Apply deletes each card only if it is still at its returned create revision. Descriptions and instructions leave agent context, and later joins use the space defaults, so a live card can become durable. Retained history, read/post grants and current readers are unchanged; the feed is a display-only lower bound. Nothing was deleted."] },
  ];
}

function previewView(data: CardImpact): Report {
  return { sections: [
    { title: "Channel card removal impact", blocks: [{ kind: "fields", rows: [["Deployment", data.deploymentId], ["Space", data.space], ["Broker", data.server], ["Auth mode", data.authMode]] }, ...cardImpactBlocks(data)] },
  ] };
}
