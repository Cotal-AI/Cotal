/**
 * The seam, as data: the members the emitted module may reach, and the names it may not collide with.
 *
 * The contract (`.internal/plans/cotal-lang-engine-wave.md`, "The transform/host contract", plus
 * seam ruling 1) says neither lane widens the seam alone. That is mechanized from this file:
 * `transform.smoke` re-parses the emitted string, resolves its scopes, and requires ZERO unbound
 * references and every `<ctx>.<member>` it reaches to be listed here. A member added without a
 * ruling is a change a reader sees in one place, not a call buried in an emitter.
 */

/**
 * The members seam ruling 1 grants.
 *
 * `fuel` is the step check (budget L4013 + yield); `get`/`set`/`call` are the member law
 * (L4014/L4018/L4020, curated tables, birth depth L2032, freeze L2031); `born` stamps a literal;
 * `effect` is a journalled primitive, with a static per-call-site payload; `free` is a free name
 * that journals nothing; `await` is the thenable gate; `template` is the interpolation law;
 * `binary`/`unary` are the operator coercion law (L4018 + the operators' meaning); `iter` is the
 * iterability law (L4015); `caught` heads every emitted catch clause (rethrow the six uncatchable
 * classes, else the walker's frozen `{code, kind, message}` record).
 */
export const SEAM_RULED: ReadonlySet<string> = new Set([
  "fuel",
  "get",
  "set",
  "call",
  "born",
  "effect",
  "free",
  "await",
  "template",
  "binary",
  "unary",
  "iter",
  "caught",
]);

/**
 * Members the emitter reaches that are SURFACED but not yet ruled.
 *
 * Kept apart from {@link SEAM_RULED} on purpose. The alternative to naming the debt is either to
 * stop building or to let a proposed member sit indistinguishable from a granted one, and the
 * second is the forbidden move wearing a green suite. `TransformMeta.proposed` reports which of
 * these an emission actually reached, and `transform.smoke` pins that set, so the debt is a
 * measured number rather than a memory.
 */
export const SEAM_PROPOSED: Readonly<Record<string, string>> = Object.freeze({
  callee:
    "L4011 at a non-function callee. `const f = 1; f()` is a program the validator ADMITS (measured at 9dc154f8), and the walker answers L4011 where a native call answers a host TypeError. Emitted behind a `typeof` fast path, so a call to a real function never reaches the host.",
});

/**
 * Operator selectors `unary` must answer beyond `-`, `+` and `~`.
 *
 * `number` is `Number(v)`, which is what `UpdateExpression` charges its operand through
 * (`let o = {}; o++` is admitted, and the walker answers NaN there rather than the L4018 that `+o`
 * would raise). Surfaced with the member, because an op set is as much a contract as a name.
 */
export const UNARY_OPS: readonly string[] = Object.freeze(["-", "+", "~", "number"]);

/** A site whose law has no ruled member and no surfaced proposal yet: refuse rather than invent one. */
export class SeamPending extends Error {
  constructor(
    readonly item: string,
    readonly site: string,
  ) {
    super(
      `${site} needs a seam decision that has not been made (${item}). It is surfaced on #fix.lang-transform; the emitter refuses rather than inventing an answer, because inventing one IS widening the seam.`,
    );
    this.name = "SeamPending";
  }
}

/** Names chosen against the program's own identifier universe, so nothing the emitter needs can be shadowed. */
export interface Names {
  /** The ctx parameter. The validator admits a program-declared `__ctx` (measured), so this is computed, not fixed. */
  readonly ctx: string;
  /** Prefix for emitter temporaries. */
  readonly temp: string;
  /** Prefix for emitter labels. Labels have their own namespace in JavaScript, but the prefix keeps output readable. */
  readonly label: string;
}

/**
 * Pick emitter names that cannot collide with anything the program spells.
 *
 * Seam ruling 1 amended the module shape to a CLOSED function expression with zero free
 * identifiers, after default_agent falsified the premise this file first carried: the validator
 * admits `$x`, `__y`, and a program-declared `__ctx`. So the ctx parameter's name is derived from
 * the source rather than assumed, and the derivation is deterministic — the same source picks the
 * same names on every run, which is what makes `transform` byte-reproducible.
 */
export function pickNames(identifiers: ReadonlySet<string>): Names {
  const free = (base: string): string => {
    if (!identifiers.has(base)) return base;
    for (let i = 0; ; i += 1) {
      const candidate = `${base}$${i}`;
      if (!identifiers.has(candidate)) return candidate;
    }
  };
  const prefix = (base: string): string => {
    let candidate = base;
    for (let i = 0; [...identifiers].some((n) => n.startsWith(candidate)); i += 1) candidate = `${base}$${i}_`;
    return candidate;
  };
  return { ctx: free("__ctx"), temp: prefix("__t"), label: prefix("__l") };
}
