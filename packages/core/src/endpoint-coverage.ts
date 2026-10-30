/**
 * Which request forms of one registered command a publish ceiling admits: the projection the
 * registry's `endpoints` question answers with (SPEC 13.7, 13.15).
 *
 * A NATS pattern tells two values at one token position apart only when it names one of them as a
 * literal there; `*` and `>` match every value alike. So the values a parameter position can take
 * fall into finitely many classes: each literal some allow or deny pattern names at that position,
 * plus one class for every other value. Testing one subject per combination of classes with
 * {@link issuedPermitsSubject} (deny wins) answers for every concrete subject, because each value
 * in a class gets the same verdict. The subjects are built by the same builders a client publishes
 * with, so the projection and the wire cannot disagree on where a parameter sits.
 */
import { randomBytes } from "node:crypto";
import type { EpClass } from "./endpoint-envelope.js";
import {
  assertBoundedOwner, epjSubject, epRequestSubject, type EpAuthzMode, type EpCaller, type EpRoute, type EpTarget,
} from "./endpoint-subjects.js";
import { issuedPermitsSubject, type IssuedSubjectPermission } from "./issued-authority.js";
import { assertLifecycleToken, mintLifecycleUid } from "./subjects.js";

/** One command as its verified root cluster document declares it: the fields coverage reads. */
export interface CoverageCommand {
  readonly name: string;
  readonly class: EpClass;
  readonly targeted: boolean;
  readonly modes?: readonly EpAuthzMode[];
}

/** A parameter position in a request form. The nonce is not one: a client always publishes a
 *  fresh one, so only the "any other value" class of the nonce is ever tested. */
export type CoverageParam = "instanceId" | "targetOwner" | "targetActor" | "targetUid";

/** A combination of classes: each parameter's literal, `null` for every value the form's
 *  `literals` does not name at that parameter, or `"*"` for every value at all (no literal is a
 *  wildcard, so the two never collide). */
export type CoverageCombination = Partial<Record<CoverageParam, string | null>>;

/** One request form the ceiling admits at least once. `epj` is the journal submission form, which
 *  has no route and no nonce. */
export interface CoveredForm {
  readonly rail: "ep" | "ep.v1" | "epj";
  readonly route?: EpRoute["mode"];
  readonly mode?: EpAuthzMode;
  readonly literals: Partial<Record<CoverageParam, readonly string[]>>;
  readonly covered: readonly CoverageCombination[];
}

/** The most class combinations one form is tested with. A ceiling naming more literals than this
 *  allows is refused for the command rather than answered in part. */
export const COVERAGE_COMBINATION_LIMIT = 4096;

export class CoverageLimitError extends Error {}

/** Merge combinations that differ only at one parameter and together cover all its classes into one
 *  with `"*"` there, until none merge. The union of subjects is unchanged. */
function mergeCovered(covered: CoverageCombination[], classes: readonly { p: CoverageParam; literals: readonly string[] }[]): CoverageCombination[] {
  let out = covered;
  for (let merged = true; merged;) {
    merged = false;
    for (const { p, literals } of classes) {
      const groups = new Map<string, CoverageCombination[]>();
      for (const c of out) {
        const key = JSON.stringify(classes.map((k) => (k.p === p ? "" : c[k.p])));
        groups.set(key, [...(groups.get(key) ?? []), c]);
      }
      const next: CoverageCombination[] = [];
      for (const group of groups.values()) {
        const seen = new Set(group.map((c) => c[p]));
        if (!seen.has("*") && seen.has(null) && literals.every((l) => seen.has(l))) {
          next.push({ ...group[0], [p]: "*" });
          merged = true;
        } else next.push(...group);
      }
      out = next;
    }
  }
  return out;
}

const PARAMS_OF_MODE: Record<EpAuthzMode, readonly CoverageParam[]> = {
  self: [], owner: ["targetOwner"], any: ["targetOwner"], child: ["targetOwner"], ledger: ["targetOwner"],
  handle: ["targetOwner", "targetActor", "targetUid"], exact: ["targetOwner", "targetActor", "targetUid"],
};

const VALIDATE: Record<CoverageParam, (v: string) => unknown> = {
  instanceId: (v) => assertLifecycleToken(v, "instanceId"),
  targetOwner: (v) => assertBoundedOwner(v, "target owner"),
  targetActor: (v) => assertBoundedOwner(v, "target actor"),
  targetUid: (v) => assertLifecycleToken(v, "target lifecycleUid"),
};

function valid(param: CoverageParam, v: string): boolean {
  try {
    VALIDATE[param](v);
    return true;
  } catch {
    return false;
  }
}

/** A value the parameter's grammar admits and no pattern names at its position. */
function freshValue(param: CoverageParam, named: ReadonlySet<string>): string {
  for (;;) {
    const v = param === "instanceId" || param === "targetUid" ? mintLifecycleUid() : `zcov${randomBytes(8).toString("hex")}`;
    if (!named.has(v)) return v;
  }
}

function freshNonce(named: ReadonlySet<string>): string {
  for (;;) {
    const v = randomBytes(16).toString("base64url");
    if (!named.has(v)) return v;
  }
}

function targetOf(mode: EpAuthzMode, v: Record<CoverageParam, string>): EpTarget {
  if (mode === "self") return { mode };
  if (mode === "handle" || mode === "exact") return { mode, tOwner: v.targetOwner, tActor: v.targetActor, tUid: v.targetUid };
  return { mode, tOwner: v.targetOwner };
}

