import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mintCreds, newIdentity, validateChannelConfig } from "@cotal-ai/core";
import { acquireMaintenanceLock, brokerAddressForDisplay, canonicalRoot, CommandFailure, connectOrThrow, findMesh, findPreparedSpace, presentationOf, readMaintenanceJournal, releaseMaintenanceLock, serviceMetadataDigest, userViewAuth, writeResult, type Report } from "@cotal-ai/workspace";
import { buildLaunchSpec, cardOf, genRunId } from "../lib/manifest/apply.js";
import { resolveControlTarget } from "../lib/control.js";
import { verifyOriginalIncarnations } from "../lib/team-retained.js";
import { hashManifestSource, listLedgerFiles } from "../lib/manifest/ledger.js";
import { loadManifest } from "../lib/manifest/index.js";
import { additiveChannelAttemptSettled, listAdditiveTeamAttempts, retainedAdditiveTeamAttempts, writeAdditiveChannelReceipt, writeAdditiveChannelStep, writeAdditiveTeamAttempt, type AdditiveChannelReceipt, type AdditiveTeamAttempt } from "../lib/team-additive-attempt.js";
import { readOwnedChannelRevisions } from "../lib/team-deploy-inspection.js";
import { openAdditiveChannelWriter } from "../lib/team-additive-native.js";
import { cotalRoot } from "../lib/paths.js";
import { freshTeamAttemptSettled, listFreshTeamAttempts, listFreshTeamSummaries } from "../lib/team-fresh.js";
import type { TeamValues } from "./team.js";

/** Channel-only effects remain create-only. An identical settled deployment can be verified as
 *  a no-op; existing foreign cards, agent launches and stale drift never enter the legacy writer. */
