/** Controller-owned fresh team boot. It starts a complete stopped local environment through the
 *  same service controller as `cotal up`, with the manifest's channels seeded through the native
 *  broker path and its agents launched by the stack's own manager member from one pinned launch
 *  spec. It writes the existing fresh-boot attempt and summary records, never an additive ledger:
 *  stop authority stays with the stack journal and `cotal down`. Every input is frozen before the
 *  first effect; a failure after it keeps what started and is reported as partial or unknown, and
 *  nothing is replayed. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveAuthProvider, type BrokerTransport } from "@cotal-ai/core";
import {
  CommandFailure, acquireMaintenanceLock, getCurrent, isCommandFailure, readMaintenanceJournal, releaseMaintenanceLock,
  workspaceSecretStore, writeResult, type Report,
} from "@cotal-ai/workspace";
import { buildLaunchSpec, genRunId, manifestToChannels, writeLaunchSpec } from "../lib/manifest/apply.js";
import { observeServiceProcess, serviceInstances } from "../lib/service-instances.js";
import { readStackJournal, STACK_DEFINITION, type StackJournal } from "../lib/stack-journal.js";
import { writeFreshTeamAttempt, writeFreshTeamSummary } from "../lib/team-fresh.js";
import { startControllerStack, stackMembersView, stackUpForegroundNotice } from "./stack-up.js";
import { assertUserStackTransport, preflightUserStack, userLoginRequired, userLoginState } from "./stack-user-auth.js";
import { controllerStackNative, holdForegroundStack, prepareFreshTeamBoot, prepareResumeTeamBoot, recheckFreshTeamBoot, type FreshTeamBootPlan } from "./up.js";
import { recheckStackResume, stackResumeEligibility, type StackResumeBinding } from "../lib/stack-resume.js";

export interface ControllerTeamBootRequest {
  file: string;
  space: string;
  transport: BrokerTransport;
  foreground: boolean;
  presentation: "rich" | "json" | "plain";
}

/** The controller boot's receipt. Evidence fields are the members' own controller receipts; the
 *  launch summary keeps its existing meaning and is not stop or ownership authority. */
interface ControllerTeamBootResult {
  kind: "fresh-team-boot";
  route: "service-controller" | "service-controller-resume";
  /** The completed whole-stack stop this boot resumed, when it resumed one. */
  resumedStopped: { operation: string; members: { role: string; instanceId: string; evidence: string }[] } | null;
  space: string;
  root: string;
  deploymentId: string;
  server: string;
  mode: "open" | "static-auth" | "user-auth";
  manifestPath: string;
  runtime: string;
  launchSpec: { path: string; sha256: string } | null;
  operation: StackJournal["operation"];
  members: StackJournal["members"];
  summaryRecorded: boolean;
  requestedAgents: { name: string; application: string; role: string | null }[];
  declaredChannels: string[];
  agentReadiness: "not-checked";
  foreground: boolean;
  currentSelection: string | null;
}

const MODE_LABEL = { open: "open", auth: "static-auth", user: "user-auth" } as const;

/** The members' own evidence projected onto the existing summary fields. Readiness of each member is
 *  its controller receipt: delivery reports ready only after its `ctl.delivery` responder is bound. */
function summaryEvidence(journal: StackJournal): { controlPlaneReturned: boolean; authServiceReturned: boolean; deliveryResponderBound: boolean | null; brokerPid: number | undefined } {
  const member = (role: StackJournal["members"][number]["role"]) => journal.members.find((row) => row.role === role)!;
  const up = (role: StackJournal["members"][number]["role"]) => ["started", "reused"].includes(member(role).state);
  const brokerId = member("broker").instanceId;
  const broker = brokerId ? serviceInstances(journal.space, STACK_DEFINITION.broker).find((row) => row.name === brokerId) : undefined;
  return {
    controlPlaneReturned: up("manager"),
    authServiceReturned: journal.mode === "user" ? up("auth") : true,
    deliveryResponderBound: journal.mode === "open" ? null : up("delivery"),
    brokerPid: broker && observeServiceProcess(broker.record.value) === "running" ? broker.record.value.process?.pid : undefined,
  };
}

