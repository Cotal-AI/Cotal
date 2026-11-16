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
  // No subschema-node ceiling: schema shape, not a node count, determines preparation cost.
  // The interpreter does not generate per-property validator code. Bytes, depth, reference-chain,
  // pattern and vocabulary admission still run before preparation. Preparation failures remain
  // contract-invalid, and compilation is not refused using process-wide CPU measurements.
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
