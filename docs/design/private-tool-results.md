# Private tool results

**PROPOSAL. NOT IMPLEMENTED. NOT NORMATIVE OR ACCEPTED.** This page proposes a design for review.
No released or source component implements it, and nothing here changes SPEC.md, a package API or
a deployment. Every rule below stays inactive until the Core/SPEC owner accepts it and the owners
named in section 9 land and qualify their parts.

Source references are to `c28c9ab16532d72f5b53521b808e8a0a93dddb2e`.

## 1. Purpose

A person who owns a managed agent wants to read the result of one of that agent's tool calls
without broadening who can see it. Today the event plane withholds `TOOL_CALL_ARGS` and
`TOOL_CALL_RESULT` from `events.<owner>.<actor>` (`extensions/connector-core/src/agui.ts`, the
`TOOL_CALL_RESULT` handling near line 377 and the egress check in `agui-emitter.ts`). That
withholding stays unchanged. This proposal adds one narrow read path: a verified human consents, a
named holder redeems it, and the serving agent answers that holder through the existing endpoint
control surface, for tool calls that started after the consent took effect.

Out of scope: tool arguments, transcript scraping, a new event reducer, a private HTTP result
path, provider credentials in any client or sandbox, and Manager-specific code in connectors.

## 2. Path overview

1. A verified human proof reaches the host.
2. The host signs a consent naming the target lifecycle and one holder, and records it.
3. The target's Manager asks the host to issue or renew the target's `tool-results` serving
   material through the existing manager-authority request path.
4. The host registers the serving instance, signs a bounded serving credential and returns it with
   a revocation snapshot. The Manager installs it as a 0600 file in the agent's generic launch
   material.
5. The connector applies the consent at a durable source frontier and captures results only for
   tool calls whose canonical START record lies after that frontier.
6. The holder redeems the consent for a caller credential bound to one space, account, instance
   and epoch, and calls the agent's endpoint with that binding.
7. The serving connector checks the binding, the consent audience, credential expiry and the
   revocation snapshot before it releases anything.

## 3. Existing interfaces

These exist at the pinned source and are reused without change unless section 4 says otherwise.

- Manager request envelope: `parseRemoteManagerEnvelope`
  (`packages/core/src/remote-manager-authority.ts:508`) and the serve-epoch variant
  `parseManagedAgentEnvelope` (`:537`).
- Host dispatch of manager requests: `dispatchManagerAuthorityRequest`
  (`implementations/auth/src/service.ts:2477`), which resolves the authorizing actor's ledger row
  and switches on the request kind.
- Current-manager check: `assertCurrentManagerRegistration`
  (`implementations/auth/src/managed-agent-enrollment.ts:37`).
- Serving registration and grant: `registerServiceInstance`, `authorizeServeGrant` and
  `deregisterServiceInstance` (`packages/core/src/endpoint-service.ts:384`, `:1549`, `:1172`).
  `EpServeGrant` carries the instance, epoch and registration revision.
- Receiver incarnation check: the request `bind` block (`packages/core/src/endpoint-envelope.ts:119`)
  is checked by `assertBoundIncarnation` (`packages/core/src/endpoint-serve.ts:140`) before any
  handler runs. A different epoch of the same instance is refused as `expired` and nothing runs.
- Native issuance records and the per-space auth store: `makeNativeIssuanceRecorder`
  (`implementations/auth/src/native-issuance.ts:88`) and `epAuthBucket`
  (`packages/core/src/endpoint-binding.ts:93`).
- Principal eviction: `evictPrincipal` (`packages/core/src/evict.ts`).
- Durable source positions: `DurableSource.end`
  (`extensions/connector-core/src/durable-source.ts:105`), and the emitter's placement of a
  reported position against a read, `boundary` and `queueTerminal`
  (`extensions/connector-core/src/agui-emitter.ts:631`, `:814`).
- Signed artifact anchors: `ANCHOR_ROLES` (`packages/core/src/endpoint-signing.ts:75`).
- A precedent for create-only revocation rows: `revocationKey`
  (`packages/core/src/run-admission.ts:47`).

## 4. Required additions

None of these exist. Each needs its owner's review.

- **Contract.** A `tool-results` endpoint with three handle-mode commands: `tool-result`,
  `tool-result-consent` and `tool-result-revoke`. Closed schemas, one per answer state, frozen at
  declaration.
- **Anchor role.** A `consents` role in `ANCHOR_ROLES`, scoped to `tool-results`.
- **Human proof check.** The auth token path parses the IdP's `auth_time` (integer seconds) and
  `amr` from the verified token. Consent requires `amr` to include a password sign-in, an
  `auth_time` that is not in the future and is at most five minutes old. Refresh, device and
  unmarked sessions refuse.
