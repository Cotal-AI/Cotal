/** Run after building core: pnpm smoke:endpoint-coverage (no broker). The coverage projection
 *  against hand-built ceilings, then a randomized oracle: every concrete subject's verdict from
 *  `issuedPermitsSubject` must equal the verdict the projection gives its class. */
import { randomBytes } from "node:crypto";
import {
  CoverageLimitError, epjSubject, epRequestSubject, issuedPermitsSubject, mintLifecycleUid, projectCommandCoverage,
  type CoverageCombination, type CoverageCommand, type CoverageParam, type CoveredForm, type EpAuthzMode, type EpCaller,
  type EpTarget, type IssuedSubjectPermission,
} from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";

const suite = createSuite();
const space = "covsp";
const endpoint = "linear";
const caller: EpCaller = { owner: "u_alice", actor: "a1", uid: mintLifecycleUid() };
const generation = "7fffffff" + randomBytes(12).toString("hex");
const [I1, I2, I3] = [mintLifecycleUid(), mintLifecycleUid(), mintLifecycleUid()];
const nonce = () => randomBytes(16).toString("base64url");
const perm = (allow: string[] | "all" | "none", deny: string[] = []): IssuedSubjectPermission =>
  ({ allow: allow === "all" || allow === "none" ? { mode: allow } : { mode: "patterns", patterns: allow }, deny });
const p = `cotal.${space}`;
const callerBlock = `${caller.owner}.${caller.actor}.${caller.uid}`;
const find = (forms: CoveredForm[], rail: string, route?: string, mode?: string) =>
  forms.find((f) => f.rail === rail && f.route === route && f.mode === mode);

const untargeted: CoverageCommand = { name: "issue-get", class: "ephemeral", targeted: false };
const targeted: CoverageCommand = { name: "issue-set", class: "ephemeral", targeted: true, modes: ["owner", "exact"] };
const journal: CoverageCommand = { name: "issue-sync", class: "journal", targeted: false };

{
  const forms = projectCommandCoverage(space, perm([`${p}.ep.one.linear.issue-get.${callerBlock}.*`]), { endpoint, command: untargeted, caller });
  suite.check("an exact class-route row covers that one form and nothing else",
    forms.length === 1 && find(forms, "ep", "one")?.covered.length === 1, forms);
}
{
  const forms = projectCommandCoverage(space, perm([`${p}.ep.one.linear.issue-set.owner.u_alice.${callerBlock}.*`, `${p}.ep.one.linear.issue-set.exact.*.*.*.${callerBlock}.*`]),
    { endpoint, command: targeted, caller });
  const owner = find(forms, "ep", "one", "owner");
  const exact = find(forms, "ep", "one", "exact");
  suite.check("an owner-mode row names its one target owner",
    owner?.covered.length === 1 && owner.covered[0]?.targetOwner === "u_alice" && owner.literals.targetOwner?.join() === "u_alice", owner);
  suite.check("a wildcard exact row covers any target",
    exact?.covered.length === 1 && exact.covered[0]?.targetOwner === "*" && exact.covered[0]?.targetActor === "*" && exact.covered[0]?.targetUid === "*", exact);
}
{
  const forms = projectCommandCoverage(space, perm([`${p}.ep.one.linear.issue-set.owner.*.${callerBlock}.*`], [`${p}.ep.one.linear.issue-set.owner.u_bob.>`]),
    { endpoint, command: targeted, caller });
  const owner = find(forms, "ep", "one", "owner");
  suite.check("a deny names the excluded owner and every other owner stays covered",
    owner?.literals.targetOwner?.includes("u_bob") === true && owner.covered.every((c) => c.targetOwner !== "u_bob" && c.targetOwner !== "*")
      && owner.covered.some((c) => c.targetOwner === null), owner);
}
{
  const forms = projectCommandCoverage(space, perm([`${p}.ep.inst.linear.${I1}.issue-get.${callerBlock}.*`]), { endpoint, command: untargeted, caller, instances: [I1, I2] });
  const inst = find(forms, "ep", "inst");
  suite.check("an instance pin covers that registered instance only",
    forms.length === 1 && inst?.covered.length === 1 && inst.covered[0]?.instanceId === I1 && inst.literals.instanceId?.length === 2, inst);
}
{
  const forms = projectCommandCoverage(space, perm([`${p}.epj.linear.issue-sync.${callerBlock}`]), { endpoint, command: journal, caller });
  suite.check("a journal row covers the epj form", forms.length === 1 && find(forms, "epj")?.covered.length === 1, forms);
}
{
  const forms = projectCommandCoverage(space, perm([`${p}.ep.v1.one.linear.issue-get.${callerBlock}.${generation}.*`]), { endpoint, command: untargeted, caller, generation });
  suite.check("an issued row covers the ep.v1 form and no legacy form", forms.length === 1 && find(forms, "ep.v1", "one") !== undefined, forms);
}
{
  const forms = projectCommandCoverage(space, perm("all"), { endpoint, command: untargeted, caller });
  suite.check("an unrestricted ceiling covers every route", ["one", "all", "inst"].every((r) => find(forms, "ep", r) !== undefined), forms);
  suite.check("a none ceiling covers nothing", projectCommandCoverage(space, perm("none"), { endpoint, command: untargeted, caller }).length === 0);
}
{
  const many = Array.from({ length: 70 }, (_, i) => `${p}.ep.one.linear.issue-set.exact.o${i}.a${i}.${mintLifecycleUid()}.${callerBlock}.*`);
  let refused = false;
  try {
    projectCommandCoverage(space, perm(many), { endpoint, command: targeted, caller });
  } catch (e) {
    refused = e instanceof CoverageLimitError;
  }
  suite.check("a ceiling past the combination limit is refused, not answered in part", refused);
}

