# Proposed endpoint authority amendment

Revision v2.3 incorporates concrete engineering review of v2/R0 and the discovery-v2 effect reservation. Base source `1bda7c112df8f2740992e7bf458b16b41ba7a616`, R0 test commit
`15e98ac4f27eaf9fd94caac5c1edeef8cc3f636f`. This is a SPEC/API proposal only.
The files beside it are not package exports or shipped validators. Their shape tests cannot
prove authority, revocation, native route enforcement or implementation acceptance.

## First implementation slice and version boundary

The first U1/U2 slice supports exact-instance ephemeral services and callers only. It MUST
refuse journal/action/shared effects/pools, sessions, implicit readers and class/scatter issuance
before material release and before acceptance. These surfaces remain required later product
nodes, not silently removed requirements. The schemas retain class vocabulary for the later
explicit class node, but shape validity does not authorize that feature.

Authority envelopes use version 2. Delegated discovery descriptors use protocol version 3,
because version 2 already denotes the mandatory command effect contract in SPEC13.7.
Version3 retains that guarantee: every command declares read/write effect, with no silent
retry of writes. Native request/reply
envelope `v:1` and existing endpoint subject rails are unchanged. Older descriptor readers MUST
refuse protocol v3 before using its owner or command surface. Caller-first rollout upgrades
readers before advertising delegated v3 services. Legacy private single-owner v1 remains its
explicit legacy policy, not silently reinterpreted. This incompatible ownership/discovery change
requires a pre-1.0 minor release, with no automatic 1.0 designation.

## Section 13.2 replacement

**Namespace governance and serving instances.** An endpoint name MUST bind to one namespace
governor within its account. Single-label names require operator governance. Reverse-DNS
names require a registered domain claim or an explicit governor-authorized subdomain binding.
A serving instance's owner MAY differ from the governor only under a live, explicit serving
delegation. Name ownership MUST NOT be inferred from the serving owner or transferred by
registration. `(endpoint, instanceId)` remains the routable address. The issuer allocates and
permanently reserves instance identity. No body-supplied owner or self-selected existing
instance establishes ownership. AccountPin is a presented expectation compared to the
server-recorded assignment, not client authority. The instance gate still checks exact
serving owner.actor and now also actor lifecycle and recorded holder public key.

The delegation MUST bind account, namespace revision, policy revision, delegate owner/actor/
lifecycle, holder public key, instance identity, complete permitted contract closures, serving
route ceiling and delegation revision. A delegation permits neither a different contract nor
another instance. Manager MUST use this same delegation rule with an operator-authored
canonical Manager policy. It is not a protocol exception. Endpoint-specific command/resource
policies do not imply authority over another endpoint.

A private own-namespace endpoint MAY use governor = serving owner. This does not replace the
generic shared-name delegation mechanism. Membership or a capability string alone confers no
serving delegation, caller grant, target grant or class admission.

## Sections 13.7 and 13.9 additions

`ServiceSpec.owner` identifies the actual serving owner. Add `servingAuthority` and
`serveRoutes` from the issuer's validated decision. `servingAuthority` is the closed tuple
`{ namespaceRevision, policyRevision, delegationId, delegationRevision }`. The corresponding
serve artifact, gate, ledger row and issuer-signed attestation MUST pin the same tuple.
The governor and canonical closure policy are resolved through these immutable coordinates,
not accepted as an authority claim from the service process. Re-registration cannot change
serving owner or holder. A new owner requires a separately allocated instance.

The authority decides on the complete registered cluster closures. Endpoint-wide governed
continuity remains namespace-owned. An instance cannot strip governance through a new
instance, delegated descriptor or caller-selected subset. The first release supports one exact
closure set per class policy revision. An incompatible class surface MUST refuse registration.

A serve route ceiling is either `{ kind: "instance" }` or
`{ kind: "class", classRevision }`. The former MUST mint and consume only exact `inst` request
rails, including reserved `describe`. The latter MAY also mint native queue-qualified `one`
and `all` rails when explicitly admitted by the class policy. No ordinary process configuration
can widen these credentials. `omitClassCommands` is not a security boundary.

Every instance MUST implement reserved describe on its admitted rails. A class-disabled
instance MUST NOT subscribe or possess class/scatter describe rows. The existing wildcard
class describe baseline is preserved for class-admitted services, but is not a right to reach
instance-only services. Instance-only discovery uses account-scoped catalog coordinates then
an exact granted native describe. Describe reports the answering serving owner and immutable
namespace/delegation reference. It does not assert that the name determines one serving owner.