function bootView(data: ControllerTeamBootResult, journal: StackJournal): Report {
  const members = stackMembersView({ ...journal, members: data.members }, "Controller stack members");
  return { sections: [
    { title: "Fresh team boot started", blocks: [{ kind: "fields", rows: [["Space", data.space], ["Deployment", data.deploymentId], ["Root", data.root], ["Broker", data.server], ["Manifest", data.manifestPath], ["Auth mode", data.mode], ["Runtime request", data.runtime], ["Launch spec", data.launchSpec ? `${data.launchSpec.path} (sha256 ${data.launchSpec.sha256.slice(0, 12)}…)` : "not written"], ["Launch summary", data.summaryRecorded ? "recorded" : "not recorded"], ["Lifetime", data.foreground ? "this terminal" : "background"], ["Agent readiness", "not checked"]] }, { kind: "lines", lines: ["The stack's own manager member was started with this exact pinned launch spec. Manager readiness proves the manager, not that each requested agent joined. The launch summary is not stop authority; stop the stack with cotal down."] }] },
    ...members.sections,
    { title: "Requested topology", blocks: [data.requestedAgents.length ? { kind: "table", columns: [{ key: "name", label: "Agent" }, { key: "application", label: "Application" }, { key: "role", label: "Role" }], rows: data.requestedAgents.slice(0, 100).map((agent) => ({ ...agent, role: agent.role ?? "none" })) } : { kind: "lines", lines: ["No agents requested."] }, { kind: "lines", lines: data.declaredChannels.length ? data.declaredChannels.slice(0, 100).map((name) => `declared #${name}`) : ["No channels declared."] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: `cotal team show ${data.deploymentId}`, description: "Read this local launch summary" }, { command: `cotal ps --space ${data.space}`, description: "List the agents the manager reports" }, { command: `cotal down --space ${data.space} --dry-run`, description: "Preview the guarded whole-stack stop" }] }] },
  ] };
}

