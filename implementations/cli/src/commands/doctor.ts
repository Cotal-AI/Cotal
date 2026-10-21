import { existsSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import {
  credentialLifetime,
  CotalEndpoint,
  inspectCredHealth,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  probeConnect,
  type CredHealth,
  type CredentialKind,
  type FlagValues,
  type ParsedArgs,
} from "@cotal-ai/core";
import {
  CommandFailure, accountInventory, canonicalRoot, isCommandFailure, jsonFlag, plainFlag, presentationOf, readLocalRecordSource, renewalRecordPath, writeResult,
  agentCredsDir,
  authDir,
  CONNECTION_EVICTOR_CREDS_KIND,
  DELIVERY_CREDS_KIND,
  findCotalRoot,
  getSoleSpaceAuth,
  getSpaceAuth,
  hasUserAuthState,
  legacyRenewalRecord,
  MEMBERSHIP_OBSERVER_CREDS_KIND,
  MEMBERSHIP_RW_CREDS_KIND,
  MeshTargetError,
  migrateLegacyCotalMaterial,
  preflightTarget,
  remintDaemonCreds,
  type Report,
  resolveMeshTarget,
  spaceAccountPath,
  staleSystemCreds,
  type StaleSystemCred, type MaterialMigrationReceipt,
  workspaceSecretStore,
  writeRenewalRecord,
  recordOperationSpace,
} from "@cotal-ai/workspace";
import { displayCmd } from "../lib/self-exec.js";
import { RESPONDER_UNBOUND_CONSEQUENCE } from "../lib/delivery-responder.js";

export const doctorFlags = [jsonFlag, plainFlag,
  { name: "fix", type: "boolean", description: "execute the safe repairs (re-sign the manager-remintable daemon creds; needs the local signer)" },
  { name: "space", type: "string", description: "target space on a multi-space root (default: the sole space)" },
] as const;

/** One inspected credential file: where it lives, what the matrix says it is, and how it looks. */
interface CredReport {
  label: string;
  kind: CredentialKind;
  path: string;
  health?: CredHealth; // undefined = file missing
  /** A finding that must block `healthy`, with its exact repair. */
  problem?: string;
  repair?: string;
  /** An expired incarnation file whose alias HAS a live successor on disk (#1576). Rendered, and
   *  given a cleanup, but deliberately NOT a `problem`: it is a leftover file, not a broken agent,
   *  and counting it as one is what reported a healthy fleet as 15 failures. */
  superseded?: boolean;
}

/** `cotal doctor auth` — the ONE stale-credential repair surface (D5 slice 6). Read-only diagnosis
 *  of every managed credential file in this folder against the credential-lifetime matrix, rendered
 *  as healthy / near-expiry (yellow) / expired / unreadable (red) with the LAST-RENEWAL timestamp
 *  for manager-reminted creds — ending in either `healthy` or the exact next command (exit 1).
 *  `--fix` executes the one safe local repair (re-sign the class-2 daemon files for their existing
 *  nkeys); $SYS and agent creds are never auto-fixed — their repairs are printed, not guessed. */
interface RepairObservation {
  requested: boolean;
  attempted: boolean;
  authority: "lease" | "offline" | null;
  results: { file: string; ok: boolean; skipped: boolean }[];
  migrationAttempted: boolean;
  migrations: MaterialMigrationReceipt[];
  coordinationCleanup: "not-opened" | "confirmed" | "unconfirmed";
}

export function validateDoctorArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  if (args.positionals.length !== 1 || args.positionals[0] !== "auth") throw new CommandFailure("refused", "USAGE_INVALID", "use doctor auth [--fix] [--space <space>] [--json|--plain]");
}