- **Consent signer and route.** A host-held consent key and a route that signs a consent for one
  target `(owner, actor, lifecycleUid)` and one holder (an interactive actor of the same owner),
  with a window of at most 24 hours. It records each consent id it signs, create-only.
- **Revocation record.** A create-only revocation row per consent id in the space auth store,
  retained until the consent's expiry plus the store's marker retention, with known, refused and
  unknown outcomes. An unknown outcome is read back before any retry and never repeated
  automatically.
- **Serving request kind.** `manager-managed-agent-tool-result-serving` with operations `issue` and
  `renew`, parsed on `parseManagedAgentEnvelope`, dispatched by `dispatchManagerAuthorityRequest`
  and authorized by scope `supervise`, `assertCurrentManagerRegistration` and a ledger check that
  the target is a current managed child of that Manager. Resume is not supported.
- **Serving material.** The host returns the grant, a serving credential and the revocation
  snapshot of section 7. The Manager installs it as a 0600 file named by a generic launch-material
  field. Retirement also deregisters the instance.
- **Caller view.** A redemption that checks the consent, presenter equality and the current
  revocation record, reads the current serving registration and mints a caller credential limited
  to the three commands on that one instance, the stock `describe` of that same instance (section
  8) and the caller's own reply subject. The response names the space, instance and epoch. This
  consent-bound caller authority is new. It is checked against the current durable revocation and
  target lifecycle state at redemption and again at every native callout or connection issuance
  for that caller, including each reconnect. A credential minted before a revocation therefore
  gets no new connection after it. Existing native issuance rows do not implement this check or
  the consent view.
- **Emitter frontier.** `queueFrontier`, modeled on `queueTerminal`, that places a consent's source
  position against each read before capture.
- **Journal and handlers.** The capture, audience and release rules of sections 5 to 7, and a
  handler rule that refuses any of the three commands without a `bind` block.
- **Browser caller.** A Node-free caller that resolves the redeemed instance through the stock
  exact-instance bootstrap of section 8, sends `bind` on every private command, never scatters,
  never guesses or silently changes a target or epoch, never resends after an accepted or unknown
  effect, and drops its binding on account, space or epoch change.

## 5. Capture frontier

A consent takes effect at a frontier `P`, a source position sampled with `DurableSource.end()`
after the consent verifies. Sampling `P` is the linearization point. Every record already in the
source at that call lies at or before `P`, including records not yet read, a read in progress,
replay after a restart and ordinary backlog.

Lifetime fence: the connector records the holder's consent life generation when the consent
arrives. It compares that generation again after every asynchronous step (verification, the
`end()` call and placement) and once more immediately before it commits the consent. A revoke or
replacement at any point bumps the generation, so an in-flight activation for the old consent
refuses and commits nothing. Token registration and pre-capture classification are serialized
with that commit. A frontier whose placement is unresolved grants no eligibility; there is no
eligible-by-default state. The section 7 expiry and snapshot checks do not replace this fence.

The emitter places `P` against each read with the same source-only comparison `boundary` already
uses. A START record is eligible for that consent only if it lies after `P`. Eligibility is
classified against the canonical durable START record, not against when the tool physically ran.
If `P` cannot be placed, the frontier is dropped and the consent is refused. A source whose `end()`
answers later than the call can only exclude more calls.

A RESULT is captured only into an entry its START created. A RESULT never creates an entry.

## 6. Audience

Each entry records, at START, the fixed set of consent ids eligible for it. The set never grows.

- A read by holder `h` answers the entry only if some id in its set is still active, unexpired,
  unrevoked and names `h`.
- Revoking, expiring or withdrawing consent `c` removes `c` from every entry. An entry with an
  empty set is deleted.
- Replacing a holder's consent revokes the old one before the new frontier applies. Results
  visible only through the old consent are discarded.
- A newly consented holder cannot read results captured before its own frontier.

The holder is an interactive actor principal. No per-sign-in or per-browser-session control is
claimed.

## 7. Revocation bound

This bound is offered only when the two prerequisites below are in place. Without them the
serving commands answer `unavailable`, and no numeric bound, immediate cutoff, restart guarantee or
per-sign-in cutoff is advertised.

Prerequisites:

1. A sealed, owner-reviewed, bounded read of the complete revocation snapshot for the target from
   the stream leader, through a watermark taken after `T0`. Authority to write native issuance
   rows does not imply authority to create consumers or read the stream this way. That read
   authority must be granted and reviewed on its own.
2. An established and enforced bound `delta` on connector-to-host clock difference. A configured
   token tolerance such as `CLOCK_TOLERANCE_SEC` (`implementations/auth/src/token.ts:34`) is not
   evidence of measured or enforced skew.

