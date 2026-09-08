# Issued permission prototype

This directory holds test-only proof development for the issued-authority contract.
Nothing here is exported from core or attached to credential issuance, endpoint
registration, or workflow admission.

The component describes subject permissions. Constructing a value does not prove
that an issuer granted those permissions. A future trusted resolver must establish
that provenance separately.

Native NATS empty allow lists import as unrestricted, subject to denies. An empty
application-requested list constructs deny-all and exports an explicit native deny.
Dynamic reply permissions and queue-qualified subscriptions are unsupported here
and refuse; they are never flattened into standing authority.

Run from the repository worktree:

```sh
pnpm exec tsx packages/core/smoke/issued-subject-permissions.smoke.ts
pnpm mutation-proof --config packages/core/smoke/mutations/issued-subject-permissions-prototype.json
pnpm exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --types node packages/core/smoke/issued-subject-permissions.smoke.ts
```

These checks are prototype controls, not the production issuer, reconnect or
revocation acceptance suite. Promote code into shipped core only after the
contract and native-entry/mutation proofs are complete.

## Issued lifecycle prototype

`issued-authority-lifecycle.ts` exercises a separate prepared/active/aborted/revoked
attempt record and immutable evidence on file-backed, leader-read JetStream KV.
Each source index ends in the permission generation; a reused bearer credential
ID cannot merge different issuances. The final activation uses the original
prepared revision. An abort that wins that CAS prevents release.

The auth smoke supplies pins and finalization from the real
`stageAgentMint`/`finalizeAgentMint` path. It freezes real source gates and walks
the prototype index explicitly. No production barrier has that attachment.
Released material is a synthetic marker, never a signed credential. The lost-ack
cell injects an error after a real committed KV write; it does not partition a
network. Reopening the prototype proves state survives an object restart, not a
broker crash. Its operator-only index scanner is unsuitable for delegated use.

```sh
pnpm exec tsx implementations/auth/smoke/issued-authority-lifecycle.smoke.ts
pnpm mutation-proof --config implementations/auth/smoke/mutations/issued-authority-lifecycle-prototype.json
pnpm exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --types node implementations/auth/smoke/issued-authority-lifecycle.smoke.ts
```

Static issuance, callout success delivery, reconnect, complete credential-source
revocation and hosted run admission remain outside this prototype. A fresh
generation is required for every stage here; existing-generation redemption is
unsupported. Prototype records and key choices do not change the wire contract.

The root-source cells use real `ensureRootCredential` issuance and signature-validate
synthetic bearers before calling `authorizeConnectCredential`. Their immutable
source references include the credential row and lifecycle head. Revoking the row,
changing the head to disagree with the root, or expiring the row denies resolution
even before the permission-generation index is retired. The head mismatch is
operator-injected inconsistent state, not a root-rotation implementation.

These cells call the credential reader directly. They do not pass a new generation
through auth-callout CONNECT. A forced revocation after validation reproduced a
release gap in the candidate adapter. The test-only `credential-release-fence.ts`
now captures the existing active credential row and touch-CASes its original bytes
and revision after the existing finalizer. A revocation that wins first prevents
release. If the touch wins first, the explicit source-index walk aborts the prepared
attempt before activation. Production revokers have no such attachment yet.

The earlier agent fixture now uses millisecond ledger expiry, checked by the real
reader; bearer expiry remains in seconds. No production expiry or credential
behavior changed. The source touch preserves the original row bytes and adds no
new credential identity or gate. Re-reading a newer revision for that touch would
revive revoked source state, which has its own named mutation control.

## Static connection binding

`issued-static-connection.ts` extracts one candidate signed metadata tag and returns
its frozen reference only after native broker authentication. Metadata extraction
and the authenticator share a private copy of the presented credential bytes.
Replacing a credentials file takes effect only on a new explicit binding. A native
reconnect keeps the original snapshot and generation.

The auth smoke signs actual NATS user credentials, persists their permission
evidence and runs the existing agent-mint finalizer before returning the bytes.
It compares the recorded ceiling with the signed claims and exercises actual
request substitution denials, separate channel ceilings and native reconnect.
A Buffer input exposed shared bytes through `slice()`; copying with the Uint8Array
constructor fixed the reproduced reconnect failure.

```sh
pnpm exec tsx implementations/auth/smoke/issued-static-binding.smoke.ts
pnpm mutation-proof --config implementations/auth/smoke/mutations/issued-static-binding-prototype.json
pnpm exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --types node implementations/auth/smoke/issued-static-binding.smoke.ts
```

This uses a candidate metadata tag and native JWT encoding, with an operator test
connection. It does not attach to shipped `mintCreds`, registration, endpoint
serving or auth callout. Same-credential reconnect does not prove callout remint
under changed policy. The full profile census and production integration remain
open. Generated credential files stay in the test's private temporary directory.

## Auth-callout response gating

The auth-side `issued-callout-gate.ts` runs the unchanged callout handler against a
per-request capturing transport. Native libraries reopen and verify its prepared
sealed response. Success reaches the broker only after the separate awaited
issuer operation succeeds. Failure is rendered as a signed denial by the same
handler. No onMint callback participates in this gate.

The smoke uses actual callout connections and a data-account witness. It holds
success behind a pending issuer operation, checks two generations of the same
signed bearer under changed policy, and proves native substitution denials.
Issuer failure and generation reuse refuse. Missing, tampered and revoked bearer
credentials retain their existing rejection paths.

```sh
pnpm exec tsx implementations/auth/smoke/issued-callout-binding.smoke.ts
pnpm mutation-proof --config implementations/auth/smoke/mutations/issued-callout-binding-prototype.json
pnpm exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --types node implementations/auth/smoke/issued-callout-binding.smoke.ts
```

The candidate connection name is `ia1_<generation>_<inboxNonce>`, with two separate
128-bit random fields. This proof explicitly selects an implementing test issuer;
connection success alone is insufficient discovery of production support. Reuse
of a generation is rejected and automatic reconnect is disabled. A fresh binding
uses a fresh generation. The transport wrapper is proof machinery, with extra
per-request handler setup; production still needs a direct prepared-response and
mandatory release interface, authenticated discovery, renewal and complete revoker
integration. No shipped handler, option or normative encoding changed here.

## Current profile census

The census constructs every `Profile` and covers the generic callout views. Its
option variants are explicit representatives. `manager-service` is tested as a
refused generic view; the two system-account credential kinds are listed outside
the data-account matrix. Endpoint-serve uses its raw row builder, rather than a
fenced mint. These limits remain open for full migration acceptance.

Publication and subscription are checked separately. A conservative intersection
checks the whole candidate namespace; native probes check one concrete request
and reply in both directions. Positive, deny-all and asymmetric native controls
keep absence results meaningful. Queue-qualified serve subscriptions are reported
as unsupported by the current permission component, without flattening their rights.

```sh
pnpm --filter @cotal-ai/core build
pnpm exec tsx implementations/auth/smoke/issued-profile-census.smoke.ts
pnpm mutation-proof --config implementations/auth/smoke/mutations/issued-profile-census-prototype.json
pnpm --filter @cotal-ai/core build
```

The package exports compiled core, so the proof rebuilds it for each mutation.
Rebuild once more after mutation proof restores the sources, before running other
work. This census records the current legacy grants; it must be revised deliberately
when production issuance moves to the versioned namespace. It does not authorize
a compatibility fallback.