/** Local credential observations only; native repair remains an explicit, separately labeled phase. */
export async function doctor(args: ParsedArgs): Promise<void> {
  validateDoctorArguments(args);
  const values = args.values as FlagValues<typeof doctorFlags>;
  const root = findCotalRoot(process.cwd());
  const repair: RepairObservation = { requested: values.fix === true, attempted: false, authority: null, results: [], migrationAttempted: false, migrations: [], coordinationCleanup: "not-opened" };
  if (!values.space) {
    // Several valid accounts are a target the caller picks with --space, not an inventory that failed
    // validation. An unreadable or corrupt inventory still refuses as SCHEMA_INVALID below.
    let spaces: string[] = [];
    try { const inventory = accountInventory(authDir(root)); if (!inventory.corrupt.length) spaces = inventory.spaces; } catch { /* refused by the read below */ }
    if (spaces.length > 1) throw new CommandFailure("refused", "TARGET_AMBIGUOUS", `this root holds accounts for ${spaces.length} spaces (${spaces.join(", ")}); doctor auth diagnoses one space`, { target: { root, space: null, candidates: spaces }, remedy: `pass --space with one of ${spaces.join(", ")}` });
  }
  let auth: Awaited<ReturnType<typeof getSpaceAuth>>;
  try { auth = values.space ? await getSpaceAuth(workspaceSecretStore(root), values.space) : await getSoleSpaceAuth(workspaceSecretStore(root), authDir(root)); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the local authority inventory could not be validated; no repair was attempted", { target: { root, space: values.space ?? null } }); }
  if (!auth) {
    if (values.fix || values.space) throw new CommandFailure("refused", "AUTH_REQUIRED", "no validated signing trust for the named local diagnostic scope is present; no open mode or broader authority was inferred", { target: { root, space: values.space ?? null } });
    writeResult(presentationOf(values), { command: "doctor auth", target: { root }, result: { kind: "credential-health", root, space: null, localFindings: null, credentialScope: "not-established", brokerAuthorization: "not-checked", repair }, completeness: "not-checked", partial: { message: "No local static authority was established. This is not proof of an open or healthy mesh." } }, () => ({ sections: [{ title: "Local credential scope not established", blocks: [{ kind: "fields", rows: [["Root", root], ["Space", "not established"], ["Live authorization", "not checked"], ["Repair", "not requested"]] }] }] }));
    return;
  }
  const target = { root, space: auth.space };
  let reports: CredReport[];
  let userMode: boolean;
  try {
    userMode = hasUserAuthState(root, auth.space, { readOnly: true });
    if (values.fix && userMode) throw new CommandFailure("refused", "UNSUPPORTED", "this static daemon repair cannot replace a user-auth space's supported issuer authority", { target });
    repair.migrationAttempted = values.fix === true;
    reports = inventory(root, auth.space, auth.sys.pub, !values.fix, (receipt) => repair.migrations.push(receipt));
    if (values.fix && reports.some((row) => row.problem && isRemintable(row.kind))) await repairDoctorCredentials(root, auth, repair);
    if (repair.attempted) reports = inventory(root, auth.space, auth.sys.pub, true);
  } catch (error) {
    const changed = [...repair.migrations.map((receipt) => ({ kind: "credential-material-migrated", materialKind: receipt.kind, from: receipt.from, to: receipt.to, space: receipt.space })), ...repair.results.filter((row) => row.ok).map((row) => ({ kind: "daemon-credential-resigned", file: row.file, space: auth!.space }))];
    if (isCommandFailure(error) && !repair.attempted && !repair.migrations.length) throw error;
    if (changed.length) throw new CommandFailure("partial", "OPERATION_PARTIAL", "native local credential material changed, but the final diagnostic/audit or coordination cleanup was not confirmed", { target, changed, remedy: "inspect the original local files and renewal owner; do not respawn agents or rotate the system account as an automatic substitute" });
    throw new CommandFailure(repair.attempted || repair.migrationAttempted ? "unknown" : "failed", repair.attempted || repair.migrationAttempted ? "OPERATION_UNKNOWN" : "OPERATION_FAILED", repair.attempted || repair.migrationAttempted ? "the native daemon repair outcome is unconfirmed; no re-sign was retried" : "local credential observations could not be completed; raw credential and parser diagnostics were not printed", { target });
  }
  const renewal = renewalObservation(root, auth.space);
  const items = reports.map((row) => ({
    label: row.label, kind: row.kind, path: row.path, state: row.superseded ? "superseded-local-file" : row.health?.state ?? "not-provisioned-here",
    issuedAt: Number.isFinite(row.health?.iat) ? row.health!.iat! : null,
    expiresAt: Number.isFinite(row.health?.exp) ? row.health!.exp! : null,
    renewAt: Number.isFinite(row.health?.renewAt) ? row.health!.renewAt! : null,
    problem: row.health?.state === "unreadable" ? "credential parsing failed; raw diagnostic omitted" : row.problem ?? null,
    repair: row.repair ?? null, superseded: row.superseded === true,
  }));
  const findings = items.filter((row) => row.problem !== null).length;
  const refused = renewal.state === "present" && renewal.brokerAcceptance === "recorded-refusal";
  const incomplete = renewal.state === "unreadable";
  const result = { kind: "credential-health", root, space: auth.space, mode: userMode ? "user" : "static", scope: "local credential claims and recorded renewal only", items, findings, renewal, repair, brokerAuthorization: "not-checked", liveAgentHealth: "not-checked", systemAccountRotated: false, agentCredentialsReminted: false };
  // A recorded refusal names the renewal owner to repair, so the finding keeps its next step.
  const failure = incomplete ? new CommandFailure("partial", "OPERATION_PARTIAL", "credential observations were collected but the renewal record is unreadable; a complete healthy verdict was not inferred", { target }) : findings || refused ? new CommandFailure(repair.results.some((row) => row.ok) || repair.migrations.length ? "partial" : "failed", repair.results.some((row) => row.ok) || repair.migrations.length ? "OPERATION_PARTIAL" : "OPERATION_FAILED", refused ? "the recorded renewal was not broker-accepted; local re-signing alone cannot clear that finding" : "local credential findings remain; per-file native repair guidance is retained", { target, ...(refused ? { remedy: "start or repair this space's manager, the renewal owner, so it re-signs the daemon credentials and the broker accepts them; do not respawn agents for this finding" } : {}) }) : undefined;
  writeResult(presentationOf(values), { command: "doctor auth", target, result, completeness: incomplete ? "partial" : "complete", failure, noOp: failure === undefined && values.fix === true && !repair.attempted && !repair.migrations.length }, (data): Report => ({ sections: [
    { title: data.findings || refused || incomplete ? "Credential findings" : "No local credential findings", blocks: [
      { kind: "fields", rows: [["Root", data.root], ["Space", data.space], ["Mode", data.mode], ["Scope", data.scope], ["Current broker authorization", { text: "not checked", tone: "waiting" }], ["Live agent health", { text: "not checked", tone: "waiting" }], ["Repair requested", data.repair.requested ? "yes" : "no"], ["Acknowledged local migrations", String(data.repair.migrations.length)], ["Repair coordination", data.repair.authority ?? "not used"]] },
      { kind: "lines", lines: [{ text: "Credential expiry/claim inspection is not live broker acceptance, daemon adoption, process health or task progress. Locally ordered superseded files are not proof that their successor is connected. No agent was respawned and no system account was rotated.", tone: "hint" }] },
    ] },
    { title: "Local credential files", blocks: [
      { kind: "table", columns: [{ key: "name", label: "Credential" }, { key: "state", label: "Local state" }, { key: "issued", label: "Issued" }, { key: "expiry", label: "Expiry" }], rows: data.items.slice(0, 200).map((row) => ({ name: row.label, state: row.state, issued: at(row.issuedAt ?? undefined), expiry: at(row.expiresAt ?? undefined) })) },
      ...(data.items.length > 200 ? [{ kind: "lines" as const, lines: [`${data.items.length - 200} credential rows are not shown; JSON retains every public diagnostic row.`] }] : []),
    ] },
    { title: "Recorded renewal", blocks: [{ kind: "fields", rows: [["Record", data.renewal.state], ["Recorded time", data.renewal.recordedAt ?? "not established"], ["Recorded owner", data.renewal.recordedOwner ?? "not established"], ["Broker acceptance at that pass", data.renewal.brokerAcceptance], ["Recorded coordination", data.renewal.authority ?? "not recorded"], ["Delivery responder at that pass", data.renewal.deliveryResponderUnbound ? "reported unbound" : "not established by this view"]] }, ...(data.renewal.deliveryResponderUnbound ? [{ kind: "lines" as const, lines: [RESPONDER_UNBOUND_CONSEQUENCE, "Repair the original delivery responder and inspect status; do not respawn agents merely because a responder was absent at that recorded pass."] }] : []),
      // The leftover root-scoped record is named, never read as this space's verdict.
      ...("legacyRecordPresent" in data.renewal && data.renewal.legacyRecordPresent ? [{ kind: "lines" as const, lines: [`This root also holds .cotal/renewal.json, a pre-per-space renewal record. It names no space, so it is not read as this space's verdict. ${displayCmd()} clean all --force removes it when this root is reset.`] }] : [])] },
    ...(data.items.some((row) => row.problem !== null || row.superseded) ? [{ title: "Inspect before changing identities", blocks: [{ kind: "table" as const, columns: [{ key: "name", label: "Credential" }, { key: "finding", label: "Finding" }, { key: "next", label: "Native guidance" }], rows: data.items.filter((row) => row.problem !== null || row.superseded).slice(0, 200).map((row) => ({ name: row.label, finding: row.problem ?? "superseded in local credential family; not a broken-agent verdict", next: row.repair ?? "inspect the original file and authority" })) }] }] : []),
  ] }));
}

async function repairDoctorCredentials(root: string, auth: NonNullable<Awaited<ReturnType<typeof getSpaceAuth>>>, observed: RepairObservation): Promise<void> {
  let target: ReturnType<typeof resolveMeshTarget> | undefined;
  try {
    target = resolveMeshTarget(root, { space: auth.space, readOnly: true });
    recordOperationSpace(target.space);
    if (target.mode !== "auth" || canonicalRoot(target.root) !== canonicalRoot(root) || target.auth?.account.pub !== auth.account.pub) throw new CommandFailure("refused", "CONFLICT", "the resolved repair target differs from this local static authority; no broader root or auth mode was substituted");
    const preflight = await preflightTarget(target);
    if (!preflight.ok) {
      if (preflight.kind.includes("creds") || preflight.kind === "stale-auth") throw new CommandFailure("refused", "AUTH_REQUIRED", "the selected broker's authenticated preflight failed; it was not called an offline repair target");
      target = undefined;
    }
  } catch (error) {
    if (error instanceof MeshTargetError && ["unknown-space", "no-meshes", "not-started"].includes(error.code)) target = undefined;
    else throw error;
  }
  const prior = renewalObservation(root, auth.space);
  if (prior.state === "unreadable") throw new CommandFailure("refused", "SCHEMA_INVALID", "the prior renewal record is unreadable; a possible broker refusal was not overwritten");
  let results: Awaited<ReturnType<typeof remintDaemonCreds>>;
  const retain = (rows: Awaited<ReturnType<typeof remintDaemonCreds>>) => { observed.results = rows.map((row) => ({ file: row.file, ok: row.ok === true, skipped: row.skipped !== undefined })); };
  if (target) {
    const uid = mintLifecycleUid(), identity = newIdentity();
    const ep = new CotalEndpoint({ space: target.space, servers: target.server, tls: target.tlsRequired, creds: await mintCreds(auth, identity, "supervisor", { lifecycleUid: uid }), lifecycleUid: uid, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false, card: { id: identity.id, name: "doctor-auth-fix", kind: "endpoint" } });
    ep.on("error", () => {});
    let held = false;
    try {
      await ep.start();
      held = await ep.holdDaemonRenewalLease(`doctor:${hostname()}:${process.pid}`);
      if (!held) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "another native renewal owner holds the lease; no daemon credential was re-signed");
      observed.authority = "lease";
      observed.attempted = true;
      results = await remintDaemonCreds(root, auth.space, undefined, { preflight: async (creds) => (await probeConnect(target!.server, { creds, tls: target!.tlsRequired })).ok === true });
      retain(results);
    } finally {
      let cleanupError: unknown;
      if (held) try { await ep.releaseDaemonRenewalLease(); } catch (error) { cleanupError = error; }
      try { await ep.stop(); } catch (error) { cleanupError ??= error; }
      observed.coordinationCleanup = cleanupError === undefined ? "confirmed" : "unconfirmed";
      if (cleanupError) throw cleanupError;
    }
  } else {
    observed.authority = "offline";
    observed.attempted = true;
    results = await remintDaemonCreds(root, auth.space);
    retain(results);
  }
  const adoption = prior.brokerAcceptance === "recorded-refusal" ? { ok: false, error: "re-signed locally by doctor auth --fix; the previous broker refusal remains unproven until the native renewal owner proves and adopts the generation" } : undefined;
  writeRenewalRecord(root, auth.space, { ts: new Date().toISOString(), owner: "doctor --fix", results, adoption, authority: observed.authority! });
}

