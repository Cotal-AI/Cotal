/** Registration-time bounds (SPEC §13.7/§13.8). Fixed by the profile, not caller-tunable, and
 *  RUNTIME-frozen (the afa715b class): a post-import `maxDepth = MAX_SAFE_INTEGER` would remove
 *  the pre-compilation recursion/DoS ceiling, so mutation throws instead. */
export const SCHEMA_PROFILE = Object.freeze({
  /** One schema document's canonical form, bytes. */
  maxDocumentBytes: 256 * 1024,
  /** The complete resolved closure (root + digest-referenced members), bytes. */
  maxClosureBytes: 1024 * 1024,
  /** Structural nesting depth of any document. */
  maxDepth: 32,
  // THERE IS DELIBERATELY NO SUBSCHEMA-NODE BOUND HERE, and this note is the guard on that: a node
  // ceiling was proposed twice, and the second attempt was killed by the measurement it asked for.
  //
  // The proposal was to refuse a "pathological" schema by counting subschema nodes before compiling
  // — deterministic, host-independent, and unlike a timer, immune to the machine. Two bases were
  // offered for the constant, and both are dead:
  //
  //   COST. There is no knee. Compile cost varies by an ORDER OF MAGNITUDE across schema shapes at a
  //   single node count, the spread itself grows with node count, and no two measurements of one
  //   cell have ever agreed. NO FIGURE IS QUOTED HERE ON PURPOSE. Six runs of the same quantity
  //   across four parties spanned a factor of six, agreeing only where one had read another's number
  //   first, so any single ratio in this comment would be an unreplicated observation presented as a
  //   measurement. Node count is a sound bound and a poor predictor: a single scalar is set by the
  //   worst family and refuses the best, rejecting a cheap union while admitting a far costlier
  //   object schema. THAT SHAPE is what defeats the proposal, and unlike a ratio it survives a re-run
  //   on another host. To see the numbers for your host, run the probe named below.
  //
  //   CRASH. A 2048-node patterned-properties document was observed to RangeError in Ajv's codegen
  //   at ~186KB — inside `maxDocumentBytes` — which looked like a hard edge worth standing in front
  //   of. It is not an edge — not because it is unstable (re-measured for #1551: the SAME 2062-
  //   property/187545-byte document RangeErrors 15/15 fresh processes at this profile's default
  //   stack, and the reported cold-then-warm-compiles pattern did not reproduce once) — but because
  //   the edge is a function of the STACK BUDGET, not the schema: it moves linearly with
  //   `--stack-size` (measured 256KB→~460, 8MB default→~2050, on the pin this profile ships;
  //   flattening ajv's codegen with `allErrors: true` moves the same edge to roughly 3.4x wider at
  //   any given stack budget, never removes it) and by a fraction of a property per extra caller
  //   frame burned before the compile call. A frozen node-count constant cannot express an edge that
  //   moves with the CALLER's stack depth, which is outside this module's control.
  //
  //   AND THE VALUE WAS UNSAFE ON AN AXIS NOBODY MEASURED. Under `node --stack-size=256` a 512-node
  //   object RangeErrors, while 384 compiles — so the proposed `maxSchemaNodes: 512` did not hold
  //   at a supported process configuration. A bound that is not a bound across the axes it ships on
  //   is not a bound.
  //
  // WHAT STANDS IN ITS PLACE is what was doing the work the whole time: `maxDocumentBytes` and
  // `maxClosureBytes`, `maxDepth`, `maxRefChain`, `maxPatternChars`, the admitted-vocabulary
  // refusal, and — for exactly the codegen overflow above — the compile-error catch in
  // `compileWithinBudget`, which normalises a stack overflow to `contract-invalid` naming the
  // COMPILER's generated-code shape and the property count that triggered it, never the caller's
  // schema (#1551). That set refuses everything it refused before; removing an unfounded bound only
  // LOOSENS, and
  // loosening cannot break a contract that was already valid.
  //
  // BEFORE PROPOSING ONE AGAIN, run `implementations/manager/smoke/_probe-nodecount-rejected.ts`.
  // It MEASURES the spread and the crash boundary on your host, against the compiler that actually
  // ships, and reports no stored figures of its own. The first version of
  // this ceiling was derived from a corpus THE CEILING ITSELF BOUNDED — every synthetic above the
  // line was refused, so the calibration reported that nothing measured had exceeded the budget,
  // and the number was unfalsifiable the moment it shipped. Measure above the line, or do not set
  // the line.
  /** Digest-reference chain depth (root → member → member …). */
  maxRefChain: 32,
  /** Compile budget per closure, ms. */
  compileBudgetMs: 100,
  /** Bounded pattern complexity: max characters of any `pattern` / `patternProperties` regex. */
  maxPatternChars: 256,
  /** Per-value validation budget at the serving boundary, ms (§13.8 reference). REPORTED on the
   *  request path, not enforced — no available instrument can justify refusing a caller on it; see
   *  `reportValidateBudget` in endpoint-envelope.ts. */
  validateBudgetMs: 10,
  /** Compiled-schema cache entries (the SPEC's reference 256-entry LRU). */
  compiledCacheEntries: 256,
} as const);