// ---- the oracle -----------------------------------------------------------------------------------

const owners = ["u_alice", "u_bob", "u_carol"];
const actors = ["a1", "a2"];
const uids = [mintLifecycleUid(), mintLifecycleUid()];
const instances = [I1, I2, I3];
const pick = <T>(xs: readonly T[]): T => xs[randomBytes(1)[0]! % xs.length]!;
const chance = (n: number) => randomBytes(1)[0]! < 256 * n;
const fresh = (param: CoverageParam) => param === "instanceId" || param === "targetUid" ? mintLifecycleUid() : `zz${randomBytes(4).toString("hex")}`;
const valueOf = (param: CoverageParam, pool: boolean): string =>
  !pool ? fresh(param) : param === "instanceId" ? pick(instances) : param === "targetOwner" ? pick(owners) : param === "targetActor" ? pick(actors) : pick(uids);
const paramsOf = (mode: EpAuthzMode | undefined, route: string | undefined): CoverageParam[] => [
  ...(route === "inst" ? ["instanceId" as const] : []),
  ...(mode === undefined || mode === "self" ? [] : mode === "exact" || mode === "handle" ? ["targetOwner", "targetActor", "targetUid"] as const : ["targetOwner"] as const),
];
const command: CoverageCommand = { name: "issue-set", class: "journal", targeted: true, modes: ["owner", "exact"] };
type Shape = { rail: "ep" | "ep.v1" | "epj"; route?: "one" | "all" | "inst"; mode: EpAuthzMode };
const shapes: Shape[] = (["owner", "exact"] as const).flatMap((mode) => [
  ...(["ep", "ep.v1"] as const).flatMap((rail) => (["one", "all", "inst"] as const).map((route) => ({ rail, route, mode }))),
  { rail: "epj" as const, mode },
]);
const subjectOf = (s: Shape, v: Record<CoverageParam, string>): string => {
  const target: EpTarget = s.mode === "exact" ? { mode: "exact", tOwner: v.targetOwner, tActor: v.targetActor, tUid: v.targetUid } : { mode: s.mode as "owner", tOwner: v.targetOwner };
  if (s.rail === "epj") return epjSubject(space, { endpoint, command: command.name, target, caller });
  const c = s.rail === "ep.v1" ? ({ ...caller, generation } as EpCaller) : caller;
  return epRequestSubject(space, { route: s.route === "inst" ? { mode: "inst", instanceId: v.instanceId } : { mode: s.route! }, endpoint, command: command.name, target, caller: c, nonce: nonce() });
};
const randomPattern = (): string => {
  const s = pick(shapes);
  const v = Object.fromEntries(paramsOf(s.mode, s.route).map((q) => [q, valueOf(q, true)])) as Record<CoverageParam, string>;
  const tokens = subjectOf(s, v).split(".");
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (i > 2 && chance(0.04)) { out.push(">"); break; }
    out.push(i > 2 && chance(0.18) ? "*" : tokens[i]!);
  }
  return out.join(".");
};

let mismatches = 0;
let checked = 0;
for (let round = 0; round < 400; round++) {
  const allow = Array.from({ length: 1 + (randomBytes(1)[0]! % 5) }, randomPattern);
  const deny = Array.from({ length: randomBytes(1)[0]! % 3 }, randomPattern);
  const ceiling = perm(chance(0.1) ? "all" : allow, deny);
  const forms = projectCommandCoverage(space, ceiling, { endpoint, command, caller, generation, instances: [I1, I2] });
  for (const s of shapes) {
    const form = find(forms, s.rail, s.route, s.mode);
    for (let k = 0; k < 12; k++) {
      const params = paramsOf(s.mode, s.route);
      const v = Object.fromEntries(params.map((q) => [q, valueOf(q, chance(0.7))])) as Record<CoverageParam, string>;
      const truth = issuedPermitsSubject(ceiling, subjectOf(s, v));
      const combo: CoverageCombination = Object.fromEntries(params.map((q) => [q, form?.literals[q]?.includes(v[q]) ? v[q] : null]));
      const predicted = form?.covered.some((c) => params.every((q) => c[q] === "*" || c[q] === combo[q])) ?? false;
      checked++;
      if (truth !== predicted && mismatches++ < 3) console.log("  mismatch", { allow: ceiling.allow, deny, shape: s, values: v, truth, predicted, form });
    }
  }
}
suite.check(`oracle: ${checked} random subjects get their class verdict from issuedPermitsSubject`, mismatches === 0, { mismatches });

suite.finish();