function renewalObservation(root: string, space: string) {
  const absent = { state: "absent" as "absent" | "unreadable" | "present", recordedAt: null as string | null, recordedOwner: null as string | null, authority: null as string | null, brokerAcceptance: "not-recorded", deliveryResponderUnbound: false };
  try {
    const bytes = readLocalRecordSource(renewalRecordPath(root, space), 1024 * 1024, true);
    if (!bytes) return { ...absent, legacyRecordPresent: legacyRenewalRecord(root) !== undefined };
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
    if (!value || typeof value !== "object" || typeof value.ts !== "string" || !Number.isFinite(Date.parse(value.ts)) || typeof value.owner !== "string" || !Array.isArray(value.results)) throw new Error();
    const adoption = value.adoption as { ok?: unknown; error?: unknown } | undefined;
    if (adoption !== undefined && (!adoption || typeof adoption !== "object" || typeof adoption.ok !== "boolean")) throw new Error();
    return { state: "present" as const, recordedAt: value.ts, recordedOwner: value.owner, authority: value.authority === "lease" || value.authority === "offline" ? value.authority : null, brokerAcceptance: adoption === undefined ? "not-requested-by-that-pass" : adoption.ok ? "recorded-acceptance" : "recorded-refusal", deliveryResponderUnbound: responderUnboundAtLastRenewal(typeof adoption?.error === "string" ? adoption.error : undefined), legacyRecordPresent: legacyRenewalRecord(root) !== undefined };
  } catch { return { ...absent, state: "unreadable" as const, brokerAcceptance: "not-established", legacyRecordPresent: false }; }
}