Issuance:

1. Take `T0` from the host clock before the snapshot read starts.
2. Read the complete snapshot under prerequisite 1.
3. Set the credential expiry to `floor(T0 / 1000) + 600` seconds. Signing, writing or installing
   never extends it.
4. Refuse and write nothing if signing happens more than 30 seconds after `T0` or the expiry has
   passed.

Release: immediately before answering a lookup or committing a consent, the connector reads the
installed file and requires that its own clock is before the expiry and that the consent id is not
in the snapshot. Otherwise it revokes locally under section 6 and refuses.

Bound: let a revocation be acknowledged at host time `Tr`. If `T0 > Tr`, the snapshot includes it
and every release refuses it. If `T0 <= Tr`, the expiry is at most `Tr + 600`, so with
`|connectorNow - hostNow| <= delta` no release happens at host time `Tr + 600 + delta` or later.

Limits: a restarted connector may re-apply a revoked consent inside that window. An already
connected caller keeps its transport until eviction, whose outcome can be unknown and which acts on
the whole principal, or until its own credential expires, but it receives no result past the bound.
The host and the Manager that installs the file are trusted.

## 8. Receiver answers

Bootstrap: before invoking, the caller runs the stock instance-addressed `describe` on the one
redeemed instance and verifies its contracts and digests, as `openBrowserEndpointCaller`
(`packages/core/src/browser-control.ts:114`) does through `describeEndpoint`
(`packages/core/src/endpoint-caller.ts:77`) on the `inst` route. It refuses an answer from any
other instance or an epoch that differs from the redemption. This needs the narrow, explicitly
reviewed `describe` grant of the caller view. Class discovery, scatter and a homemade contract
are not used. In stock, `describe` carries no `bind`, because it is the bootstrap that produces
one (`packages/core/src/endpoint-call.ts:99-108`).

Every private command after that requires a `bind` block whose instance and epoch match the
redemption. `assertBoundIncarnation` already refuses a different epoch of the same instance before
the handler runs. The handler refuses a request with no `bind` before it touches the journal. The
caller learns the instance and epoch only from its redemption.

`tool-result` answers one of these closed states:

- `available`, with thread id, tool call id, content, truncated, byte count, error flag and capture
  time. Empty or falsy content such as `""`, `"0"`, `"false"` and `"null"` is a result.
- `pending`, naming the pair.
- `not-shared`, `missing` or `expired`, carrying nothing else.

Content is inert text bounded to 64 KiB of UTF-8. The journal holds at most 256 entries for at most
one hour and never stores arguments.

## 9. Owner order

1. Core/SPEC owner: accept sections 4 to 8, the anchor role, the request kind, the record families
   and the limits.
2. Auth and host owners: human proof check, consent signer and route, revocation record, serving
   request authorization and issuance under section 7, caller view, and the consent-bound current
   revocation and lifecycle check at redemption and at every native callout, connection issuance
   and reconnect.
3. Core and Manager owners: generic launch-material field, serving material installation, renewal
   before expiry and removal on failure.
4. Connector-core owner: `queueFrontier`, capture, audience, release check and `bind` requirement.
   Connectors use only the generic launch field.
5. Browser SDK owner: the browser caller.
6. Release and adoption owners: a stock release before any product exposes it.

## 10. Qualification cells (UNRUN)

Positive:

- Fresh password sign-in, consent, a tool call whose START is after the frontier, and a read that
  answers `available` with content `""` and with `"0"`.

Negative:

- Refresh, device or unmarked session, `auth_time` older than five minutes, in the future or in
  milliseconds: consent refused.
- A START appended before the frontier but read after it: not captured.
- A second holder consenting later: cannot read earlier results.
- Revoke one of two holders: the other keeps entries shared with it.
- Same-space non-holder, the target agent itself and a cross-space consent: refused.
- Stale epoch: `expired` before the handler. Missing `bind`: refused.
- Snapshot read taken before `T0`, signing more than 30 seconds after `T0`, expired file: refused.
- Revocation with `T0 <= Tr`: no release at or after `Tr + 600 + delta`. With `T0 > Tr`: refused at
  the next release check.
- Unknown revocation outcome: read back, no automatic repeat.
- Prerequisite 1 or 2 of section 7 absent: commands answer `unavailable`.
- The public event plane still carries no `TOOL_CALL_RESULT`.

## 11. Activation gates

Nothing in this page may be enabled until all of these hold:

- the Core/SPEC owner has accepted it;
- each owner in section 9 has landed and qualified its part;
- the section 7 prerequisites are in place, or the commands stay `unavailable`;
- a stock release carries it, and any product surface has its own freshness and viewer
  qualification.