export async function applyChannelOnlyTeam(file: string, values: TeamValues): Promise<void> {
  const path = resolve(file);
  let prepared: ReturnType<typeof loadManifest>;
  try { prepared = loadManifest(path); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the additive manifest could not be resolved; no broker was contacted", { target: { path } }); }
  const manifest = prepared.manifest, space = manifest.space;
  if (values.space !== undefined && values.space !== space) throw new CommandFailure("refused", "CONFLICT", "--space differs from this manifest's exact target; no broker was contacted", { target: { space, selected: values.space } });
  if (prepared.agents.length || manifest.runtime !== undefined || values.runtime !== undefined || values["allow-stale"] !== undefined)
    throw new CommandFailure("refused", "UNSUPPORTED", "this channel-only route accepts no agent or runtime phase; no channel card was created in place of that request", { target: { space, requestedAgents: prepared.agents.length } });
  if (!manifest.channels.length) throw new CommandFailure("refused", "USAGE_INVALID", "this channel-only additive route needs at least one declared channel; no empty deployment was recorded", { target: { space } });
  if (manifest.defaults !== undefined || manifest.broker?.host !== undefined || manifest.channels.some((channel) => channel.subscribe.length || channel.allowSubscribe.length || channel.allowPublish.length))
    throw new CommandFailure("refused", "UNSUPPORTED", "this channel-only route cannot apply a broker bind, space defaults or agent access edges; none was silently dropped", { target: { space } });
  const registered = findMesh(space), preparedSpace = findPreparedSpace(space), root = canonicalRoot(cotalRoot());
  if (!registered || canonicalRoot(registered.root) !== root || preparedSpace && canonicalRoot(preparedSpace.root) !== root)
    throw new CommandFailure("refused", "CONFLICT", "additive creation needs an existing registered mesh in this checkout; no foreign root was adopted", { target: { root, space } });
  if (registered.server.includes(","))
    throw new CommandFailure("refused", "UNSUPPORTED", "channel-only additive creation needs one registered broker address; a server list cannot pin one native target", { target: { root, space } });
  if (manifest.broker?.servers !== undefined && manifest.broker.servers !== registered.server)
    throw new CommandFailure("refused", "CONFLICT", "the manifest broker differs from the registered target; no alternate server was selected", { target: { root, space } });
  const requestedMode = manifest.broker?.auth === false ? "open" : manifest.broker?.auth === "user" ? "user" : "auth";
  if (manifest.broker?.auth !== undefined && requestedMode !== registered.mode)
    throw new CommandFailure("refused", "CONFLICT", "the manifest authentication mode differs from this registered mesh; no identity mode was substituted", { target: { root, space, recordedMode: registered.mode, requestedMode } });
  if (registered.mode === "open" && manifest.channels.some((channel) => channel.deliveryClass === "durable"))
    throw new CommandFailure("refused", "UNSUPPORTED", "an open mesh has no durable delivery daemon; no durable channel card was created", { target: { root, space } });
  if (manifest.channels.some((channel) => channel.deliveryClass !== "live"))
    throw new CommandFailure("refused", "UNSUPPORTED", "channel-only additive apply currently needs explicit live delivery on every card; inherited or durable delivery needs a verified daemon before creation", { target: { root, space } });
  try { for (const channel of manifest.channels) validateChannelConfig(cardOf(channel)); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "a declared channel card exceeds native policy or text limits; no intent or channel was written", { target: { root, space } }); }
  let source: string;
  try { source = readFileSync(path, "utf8"); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the additive manifest source could not be read for an exact pre-effect comparison", { target: { path, space } }); }
  const manifestHash = hashManifestSource(source);
  let lock: ReturnType<typeof acquireMaintenanceLock>;
  try { lock = acquireMaintenanceLock(root); }
  catch { throw new CommandFailure("refused", "CONFLICT", "the root's maintenance lock could not be acquired; no additive effect was submitted", { target: { root, space } }); }
  let phase: "preflight" | "intent" | "submitted" | "returned" = "preflight";
  let attempt: AdditiveTeamAttempt | undefined;
  let reused: { receipt: AdditiveChannelReceipt; observedAt: string } | undefined;
  let writer: Awaited<ReturnType<typeof openAdditiveChannelWriter>> | undefined;
  let failure: CommandFailure | undefined;
  let writerCloseUnconfirmed = false;
  const created: Array<{ name: string; revision: number }> = [];
  try {
    if (readMaintenanceJournal(root)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "this root retains a maintenance transition; additive deployment did not write across it", { target: { root, space } });
    const current = findMesh(space);
    if (!current || current.server !== registered.server || current.root !== registered.root || current.mode !== registered.mode || current.tlsRequired !== registered.tlsRequired || current.ts !== registered.ts)
      throw new CommandFailure("refused", "CONFLICT", "the registered mesh changed under the lock; no additive effect was submitted", { target: { root, space } });
    const reloaded = loadManifest(path);
    if (readFileSync(path, "utf8") !== source || JSON.stringify(reloaded) !== JSON.stringify(prepared))
      throw new CommandFailure("refused", "CONFLICT", "the manifest changed during additive preflight; no native effect was submitted", { target: { root, space } });
    const ledgers = listLedgerFiles(root, { requireReadable: true });
    if (ledgers.refused.length || ledgers.valid.some(({ ledger }) => ledger.space === space && ledger.manifestHash === manifestHash))
      throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a legacy additive ledger is unreadable or already names this manifest; no re-apply was inferred", { target: { root, space, unreadable: ledgers.refused.map(({ path }) => path) } });
    const prior = listAdditiveTeamAttempts(root);
    const returnedIds = new Set(prior.returned.map((row) => row.deploymentId)), retained = retainedAdditiveTeamAttempts(prior);
    if (prior.refused.length || retained.some((row) => !returnedIds.has(row.deploymentId)))
      throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an additive attempt is unreadable or unsettled; no uncertain operation was retried", { target: { root, space, deploymentIds: prior.valid.map((row) => row.deploymentId), unreadable: prior.refused.map(({ path }) => path) } });
    const matching = retained.filter((row) => row.space === space && row.manifestHash === manifestHash);
    if (matching.length > 1) throw new CommandFailure("refused", "TARGET_AMBIGUOUS", "several retained deployments name this manifest; no ownership was selected", { target: { root, space, deploymentIds: matching.map((row) => row.deploymentId) } });
    const previous = matching[0];
    const previousReceipt = previous && prior.returned.find((row) => row.deploymentId === previous.deploymentId);
    if (previous && (!previousReceipt || previousReceipt.kind !== "additive-channel-receipt" || previous.requestedAgents.length || previous.root !== root || previous.server !== current.server || previous.authMode !== current.mode || previous.tlsRequired !== (current.tlsRequired === true) || JSON.stringify(previous.declaredChannels) !== JSON.stringify(manifest.channels.map((channel) => channel.name)) || !additiveChannelAttemptSettled(previous, previousReceipt, prior.steps.filter((row) => row.deploymentId === previous.deploymentId))))
      throw new CommandFailure("refused", "CONFLICT", "the retained deployment does not settle this exact channel-only request and registered target; no re-apply was inferred", { target: { root, space, deploymentId: previous.deploymentId } });
    const boots = listFreshTeamAttempts(root), summaries = listFreshTeamSummaries(root);
    const byId = new Map(summaries.valid.map((row) => [row.deploymentId, row]));
    if (boots.refused.length || summaries.refused.length || boots.valid.some((row) => !freshTeamAttemptSettled(row, byId.get(row.deploymentId))))
      throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an earlier fresh boot has an unsettled or unreadable record; no additive ownership was inferred", { target: { root, space } });
    const conn = await connectOrThrow({ space }, "deployer", { readOnly: true });
    if (!conn.root || canonicalRoot(conn.root) !== root || conn.server !== current.server || conn.mode !== current.mode || conn.tls !== (current.tlsRequired === true))
      throw new CommandFailure("refused", "CONFLICT", "the scoped connection differs from the selected root, broker, auth mode or transport; no additive card was written", { target: { root, space } });
    if (conn.mode === "auth" && !conn.auth) throw new CommandFailure("refused", "PERMISSION_DENIED", "the registered static mesh has no signer for a scoped channel writer; no open credential was substituted", { target: { root, space } });
    let userRead: Awaited<ReturnType<typeof userViewAuth>> | undefined;
    if (conn.mode === "user") {
      try { userRead = await userViewAuth(conn, "deployer"); }
      catch (error) {
        const cause = (error as { code?: unknown }).code;
        const code = cause === "signed-out" ? "AUTH_REQUIRED" : cause === "refused" ? "PERMISSION_DENIED" : "DEPENDENCY_UNAVAILABLE";
        throw new CommandFailure("refused", code, "the user-auth deployer view was not issued; no identity or broader credential was substituted", { target: { root, space }, remedy: code === "AUTH_REQUIRED" ? "sign in with cotal login, then inspect the selected space" : "inspect the caller's team deploy grant on this exact space" });
      }
    }
    if (userRead && (!conn.epCaller || userRead.owner !== conn.epCaller.owner || userRead.actor !== conn.epCaller.actor))
      throw new CommandFailure("refused", "CONFLICT", "the original user bearer and deployer view do not name one caller; no identity was substituted", { target: { root, space } });
    const readAuth = userRead ? { bearer: userRead.bearer, sentinelCreds: userRead.sentinelCreds } : { creds: conn.creds };
    const names = manifest.channels.map((channel) => channel.name);
    const observed = await readOwnedChannelRevisions(conn.server, space, conn.tls, readAuth, names, { leader: previous !== undefined });
    const latest = findMesh(space);
    if (!latest || latest.ts !== current.ts || latest.server !== current.server || latest.root !== current.root || latest.mode !== current.mode || latest.tlsRequired !== current.tlsRequired || readFileSync(path, "utf8") !== source)
      throw new CommandFailure("refused", "CONFLICT", "the registered target or manifest changed during inspection; no native create was submitted", { target: { root, space } });
    if (previous) {
      if (!previousReceipt || previousReceipt.kind !== "additive-channel-receipt") throw new CommandFailure("refused", "CONFLICT", "the retained channel receipt is unavailable");
      const expected = new Map(previousReceipt.createdChannels.map((row) => [row.name, row.revision]));
      const cards = new Map(manifest.channels.map((channel) => [channel.name, serviceMetadataDigest(cardOf(channel))]));
      if (observed.length !== expected.size || observed.some((row) => row.revision !== expected.get(row.name) || row.cardSha256 !== cards.get(row.name)))
        throw new CommandFailure("refused", "CONFLICT", "a retained channel card is absent or changed from its original create revision; no card was repaired, adopted or recreated", { target: { root, space, deploymentId: previous.deploymentId } });
      const confirmed = listAdditiveTeamAttempts(root);
      if (confirmed.refused.length || !retainedAdditiveTeamAttempts(confirmed).some((row) => JSON.stringify(row) === JSON.stringify(previous)) || !confirmed.returned.some((row) => JSON.stringify(row) === JSON.stringify(previousReceipt)))
        throw new CommandFailure("refused", "CONFLICT", "the retained deployment changed during native inspection; no completed re-apply was inferred", { target: { root, space, deploymentId: previous.deploymentId } });
      reused = { receipt: previousReceipt, observedAt: new Date().toISOString() };
    } else {
      if (observed.some((row) => row.revision !== null))
        throw new CommandFailure("refused", "CONFLICT", "one or more declared channel cards already exist; this all-new route did not patch or adopt them", { target: { root, space, existingChannels: observed.filter((row) => row.revision !== null).map((row) => row.name) } });
      let userWrite: Awaited<ReturnType<typeof userViewAuth>> | undefined;
      if (userRead) {
        try { userWrite = await userViewAuth(conn, "channel-writer"); }
        catch (error) {
          const cause = (error as { code?: unknown }).code;
          const code = cause === "signed-out" ? "AUTH_REQUIRED" : cause === "refused" ? "PERMISSION_DENIED" : "DEPENDENCY_UNAVAILABLE";
          throw new CommandFailure("refused", code, "the channel-writer view was not issued; no identity or broader credential was substituted", { target: { root, space } });
        }
        if (userRead.owner !== userWrite.owner || userRead.actor !== userWrite.actor) throw new CommandFailure("refused", "CONFLICT", "the deployer and channel-writer views do not name one caller; no identity was substituted", { target: { root, space } });
      }
      const writerAuth = userWrite ? { bearer: userWrite.bearer, sentinelCreds: userWrite.sentinelCreds }
        : conn.mode === "auth" ? { creds: await mintCreds(conn.auth!, newIdentity(), "channel-writer") } : { creds: conn.creds };
      const deploymentId = genRunId();
      if (ledgers.valid.some(({ ledger }) => ledger.runId === deploymentId) || prior.valid.some((row) => row.deploymentId === deploymentId) || boots.valid.some((row) => row.deploymentId === deploymentId) || summaries.valid.some((row) => row.deploymentId === deploymentId))
        throw new CommandFailure("refused", "CONFLICT", "the proposed additive ID is already recorded under this root; no new ID or native effect was silently substituted", { target: { root, space, deploymentId } });
      writer = await openAdditiveChannelWriter({ server: conn.server, space, tls: conn.tls, auth: writerAuth });
      const beforeIntent = findMesh(space);
      if (!beforeIntent || beforeIntent.ts !== current.ts || beforeIntent.server !== current.server || beforeIntent.root !== current.root || beforeIntent.mode !== current.mode || beforeIntent.tlsRequired !== current.tlsRequired || readFileSync(path, "utf8") !== source)
        throw new CommandFailure("refused", "CONFLICT", "the registered target or manifest changed before intent publication; no native create was submitted", { target: { root, space } });
      attempt = { schemaVersion: 1, kind: "additive-team-attempt", deploymentId, root, space, server: conn.server, manifestPath: path, manifestHash, authMode: current.mode, tlsRequired: conn.tls, declaredChannels: names, requestedAgents: [], createdAt: new Date().toISOString() };
      try { writeAdditiveTeamAttempt(root, attempt); phase = "intent"; }
      catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the additive intent did not confirm durable publication; no native create was requested or retried", { target: { root, space, deploymentId: attempt.deploymentId } }); }
      for (const [ordinal, channel] of manifest.channels.entries()) {
        try { writeAdditiveChannelStep(root, attempt, ordinal, "submitted"); phase = "submitted"; }
        catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "a channel submission marker did not confirm durability; its native create was not requested", { target: { root, space, deploymentId: attempt.deploymentId, channel: channel.name }, changed: created }); }
        let revision: number;
        try { revision = await writer.create(channel.name, cardOf(channel)); }
        catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "a create-only channel request did not confirm its native outcome; no card was overwritten or retried", { target: { root, space, deploymentId: attempt.deploymentId, channel: channel.name }, changed: created }); }
        try { writeAdditiveChannelStep(root, attempt, ordinal, "accepted", revision); created.push({ name: channel.name, revision }); }
        catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the channel create returned but its local revision receipt did not confirm publication; no further channel was attempted", { target: { root, space, deploymentId: attempt.deploymentId, channel: channel.name }, changed: created }); }
      }
      try { writeAdditiveChannelReceipt(root, attempt, created); }
      catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "all channel creates returned, but their full additive receipt did not confirm publication; no operation was retried", { target: { root, space, deploymentId: attempt.deploymentId }, changed: created }); }
      const recorded = listAdditiveTeamAttempts(root);
      if (!recorded.returned.some((row) => row.deploymentId === attempt!.deploymentId && additiveChannelAttemptSettled(attempt!, row, recorded.steps.filter((step) => step.deploymentId === attempt!.deploymentId))))
        throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the returned channel receipt could not be read back as a settled exact attempt", { target: { root, space, deploymentId: attempt.deploymentId }, changed: created });
    }
    phase = "returned";
  } catch (error) {
    failure = error instanceof CommandFailure ? error : new CommandFailure(phase === "preflight" ? "refused" : "unknown", phase === "preflight" ? "TARGET_UNAVAILABLE" : "OPERATION_UNKNOWN", phase === "preflight" ? "additive preflight could not establish an authorized unchanged target; no channel create was requested" : "the additive operation did not confirm its complete outcome; no channel was retried", { target: { root, space, ...(attempt ? { deploymentId: attempt.deploymentId } : {}) }, changed: created });
  } finally {
    if (writer) {
      try { await writer.close(); }
      catch { if (phase === "returned") writerCloseUnconfirmed = true; }
    }
    try { releaseMaintenanceLock(lock); }
    catch { if (!failure) failure = new CommandFailure(phase === "returned" ? "partial" : "unknown", phase === "returned" ? "OPERATION_PARTIAL" : "OPERATION_UNKNOWN", "the local maintenance lock release did not confirm; native effects were not retried", { target: { root, space, ...(attempt ? { deploymentId: attempt.deploymentId } : {}) }, changed: created }); }
  }
  if (failure) throw failure;
  if (reused) {
    const receipt = reused.receipt;
    writeResult(presentationOf(values), { command: "team deploy", target: { root, space, deploymentId: receipt.deploymentId }, noOp: true,
      result: { kind: "retained-channel-deployment", deploymentId: receipt.deploymentId, root, space, createdChannels: [], checkedChannels: receipt.createdChannels, observedAt: reused.observedAt, currentCardState: "matching-create-revisions-as-of-read", nativeRead: "leader-served", effectAttempted: false, writerIssued: false, removalAuthority: "not-established" } }, (data): Report => ({ sections: [
      { title: "Retained channel deployment unchanged", blocks: [{ kind: "fields", rows: [["Deployment", data.deploymentId], ["Space", data.space], ["Root", data.root], ["Checked cards", String(data.checkedChannels.length)], ["Observed", data.observedAt], ["Channel writes", "none"], ["Channel-writer issued", "no"]] }, { kind: "lines", lines: ["The original settled deployment and exact create revisions matched leader-served reads. No card, agent, intent or deployment was created. This is a snapshot, not a reader, delivery-health or removal-authority check."] }] },
    ] }));
    return;
  }
  writeResult(presentationOf(values), { command: "team deploy", target: { root, space, deploymentId: attempt!.deploymentId }, result: { kind: "additive-channel-only", deploymentId: attempt!.deploymentId, root, space, server: brokerAddressForDisplay(registered.server) ?? "not displayable", createdChannels: created, requestedAgents: [], returnedReceipt: true, currentCardState: "not-checked", removalAuthority: "not-established" }, warnings: [{ code: "CURRENT_CHANNEL_STATE_UNCHECKED", target: { space, deploymentId: attempt!.deploymentId }, message: "The returned revisions are historical; current cards and readers were not re-read." }, ...(writerCloseUnconfirmed ? [{ code: "WRITER_CLOSE_UNCONFIRMED", target: { space, deploymentId: attempt!.deploymentId }, message: "The create receipts were confirmed, but closing the writer connection did not confirm." }] : [])] }, (data): Report => ({ sections: [
    { title: "Additive channels returned", blocks: [{ kind: "fields", rows: [["Deployment", data.deploymentId], ["Space", data.space], ["Root", data.root], ["Broker", data.server], ["Created cards", String(data.createdChannels.length)], ["Agent launches", "none requested"], ["Current card state", "not checked"], ["Removal authority", "not established"]] }, { kind: "table", columns: [{ key: "channel", label: "Channel" }, { key: "revision", label: "Returned revision" }], rows: data.createdChannels.slice(0, 100).map((row) => ({ channel: `#${row.name}`, revision: String(row.revision) })) }, { kind: "lines", lines: [...(data.createdChannels.length > 100 ? ["Additional accepted revisions are in the saved receipt."] : []), "The receipt is historical. Existing cards were not patched and no agent was launched. Guarded team removal checks the original card revisions; it does not purge history, change grants or stop readers."] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: `cotal team show ${data.deploymentId}`, description: "Read the returned channel-only receipt" }, { command: `cotal status --space ${data.space}`, description: "Inspect the selected mesh without assuming these cards are unchanged" }] }] },
  ] }));
}

