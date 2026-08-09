---
"@cotal-ai/core": minor
---
Contract schema registration is bounded structurally, and an unrecognised keyword is now refused.

**This refuses more than before, and it can reject a contract that registered successfully in an
earlier version.** `compileContract` is exported from `@cotal-ai/core` in the released package, so
this is a break against schemas already in use, not an internal tightening. The 2020-12 execution
profile (SPEC §13.7/§13.8) now validates a schema document
against an explicit admitted vocabulary and raises `contract-invalid` for any keyword outside it.
JSON Schema says an unknown keyword is ignored as an annotation; this profile refuses it, because a
profile that enforces bounds cannot soundly bound what it does not recognise — counting only known
keywords silently skipped `contentSchema` and `dependencies`, both of which hold subschemas. The
admitted set covers the full 2020-12 assertion, applicator and annotation vocabulary, so
documentation keywords (`title`, `description`, `default`, `examples`, `deprecated`, `readOnly`,
`writeOnly`, `$comment`) and the `$`-identifiers are all accepted; a vendor extension or a keyword
newer than this release is not, and needs a line added to the profile. If you register contract
schemas, check them against the admitted list before upgrading.

Everything else in this change admits more, not less. The `maxSchemaNodes` and `maxClosureNodes`
ceilings are removed: neither candidate basis for the constant survived measurement, since compile
cost varies up to 46x across schema shapes at one node count, and the compiler crash the bound was
meant to sit below is not a stable edge (the same document threw on a cold compile and succeeded on
the immediate warm retry in the same process). Registration remains bounded by document and closure
bytes, structural depth, reference-chain depth, pattern complexity, the admitted vocabulary, and the
compile-error catch that normalises any codegen failure to `contract-invalid`.

The §13.8 compile and validate time budgets are reported rather than enforced. No instrument on the
supported Node floor measures the intended quantity: elapsed time counts the whole machine, and
`process.cpuUsage()` sums every thread in the process, so background JIT threads and sibling Workers
are attributed to the compile being measured. Enforcing them refused valid arguments on the request
path and refused a manager's own service contract at startup.