function isRemintable(kind: CredentialKind): boolean {
  return kind === "delivery" || kind === "membership-rw";
}

/** Local filename/issued-at ordering only. No role here proves a connected or running successor. */
type AgentFileRole = "current" | "superseded" | "sole";
interface LocalCredentialFamily { role: AgentFileRole }

function agentRepair(path: string, family?: LocalCredentialFamily): string {
  if (family?.role === "superseded") return `an older local incarnation file exists at ${path}; inspect its exact lifecycle and owner before removing it. File ordering alone proves no live successor. Do not respawn an agent from this finding`;
  return `inspect this original lifecycle under its manager; supported managed renewal can re-sign the same nkey without a replacement. Do not spawn another agent only because a local file expired`;
}

function agentUnrenewableRepair(): string {
  return "native renewal skips unbounded or unreadable material; inspect the exact lifecycle and authority before choosing an explicit replacement. This diagnosis does not prove the agent is stopped or authorize a blind respawn";
}

/** Classify every `agent` file by alias family, so a superseded incarnation is never reported as a
 *  broken fleet (#1576 ask 3).
 *
 *  PURELY ON-DISK, AND DELIBERATELY SO. `doctor auth` is the OFFLINE credential surface: it resolves
 *  no mesh, opens no connection and, on a user-auth mesh, is forbidden to mint at all. The filename
 *  grammar already carries the answer — `agentIncarnationBase` writes `<alias>.<lifecycleUid>` and
 *  refuses `.` inside a standing alias, so the two families are structurally disjoint and an alias's
 *  incarnations are enumerable without asking anyone. Ordering is by issued-at (`iat`), which is the
 *  credential's own claim rather than a filesystem timestamp a copy would destroy. */
