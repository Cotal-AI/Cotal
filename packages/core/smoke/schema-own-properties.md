# Own-member conformance repair

The Node compiler enables Ajv's documented `ownProperties` option. This repairs five of the twenty observed Node cases, M04–M08. It does not finish #3623 or the browser validator. The other fifteen verdicts and the adjacent `__proto__` schema-property filter remain unresolved.

Build the actual package, then run its public-export regressions:

```sh
pnpm --filter @cotal-ai/core build
pnpm --filter @cotal-ai/core smoke:schema-own-properties
pnpm --filter @cotal-ai/core smoke:schema-own-properties-controls
pnpm --filter @cotal-ai/core smoke:schema-conformance-20
```

The full twenty-case gate remains red. Every invocation evaluates all twenty cases through `@cotal-ai/core`, including synchronous results, the private brand, frozen pairs, original digests and unchanged schema/instance bytes. The controls cover ordinary error arrays, cache/table identity, closed references and profile bounds. Optional `--receipt <path>` and `--ordinary-reference <path>` arguments retain and compare ordinary error arrays across runs.

The existing CI unit job builds the packages and runs both passing gates through `pnpm test`. The mutation fixture builds core and invokes the same public regression file directly from the repository root. The existing mutation safety checker resolves `smoke:*` tokens against the root package scripts, not a `pnpm --filter` package. Using the core-only script names caused the initial CI fan-out to omit this fixture, so that green mutation run proved none of M04–M08. Direct file invocation keeps the suite inspectable without changing the safety checker or workflow:

```sh
pnpm mutation-proof --config packages/core/smoke/mutations/schema-own-properties.json
```

It removes only `ownProperties: true`, rebuilds the real package and requires each named M04–M08 verdict to fail. Each restoration rebuilds and reruns the partial and control gates. Neither a red full gate nor a source-only draft is a passing mutation proof. CI results are required before claiming validation of this draft. No successful local install, build or 128 MiB-constrained run is claimed.