/** Boot a manifest as a fresh controller stack. The caller has made the prepared root the cwd. */
export async function controllerTeamBoot(request: ControllerTeamBootRequest): Promise<void> {
  // Freeze every input before the first effect. A root without a stack journal takes the fresh
  // route. A root whose journal records a completed stop with a never-attempted manager resumes
  // that exact stack; every other recorded stack refuses with its exact reason. Nothing is written.
  const recorded = readStackJournal(process.cwd())?.journal;
  let binding: StackResumeBinding | undefined;
  let plan: FreshTeamBootPlan;
  if (!recorded) plan = await prepareFreshTeamBoot(request.file, { space: request.space, transport: request.transport });
  else {
    binding = stackResumeEligibility(recorded.root, request.space, { server: recorded.server, mode: recorded.mode });
    plan = await prepareResumeTeamBoot(request.file, { space: request.space, transport: request.transport, recorded: { server: binding.server, mode: binding.mode, ...(binding.broker.host ? { host: binding.broker.host } : {}) } });
  }
  if (plan.prepared.agents.length === 0 && plan.prepared.manifest.channels.length === 0)
    throw new CommandFailure("refused", "USAGE_INVALID", "this manifest declares no agents and no channels; a fresh team boot has nothing to start beyond an ordinary stack", { target: { space: plan.space }, remedy: "use cotal up for a stack without a team" });
  // A user-auth boot checks its transport and the provider's IdP inputs before the maintenance lock,
  // the fresh intent, trust or any journal exists. Preparation repeats them authoritatively.
  if (plan.mode === "user") {
    assertUserStackTransport(plan.server, plan.transport.kind === "tls-required");
    await preflightUserStack(plan.root, plan.space, plan.idp);
    // The manifest's agents launch from the manager, which a user stack reads and starts only as the
    // invoking user's existing signed-in, granted login. Without it the boot could start everything
    // except the team and leave its intent unsettled, so it refuses here before any effect.
    const login = await userLoginState(plan.root, plan.space);
    if (login.state !== "ready") {
      // A fresh root cannot hold a login grant before its first enable, so the refusal names the
      // whole native preparation path rather than login alone.
      if (!binding) throw new CommandFailure("refused", "AUTH_REQUIRED", "a user-auth team boot needs a prepared space with your granted login, and this root has none yet; nothing was written", { target: { root: plan.root, space: plan.space }, remedy: `cotal up --user-auth --idp <auth base URL>, then cotal login, then cotal auth grant cli --sub <subject>, then cotal down, then cotal team boot ${request.file}` });
      throw userLoginRequired(plan.space, login);
    }
  }
  if (readMaintenanceJournal(plan.root)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this root retains a maintenance or recovery attempt; team boot cannot substitute an ordinary startup", { target: { root: plan.root, space: plan.space } });
  const lock = acquireMaintenanceLock(plan.root);
  let result!: ControllerTeamBootResult;
  let journal!: StackJournal;
  try {
    if (binding) recheckStackResume(binding); else await recheckFreshTeamBoot(plan);
    const deploymentId = genRunId();
    try { writeFreshTeamAttempt(plan.root, { schemaVersion: 1, kind: "fresh-team-attempt", deploymentId, space: plan.space, root: plan.root, server: plan.server, authMode: plan.mode, manifestPath: plan.manifestPath, createdAt: new Date().toISOString() }); }
    catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "fresh boot intent creation or its durability did not confirm; no trust preparation, launch spec or listener was requested", { target: { space: plan.space, deploymentId, root: plan.root }, remedy: "inspect the exact intent path before deciding whether any further boot can be attempted" }); }
    if (binding) recheckStackResume(binding, deploymentId); else await recheckFreshTeamBoot(plan, { deploymentId });
    const started = await startControllerStack({
      root: plan.root, space: plan.space, server: plan.server, transport: plan.transport, runtime: plan.runtime, noManager: false, mode: plan.mode,
      ...(plan.idp !== undefined ? { idp: plan.idp } : {}), ...(plan.host ? { host: plan.host } : {}), ...(plan.maxSessions !== undefined ? { maxSessions: plan.maxSessions } : {}),
      foreground: request.foreground, presentation: request.presentation,
      ...(binding ? { expectPriorDown: { journalSha256: binding.journalSha256, operationId: binding.priorDown } } : {}),
      manifest: {
        deploymentId,
        seed: manifestToChannels(plan.prepared),
        // Called once, after broker preparation and before the manager member is defined. A user
        // owner is the invoking user's own login over the provider state that preparation created.
        async launchSpec({ root, space, server, mode, user }) {
          if (root !== plan.root || space !== plan.space || server !== plan.server || mode !== plan.mode) throw new CommandFailure("refused", "CONFLICT", "the stack's prepared target differs from the frozen boot plan; no launch spec was written", { target: { space, deploymentId } });
          let owner: string | undefined;
          if (mode === "user") {
            if (!user) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a user-auth team boot needs this call's own provider preparation to resolve the invoking user; no launch spec was written", { target: { space, deploymentId } });
            try { owner = await resolveAuthProvider().ownerForLogin({ store: workspaceSecretStore(root), dir: user.stateDir, space }); }
            catch (error) { throw new CommandFailure("refused", "AUTH_REQUIRED", "the invoking user's login could not resolve an owner for this space; no launch spec was written and the manager was not started", { target: { space, deploymentId }, native: { code: "OWNER_FOR_LOGIN", outcome: "refused", detail: (error as Error).message }, remedy: "cotal login, then inspect the stack before another boot" }); }
          }
          let path: string;
          try { path = writeLaunchSpec(root, buildLaunchSpec(plan.prepared, deploymentId, owner)); }
          catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "launch-spec creation did not confirm its outcome; the manager was not started and the intent remains for inspection", { target: { space, deploymentId } }); }
          return { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
        },
      },
    }, controllerStackNative());
    journal = started.journal;
    const evidence = summaryEvidence(journal);
    let summaryRecorded = false;
    try {
      writeFreshTeamSummary(plan.root, {
        schemaVersion: 1, kind: "fresh-team-summary", deploymentId, space: plan.space, root: plan.root, server: plan.server, authMode: plan.mode,
        ...(evidence.brokerPid !== undefined ? { brokerPid: evidence.brokerPid } : {}), manifestPath: plan.manifestPath,
        requestedAgents: plan.prepared.agents.map((agent) => agent.name), declaredChannels: plan.prepared.manifest.channels.map((channel) => channel.name),
        recordedAt: new Date().toISOString(), managerRequested: true,
        controlPlaneReturned: evidence.controlPlaneReturned, authServiceReturned: evidence.authServiceReturned, deliveryResponderBound: evidence.deliveryResponderBound,
        agentReadiness: "not-checked",
      });
      summaryRecorded = true;
    } catch { /* Reported below as a partial outcome; the started members stand and nothing is retried. */ }
    let currentSelection: string | null = null;
    try { currentSelection = getCurrent() ?? null; } catch { /* Not checked; no default is inferred. */ }
    result = {
      kind: "fresh-team-boot", route: binding ? "service-controller-resume" : "service-controller", resumedStopped: binding ? { operation: binding.priorDown, members: binding.members.map((member) => ({ role: member.role, instanceId: member.instanceId, evidence: member.evidence })) } : null, space: plan.space, root: plan.root, deploymentId, server: plan.server, mode: MODE_LABEL[plan.mode],
      manifestPath: plan.manifestPath, runtime: plan.runtime, launchSpec: started.launch ?? null, operation: journal.operation, members: journal.members, summaryRecorded,
      requestedAgents: plan.prepared.agents.map((agent) => ({ name: agent.name, application: agent.agentType, role: agent.role ?? null })),
      declaredChannels: plan.prepared.manifest.channels.map((channel) => channel.name), agentReadiness: "not-checked", foreground: request.foreground, currentSelection,
    };
    if (!summaryRecorded) throw new CommandFailure("partial", "OPERATION_PARTIAL", "every stack member started, but the fresh launch summary was not recorded; the boot was not repeated", { target: { space: plan.space, deploymentId, members: journal.members }, changed: [{ kind: "controller-stack-started", operation: journal.operation.id }, ...(started.launch ? [{ kind: "launch-spec-written", path: started.launch.path }] : [])], remedy: "inspect cotal team show and cotal down --dry-run; do not repeat the boot to recreate the summary" });
  } catch (error) {
    // Partial and unknown startup keeps the retained attempt with no summary: never adopted as
    // settled, never replayed. A stack journal, when one was written, names the exact members.
    throw isCommandFailure(error) ? error : new CommandFailure("unknown", "OPERATION_UNKNOWN", "the fresh controller team boot did not confirm its outcome; its retained intent and any started members were kept", { target: { space: plan.space, root: plan.root } });
  } finally { releaseMaintenanceLock(lock); }
  if (request.foreground && request.presentation !== "json") stackUpForegroundNotice(request.presentation);
  writeResult(request.presentation, { command: "team boot", target: { space: result.space, root: result.root, deploymentId: result.deploymentId }, result, completeness: "partial", partial: { message: "Agent joins are not checked by this receipt." }, warnings: plan.prepared.warnings.map((warning) => ({ code: "MANIFEST_WARNING", target: { agent: warning.agent }, message: warning.message })) }, (data) => bootView(data, journal));
  if (request.foreground) await holdForegroundStack(plan.root);
}

