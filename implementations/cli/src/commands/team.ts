import { basename, join, resolve } from "node:path";
import { CotalEndpoint, DEFAULT_SERVER, isReachable, realDirNoSymlink, subjectMatches, type CompletionResult, type FlagSpec, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
import { assertSingleSpaceBroker, recordOperationSpace, authDir, CommandFailure, credentialRefusalMessage, brokerAddressForDisplay, canonicalRoot, connectOrThrow, findMesh, findPreparedSpace, jsonFlag, loadMeshes, localMeshesForRoot, plainFlag, presentationOf, readMaintenanceJournal, spaceFlag, userViewAuth, writeResult, type Report } from "@cotal-ai/workspace";
import { personaCatalog } from "../lib/persona-files.js";
import { loadManifest, type PreparedManifest } from "../lib/manifest/index.js";
import { findLedgerByRun, listLedgerFiles, type MeshLedger } from "../lib/manifest/ledger.js";
import { findFreshTeamAttempt, findFreshTeamSummary, freshTeamAttemptSettled, listFreshTeamAttempts, listFreshTeamSummaries, type FreshTeamSummary } from "../lib/team-fresh.js";
import { additiveTeamRecordedState, findAdditiveTeamAttempt, listAdditiveTeamAttempts, removedAdditiveDeploymentIds } from "../lib/team-additive-attempt.js";
import { completedFlagValue, completingFlagValue, positionalsForCompletion } from "../lib/completion.js";
import { inspectTeamDeployment, readOwnedChannelRevisions } from "../lib/team-deploy-inspection.js";
import { managerRecordState } from "../lib/manager-proc.js";
import { readLocalServiceCensus } from "../lib/service-census.js";
import { liveMeshProcesses } from "./clean.js";
import { preparedUpRoot, recordedBrokerTransport } from "./up.js";
import { controllerTeamBoot } from "./team-boot-controller.js";
import { applyChannelOnlyTeam } from "./team-deploy-apply.js";

export const teamFlags = [spaceFlag, jsonFlag, plainFlag,
  { name: "graph", type: "boolean", description: "check: show effective channel and capability access from merged manifest/persona policy" },
  { name: "dry-run", type: "boolean", description: "boot: preview declaration; deploy/remove: read native diagnostics without effects" },
  { name: "runtime", type: "string", value: "<name>", description: "deploy: require the selected manager's native runtime; channel-only apply refuses it" },
  { name: "allow-stale", type: "string", value: "<names>", description: "retained agents: keep named stale agents on their old policy without restarting; new/channel-only apply refuses it" },
  { name: "foreground", type: "boolean", description: "boot: hold the booted stack's lifetime in this terminal; Ctrl-C runs the guarded whole-stack stop" },
  { name: "yes", short: "y", type: "boolean", description: "remove: confirm recorded static agent retirement and unchanged channel-card removal, or record observed outcomes of an unsettled removal; not accepted with a preview" },
] as const satisfies readonly FlagSpec[];

export type TeamValues = FlagValues<typeof teamFlags>;

/** Completion reads the local space selection and its ledger directory, never the broker.
 *  An unreadable record cannot become a suggested target or trigger a provider. */
export function teamComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, teamFlags);
  if (flag?.name === "space") return { items: loadMeshes().map((mesh) => ({ value: mesh.space })), directive: "nofiles" };
  if (argv.at(-1)?.startsWith("-")) return { items: teamFlags.map((item) => ({ value: `--${item.name}`, description: item.description })), directive: "nofiles" };
  const positionals = positionalsForCompletion(argv, teamFlags);
  if (positionals.length <= 1) return { items: ["show", "check", "boot", "deploy", "remove"].map((value) => ({ value })), directive: "nofiles" };
  if (positionals.length !== 2) return { items: [], directive: "nofiles" };
  if (positionals[0] === "check" || positionals[0] === "boot" || positionals[0] === "deploy") return { items: [], directive: "default" };
  if (positionals[0] !== "show" && positionals[0] !== "remove") return { items: [], directive: "nofiles" };
  try {
    const { root, space } = personaCatalog({ space: completedFlagValue(argv, teamFlags, "space") });
    const additive = listLedgerFiles(root).valid.filter(({ ledger }) => ledger.space === space).map(({ ledger }) => ({ value: ledger.runId, description: "recorded additive deployment" }));
    const fresh = listFreshTeamSummaries(root).valid.filter((summary) => summary.space === space).map((summary) => ({ value: summary.deploymentId, description: "recorded fresh boot" }));
    const freshIds = new Set(fresh.map((row) => row.value));
    const intents = listFreshTeamAttempts(root).valid.filter((attempt) => attempt.space === space).map((attempt) => ({ value: attempt.deploymentId, description: "fresh boot attempt" }));
    const additiveInventory = listAdditiveTeamAttempts(root);
    const additiveIntents = additiveInventory.valid.filter((attempt) => attempt.space === space).map((attempt) => ({ value: attempt.deploymentId, description: additiveTeamRecordedState(attempt, additiveInventory).replaceAll("-", " ") }));
    for (const intent of intents) freshIds.add(intent.value);
    const additiveAttemptIds = new Set(additiveIntents.map((row) => row.value));
    if (positionals[0] === "remove") {
      const removed = removedAdditiveDeploymentIds(additiveInventory);
      const unsettledRemoval = (id: string) => additiveInventory.removal?.attempts.some((attempt) => attempt.deploymentId === id) && !additiveInventory.removal?.returned.some((row) => row.deploymentId === id)
        || additiveInventory.channelRemoval?.attempts.some((attempt) => attempt.deploymentId === id) && !additiveInventory.channelRemoval?.returned.some((row) => row.deploymentId === id);
      return { items: [...additive.filter((row) => !freshIds.has(row.value) && !additiveAttemptIds.has(row.value)), ...additiveIntents.filter((row) => additiveInventory.returned.some((receipt) => receipt.deploymentId === row.value && (receipt.kind === "additive-channel-receipt" || receipt.authMode === "auth")) && !removed.has(row.value) && !freshIds.has(row.value) && !additive.some((legacy) => legacy.value === row.value)).map((row) => ({ ...row, description: unsettledRemoval(row.value) ? "unsettled removal; observation-only reconcile" : additiveInventory.returned.some((receipt) => receipt.deploymentId === row.value && receipt.kind === "additive-channel-receipt") ? "channel-only card removal; revision recheck required" : additiveInventory.returned.some((receipt) => receipt.deploymentId === row.value && receipt.kind === "additive-team-receipt") ? "static mixed removal; native and revision recheck required" : "static agent-only removal; native recheck required" }))], directive: "nofiles" };
    }
    const additiveIds = new Set(additive.map((row) => row.value));
    return { items: [...fresh.filter((row) => !additiveIds.has(row.value) && !additiveAttemptIds.has(row.value)), ...intents.filter((row) => !additiveIds.has(row.value) && !additiveAttemptIds.has(row.value) && !fresh.some((summary) => summary.value === row.value)), ...additiveIntents.filter((row) => !freshIds.has(row.value) && !additiveIds.has(row.value)), ...additive.filter((row) => !freshIds.has(row.value) && !additiveAttemptIds.has(row.value))], directive: "nofiles" };
  } catch { return { items: [], directive: "nofiles" }; }
}

export function validateTeamArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  const [mode = "list", subject, ...extra] = args.positionals;
  if (!["list", "show", "check", "boot", "deploy", "remove"].includes(mode) || extra.length || (mode === "list" ? subject !== undefined : !subject?.trim()))
    throw new CommandFailure("refused", "USAGE_INVALID", "use team, team show <deployment-id>, team check <file> [--graph], team boot <file> [--dry-run], team deploy <file> [--dry-run], or team remove <deployment-id> [--dry-run] [--yes]");
  if (mode !== "check" && args.values.graph) throw new CommandFailure("refused", "USAGE_INVALID", "--graph belongs to team check");
  if (!["boot", "deploy", "remove"].includes(mode) && args.values["dry-run"] !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "--dry-run belongs to team boot, deploy or remove in this source");
  if (mode !== "deploy" && (args.values.runtime !== undefined || args.values["allow-stale"] !== undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "--runtime and --allow-stale belong to team deploy");
  if (mode === "deploy" && args.values.runtime !== undefined && !String(args.values.runtime).trim()) throw new CommandFailure("refused", "USAGE_INVALID", "--runtime needs a runtime name");
  if (mode === "deploy" && args.values["dry-run"] === true && args.values["allow-stale"] !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "--allow-stale is apply-only and cannot be validated by a declaration-only preview");
  if (mode !== "boot" && args.values.foreground !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "--foreground belongs to team boot");
  if (mode === "boot" && args.values["dry-run"] !== true && args.values.foreground === true && (args.values.json === true || args.values.plain === true)) throw new CommandFailure("refused", "USAGE_INVALID", "a foreground team boot keeps terminal custody and cannot produce a finite JSON or plain receipt");
  if ((mode !== "remove" && args.values.yes !== undefined) || (mode === "remove" && args.values["dry-run"] === true && args.values.yes === true)) throw new CommandFailure("refused", "USAGE_INVALID", "--yes belongs only to a real guarded team removal, not a read or dry-run");
  if (mode === "remove" && !/^[a-f0-9]{16}$/.test(subject!)) throw new CommandFailure("refused", "USAGE_INVALID", "team remove requires the complete recorded 16-character deployment ID, not a manifest path or prefix");
  if (mode === "show" && !/^[A-Za-z0-9_-]+$/.test(subject!)) throw new CommandFailure("refused", "USAGE_INVALID", "use the full recorded deployment ID, not a manifest path");
}

function recorded(root: string, ledger: MeshLedger) {
  return { deploymentId: ledger.runId, kind: "additive" as const, space: ledger.space, root,
    recordedState: "ownership-ledger-present", liveState: "not-checked", manifestPath: ledger.manifestPath,
    channels: ledger.created.channels, agents: ledger.created.agents.map((agent) => ({ requested: agent.requested, name: agent.name, id: agent.id, lifecycleUid: agent.lifecycleUid ?? null })),
    removalScope: "only ledger-owned resources after native ownership and live-incarnation checks",
    nextAction: "review-scoped-native-teardown" as const };
}

/** One card removal step as `team show` names it. A reconciled observation never claims that the
 * original delete executed. */
function cardStepText(phase: string): string {
  return phase === "deleted" ? "deleted at created revision" : phase === "absent" ? "already absent; remover unknown" : phase === "conflict" ? "card moved; not deleted"
    : phase === "observed-removed" ? "removed after an unconfirmed delete; remover unknown" : phase === "observed-superseded" ? "replaced after an unconfirmed delete; not owned" : "delete submitted; outcome not implied";
}

function freshRecorded(summary: FreshTeamSummary) {
  const responderMismatch = summary.deliveryResponderBound !== undefined && (summary.authMode === "open" ? summary.deliveryResponderBound !== null
    : summary.authMode === "auth" || summary.authMode === "user" ? summary.deliveryResponderBound !== true : false);
  return { deploymentId: summary.deploymentId, kind: "fresh" as const, space: summary.space, root: summary.root,
    recordedState: !summary.controlPlaneReturned || !summary.authServiceReturned || responderMismatch ? "broker-boot-degraded" : summary.authMode === undefined || summary.deliveryResponderBound === undefined ? "broker-boot-unverified" : "broker-boot-returned",
    liveState: "not-checked", authMode: summary.authMode ?? null, brokerPid: summary.brokerPid ?? null, deliveryResponder: summary.deliveryResponderBound === undefined ? "not-recorded" : summary.deliveryResponderBound === null ? "not-required-open" : summary.deliveryResponderBound ? "bound-at-return" : "not-bound-at-return", manifestPath: summary.manifestPath, recordedAt: summary.recordedAt,
    channels: summary.declaredChannels, agents: summary.requestedAgents.map((requested) => ({ requested, name: null, id: null, lifecycleUid: null })),
    managerRequested: summary.managerRequested, controlPlaneReturned: summary.controlPlaneReturned, authServiceReturned: summary.authServiceReturned,
    removalScope: "whole local stack only; this summary grants no stop authority, and bare down offers local-record inspection only",
    nextAction: "inspect-selected-stack" as const };
}

