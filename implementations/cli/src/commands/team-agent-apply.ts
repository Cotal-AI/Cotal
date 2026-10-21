import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEV_OWNER, assertLifecycleToken, mintCreds, newIdentity, validateChannelConfig, type MeshLaunchSpec } from "@cotal-ai/core";
import { acquireMaintenanceLock, brokerAddressForDisplay, canonicalRoot, CommandFailure, connectOrThrow, findMesh, presentationOf, readMaintenanceJournal, releaseMaintenanceLock, writeResult, type Report } from "@cotal-ai/workspace";
import { askManager, managerFailure, resolveControlTarget } from "../lib/control.js";
import { buildLaunchSpec, cardOf, genRunId } from "../lib/manifest/apply.js";
import { hashManifestSource, listLedgerFiles } from "../lib/manifest/ledger.js";
import { loadManifest } from "../lib/manifest/index.js";
import { cotalRoot } from "../lib/paths.js";
import { additiveAgentRequestReceipt, listAdditiveTeamAttempts, retainedAdditiveTeamAttempts, writeAdditiveAgentReceipt, writeAdditiveAgentStep, writeAdditiveChannelStep, writeAdditiveTeamAttempt, type AdditiveAgentReceipt, type AdditiveChannelReceipt, type AdditiveTeamAttempt } from "../lib/team-additive-attempt.js";
import { openAdditiveChannelWriter } from "../lib/team-additive-native.js";
import { readOwnedChannelRevisions } from "../lib/team-deploy-inspection.js";
import { freshTeamAttemptSettled, listFreshTeamAttempts, listFreshTeamSummaries } from "../lib/team-fresh.js";
import { retainedTeamMatches } from "../lib/team-retained.js";
import { applyRetainedTeam } from "./team-deploy-apply.js";
import type { TeamValues } from "./team.js";

type CreatedAgent = AdditiveAgentReceipt["createdAgents"][number];

/** All-new agent deployment, optionally preceded by live channel creation. Channels and launches
 * retain separate native authority and steps under one intent; completed effects are not rolled back. */