interface Form {
  rail: CoveredForm["rail"];
  route?: EpRoute["mode"];
  mode?: EpAuthzMode;
  params: readonly CoverageParam[];
  build(values: Record<CoverageParam, string>, nonce: string): string;
}

function formsOf(space: string, endpoint: string, command: CoverageCommand, caller: EpCaller, generation: string | undefined): Form[] {
  const modes: (EpAuthzMode | undefined)[] = command.targeted ? [...(command.modes ?? [])] : [undefined];
  const callers: [CoveredForm["rail"], EpCaller][] = [["ep", { owner: caller.owner, actor: caller.actor, uid: caller.uid }]];
  if (generation !== undefined) callers.push(["ep.v1", { owner: caller.owner, actor: caller.actor, uid: caller.uid, generation } as EpCaller]);
  const forms: Form[] = [];
  for (const mode of modes) {
    const targetParams = mode === undefined ? [] : PARAMS_OF_MODE[mode];
    for (const [rail, c] of callers) {
      for (const route of ["one", "all", "inst"] as const) {
        const params = route === "inst" ? ["instanceId" as const, ...targetParams] : targetParams;
        forms.push({
          rail, route, ...(mode !== undefined ? { mode } : {}), params,
          build: (v, nonce) => epRequestSubject(space, {
            route: route === "inst" ? { mode: "inst", instanceId: v.instanceId } : { mode: route },
            endpoint, command: command.name, ...(mode !== undefined ? { target: targetOf(mode, v) } : {}), caller: c, nonce,
          }),
        });
      }
    }
    if (command.class === "journal")
      forms.push({
        rail: "epj", ...(mode !== undefined ? { mode } : {}), params: targetParams,
        build: (v) => epjSubject(space, { endpoint, command: command.name, ...(mode !== undefined ? { target: targetOf(mode, v) } : {}), caller }),
      });
  }
  return forms;
}

/**
 * Project one command onto a publish ceiling. `caller` is the triple on the authenticated request;
 * `generation`, when present, adds the issued rail's forms. `instances` are the endpoint's
 * registered instance ids, tested as named classes so an `inst` row can name them. Returns only the
 * forms the ceiling admits at least once. Throws {@link CoverageLimitError} when a form would need
 * more than `limit` combinations.
 */
export function projectCommandCoverage(
  space: string,
  publish: IssuedSubjectPermission,
  args: { endpoint: string; command: CoverageCommand; caller: EpCaller; generation?: string; instances?: readonly string[] },
  limit = COVERAGE_COMBINATION_LIMIT,
): CoveredForm[] {
  const patterns = publish.allow.mode === "patterns" ? [...publish.allow.patterns, ...publish.deny] : [...publish.deny];
  const split = patterns.map((p) => p.split("."));
  const out: CoveredForm[] = [];
  for (const form of formsOf(space, args.endpoint, args.command, args.caller, args.generation)) {
    // Locate each parameter by building once with distinct fresh values and finding them.
    const probe = {} as Record<CoverageParam, string>;
    for (const p of form.params) probe[p] = freshValue(p, new Set(Object.values(probe)));
    const probeTokens = form.build(probe, freshNonce(new Set())).split(".");
    for (const p of form.params)
      if (probeTokens.indexOf(probe[p]) !== probeTokens.lastIndexOf(probe[p])) throw new Error(`coverage: the ${p} probe is not unique in its subject`);
    const nonceAt = form.rail === "epj" ? -1 : probeTokens.length - 1;
    const named = (at: number) => new Set(split.flatMap((t) => (t.length > at && t[at] !== "*" && t[at] !== ">" ? [t[at]!] : [])));
    const classes = form.params.map((p) => {
      const at = probeTokens.indexOf(probe[p]);
      const set = named(at);
      if (p === "instanceId") for (const i of args.instances ?? []) set.add(i);
      const literals = [...set].filter((v) => valid(p, v)).sort();
      return { p, literals, fresh: freshValue(p, set) };
    });
    const total = classes.reduce((n, c) => n * (c.literals.length + 1), 1);
    if (total > limit)
      throw new CoverageLimitError(`${args.endpoint}.${args.command.name} needs ${total} combinations to project; the limit is ${limit}`);
    const nonce = nonceAt < 0 ? "" : freshNonce(named(nonceAt));
    const covered: CoverageCombination[] = [];
    const walk = (i: number, values: Record<CoverageParam, string>, combo: CoverageCombination) => {
      if (i === classes.length) {
        if (issuedPermitsSubject(publish, form.build(values, nonce))) covered.push({ ...combo });
        return;
      }
      const c = classes[i]!;
      for (const v of [...c.literals, null]) walk(i + 1, { ...values, [c.p]: v ?? c.fresh }, { ...combo, [c.p]: v });
    };
    walk(0, {} as Record<CoverageParam, string>, {});
    if (covered.length === 0) continue;
    out.push({
      rail: form.rail, ...(form.route ? { route: form.route } : {}), ...(form.mode ? { mode: form.mode } : {}),
      literals: Object.fromEntries(classes.map((c) => [c.p, c.literals])), covered: mergeCovered(covered, classes),
    });
  }
  return out;
}
