# General endpoint R0

These test-only files drive the public package roots at the checked-out source revision.
They start one sandbox broker, two real Better Auth users, two data accounts, account-scoped
`startAuthService` contexts and separate non-Manager endpoint processes.

The authority fixture alone holds account signing material. Endpoint workers receive scoped
serve credentials and a read-only records/contract reader, never an issuer or executor.
The reader's leader-served records-stream metadata access is an explicit fixture residual.

Run after building core, lang, workspace and auth, with a private sandbox HOME/TMPDIR and
an absolute output path in `ENDPOINT_R0_REPORT`:

```sh
node --import tsx implementations/auth/smoke/general-endpoint-r0.smoke.ts
node node_modules/typescript/bin/tsc -p implementations/auth/tsconfig.r0.json
```

The run bounds work at 150 seconds. The external runner must bound and own cleanup too.
Use the shared validation lock and verified 4 GiB memory with zero swap.

Named observations distinguish real user exchange/callout/describe/invoke paths, exact
operator-minted positive controls, current namespace-policy refusal, native broker denials,
handler effect counts and resource closure. Guessed routes, a proposed view and proposed
exports are marked as hypothesis probes, not existing interfaces.

A green R0 reproduces the current limitations. It does not prove generic signerless serving,
shared-name delegated serving, browser execution or migration acceptance. Do not authorize
another serving owner in the fixture to pretend that delegation exists in the stock API.
