/**
 * EPS GRANT SWEEP (control-surface v0.4, Lane B finding 1) — the STRUCTURAL guard behind
 * SPEC §13.9: "both sides of a session hold only redemption-minted per-session credentials
 * (§13.6); no standing EPS grant exists on either side", and the §13.9 matrix rows at 2695-2698
 * which require the EXACT `eps.<endpoint>.<sessionId>.<epoch>.{in,out}` subject on all four legs.
 *
 * The suite this replaces encoded BOTH the rule and its violation and was green on both:
 * `ep-session` asserted no standing EPS while `session-writer-grant` pinned the wildcard
 * `eps.<endpoint>.*.<epoch>.{in,out}` as reviewed literals. Flipping that one assertion would
 * leave the contradiction reintroducible by the next profile. So this sweep does not inspect the
 * profile under change; it enumerates EVERY mint profile and asks a question no wording can dodge:
 *
 *     can this credential touch a session rail that is not its own?
 *
 * It answers by NATS SUBJECT MATCHING, not string search. Each profile's rows are matched against
 * a foreign session's `in` and `out` rails with real wildcard semantics (`*` = one token, `>` =
 * the rest), so `eps.<e>.*.<epoch>.in`, `eps.>`, `cotal.<space>.>` and a bare `>` are all caught
 * by the same check, and a future row shape nobody anticipated is caught too.
 *
 * EXHAUSTIVENESS IS ENFORCED, NOT DECLARED. The producer table is keyed `Record<Profile, …>`, so
 * the compiler refuses a missing profile where this file is typechecked, and — because smoke files
 * are not in the typecheck project — the sweep ALSO proves at runtime that its key set is exactly
 * the profile set of `CREDENTIAL_LIFETIMES` (the frozen D5 table every profile must classify into).
 * A profile the sweep cannot construct FAILS; there is no skip list, because a skipped profile is
 * an escaped profile. `endpoint-serve` is deliberately unconstructible through `permissionsFor`
 * (its rows are emitted only by `mintCreds` behind the §13.1 issuance fence), so the table reaches
 * it through the SAME row builder that mint uses rather than skipping it.
 *
 * Run: pnpm smoke:eps-grant-sweep   (broker-free; part of smoke:ci).
 */
import {
  permissionsFor, epServeGrantRows, epsSubject, CREDENTIAL_LIFETIMES, DEV_OWNER,
  type Profile,
} from "@cotal-ai/core";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra !== undefined ? JSON.stringify(extra) : ""); } };

const SPACE = "epssweep";
const EP = "manager";
const EPOCH = 7;
const MINE = "s".repeat(26);    // the one session a per-session credential is minted for
const FOREIGN = "f".repeat(26); // a DIFFERENT live session on the same endpoint + epoch
const UID = "u".repeat(26);
const IID = "i".repeat(26);
// The holder's incarnation uid rides the MINT PRINCIPAL (not the opts): the agent baseline and the
// operator instruments carry lifecycle-keyed ep caller rows, and their mint refuses without it.
const pr = { owner: DEV_OWNER, actor: "sweep", connId: "conn0123456789abcdef", lifecycleUid: UID };