/** Re-apply of a retained agent or mixed deployment for the identical manifest. It verifies the
 *  exact original receipt, cards and manager incarnations as of now and never launches, restarts,
 *  updates, adopts or records anything. A changed agent hash is stale drift: refused unless
 *  `--allow-stale` names exactly that agent, in which case it keeps running its old policy. */
export async function applyRetainedTeam(file: string, values: TeamValues, previous: AdditiveTeamAttempt): Promise<void> {
  const path = resolve(file), root = canonicalRoot(cotalRoot());
  let prepared: ReturnType<typeof loadManifest>, source: string;
  try { prepared = loadManifest(path); source = readFileSync(path, "utf8"); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the team manifest and referenced personas could not be resolved; no retained deployment was checked", { target: { root, path } }); }
  const { manifest } = prepared, space = manifest.space, target = { root, space, path, deploymentId: previous.deploymentId };
  if (values.space !== undefined && values.space !== space) throw new CommandFailure("refused", "CONFLICT", "the selected space differs from this manifest; no target was substituted", { target });
  const runtime = values.runtime ?? manifest.runtime ?? "pty";
  const inventory = listAdditiveTeamAttempts(root);
  if (inventory.refused.length) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "unreadable deployment or removal records remain; no retained ownership was selected", { target });
  const matching = retainedAdditiveTeamAttempts(inventory).filter((row) => row.space === space && row.manifestHash === hashManifestSource(source));
  const receipt = inventory.returned.find((row) => row.deploymentId === previous.deploymentId);
  if (matching.length > 1) throw new CommandFailure("refused", "TARGET_AMBIGUOUS", "several retained deployments name this manifest; no ownership was selected", { target: { ...target, deploymentIds: matching.map((row) => row.deploymentId) } });
  if (matching.length !== 1 || JSON.stringify(matching[0]) !== JSON.stringify(previous) || !receipt || receipt.kind === "additive-channel-receipt")
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the retained deployment for this manifest is unsettled or has no returned agent receipt; no uncertain launch was retried", { target });
  const selected = findMesh(space);
  if (!selected || canonicalRoot(selected.root) !== root || canonicalRoot(previous.root) !== root || selected.server !== previous.server || selected.mode !== previous.authMode || (selected.tlsRequired === true) !== previous.tlsRequired || !previous.managerInstanceId)
    throw new CommandFailure("refused", "CONFLICT", "the registered root, broker, auth mode or transport differs from the retained deployment; no target was substituted", { target });
  if (selected.mode === "user") throw new CommandFailure("refused", "UNSUPPORTED", "user-auth managers expose no durable static slot store to prove the original incarnations; the retained deployment was not verified or changed", { target });
  if (receipt.createdAgents.some((row) => row.runtime !== runtime)) throw new CommandFailure("refused", "CONFLICT", "the requested runtime differs from the retained incarnations' runtime; no restart or replacement was attempted", { target: { ...target, requestedRuntime: runtime } });
  // The manifest hash binds the text, but a persona file can change underneath it: compare resolved agent hashes.
  const spec = buildLaunchSpec(prepared, previous.deploymentId);
  if (JSON.stringify(spec.agents.map((row) => row.name)) !== JSON.stringify(previous.requestedAgents) || JSON.stringify(manifest.channels.map((row) => row.name)) !== JSON.stringify(previous.declaredChannels))
    throw new CommandFailure("refused", "CONFLICT", "the resolved agents or channels differ from the retained request; no member was added or removed by a re-apply", { target });
  const stale = spec.agents.filter((row, ordinal) => receipt.createdAgents[ordinal]?.hash !== row.hash).map((row) => row.name);
  const waived = new Set(String(values["allow-stale"] ?? "").split(",").map((name) => name.trim()).filter(Boolean));
  const unknownWaiver = [...waived].filter((name) => !stale.includes(name));
  if (unknownWaiver.length) throw new CommandFailure("refused", "USAGE_INVALID", "--allow-stale names agents that are not stale in this retained deployment; a waiver applies only to observed drift", { target: { ...target, notStale: unknownWaiver } });
  const unwaived = stale.filter((name) => !waived.has(name));
  if (unwaived.length) throw new CommandFailure("refused", "CONFLICT", "declared agents changed since the retained deployment; they need a restart this route does not perform", { target: { ...target, stale: unwaived }, remedy: `keep them on the old policy with --allow-stale ${unwaived.join(",")}, or remove and redeploy the team` });

  const control = await resolveControlTarget({ space }, "control-caller-privileged", previous.managerInstanceId, { onRefusal: "throw" });
  if (!control.root || canonicalRoot(control.root) !== root || control.server !== selected.server || control.mode !== selected.mode || (control.auth.tls === true) !== previous.tlsRequired)
    throw new CommandFailure("refused", "CONFLICT", "the original manager's caller resolved another target; nothing was checked", { target });
  const incarnations = await verifyOriginalIncarnations({ space, server: control.server, auth: control.auth, mode: selected.mode, managerInstanceId: previous.managerInstanceId, agents: receipt.createdAgents, target });
  let cards: Array<{ name: string; revision: number }> = [];
  if (receipt.createdChannels.length) {
    const read = await connectOrThrow({ space }, "deployer", { readOnly: true });
    if (!read.root || canonicalRoot(read.root) !== root || read.server !== selected.server || read.mode !== selected.mode || read.tls !== previous.tlsRequired) throw new CommandFailure("refused", "CONFLICT", "the channel reader resolved another root, broker, mode or transport; no card was checked", { target });
    const observed = await readOwnedChannelRevisions(read.server, space, read.tls, { creds: read.creds }, receipt.createdChannels.map((row) => row.name), { leader: true });
    const digests = new Map(manifest.channels.map((channel) => [channel.name, serviceMetadataDigest(cardOf(channel))]));
    if (observed.length !== receipt.createdChannels.length || observed.some((row, index) => row.name !== receipt.createdChannels[index]!.name || row.revision !== receipt.createdChannels[index]!.revision || row.cardSha256 !== digests.get(row.name)))
      throw new CommandFailure("refused", "CONFLICT", "a retained channel card is absent or changed from its original create revision; no card was repaired, adopted or recreated", { target });
    cards = receipt.createdChannels;
  }
  const after = listAdditiveTeamAttempts(root);
  if (JSON.stringify(findMesh(space)) !== JSON.stringify(selected) || readFileSync(path, "utf8") !== source || after.refused.length || !after.returned.some((row) => JSON.stringify(row) === JSON.stringify(receipt)) || !retainedAdditiveTeamAttempts(after).some((row) => JSON.stringify(row) === JSON.stringify(previous)))
    throw new CommandFailure("refused", "CONFLICT", "the registration, manifest or retained records changed during verification; no unchanged deployment was reported", { target });
  const observedAt = new Date().toISOString();
  writeResult(presentationOf(values), { command: "team deploy", target, noOp: true,
    result: { kind: "retained-team-deployment", deploymentId: previous.deploymentId, managerInstanceId: previous.managerInstanceId, managerEpoch: incarnations.managerEpoch, observedAt, readConsistency: "ordered-not-atomic", verifiedAgents: incarnations.agents, checkedChannels: cards, staleWaived: stale, oldPolicyRetained: stale, restarted: [], launched: [], createdChannels: [], recorded: false },
    ...(stale.length ? { warnings: [{ code: "STALE_POLICY_RETAINED", target: { ...target, agents: stale }, message: "These agents changed in the manifest but keep running the policy they were launched with; nothing was restarted or updated." }] } : {}) },
    (data): Report => ({ sections: [
      { title: "Retained team unchanged", blocks: [{ kind: "fields", rows: [["Deployment", data.deploymentId], ["Manager", data.managerInstanceId], ["Observed at", data.observedAt], ["Original incarnations", String(data.verifiedAgents.length)], ["Checked cards", String(data.checkedChannels.length)], ["Old policy kept", data.oldPolicyRetained.join(", ") || "none"], ["Launched or restarted", "none"]] },
        { kind: "table", columns: [{ key: "name", label: "Agent" }, { key: "uid", label: "Lifecycle" }, { key: "evidence", label: "Evidence" }], rows: data.verifiedAgents.map((row) => ({ name: row.name, uid: row.lifecycleUid, evidence: row.evidence === "static-slot-active-live" ? "active live slot" : "exact manager ps row" })) },
        { kind: "lines", lines: ["Each original incarnation and card matched as of the time shown, in ordered reads that are not one atomic snapshot. Nothing was launched, restarted, updated or recorded. A waived stale agent keeps running the policy it was launched with."] }] },
    ] }));
}
