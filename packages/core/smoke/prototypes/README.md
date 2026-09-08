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
