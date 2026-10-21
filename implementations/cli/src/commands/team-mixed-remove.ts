import * as prompts from "@clack/prompts";
import { acquireMaintenanceLock, brokerAddressForDisplay, canonicalRoot, CommandFailure, oneLine, presentationOf, releaseMaintenanceLock, writeResult, type Report } from "@cotal-ai/workspace";
import { personaCatalog } from "../lib/persona-files.js";
import { listAdditiveTeamAttempts, type AdditiveAgentReceipt } from "../lib/team-additive-attempt.js";
import { agentOutcomeRows, agentSettlementRows, AGENT_RECONCILE_NOTE, prepareAgentReconcile, prepareAgentRetirement, withInterruptGuard, type AgentReconcileRun, type AgentRetirementRun } from "./team-agent-remove.js";
import { CARD_SCOPE_NOTE, cardImpactBlocks, cardOutcomeRows, cardSettlementRows, prepareCardReconcile, prepareCardRemoval, RECONCILE_NOTE, type CardReconcileRun, type CardRemovalRun } from "./team-channel-remove.js";
import { canPrompt } from "./meshes-wizard.js";
import type { TeamValues } from "./team.js";

type MixedReceipt = AdditiveAgentReceipt & { kind: "additive-team-receipt" };

/** Remove a returned static-auth mixed deployment in one guarded operation: retire every original
 * agent incarnation natively, then delete each original unchanged card by revision CAS. Each phase
 * keeps its own journal, and the card journal is valid only after a complete retirement receipt.
 * Any unknown or partial outcome stops immediately; later members stay unattempted and nothing is
 * replayed. The deployment is released only when both validated receipts exist. */
