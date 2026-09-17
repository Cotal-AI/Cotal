---
"@cotal-ai/cmux": patch
---

Pin the cmux wait-stub to a .cjs extension so its module system stops depending on TMPDIR

The cmux package suite writes a small stub CLI under `tmpdir()` and points
`CMUX_BUNDLED_CLI_PATH` at it. The stub body is CommonJS and calls `require("node:fs")`,
but the file was written with no extension, and node decides the module system for an
extensionless file from the nearest `package.json` above it. With TMPDIR outside the
repository the stub loaded as CommonJS and the suite passed 12 of 12. With TMPDIR
pointing inside a `"type": "module"` package the same stub loaded as ESM, `require`
threw `ReferenceError: require is not defined in ES module scope`, and the suite died
after 5 assertions. `smoke:package-test-contract` reported the same failure through its
`@cotal-ai/cmux: filtered test command exits 0` cell.

Naming the stub `cmux-stub.cjs` fixes the module system at the file, so the result no
longer depends on where the ambient TMPDIR points. Nothing reads the stub by basename,
and the path reaches the runtime only through `CMUX_BUNDLED_CLI_PATH`, which places no
constraint on the extension.
