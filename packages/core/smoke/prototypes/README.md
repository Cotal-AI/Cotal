# Issued permission prototype

[CLAIMS.md](CLAIMS.md) labels every claim on this page as measured or asserted, and names the
cell and mutation behind each measured one. Start there if you are reviewing.

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

The cell that holds a finalizer blocked watches the attempt state across a bounded window rather
than sampling it once. Activation and the test's read are both round trips, so one sample races
the writer: it passed under the unawaited-finalizer mutation on current main while failing on the
older base, which means the single sample had been proving nothing about ordering all along.

The auth smoke supplies pins and finalization from the real
`stageAgentMint`/`finalizeAgentMint` path. It freezes real source gates and walks
the prototype index explicitly. No production barrier has that attachment.
Released material is a synthetic marker, never a signed credential. The lost-ack
cell injects an error after a real committed KV write; it does not partition a
network. Reopening the prototype proves state survives an object restart. A separate cell kills the
broker process with SIGKILL and brings it back on the same file store, then resolves and
retires the issuance through a fresh connection, so process death is covered too. Neither
covers a crash mid-write with unflushed data.

The index walk is measured on a least-privilege principal rather than the operator
connection: a user granted the issued bucket and nothing else runs `retireSource` to
completion, and the same credential is refused a read of the auth bucket in the same
space. That principal necessarily holds a write and a raw read on one stream, the pairing
the census forbids for peer-held profiles; a revoker is trusted infrastructure, which is
where the census already places every such overlap. This is a grant measurement, so it
carries no mutation of its own; the walk's own logic is covered by the retirement and
source-index cells. It is still not the production sealed-scanner discipline, which binds
a dedicated plane-owned connection and a claim guard to the auth stream, and would need
its own scanner over this bucket.

```sh
pnpm exec tsx implementations/auth/smoke/issued-authority-lifecycle.smoke.ts
pnpm mutation-proof --config implementations/auth/smoke/mutations/issued-authority-lifecycle-prototype.json
pnpm exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --types node implementations/auth/smoke/issued-authority-lifecycle.smoke.ts
```

Revocation is carried by the attempt row's state, separate from the immutable evidence
record, so absence of a revocation is a readable `active` state rather than a missing key.
The linearization point for a resolution is the second attempt read: the resolver reads the
state, awaits source authorization, then reads again and refuses unless the state is still
`active` at the same revision. A read failure on that row is refused, never taken as absence
of a revocation; a named mutation turns the failure into `active` and the cell goes red.

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

## Accepted-generation discovery

`issued-generation-discovery.ts` answers how a client learns which generation the issuer
actually bound. It requests the native `$SYS.REQ.USER.INFO` subject, which on NATS 2.14.5
returns the server's own view of the connection: account, user, and the enforced publish and
subscribe permissions. The client then reads the generation out of its granted rail rows.
The answer comes from the broker, never from the credential the client presented or the name
it proposed.

Measured limits. No current profile holds a grant that would let it request its own server view
(a census cell, with a positive control), and a connection without that grant cannot discover its
generation (a static cell), so production issuance would have to add `$SYS.REQ.USER.INFO` to each
issued ceiling. A
connection whose publish permissions are unrestricted names no generation and refuses. Grant
rows carrying two generations, a wildcard generation, or a malformed field all refuse rather
than picking one. Foreign-space rows are ignored.

The static smoke covers a signed tag that disagrees with the granted rows: the binding follows
the tag, discovery follows the grants, and the two are asserted to differ. It also holds a live
connection to its original answer after the credential file is replaced. The callout smoke has
the issuer bind a generation different from the client proposal; discovery reports the issuer's,
and the proposed rail is natively denied.

An auto-reconnecting callout client is measured too. The connection name is fixed at connect
time, so a reconnect re-proposes the same generation, the issuance lifecycle refuses to prepare
it a second time, and the transport closes with an authorization error rather than acquiring a
new ceiling in place. The original attempt stays active and no second issuance appears. That
outcome rests on the same fresh-generation-only rule the reuse cell names, and the named
mutation for it is attached to that cell.

Discovery establishes what the broker enforces for this connection. It does not establish that
a durable issuance record exists; that remains the issuer-side lifecycle evidence. The static
discovery mints grant `_INBOX.>`, wider than the production per-connection inbox confinement,
because inbox scoping is not what these cells measure. The client side of that transition is covered: a client observes the closure, rebinds on a
fresh generation, delivers a request on the new rail, and is natively denied on the old one.
`rebindOnAuthorizationClosure` refuses a clean close and refuses a transport failure, so a
closure for any other reason is not retried as an authority transition. The transport-failure
branch uses a hand-built closure result, since a live broker does not produce one on demand;
the authorization branch is the live path.

## Dual-rail migration refusal

`issued-request-admission.ts` is the candidate rule an endpoint applies while it serves both
the legacy and the versioned rail. A legacy arrival classifies as `legacy` with the named
reason `unbound-caller-authority`, so caller-scoped admission refuses it by name instead of
running it under trusted-host authority. A versioned arrival classifies to its exact reference.
A malformed generation on the versioned rail throws; it is never demoted to a legacy arrival,
which would turn a broken binding into a silent compatibility path. Subjects from another space
throw.

