import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  credentialLifetime,
  inspectCredHealth,
  type CredHealth,
  type CredentialKind,
  type FlagValues,
  type ParsedArgs,
} from "@cotal-ai/core";
import {
  agentCredsDir,
  authDir,
  CONNECTION_EVICTOR_CREDS_KIND,
  DELIVERY_CREDS_KIND,
  findCotalRoot,
  getSoleSpaceAuth,
  getSpaceAuth,
  hasUserAuthState,
  MEMBERSHIP_OBSERVER_CREDS_KIND,
  MEMBERSHIP_RW_CREDS_KIND,
  migrateLegacyCotalMaterial,
  readRenewalRecord,
  remintDaemonCreds,
  spaceAccountPath,
  staleSystemCreds,
  type StaleSystemCred,
  workspaceSecretStore,
  writeRenewalRecord,
} from "@cotal-ai/workspace";
import { displayCmd } from "../lib/self-exec.js";
import { RESPONDER_UNBOUND_CONSEQUENCE } from "../lib/delivery-responder.js";
import { c } from "../ui.js";

export const doctorFlags = [
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
export async function doctor(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[0];
  if (sub !== "auth") {
    console.error(`usage: ${displayCmd()} doctor auth [--fix] [--space <s>]  - credential-health diagnosis + repair for this folder's mesh`);
    process.exitCode = 1;
    return;
  }
  const values = args.values as FlagValues<typeof doctorFlags>;
  const root = findCotalRoot(process.cwd());
  const auth = values.space ? await getSpaceAuth(workspaceSecretStore(root), values.space) : await getSoleSpaceAuth(workspaceSecretStore(root), authDir(root));

  console.log(c.bold("cotal doctor auth"));
  console.log(`  root ${root}`);
  if (!auth) {
    // An explicitly named space that has no record is a selection error, never "healthy" —
    // falling through to the open-mesh answer would turn a typo into a green diagnosis.
    if (values.space) {
      console.error(c.red(`\n✗ no account record for space "${values.space}" under ${authDir(root)} (expected ${spaceAccountPath(authDir(root), values.space)})`));
      process.exitCode = 1;
      return;
    }
    // An open mesh has no minted credentials at all — nothing to diagnose is a healthy answer,
    // not a silent one.
    console.log(c.green("\nauth: healthy - open mesh (no credential material in this folder)"));
    return;
  }
  const userMode = hasUserAuthState(root, auth.space);
  // A legacy monolith root genuinely holds the signer in auth.json until a write splits it.
  const acctPath = spaceAccountPath(authDir(root), auth.space);
  const signerPath = existsSync(acctPath) ? acctPath : join(authDir(root), "auth.json");
  console.log(`  space ${auth.space}${userMode ? " · user-auth" : ""} · signer ${c.green("present")} (${signerPath})`);

  let reports = inventory(root, auth.space, auth.sys.pub);
  let problems = reports.filter((r) => r.problem);

  // --fix: the one safe local repair — re-sign the remintable daemon files (same nkeys), exactly
  // what the manager's renewal pass does, and record the pass so the audit trail stays honest
  // (adoption is the DAEMON's explicit reload, which only the running manager requests — a doctor
  // fix without a live manager is adopted by the daemon's own 75% renewal timer). Then re-diagnose:
  // the doctor reports what IS, never what it hopes the fix did.
  if (values.fix && problems.some((r) => isRemintable(r.kind))) {
    console.log(c.dim("\n--fix: re-signing the remintable daemon creds…"));
    const prior = readRenewalRecord(root);
    const results = await remintDaemonCreds(root, auth.space); // validate the signer against THIS folder's space
    // A local re-sign is NOT a broker proof: `--fix` has no live admin rail to adopt through, it
    // relies on the daemon's 75% renewal timer. So it must NEVER erase a KNOWN broker refusal to
    // green — if the last renewal was refused (e.g. the signer the broker rejects), the re-signed
    // generation is still unproven and may be broker-dead. Carry the refusal forward as an explicit
    // unproven state until a REAL proof (the manager's/daemon's reloadCreds) supersedes it, so the
    // verdict below stays exit 1 with an actionable next step. A prior non-refusal is left absent
    // (the "backstop will adopt" state), unchanged from before.
    const adoption = prior?.adoption?.ok === false
      ? { ok: false, error: "re-signed locally by `doctor auth --fix`, but the previous renewal was refused by the broker and the re-signed generation is not yet broker-proven - start the mesh's manager (the renewal owner) so it proves and adopts it" }
      : undefined;
    writeRenewalRecord(root, { ts: new Date().toISOString(), owner: "doctor --fix", results, adoption });
    for (const r of results.filter((x) => !x.ok && !x.skipped)) console.error(c.red(`  ✗ ${r.file}: ${r.error}`));
    reports = inventory(root, auth.space, auth.sys.pub);
    problems = reports.filter((r) => r.problem);
  }

  render("Daemon creds (manager-reminted - class 2)", reports.filter((r) => isRemintable(r.kind)));
  renderRenewalRecord(root);
  render("$SYS creds (rotation-renewed - never remintable from disk)", reports.filter((r) => r.kind === "membership-observer" || r.kind === "connection-evictor"));
  render("Agent creds (static, pre-flip)", reports.filter((r) => r.kind === "agent"));

  // A broker-REFUSED renewal is a first-class problem for the final verdict + exit status, not just a
  // warning line. Cred-file health alone is not enough: a structurally-valid JWT the broker rejected
  // must never let `auth: healthy` / exit 0 stand (the whole point of the renewal-honesty slice).
  const rec = readRenewalRecord(root);
  const adoptionRefused = rec?.adoption?.ok === false;
  // Superseded leftovers are reported but never block `healthy` (#1576). An operator whose fleet is
  // fine must be told so in one word; the leftovers are a tidy-up, and burying that in an `auth: 15
  // cred problems` line is what sent one operator toward respawning 18 working agents.
  //
  // REPORTED ON BOTH PATHS, and that is not symmetry for its own sake. During the reported incident
  // there WERE genuine problems alongside the 15 husks, so a note printed only on the healthy path
  // would have been absent exactly when the operator needed it — and the one thing they must not
  // conclude, while reading real failures, is that the husks are more of the same.
  const superseded = reports.filter((r) => r.superseded);
  const leftovers = superseded.length
    ? ` (${superseded.length} superseded credential file${superseded.length === 1 ? "" : "s"} left on disk from earlier incarnations - safe to delete, the agents using their successors are unaffected)`
    : "";
  if (!problems.length && !adoptionRefused) {
    console.log(c.green("\nauth: healthy") + c.dim(leftovers));
    if (superseded.length) printSuperseded(superseded);
    return;
  }
  const parts: string[] = [];
  if (problems.length) parts.push(`${problems.length} cred problem${problems.length === 1 ? "" : "s"}`);
  if (adoptionRefused) parts.push("last renewal not broker-accepted");
  console.log(c.red(`\nauth: ${parts.join(", ")}`) + c.dim(leftovers));
  for (const p of problems) console.log(`  ${c.red("✗")} ${p.label}: ${p.problem}\n    next: ${p.repair}`);
  if (adoptionRefused)
    console.log(`  ${c.red("✗")} the last renewal pass was refused by the broker: ${rec?.adoption?.error ?? "unknown"}\n    next: start or repair the mesh's manager (the renewal owner) so it re-signs and re-proves the daemon creds`);
  if (superseded.length) printSuperseded(superseded);
  process.exitCode = 1;
}

/** The superseded leftovers, with their cleanup, rendered BELOW the verdict on both paths (#1576).
 *
 *  Each one repeats "not a broken agent" and its own cleanup rather than sharing one footnote,
 *  because the failure mode being designed against is an operator scanning a long list during an
 *  incident and acting per row. A single note at the top of 15 rows is a note that gets skipped, and
 *  the action it would have prevented destroys live sessions. */
function printSuperseded(reports: CredReport[]): void {
  console.log(c.dim(`  ${reports.length} superseded credential file${reports.length === 1 ? "" : "s"} (not a broken agent - the live successor of each is listed above):`));
  for (const r of reports) console.log(c.dim(`    ⊖ ${r.label}\n      next: ${r.repair}`));
}

function isRemintable(kind: CredentialKind): boolean {
  return kind === "delivery" || kind === "membership-rw";
}

/** One agent credential file's place in its alias's family (#1576).
 *
 *  `current`     — the newest incarnation of this alias on disk: the one a live agent is using.
 *  `superseded`  — an OLDER incarnation of an alias that HAS a newer one. The successor's existence
 *                  is the proof: incarnation files are `<alias>.<lifecycleUid>.creds` and a new
 *                  lifecycle only ever appears because a new incarnation was provisioned.
 *  `sole`        — a standing (`<alias>.creds`) file, or the only incarnation of its alias. Nothing
 *                  supersedes it, so an expiry here is a real finding. */
type AgentFileRole = "current" | "superseded" | "sole";

interface LivePresence {
  role: AgentFileRole;
}

/** THE REMEDY SPLIT (#1576 ask 2).
 *
 *  The old text was one sentence for every agent credential: "respawn the agent - its old cred is
 *  dead by design". It is correct for exactly one of the three cases below and DESTRUCTIVE for the
 *  other two. A reporter was shown it for 15 credentials during an outage; following it would have
 *  destroyed 18 live agent sessions, each holding working context, to fix a state the manager's own
 *  renewal pass repaired by itself thirty minutes later.
 *
 *  WHAT THE MANAGER ACTUALLY DOES, which is what makes the distinction real rather than softer
 *  wording: its renewal pass walks its managed agents and re-signs any whose credential is expired
 *  or near expiry for the SAME nkey, and the agent adopts the new file through its own source
 *  re-read. It explicitly does NOT renew an `unbounded` or `unreadable` credential. So:
 *    - an EXPIRED current incarnation is re-minted by a running manager: start it, do not respawn;
 *    - an UNBOUNDED/UNREADABLE one genuinely cannot be renewed: respawn is the honest answer;
 *    - a SUPERSEDED incarnation belongs to no live agent at all: it is a leftover FILE, and the
 *      repair is to delete it, never to touch the running agent that replaced it. */
function agentRepair(path: string, live?: LivePresence): string {
  if (live?.role === "superseded")
    return `nothing is wrong with this agent - this file is a SUPERSEDED incarnation left on disk after a re-mint, and its live successor is listed above. Delete it when convenient (\`rm ${path}\`). DO NOT respawn the agent.`;
  return `if the mesh's manager is running it RE-MINTS this credential by itself (it is the renewal owner for managed agents; start it with \`${displayCmd()} up\` and the agent adopts the new file without being restarted). Respawn only if the manager cannot: \`${displayCmd()} spawn\``;
}

/** The repair for a credential no renewal pass can rescue — the one case where respawning is right.
 *  An `unbounded` credential predates the renewal slice and an `unreadable` one cannot be parsed to
 *  re-sign; the manager skips both by name, so promising a re-mint here would be a false hope. */
function agentUnrenewableRepair(): string {
  return `respawn the agent (\`${displayCmd()} spawn\`) - this credential cannot be re-minted from disk (the manager's renewal pass skips unbounded/unreadable material), so its old cred is dead by design`;
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
function inventory(root: string, space: string, sysPub?: string): CredReport[] {
  // Through the choke point, not a hand-composed `.cotal/<file>` (P7 §2 rule 1). The four kinds are
  // per-space now, and a diagnosis that read the canonical location past an unmigrated copy would
  // report every one of them "missing" on a root `up` has not re-provisioned — the worst possible
  // answer from the surface an operator reaches for when something is already wrong. The LABEL stays
  // the kind, which is what the operator reads and what `staleSystemCreds` keys its answer by.
  const at = (kind: string) => migrateLegacyCotalMaterial(root, space, kind);
  const fixed: Array<{ label: string; kind: CredentialKind; path: string }> = [
    { label: DELIVERY_CREDS_KIND, kind: "delivery", path: at(DELIVERY_CREDS_KIND) },
    { label: MEMBERSHIP_RW_CREDS_KIND, kind: "membership-rw", path: at(MEMBERSHIP_RW_CREDS_KIND) },
    { label: MEMBERSHIP_OBSERVER_CREDS_KIND, kind: "membership-observer", path: at(MEMBERSHIP_OBSERVER_CREDS_KIND) },
    { label: CONNECTION_EVICTOR_CREDS_KIND, kind: "connection-evictor", path: at(CONNECTION_EVICTOR_CREDS_KIND) },
  ];
  // Ask the staleness question ONCE, through the same helper the boot path uses, so `doctor auth`
  // and `cotal up` can never disagree about which $SYS creds the trust record authorizes.
  const stale = new Map(sysPub ? staleSystemCreds(root, sysPub, space).map((x) => [x.file, x] as const) : []);
  const reports = fixed.map((f) => report(f.label, f.kind, f.path, sysPub, stale.get(f.label)));
  // Same posture for the per-agent secrets (P1), and for the same reason: this space's segment
  // through the choke point, never `join(authDir(root), "creds")`, so an operator running `doctor`
  // on a root that has not migrated yet sees their agents' creds rather than an empty inventory. It
  // is also what keeps the report SPACE-scoped now that the dir holds every tenant's segment — a
  // diagnosis must not name a co-resident tenant's material.
  const agentDir = agentCredsDir(root, space);
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

function report(label: string, kind: CredentialKind, path: string, sysPub?: string, stale?: StaleSystemCred, live?: LivePresence): CredReport {
  if (!existsSync(path)) return { label, kind, path };
  const creds = readFileSync(path, "utf8");
  const health = inspectCredHealth(creds);
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
    r.problem = `signed by a RETIRED system account (${stale.iss ? `${stale.iss.slice(0, 12)}…` : "unreadable"}, but this root's is ${sysPub.slice(0, 12)}…) - the broker denies it`;
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
      if (standing) {
        r.problem = "unbounded standing credential (minted before the renewal slice) - a copied cred never dies";
        r.repair = repair;
      }
      break;
  }
  return r;
}

function render(title: string, reports: CredReport[]): void {
  console.log(`\n  ${c.bold(title)}`);
  if (!reports.length) {
    console.log(c.dim("    none"));
    return;
  }
  for (const r of reports) {
    if (!r.health) {
      console.log(`    ${c.dim("−")} ${r.label} ${c.dim(`not provisioned here (written by \`${displayCmd()} up\`)`)}`);
      continue;
    }
    const h = r.health;
    const lastRenewal = h.iat ? c.dim(` · last renewal ${at(h.iat)}`) : "";
    const expiry = h.exp ? c.dim(` · expires ${at(h.exp)}`) : "";
    // A superseded incarnation is dim and NAMED, never red (#1576): its expiry is the expected
    // consequence of the re-mint that replaced it, and an operator scanning red rows during an
    // incident must not be sent to destroy the live agent that succeeded it.
    const badge = r.superseded
      ? c.dim("⊖ superseded")
      : h.state === "healthy" ? c.green("● healthy")
      : h.state === "near-expiry" ? c.yellow("◐ near-expiry")
      : h.state === "unbounded" ? (r.problem ? c.red("∞ unbounded") : c.dim("∞ static (dies at the flip)"))
      : c.red(`✗ ${h.state}`);
    const note = r.superseded ? c.dim(` · replaced by a newer incarnation of "${aliasOf(r.label)}" - leftover file, not a broken agent`) : "";
    console.log(`    ${badge}  ${r.label}${lastRenewal}${expiry}${note}`);
  }
}

/** Render the renewal owner's audit record (written by the manager's pass / doctor --fix): when the
 *  last pass ran, who ran it, and whether the daemon EXPLICITLY adopted — the "file re-signed" vs
 *  "daemon adopted" distinction the D5 panel required. Absence is informational (a mesh started
 *  before the renewal owner existed, or an open mesh). */
function renderRenewalRecord(root: string): void {
  const rec = readRenewalRecord(root);
  if (!rec) {
    console.log(c.dim("    no renewal record yet (written by the manager's renewal pass)"));
    return;
  }
  const resigned = rec.results.filter((r) => r.ok).map((r) => r.file);
  const failed = rec.results.filter((r) => !r.ok && !r.skipped);
  // Per-component result from the daemon's structured reply detail (persisted on ok AND failed
  // passes): "accepted" = the broker accepted this generation (the proof); "rejected" (ok:false);
  // "n/a" (absent/skipped). NOT "adopted" — the resident wire swap is best-effort/self-healing, not
  // witnessed. Empty for an older record.
  const detail = rec.adoption?.detail as
    | { delivery?: { ok?: boolean; brokerAccepted?: unknown; skipped?: string }; membership?: { ok?: boolean; brokerAccepted?: unknown; skipped?: string } }
    | undefined;
  const compStatus = (comp?: { ok?: boolean; brokerAccepted?: unknown; skipped?: string }): string =>
    comp === undefined ? "n/a" : comp.ok === false ? "rejected" : comp.skipped ? "n/a" : comp.brokerAccepted ? "accepted" : "n/a";
  const perComponent = detail && typeof detail === "object" && (detail.delivery !== undefined || detail.membership !== undefined)
    ? ` (delivery: ${compStatus(detail.delivery)}, membership: ${compStatus(detail.membership)})`
    : "";
  const adoption = rec.adoption === undefined
    ? resigned.length
      ? c.yellow("daemon reload not requested by this pass - daemons pick up the re-sign via the 75% re-read backstop or the next renewal pass")
      : c.dim("renewal: n/a (nothing re-signed)")
    : rec.adoption.ok
      ? c.green(`broker-accepted ✓${perComponent}`)
      : c.yellow(`renewal not accepted - ${rec.adoption.error ?? "unknown"}${perComponent}`);
  console.log(`    ${c.dim(`last renewal pass ${rec.ts} by ${rec.owner}`)} - re-signed [${resigned.join(", ") || "none"}] · ${adoption}`);
  for (const f of failed) console.log(`    ${c.red("✗")} last pass failed on ${f.file}: ${f.error}`);
  // #1576: NAME THE DELIVERY RESPONDER, OFFLINE. `doctor auth` resolves no mesh and opens no
  // connection by design (and on a user-auth mesh it is forbidden to mint at all), so it cannot read
  // the delivery lease that `cotal status` reads. It does not have to: when the manager's renewal
  // pass finds no responder on the delivery-admin rail it RECORDS that, in this file, which doctor
  // already reads. That record was being rendered only as a generic "renewal not accepted", so the
  // one surface an operator reaches for when credentials look wrong never said the word "delivery"
  // — and in the reported incident credentials were exactly what the operator wrongly suspected.
  if (responderUnboundAtLastRenewal(rec.adoption?.error))
    console.log(
      `    ${c.red("✗")} the delivery daemon's responder was NOT BOUND at that pass - ${RESPONDER_UNBOUND_CONSEQUENCE}\n` +
        `      next: start it (\`${displayCmd()} up\`) and confirm with \`${displayCmd()} status --components\`. Expired agent creds above are re-minted once it binds - do NOT respawn agents for this.`,
    );
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
  return sec ? new Date(sec * 1000).toISOString() : "?";
}