function classifyAgentFamilies(reports: CredReport[]): Map<string, AgentFileRole> {
  const byAlias = new Map<string, CredReport[]>();
  for (const r of reports) {
    if (r.kind !== "agent" || !r.health) continue;
    const alias = aliasOf(r.label);
    const family = byAlias.get(alias);
    if (family) family.push(r);
    else byAlias.set(alias, [r]);
  }
  const roles = new Map<string, AgentFileRole>();
  for (const [, family] of byAlias) {
    const incarnations = family.filter((r) => incarnationUidOf(r.label) !== undefined);
    // A single file (standing or lone incarnation) is nobody's predecessor: leave it a real finding.
    if (incarnations.length < 2) {
      for (const r of family) roles.set(r.label, "sole");
      continue;
    }
    // Newest `iat` wins. A file with no readable `iat` cannot be ordered, so it is never promoted to
    // `current` and never demoted to `superseded` — an unorderable file keeps its own verdict rather
    // than being explained away by a neighbour.
    let newest: CredReport | undefined;
    for (const r of incarnations) {
      if (r.health?.iat === undefined) continue;
      if (newest?.health?.iat === undefined || r.health.iat > newest.health.iat) newest = r;
    }
    for (const r of family) {
      if (r === newest) roles.set(r.label, "current");
      else if (newest && incarnationUidOf(r.label) !== undefined && r.health?.iat !== undefined) roles.set(r.label, "superseded");
      else roles.set(r.label, "sole");
    }
  }
  return roles;
}