The unchanged `one`/`all` subjects cannot distinguish multiple overlapping cohorts. There
MUST be ONE active governor-authorized compatible receiving set per endpoint/command. A queue
group is not a policy partition: different matching queue groups may each receive and duplicate
an effect. Caller class authority MUST cover that complete receiving set.

A class caller grant MUST cover every eligible class receiver at the admitted class revision,
with the same operation surface. Adding a receiving owner or incompatible closure requires a
new policy revision and caller issuance. No filtering after a shared class publish repairs a
credential that already authorized an ineligible receiver. Scatter selects a policy-authorized
frozen member set and invokes exact instance rows. Do not name this raw `all` publication, which
other matching subscribers could also receive. Private cross-owner members never enter an
implicit public class. A class winner is accepted only with fresh trusted eligible-member and
contract/owner/epoch verification, or the native pre-effect split repair within one deadline.
GE18 forces describe and invoke onto distinct members and requires one actual effect. Revocation fences affected class/delegation grants before new membership.

Caller issuance uses a dedicated minimal endpoint caller permission assembly. Instance
selection MUST compile all operations, including describe, with `instanceOnly: true` and exact
instance id. It MUST NOT retain class/scatter operation rows. Class selection requires explicit
current class authority. No control/admin or agent baseline profile substitutes for this
instrument. Request identity derives from the verified actor token and accepted native
connection, never from request owner, principal, capability rows or issued source coordinates.

## Sections 13.1 and 13.15 additions

New native account-local authority coordinates:

| Coordinate | Storage and rule |
|---|---|
| `endpoint-policy.<encoded-endpoint>` | Policy-head CAS gate in the account auth store. Serializes serving/caller release and policy changes. No participant reads/writes it. |
| `endpoint-delegation.<id>.<revision>` | Immutable first-message authority record in the issued evidence store, with account/name/holder/instance/closure/routes/expiry. Separate live state in the policy head invalidates it. |
| `endpoint-grant.<id>.<revision>` | Immutable first-message caller ceiling/source record in the issued evidence store, never supplied by clients. |
| `endpoint-class.<encoded-endpoint>.<revision>` | Immutable admitted contract and serving-member set, plus policy-head liveness. |

Each authority row is a closed schema with bounded token/digest lists and no overwrite/delete/
purge/rollup authority. Stock registers the kinds and owns grants/scanners. These are proposed
new native coordinates, not files Cloud may mint independently. Source references bind exact
account-local bucket/key and revision. A numeric revision is encoded in the immutable source KEY, not a mutable reused coordinate.
Existing IssuedSourceRef stays `{space,bucket,key}`. Stock resolves the immutable first message
and its current policy-head liveness. The stock source attestor fails closed for unknown,
foreign, revoked, expired or stale policy/class/delegation coordinates.

**One release order.** The minimal implementation serializes mutations and releases on one
policy-head operation gate. The issuer first acquires that gate by leader CAS and records a
durable operation intent. It then acquires the affected instance gate, stages immutable
credential/evidence/ledger rows, wins the instance fence, and completes the policy-head CAS as
the LAST material-release fence. Instance registration/renew/revoke barriers also acquire the
policy-head gate first. No barrier can mutate an instance while a sibling policy operation
holds its release gate. Both failed and uncertain release paths remain held for reconciliation;
there is no expired-lock force-reclaim. This explicit serialized implementation is preferred to
assuming two independent final CAS writes form one atomic transaction. Every recovered
operation uses the same durable identity. A released response is replayed only for the same
verified holder and byte-identical operation, not a freshly reconstructed broader ceiling.

Policy or delegation revocation first blocks admission and issuance through the same gate,
then retires indexed issued generations, drives instance credential-family revocation,
verified live eviction and native admission drain. Completion requires no held admitted work
or live credential from the revoked family. A connected client losing authority cannot continue
untargeted effects. Actor-row UID equality is insufficient to attest a narrowed policy.
A namespace change invalidates every affected cohort. One delegate's retirement leaves an
unaffected sibling delegation live. An operation already completed is not rolled back.

Each private/delegated served request requires the new `requestAuthority.admit` hook before
handler dispatch, including untargeted commands and describe. It validates the exact
broker-authenticated subject against active immutable issued evidence and current sources,
after the last asynchronous bind/target/trait/ledger validation, then holds a native admission
until its outcome is terminal. Admission commits under the policy fence and rechecks the final
coordinates. A revoke begun before admission wins prevents dispatch. An earlier admitted
request keeps drain custody until terminal, so completion cannot overtake any paused handler. Legacy rails cannot satisfy an
issued-authority requirement. On refusal, the handler effect count stays unchanged and the
reply states `not-executed`. Class mismatch/contract/target/trait checks stay fail-closed.

