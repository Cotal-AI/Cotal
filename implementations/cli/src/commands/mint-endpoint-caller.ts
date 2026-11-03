import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  CotalEndpoint, DEV_OWNER, acquireLock, credsClaims, identityFromCreds, mintCreds,
  mintLifecycleUid, newIdentity, provisionAgent, resolveService, writeSecretFileCreateOnly,
  type EpCapability, type ParsedArgs,
} from "@cotal-ai/core";
import {
  CommandFailure, assertExternalCredentialExport, canonicalRoot, isCommandFailure,
  presentationOf, protectedCredentialReference, protectedLocalDirectory, readLocalRecordSource,
  standaloneCallerIntent, validateCredentialMintArguments, writeResult, type Report,
} from "@cotal-ai/workspace";
import { staticMintAuthority } from "../lib/credential-authority.js";
import { openEndpointConnection, pairedCallerCommand } from "../lib/endpoint-client.js";
import { endpointFailure } from "../lib/endpoint-errors.js";

async function callerSurface(expected: { root: string; space: string; server: string; account: string; tlsRequired: boolean }, endpoint: string) {
  let connection: Awaited<ReturnType<typeof openEndpointConnection>> | undefined;
  const target = { space: expected.space, endpoint };
  try {
    connection = await openEndpointConnection({ space: expected.space, server: expected.server }, "control-caller-privileged", endpoint);
    if (connection.space !== expected.space || connection.server !== expected.server || !connection.root || canonicalRoot(connection.root) !== canonicalRoot(expected.root) || connection.account !== expected.account || connection.mode !== "auth" || (connection.auth.tls === true) !== expected.tlsRequired) throw new CommandFailure("refused", "CONFLICT", "the endpoint discovery instrument differs from the selected signing root, account or transport; no caller was provisioned", { target });
    const service = await resolveService(connection.nc, expected.space, endpoint, connection.auth.epCaller!, { deadlineMs: 10000 });
    if (!service.commands.size || service.commands.size > 512) throw new CommandFailure("refused", "UNSUPPORTED", "caller issuance needs a nonempty bounded native command surface; no empty or truncated grant was minted", { target });
    const commands = [...service.commands.values()].sort((a, b) => a.command < b.command ? -1 : a.command > b.command ? 1 : 0);
    if (!commands.every(pairedCallerCommand)) throw new CommandFailure("refused", "UNSUPPORTED", "this caller issuer supports untargeted synchronous ephemeral commands only; targeted, journaled or goal-follow authority was not guessed or silently omitted", { target, remedy: "use a supported native issuer for the endpoint's declared target and work policy" });
    const capabilities: EpCapability[] = commands.map((command) => ({ endpoint, command: command.command }));
    return { capabilities, observation: { source: "fresh-native-resolution" as const, supportedMode: "untargeted-synchronous-ephemeral" as const, owner: service.owner, responder: { ...service.responder }, instancePinned: false, commands: commands.map((command) => ({ command: command.command, class: command.class, capability: command.capability, inputDigest: command.contract.input.closureDigest, outputDigest: command.contract.output.closureDigest })) } };
  } catch (error) { throw endpointFailure(error, target, false); }
  finally { if (connection) await connection.nc.close(); }
}

interface EndpointCallerReceipt {
  kind: "endpoint-caller-written";
  name: string;
  space: string;
  endpoint: string;
  requestId: string;
  intentPath: string;
  identity: string;
  lifecycleUid: string;
  owner: string;
  output: string;
  channels: string[];
  expiresAt: number | null;
  scope: Awaited<ReturnType<typeof callerSurface>>["observation"];
  nativeProvisioning: "acknowledged";
  managedSpawnSupport: false;
  seatStarted: false;
  secretOnStdout: false;
  cleanup: "not-checked";
  changed: Record<string, unknown>[];
}

/** Native agent provisioning with explicit endpoint rows, not a hand-written permission profile.
 *  An immutable non-secret intent precedes the first footprint operation and blocks blind replay. */