/** The lifecycle uid of an incarnation filename, or undefined for a standing `<alias>.creds`. The
 *  grammar is the one `agentIncarnationBase` writes: a 26-32 char lowercase-alphanumeric token. */
function incarnationUidOf(label: string): string | undefined {
  const base = label.replace(/\.sentinel\.creds$|\.actor-token$|\.creds$/, "");
  const m = /^(.+)\.([a-z0-9]{26,32})$/.exec(base);
  return m ? m[2] : undefined;
}

/** The agent ALIAS a credential filename belongs to — the part before the lifecycle uid, or the
 *  whole base for a standing file. Two incarnations of one agent share this; two agents never do. */
function aliasOf(label: string): string {
  const base = label.replace(/\.sentinel\.creds$|\.actor-token$|\.creds$/, "");
  const m = /^(.+)\.([a-z0-9]{26,32})$/.exec(base);
  return m ? m[1] : base;
}

/** Inspect every managed credential file for this folder. Missing files are noted (with how they
 *  get provisioned) but only EXISTING-but-bad material is a problem — process presence is `cotal
 *  status`'s job; this surface owns credential health. */
function inventory(root: string, space: string, sysPub?: string, readOnly = false, onMigrated?: (receipt: MaterialMigrationReceipt) => void): CredReport[] {
  // Through the choke point, not a hand-composed `.cotal/<file>` (P7 §2 rule 1). The four kinds are
  // per-space now, and a diagnosis that read the canonical location past an unmigrated copy would
  // report every one of them "missing" on a root `up` has not re-provisioned — the worst possible
  // answer from the surface an operator reaches for when something is already wrong. The LABEL stays
  // the kind, which is what the operator reads and what `staleSystemCreds` keys its answer by.
  const at = (kind: string) => migrateLegacyCotalMaterial(root, space, kind, { readOnly, onMigrated });
  const fixed: Array<{ label: string; kind: CredentialKind; path: string }> = [
    { label: DELIVERY_CREDS_KIND, kind: "delivery", path: at(DELIVERY_CREDS_KIND) },
    { label: MEMBERSHIP_RW_CREDS_KIND, kind: "membership-rw", path: at(MEMBERSHIP_RW_CREDS_KIND) },
    { label: MEMBERSHIP_OBSERVER_CREDS_KIND, kind: "membership-observer", path: at(MEMBERSHIP_OBSERVER_CREDS_KIND) },
    { label: CONNECTION_EVICTOR_CREDS_KIND, kind: "connection-evictor", path: at(CONNECTION_EVICTOR_CREDS_KIND) },
  ];
  // Ask the staleness question ONCE, through the same helper the boot path uses, so `doctor auth`
  // and `cotal up` can never disagree about which $SYS creds the trust record authorizes.
  const stale = new Map(sysPub ? staleSystemCreds(root, sysPub, space, { readOnly, onMigrated }).map((x) => [x.file, x] as const) : []);
  const reports = fixed.map((f) => report(f.label, f.kind, f.path, sysPub, stale.get(f.label)));
  // Same posture for the per-agent secrets (P1), and for the same reason: this space's segment
  // through the choke point, never `join(authDir(root), "creds")`, so an operator running `doctor`
  // on a root that has not migrated yet sees their agents' creds rather than an empty inventory. It
  // is also what keeps the report SPACE-scoped now that the dir holds every tenant's segment — a
  // diagnosis must not name a co-resident tenant's material.
  const agentDir = agentCredsDir(root, space, { readOnly, onMigrated });
  if (existsSync(agentDir)) {
    for (const f of readdirSync(agentDir).filter((f) => f.endsWith(".creds") && !f.endsWith(".sentinel.creds")).sort()) {
      reports.push(report(basename(f), "agent", join(agentDir, f)));
    }
  }
  // SECOND PASS over the agent files (#1576). Supersession is a property of an alias's FAMILY, not of
  // a file, so it cannot be decided while the files are still being read one at a time — which is
  // exactly why the old single pass reported 15 leftovers as a broken fleet. Now each family is
  // classified once every member is known, and the affected rows are re-derived with that role.
  const roles = classifyAgentFamilies(reports);
  return reports.map((r) =>
    r.kind === "agent" && r.health ? report(r.label, r.kind, r.path, undefined, undefined, { role: roles.get(r.label) ?? "sole" }) : r,
  );
}