The static smoke publishes both a real legacy subject and a real bound subject and waits for
each to arrive on a live subscription before classifying, so the shapes are the ones the broker
actually delivers. The generation's position is pinned across every rail mode: `one`, `all` and
`inst` all place it one token from the tail, which is the offset both the admission classifier
and the discovery parser walk. This is classification only: no endpoint handler, admission record or run
policy is attached, and the versioned mode token is the only thing separating the two rails.

## Current profile census

The census constructs every `Profile` and covers the generic callout views. Its
option variants are explicit representatives. `manager-service` is tested as a
refused generic view; the two system-account credential kinds are listed outside
the data-account matrix. Endpoint-serve appears twice: the raw row builder, and the
wider shape a fenced mint composes on top of it (journal effects bind, one owned pool
bind, `$JS.API.INFO`, and the connection inbox). The fence that releases those rows is
covered by `endpoint-serve-auth.smoke.ts`, not here. These limits remain open for full
migration acceptance, except the option-combination one: the per-variant checks cover
representative options, and a scan of every shipped `.ts` under `packages/*/src`,
`implementations/*/src` and `extensions/*/src` shows no builder emits an `ep.v1` subject at
all, so no option combination can reach that namespace. The scan carries a positive control
requiring it to have reached the endpoint subject builders, and two named mutations: skipping
a source tier, and making a real builder emit the issued rail.

Every profile is classified peer-held or trusted, and the two lists must union to exactly the
declared set. Peer-heldness is a deployment property, so no cell here can settle which side a
profile belongs on; what the closed union buys is that a new profile lands in neither list and
fails, instead of drifting into the trusted half by default.

The overlap check counts `$JS.API.DIRECT.GET` and `$JS.API.STREAM.MSG.GET` and no other
read. A pull `CONSUMER.MSG.NEXT` also delivers to a caller-chosen reply subject, but the
frame keeps its original captured subject, so it cannot place bytes on the rail; the
ingress-origin suite is where that was measured.

The census also measures which profiles hold both a write and a raw stream read
(`$JS.API.DIRECT.GET` or `$JS.API.STREAM.MSG.GET`) on one stream, the condition that
would let a credential place bytes of its own choosing under any subject. Today that
pairing appears only in trusted infrastructure and operator profiles; the four
peer-held profiles are asserted to have none. `agent` and `observer` do hold raw
reads, on streams they cannot write, so their zero is a measurement rather than an
absence of grants. A positive control requires the detector to keep finding the known
trusted overlaps, and a named mutation adds a profile with a known overlap to the
peer-held list.

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

## Ingress origin measurement

`implementations/auth/smoke/issued-ingress-origin.smoke.ts` measures the SPEC 678-695
consumer-delivery confused deputy against the candidate rail, using the stock agent
profile as production mints it and the serve subscription shape an endpoint really
uses (wildcard filter, queue-qualified). Measured on NATS 2.14.5:

- A direct publish onto the rail is denied.
- A push consumer whose `deliver_subject` is the rail is created, but its delivery is
  interest-gated and never reaches the wildcard queue subscription. An earlier probe
  saw delivery only because it listened on the exact subject, which no endpoint does.
- A pull `MSG.NEXT` whose reply is the rail does reach that subscription, and the
  frame RETAINS its original captured subject with a `$JS.ACK.` reply. This answers
  the determination SPEC 690-693 leaves to the reference implementation by test.
- A KV `STREAM.MSG.GET` whose reply is the rail reaches that subscription UNDER the
  rail subject, with no headers and an empty reply.

- A `DIRECT.GET` whose reply is the rail reaches that subscription under the rail
  subject carrying the raw stored bytes, with `Nats-Stream`, `Nats-Subject`,
  `Nats-Sequence` and `Nats-Time-Stamp` headers. The stock agent holds this read only
  on `EPC`, a stream it cannot publish to, so it does not choose those bytes.

Read together, no granted path delivers attacker-chosen request-shaped bytes under the
rail subject without a marker. The frame that arrives unmarked on the rail carries a
JetStream API envelope the agent cannot shape; the frame that carries raw bytes to the
rail carries `Nats-` headers and replays a stream the agent cannot write; the frame whose
bytes the agent does control arrives under its original captured subject.

That is a property of the current grant set, not an invariant. It closes the moment one
credential can both write a stream and `DIRECT.GET` it, which would put attacker-chosen
raw bytes under an arbitrary subject. Treat the present result as exposure measurement,
not as the origin defense; a later schema or subject miss is not an origin proof. The
raw `STREAM.MSG.GET` and `DIRECT.GET` reads the v0.3 agent binding still holds are what
SPEC 3151-3152 places in scope for v0.4 remediation. The census now asserts that closing
condition against every peer-held profile, so a future grant change that introduces the
pairing fails there rather than silently invalidating this measurement.

This suite measures broker behavior, not first-party logic, so no mutation proof applies
to it. Its negatives are meaningful because each runs beside a positive control: a
conforming request is received on the same subscription, and the agent's own denial and
its stored write are asserted before the deputy attempt.

```sh
pnpm exec tsx implementations/auth/smoke/issued-ingress-origin.smoke.ts [observations.json]
```