## Holder proof and public interface

The `endpoint-authority-v2.d.ts` is the complete proposed U1/U2 type delta. The JSON schema
covers client requests and namespace/delegation records. Closed requests accept intention and
coordinates only. Every NKey checksum, real signature, owner/account binding, content digest,
expiry and policy decision still needs runtime verification in stock.

### Exact lifecycle proof and retry projection

All timestamps are integer Unix seconds. Challenge TTL is at most 60 seconds; reservation TTL
is at most 300 seconds. Credential and attestation expiry cannot exceed the active delegation
or actor expiry, and must agree with the actual credential. Prepare returns a reservation only,
never an activation challenge or credential. It persists the authenticated serving holder and
permanently reserved instance under the stable prepare operationId. Same operationId with
another holder/account/endpoint/key refuses. A transport retry with a fresh requestId returns
that same reservation only while its holder and policy remain current.

After prepare, the holder submits challenge with complete LifecycleContent. Activate content
uses the reservation's registrationRevision=0/processEpoch=0 and the complete artifact list.
Renew/retire content uses the server's current positive registration revision and process epoch
and an empty artifact list. The server compares these coordinates before challenge release.
A distinct stable operationId identifies each action; all retries of that action reuse it.
The operation digest is SHA256 of RFC8785 canonical JSON over
`{v:2, account, endpoint, instanceId, expected, holder, operationId, content}`. Artifact arrays
are sorted uniquely by digest and all artifact values are verified before hashing. requestId,
challengeId and signature/proof are excluded. requestId is transport-attempt identity only and
cannot change operation meaning. Same operationId with different content refuses.

HolderChallenge is the exact closed signed payload, including domain kind, actual account,
issuer-recorded holder/lifecycle/key, stable operation identity/action/digest, instance,
authority, registration/epoch, nonce and issue/expiry. The holder signs RFC8785 canonical UTF-8
bytes of that entire payload with its recorded Ed25519 user NKey. The server reconstructs those
bytes from durable challenge state, not caller JSON, verifies NKey checksum/signature, content
hash and current policy/holder, then consumes the challenge once under the operation gate.
A committed retry returns the recorded exact material only to the same still-current holder
and byte-identical stable operation. It never allocates/re-mints a family or reuses an expired,
retired or stale-holder operation. Fresh requestId does not invalidate a content-identical retry.

### Decision and artifact ceilings

`authorizeInstance` takes the complete requested AuthorityCeiling and returns its complete
pinned authorized ceiling, including expiry. Stock requires EXACT equality of routes, class
revision, resources, closures and expiry with the immutable delegation under the policy gate.
There is no independent default resource/route profile. First-slice issuance rejects class
routes and any resource other than ephemeral-only before credential release even when its
shape is understood. Account, holder/lifecycle/key, instance and every revision are checked
under that same decision. Service spec, brand, grant compiler and serve table consume that result.

ContractArtifact is `{digest,value}`, where digest identifies the canonical object-or-boolean value, not
its closure digest. Activate supplies the complete verified cluster/schema closure set.
Closure manifests must name present, digest-verified roots/members and match every delegated
cluster closure exactly. Null, unresolved external resources, duplicate digests or extra
unreachable artifacts refuse. Artifacts use the existing stock manifest/2020-12 validators.
Boolean2020-12 schemas retain canonical true/false bytes and digests, never convert to objects.
A canonical artifact is bounded at 256 KiB, aggregate closure at 1 MiB, maximum64 artifacts,
and encoded lifecycle request at 2 MiB. No ambient URI fetch occurs. Challenge payload is
bounded at 16 KiB, service response at 64 KiB, admission/release at 16 KiB. Encoded-size,
time ordering/TTL and cross-field agreement are stock runtime checks, not JSON shape claims.

### Stock-owned signerless client and held admission

`createEndpointServiceClient` receives a trusted account/issuer key/auth-instance/contract pin
from the already authenticated deployment authority, never from the activation response. It
verifies compact EdDSA serve attestation using that pinned issuer/key and domain kind, actual
broker account/assignment and complete ServeAttestation. Actual serve JWT signature/subject,
issuer/account, holder key, credentialId/digest, permissions and issue/expiry must match the
attestation and derived native ceiling. Verify canonical closure digests, holder possession and
fresh current gate/authority through the stock authority path before constructing the local
serve brand. Missing/unknown version/fields, substituted credentials/keys/account/closures or
stale evidence refuse. No arbitrary-JSON trusted snapshot constructor is exposed to clients.