export async function applyAgentTeam(file: string, values: TeamValues): Promise<void> {
  const path = resolve(file), root = canonicalRoot(cotalRoot());
  let prepared: ReturnType<typeof loadManifest>, source: string;
  try { prepared = loadManifest(path); source = readFileSync(path, "utf8"); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the team manifest and referenced personas could not be resolved; no agent launch was requested", { target: { root, path } }); }
  const { manifest } = prepared, space = manifest.space, target = { root, space, path };
  // A retained deployment of this exact manifest is verified, never re-created; a local read only.
  const retained = retainedTeamMatches(root, space, hashManifestSource(source));
  if (retained) return applyRetainedTeam(file, values, retained[0]!);
  if (!prepared.agents.length || prepared.agents.length > 100 || manifest.channels.length > 100 || manifest.defaults !== undefined || manifest.broker?.host !== undefined || values["allow-stale"] !== undefined) throw new CommandFailure("refused", "UNSUPPORTED", "this guarded team route accepts one to 100 all-new agents and at most 100 new live channel cards without default/bind changes or stale waivers; no field was dropped", { target });
  if (manifest.channels.some((channel) => channel.deliveryClass !== "live")) throw new CommandFailure("refused", "UNSUPPORTED", "mixed team creation needs explicit live delivery on every channel; inherited or durable delivery was not silently replaced", { target });
  try { for (const channel of manifest.channels) validateChannelConfig(cardOf(channel)); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "a declared channel card exceeds native policy or text limits; no channel or agent was created", { target }); }
  if (values.space !== undefined && values.space !== space) throw new CommandFailure("refused", "CONFLICT", "the selected space differs from this manifest; no target was substituted", { target });
  const selected = findMesh(space);
  if (!selected || canonicalRoot(selected.root) !== root || selected.server.includes(",")) throw new CommandFailure("refused", "CONFLICT", "team deployment needs one registered broker and this exact project root", { target });
  if (selected.mode === "user") throw new CommandFailure("refused", "UNSUPPORTED", "user-auth inline team launch needs its server-side pre-persistence owner boundary qualified first; no inline spec was submitted or broader caller substituted", { target });
  if (manifest.broker?.servers !== undefined && manifest.broker.servers !== selected.server || manifest.broker?.auth !== undefined && (manifest.broker.auth === false ? "open" : manifest.broker.auth === "user" ? "user" : "auth") !== selected.mode) throw new CommandFailure("refused", "CONFLICT", "the manifest broker or authentication mode differs from its registered target", { target });
  const runtime = values.runtime ?? manifest.runtime ?? "pty", manifestHash = hashManifestSource(source);
  const unchanged = () => {
    const current = findMesh(space);
    if (!current || JSON.stringify(current) !== JSON.stringify(selected) || readFileSync(path, "utf8") !== source || JSON.stringify(loadManifest(path)) !== JSON.stringify(prepared)) throw new CommandFailure("refused", "CONFLICT", "the registration, manifest or referenced persona changed; no later team effect was submitted", { target });
  };
  let lock: ReturnType<typeof acquireMaintenanceLock>;
  try { lock = acquireMaintenanceLock(root); }
  catch { throw new CommandFailure("refused", "CONFLICT", "the root maintenance lock could not be acquired; no team effect was submitted", { target }); }
  let attempt: AdditiveTeamAttempt | undefined, spec: MeshLaunchSpec | undefined;
  let writer: Awaited<ReturnType<typeof openAdditiveChannelWriter>> | undefined;
  let failure: CommandFailure | undefined, intentPublished = false, returned = false, writerCloseUnconfirmed = false;
  const created: CreatedAgent[] = [], createdChannels: AdditiveChannelReceipt["createdChannels"] = [];
  const allocations: Array<{ requested: string; request: ReturnType<typeof additiveAgentRequestReceipt> }> = [];
  const changed = () => [...createdChannels.map((row) => ({ kind: "channel-create", ...row })), ...allocations.map((row) => ({ kind: "agent-allocation", ...row }))];
  try {
    unchanged();
    if (readMaintenanceJournal(root)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a maintenance transition is retained; no additive team effect was submitted", { target });
    const legacy = listLedgerFiles(root, { requireReadable: true }), prior = listAdditiveTeamAttempts(root);
    const returnedIds = new Set(prior.returned.map((row) => row.deploymentId));
    if (legacy.refused.length || legacy.valid.some(({ ledger }) => ledger.space === space && ledger.manifestHash === manifestHash) || prior.refused.length || retainedAdditiveTeamAttempts(prior).some((row) => !returnedIds.has(row.deploymentId) || row.space === space && row.manifestHash === manifestHash)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an unreadable, unsettled or prior same-manifest deployment is retained; no uncertain effect or reapply was repeated", { target });
    const boots = listFreshTeamAttempts(root), summaries = listFreshTeamSummaries(root), byId = new Map(summaries.valid.map((row) => [row.deploymentId, row]));
    if (boots.refused.length || summaries.refused.length || boots.valid.some((row) => !freshTeamAttemptSettled(row, byId.get(row.deploymentId)))) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a fresh boot is unsettled or unreadable; team deployment did not infer complete custody", { target });
    // Select once by an attributed read, then obtain a caller instrument for that exact instance.
    const probe = await resolveControlTarget({ space }, "control-caller-admin", undefined, { onRefusal: "throw" });
    if (probe.root === undefined || canonicalRoot(probe.root) !== root || probe.server !== selected.server || probe.mode !== selected.mode || (probe.auth.tls === true) !== (selected.tlsRequired === true)) throw new CommandFailure("refused", "CONFLICT", "manager discovery resolved another root, broker, transport or authentication mode", { target });
    const status = await askManager(space, probe.server, "managerStatus", undefined, probe.auth, "any");
    if (!status.ok) throw managerFailure(status, "team manager inspection", target);
    const instanceId = assertLifecycleToken(status.managerInstanceId ?? "", "instanceId");
    const control = await resolveControlTarget({ space }, "control-caller-admin", instanceId, { onRefusal: "throw" });
    if (control.root === undefined || canonicalRoot(control.root) !== root || control.server !== selected.server || control.mode !== selected.mode || (control.auth.tls === true) !== (selected.tlsRequired === true)) throw new CommandFailure("refused", "CONFLICT", "the pinned manager caller resolved another target; no launch was submitted", { target });
    const pinnedStatus = await askManager(space, control.server, "managerStatus", undefined, control.auth, "any", undefined, { instanceId });
    if (!pinnedStatus.ok) throw managerFailure(pinnedStatus, "pinned team manager inspection", { ...target, managerInstanceId: instanceId });
    const info = pinnedStatus.data as { execution?: unknown; runtime?: unknown; connectors?: Array<{ agent?: unknown; state?: unknown }> } | undefined;
    if (pinnedStatus.managerInstanceId !== instanceId || info?.execution !== "runtime" || info.runtime !== runtime) throw new CommandFailure("refused", "UNSUPPORTED", "the selected manager does not report the requested executable runtime; no replacement manager or runtime was started", { target: { ...target, managerInstanceId: instanceId, requestedRuntime: runtime } });
    if (manifest.channels.length && (!Array.isArray(info.connectors) || prepared.agents.some((agent) => !info.connectors!.some((row) => row.agent === agent.agentType && row.state === "available")))) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the selected manager's connector inventory does not report every requested application available; no channel was created ahead of an unavailable application", { target: { ...target, managerInstanceId: instanceId } });
    if (manifest.channels.length) {
      const read = await connectOrThrow({ space }, "deployer", { readOnly: true });
      if (!read.root || canonicalRoot(read.root) !== root || read.server !== selected.server || read.mode !== selected.mode || read.tls !== (selected.tlsRequired === true) || read.mode === "auth" && !read.auth) throw new CommandFailure("refused", "CONFLICT", "the channel reader/writer authority does not match the selected root, broker, transport and authentication mode", { target });
      const observed = await readOwnedChannelRevisions(read.server, space, read.tls, { creds: read.creds }, manifest.channels.map((channel) => channel.name));
      if (observed.some((row) => row.revision !== null)) throw new CommandFailure("refused", "CONFLICT", "a declared channel already exists; this all-new route did not patch or adopt it", { target: { ...target, existingChannels: observed.filter((row) => row.revision !== null).map((row) => row.name) } });
      const auth = read.mode === "auth" ? { creds: await mintCreds(read.auth!, newIdentity(), "channel-writer") } : { creds: read.creds };
      writer = await openAdditiveChannelWriter({ server: read.server, space, tls: read.tls, auth });
    }
    const deploymentId = genRunId();
    if (legacy.valid.some(({ ledger }) => ledger.runId === deploymentId) || prior.valid.some((row) => row.deploymentId === deploymentId) || boots.valid.some((row) => row.deploymentId === deploymentId) || summaries.valid.some((row) => row.deploymentId === deploymentId)) throw new CommandFailure("refused", "CONFLICT", "the proposed deployment id is already recorded; no alternative was silently allocated", { target });
    spec = buildLaunchSpec(prepared, deploymentId);
    if (Buffer.byteLength(JSON.stringify(spec)) > 256 * 1024) throw new CommandFailure("refused", "SCHEMA_INVALID", "the resolved launch specification exceeds the bounded native submission size", { target });
    attempt = { schemaVersion: 1, kind: "additive-team-attempt", deploymentId, root, space, server: selected.server, manifestPath: path, manifestHash, authMode: selected.mode, tlsRequired: selected.tlsRequired === true, declaredChannels: manifest.channels.map((row) => row.name), requestedAgents: spec.agents.map((row) => row.name), agentHashes: spec.agents.map((row) => ({ name: row.name, hash: row.hash })), managerInstanceId: instanceId, createdAt: new Date().toISOString() };
    unchanged();
    // Treat an interrupted intent write as retained uncertainty too; no native request is replayed.
    intentPublished = true;
    writeAdditiveTeamAttempt(root, attempt);
    for (const [ordinal, channel] of manifest.channels.entries()) {
      unchanged();
      writeAdditiveChannelStep(root, attempt, ordinal, "submitted");
      if (!writer) throw new Error("the original channel writer is unavailable");
      const revision = await writer.create(channel.name, cardOf(channel));
      createdChannels.push({ name: channel.name, revision });
      writeAdditiveChannelStep(root, attempt, ordinal, "accepted", revision);
    }
    for (const [ordinal, agent] of spec.agents.entries()) {
      unchanged();
      const observation: { request?: ReturnType<typeof additiveAgentRequestReceipt> } = {};
      const original = attempt;
      const reply = await askManager(space, control.server, "launch", { runId: deploymentId, name: agent.name, spec }, control.auth, "any", undefined, { instanceId, journal: {
        beforeSubmit(intent) {
          if (intent.requestedGoalId !== intent.requestId) throw new Error("native launch did not retain its original requested goal id");
          writeAdditiveAgentStep(root, original, ordinal, { phase: "submitted", managerInstanceId: instanceId, requestId: intent.requestId });
        },
        accepted(receipt) {
          const request = additiveAgentRequestReceipt(receipt);
          observation.request = request;
          allocations.push({ requested: agent.name, request });
          if (request.managerInstanceId !== instanceId) throw new Error("native allocation came from another manager");
          writeAdditiveAgentStep(root, original, ordinal, { phase: "accepted", managerInstanceId: instanceId, requestId: request.requestId, request });
        },
      } });
      if (!reply.ok) throw managerFailure(reply, "additive agent launch", { ...target, deploymentId, managerInstanceId: instanceId, requested: agent.name });
      const row = reply.data as { name?: unknown; id?: unknown; lifecycleUid?: unknown; agent?: unknown; mode?: unknown } | undefined;
      const request = observation.request;
      const allocation = request?.allocation, id = allocation?.owner === DEV_OWNER ? allocation.actor : allocation ? `${allocation.owner}.${allocation.actor}` : null;
      if (!request || !allocation || !row || row.name !== allocation.name || row.id !== id || row.lifecycleUid !== allocation.lifecycleUid || row.agent !== agent.agent || row.mode !== runtime || reply.managerInstanceId !== instanceId) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native joined result did not match its original manager allocation; no launch was retried", { target: { ...target, deploymentId, managerInstanceId: instanceId, requested: agent.name } });
      const joined: CreatedAgent = { requested: agent.name, hash: agent.hash, name: allocation.name, id: id!, lifecycleUid: allocation.lifecycleUid, agent: agent.agent, runtime, request };
      created.push(joined);
      writeAdditiveAgentStep(root, original, ordinal, { phase: "joined", managerInstanceId: instanceId, requestId: request.requestId, request, joined });
    }
    writeAdditiveAgentReceipt(root, attempt, created, createdChannels);
    if (!listAdditiveTeamAttempts(root).returned.some((row) => row.deploymentId === deploymentId && row.kind !== "additive-channel-receipt")) throw new Error("the full returned team receipt did not read back");
    returned = true;
  } catch (error) {
    failure = error instanceof CommandFailure ? error : new CommandFailure(intentPublished ? "unknown" : "refused", intentPublished ? "OPERATION_UNKNOWN" : "TARGET_UNAVAILABLE", intentPublished ? "the additive team sequence did not confirm its entire journal; no effect was retried and later effects were not attempted" : "team deployment preflight did not establish an unchanged authorized target; no create or launch was submitted", { target: { ...target, deploymentId: attempt?.deploymentId ?? null }, changed: changed(), remedy: "inspect this deployment's original requests, channel revisions and allocations before another action; no completed effect was rolled back" });
    if ((allocations.length || createdChannels.length) && failure.outcome !== "unknown") failure = new CommandFailure("partial", "OPERATION_PARTIAL", "the deployment retained native channel creates or agent allocations but did not complete every joined receipt; completed effects were not rolled back", { target: { ...target, deploymentId: attempt?.deploymentId ?? null }, changed: changed(), native: { code: failure.code, outcome: failure.outcome }, remedy: "inspect the original manager, channel revisions, accepted goals and journal before another action" });
  } finally {
    if (writer) { try { await writer.close(); } catch { writerCloseUnconfirmed = true; } }
    try { releaseMaintenanceLock(lock); }
    catch { if (!failure) failure = new CommandFailure(returned ? "partial" : "unknown", returned ? "OPERATION_PARTIAL" : "OPERATION_UNKNOWN", "the deployment's maintenance lock release did not confirm; native effects were not repeated", { target, changed: changed() }); }
  }
  writeResult(presentationOf(values), { command: "team deploy", target: { ...target, deploymentId: attempt?.deploymentId ?? null }, result: { kind: manifest.channels.length ? "additive-mixed-team" : "additive-agent-only", deploymentId: attempt?.deploymentId ?? null, managerInstanceId: attempt?.managerInstanceId ?? null, server: brokerAddressForDisplay(selected.server) ?? "not displayable", returnedReceipt: returned, requestedAgents: spec?.agents.map((row) => row.name) ?? [], declaredChannels: manifest.channels.map((row) => row.name), createdChannels, createdAgents: created, acceptedAllocations: allocations, currentState: "not-rechecked", removalAuthority: "requires-native-incarnation-review" }, warnings: writerCloseUnconfirmed ? [{ code: "WRITER_CLOSE_UNCONFIRMED", target, message: "Closing the original channel writer was not confirmed; returned native receipts remain recorded." }] : [], ...(failure ? { failure } : {}) }, (data): Report => ({ sections: [
    { title: returned ? "Additive team returned" : "Additive team deployment incomplete", blocks: [
      { kind: "fields", rows: [["Deployment", data.deploymentId ?? "not recorded"], ["Manager", data.managerInstanceId ?? "not selected"], ["Requested agents", String(data.requestedAgents.length)], ["Joined receipts", String(data.createdAgents.length)], ["Channel create receipts", `${data.createdChannels.length} of ${data.declaredChannels.length}`], ["Current state", "not rechecked"]] },
      { kind: "table", columns: [{ key: "requested", label: "Declared" }, { key: "name", label: "Allocated" }, { key: "id", label: "Identity" }, { key: "goal", label: "Accepted goal" }], rows: data.createdAgents.map((row) => ({ requested: row.requested, name: row.name, id: row.id, goal: row.request.goalId })) },
      ...(data.acceptedAllocations.some((row) => !data.createdAgents.some((joined) => joined.request.requestId === row.request.requestId)) ? [
        { kind: "lines" as const, lines: ["These allocations were accepted, but no matched joined result was confirmed:"] },
        { kind: "table" as const, columns: [{ key: "requested", label: "Declared" }, { key: "name", label: "Allocated" }, { key: "uid", label: "Lifecycle" }, { key: "goal", label: "Accepted goal" }], rows: data.acceptedAllocations.filter((row) => !data.createdAgents.some((joined) => joined.request.requestId === row.request.requestId)).map((row) => ({ requested: row.requested, name: row.request.allocation.name, uid: row.request.allocation.lifecycleUid, goal: row.request.goalId })) },
      ] : []),
      ...(data.createdChannels.length ? [{ kind: "table" as const, columns: [{ key: "name", label: "Channel" }, { key: "revision", label: "Returned revision" }], rows: data.createdChannels.map((row) => ({ name: `#${row.name}`, revision: String(row.revision) })) }] : []),
      { kind: "lines", lines: ["Channel revisions and joined identities are historical native results, not current health, exclusive readers or task completion. Each phase is retained before the next effect. Existing cards and agents were not adopted. Unknown effects are not replayed; completed effects are not rolled back. Mixed/channel and open/user-auth removal remain unsupported; a returned static agent-only team has its own guarded retirement route."] },
    ] },
    ...(data.deploymentId ? [{ title: "Next", blocks: [{ kind: "commands" as const, items: [{ command: `cotal team show ${data.deploymentId}`, description: "Inspect original requests, channel creates, allocations and returned joins" }] }] }] : []),
  ] }));
}