function report(label: string, kind: CredentialKind, path: string, sysPub?: string, stale?: StaleSystemCred, live?: LocalCredentialFamily): CredReport {
  let health: CredHealth;
  try {
    const bytes = readLocalRecordSource(path, 1024 * 1024, true);
    if (!bytes) return { label, kind, path };
    health = inspectCredHealth(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (isCommandFailure(error) && error.code === "UNSUPPORTED") throw error;
    health = { state: "unreadable", error: "protected credential could not be read or parsed" };
  }
  const r: CredReport = { label, kind, path, health };
  const policy = credentialLifetime(kind);
  const standing = policy.class === "standing-renewable" || policy.class === "rotation-renewed";
  const repair = isRemintable(kind)
    ? `${displayCmd()} doctor auth --fix   (or start the mesh's manager - it is the renewal owner and re-signs + reloads these every half-TTL)`
    : kind === "agent"
      ? agentRepair(path, live)
        // The $SYS pair. A plain `down` + `up` does NOT touch these: `up` mints them only on the
        // branch that CREATES the trust record, so re-upping an existing space reuses the same
        // expired files and reports success. The rotation must be asked for.
      : `system-account rotation: \`${displayCmd()} down\` then \`${displayCmd()} up --rotate-sys\` re-mints the $SYS material (the space, its agents, its creds and its data are untouched)`;
  // A $SYS cred is only usable if the system account that SIGNED it is the one the broker loads,
  // i.e. the one in this root's trust record. Expiry alone cannot see a RETIRED issuer: a rotation
  // that committed the record and then died leaves a file that is structurally valid and years from
  // expiry, yet broker-dead. Without this the doctor reported `auth: healthy` over exactly that
  // split, which is the false green this whole surface exists to prevent. Answered by the SAME
  // helper the boot path uses, so the two surfaces cannot drift on what "stale" means. Checked
  // before the health switch, so it wins over a merely-healthy verdict.
  if (stale && sysPub) {
    r.problem = stale.iss ? `the claimed system-account issuer ${stale.iss} differs from this root's ${sysPub}; current broker acceptance is not checked` : "the system-account issuer could not be established; current broker acceptance is not checked";
    r.repair = repair;
    return r;
  }
  switch (health.state) {
    case "unreadable":
      r.problem = `unreadable credential file (${health.error})`;
      // Unreadable material cannot be re-signed, so the honest agent remedy here is the respawn
      // the old code gave to every case — this is the ONE case it fitted.
      r.repair = kind === "agent" && live?.role !== "superseded" ? agentUnrenewableRepair() : repair;
      break;
    case "expired":
      // #1576 ASK 3. A SUPERSEDED incarnation is expected to be expired — that is what supersession
      // MEANS: the daemon re-minted the alias, the successor is live and listed, and this file is the
      // husk of the incarnation it replaced. Reporting it as "EXPIRED - the broker denies this
      // credential" is true of the FILE and false about the FLEET, and it is what made a healthy
      // 30-agent deployment read as 15 broken agents. It stays visible as a superseded leftover with
      // a cleanup, but it is no longer a problem, so it no longer poisons the exit code.
      if (live?.role === "superseded") {
        r.superseded = true;
        r.repair = agentRepair(path, live);
        break;
      }
      r.problem = "EXPIRED - the broker denies this credential";
      r.repair = repair;
      break;
    case "near-expiry":
      if (standing) {
        r.problem = `past its renewal point (renewal owner: ${policy.renewalOwner}) - expires ${at(health.exp)}`;
        r.repair = repair;
      }
      break;
    case "unbounded":
      // A credential with no expiry claim stays valid until its signer rotates, whatever its kind,
      // so it is a finding even where no renewal owner bounds it.
      r.problem = standing
        ? "unbounded standing credential (minted before the renewal slice) - a copied cred never dies"
        : "unbounded credential (no expiry claim) - a copied cred never dies";
      r.repair = kind === "agent" && live?.role !== "superseded" ? agentUnrenewableRepair() : repair;
      break;
  }
  return r;
}

/** Did the last renewal pass fail because the delivery-admin rail had NO RESPONDER (#1576)?
 *
 *  Matched on the manager's own recorded sentence for that case. A TIMEOUT is deliberately excluded:
 *  a hung rail is a bound responder that did not answer in time, which is a different fault with a
 *  different repair, and the daemon-side helper that classifies this rail draws the same line. */
function responderUnboundAtLastRenewal(error?: string): boolean {
  if (!error || /timeout/i.test(error)) return false;
  return /no delivery-admin responder|no responders/i.test(error);
}

function at(sec?: number): string {
  if (sec === undefined) return "not reported";
  const date = new Date(sec * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "not representable as a date";
}