The factory privately constructs a branded EndpointRequestAuthority. A structural no-op admit
callback cannot substitute for it. A trusted in-process host adapter, if later supported, is a
separate explicitly trusted interface, not the default signerless client. Delegated serve
construction refuses absent or unsupported branded authority. The endpoint receives no issuer,
signer, executor, raw auth-store reader or issued evidence reader.

Admission uses stock native direct endpoint request/reply to the separately pinned account-local
`auth` instance, commands `ep-admit` and `ep-release`. Add exact issued instance command rows
for the authenticated serving holder, plus narrowly scoped replies and digest-only contract
fetch. No Manager, new subject grammar or application proxy is involved. Request sender comes
from that issued serving connection. The authority parses the complete application requestSubject,
requires the issued rail, checks the actual immutable caller generation/accepted evidence,
current sources and exact effective permissions, and binds serving holder/lifecycle/account/
instance/epoch/authority plus request id and envelope digest. Application request id retains the existing native
`[A-Za-z0-9_-]{1,64}` grammar, distinct from new separator-free authority operation ids. No application argument or result
bytes go to the authority, only bounded immutable request coordinates/digests.

The authority commits a durable held admission under the endpoint policy gate, then RELEASES
that gate before replying or waiting on handler completion. Its separate drain row persists
admissionId, both holder/caller generations, exact request identity/digests, serving pin and
outcome state. It never holds the global issuance gate over a running handler. Same operationId
and content is idempotent. Unknown/foreign admission, changed content, stale serving generation
or duplicate conflicting outcome refuses. Native policy revocation stops new admission first,
then waits for terminal drain rows. `ep-release` remains authorized for recorded held admissions
while that family is draining, so revoke cannot deadlock its own terminal completion. No TTL
force-clears a live/uncertain admission. Crash reconciliation retains unknown work held until
terminal non-execution/completion is proven.

The native serve boundary calls admit AFTER its final async target/trait/ledger validation and
before dispatch, holds custody through handler/output validation/reply publication, and calls
release in finally for every admitted success/refusal/error. It distinguishes executed,
not-executed and unknown without claiming an uncertain effect did not run. Release failure
remains a held reconciliation record, not silent success. Earlier completed release replay is
allowed only with the identical outcome and recorded serving holder. Fresh lifecycle or a
new key cannot release an old holder's admission merely by naming its id.

`startAuthService` gains only optional `endpointAuthority: { policy }` and an account-bound
handle. Its HTTP exchange/callout supports the generic caller view. The host adapter supplies
fresh policy decisions, not account signers or arbitrary NATS grants. The stock issuer persists
and validates authority records, compiles rows and signs material. Native client control and
application results flow directly between client and endpoint. Authority requests do not proxy
application payloads or results. Manager is never consulted for unrelated service decisions.

A client-side serve brand requires verified issuer attestation, holder proof, exact account/
instance/delegation/currency and digest-verified registered closures. This constructor grants
no signer/mint/storage privileges. An endpoint process does not receive the auth handle,
registration executor, issuer profile, auth-store reader or raw issued evidence. The R0's
records-stream read credential is a test fixture residual, not the proposed shipping client API.

## Minimal source seams and review cells

| Node | Existing source seam | Proposed change | Required native gate |
|---|---|---|---|
| U1 | core `endpoint-service`, `endpoint-serve-kv`, `lifecycle-state` | Instance-aware name decision, immutable delegation tuple, policy/instance gate serialization | GE17, GE07, GE08 |
| U1 | core `endpoint-grants`, `provision`, `endpoint-serve` | Branded serving route ceiling, reserved describe on admitted rails only | GE03, GE17, GE18 |
| U1 | auth `service`, `authority-client`, sealed scanners | Optional generic namespace/service mediation, holder challenge, exact contracts and native revocation | GE01, GE05, GE08, GE17 |
| U2 | auth `token`, `idp`, `permissions`, `service` | Generic endpoint-caller view, fresh policy sources, exact dedicated instrument, accepted generation | GE02, GE04, GE05, GE06 |
| U2 | core `issued-authority`, `endpoint-serve`, native admission seam | Fresh every-request admission and terminal drain, no legacy bypass | GE05, GE10, GE17 |
| U2 | stock catalog/describe | Per-instance ownership plus namespace refs, explicit class cohorts | GE09, GE16, GE18 |

U1/U2 do not promise journal/session/browser closure by themselves. U3 remains separately
gated on those real interfaces. No imagined endpoint-authority route/export was treated as a
product reproduction in R0. Real R0 shows the current namespace and user caller limits.
Review approves concrete source/API invariants above, not a prose-only implementation claim.