export async function removeMixedTeam(deploymentId: string, values: TeamValues): Promise<void> {
  const catalog = personaCatalog(values), root = canonicalRoot(catalog.root), space = catalog.space;
  const target = { root, space, deploymentId };
  let inventory: ReturnType<typeof listAdditiveTeamAttempts>;
  try { inventory = listAdditiveTeamAttempts(root); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the additive and removal records could not be read; no stop or delete was submitted", { target }); }
  if (inventory.refused.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "unreadable deployment or removal records remain; no removal target was inferred", { target, remedy: "inspect team show <deployment-id> and the listed records before any removal" });
  const original = inventory.valid.find((row) => row.deploymentId === deploymentId);
  const found = inventory.returned.find((row) => row.deploymentId === deploymentId);
  if (!original || !found || found.kind !== "additive-team-receipt" || found.authMode !== "auth" || original.authMode !== "auth" || !original.managerInstanceId || !found.createdChannels.length || found.createdChannels.length > 100 || found.createdAgents.length > 100 || found.createdChannels.length !== original.declaredChannels.length)
    throw new CommandFailure("refused", "UNSUPPORTED", "guarded mixed removal needs a full static-auth returned team receipt with its recorded manager and 1 to 100 cards; open, user-auth, legacy and unsettled deployments were not routed here", { target });
  if (original.space !== space || canonicalRoot(original.root) !== root) throw new CommandFailure("refused", "CONFLICT", "the deployment belongs to another selected root or space; it was not rebound", { target });
  const receipt = found as MixedReceipt;
  const agentsDone = inventory.removal?.returned.find((row) => row.deploymentId === deploymentId);
  const cardsDone = inventory.channelRemoval?.returned.find((row) => row.deploymentId === deploymentId);
  if (agentsDone && cardsDone) {
    writeResult(presentationOf(values), { command: "team remove", target, result: { kind: "mixed-team-removal", recordedState: "removal-returned", noOp: true, retirement: agentsDone, cards: cardsDone, currentState: "not-rechecked" }, noOp: true }, (): Report => ({ sections: [{ title: "Mixed team removal already recorded", blocks: [{ kind: "fields", rows: [["Deployment", deploymentId], ["Retired incarnations", String(agentsDone.retiredAgents.length)], ["Removed cards", String(cardsDone.removedChannels.length)], ["Current state", "not rechecked"]] }, { kind: "lines", lines: ["Both original receipts are recorded. No stop or delete was repeated."] }] }] }));
    return;
  }
  const agentIntent = inventory.removal?.attempts.find((row) => row.deploymentId === deploymentId);
  const cardIntent = inventory.channelRemoval?.attempts.find((row) => row.deploymentId === deploymentId);
  if (agentIntent && !agentsDone || cardIntent) return reconcileMixedTeam({ root, space, deploymentId, original, receipt, agentIntent: agentsDone ? undefined : agentIntent, cardIntent, values });
  // Only a fully returned retirement with no card intent may continue straight to the card phase.
  const resume = agentsDone !== undefined;
  const agents = resume ? undefined : await prepareAgentRetirement({ root, space, deploymentId, original, receipt });
  // The preview reads cards without a writer. The one-shot writer is issued only after retirement,
  // by a fresh card preparation that repeats every check, so a slow retirement cannot outlive it.
  const previewCards = await prepareCardRemoval({ root, space, deploymentId, original, receipt, apply: false });
  await previewCards.close();
  let lockFailure: CommandFailure | undefined, closeUnconfirmed = previewCards.closeUnconfirmed();
  const preview = { kind: "mixed-team-removal-preview" as const, deploymentId, managerInstanceId: original.managerInstanceId, server: brokerAddressForDisplay(original.server) ?? "not displayable", remainingPhases: resume ? ["card-removal"] : ["agent-retirement", "card-removal"], agents: agents?.agents ?? null, cards: previewCards.preview, readConsistency: "ordered-not-atomic" as const, dryRun: values["dry-run"] === true, effectAttempted: false };
  const previewReport = (data: typeof preview): Report => ({ sections: [
    { title: "Mixed team removal impact", blocks: [{ kind: "fields", rows: [["Deployment", data.deploymentId], ["Manager", data.managerInstanceId ?? "not recorded"], ["Broker", data.server], ["Remaining phases", data.remainingPhases.join(", then ")], ["Read consistency", "ordered, not atomic"]] },
      ...(data.agents ? [{ kind: "table" as const, columns: [{ key: "name", label: "Agent" }, { key: "id", label: "Identity" }, { key: "uid", label: "Lifecycle" }, { key: "state", label: "Native observation" }], rows: data.agents.map((row) => ({ name: row.name, id: row.id, uid: row.lifecycleUid, state: row.observedState })) }] : [{ kind: "lines" as const, lines: ["All original incarnations already have a complete native retirement receipt; only the card phase remains."] }]),
      { kind: "lines", lines: ["Apply retires each original incarnation once and waits for native retirement and cleanup, then deletes the cards. Cards are not touched unless every retirement is confirmed. Any unknown or partial step stops the operation without replay."] }] },
    { title: "Channel cards", blocks: cardImpactBlocks(data.cards) },
  ] });
  if (values["dry-run"]) { writeResult(presentationOf(values), { command: "team remove", target, result: preview, completeness: "partial", partial: { message: "Native slots and card revisions were read in order, not atomically. The membership feed is display-only. Nothing was stopped or deleted." } }, previewReport); return; }
  if (!values.yes) {
    if (!canPrompt() || values.json) throw new CommandFailure("refused", "USAGE_INVALID", "scripted mixed team removal needs --yes after reviewing its retirements, policy fallback and impact", { target });
    const cardsText = `${receipt.createdChannels.length} recorded channel card(s) from ${oneLine(space)}`;
    const answer = await prompts.confirm({ message: `${resume ? `Remove ${cardsText}` : `Retire ${receipt.createdAgents.length} recorded agent incarnation(s), then remove ${cardsText}`}? The space defaults then apply to those channels (delivery ${previewCards.preview.defaults.deliveryClass}). History, grants and other readers are not changed.`, initialValue: false });
    if (prompts.isCancel(answer) || !answer) { writeResult(presentationOf(values), { command: "team remove", target, result: { kind: "mixed-team-removal", removed: false }, noOp: true }, () => ({ sections: [{ title: "Team kept", blocks: [{ kind: "lines", lines: ["No removal intent, stop or delete was submitted."] }] }] })); return; }
  }
  let lock: ReturnType<typeof acquireMaintenanceLock>;
  try { lock = acquireMaintenanceLock(root); } catch { throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the root maintenance lock could not be acquired; no removal intent, stop or delete was submitted", { target }); }
  type Phases = { agentRun?: AgentRetirementRun; cardRun?: CardRemovalRun; cardRefusal?: CommandFailure; writerCloseUnconfirmed?: boolean };
  let guarded: { value: Phases; signal: "SIGINT" | "SIGTERM" | undefined };
  try {
    guarded = await withInterruptGuard(async (abort): Promise<Phases> => {
      let agentRun: AgentRetirementRun | undefined;
      if (agents) {
        agentRun = await agents.execute(abort);
        if (!agentRun.returned || abort.aborted) return { agentRun };
      }
      let cards: Awaited<ReturnType<typeof prepareCardRemoval>>;
      try { cards = await prepareCardRemoval({ root, space, deploymentId, original, receipt, apply: true }); }
      catch (error) { return { ...(agentRun ? { agentRun } : {}), cardRefusal: error instanceof CommandFailure ? error : new CommandFailure("refused", "TARGET_UNAVAILABLE", "the card phase could not establish an unchanged target; no card was deleted", { target }) }; }
      let cardRun: CardRemovalRun | undefined;
      try { cardRun = await cards.execute(); }
      finally { await cards.close(); }
      return { ...(agentRun ? { agentRun } : {}), cardRun, writerCloseUnconfirmed: cards.closeUnconfirmed() };
    });
  } finally {
    try { releaseMaintenanceLock(lock); } catch { lockFailure = new CommandFailure("unknown", "OPERATION_UNKNOWN", "the root maintenance lock release did not confirm; no native effect was repeated", { target }); }
  }
  const { agentRun, cardRun, cardRefusal } = guarded!.value, signal = guarded!.signal;
  if (guarded!.value.writerCloseUnconfirmed) closeUnconfirmed = true;
  const agentsReturned = resume || agentRun?.returned === true, cardsReturned = cardRun?.returned === true;
  const intentAttempted = agentRun?.intentAttempted === true || cardRun?.intentAttempted === true;
  const phaseFailure = agentRun?.failure ?? cardRun?.failure ?? cardRefusal;
  if (!intentAttempted && !resume && phaseFailure) throw phaseFailure;
  const remainingPhase = !agentsReturned ? "agent-retirement" : !cardsReturned ? "card-removal" : null;
  const failure = phaseFailure ? (agentsReturned && phaseFailure.outcome === "refused" ? new CommandFailure("partial", "OPERATION_PARTIAL", "every original incarnation was retired, but the card phase stopped before every card settled; nothing was retried", { target: { ...target, remainingPhase }, native: { code: phaseFailure.code, outcome: phaseFailure.outcome }, changed: [...(phaseFailure.changed ?? [])] }) : phaseFailure)
    : remainingPhase ? new CommandFailure("partial", "OPERATION_PARTIAL", "the removal stopped before its card phase; no card was deleted and the retirement receipt stands", { target: { ...target, remainingPhase } }) : lockFailure;
  writeResult(presentationOf(values), { command: "team remove", target, result: { kind: "mixed-team-removal", deploymentId, managerInstanceId: original.managerInstanceId, retirementReturned: agentsReturned, cardRemovalReturned: cardsReturned, remainingPhase, retiredAgents: agentRun?.retired ?? null, stopRequests: agentRun?.stops ?? [], channels: cardRun?.outcomes ?? [], impact: previewCards.preview, historyPurged: false, grantsChanged: false, readerExclusivity: "not-established", completeCleanup: false, retryAuthorized: false }, warnings: closeUnconfirmed ? [{ code: "WRITER_CLOSE_UNCONFIRMED", target, message: "Closing the scoped registry writer was not confirmed; recorded outcomes stand." }] : [], ...(failure ? { failure } : {}) }, (data): Report => ({ sections: [
    { title: data.remainingPhase ? "Mixed team removal incomplete" : "Mixed team removed", blocks: [
      { kind: "fields", rows: [["Deployment", deploymentId], ["Manager", data.managerInstanceId ?? "not recorded"], ["Agent retirement", data.retirementReturned ? "receipt recorded" : "not confirmed"], ["Card removal", data.cardRemovalReturned ? "receipt recorded" : "not confirmed"], ["Remaining phase", data.remainingPhase ?? "none"], ["Retained history", "kept"], ["Grants", "unchanged"]] },
      ...(agentRun ? [{ kind: "table" as const, columns: [{ key: "name", label: "Agent" }, { key: "uid", label: "Original lifecycle" }, { key: "state", label: "Observed outcome" }], rows: agentOutcomeRows(receipt, agentRun) }] : []),
      { kind: "table", columns: [{ key: "channel", label: "Channel" }, { key: "created", label: "Create revision" }, { key: "outcome", label: "Outcome" }], rows: cardOutcomeRows(receipt, data.channels) },
      { kind: "lines", lines: ["Original incarnations were retired only by their recorded identity and lifecycle; no successor was targeted. " + CARD_SCOPE_NOTE + " The deployment is released only once both receipts exist."] },
    ] },
  ] }));
  if (signal) process.exitCode = signal === "SIGINT" ? 130 : 143;
}

/** Reconcile an unsettled mixed removal from native observation only. The retirement phase settles
 * first; the card phase is observed only once a complete original retirement receipt reads back,
 * so a card settlement can never precede or replace retirement. Nothing is stopped, deleted,
 * retried or continued. A phase that does not settle keeps the deployment blocking. */
async function reconcileMixedTeam(input: { root: string; space: string; deploymentId: string; original: Parameters<typeof prepareAgentReconcile>[0]["original"]; receipt: MixedReceipt; agentIntent: Parameters<typeof prepareAgentReconcile>[0]["intent"] | undefined; cardIntent: Parameters<typeof prepareCardReconcile>[0]["intent"] | undefined; values: TeamValues }): Promise<void> {
  const { root, space, deploymentId, original, receipt, agentIntent, cardIntent, values } = input, target = { root, space, deploymentId };
  if (cardIntent && !listAdditiveTeamAttempts(root).removal?.returned.some((row) => row.deploymentId === deploymentId)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a card removal intent exists without a complete retirement receipt; it was not reconciled", { target: { ...target, remainingPhase: "agent-retirement" } });
  const agents = agentIntent ? await prepareAgentReconcile({ root, space, deploymentId, original, receipt, intent: agentIntent }) : undefined;
  let cards = cardIntent ? await prepareCardReconcile({ root, space, deploymentId, original, receipt, intent: cardIntent }) : undefined;
  try {
    const preview = { kind: "mixed-team-removal-reconcile-preview" as const, deploymentId, managerInstanceId: original.managerInstanceId, agents: agents?.settlements ?? null, cards: cards?.settlements ?? null, remainingPhase: agentIntent ? "agent-retirement" as const : "card-removal" as const, effectAttempted: false as const, continuationOffered: false as const };
    const view = (data: typeof preview): Report => ({ sections: [
      { title: "Unsettled mixed team removal", blocks: [{ kind: "fields", rows: [["Deployment", deploymentId], ["Manager", data.managerInstanceId ?? "not recorded"], ["Phase to reconcile", data.remainingPhase]] }] },
      ...(data.agents ? [{ title: "Original incarnations", blocks: [{ kind: "table" as const, columns: [{ key: "name", label: "Agent" }, { key: "uid", label: "Original lifecycle" }, { key: "state", label: "Observation" }], rows: agentSettlementRows(data.agents) }, { kind: "lines" as const, lines: [AGENT_RECONCILE_NOTE] }] }] : []),
      ...(data.cards ? [{ title: "Channel cards", blocks: [{ kind: "table" as const, columns: [{ key: "channel", label: "Channel" }, { key: "created", label: "Create revision" }, { key: "state", label: "Observation" }], rows: cardSettlementRows(data.cards) }, { kind: "lines" as const, lines: [RECONCILE_NOTE] }] }] : [{ title: "Channel cards", blocks: [{ kind: "lines" as const, lines: ["Cards are observed only after a complete retirement receipt; none was read."] }] }]),
    ] });
    if (values["dry-run"]) { writeResult(presentationOf(values), { command: "team remove", target, result: preview, completeness: "partial", partial: { message: "Native slots and card revisions were read in order, not atomically. Nothing was recorded, stopped or deleted." } }, view); return; }
    if (!values.yes) {
      if (!canPrompt() || values.json) throw new CommandFailure("refused", "USAGE_INVALID", "scripted reconciliation needs --yes after reviewing which observations it records", { target });
      const answer = await prompts.confirm({ message: "Record the observed outcomes for this unsettled mixed removal? Nothing is stopped, deleted or retried.", initialValue: false });
      if (prompts.isCancel(answer) || !answer) { writeResult(presentationOf(values), { command: "team remove", target, result: { kind: "mixed-team-removal-reconcile", recorded: false }, noOp: true }, () => ({ sections: [{ title: "Nothing recorded", blocks: [{ kind: "lines", lines: ["The unsettled intents are unchanged."] }] }] })); return; }
    }
    let lock: ReturnType<typeof acquireMaintenanceLock>;
    try { lock = acquireMaintenanceLock(root); } catch { throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the root maintenance lock could not be acquired; nothing was reconciled", { target }); }
    let agentRun: AgentReconcileRun | undefined, cardRun: CardReconcileRun | undefined, lockFailure: CommandFailure | undefined;
    try {
      if (agents) agentRun = await agents.execute();
      // A card intent that already existed is reconciled only after a complete retirement receipt;
      // a retirement that settles now does not start a card phase, which stays unattempted.
      if (cards && (!agents || agentRun?.returned)) cardRun = await cards.execute();
    } finally { try { releaseMaintenanceLock(lock); } catch { lockFailure = new CommandFailure("unknown", "OPERATION_UNKNOWN", "the root maintenance lock release did not confirm; recorded observations stand", { target }); } }
    const readerCloseUnconfirmed = cards ? (await cards.close(), cards.closeUnconfirmed()) : false;
    cards = undefined;
    const now = listAdditiveTeamAttempts(root);
    const retirementReturned = now.removal?.returned.some((row) => row.deploymentId === deploymentId) === true;
    const cardsReturned = now.channelRemoval?.returned.some((row) => row.deploymentId === deploymentId) === true;
    const remainingPhase = !retirementReturned ? "agent-retirement" : !cardsReturned ? "card-removal" : null;
    const failure = agentRun?.failure ?? cardRun?.failure ?? lockFailure ?? (remainingPhase ? new CommandFailure((agentRun?.recorded.length ?? 0) + (cardRun?.recorded.length ?? 0) ? "partial" : "refused", (agentRun?.recorded.length ?? 0) + (cardRun?.recorded.length ?? 0) ? "OPERATION_PARTIAL" : "LIFECYCLE_BLOCKED", "the mixed removal stays unsettled; nothing was stopped, deleted or retried", { target: { ...target, remainingPhase } }) : undefined);
    writeResult(presentationOf(values), { command: "team remove", target, result: { kind: "mixed-team-removal-reconcile", deploymentId, retirementReturned, cardRemovalReturned: cardsReturned, remainingPhase, agents: agentRun?.settlements ?? null, cards: cardRun?.settlements ?? null, effectAttempted: false, retryAuthorized: false }, warnings: readerCloseUnconfirmed ? [{ code: "READER_CLOSE_UNCONFIRMED", target, message: "Closing the registry reader was not confirmed; recorded observations stand." }] : [], ...(failure ? { failure } : {}) }, (data): Report => ({ sections: [
      { title: data.remainingPhase ? "Mixed team removal still unsettled" : "Mixed team removal settled", blocks: [{ kind: "fields", rows: [["Deployment", deploymentId], ["Agent retirement", data.retirementReturned ? "receipt recorded" : "not settled"], ["Card removal", data.cardRemovalReturned ? "receipt recorded" : "not settled"], ["Remaining phase", data.remainingPhase ?? "none"]] }] },
      ...(data.agents ? [{ title: "Original incarnations", blocks: [{ kind: "table" as const, columns: [{ key: "name", label: "Agent" }, { key: "uid", label: "Original lifecycle" }, { key: "state", label: "Outcome" }], rows: agentSettlementRows(data.agents) }] }] : []),
      ...(data.cards ? [{ title: "Channel cards", blocks: [{ kind: "table" as const, columns: [{ key: "channel", label: "Channel" }, { key: "created", label: "Create revision" }, { key: "state", label: "Outcome" }], rows: cardSettlementRows(data.cards) }] }] : []),
      { title: "Scope", blocks: [{ kind: "lines", lines: [AGENT_RECONCILE_NOTE, RECONCILE_NOTE] }] },
    ] }));
  } finally { if (cards) await cards.close(); }
}
