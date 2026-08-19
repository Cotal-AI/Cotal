/**
 * The seam, as data: the members the emitted module may reach, and the names it may not collide with.
 *
 * The transform and its host share this seam, and neither side widens it on its own. That is
 * mechanized from this file: `transform.smoke` re-parses the emitted string, resolves its scopes,
 * and requires ZERO unbound references and every `<ctx>.<member>` it reaches to be listed here. A
 * member added without changing this table is a change a reader sees in one place, not a call
 * buried in an emitter.
 */

/**
 * The members the seam grants, each with the range of ARGUMENT COUNTS the emitter may pass.
 *
 * The arity is written here rather than left implicit in the emitter because a member's shape is as
 * much of the contract as its name, and the two that vary are exactly where a divergence hid from a
 * names-only comparison: `call` grew a fourth and then a fifth argument for the optional call
 * against a host member declared with three, and the differential found it rather than the surface.
 * `transform.smoke` checks every emitted call site against this range in both directions - no site
 * outside it, and no bound without a site that reaches it - and `engine.smoke` checks the host's
 * `ctx` against the same table: names by set-equality, and `ctx[name].length === max` for each. That
 * last is the contracted spelling, and it is `max` rather than `min` for a measured reason: a
 * TypeScript optional parameter is a plain parameter after erasure and still counts toward
 * `Function.length`, so a `<= min` rule
 * would be vacuous on every fixed member and false on all four variadic ones. The MIN end cannot be
 * read from a function at all - erasure has discarded which parameters were optional - so it is
 * behavioural on the host's side: each variadic member has a cell calling it in its shortest form.
 *
 * `fuel` is the step check (budget L4013 + yield); `get`/`set`/`call` are the member law
 * (L4014/L4018/L4020, curated tables, birth depth L2032, freeze L2031); `born` stamps a literal;
 * `effect` is a journalled primitive, with a static per-call-site payload; `free` is a free name
 * that journals nothing; `await` is the thenable gate; `template` is the interpolation law;
 * `binary`/`unary` are the operator coercion law (L4018 + the operators' meaning); `iter` is the
 * iterability law (L4015); `caught` heads every emitted catch clause (rethrow the six uncatchable
 * classes, else the walker's frozen `{code, kind, message}` record).
 */
export const SEAM_MEMBERS: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  fuel: [0, 0],
  // 2, or 3 with the dead-zone rule's binding name, which turns an absent own `v` into L2004.
  get: [2, 3],
  // 3, or 4 with that binding name on a write that can land in the dead zone (the declaration's
  // own initializing write never carries it).
  set: [3, 4],
  // 3 ordinary; 4 with the optional-call flag, where the arguments arrive as a thunk; 5 when the
  // chain continues past the optional call and the rest of it travels as a continuation.
  call: [3, 5],
  born: [1, 1],
  effect: [3, 3],
  // 1 for a free name in value position, 2 for a call to one.
  free: [1, 2],
  await: [1, 1],
  template: [2, 2],
  binary: [3, 3],
  unary: [2, 2],
  iter: [1, 1],
  caught: [1, 1],
  // Member 14: L4011 at a non-function callee. `const f = 1; f()` is a program the
  // validator ADMITS (measured at 9dc154f8), and the walker answers L4011 where a native call
  // answers a host TypeError. Emitted behind a `typeof` fast path, so a call to a real function
  // never reaches the host.
  callee: [1, 1],
});

/** The member NAMES the seam grants. Derived from the table above, so the two cannot disagree. */
export const SEAM_RULED: ReadonlySet<string> = new Set(Object.keys(SEAM_MEMBERS));

/**
 * Members the emitter reaches that are SURFACED but not yet ruled.
 *
 * Kept apart from {@link SEAM_RULED} on purpose. The alternative to naming the debt is either to
 * stop building or to let a proposed member sit indistinguishable from a granted one, and the
 * second is the forbidden move wearing a green suite. `TransformMeta.proposed` reports which of
 * these an emission actually reached, and `transform.smoke` pins that set, so the debt is a
 * measured number rather than a memory.
 */
export const SEAM_PROPOSED: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Every operator selector the emitter hands `unary`, and no other.
 *
 * `!` and `typeof` never reach here: neither can refuse, so both are emitted natively. `update` is
 * `UpdateExpression`'s operand read, and it carries the coercion refusal rather than the walker's
 * bare `Number(...)`. The walker's answer there (NaN for a record, 6 for `"5"++`) is the
 * silent-coercion class, filed as issue 646 and carried as a declared divergence with named cells.
 * An op set is as much a contract as a member name, which is why it is written down here rather
 * than left implicit in the emitter.
 */
export const UNARY_OPS: readonly string[] = Object.freeze(["-", "+", "~", "update"]);

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
 * The module shape is a CLOSED function expression with zero free identifiers. That replaced an
 * earlier premise this file carried, which a review falsified: the validator admits `$x`, `__y`,
 * and a program-declared `__ctx`. So the ctx parameter's name is derived from the source rather
 * than assumed, and the derivation is deterministic: the same source picks the
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