export async function mintEndpointCaller(args: ParsedArgs): Promise<void> {
  validateCredentialMintArguments(args);
  if (typeof args.values.endpoint !== "string") throw new CommandFailure("refused", "USAGE_INVALID", "this caller action requires an explicit --endpoint class; no fixed-profile request was reinterpreted");
  const values = args.values, name = args.positionals[0]!, endpoint = String(values.endpoint), out = resolve(String(values.out));
  const requestId = randomUUID(), intentPath = `${out}.issuance.json`;
  const channels = String(values.channels ?? "").split(",").map((channel) => channel.trim()).filter(Boolean);
  let target: Record<string, unknown> = { name, endpoint, path: out, intentPath };
  const changed: Record<string, unknown>[] = [];
  let intentAttempted = false, submitted = false, closeConfirmed = false;
  let held: ReturnType<typeof acquireLock> | undefined, provisioner: CotalEndpoint | undefined;
  let result: EndpointCallerReceipt | undefined;
  try {
    const { target: selected, auth, currentRoot } = await staticMintAuthority(values as { space?: string; server?: string }, target);
    target = { ...target, space: selected.space };
    if (!selected.auth || selected.auth.account.pub !== auth.account.pub) throw new CommandFailure("refused", "CONFLICT", "the registered broker target and caller signer do not share one native account authority", { target });
    assertExternalCredentialExport(out, [selected.root, currentRoot]);
    assertExternalCredentialExport(intentPath, [selected.root, currentRoot]);
    protectedLocalDirectory(dirname(out));
    held = acquireLock(`${out}.mint.lock`, { label: "endpoint caller output", waitMs: 0, onTimeout: () => new CommandFailure("refused", "CONFLICT", "another writer holds the endpoint caller output", { target }) });
    if (lstatSync(out, { throwIfNoEntry: false })) throw new CommandFailure("refused", "CONFLICT", "the caller output already exists; it was not replaced and no new caller was provisioned", { target });
    if (lstatSync(intentPath, { throwIfNoEntry: false })) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an original caller issuance intent is retained; no second identity or footprint was allocated", { target, remedy: "inspect the original private intent, identity/lifecycle and output before a new issuance; an absent output is not proof of no footprint" });
    const scope = await callerSurface({ root: selected.root, space: selected.space, server: selected.server, account: auth.account.pub, tlsRequired: selected.tlsRequired }, endpoint);
    const identity = newIdentity(), lifecycleUid = mintLifecycleUid();
    target = { ...target, requestId, identity: identity.id, lifecycleUid };
    const intent = standaloneCallerIntent({ schemaVersion: 1, kind: "endpoint-caller-issuance-intent", requestId, createdAt: new Date().toISOString(), space: selected.space, endpoint, identity: identity.id, owner: DEV_OWNER, lifecycleUid, output: out, channels, expiresInSeconds: values["expires-in"] === undefined ? null : Number(values["expires-in"]), scope: scope.observation, phase: "local-intent-only", secretIncluded: false });
    intentAttempted = true;
    try { writeSecretFileCreateOnly(intentPath, JSON.stringify(intent, null, 2) + "\n"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") { intentAttempted = false; throw new CommandFailure("refused", "CONFLICT", "another issuance intent appeared; it was not adopted or replaced and no footprint was submitted", { target }); }
      throw error;
    }
    changed.push({ kind: "private-issuance-intent", path: intentPath, requestId, acknowledged: true });
    // start() and provisionAgent may affect broker state. The original intent is already durable;
    // any failure from here retains it and never issues another identity automatically.
    submitted = true;
    provisioner = new CotalEndpoint({ space: selected.space, servers: selected.server, tls: selected.tlsRequired, creds: await mintCreds(auth, newIdentity(), "provisioner"), channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false, card: { name: "endpoint-caller-provisioner", role: "provisioner", kind: "endpoint" } });
    provisioner.on("error", () => {});
    await provisioner.start();
    const creds = await provisionAgent(provisioner, auth, identity, { lifecycleUid, capabilities: [], endpointCapabilities: scope.capabilities, allowSubscribe: channels, allowPublish: channels, subscribe: channels, ...(values["expires-in"] === undefined ? {} : { expiresInSeconds: Number(values["expires-in"]) }) });
    changed.push({ kind: "native-caller-footprint", identity: identity.id, lifecycleUid, acknowledged: true });
    if (identityFromCreds(creds).id !== identity.id) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native caller result did not retain its intended identity; no credential bytes were published", { target, changed });
    protectedLocalDirectory(dirname(out));
    writeSecretFileCreateOnly(out, creds);
    changed.push({ kind: "private-caller-file", path: out, acknowledged: true });
    protectedCredentialReference(out);
    const actual = readLocalRecordSource(out, 1024 * 1024, true);
    if (!actual?.equals(Buffer.from(creds, "utf8"))) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the caller file publication was acknowledged but its current private bytes were not confirmed; no issuance was retried", { target, changed });
    const claims = credsClaims(creds);
    result = { kind: "endpoint-caller-written", name, space: selected.space, endpoint, requestId, intentPath, identity: identity.id, lifecycleUid, owner: DEV_OWNER, output: out, channels, expiresAt: claims.exp ?? null, scope: scope.observation, nativeProvisioning: "acknowledged", managedSpawnSupport: false, seatStarted: false, secretOnStdout: false, cleanup: "not-checked", changed };
  } catch (error) {
    if (!intentAttempted && !submitted && isCommandFailure(error)) throw error;
    if (!intentAttempted && !submitted) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "caller authority, contract or private output preparation did not complete; no standalone caller footprint was submitted", { target });
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", submitted ? "the original native caller provisioning or private publication did not confirm its outcome; the intent and any footprint/output were retained, without replay" : "the original local issuance intent publication was not confirmed; no caller provisioning was submitted and the possible intent was retained", { target, changed, remedy: "inspect the original intent, identity/lifecycle and private output; do not infer no effect from an absent credential file" });
  } finally {
    if (provisioner) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { closeConfirmed = await Promise.race([provisioner.stop().then(() => true, () => false), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 5000); })]); }
      finally { if (timer) clearTimeout(timer); }
    }
    held?.release();
  }
  if (!result) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original caller issuance has no complete result; its local intent was retained", { target, changed });
  const receipt = { ...result, provisionerClose: closeConfirmed ? "returned" : "not-confirmed" };
  writeResult(presentationOf(values), { command: "auth mint", target, result: receipt, ...(!closeConfirmed ? { completeness: "partial" as const, partial: { message: "The credential file and native footprint were acknowledged, but the temporary provisioner's close did not confirm completion within the observation bound." } } : {}) }, (row): Report => ({ sections: [{ title: "Private endpoint caller written", blocks: [
    { kind: "fields", rows: [["Label", String(row.name)], ["Space", String(row.space)], ["Endpoint", String(row.endpoint)], ["Identity", String(row.identity)], ["Lifecycle", String(row.lifecycleUid)], ["Private file", String(row.output)], ["Local issuance request", row.requestId], ["Private intent", row.intentPath], ["Caller owner", row.owner], ["Described endpoint owner", row.scope.owner], ["Observed responder", row.scope.responder.instanceId], ["Observed epoch", String(row.scope.responder.epoch)], ["Instance pin", "none; class-scoped grants"], ["Additional commands", String(row.scope.commands.length)], ["Explicit read/post channels", row.channels.join(", ") || "none"], ["Native expiry", row.expiresAt === null ? "not reported" : `${row.expiresAt} Unix seconds`], ["Provisioning", "native footprint acknowledged"], ["Provisioner close", row.provisionerClose], ["Seat", "not started"]] },
    { kind: "table", columns: [{ key: "command", label: "Observed command" }, { key: "capability", label: "Declared capability" }, { key: "class", label: "Class" }], rows: row.scope.commands.slice(0, 40).map((command) => ({ command: { text: command.command, tone: "command" as const }, capability: command.capability, class: command.class })) },
    ...(row.scope.commands.length > 40 ? [{ kind: "lines" as const, lines: [`${row.scope.commands.length - 40} more command rows are not shown; --json retains every scoped command and contract digest.`] }] : []),
    { kind: "lines", lines: ["The scoped native agent baseline remains. Additional request grants cover only the issuer-observed untargeted synchronous ephemeral commands on this endpoint; no spawn, run or admin capability was added. Targeted/journaled/action surfaces refuse instead of dropping rows. The local intent is not a grant or completion receipt. Provisioning is not presence, completed work or cleanup. Credential bytes and environment-export onboarding are not printed."] },
  ] }, { title: "Next", blocks: [{ kind: "commands", items: [
    { command: "cotal ep describe ep:<class> --space <space> --creds <private-file>", description: "Read fresh contracts using this paired native caller" },
    { command: "cotal ep invoke ep:<class> <command> --space <space> --creds <private-file> --args '<json>'", description: "Keep the same file and native synchronous scope; do not reissue to recover output" },
    { command: "cotal ep add <name> --file <reference.json>", description: "Optionally save the same protected file reference without granting authority" },
  ] }] }] }));
}