export async function team(args: ParsedArgs): Promise<void> {
  validateTeamArguments(args);
  const values = args.values as TeamValues;
  const [mode = "list", subject] = args.positionals;
  if (mode === "check") return checkTeam(subject!, values);
  if (mode === "boot") return previewBoot(subject!, values);
  if (mode === "deploy") return previewDeploy(subject!, values);
  if (mode === "remove") return previewRemove(subject!, values);
  const catalog = personaCatalog(values);
  recordOperationSpace(catalog.space);
  if (mode === "show") {
    let summary: FreshTeamSummary | undefined;
    let additiveAttempt: ReturnType<typeof findAdditiveTeamAttempt>;
    if (/^[a-f0-9]{16}$/.test(subject!)) {
      try { summary = findFreshTeamSummary(catalog.root, subject!); }
      catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the fresh launch summary for this full ID is unreadable or does not match its recorded root; it was not treated as absent", { target: { space: catalog.space, deploymentId: subject } }); }
      try { additiveAttempt = findAdditiveTeamAttempt(catalog.root, subject!); }
      catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the additive attempt for this full ID is unreadable or does not match its recorded root; its effects were not inferred", { target: { space: catalog.space, deploymentId: subject } }); }
    }
    if (summary && additiveAttempt) throw new CommandFailure("refused", "CONFLICT", "a fresh summary and additive attempt share this deployment ID; neither establishes unique ownership authority");
    if (summary) {
      if (summary.space !== catalog.space) throw new CommandFailure("refused", "CONFLICT", "this fresh launch summary belongs to another space; it was not rebound", { target: { recordedSpace: summary.space, selectedSpace: catalog.space, deploymentId: subject } });
      let intent: ReturnType<typeof findFreshTeamAttempt>;
      try { intent = findFreshTeamAttempt(catalog.root, subject!); }
      catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the fresh boot intent for this summary is unreadable; its outcome was not inferred", { target: { space: catalog.space, deploymentId: subject } }); }
      if (intent && (intent.space !== summary.space || intent.server !== summary.server || intent.authMode !== summary.authMode || intent.manifestPath !== summary.manifestPath)) throw new CommandFailure("refused", "CONFLICT", "the fresh boot intent and returned summary disagree on their target; no settled boot was inferred", { target: { space: catalog.space, deploymentId: subject } });
      let ledgers: ReturnType<typeof listLedgerFiles>;
      try { ledgers = listLedgerFiles(catalog.root); }
      catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the additive ledger directory could not be safely read; the fresh run ID was not treated as unique"); }
      if (ledgers.valid.some(({ ledger }) => ledger.runId === subject) || ledgers.refused.some(({ path }) => basename(path) === `${subject}.json`)) throw new CommandFailure("refused", "CONFLICT", "fresh and additive records claim the same deployment ID; neither was used as teardown authority");
      const row = freshRecorded(summary);
      writeResult(presentationOf(values), { command: "team", target: { space: row.space, root: row.root, deploymentId: row.deploymentId }, result: row,
        ...(row.recordedState !== "broker-boot-returned" ? { completeness: "partial" as const, partial: { message: "The fresh boot summary did not verify every returned startup component, or predates delivery-responder observation; this record proves no current ownership." } } : {}) }, (data): Report => ({ sections: [
        { title: "Recorded fresh boot", blocks: [{ kind: "fields", rows: [["Deployment", data.deploymentId], ["Kind", data.kind], ["Space", data.space], ["Root", data.root], ["Initial broker PID", data.brokerPid === null ? "not recorded" : String(data.brokerPid)], ["Auth mode", data.authMode ?? "not recorded"], ["Recorded state", data.recordedState], ["Next action", data.nextAction], ["Manager requested", data.managerRequested ? "yes" : "no (broker-only)"], ["Control-plane ensure", data.controlPlaneReturned ? "returned" : "did not confirm return"], ["Auth-service command", data.authServiceReturned ? "returned or not required" : "did not confirm return"], ["Delivery responder", data.deliveryResponder.replaceAll("-", " ")], ["Requested agent readiness", "not checked"], ["Live state", "not checked"], ["Source context", data.manifestPath]] }] },
        { title: "Declared at boot", blocks: [
          { kind: "fields", rows: [["Requested agents", String(data.agents.length)], ["Declared channels", String(data.channels.length)]] },
          { kind: "lines", lines: data.agents.length ? data.agents.slice(0, 100).map((agent) => `requested agent ${agent.requested} (allocation not checked)`) : ["No agents requested in this fresh boot."] },
          { kind: "lines", lines: data.channels.length ? data.channels.slice(0, 100).map((channel) => `declared #${channel}`) : ["No channels declared in this fresh boot."] },
          ...((data.agents.length > 100 || data.channels.length > 100) ? [{ kind: "lines" as const, lines: ["Additional declared names are not shown; JSON retains the full summary."] }] : []),
          { kind: "lines", lines: [{ text: "The requested agent names are not allocated identities. A returned boot command does not prove current broker health, agent joins or retained ownership.", tone: "hint" }] },
        ] },
        { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal down --space <recorded-space> --dry-run", description: "From the recorded root, inspect local process records without a stop" }] }, { kind: "lines", lines: [`Whole-stack apply from ${data.root} remains unguarded in this source. The preview is incomplete and this summary authorizes no stop.`] }] },
      ] }));
      return;
    }
    let attempt: ReturnType<typeof findFreshTeamAttempt>;
    if (/^[a-f0-9]{16}$/.test(subject!)) {
      try { attempt = findFreshTeamAttempt(catalog.root, subject!); }
      catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the fresh boot attempt for this full ID is unreadable or does not match its recorded root; no completed boot was inferred", { target: { space: catalog.space, deploymentId: subject } }); }
    }
    if (attempt) {
      if (additiveAttempt) throw new CommandFailure("refused", "CONFLICT", "a fresh boot and additive attempt share this deployment ID; neither establishes unique ownership authority");
      if (attempt.space !== catalog.space) throw new CommandFailure("refused", "CONFLICT", "this fresh boot attempt belongs to another space; it was not rebound", { target: { recordedSpace: attempt.space, selectedSpace: catalog.space, deploymentId: subject } });
      let ledgers: ReturnType<typeof listLedgerFiles>;
      try { ledgers = listLedgerFiles(catalog.root, { requireReadable: true }); }
      catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the additive ledger directory could not be read; this attempt ID was not treated as unique"); }
      if (ledgers.valid.some(({ ledger }) => ledger.runId === subject) || ledgers.refused.some(({ path }) => basename(path) === `${subject}.json`)) throw new CommandFailure("refused", "CONFLICT", "fresh attempt and additive record claim the same deployment ID; neither grants ownership authority");
      writeResult(presentationOf(values), { command: "team", target: { space: attempt.space, root: attempt.root, deploymentId: attempt.deploymentId }, result: { ...attempt, kind: "fresh-team-attempt", server: brokerAddressForDisplay(attempt.server) ?? "not displayable", intentPath: join(catalog.root, ".cotal", `team-boot-attempt-${attempt.deploymentId}.json`), launchSpecCandidate: join(catalog.root, ".cotal", "run", `${attempt.deploymentId}.json`), recordedState: "no-matching-summary", nativeOutcome: "unknown", effectAttempted: "not-established" }, completeness: "partial", partial: { message: "A durable fresh boot intent has no matching summary. The launch spec, broker and control plane may have changed; this is not a retry or stop authorization." } }, (data): Report => ({ sections: [{ title: "Unsettled fresh boot attempt", blocks: [{ kind: "fields", rows: [["Deployment", data.deploymentId], ["Space", data.space], ["Root", data.root], ["Broker", data.server], ["Manifest", data.manifestPath], ["Intent file", data.intentPath], ["Launch spec candidate", data.launchSpecCandidate], ["Intent recorded", data.createdAt], ["Native outcome", "unknown"]] }, { kind: "lines", lines: ["The launch spec path is derived from the run ID, not read or verified. Inspect the original listener and local custody. A missing summary is not proof that the broker never started."] }] }] }));
      return;
    }
    if (additiveAttempt) {
      if (additiveAttempt.space !== catalog.space) throw new CommandFailure("refused", "CONFLICT", "this additive attempt belongs to another space; it was not rebound", { target: { recordedSpace: additiveAttempt.space, selectedSpace: catalog.space, deploymentId: subject } });
      let ledgers: ReturnType<typeof listLedgerFiles>;
      try { ledgers = listLedgerFiles(catalog.root, { requireReadable: true }); }
      catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the additive ledger directory could not be read; an attempt was not treated as settled"); }
      if (ledgers.valid.some(({ ledger }) => ledger.runId === subject) || ledgers.refused.some(({ path }) => basename(path) === `${subject}.json`)) throw new CommandFailure("refused", "CONFLICT", "an additive intent and legacy ledger share this ID, but no revision-bound settlement links them; no ownership was inferred");
      let inventory: ReturnType<typeof listAdditiveTeamAttempts>;
      try { inventory = listAdditiveTeamAttempts(catalog.root); }
      catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the additive step inventory could not be read; no native outcome was inferred"); }
      const steps = inventory.steps.filter((step) => step.deploymentId === subject);
      const unreadableSteps = inventory.refused.filter(({ path }) => basename(path).startsWith(`team-deploy-step-${subject}-`) || basename(path) === `team-deploy-attempt-${subject}-returned.json`).map(({ path }) => path);
      const receipt = inventory.returned.find((row) => row.deploymentId === subject);
      if (additiveAttempt.requestedAgents.length) {
        const agentSteps = inventory.agentSteps.filter((step) => step.deploymentId === subject);
        const agentReceipt = receipt && receipt.kind !== "additive-channel-receipt" ? receipt : null;
        const mixed = additiveAttempt.declaredChannels.length > 0;
        const removalReceipt = inventory.removal?.returned.find((row) => row.deploymentId === subject) ?? null;
        const removalAttempt = inventory.removal?.attempts.find((row) => row.deploymentId === subject) ?? null;
        const removalSteps = inventory.removal?.steps.filter((row) => row.deploymentId === subject) ?? [];
        const cardRemoval = mixed ? { receipt: inventory.channelRemoval?.returned.find((row) => row.deploymentId === subject) ?? null, attempt: inventory.channelRemoval?.attempts.find((row) => row.deploymentId === subject) ?? null, steps: inventory.channelRemoval?.steps.filter((row) => row.deploymentId === subject) ?? [] } : null;
        const data = { ...additiveAttempt, server: brokerAddressForDisplay(additiveAttempt.server) ?? "not displayable", kind: mixed ? "additive-mixed-deployment" : "additive-agent-deployment", recordedState: additiveTeamRecordedState(additiveAttempt, inventory), agentSteps, steps, removalReceipt, removalAttempt, removalSteps, cardRemoval, remainingRemovalPhase: !removalAttempt ? null : !removalReceipt ? "agent-retirement" : mixed && !cardRemoval?.receipt ? "card-removal" : null, receipt: agentReceipt ? { ...agentReceipt, server: brokerAddressForDisplay(agentReceipt.server) ?? "not displayable" } : null, unreadableSteps: [...new Set([...unreadableSteps, ...inventory.refused.filter(({ path }) => basename(path).startsWith(`team-deploy-agent-step-${subject}-`) || basename(path).startsWith("team-remove-") && basename(path).includes(subject!) || basename(path).startsWith("team-channel-remove-") && basename(path).includes(subject!)).map(({ path }) => path)])], currentState: "not-rechecked" };
        writeResult(presentationOf(values), { command: "team", target: { space: data.space, root: data.root, deploymentId: data.deploymentId }, result: data, completeness: "partial", partial: { message: removalReceipt ? "All original static agent incarnations have matched native retired slot/head and cleanup receipts. Current alias holders are not rechecked, and the receipt authorizes no further stop." : agentReceipt ? "Declared channel creates and native launch joins have matching historical receipts. Current health, readers and permission to remove an incarnation are not established." : "The original intent and steps do not settle every channel create and launch. A missing acceptance or terminal does not authorize another submission." } }, (row): Report => ({ sections: [
          { title: agentReceipt ? "Returned additive team" : "Unsettled additive team", blocks: [{ kind: "fields", rows: [["Deployment", row.deploymentId], ["Root", row.root], ["Manager", row.managerInstanceId ?? "not recorded"], ["Recorded state", row.recordedState], ["Requested agents", String(row.requestedAgents.length)], ["Joined receipts", row.receipt ? String(row.receipt.createdAgents.length) : "incomplete"], ["Declared channels", String(row.declaredChannels.length)], ["Channel create receipts", row.receipt ? String(row.receipt.createdChannels.length) : "incomplete"], ["Current state", row.currentState]] }] },
          ...(row.receipt ? [{ title: "Original joined identities", blocks: [{ kind: "table" as const, columns: [{ key: "requested", label: "Declared" }, { key: "name", label: "Allocated" }, { key: "id", label: "Identity" }, { key: "goal", label: "Accepted goal" }], rows: row.receipt.createdAgents.slice(0, 100).map((agent) => ({ requested: agent.requested, name: agent.name, id: agent.id, goal: agent.request.goalId })) }, ...(row.receipt.createdAgents.length > 100 ? [{ kind: "lines" as const, lines: ["Additional joined identities are in JSON."] }] : [])] }] : [{ title: "Native launch journal", blocks: [{ kind: "table" as const, columns: [{ key: "name", label: "Declared" }, { key: "phase", label: "Phase" }, { key: "request", label: "Original request" }, { key: "goal", label: "Accepted goal" }], rows: row.agentSteps.slice(0, 100).map((step) => ({ name: step.name, phase: step.phase, request: step.requestId, goal: step.request?.goalId ?? "not returned" })) }, { kind: "lines" as const, lines: [...(row.agentSteps.length > 100 ? ["Additional native steps are in JSON."] : []), "Do not retry an unknown launch or infer a fresh incarnation from a reused name."] }] }]),
          ...(row.declaredChannels.length ? [{ title: row.receipt ? "Created channel receipts" : "Native channel journal", blocks: [{ kind: "table" as const, columns: [{ key: "name", label: "Channel" }, { key: "phase", label: "Phase" }, { key: "revision", label: "Returned revision" }], rows: row.receipt ? row.receipt.createdChannels.slice(0, 100).map((channel) => ({ name: `#${channel.name}`, phase: "accepted", revision: String(channel.revision) })) : row.steps.slice(0, 100).map((step) => ({ name: `#${step.name}`, phase: step.phase, revision: step.phase === "accepted" ? String(step.revision) : "not returned" })) }, { kind: "lines" as const, lines: [...((row.receipt ? row.receipt.createdChannels.length : row.steps.length) > 100 ? ["Additional channel records are in JSON."] : []), "Returned revisions do not prove current cards or exclusive readers."] }] }] : []),
          ...(row.removalAttempt ? [{ title: row.removalReceipt ? "Recorded native retirements" : "Unsettled removal journal", blocks: [{ kind: "fields" as const, rows: [["Full removal receipt", row.removalReceipt ? "recorded" : "not confirmed"], ["Original-receipt binding", row.removalAttempt.originalReceiptDigest]] as const }, { kind: "table" as const, columns: [{ key: "name", label: "Original agent" }, { key: "phase", label: "Observation" }, { key: "request", label: "Stop request" }, { key: "revisions", label: "Slot / head revisions" }], rows: row.removalSteps.map((step) => ({ name: step.phase === "retired" ? step.observation.name : row.receipt?.createdAgents[step.ordinal]?.name ?? row.requestedAgents[step.ordinal] ?? "not recorded", phase: step.phase === "retired" ? "native retired and cleaned" : "stop submitted; outcome not implied", request: step.requestId ?? "already retired before stop", revisions: step.phase === "retired" ? `${step.observation.slotRevision} / ${step.observation.headRevision}` : "not confirmed" })) }, { kind: "lines" as const, lines: ["Only a complete matched retirement receipt releases this deployment's known additive blocker. An incomplete intent is not retry authority; stop acceptance is not retirement."] }] }] : []),
          ...(row.cardRemoval?.attempt ? [{ title: row.cardRemoval.receipt ? "Recorded card removals" : "Unsettled card removal journal", blocks: [{ kind: "fields" as const, rows: [["Full card receipt", row.cardRemoval.receipt ? "recorded" : "not confirmed"], ["Remaining removal phase", row.remainingRemovalPhase ?? "none"]] as [string, string][] }, { kind: "table" as const, columns: [{ key: "channel", label: "Channel" }, { key: "phase", label: "Step" }, { key: "marker", label: "Marker revision" }], rows: row.cardRemoval.steps.map((step) => ({ channel: `#${step.name}`, phase: cardStepText(step.phase), marker: "markerRevision" in step && step.markerRevision !== null ? String(step.markerRevision) : "currentRevision" in step ? String(step.currentRevision) : "none" })) }, { kind: "lines" as const, lines: ["Only registry cards are in scope. Retained history, grants and readers were not changed. The mixed deployment is released only when both receipts exist."] }] }] : row.remainingRemovalPhase ? [{ title: "Remaining removal phase", blocks: [{ kind: "lines" as const, lines: [`The ${row.remainingRemovalPhase.replace("-", " ")} phase has not settled. An unsettled intent is not retry authority.`] }] }] : []),
          ...(row.unreadableSteps.length ? [{ title: "Unreadable records", blocks: [{ kind: "lines" as const, lines: [...row.unreadableSteps.slice(0, 100).map((path) => `Unreadable: ${path}`), ...(row.unreadableSteps.length > 100 ? ["Additional unreadable paths are in JSON."] : [])] }] }] : []),
        ] }));
        return;
      }
      const channelRemoval = { receipt: inventory.channelRemoval?.returned.find((row) => row.deploymentId === subject) ?? null, attempt: inventory.channelRemoval?.attempts.find((row) => row.deploymentId === subject) ?? null, steps: inventory.channelRemoval?.steps.filter((row) => row.deploymentId === subject) ?? [] };
      const result = { ...additiveAttempt, server: brokerAddressForDisplay(additiveAttempt.server) ?? "not displayable", intentPath: join(catalog.root, ".cotal", `team-deploy-attempt-${additiveAttempt.deploymentId}.json`), steps, unreadableSteps: [...unreadableSteps, ...inventory.refused.filter(({ path }) => basename(path).startsWith("team-channel-remove-") && basename(path).includes(subject!)).map(({ path }) => path)], receipt: receipt ? { ...receipt, server: brokerAddressForDisplay(receipt.server) ?? "not displayable" } : null, channelRemoval, recordedState: channelRemoval.receipt ? "removal-returned" as const : receipt ? "channel-create-returned" as const : "unsettled-additive-attempt" as const, nativeOutcome: receipt ? "returned" as const : "unknown" as const };
      writeResult(presentationOf(values), { command: "team", target: { space: result.space, root: result.root, deploymentId: result.deploymentId }, result, completeness: "partial", partial: { message: receipt ? "All declared channel creates returned and their revisions were recorded. This is historical, not current broker state; guarded card removal rechecks each revision." : "Submitted and acknowledged channel steps do not settle the entire deployment. Missing or unreadable steps remain unknown; neither intent nor steps grant removal or retry authority." } }, (data): Report => ({ sections: [
        { title: data.receipt ? "Returned additive channels" : "Unsettled additive attempt", blocks: [{ kind: "fields", rows: [["Deployment", data.deploymentId], ["Space", data.space], ["Root", data.root], ["Broker", data.server], ["Auth mode", data.authMode], ["TLS", data.tlsRequired ? "required" : "not required"], ["Manifest", data.manifestPath], ["Intent recorded", data.createdAt], ["Recorded state", data.recordedState], ["Created channels", data.receipt ? String(data.receipt.createdChannels.length) : "unknown"]] }, { kind: "lines", lines: [data.receipt ? "The returned revisions are historical. Current cards and readers were not checked here; team remove deletes only cards still at these revisions." : "The intent and partial steps do not prove a complete deployment. Inspect the exact run before any retry or removal."] }] },
        ...(data.receipt ? [{ title: "Created channel receipts", blocks: [{ kind: "table" as const, columns: [{ key: "channel", label: "Channel" }, { key: "revision", label: "Returned revision" }], rows: data.receipt.createdChannels.slice(0, 100).map((row) => ({ channel: `#${row.name}`, revision: String(row.revision) })) }, ...(data.receipt.createdChannels.length > 100 ? [{ kind: "lines" as const, lines: ["Additional returned revisions are in JSON."] }] : [])] }] : data.steps.length || data.unreadableSteps.length ? [{ title: "Unsettled channel steps", blocks: [{ kind: "table" as const, columns: [{ key: "channel", label: "Channel" }, { key: "phase", label: "Step" }, { key: "revision", label: "Returned revision" }], rows: data.steps.slice(0, 100).map((step) => ({ channel: `#${step.name}`, phase: step.phase, revision: step.phase === "accepted" ? String(step.revision) : "not returned" })) }, { kind: "lines" as const, lines: [...data.unreadableSteps.slice(0, 100).map((path) => `Unreadable: ${path}`), ...(data.steps.length > 100 || data.unreadableSteps.length > 100 ? ["Additional steps are in JSON."] : [])] }] }] : []),
        ...(data.channelRemoval.attempt ? [{ title: data.channelRemoval.receipt ? "Recorded card removals" : "Unsettled card removal journal", blocks: [{ kind: "fields" as const, rows: [["Full removal receipt", data.channelRemoval.receipt ? "recorded" : "not confirmed"], ["Original-receipt binding", data.channelRemoval.attempt.originalReceiptDigest]] as [string, string][] }, { kind: "table" as const, columns: [{ key: "channel", label: "Channel" }, { key: "phase", label: "Step" }, { key: "marker", label: "Marker revision" }], rows: data.channelRemoval.steps.map((step) => ({ channel: `#${step.name}`, phase: cardStepText(step.phase), marker: "markerRevision" in step && step.markerRevision !== null ? String(step.markerRevision) : "currentRevision" in step ? String(step.currentRevision) : "none" })) }, { kind: "lines" as const, lines: ["Only registry cards are in scope. Retained history, grants and readers were not changed. An incomplete intent is not retry authority."] }] }] : []),
      ] }));
      return;
    }
    let found: ReturnType<typeof findLedgerByRun>;
    try { found = findLedgerByRun(catalog.root, subject!); }
    catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the selected root has no readable additive ownership ledger for this full ID; no resources were touched", { target: { space: catalog.space, deploymentId: subject }, remedy: "inspect team in the checkout and space that created this deployment" }); }
    if (found.ledger.space !== catalog.space) throw new CommandFailure("refused", "CONFLICT", "this deployment's recorded space differs from the selected space; it was not rebound", { target: { recordedSpace: found.ledger.space, selectedSpace: catalog.space, deploymentId: subject } });
    const result = recorded(catalog.root, found.ledger);
    writeResult(presentationOf(values), { command: "team", target: { space: result.space, root: result.root, deploymentId: result.deploymentId }, result }, (row): Report => ({ sections: [
      { title: "Recorded team deployment", blocks: [{ kind: "fields", rows: [["Deployment", row.deploymentId], ["Kind", row.kind], ["Space", row.space], ["Root", row.root], ["Recorded state", row.recordedState], ["Next action", row.nextAction], ["Live state", "not checked"], ["Source context", row.manifestPath]] }] },
      { title: "Ledger-owned agents", blocks: [row.agents.length ? { kind: "table", columns: [{ key: "requested", label: "Declared" }, { key: "name", label: "Allocated name" }, { key: "id", label: "Identity" }, { key: "lifecycleUid", label: "Lifecycle" }], rows: row.agents.slice(0, 100).map((agent) => ({ ...agent, lifecycleUid: agent.lifecycleUid ?? "not recorded by this ledger" })) } : { kind: "lines", lines: ["No agent entries in this ledger."] }, ...(row.agents.length > 100 ? [{ kind: "lines" as const, lines: ["Additional owned agent records are in JSON."] }] : [])] },
      { title: "Ledger-owned channels", blocks: [{ kind: "lines", lines: row.channels.length ? row.channels.slice(0, 100).map((name) => `#${name}`) : ["No channel entries in this ledger."] }, ...(row.channels.length > 100 ? [{ kind: "lines" as const, lines: ["Additional owned channel records are in JSON."] }] : []), { kind: "lines", lines: [{ text: "An ownership record is not proof of running agents or permission to stop them. Removal must recheck native identities and retain unresolved entries.", tone: "hint" }] }] },
      { title: "Next", blocks: [{ kind: "commands", items: [{ command: `cotal down -f <file> --run ${row.deploymentId} --dry-run`, description: "From the recorded root, review only this additive run's native teardown plan" }] }, { kind: "lines", lines: [{ text: "The file is a required command argument, not the authority for --run. Do not apply from another root or infer that this ledger names current live members.", tone: "hint" }] }] },
    ] }));
    return;
  }
  let records: ReturnType<typeof listLedgerFiles>;
  try { records = listLedgerFiles(catalog.root); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the deployment record directory could not be read; an empty inventory was not inferred"); }
  let fresh: ReturnType<typeof listFreshTeamSummaries>;
  try { fresh = listFreshTeamSummaries(catalog.root); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the fresh launch summary directory could not be safely read; an empty inventory was not inferred"); }
  let attempts: ReturnType<typeof listFreshTeamAttempts>;
  try { attempts = listFreshTeamAttempts(catalog.root); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the fresh boot attempt records could not be read; an empty inventory was not inferred"); }
  let additiveAttempts: ReturnType<typeof listAdditiveTeamAttempts>;
  try { additiveAttempts = listAdditiveTeamAttempts(catalog.root); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the additive attempt records could not be read; an empty deployment inventory was not inferred"); }
  const additive = records.valid.filter(({ ledger }) => ledger.space === catalog.space).map(({ ledger }) => recorded(catalog.root, ledger));
  const freshItems = fresh.valid.filter((summary) => summary.space === catalog.space).map(freshRecorded);
  const removedIds = removedAdditiveDeploymentIds(additiveAttempts);
  const returnedItems = additiveAttempts.returned.filter((receipt) => receipt.space === catalog.space).map((receipt) => ({ deploymentId: receipt.deploymentId, kind: receipt.kind === "additive-team-receipt" ? "additive-mixed-team" as const : receipt.kind === "additive-agent-receipt" ? "additive-agent-only" as const : "additive-channel-only" as const, space: receipt.space, root: receipt.root, manifestPath: receipt.manifestPath, recordedState: removedIds.has(receipt.deploymentId) ? "removal-returned" : receipt.kind === "additive-team-receipt" ? "channels-and-agents-returned" : receipt.kind === "additive-agent-receipt" ? "agent-joins-returned" : "channel-create-returned", liveState: "not-checked", nextAction: removedIds.has(receipt.deploymentId) ? "inspect-removal-history" : additiveAttempts.removal?.attempts.some((row) => row.deploymentId === receipt.deploymentId) && !additiveAttempts.removal?.returned.some((row) => row.deploymentId === receipt.deploymentId) || additiveAttempts.channelRemoval?.attempts.some((row) => row.deploymentId === receipt.deploymentId) && !additiveAttempts.channelRemoval?.returned.some((row) => row.deploymentId === receipt.deploymentId) ? "reconcile-unsettled-removal" : receipt.kind === "additive-channel-receipt" ? "inspect-card-revisions-before-removal" : "inspect-native-incarnation-before-removal", agents: receipt.kind !== "additive-channel-receipt" ? receipt.createdAgents : [], channels: receipt.createdChannels }));
  const ids = new Set(additive.map((row) => row.deploymentId));
  if ([...freshItems, ...returnedItems].some((row) => ids.has(row.deploymentId)) || returnedItems.some((row) => freshItems.some((freshRow) => freshRow.deploymentId === row.deploymentId))) throw new CommandFailure("refused", "CONFLICT", "fresh, legacy additive and returned channel records share a deployment ID; none was treated as unique ownership");
  const items = [...freshItems, ...additive, ...returnedItems];
  const summariesById = new Map(fresh.valid.map((summary) => [summary.deploymentId, summary]));
  const unsettledAttempts = attempts.valid.filter((attempt) => attempt.space === catalog.space && !freshTeamAttemptSettled(attempt, summariesById.get(attempt.deploymentId)))
    .map((attempt) => ({ deploymentId: attempt.deploymentId, space: attempt.space, root: attempt.root, server: brokerAddressForDisplay(attempt.server) ?? "not displayable", createdAt: attempt.createdAt, recordedState: "unsettled-fresh-attempt" as const }));
  if (unsettledAttempts.some((attempt) => ids.has(attempt.deploymentId))) throw new CommandFailure("refused", "CONFLICT", "fresh attempt and additive ledger claim the same deployment ID; neither was treated as ownership authority");
  const returnedIds = new Set(returnedItems.map((row) => row.deploymentId));
  const allAdditiveAttempts = additiveAttempts.valid.filter((attempt) => attempt.space === catalog.space);
  const occupied = new Set([...freshItems.map((row) => row.deploymentId), ...additive.map((row) => row.deploymentId), ...unsettledAttempts.map((row) => row.deploymentId)]);
  if (allAdditiveAttempts.some((attempt) => occupied.has(attempt.deploymentId))) throw new CommandFailure("refused", "CONFLICT", "additive and another deployment record claim the same ID; no settled ownership was inferred");
  const unsettledAdditiveAttempts = allAdditiveAttempts.filter((attempt) => !returnedIds.has(attempt.deploymentId))
    .map((attempt) => ({ deploymentId: attempt.deploymentId, space: attempt.space, root: attempt.root, server: brokerAddressForDisplay(attempt.server) ?? "not displayable", createdAt: attempt.createdAt, recordedState: "unsettled-additive-attempt" as const }));
  const warnings = [...records.refused, ...fresh.refused, ...attempts.refused, ...additiveAttempts.refused].map(({ path }) => ({ code: "DEPLOYMENT_RECORD_UNREADABLE", message: "A local deployment record could not be read or validated; it was not reset.", target: { path } }));
  writeResult(presentationOf(values), { command: "team", target: catalog, result: { kind: "team-deployments", scope: "selected-root fresh summaries/attempts and additive ledgers/attempts; historical completeness unknown", items, unsettledAttempts, unsettledAdditiveAttempts }, completeness: "partial", partial: { message: "The available local records do not establish a complete historical or live team inventory. An unsettled fresh or additive attempt is not proof that no native effect occurred." }, warnings }, (result): Report => ({ sections: [
    { title: "Recorded teams", blocks: [{ kind: "fields", rows: [["Space", catalog.space], ["Root", catalog.root], ["Scope", "fresh summaries, additive ledgers and returned agent/channel receipts; historical completeness unknown"]] }, result.items.length ? { kind: "table", columns: [{ key: "id", label: "Deployment" }, { key: "kind", label: "Kind" }, { key: "state", label: "Recorded state" }, { key: "next", label: "Next" }, { key: "agents", label: "Agent records" }, { key: "channels", label: "Channel records" }], rows: result.items.slice(0, 100).map((row) => ({ id: row.deploymentId, kind: row.kind, state: row.recordedState, next: row.nextAction, agents: String(row.agents.length), channels: String(row.channels.length) })) } : { kind: "lines", lines: ["No readable fresh summaries or additive ledgers for this selected space."] }, ...(result.items.length > 100 ? [{ kind: "lines" as const, lines: ["Additional deployment records are in JSON."] }] : []), { kind: "lines", lines: [{ text: "Older fresh boots may have no summary. A record is not current live state or removal authority; native observations are still needed.", tone: "waiting" }] }] },
    { title: "Unsettled fresh boot attempts", blocks: [result.unsettledAttempts.length ? { kind: "table", columns: [{ key: "id", label: "Deployment" }, { key: "space", label: "Space" }, { key: "broker", label: "Recorded broker" }, { key: "time", label: "Intent recorded" }], rows: result.unsettledAttempts.slice(0, 100).map((row) => ({ id: row.deploymentId, space: row.space, broker: row.server, time: row.createdAt })) } : { kind: "lines", lines: ["No unsettled readable fresh boot attempts in the selected space."] }, { kind: "lines", lines: [...(result.unsettledAttempts.length > 100 ? ["Additional attempts are in JSON."] : []), "An intent without a matching returned summary may have started a broker. Inspect its exact run; do not retry or stop by inference."] }] },
    { title: "Unsettled additive attempts", blocks: [result.unsettledAdditiveAttempts.length ? { kind: "table", columns: [{ key: "id", label: "Deployment" }, { key: "space", label: "Space" }, { key: "broker", label: "Recorded broker" }, { key: "time", label: "Intent recorded" }], rows: result.unsettledAdditiveAttempts.slice(0, 100).map((row) => ({ id: row.deploymentId, space: row.space, broker: row.server, time: row.createdAt })) } : { kind: "lines", lines: ["No readable additive attempts in the selected space."] }, { kind: "lines", lines: [...(result.unsettledAdditiveAttempts.length > 100 ? ["Additional attempts are in JSON."] : []), "An intent names a request, not resources created. Its native outcome remains unknown until a guarded receipt reconciles it."] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal t show <deployment-id>", description: "Inspect recorded ownership or an unsettled boot attempt without changing anything" }, { command: "cotal t check <file> --graph", description: "Read the resolved manifest and its access edges offline" }] }] },
  ] }));
}

async function previewDeploy(file: string, values: TeamValues): Promise<void> {
  if (values["dry-run"] !== true) {
    let resolved: ReturnType<typeof loadManifest>;
    try { resolved = loadManifest(resolve(file)); }
    catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the additive manifest could not be resolved; no native effect was submitted"); }
    if (resolved.agents.length) {
      const { applyAgentTeam } = await import("./team-agent-apply.js");
      return applyAgentTeam(file, values);
    }
    return applyChannelOnlyTeam(file, values);
  }
  const { path, prepared } = readTeamFile(file, values);
  const space = prepared.manifest.space;
  let local: ReturnType<typeof findMesh>, waiting: ReturnType<typeof findPreparedSpace>;
  try { local = findMesh(space); waiting = findPreparedSpace(space); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the local registry or prepared-space records could not be read; no additive target was inferred", { target: { space } }); }
  if (!local) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", waiting ? "the selected space is only prepared; additive deploy requires an existing registered mesh" : "the selected space has no local registration; no broker or authorization target was inferred", { target: { space }, remedy: "register an existing authorized mesh before reviewing an additive deployment" });
  if (waiting && canonicalRoot(waiting.root) !== canonicalRoot(local.root)) throw new CommandFailure("refused", "CONFLICT", "prepared and registered records disagree on this space's root; no additive target was chosen", { target: { space } });
  const runtimeRequest = values.runtime ?? prepared.manifest.runtime ?? "pty";
  const openDurable = local.mode === "open" && prepared.manifest.channels.some((channel) => channel.deliveryClass === "durable");
  let attempts: ReturnType<typeof listAdditiveTeamAttempts>;
  try { attempts = listAdditiveTeamAttempts(canonicalRoot(local.root)); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the registered root's additive attempt records could not be read; no empty apply history was inferred", { target: { space, root: local.root } }); }
  const native = await inspectTeamDeployment(canonicalRoot(local.root), path, prepared, runtimeRequest);
  const result = { kind: "additive-team-deploy-preview", dryRun: true, path, space, root: local.root,
    retainedAdditiveAttempts: attempts.valid.map((attempt) => ({ deploymentId: attempt.deploymentId, space: attempt.space, server: brokerAddressForDisplay(attempt.server) ?? "not displayable", createdAt: attempt.createdAt, recordedState: additiveTeamRecordedState(attempt, attempts) })), unreadableAdditiveAttempts: attempts.refused.map(({ path }) => path),
    registrationOrigin: local.origin ?? "not recorded", recordedBroker: brokerAddressForDisplay(local.server) ?? null,
    recordedMode: local.mode, recordedTlsRequired: local.tlsRequired === true,
    runtimeRequest, native, openDurableUnsupported: openDurable,
    agents: prepared.agents.map((agent) => ({ name: agent.name, application: agent.agentType, role: agent.role ?? null, requestedModel: agent.model ?? null })),
    channels: prepared.manifest.channels.map((channel) => ({ name: channel.name, deliveryClass: channel.deliveryClass ?? null, replay: channel.replay ?? null, replayWindow: channel.replayWindow ?? null })),
    targetReachability: "native-reads-established", brokerPolicy: "not-checked", authorization: "read-established-not-deploy-authority", ownershipClassification: "native-roster-and-registry-snapshot", connectorAvailability: "not-checked", effectAttempted: false, persisted: false };
  writeResult(presentationOf(values), { command: "team deploy", target: { space, root: local.root, path }, result,
    completeness: "partial", partial: { message: "Native roster and channel-registry classification is a non-atomic read, not an authorized deployment plan. Manager readiness, runtime and connector availability, write grants and apply effects remain unchecked." },
    warnings: [...prepared.warnings.map((warning) => ({ code: "MANIFEST_WARNING", target: { agent: warning.agent }, message: warning.message })), ...(openDurable ? [{ code: "OPEN_DURABLE_UNSUPPORTED", target: { space }, message: "The selected running mesh is open and has no delivery daemon; this manifest's durable declaration cannot acquire a per-member backstop." }] : []), ...(!native.unmanaged.feedAvailable ? [{ code: "MEMBERSHIP_FEED_UNAVAILABLE", target: { space }, message: "Other readers are a lower bound because the derived membership feed has no observed heartbeat." }] : []), ...(attempts.valid.length || attempts.refused.length ? [{ code: "ADDITIVE_ATTEMPT_REMAINS", target: { root: local.root, space, deploymentIds: attempts.valid.map((attempt) => attempt.deploymentId), unreadable: attempts.refused.map(({ path }) => path) }, message: "An additive deployment intent is retained at this root; the preview does not settle or retry it." }] : [])] }, (data): Report => ({ sections: [
    { title: "Additive team inspection", blocks: [{ kind: "fields", rows: [["Space", data.space], ["Registered root", data.root], ["Registration", data.registrationOrigin], ["Recorded broker", data.recordedBroker ?? "not displayable"], ["Recorded mode", data.recordedMode], ["TLS requirement", data.recordedTlsRequired ? "recorded required" : "not recorded required"], ["Manifest", data.path], ["Runtime request", data.runtimeRequest], ["Prior additive run", data.native.priorDeploymentId ?? "none recorded"], ["Retained additive attempts", String(data.retainedAdditiveAttempts.length)], ["Unreadable additive attempts", String(data.unreadableAdditiveAttempts.length)], ["Native roster", data.native.roster], ["Channel registry", data.native.registry], ["Membership feed", data.native.unmanaged.feedAvailable ? "display-only lower bound" : "unavailable"], ["Durable delivery on open", data.openDurableUnsupported ? "unsupported" : "not a contradiction"]] }, { kind: "lines", lines: [{ text: "The observed registry and roster do not reserve names or authorize creation. Manager readiness, runtime/provider availability and write grants remain unchecked; nothing was added.", tone: "waiting" }] }] },
    { title: "Requested agents", blocks: [data.agents.length ? { kind: "table", columns: [{ key: "name", label: "Name" }, { key: "application", label: "Application" }, { key: "role", label: "Role" }, { key: "model", label: "Model request" }], rows: data.agents.slice(0, 100).map((agent) => ({ name: agent.name, application: agent.application, role: agent.role ?? "none", model: agent.requestedModel ?? "application default" })) } : { kind: "lines", lines: ["No agents requested."] }, ...(data.agents.length > 100 ? [{ kind: "lines" as const, lines: ["Additional requested agents are in JSON."] }] : [])] },
    { title: "Declared channels", blocks: [data.channels.length ? { kind: "table", columns: [{ key: "name", label: "Channel" }, { key: "delivery", label: "Delivery class" }, { key: "replay", label: "Replay" }, { key: "window", label: "Replay window" }], rows: data.channels.slice(0, 100).map((channel) => ({ name: `#${channel.name}`, delivery: channel.deliveryClass ?? "not declared", replay: channel.replay === null ? "not declared" : channel.replay ? "on" : "off", window: channel.replayWindow ?? "not declared" })) } : { kind: "lines", lines: ["No channels declared."] }, { kind: "lines", lines: [...(data.channels.length > 100 ? ["Additional channels are in JSON."] : []), "Declared policy is not a live registry value or permission to overwrite existing metadata. Apply accepts all-new live channels and bounded static/open agent or mixed teams; existing cards and reapply refuse."] }] },
    { title: "Retained additive attempts", blocks: [data.retainedAdditiveAttempts.length ? { kind: "table", columns: [{ key: "id", label: "Deployment" }, { key: "space", label: "Space" }, { key: "state", label: "Recorded state" }], rows: data.retainedAdditiveAttempts.slice(0, 100).map((attempt) => ({ id: attempt.deploymentId, space: attempt.space, state: attempt.recordedState })) } : { kind: "lines", lines: ["No readable additive attempt under this root."] }, { kind: "lines", lines: [...data.unreadableAdditiveAttempts.slice(0, 100).map((path) => `Unreadable additive attempt: ${path}`), ...(data.retainedAdditiveAttempts.length > 100 || data.unreadableAdditiveAttempts.length > 100 ? ["Additional records are in JSON."] : []), "A returned receipt records historical channel creation or native agent joins; an unsettled intent remains unknown. Neither grants removal or retry authority."] }] },
    { title: "Existing unmanaged channel metadata", blocks: [data.native.channels.existsUnmanagedPolicy.length ? { kind: "table", columns: [{ key: "name", label: "Channel" }, { key: "difference", label: "Declared fields differing from live" }], rows: data.native.channels.existsUnmanagedPolicy.slice(0, 100).map((row) => ({ name: `#${row.name}`, difference: row.differingDeclaredFields.join(", ") || "none among declared fields" })) } : { kind: "lines", lines: ["No existing unmanaged declared channel cards in this snapshot."] }, { kind: "lines", lines: [...(data.native.channels.existsUnmanagedPolicy.length > 100 ? ["Additional comparisons are in JSON."] : []), "Only field names are shown, not live instructions or descriptions. Unmanaged cards are not patched or adopted; an omitted declaration is not a difference."] }] },
    { title: "Native additive classification", blocks: [{ kind: "fields", rows: [["New channel candidates", String(data.native.channels.create.length)], ["Prior-owned channel records", String(data.native.channels.owned.length)], ["Unmanaged existing channels", String(data.native.channels.existsUnmanaged.length)], ["Present unowned agents", String(data.native.unmanaged.presentUnowned.length)]] }, { kind: "table", columns: [{ key: "name", label: "Declared agent" }, { key: "state", label: "Disposition" }, { key: "running", label: "Prior name present" }], rows: data.native.agents.slice(0, 100).map((agent) => ({ name: agent.name, state: agent.disposition, running: agent.runningByName === null ? "not recorded" : agent.runningByName ? "yes" : "no" })) }, ...(data.native.agents.length > 100 ? [{ kind: "lines" as const, lines: ["Additional classifications are in JSON."] }] : []), { kind: "lines", lines: ["Presence is not an ownership claim. The derived membership feed is display-only and may miss silent readers; this read is not a safe-to-apply plan."] }] },
  ] }));
}

/** A native read for display. Neither PS nor the derived membership feed grants stop authority. */
async function nativeRemovalImpact(root: string, ledger: MeshLedger) {
  const conn = await connectOrThrow({ space: ledger.space }, "deployer", { readOnly: true });
  if (!conn.root || canonicalRoot(conn.root) !== canonicalRoot(root) || conn.server !== ledger.server)
    throw new CommandFailure("refused", "CONFLICT", "the current registered broker/root differs from the additive ledger; no live removal target was inferred", { target: { space: ledger.space, deploymentId: ledger.runId } });
  let user: Awaited<ReturnType<typeof userViewAuth>> | undefined;
  if (conn.mode === "user") {
    try { user = await userViewAuth(conn, "deployer"); }
    catch (error) {
      const remedy = credentialRefusalMessage(error);
      throw new CommandFailure("refused", "PERMISSION_DENIED", "the selected user-auth deployer view was not issued; no other identity or root was substituted", { target: { space: ledger.space, deploymentId: ledger.runId }, ...(remedy ? { remedy } : {}) });
    }
  }
  const ep = new CotalEndpoint({ space: ledger.space, servers: conn.server, tls: conn.tls,
    ...(user ? { bearer: user.source, sentinelCreds: user.sentinelCreds, lifecycleUid: user.lifecycleUid,
      card: { owner: user.owner, actor: user.actor, name: "team-remove-preview", kind: "endpoint" as const } }
      : { creds: conn.creds, lifecycleUid: conn.epCaller?.uid, card: { name: "team-remove-preview", kind: "endpoint" as const } }),
    channels: [], consume: false, registerPresence: false, watchPresence: false });
  ep.on("error", () => {});
  try {
    await ep.start();
    const response = await ep.invokeService("manager", "ps", undefined, { deadlineMs: 8_000 });
    const live = response.reply.data;
    if (response.reply.ok !== true || !Array.isArray(live) || live.length > 10_000 || live.some((row) => !row || typeof row !== "object" || typeof row.name !== "string" || !row.name || typeof row.id !== "string" || !row.id || typeof row.lifecycleUid !== "string" || !row.lifecycleUid) || new Set(live.map((row: { id: string }) => row.id)).size !== live.length)
      throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the serving manager did not return a bounded, usable native agent inventory; no disappearance or stop eligibility was inferred", { target: { space: ledger.space, deploymentId: ledger.runId } });
    const byId = new Map<string, { name: string; id: string; lifecycleUid: string }>(live.map((row: { name: string; id: string; lifecycleUid: string }) => [row.id, row]));
    const agents = ledger.created.agents.map((agent) => {
      const current = byId.get(agent.id);
      const other = live.find((row: { name: string; id: string }) => row.name === agent.name && row.id !== agent.id);
      return { name: agent.name, recordedId: agent.id, recordedLifecycleUid: agent.lifecycleUid ?? null,
        observedId: current?.id ?? other?.id ?? null, observedLifecycleUid: current?.lifecycleUid ?? other?.lifecycleUid ?? null,
        state: current ? current.name !== agent.name ? "identity-name-mismatch" : !agent.lifecycleUid ? "recorded-lifecycle-unpinned" : current.lifecycleUid === agent.lifecycleUid ? "exact-incarnation-observed" : "successor-incarnation-observed"
          : other ? "foreign-name-holder-observed" : "not-in-manager-ps" };
    });
    const readAuth = user ? { bearer: user.bearer, sentinelCreds: user.sentinelCreds } : { creds: conn.creds };
    const revisions = await readOwnedChannelRevisions(conn.server, ledger.space, conn.tls, readAuth, ledger.created.channels);
    let members: Awaited<ReturnType<typeof ep.readMembership>> | undefined;
    let membershipWarning: string | null = null;
    try { members = await ep.readMembership(); }
    catch { membershipWarning = "The derived membership feed could not be read; channel observers and live readers are unknown."; }
    const ownedIds = new Set(ledger.created.agents.map((agent) => agent.id));
    const channels = revisions.map(({ name, revision }) => ({ name, observedRevision: revision, otherMembersObserved: members ? members.members.filter((row) => !ownedIds.has(row.id) && (row.durable.includes(name) || row.live.some((pattern) => subjectMatches(pattern, name)))).map((row) => row.id) : null }));
    return { managerPs: "answered" as const, agents, channels, channelRegistry: ledger.created.channels.length ? "scoped-native-read" as const : "no-owned-channels" as const, membershipFeed: members ? "display-only-observed" as const : "unavailable" as const, membershipObservedAt: members?.asOf ?? null, membershipWarning };
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the native manager or owned-channel registry read did not complete; no live absence or removal eligibility was inferred", { target: { space: ledger.space, deploymentId: ledger.runId } });
  } finally {
    try { await ep.stop(); }
    catch { throw new CommandFailure("failed", "OPERATION_FAILED", "the native preview reader did not confirm closure; no agent or channel was removed", { target: { space: ledger.space, deploymentId: ledger.runId } }); }
  }
}

async function previewRemove(deploymentId: string, values: TeamValues): Promise<void> {
  if (values["dry-run"] !== true) {
    // The original intent picks the route; each route revalidates its own returned receipt.
    let routed: ReturnType<typeof findAdditiveTeamAttempt>;
    try { routed = findAdditiveTeamAttempt(personaCatalog(values).root, deploymentId); }
    catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the additive attempt for this ID is unreadable; no removal route was inferred", { target: { deploymentId } }); }
    if (routed && !routed.requestedAgents.length && routed.declaredChannels.length) {
      const { removeChannelTeam } = await import("./team-channel-remove.js");
      return removeChannelTeam(deploymentId, values);
    }
    if (routed && routed.requestedAgents.length && routed.declaredChannels.length) {
      const { removeMixedTeam } = await import("./team-mixed-remove.js");
      return removeMixedTeam(deploymentId, values);
    }
    const { removeAgentTeam } = await import("./team-agent-remove.js");
    return removeAgentTeam(deploymentId, values);
  }
  const catalog = personaCatalog(values);
  recordOperationSpace(catalog.space);
  let summary: FreshTeamSummary | undefined;
  try { summary = findFreshTeamSummary(catalog.root, deploymentId); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the fresh launch summary for this ID is unreadable; it cannot be treated as absent or as an additive removal target", { target: { space: catalog.space, deploymentId } }); }
  if (summary) throw new CommandFailure("refused", "CONFLICT", "this ID belongs to a fresh boot summary, not an additive ownership ledger; team remove did not infer whole-stack stop authority", { target: { recordedSpace: summary.space, recordedRoot: summary.root, selectedSpace: catalog.space, deploymentId }, remedy: "from the recorded root, inspect cotal down --space <recorded-space> --dry-run; guarded bare down is not integrated in this source" });
  let freshAttempt: ReturnType<typeof findFreshTeamAttempt>;
  try { freshAttempt = findFreshTeamAttempt(catalog.root, deploymentId); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the fresh boot attempt for this ID is unreadable; it was not treated as an additive target", { target: { root: catalog.root, deploymentId } }); }
  if (freshAttempt) throw new CommandFailure("refused", "CONFLICT", "this ID belongs to a fresh boot attempt, not an additive removal target", { target: { root: catalog.root, deploymentId } });
  let attempt: ReturnType<typeof findAdditiveTeamAttempt>;
  try { attempt = findAdditiveTeamAttempt(catalog.root, deploymentId); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the additive attempt for this ID is unreadable; no safe removal target was inferred", { target: { root: catalog.root, deploymentId } }); }
  if (attempt) {
    let inventory: ReturnType<typeof listAdditiveTeamAttempts>;
    try { inventory = listAdditiveTeamAttempts(catalog.root); }
    catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the additive attempt steps and receipts could not be read; no removal scope was inferred", { target: { root: catalog.root, deploymentId } }); }
    const receipt = inventory.returned.find((row) => row.deploymentId === deploymentId);
    if (receipt) {
      if (attempt.space !== catalog.space) throw new CommandFailure("refused", "CONFLICT", "this returned additive deployment belongs to another selected space; it was not rebound", { target: { recordedSpace: attempt.space, selectedSpace: catalog.space, deploymentId } });
      if (receipt.kind === "additive-agent-receipt") {
        const { removeAgentTeam } = await import("./team-agent-remove.js");
        return removeAgentTeam(deploymentId, values);
      }
      if (receipt.kind === "additive-team-receipt") {
        const { removeMixedTeam } = await import("./team-mixed-remove.js");
        return removeMixedTeam(deploymentId, values);
      }
      if (receipt.kind !== "additive-channel-receipt") throw new CommandFailure("refused", "UNSUPPORTED", "the returned agent identities and any channel revisions are historical receipts; guarded team removal requires native incarnation, reader and retained-custody review", { target: { space: catalog.space, deploymentId }, remedy: "inspect team show <deployment-id> and the recorded exact manager before requesting a stop" });
      const { removeChannelTeam } = await import("./team-channel-remove.js");
      return removeChannelTeam(deploymentId, values);
    }
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this additive ID retains an unsettled attempt; team remove cannot infer which resources it created", { target: { root: catalog.root, deploymentId }, remedy: "inspect team show <deployment-id> and the original native target; no effect was retried or removed" });
  }
  let found: ReturnType<typeof findLedgerByRun>;
  try { found = findLedgerByRun(catalog.root, deploymentId); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "no readable additive ownership ledger matches this full ID in the selected root; no resources were touched", { target: { space: catalog.space, root: catalog.root, deploymentId }, remedy: "inspect the checkout and space that recorded the additive deployment" }); }
  if (found.ledger.space !== catalog.space) throw new CommandFailure("refused", "CONFLICT", "this additive ledger belongs to another space; it was not rebound", { target: { recordedSpace: found.ledger.space, selectedSpace: catalog.space, deploymentId } });
  let otherAttempts: ReturnType<typeof listAdditiveTeamAttempts>;
  try { otherAttempts = listAdditiveTeamAttempts(catalog.root); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the root's additive attempt inventory could not be read; no complete removal scope was inferred", { target: { root: catalog.root, deploymentId } }); }
  const native = await nativeRemovalImpact(catalog.root, found.ledger);
  const result = { ...recorded(catalog.root, found.ledger), kind: "additive-removal-preview" as const,
    dryRun: true, native, otherRetainedAttempts: otherAttempts.valid.map((row) => ({ deploymentId: row.deploymentId, space: row.space, server: brokerAddressForDisplay(row.server) ?? "not displayable" })), unreadableAttempts: otherAttempts.refused.map(({ path }) => path), authorization: "read-established-not-removal-authority", effectAttempted: false, persisted: false };
  writeResult(presentationOf(values), { command: "team remove", target: { space: result.space, root: result.root, deploymentId }, result,
    completeness: "partial", partial: { message: "Native manager PS, current channel revisions and a derived display-only membership read do not authorize stopping a lifecycle or removing a channel. The legacy ledger has no create revisions; exact ownership, authority and effect impact still need guarded apply checks." },
    warnings: [...(native.membershipWarning ? [{ code: "MEMBERSHIP_FEED_UNAVAILABLE", target: { space: result.space, deploymentId }, message: native.membershipWarning }] : []), ...(otherAttempts.valid.length || otherAttempts.refused.length ? [{ code: "ADDITIVE_ATTEMPT_REMAINS", target: { root: catalog.root, deploymentIds: otherAttempts.valid.map((row) => row.deploymentId), unreadable: otherAttempts.refused.map(({ path }) => path) }, message: "Other additive attempts remain in this root; their native effects were not attributed to this ledger." }] : [])] }, (data): Report => ({ sections: [
    { title: "Additive removal impact", blocks: [{ kind: "fields", rows: [["Deployment", data.deploymentId], ["Space", data.space], ["Recorded root", data.root], ["Source context", data.manifestPath], ["Manager PS", data.native.managerPs], ["Channel registry", data.native.channelRegistry], ["Other additive attempts", String(data.otherRetainedAttempts.length)], ["Unreadable attempts", String(data.unreadableAttempts.length)], ["Membership feed", data.native.membershipFeed], ["Feed observed at", data.native.membershipObservedAt === null ? "not available" : String(data.native.membershipObservedAt)], ["Removal authority", "not established"]] }, { kind: "lines", lines: [{ text: "Native PS is a snapshot; the derived membership feed is display-only, never an ACL or stop authority. No stop, channel removal or ledger write occurred.", tone: "waiting" }] }] },
    ...(data.otherRetainedAttempts.length || data.unreadableAttempts.length ? [{ title: "Other retained additive attempts", blocks: [{ kind: "lines" as const, lines: [...data.otherRetainedAttempts.slice(0, 100).map((row) => `${row.deploymentId} (${row.space})`), ...data.unreadableAttempts.slice(0, 100).map((path) => `Unreadable: ${path}`), ...(data.otherRetainedAttempts.length > 100 || data.unreadableAttempts.length > 100 ? ["Additional attempts are in JSON."] : []), "These attempts may have affected the same broker; they are not part of this ledger's owned scope."] }] }] : []),
    { title: "Ledger-owned agents against manager PS", blocks: [data.native.agents.length ? { kind: "table", columns: [{ key: "name", label: "Allocated" }, { key: "recorded", label: "Recorded identity" }, { key: "observed", label: "Observed identity" }, { key: "state", label: "Incarnation" }], rows: data.native.agents.slice(0, 100).map((agent) => ({ name: agent.name, recorded: agent.recordedId, observed: agent.observedId ?? "not seen", state: agent.state })) } : { kind: "lines", lines: ["No agent entries in this ledger."] }, ...(data.native.agents.length > 100 ? [{ kind: "lines" as const, lines: ["Additional agent observations are in JSON."] }] : [])] },
    { title: "Ledger-owned channels", blocks: [{ kind: "table", columns: [{ key: "name", label: "Channel" }, { key: "revision", label: "Current revision" }, { key: "members", label: "Other members observed" }], rows: data.native.channels.slice(0, 100).map((channel) => ({ name: `#${channel.name}`, revision: channel.observedRevision === null ? "not live" : String(channel.observedRevision), members: channel.otherMembersObserved === null ? "unknown" : String(channel.otherMembersObserved.length) })) }, ...(data.native.channels.length > 100 ? [{ kind: "lines" as const, lines: ["Additional channel observations are in JSON."] }] : []), { kind: "lines", lines: ["Current KV revisions are read-only snapshots. This ledger did not record create revisions, so matching a channel name does not authorize deleting its current card."] }] },
  ] }));
}

function accessGraph(prepared: PreparedManifest) {
  const declared = new Set(prepared.manifest.channels.map((channel) => channel.name));
  const names = new Set(declared);
  for (const agent of prepared.agents) {
    for (const channel of [...agent.policy.subscribe, ...agent.policy.allowSubscribe, ...agent.policy.allowPublish]) names.add(channel);
  }
  return [...names].sort().map((name) => ({
    name,
    source: declared.has(name) ? "manifest" as const : "persona-inherited" as const,
    subscribe: prepared.agents.filter((agent) => agent.policy.subscribe.includes(name)).map((agent) => agent.name),
    allowSubscribe: prepared.agents.filter((agent) => agent.policy.allowSubscribe.includes(name)).map((agent) => agent.name),
    allowPublish: prepared.agents.filter((agent) => agent.policy.allowPublish.includes(name)).map((agent) => agent.name),
  }));
}

function readTeamFile(file: string, values: TeamValues): { path: string; prepared: PreparedManifest } {
  const path = resolve(file);
  let prepared: PreparedManifest;
  try { prepared = loadManifest(path); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the team manifest or referenced persona could not be read and resolved; no broker was contacted", { target: { path }, remedy: "check the manifest schema, persona paths and permission declarations" }); }
  if (values.space !== undefined && values.space !== prepared.manifest.space) throw new CommandFailure("refused", "CONFLICT", "--space must agree with the manifest's recorded target; the file was not rebound");
  return { path, prepared };
}

async function bootTeam(file: string, values: TeamValues): Promise<void> {
  const { path, prepared } = readTeamFile(file, values), space = prepared.manifest.space;
  let local: ReturnType<typeof findMesh>, waiting: ReturnType<typeof findPreparedSpace>;
  try { local = findMesh(space); waiting = findPreparedSpace(space); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the selected local registration or prepared-space record could not be read; no boot root was chosen", { target: { space } }); }
  if (local && local.origin !== "up") throw new CommandFailure("refused", "CONFLICT", "a remote, discovered or hand-registered space cannot become an owned fresh local boot target", { target: { space } });
  if (!local && !waiting) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "prepare this space at an explicit local root before a fresh team boot; no current directory or machine home was guessed", { target: { space }, remedy: `cotal space create ${space} --root <project-directory>` });
  if (local && waiting && canonicalRoot(local.root) !== canonicalRoot(waiting.root)) throw new CommandFailure("refused", "CONFLICT", "the registered and prepared records disagree on this space's root; no stack was started", { target: { space } });
  const root = canonicalRoot(waiting?.root ?? local!.root);
  // The service controller owns the fresh boot: the same exact members, journal and stop route as
  // `cotal up`, with the manifest's launch carried by the stack's own manager member.
  const selected = preparedUpRoot(root), previous = process.cwd();
  process.chdir(selected);
  try {
    await controllerTeamBoot({ file: path, space, transport: recordedBrokerTransport(selected), foreground: values.foreground === true, presentation: presentationOf(values) });
  } finally { process.chdir(previous); }
}

async function previewBoot(file: string, values: TeamValues): Promise<void> {
  if (values["dry-run"] !== true) return bootTeam(file, values);
  const { path, prepared } = readTeamFile(file, values);
  const space = prepared.manifest.space;
  let local: ReturnType<typeof findMesh>, waiting: ReturnType<typeof findPreparedSpace>;
  try { local = findMesh(space); waiting = findPreparedSpace(space); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the local space registry or prepared-space records could not be read; no boot target was inferred", { target: { space } }); }
  if (local && local.origin !== "up") throw new CommandFailure("refused", "CONFLICT", "a remote, discovered or hand-registered space cannot become an owned local boot target", { target: { space } });
  if (local && waiting && canonicalRoot(local.root) !== canonicalRoot(waiting.root)) throw new CommandFailure("refused", "CONFLICT", "prepared and registered records disagree on this space's root; no boot target was chosen", { target: { space } });
  const root = waiting?.root ?? local?.root ?? process.cwd();
  let localState: { controlDir: "real" | "absent"; recordedSpaces: string[]; maintenance: string; possibleProcesses: string[]; managerRecord: { state: string; pid: number | null; path: string } | null };
  let serviceCensus: ReturnType<typeof readLocalServiceCensus>;
  let additiveRecords: ReturnType<typeof listLedgerFiles>, additiveAttempts: ReturnType<typeof listAdditiveTeamAttempts>;
  let bootAttempts: ReturnType<typeof listFreshTeamAttempts>;
  let bootSummaries: ReturnType<typeof listFreshTeamSummaries>;
  try {
    const controlDir = realDirNoSymlink(root, ".cotal") ? "real" as const : "absent" as const;
    if (controlDir === "real") assertSingleSpaceBroker(authDir(root), "team boot preview");
    const manager = controlDir === "real" ? managerRecordState(undefined, undefined, space, root) : null;
    localState = { controlDir, recordedSpaces: controlDir === "real" ? localMeshesForRoot(root).map((entry) => entry.space) : [],
      maintenance: controlDir === "real" ? readMaintenanceJournal(root)?.state ?? "none-recorded" : "not-checked",
      possibleProcesses: controlDir === "real" ? liveMeshProcesses(root, space) : [],
      managerRecord: manager ? { state: manager.state, pid: manager.pid ?? null, path: manager.path } : null };
    serviceCensus = readLocalServiceCensus(space);
    additiveRecords = controlDir === "real" ? listLedgerFiles(root, { requireReadable: true }) : { valid: [], refused: [] };
    additiveAttempts = controlDir === "real" ? listAdditiveTeamAttempts(root) : { valid: [], steps: [], agentSteps: [], returned: [], refused: [] };
    bootAttempts = controlDir === "real" ? listFreshTeamAttempts(root) : { valid: [], refused: [] };
    bootSummaries = controlDir === "real" ? listFreshTeamSummaries(root) : { valid: [], refused: [] };
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    throw new CommandFailure("refused", "CONFLICT", "the boot root's control directory, tenant inventory, maintenance state, additive ledgers, process records or selected-space service records could not be read safely; no startup eligibility was inferred", { target: { space, root } });
  }
  const openDurable = prepared.manifest.broker?.auth === false && (prepared.manifest.defaults?.deliveryClass === "durable" || prepared.manifest.channels.some((channel) => channel.deliveryClass === "durable"));
  const candidate = prepared.manifest.broker?.host && !prepared.manifest.broker?.servers ? null : prepared.manifest.broker?.servers ?? DEFAULT_SERVER;
  let otherBrokerRegistrations: Array<{ space: string; root: string; origin: string }> | null = null;
  if (candidate) {
    try { otherBrokerRegistrations = loadMeshes().filter((row) => row.space !== space && row.server === candidate).map((row) => ({ space: row.space, root: row.root, origin: row.origin ?? "not recorded" })); }
    catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the local broker registration list could not be read; an exact-address sharing snapshot was not inferred", { target: { space, root } }); }
  }
  let brokerProbe: "credless-broker-response" | "no-credless-response" | "probe-failed" | "not-checked" = "not-checked";
  if (candidate) {
    try { brokerProbe = await isReachable(candidate) ? "credless-broker-response" : "no-credless-response"; }
    catch { brokerProbe = "probe-failed"; }
  }
  const result = { kind: "fresh-team-boot-preview", dryRun: true, path, space, root,
    rootSource: waiting ? "prepared-local-record" : local ? "local-up-registration" : "invoking-folder-unprepared",
    localState, serviceCensus,
    additiveLedgers: additiveRecords.valid.map(({ ledger }) => ({ deploymentId: ledger.runId, space: ledger.space, agents: ledger.created.agents.length, channels: ledger.created.channels.length })),
    unreadableAdditiveLedgers: additiveRecords.refused.map(({ path }) => path),
    additiveAttempts: additiveAttempts.valid.map((attempt) => ({ deploymentId: attempt.deploymentId, space: attempt.space, server: brokerAddressForDisplay(attempt.server) ?? "not displayable", createdAt: attempt.createdAt, recordedState: additiveTeamRecordedState(attempt, additiveAttempts) })),
    unreadableAdditiveAttempts: additiveAttempts.refused.map(({ path }) => path),
    bootAttempts: bootAttempts.valid.map((attempt) => ({ deploymentId: attempt.deploymentId, space: attempt.space, server: brokerAddressForDisplay(attempt.server) ?? "not displayable", createdAt: attempt.createdAt,
      matchedSummary: bootSummaries.valid.some((summary) => freshTeamAttemptSettled(attempt, summary)) })),
    unreadableBootRecords: [...bootAttempts.refused, ...bootSummaries.refused].map(({ path }) => path),
    additiveInventory: localState.controlDir === "real" ? "selected-root-local-ledgers" : "not-checked-no-control-directory",
    brokerCandidate: candidate ? brokerAddressForDisplay(candidate) ?? null : null, brokerProbe, otherBrokerRegistrations,
    brokerAddressScope: candidate ? "exact local registration matches only; aliases and live tenants not checked" : "host-derived at apply; exact local matches not checked",
    lifetimeRequest: values.foreground ? "terminal-bound" : "background",
    runtime: prepared.manifest.runtime ?? "pty",
    authMode: prepared.manifest.broker?.auth === false ? "open" : prepared.manifest.broker?.auth === "user" ? "user" : "static",
    agents: prepared.agents.map((agent) => ({ name: agent.name, application: agent.agentType, role: agent.role ?? null, requestedModel: agent.model ?? null })),
    channels: prepared.manifest.channels.map((channel) => ({ name: channel.name, deliveryClass: channel.deliveryClass ?? null, replay: channel.replay ?? null, replayWindow: channel.replayWindow ?? null })),
    nativePreflight: "local-read-and-credless-probe-only", openDurableUnsupported: openDurable, effectAttempted: false, persisted: false };
  writeResult(presentationOf(values), { command: "team boot", target: { space, root, path }, result, completeness: "partial", partial: { message: "Local process, additive ledger and selected-space service records, any exact-address registration matches and a credless broker probe were read, but broker exclusivity, service root ownership, native attempt settlement, bind authority, credentials, provider availability and startup readiness have not been checked.", remedy: waiting || local ? "inspect the selected local root and native startup guards before a future apply" : "prepare this folder explicitly with cotal space create <space> --root . before a future apply" }, warnings: [...prepared.warnings.map((warning) => ({ code: "MANIFEST_WARNING", target: { agent: warning.agent }, message: warning.message })), ...(openDurable ? [{ code: "OPEN_DURABLE_UNSUPPORTED", target: { space }, message: "The open manifest declares durable delivery, but its broker has no delivery daemon; fresh apply refuses before writing." }] : []), ...(otherBrokerRegistrations?.length ? [{ code: "BROKER_ADDRESS_SHARED", target: { space, root, otherSpaces: otherBrokerRegistrations.map((row) => row.space) }, message: "Other local registrations name this exact broker address; fresh apply refuses rather than binding over their recorded target." }] : []), ...(additiveRecords.valid.length || additiveRecords.refused.length ? [{ code: "ADDITIVE_OWNERSHIP_REMAINS", target: { space, root, deploymentIds: additiveRecords.valid.map(({ ledger }) => ledger.runId), unreadable: additiveRecords.refused.map(({ path }) => path) }, message: "Additive ledgers remain under this boot root. Fresh apply refuses until their lifecycle is resolved; unreadable ledgers are not absence." }] : []), ...(additiveAttempts.valid.length || additiveAttempts.refused.length ? [{ code: "ADDITIVE_ATTEMPT_REMAINS", target: { space, root, deploymentIds: additiveAttempts.valid.map((attempt) => attempt.deploymentId), unreadable: additiveAttempts.refused.map(({ path }) => path) }, message: "An additive intent is retained under this boot root. Fresh apply cannot infer its native outcome and refuses." }] : [])] }, (data): Report => ({ sections: [
    { title: "Fresh team local impact", blocks: [{ kind: "fields", rows: [["Space", data.space], ["Local root", data.root], ["Root source", data.rootSource], ["Control directory", data.localState.controlDir], ["Other locally recorded spaces", data.localState.recordedSpaces.join(", ") || "none"], ["Maintenance", data.localState.maintenance], ["Manager record", data.localState.managerRecord ? `${data.localState.managerRecord.state}${data.localState.managerRecord.pid === null ? "" : ` (pid ${data.localState.managerRecord.pid})`}` : "not checked"], ["Possibly live recorded processes", data.localState.possibleProcesses.join(", ") || "none found"], ["Broker candidate", data.brokerCandidate ?? "host-derived at apply; not probed"], ["Credless broker probe", data.brokerProbe], ["Other exact-address registrations", data.otherBrokerRegistrations === null ? "not checked" : String(data.otherBrokerRegistrations.length)], ["Manifest", data.path], ["Runtime request", data.runtime], ["Lifetime request", data.lifetimeRequest], ["Auth mode request", data.authMode], ["Durable delivery on open", data.openDurableUnsupported ? "unsupported at apply" : "not a contradiction"], ["Agents requested", String(data.agents.length)], ["Channels declared", String(data.channels.length)], ["Saved service definitions", String(data.serviceCensus.serviceDefinitions.length)], ["Saved service instances", String(data.serviceCensus.serviceRecords.length)], ["Supervisor receipts", String(data.serviceCensus.supervisors.length)], ["Retained native attempts", String(data.serviceCensus.nativeAttempts.length)], ["Additive ledgers", data.additiveInventory === "selected-root-local-ledgers" ? String(data.additiveLedgers.length) : "not checked"], ["Unreadable additive ledgers", data.additiveInventory === "selected-root-local-ledgers" ? String(data.unreadableAdditiveLedgers.length) : "not checked"], ["Additive attempts", data.additiveInventory === "selected-root-local-ledgers" ? String(data.additiveAttempts.length) : "not checked"], ["Unreadable additive attempts", data.additiveInventory === "selected-root-local-ledgers" ? String(data.unreadableAdditiveAttempts.length) : "not checked"], ["Fresh boot attempts", data.additiveInventory === "selected-root-local-ledgers" ? String(data.bootAttempts.length) : "not checked"], ["Unsettled fresh attempts", data.additiveInventory === "selected-root-local-ledgers" ? String(data.bootAttempts.filter((attempt) => !attempt.matchedSummary).length) : "not checked"], ["Unreadable fresh records", data.additiveInventory === "selected-root-local-ledgers" ? String(data.unreadableBootRecords.length) : "not checked"]] }, { kind: "lines", lines: [{ text: "A dead manager PID record remains visible here even when the possibly-live list omits it. Neither that record nor a credless probe proves safe reuse, broker absence on a TLS-first address, or authority to stop a leftover process. Bind authority, credentials, provider readiness and startup ownership remain unproved. No process or native resource was started.", tone: "waiting" }] }] },
    { title: "Recorded additive deployments", blocks: [data.additiveLedgers.length ? { kind: "table", columns: [{ key: "id", label: "Deployment" }, { key: "space", label: "Recorded space" }, { key: "agents", label: "Agent rows" }, { key: "channels", label: "Channel rows" }], rows: data.additiveLedgers.slice(0, 100).map((row) => ({ id: row.deploymentId, space: row.space, agents: String(row.agents), channels: String(row.channels) })) } : { kind: "lines", lines: [data.additiveInventory === "selected-root-local-ledgers" ? "No readable additive deployment ledgers in this root." : "The unprepared root has no control directory; additive ownership was not checked."] }, { kind: "lines", lines: [...(data.additiveLedgers.length > 100 ? ["Additional additive ledgers are in JSON."] : []), ...data.unreadableAdditiveLedgers.slice(0, 100).map((path) => `Unreadable ledger: ${path}`), ...(data.unreadableAdditiveLedgers.length > 100 ? ["Additional unreadable ledger paths are in JSON."] : []), "A recorded or unreadable additive ledger blocks fresh apply. The preview neither adopts nor tears down its resources."] }] },
    { title: "Retained additive deployments", blocks: [data.additiveAttempts.length ? { kind: "table", columns: [{ key: "id", label: "Deployment" }, { key: "space", label: "Space" }, { key: "state", label: "Recorded state" }], rows: data.additiveAttempts.slice(0, 100).map((attempt) => ({ id: attempt.deploymentId, space: attempt.space, state: attempt.recordedState })) } : { kind: "lines", lines: ["No readable additive attempts in this root."] }, { kind: "lines", lines: [...data.unreadableAdditiveAttempts.slice(0, 100).map((path) => `Unreadable additive attempt: ${path}`), ...(data.additiveAttempts.length > 100 || data.unreadableAdditiveAttempts.length > 100 ? ["Additional attempts or paths are in JSON."] : []), "An unsettled or unremoved additive deployment blocks a fresh boot. A complete matched removal receipt (static agent retirement or channel card deletion) releases only that known blocker; other service, broker and process custody is still checked."] }] },
    { title: "Fresh boot attempts", blocks: [data.bootAttempts.length ? { kind: "table", columns: [{ key: "id", label: "Deployment" }, { key: "space", label: "Space" }, { key: "summary", label: "Returned summary" }], rows: data.bootAttempts.slice(0, 100).map((attempt) => ({ id: attempt.deploymentId, space: attempt.space, summary: attempt.matchedSummary ? "matched" : "unsettled" })) } : { kind: "lines", lines: ["No readable fresh boot attempts under this root."] }, { kind: "lines", lines: [...(data.bootAttempts.length > 100 ? ["Additional attempts are in JSON."] : []), ...data.unreadableBootRecords.slice(0, 100).map((path) => `Unreadable fresh record: ${path}`), ...(data.unreadableBootRecords.length > 100 ? ["Additional unreadable paths are in JSON."] : []), "An unsettled attempt or unreadable fresh record blocks a new boot. Even a matched summary is not current broker or agent liveness."] }] },
    { title: "Recorded broker address matches", blocks: [data.otherBrokerRegistrations === null ? { kind: "lines", lines: ["Broker address is host-derived at apply; exact local registrations were not compared."] } : data.otherBrokerRegistrations.length ? { kind: "table", columns: [{ key: "space", label: "Other space" }, { key: "root", label: "Recorded root" }, { key: "origin", label: "Registration" }], rows: data.otherBrokerRegistrations.slice(0, 100) } : { kind: "lines", lines: ["No other registration uses this exact candidate address in the local workstation registry."] }, { kind: "lines", lines: [...((data.otherBrokerRegistrations?.length ?? 0) > 100 ? ["Additional exact-address matches are in JSON."] : []), "A match blocks fresh apply. No match does not prove an exclusive broker: address aliases, remote tenants and live attachments were not checked."] }] },
    { title: "Selected-space service records", blocks: [data.serviceCensus.serviceRecords.length ? { kind: "table", columns: [{ key: "definition", label: "Definition" }, { key: "instance", label: "Full instance" }, { key: "state", label: "Recorded state" }], rows: data.serviceCensus.serviceRecords.slice(0, 100).map((row) => ({ definition: row.definition, instance: row.instanceId, state: row.recordedState })) } : { kind: "lines", lines: ["No service instance records in this space's workstation store."] }, { kind: "lines", lines: [...(data.serviceCensus.serviceRecords.length > 100 ? ["Additional instance records are in JSON."] : []), "Definitions and supervisor receipts are also in JSON. These space-scoped records are not attributed to this boot root or established as live; a future apply must recheck them before writing."] }] },
    { title: "Retained native attempts", blocks: [data.serviceCensus.nativeAttempts.length ? { kind: "table", columns: [{ key: "kind", label: "Action" }, { key: "instance", label: "Full instance" }, { key: "step", label: "Step" }, { key: "position", label: "Position" }], rows: data.serviceCensus.nativeAttempts.slice(0, 100).map((row) => ({ kind: row.kind, instance: row.instanceId, step: row.step, position: row.position })) } : { kind: "lines", lines: ["No retained native attempts in this space's workstation store."] }, ...(data.serviceCensus.nativeAttempts.length > 100 ? [{ kind: "lines" as const, lines: ["Additional attempts are in JSON."] }] : [])] },
    { title: "Requested agents", blocks: [data.agents.length ? { kind: "table", columns: [{ key: "name", label: "Name" }, { key: "application", label: "Application" }, { key: "role", label: "Role" }, { key: "model", label: "Model request" }], rows: data.agents.slice(0, 100).map((agent) => ({ name: agent.name, application: agent.application, role: agent.role ?? "none", model: agent.requestedModel ?? "application default" })) } : { kind: "lines", lines: ["No agents requested."] }, ...(data.agents.length > 100 ? [{ kind: "lines" as const, lines: ["Additional requested agents are in JSON."] }] : [])] },
    { title: "Declared channels", blocks: [data.channels.length ? { kind: "table", columns: [{ key: "name", label: "Channel" }, { key: "delivery", label: "Delivery class" }, { key: "replay", label: "Replay" }, { key: "window", label: "Replay window" }], rows: data.channels.slice(0, 100).map((channel) => ({ name: `#${channel.name}`, delivery: channel.deliveryClass ?? "not declared", replay: channel.replay === null ? "not declared" : channel.replay ? "on" : "off", window: channel.replayWindow ?? "not declared" })) } : { kind: "lines", lines: ["No channels declared."] }, { kind: "lines", lines: [...(data.channels.length > 100 ? ["Additional channels are in JSON."] : []), "Only declared values are shown. The preview does not read saved channel metadata or infer final effective policy."] }] },
  ] }));
}

async function checkTeam(file: string, values: TeamValues): Promise<void> {
  const { path, prepared } = readTeamFile(file, values);
  const openDurable = prepared.manifest.broker?.auth === false && (prepared.manifest.defaults?.deliveryClass === "durable" || prepared.manifest.channels.some((channel) => channel.deliveryClass === "durable"));
  const result = { kind: "team-check", file: path, space: prepared.manifest.space, runtime: prepared.manifest.runtime ?? "pty",
    agents: prepared.agents.map((agent) => ({ name: agent.name, harness: agent.agentType, role: agent.role ?? null, model: agent.model ?? null, policy: agent.policy, inherited: agent.inherited, capabilities: agent.capabilities, capabilitySource: agent.capabilitySource })),
    channels: prepared.manifest.channels.map((channel) => ({ name: channel.name, subscribe: channel.subscribe, allowSubscribe: channel.allowSubscribe, allowPublish: channel.allowPublish,
      deliveryClass: channel.deliveryClass ?? null, replay: channel.replay ?? null, replayWindow: channel.replayWindow ?? null })),
    graph: values.graph ? accessGraph(prepared) : null,
  };
  writeResult(presentationOf(values), { command: "team", target: { space: result.space, path }, result: { ...result, openDurableUnsupported: openDurable }, warnings: [...prepared.warnings.map((warning) => ({ code: "MANIFEST_WARNING", target: { agent: warning.agent }, message: warning.message })), ...(openDurable ? [{ code: "OPEN_DURABLE_UNSUPPORTED", target: { space: result.space }, message: "This open manifest explicitly declares durable delivery, but open mode has no delivery daemon; fresh apply refuses before effects." }] : [])] }, (data): Report => ({ sections: [
    { title: "Team manifest resolved", blocks: [{ kind: "fields", rows: [["File", data.file], ["Space", data.space], ["Runtime", data.runtime], ["Agents", String(data.agents.length)], ["Channels", String(data.channels.length)], ["Durable delivery on open", data.openDurableUnsupported ? "unsupported at fresh apply" : "not a contradiction"]] }, { kind: "table", columns: [{ key: "name", label: "Agent" }, { key: "harness", label: "Application" }, { key: "role", label: "Role" }, { key: "model", label: "Declared model" }], rows: data.agents.slice(0, 100).map((agent) => ({ name: agent.name, harness: agent.harness, role: agent.role ?? "none", model: agent.model ?? "application default" })) }, ...(data.agents.length > 100 ? [{ kind: "lines" as const, lines: ["Additional resolved agents are in JSON."] }] : []), { kind: "lines", lines: [{ text: "File and persona resolution only. No broker, runtime availability, grants, reservations or launch readiness were checked. Persona bodies and kickoff prompts are not printed.", tone: "hint" }] }] },
    { title: "Declared channel policy", blocks: [data.channels.length ? { kind: "table", columns: [{ key: "name", label: "Channel" }, { key: "delivery", label: "Delivery class" }, { key: "replay", label: "Replay" }, { key: "window", label: "Replay window" }], rows: data.channels.slice(0, 100).map((channel) => ({ name: `#${channel.name}`, delivery: channel.deliveryClass ?? "not declared", replay: channel.replay === null ? "not declared" : channel.replay ? "on" : "off", window: channel.replayWindow ?? "not declared" })) } : { kind: "lines", lines: ["No channels declared."] }, { kind: "lines", lines: [...(data.channels.length > 100 ? ["Additional channel policies are in JSON."] : []), "Only manifest-declared values are shown. An absent field may inherit saved registry metadata at boot; this offline check does not read the broker."] }] },
    ...(values.graph ? [
      { title: "Effective channel access", blocks: [{ kind: "table" as const, columns: [{ key: "channel", label: "Channel" }, { key: "source", label: "Source" }, { key: "listen", label: "Initially listening" }, { key: "read", label: "May read" }, { key: "post", label: "May post" }], rows: (data.graph ?? []).slice(0, 100).map((channel) => ({ channel: `#${channel.name}`, source: channel.source, listen: channel.subscribe.join(", ") || "none", read: channel.allowSubscribe.join(", ") || "none", post: channel.allowPublish.join(", ") || "none" })) }, { kind: "lines" as const, lines: [...((data.graph?.length ?? 0) > 100 ? ["Additional access edges are in JSON."] : []), "Persona-inherited channels have no manifest card. These are resolved access intentions, not registered channels, observed membership or live grants."] }] },
      { title: "Agent capability intent", blocks: [data.agents.length ? { kind: "table" as const, columns: [{ key: "agent", label: "Agent" }, { key: "role", label: "Role" }, { key: "capabilities", label: "Capabilities" }, { key: "source", label: "Source" }], rows: data.agents.slice(0, 100).map((agent) => ({ agent: agent.name, role: agent.role ?? "none", capabilities: agent.capabilities.join(", ") || "none", source: agent.capabilitySource })) } : { kind: "lines" as const, lines: ["No agents declared."] }, { kind: "lines" as const, lines: [...(data.agents.length > 100 ? ["Additional capability intentions are in JSON."] : []), "A role or capability in a resolved manifest is not an issued credential. No broker, provider or grant was contacted."] }] },
    ] : []),
  ] }));
}