/** NATS subject matching: `*` matches exactly one token, `>` matches one-or-more trailing tokens. */
function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split("."), s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ">") return s.length > i;
    if (i >= s.length) return false;
    if (p[i] !== "*" && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

const rowsOf = (perm: unknown): string[] => {
  const p = perm as { pub?: { allow?: string[] }; sub?: { allow?: string[] } };
  return [...(p.pub?.allow ?? []), ...(p.sub?.allow ?? [])];
};
const via = (profile: Profile, opts: Record<string, unknown> = {}) => (): string[] =>
  rowsOf(permissionsFor(profile, SPACE, pr, opts as never));

/**
 * How each profile's rows are produced. Keyed `Record<Profile, …>` so the profile union drives it.
 * Every entry is a REPRESENTATIVE mint: the per-session profiles are pinned to `MINE`, so a row
 * that reaches `FOREIGN` is a genuine cross-session leak and not an artifact of the fixture.
 */
const PRODUCERS: Record<Profile, () => string[]> = {
  agent: via("agent"),
  observer: via("observer"),
  admin: via("admin"),
  supervisor: via("supervisor"),
  provisioner: via("provisioner"),
  deprovisioner: via("deprovisioner", { deprovisionTarget: { principal: `${DEV_OWNER}.worker`, lifecycleUid: UID } }),
  "retirement-requester": via("retirement-requester", { retirementRequester: { owner: DEV_OWNER, actor: "manager", uid: UID, target: { owner: DEV_OWNER, actor: "worker", lifecycleUid: UID } } }),
  "lifecycle-executor": via("lifecycle-executor", { lifecycleExecutor: { owner: DEV_OWNER, actor: "worker", lifecycleUid: UID, alias: "worker" } }),
  "endpoint-serve-executor": via("endpoint-serve-executor", { endpointServeExecutor: { endpoint: EP, instanceId: IID } }),
  operator: via("operator"),
  purger: via("purger"),
  backup: via("backup", { backup: { operation: "inspect", selection: "full" } }),
  restore: via("restore", { restore: { operation: "initiate", stream: `CHAT_${SPACE}` } }),
  delivery: via("delivery"),
  "membership-rw": via("membership-rw"),
  probe: via("probe"),
  "channel-writer": via("channel-writer"),
  "channel-purger": via("channel-purger"),
  teardown: via("teardown"),
  "control-caller-privileged": via("control-caller-privileged"),
  "control-caller-admin": via("control-caller-admin"),
  deployer: via("deployer"),
  // `permissionsFor` refuses this one BY DESIGN (serve rows are emitted only by mintCreds behind
  // the §13.1 fence), so it is covered through the row builder the mint itself calls — covered,
  // never skipped.
  "endpoint-serve": () => {
    const g = epServeGrantRows(SPACE, { endpoint: EP, instanceId: IID, epoch: EPOCH, ephemeralCommands: ["ps", "attach"] });
    return [...g.pub, ...g.sub];
  },
  "goal-writer": via("goal-writer", { goalWriter: { endpoint: EP } }),
  "session-caller": via("session-caller", { sessionCaller: { endpoint: EP, sessionId: MINE, epoch: EPOCH } }),
  "session-ledger": via("session-ledger"),
  "session-serving": via("session-serving", { sessionServing: { endpoint: EP, sessionId: MINE, epoch: EPOCH } }),
  "endpoint-evictor": via("endpoint-evictor"),
};

// ── exhaustiveness: the table's key set IS the profile set, proven at runtime ──────────────────
console.log("A. exhaustiveness: every mint profile is swept, none skipped");
{
  // The two CredentialKind members that are NOT Profiles ($SYS creds minted outside permissionsFor).
  const NON_PROFILE_KINDS = ["membership-observer", "connection-evictor"];
  const declared = Object.keys(CREDENTIAL_LIFETIMES).filter((k) => !NON_PROFILE_KINDS.includes(k)).sort();
  const swept = Object.keys(PRODUCERS).sort();
  const missing = declared.filter((k) => !swept.includes(k));
  const extra = swept.filter((k) => !declared.includes(k));
  c("the sweep covers EXACTLY the profiles of the frozen D5 lifetime table (a new profile fails here until it is swept)",
    missing.length === 0 && extra.length === 0, { missing, extra });
  c("every non-profile CredentialKind is accounted for explicitly (never silently dropped)",
    NON_PROFILE_KINDS.every((k) => k in CREDENTIAL_LIFETIMES), NON_PROFILE_KINDS);
}

// ── the sweep ──────────────────────────────────────────────────────────────────────────────────
const foreignRails = [
  epsSubject(SPACE, EP, FOREIGN, EPOCH, "in"),
  epsSubject(SPACE, EP, FOREIGN, EPOCH, "out"),
];
const myRails = [
  epsSubject(SPACE, EP, MINE, EPOCH, "in"),
  epsSubject(SPACE, EP, MINE, EPOCH, "out"),
];

console.log("B. no profile's credential can reach a session rail that is not its own");
{
  const leaks: Array<{ profile: string; row: string; reaches: string }> = [];
  const unconstructible: Array<{ profile: string; error: string }> = [];
  for (const [profile, produce] of Object.entries(PRODUCERS)) {
    let rows: string[];
    try {
      rows = produce();
    } catch (e) {
      // A profile the sweep cannot construct FAILS. It is never skipped: a skipped profile is an
      // escaped profile, and a guard with a skip list decays into the hand-maintained list this
      // sweep exists to replace.
      unconstructible.push({ profile, error: (e as Error).message });
      continue;
    }
    for (const row of rows) for (const rail of foreignRails) if (subjectMatches(row, rail)) leaks.push({ profile, row, reaches: rail });
  }
  c("every profile constructs (an unconstructible profile FAILS, never skips)", unconstructible.length === 0, unconstructible);
  c("NO profile's rows match a foreign session's `in`/`out` rail — no standing EPS grant on either side (SPEC 13.9:2526)",
    leaks.length === 0, leaks);
}

console.log("C. the two per-session profiles DO reach their own rail (the sweep is not vacuous)");
{
  const caller = PRODUCERS["session-caller"]();
  const serving = PRODUCERS["session-serving"]();
  const [inMine, outMine] = myRails;
  c("session-caller PUBLISHES its own `in` rail", caller.some((r) => subjectMatches(r, inMine)), caller);
  c("session-caller SUBSCRIBES its own `out` rail", caller.some((r) => subjectMatches(r, outMine)), caller);
  c("session-serving SUBSCRIBES its own `in` rail", serving.some((r) => subjectMatches(r, inMine)), serving);
  c("session-serving PUBLISHES its own `out` rail", serving.some((r) => subjectMatches(r, outMine)), serving);
  // Asymmetry: the caller writes `in` and reads `out`; the serving side is the exact reverse
  // (§13.6 "the caller publishes in and subscribes out; the serving instance the reverse").
  const pubOf = (p: Profile, opts: Record<string, unknown>) => ((permissionsFor(p, SPACE, pr, opts as never) as { pub?: { allow?: string[] } }).pub?.allow ?? []);
  const callerPub = pubOf("session-caller", { sessionCaller: { endpoint: EP, sessionId: MINE, epoch: EPOCH } });
  const servingPub = pubOf("session-serving", { sessionServing: { endpoint: EP, sessionId: MINE, epoch: EPOCH } });
  c("the pair is ASYMMETRIC: caller publishes ONLY `in`, serving publishes ONLY `out`",
    callerPub.includes(inMine) && !callerPub.includes(outMine) && servingPub.includes(outMine) && !servingPub.includes(inMine),
    { callerPub, servingPub });
}

console.log("D. the session-ledger (the durable revocation authority) holds NO session rail at all");
{
  const ledger = PRODUCERS["session-ledger"]();
  const anyRail = [...myRails, ...foreignRails];
  c("no `eps` row of any shape (the ledger authority never touches the byte rails)",
    !ledger.some((r) => anyRail.some((rail) => subjectMatches(r, rail))) && !ledger.some((r) => r.includes(".eps.")), ledger);
  c("it DOES hold the sessions-bucket ledger write (the sweep is not passing by holding nothing)",
    ledger.some((r) => r.startsWith("$KV.cotal_sessions_")), ledger);
}

console.log(`\neps-grant-sweep: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
