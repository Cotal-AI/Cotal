# @cotal-ai/auth

## 0.79.0

### Patch Changes

- d242385: The auth service now builds its data account's signing context in one place. The authority plane's own mints, the remote manager credentials it issues and the delivery-admin endpoint all sign through it, where before the delivery-admin endpoint and the manager-service issue path each spelled their own copy. Credentials are unchanged.
- 7e72329: The run attempt and run revoke parsers now parse their own registered-manager envelope. They used to rewrite the request into a run admission with a placeholder `run` and hand it to the admission parser. A `manager-run-attempt` that carries a `run` field is now refused as an unknown field, where it was accepted and the field dropped. Attempt and revoke refusals name their own kind and carry the `manager run attempt request` or `manager run revoke request` prefix. The manager-service authority parser also refuses a `session` request whose `session` carries a key other than `id`, `endpoint`, `sessionId`, `epoch` and `exp`, and returns a session built from the checked fields, where it returned the caller's own object.
- fbc3e2d: Whether a consumer info or delete found no consumer is now decided by one predicate, `isConsumerNotFound` in `@cotal-ai/core`, which accepts only the broker's structured `ConsumerNotFound` error. It no longer accepts a bare `name` of `ConsumerNotFoundError` or a string `code`, so the run journal's replay cleanup no longer swallows those shapes. The stream, KV scan, run wait, delivery `pending` and auth scanner sites use it in place of their own copies, and `isJetStreamMissing`, the structured check it builds on, is exported beside it.
- Updated dependencies [50747b1]
- Updated dependencies [fbc3e2d]
- Updated dependencies [c535d98]
- Updated dependencies [36b03b0]
- Updated dependencies [2bd492c]
- Updated dependencies [5e9a618]
- Updated dependencies [7cb89f9]
- Updated dependencies [aaa6bc9]
- Updated dependencies [db962ae]
- Updated dependencies [4aafb0d]
- Updated dependencies [92590e8]
- Updated dependencies [c03f2af]
- Updated dependencies [79ace0f]
  - @cotal-ai/workspace@0.79.0
  - @cotal-ai/core@0.79.0
  - @cotal-ai/lang@0.79.0

## 0.78.1

### Patch Changes

- aa8c947: The auth plane now derives the remote manager's serve surface from the cluster document core parsed, instead of re-checking the raw document with its own field checks. Activation parses the submitted `ai.cotal.manager` document with core's parser, and standing renewal and run attempts use the document core verified at registration. A manager cluster that declares a journal-class command, which core admits and registers, is now refused with `EpEnvelopeError` `failed-precondition` naming the command. Before, it was refused with a plain `Error` and no code, as was an activation request that submits no manager cluster document, which is now refused `bad-request`. The stock manager cluster is all ephemeral, so stock activation, renewal and runs are unchanged.
  - @cotal-ai/core@0.78.1
  - @cotal-ai/workspace@0.78.1
  - @cotal-ai/lang@0.78.1

## 0.78.0

### Minor Changes

- c4cd8dc: `POST /manager-service-authority` now applies the exchange face's refusal budgets, as `POST /exchange` does. A missing or wrong loopback capability counts in the invalid-capability window, and a refused IdP token or request counts against the face's refused-exchange budget, per peer on the public face. After 30 refusals in a minute a further refusal answers 429, where the route used to answer 401 or 403 without limit. `ManagerServiceAuthorityCtx` now requires the `failures` and `badCaps` windows, so a host that builds it without them no longer compiles; see the upgrading guide.
- 70fb24e: `SecretStore` gains `create(key, value)`, a write that stores the value only while the key is absent and resolves whether it did. `FsSecretStore` implements it with an exclusive create. `ensureCalloutAuth`, `ensureIssuer`, `ensureOwnerSecret` and the hosted auth plane's instance identity now write their first value through it and adopt the stored value when another caller created it first. Before, two concurrent first calls on one space each minted a value, the later `put` replaced the earlier one, and the earlier caller kept a value the store no longer held: one IdP subject could derive two owners, a bearer could be signed by a key the stored issuer does not publish, and a prepared broker could preload a callout account the auth service never loads. A store of your own must now implement `create` as one atomic step; see the upgrade guide.

### Patch Changes

- af7fd7a: `handleManagerServiceAuthority` now answers a body over 64 KiB with 413 and a body that is not JSON with 400 itself, and answers a JSON `null` body with the same 400 as a body without `idpToken`. Before, those rejections escaped the returned promise, so a host that served the export behind its own `http.createServer` exited on such a request instead of answering it. The auth service's own listeners already answered 413 and 400.
- Updated dependencies [a7f39aa]
- Updated dependencies [981b567]
- Updated dependencies [8b92413]
- Updated dependencies [a74b832]
- Updated dependencies [d04629a]
- Updated dependencies [905a78b]
- Updated dependencies [8344353]
- Updated dependencies [f9a71ce]
- Updated dependencies [b9499b3]
- Updated dependencies [c2d8362]
- Updated dependencies [70fb24e]
- Updated dependencies [de3c0f7]
- Updated dependencies [a32e955]
- Updated dependencies [7d13389]
  - @cotal-ai/workspace@0.78.0
  - @cotal-ai/core@0.78.0
  - @cotal-ai/lang@0.78.0

## 0.77.1

### Patch Changes

- @cotal-ai/core@0.77.1
- @cotal-ai/workspace@0.77.1
- @cotal-ai/lang@0.77.1

## 0.77.0

### Minor Changes

- 6979e05: `validateUserToken` and the `IdpConfig` of `verifyIdpToken` and `createIdpBridge` no longer take `clockToleranceSec`. Both verifiers allow a fixed 5 seconds of clock skew, the default they already applied. Nothing in the repository passed the option, and a `NaN` value, such as `Number()` of an unset environment variable, turned off the expiry, not-before and issued-at checks so an expired or post-dated token was accepted, while a large value widened them by that many seconds.

### Patch Changes

- Updated dependencies [6861390]
- Updated dependencies [7d1b600]
  - @cotal-ai/core@0.77.0
  - @cotal-ai/workspace@0.77.0
  - @cotal-ai/lang@0.77.0

## 0.76.0

### Minor Changes

- 19fac82: Remove `allowManagerAuthority` from the exchange policy that `handleManagerServiceAuthority` takes. Both exchange faces set it to `true`, so its refusal could never fire, and the route table alone decides which face serves `POST /manager-service-authority`. The docs and source comments now list that route on the public listener, which has always served it. A policy object literal that sets `allowManagerAuthority` no longer compiles, and a JavaScript caller that set it to `false` is no longer refused by the handler; see the upgrading guide.
- 15d10c9: Refuse competing patched same-host consuming sessions without replacing their logical inbox owner. Preserve live control listeners and existing foreground actor material. Make fresh local foreground grants and departure cleanup generation-aware. This containment does not fence other hosts, broker URL aliases or older clients.
- 31b22ae: Issue managed seats' manager-caller run authority when their current persona scope and fresh same-owner parent grant both carry run. Preserve the signed permission ceiling, actor-row lifecycle source, interactive issuance and ordinary legacy commands.
- 3d0a5f9: Add an owner-bound platform supervisor authority door to the hosted auth service. It reuses native manager registration and renewal, checks a current administrative assignment, confines issuance to one owner and lifecycle, and records the registration credentials' signed permission ceilings before returning material. Recorded permissions match the authority-plane signed native set at issuance and every renewal without widening. `endPlatformSupervisorAssignment(owner)` ends an assignment the host recorded `ended`: it retires the manager gate and the issued generations, so registration, activation and renewal refuse previously returned material by name before it expires.

### Patch Changes

- 97f953f: `cotal actor revoke` now mints its live-connection eviction credential with a 60 second lifetime instead of the supervisor profile's 24 hour default. The revoke-time eviction, the barrier evictors and the liveness oracles that call the delivery daemon's `ctl.delivery-admin` rail now share one connection helper, so the lifetime and the non-participating endpoint options are decided in one place.
- b8a41c5: The auth-ledger and records scanners now run every sealed scan through one shared plane-guard helper, `guardedScan`, beside `ScanGuard`. It used to be written out three times: once in the ledger scanner and once in each of the records scanner's obligation and manager goal-index scans. A change to the before-and-after claim check is now made in one place. No behavior changes.
- a5c18a0: A `renewRunDriver` renewal now checks the run it renews through one `holdsRunFence` predicate in `@cotal-ai/auth`, read through one run observer in the auth service. The renewal decision and the re-check right before issuance each kept a hand-written copy of the read and of the run fence comparison, so a change to what makes a run renewable could reach one copy and leave the other weaker or stricter without any suite noticing. Both still refuse with their own `conflict` message.
- 5f17642: The hosted auth fence smoke takes its injected-store baseline after each plane's first start, which now puts the plane's instance identity into the store, so its store cells check that the fence and close write nothing on top of that record.
- 0eb8eff: `@cotal-ai/core` exports `REMOTE_MANAGER_AUTHORITY_OPERATIONS`, the frozen list of manager-service authority operations, and `RemoteManagerAuthorityRequest["operation"]` is derived from it. The auth request parser checks the operation against the same list and builds its refusal from it, so an operation added to core is admitted by the host instead of compiling cleanly and being refused at runtime with the old list. The refusal now reads `operation must be one of prepare, activate, renew, session, retire, renewStandingBundle, renewRunDriver, transferReader`.
- Updated dependencies [58a725f]
- Updated dependencies [7829cbb]
- Updated dependencies [8e0876b]
- Updated dependencies [d85ca1a]
- Updated dependencies [20c93a1]
- Updated dependencies [715928c]
- Updated dependencies [a4b0467]
- Updated dependencies [08d92b7]
- Updated dependencies [35fdda8]
- Updated dependencies [7b34e9a]
- Updated dependencies [d153172]
- Updated dependencies [ea15e8d]
- Updated dependencies [9adcf1c]
- Updated dependencies [15d10c9]
- Updated dependencies [0eb8eff]
- Updated dependencies [ba76f78]
- Updated dependencies [f2a4bde]
- Updated dependencies [8be669e]
- Updated dependencies [42b28aa]
- Updated dependencies [720dbc3]
  - @cotal-ai/core@0.76.0
  - @cotal-ai/workspace@0.76.0
  - @cotal-ai/lang@0.76.0

## 0.75.0

### Minor Changes

- b48a740: Add the closed manager-run-revoke issuing-host request, authorized by the recorded admission owner or a fresh admin grant. Route signerless RunHosting revocation through it and return the existing create-only marker on repeats.

### Patch Changes

- ed0785d: `@cotal-ai/core` exports `isAccountNkey`, the shape rule for an account nkey public key, and every site in core, `@cotal-ai/auth` and `@cotal-ai/delivery` that checks an account public key calls it. The run admission and run attempt parsers now refuse an `accountPublicKey` that is not an account nkey as a bad request. They accepted any non-empty string before, which only the later comparison with the assigned account refused.
- 0c924f4: A hosted auth context started through `startAuthService` now keeps the auth plane's instance identity, whose serve seed is a private nkey, in its injected `SecretStore` under the new `authInstanceKey(space)`, with the other auth secret kinds. It used to write that record under `stateDir`, which the hosted contract documents as non-secret state. The first start of an upgraded context puts the earlier record into the store, removes the file and keeps the instance. A store and `stateDir` that hold different identities refuse the start. `@cotal-ai/workspace` exports `removeAuthInstanceIdentity`. A CLI root keeps its record where it was.
- cb3a177: The manager-service authority and maintenance request parsers now check the registered-manager envelope through core's `parseRemoteManagerEnvelope` instead of their own copies of its rules, so a change to a shared envelope rule reaches them too. `parseRemoteManagerEnvelope` takes an optional fourth argument, `registrationProof`; pass `false` for a request that must carry no proof, such as `prepare`. Some refusal wording changes with it: a lifecycle-token refusal names `manager-service authority` or `manager-service maintenance`, a missing or malformed proof on any registered-manager request reads `requires a sha256 registrationProof` without the operation, and a proof on `prepare` reads `must not carry registrationProof`.
- d269d1d: Core exports `serviceContractTable(rows)`, which builds a service's command contracts, compiled on first access, and the schema artifacts its registration publishes. The auth, manager and Linear service contracts call it instead of carrying their own copies of the lazy table and the artifact loop, so a fix to either reaches all three. Importing a contract module still compiles nothing, and the published artifacts and the behaviour of `AUTH_CONTRACTS`, `MANAGER_CONTRACTS` and `MANAGER_STATUS_CONTRACT` are unchanged.
- Updated dependencies [6286d29]
- Updated dependencies [ed0785d]
- Updated dependencies [625659e]
- Updated dependencies [0c924f4]
- Updated dependencies [b48a740]
- Updated dependencies [597fa25]
- Updated dependencies [cb3a177]
- Updated dependencies [5f5196f]
- Updated dependencies [d269d1d]
  - @cotal-ai/core@0.75.0
  - @cotal-ai/workspace@0.75.0
  - @cotal-ai/lang@0.75.0

## 0.74.0

### Patch Changes

- Updated dependencies [f3e6f95]
- Updated dependencies [328d59b]
- Updated dependencies [ac251fd]
- Updated dependencies [e3498d9]
  - @cotal-ai/core@0.74.0
  - @cotal-ai/workspace@0.74.0
  - @cotal-ai/lang@0.74.0

## 0.73.0

### Minor Changes

- 8182b64: The IdP URL, the pinned JWKS URL, the space-catalog link and `cotal sync`'s account binding now share one plain-http rule: `https://`, or `http://` on a loopback IP literal, decided by core's `isLoopbackLiteral`. Before, each spelled its own host list, so `cotal login --idp http://127.0.0.2/api/auth` and `http://[::ffff:127.0.0.1]/api/auth` were refused, `http://localhost/api/auth` signed in but dropped its same-origin catalog link, and the JWKS pin accepted any scheme on `127.0.0.1` or `localhost`, such as `ftp:` or `ws:`. Every loopback literal now passes and `localhost` is refused everywhere, because a hosts entry would choose the IdP and the keys the callout trusts. A mesh with an IdP pinned on `localhost` must move its pin to `127.0.0.1`; see the upgrading guide.

### Patch Changes

- Updated dependencies [9873985]
  - @cotal-ai/core@0.73.0
  - @cotal-ai/workspace@0.73.0
  - @cotal-ai/lang@0.73.0

## 0.72.1

### Patch Changes

- Updated dependencies [07fe6b3]
  - @cotal-ai/core@0.72.1
  - @cotal-ai/workspace@0.72.1
  - @cotal-ai/lang@0.72.1

## 0.72.0

### Minor Changes

- c5a45ab: Expose the auth context's owned connection inventory and terminal `closed` signal (#3054). Underlying connection close failures now reject with their labels instead of being suppressed. Add a read-only, space-bound `readPlaneClaim` export (#3270) and an account-scoped `observeAccountLivenessWithCreds` observer over the existing native CONNZ sweep.

  UPGRADING (`@cotal-ai/auth`): After `close()` or `drain()`, await `handle.closed` to prove all owned connections ended. `handle.connections()` returns a detached snapshot, including replaced readiness readers and short-lived clients. A close failure leaves the end signal pending while a connection remains live. Repair the failure and retry `close()` before awaiting the terminal signal. Read another process's claim with `readPlaneClaim(kv, space)` using that account's leader-only auth bucket. An unclaimed space returns `undefined`. Deleted or malformed claim rows refuse, and the package now exports `PlaneClaimRow` and `PLANE_CLAIM_KEY`.

  UPGRADING (`@cotal-ai/core`): Use `observeAccountLivenessWithCreds({ servers, observerCreds, accountId, options })` with the same account-scoped membership-observer credentials used by the tuple query. It returns connection labels, server ids, cids, identities and the sweep's `gotAnyReply`, `truncated`, `sweepComplete` and topology facts. Zero rows prove absence only with a complete sweep and the single-server proof. Credentials are never widened and the observer performs no eviction. Trusted endpoint composition roots may use `EndpointOptions.onConnection` to retain custody of each opened transport and await its terminal signal.

### Patch Changes

- 7aa94be: A broker error on the auth service's connect reader connection no longer denies every connect. The reader treated any async error, such as one refused publish or subscribe, as a lost connection: it stopped serving and only came back on a reconnect, which a connection that never dropped does not get, so every connect was denied with `unavailable` until the link dropped or the service restarted. The reader now goes down only when the connection is lost, and an auth error that makes the client drop the link still denies until the reconnect re-proves the reader. The service log names the broker error instead of reporting a lost connection.
- Updated dependencies [c5a45ab]
- Updated dependencies [18e7e91]
  - @cotal-ai/core@0.72.0
  - @cotal-ai/workspace@0.72.0
  - @cotal-ai/lang@0.72.0

## 0.71.0

### Patch Changes

- 976fe67: A failed auth plane open now closes every connection it opened and releases its plane claim, wherever the open fails. A JetStream timeout or error on the remote manager issuer's first request, after the auth admin listener came up, used to leave the authority connections, both scanners and the listener open with the claim still held, so a hosted retry on the same space was refused by the leaked claim. The open now records each resource's close as soon as it opens and unwinds them in reverse from one place.
- Updated dependencies [b9daf53]
- Updated dependencies [3518435]
- Updated dependencies [726a750]
- Updated dependencies [3400d53]
- Updated dependencies [518351a]
  - @cotal-ai/core@0.71.0
  - @cotal-ai/lang@0.71.0
  - @cotal-ai/workspace@0.71.0

## 0.70.2

### Patch Changes

- d873500: Plane-claim release no longer caches a rejected KV operation. A hosted `close()` that cannot reach the claim row still rejects, but it can be retried after the broker reconnects without reopening the scanners. The exported `planeClaimRefusal()` reports `release-unreachable` for this retryable refusal and `lost` when another claim owns the row; a release also accepts its own already-released row after an uncertain write acknowledgment.
  - @cotal-ai/core@0.70.2
  - @cotal-ai/workspace@0.70.2
  - @cotal-ai/lang@0.70.2

## 0.70.1

### Patch Changes

- cd3c155: The doc comment on `reconstructRemoteManagerServeGrant`, which ships in `dist/manager-contract.d.ts`, now says what the function does: it is the activation entry and derives the serve grant from the submitted `ai.cotal.manager` document through `remoteManagerServeGrantFromCluster`. It described a canonical manager surface mirrored from the manager package that activation was checked against, and the module holds no such value. No runtime change.
- 0a21b56: The `renew` arm of the manager-service authority now checks the manager gate's owner against the same actor set it mints the supervisor and executor credentials from. It recomputed its own copy before, which only matched because both copies were derived from the same instance id. No behavior changes.
- Updated dependencies [9c99ee5]
- Updated dependencies [da6dba0]
- Updated dependencies [032522a]
- Updated dependencies [5c6c92d]
- Updated dependencies [6d81d61]
- Updated dependencies [fe54eb0]
- Updated dependencies [1ef1396]
- Updated dependencies [66a0f19]
- Updated dependencies [2be1384]
- Updated dependencies [25237f0]
- Updated dependencies [6bd6099]
- Updated dependencies [ed1e171]
  - @cotal-ai/core@0.70.1
  - @cotal-ai/lang@0.70.1
  - @cotal-ai/workspace@0.70.1

## 0.70.0

### Minor Changes

- 392bfeb: The user-auth service's instance identity no longer travels with a mesh's trust folder. It now lives in the root's own space segment, `.cotal/space.<space-hex>/auth-instance.json`, beside the manager's identity. It used to land in `.cotal/auth/space.<space-hex>/.cotal/auth/auth-instance.<space-hex>.json`, because the auth plane passed its user-auth state dir where the identity helpers expected a workspace root, so copying `.cotal/auth` to another root, as the docs describe for a mesh you did not start, copied it too and an auth service started there came up as the original instance. A record at the older place is moved on the first start and the instance is kept; both places holding a record is refused, and so is a symlink or other non-regular entry at the older place of the auth or manager identity, which the manager used to skip, minting a new identity. A hosted context started through `startAuthService` keeps its identity in its own `stateDir`, moved the same way from `<stateDir>/.cotal/auth/` to `<stateDir>/.cotal/space.<space-hex>/`. `openAuthAuthorityPlane` now takes a required `identityRoot`, the root whose space segment keeps that identity, and no longer derives it from `dir`.
- b543926: `validateUserToken` no longer takes `maxTtlSec`. It caps a bearer's lifetime at the cap of the bearer's view, the same cap the issuer applies at mint: 900 seconds, or 300 for a `transfer-writer` bearer. Nothing in the repository passed the option, and a `NaN` value, such as `Number()` of an unset environment variable, turned the lifetime check off so a bearer of any lifetime was accepted. A caller that needs a shorter-lived bearer mints one.
- fd07b1e: `remoteManagerClient.remoteManagerAuthorityRequest` takes an operation's coordinates as one named object instead of trailing positional arguments, and `remoteManagerRegistrationProof(owner, registration, contractArtifacts?)` computes the registration proof from the manager's identity coordinates instead of a request built with a placeholder proof. The proof digest and the wire request are unchanged.
- 2639a13: `AuthProvider.userCredentials` no longer returns `managerInstanceId`. A `manager-caller` credential's instance is the signed `act.managerInstanceId` claim in its bearer, the one `userViewAuth` checks. The reference provider copied the exchange response's field beside it, and nothing compared the two, so a provider whose result named a different instance than its bearer satisfied the contract while the CLI used the bearer's. `userViewAuth` also decodes each minted bearer once, through one typed decoder, where the manager-caller check read a second untyped decode.

### Patch Changes

- 2cbfe9c: `@cotal-ai/core` exports `isUserNkey`, the shape rule for a user nkey public key, and every parser in core and `@cotal-ai/auth` that checks a user nkey calls it. `mintPublicUserJwt` now refuses a non-string `publicId`, such as a boxed `String`, as every other site already did. Decisions for string ids do not change.
- b413e2a: `authorizeRemoteManagerRenewal` now takes its run observation as the exported `ObserveManagerRun`, built on core's new `HostedRunAttempt`, instead of an inline shape whose `state` was a plain `string`. `observeHostedRunAttempt` returns `HostedRunAttempt`, so its `state` is a `RunState`. A misspelled or unknown run state in an observation, or in a comparison against one, now fails the typecheck where it used to compile. Renewal accepts and refuses the same runs as before.
- 4dcfa0b: The run admission and run attempt requests from a registered manager now refuse a `requestId` outside the 22-64 character idempotency token grammar and an `actor` that is not an owner token, as the other registered-manager requests already did. The manager-service authority request also refuses such an `actor`. Core exports `parseRemoteManagerEnvelope`, the one parser for the fields every registered-manager request carries, and the auth parsers call it in place of their own copies.
- cce8dad: `@cotal-ai/core` exports `singleDocumentClosure(document)`, which returns the §13.7 closure manifest `{ v: 1, root, members: [] }` of one self-contained document and the manifest's closure digest. It builds the manifest with `buildContractClosureManifest`, so every closure manifest core mints follows one rule. The auth and manager service contracts and `VOID_SCHEMA_DIGEST` now build their closures with it instead of each writing the manifest by hand, and the platform host example in `docs/embedding.md` uses it. Every digest they produce is unchanged.
- Updated dependencies [392bfeb]
- Updated dependencies [66df6c0]
- Updated dependencies [0ec35c2]
- Updated dependencies [015f805]
- Updated dependencies [2cbfe9c]
- Updated dependencies [1b11c4e]
- Updated dependencies [c088c5c]
- Updated dependencies [b413e2a]
- Updated dependencies [7986785]
- Updated dependencies [12bfc34]
- Updated dependencies [4dcfa0b]
- Updated dependencies [fd07b1e]
- Updated dependencies [8dc360c]
- Updated dependencies [cce8dad]
- Updated dependencies [c7e0c0a]
- Updated dependencies [2639a13]
- Updated dependencies [668f6b0]
- Updated dependencies [83a6352]
- Updated dependencies [15b7920]
  - @cotal-ai/workspace@0.70.0
  - @cotal-ai/core@0.70.0
  - @cotal-ai/lang@0.70.0

## 0.69.0

### Minor Changes

- d29d4d3: A remote manager now verify-evicts its credential family through its host with one maintenance request per 256 holders instead of one per holder. The `evict-family-principal` request carries `principals`, 1 to 256 distinct holders, in place of `principal`, and the result carries `evictions`, one `EvictionResult` per principal in request order, in place of `eviction`. The host reads the caller's `epcred.manager.<instanceId>` family once per request, refuses the request when any named holder is outside it, and evicts the set in one `evictPrincipals` sweep. Before, each restart cost one host request, one family read, one credential mint and one daemon sweep per holder, so the host's work grew with holders times family rows. `registerRemoteManagerAuthority` now takes an `evict` that answers one verdict per holder for a set, `makeDeliveryAdminHolderEvictor` answers one `EvictionResult` per holder, and the registration barrier's `evictMax` option is removed, since every evictor now takes up to `EVICT_PRINCIPALS_MAX` holders per call. A remote manager and its issuing host must upgrade together.

### Patch Changes

- 6efcb8a: `deviceLogin` and `establishIdpSession` now await `onPrompt`, which may return a promise. Polling starts only after the prompt settles, and a rejection from it fails the login instead of escaping as an unhandled rejection. The device code's lifetime also bounds the prompt, so one that never settles fails the login at expiry.
- d8adc43: `handleManagerServiceAuthority` now takes `ManagerServiceAuthorityCtx`, exported from `@cotal-ai/auth`, which holds only the fields the handler and its dispatcher read. A host that serves the manager-authority route with a context it builds itself no longer casts that context to the full private handler context, so a dispatcher arm missing from it is now a compile error. It used to typecheck and then fail with `is not a function` on the first request of that kind.
- 259f570: The manager cluster parser that activation, standing renewal and run-attempt admission share now words its refusals for the document instead of an activation request: "found no canonical manager cluster document", "the manager cluster document carries a malformed command declaration" and "the manager cluster document declares command <name> twice". A standing renewal or run-attempt admission that fails on its registered manager cluster no longer reports an activation that never happened. No other behavior changes.
- a4e4015: Every plane-claim refusal now carries a `PLANE_CLAIM_REFUSED` detail, and `planeClaimRefusal(err)` returns its reason (`corrupt`, `live-peer`, `unknown`, `concurrent`, `fenced`, `released` or `lost`), so a host can retry contention and stop on a corrupt row without matching message text. The `startAuthService` handle's `close()` now rejects when the context did not release its plane claim, either because the row is no longer its own or because the release write failed. It used to resolve in both cases, and only stderr told them apart. The CLI daemon reports such a close on its exit line and exits 1.
- 39efad7: The auth service's authority plane no longer rebuilds the data account's signing context inside remote manager maintenance, run admission and run attempt issuance. The serve-executor and run-admitter mints, the run admission's issuer window, and the run-driver, run-mediator and run-operator mints now use the plane's `issuerAuth()`, so a change to how the plane signs reaches them with the plane's other issuer windows and mints. No behavior changes.
- c55b463: An auth-service context started by the CLI composition no longer carries a made-up hosted context. The shared builder gave every handle a `readiness()` and, with no assigned context, reported the store's data account with an empty lifecycle UID, a key no assignment names and `startAuthService` itself refuses. Only `startAuthService` now attaches `readiness()`, and it reports the context it was assigned.
- 9e59f0a: The ledger scanner, the records scanner and managed-agent enrollment now share one keyed serialization helper instead of three private copies. The two scanners' copies never removed a key, so their module maps kept one entry for every space a process had ever scanned. The shared helper removes a key once its last queued call settles, which the enrollment copy already did. Scans still run one at a time per space, and a scan still runs after an earlier one fails.
- 886c3e5: The managed-agent host doors (enrollment, prepare-retirement, and runtime create and status) now run one current-registration check instead of three hand-kept copies of the open gate, serve principal, serve epoch, and registration proof checks. The order and codes are unchanged. An enrollment refused for an absent or frozen gate now reads `enrollment found no current open manager gate for instance <id>`.
- 426d72e: The issuing host now admits a run that a signerless manager forwards only if it saw the caller publish that `run-start` request on the broker, and only once. Before, it checked the forwarded subject's caller against live issuance and its publish ceiling, so a registered manager could get an admission, and then driver and mediator credentials, for any live caller whose ceiling permits `run-start` on it without that caller asking. The host's issuer connection now also watches the `run-start` request subjects on both manager routes, read-only, the way it already watched `run-resume` and `run-answer`. A forward it did not observe, or a second forward of one it did, is refused as `permission-denied`. The manager's request is unchanged.
- 93716c3: The loopback check that lets plain http carry a credential now has one definition, `isLoopbackLiteral` in `@cotal-ai/core`. `agent-bearer --exchange-url`, the pinned exchange, enrollment redeem, the managed handoff reader and workspace `isLoopbackHost` all call it, so a fix to the rule can no longer reach only some of them. It parses the address, so every IPv6 spelling of `::1` is loopback and a dotted host that is not an IPv4 literal, such as `127.0.0.09`, is not. `isLoopbackHost` keeps only the legacy IPv4 canonicalization a `nats://` host needs.
- Updated dependencies [f5cb8e1]
- Updated dependencies [2d45766]
- Updated dependencies [03a7405]
- Updated dependencies [a256e2f]
- Updated dependencies [3f3d04a]
- Updated dependencies [4500563]
- Updated dependencies [1bdc7f2]
- Updated dependencies [94996e5]
- Updated dependencies [5eb1e24]
- Updated dependencies [69232cd]
- Updated dependencies [02c0a2d]
- Updated dependencies [93716c3]
- Updated dependencies [3a1716d]
- Updated dependencies [9772fd4]
- Updated dependencies [06429be]
- Updated dependencies [adab793]
- Updated dependencies [d29d4d3]
- Updated dependencies [539266a]
- Updated dependencies [b584718]
- Updated dependencies [0c5b205]
- Updated dependencies [98d2b41]
- Updated dependencies [f409b46]
  - @cotal-ai/workspace@0.69.0
  - @cotal-ai/core@0.69.0
  - @cotal-ai/lang@0.69.0

## 0.68.0

### Minor Changes

- 6141e7b: The issuing host no longer signs an answering run operator for a checkpoint token a participant manager names. The manager's request now names the run and step it answers (`operator.answers: { runId, stepKey, amend? }`), and the host requires that run admitted on the manager's instance, reads the pause's token off the run's journal under a read it mints for that run, and requires a served answer to name the same run and step as the request it observed. Before, a manager could be issued the answer and settle writes for another instance's waiting pause. The pause lookups `openCheckpointToken`, `settledPauseToken`, `stepPauseToken`, `CheckpointNotOpen` and `CheckpointNotAmendable` move to `@cotal-ai/lang`; `@cotal-ai/runtime` still exports the first four. A participant manager and its issuing host must upgrade together.

### Patch Changes

- 171a177: The manager serve grant no longer takes a serve actor it never read. `reconstructRemoteManagerServeGrant` now takes the request, the owner and the observed gate, and `remoteManagerServeGrantFromCluster` no longer computes and discards the manager actors. The grant is unchanged: it is derived from the gate and the cluster document alone.
- 9b439e8: `mintPublicUserJwt` in `@cotal-ai/core` now takes only what it signs with: the space and the account's public key and signing seed. The auth service passed it that partial context behind a cast that turned the type check off for every remote-manager credential it signs. It now passes the context typed. Its authority plane also opens the auth KV view once and reads every manager issuance gate through one helper, where each operation used to reopen the view and rebuild the gate inline. The activate arm's duplicate missing-gate check, which could never run, is gone.
- f81a132: The docs index and the platform control authority design page no longer call the door unreleased. It shipped in 0.60.0 and its readiness read in 0.62.0. The delegated user launch intent design page now says it shipped in 0.62.0, with its host incarnation members in 0.65.0. No behavior changes.
- Updated dependencies [6141e7b]
- Updated dependencies [4120c97]
- Updated dependencies [218006f]
- Updated dependencies [681c5b0]
- Updated dependencies [585fdb2]
- Updated dependencies [a5256fd]
- Updated dependencies [0d806ae]
- Updated dependencies [b38a683]
- Updated dependencies [d5ea4d2]
- Updated dependencies [54e0199]
- Updated dependencies [9b439e8]
- Updated dependencies [41a7e66]
- Updated dependencies [f018376]
- Updated dependencies [6a1789b]
- Updated dependencies [237c813]
  - @cotal-ai/core@0.68.0
  - @cotal-ai/lang@0.68.0
  - @cotal-ai/workspace@0.68.0

## 0.67.0

### Minor Changes

- f389576: `cotal spawn --resume <id> --detach --on <instance>` carries a Claude session held on the operator's host to a manager on another host, as `docs/design/resume-transfer.md` lays out. The CLI finds the transcript with the connector's new `resumeTranscript` locator and writes it into a JetStream Object Store bucket owned by the target instance, in chunks sized to the broker's `max_payload`, as a chain that an interrupted carry continues. The manager's new operator-only `transcript-receive` command stages it, removes the broker object, and issues a one-time `resumeClaim` that `spawn` consumes; a re-run of the same bytes moves none. The seat forks the transcript in a seat-private Claude home that authenticates with an environment credential, and `cotal ps --wide` names the source host, session, digest and carry time. The manager cluster document moves to revision 21. Two one-shot credentials carry it on an authenticated mesh: a `transfer-writer` the CLI mints from the space's signing seed for the one transcript it hashed, or on a user-auth mesh exchanges from the operator's login as the new `transfer-writer` view (scope `admin`), and a `transfer-reader` the target manager mints for its own bucket on each receive or sweep, or that the host issues a remote manager through the new manager-service `transferReader` operation. A carried seat records the digest of the transcript Claude forked, and the manager stops a seat whose record does not match the carried bytes, including one whose launch was uncertain and that joined later. Space deletion lists the transfer buckets and deletes them: `deleteSpace` given the space's trust material mints its own `teardown` naming them, and it now throws naming every stream it could not delete instead of reporting success. The console space picker deletes a space this host registered as a static-auth mesh that way. The `transfer-writer` view, and the broker connection minted from it, lives at most five minutes, the static credential's lifetime.

### Patch Changes

- 5b0da88: Breaking: the issuance-gate types now carry the op rule the gate parsers already enforce. `EpGateRow`, `EndpointGateRow` and `EpGateState` declared `op` optional in every state, so each reader re-derived it with placeholders, assertions and fallbacks for a case the parsers refuse. They are now a union on `state` over a shared `GateOp`: `open` carries no op, and `frozen` and `retired` always carry one. A reader that has checked the state reads `op` directly, and an in-memory gate or barrier that freezes or retires without recording its op no longer compiles. Because they are no longer interfaces, an `interface` that extends one fails with TS2312; declare it as an intersection such as `type CustomGateRow = EpGateRow & { custom: string }` instead. The endpoint gate's mint fence and registration barrier also read the `epgate` row through one shared reader and one mapping into `EpGateState`, so the two `observe` members can no longer refuse a DEL marker or carry the row's fields differently. Gates that parsed before parse the same way, and the refusals are unchanged.
- cd59891: `docs/embedding.md` now shows how a host builds `platformControl.host`. Registration reads the closure manifest `{ v: 1, root, members: [] }` at `clusterDigest` and the cluster document at its `root`, so `artifacts` carries both and `clusterDigest` is the digest of the manifest. `members` stays empty because single-document clusters are the only ones registered, and the instance id is a lifecycle token. A minimal one-command example built from `contractDigest`, `VOID_SCHEMA_DIGEST` and `mintLifecycleUid` is included. No behavior changes.
- 73567e2: The auth decisions that read a manager's gate now take `ObserveManagerGate` instead of restating its result, and `ObserveManagerGate` takes its fields from core's `EpGateState`. `authorizeRemoteManagerRenewal`, `admitRemoteRun`, `authorizeRemoteRunAttempt`, `authorizeRemoteManagerGoalIndexScan`, `authorizeRemoteManagerMaintenance`, `authorizeRemoteManagerAdmin` and `AuthorizeRemoteRetainedAgentValidationArgs` each wrote the gate's fields and state union out again, so a change to the exported type reached none of them and the typecheck stayed green. The retirement decision and the platform control view of a manager's gate also take their fields from `EpGateState`. Every decision accepts the same gates as before.
- 79e5268: Every request that carries a manager's `identities` now goes through one parser, `parseRemoteManagerIdentities`, and one name list, `REMOTE_MANAGER_IDENTITY_NAMES`, both exported from core. The run admission and run attempt parsers had their own copy, which checked only that each id was a string. A non-nkey id got through to the proof check and was refused there as `permission-denied`, and a wrong key set got a message that did not name the expected keys. Both now refuse with the same `bad-request` messages as the other manager requests: "identities.<name>.id must be a user nkey" and "identities must contain exactly supervisor, executor, serve, goalWriter, sessionLedger". The auth parsers, the credential checks in authority issuance and the manager's standing renewal checks now use the shared list too, so a change to the identity set happens in one place.
- c3601f9: A logged-in user's workflow run on a `cotal supervise` participant manager can spawn, turn and despawn agents that user owns and receive their typed answers. The run's spawn takes the admin reach of the user who started the run, read from that user's actor-ledger row when the spawn runs, so a space that requires the event plane no longer refuses it and a revoked login demotes it. The host pins each run mediator it signs for a participant manager to a placement on that manager's own instance, so a program may place a spawn there; a placement on any other instance is refused at `run start`. A completed run now releases a seat by the identity its spawn terminal records, so a seat the host enrolled at its own lifecycle UID is despawned instead of left running.
- 562a56b: `@cotal-ai/core` now exports `UserCredentialsRequest`, the one request type `AuthProvider.userCredentials` takes. The reference provider uses it for both the local and the remote client arm: the remote arm takes the request object instead of each coordinate as a positional parameter, and both arms send the `/exchange` body from one builder. A coordinate can no longer reach one arm's exchange body and miss the other's, and two coordinates of the same type can no longer be swapped at the remote call. The exchange body on the wire is unchanged.
- Updated dependencies [48f18d0]
- Updated dependencies [e85e1fd]
- Updated dependencies [55061ff]
- Updated dependencies [5b0da88]
- Updated dependencies [e65ec69]
- Updated dependencies [79e5268]
- Updated dependencies [bb0b14e]
- Updated dependencies [3069425]
- Updated dependencies [ae5b3cd]
- Updated dependencies [954a78b]
- Updated dependencies [f389576]
- Updated dependencies [562a56b]
  - @cotal-ai/core@0.67.0
  - @cotal-ai/workspace@0.67.0

## 0.66.1

### Patch Changes

- Updated dependencies [568f718]
  - @cotal-ai/workspace@0.66.1
  - @cotal-ai/core@0.66.1

## 0.66.0

### Minor Changes

- 658c1b8: Breaking: the `ai.cotal.ep.lifecycle-blocked` refusal detail now reports only the state the refusing site read. `headState` is optional and set only where the lifecycle head was read; a new `gateState` (`frozen` or `retired`) is set where the issuance gate was read. A gate frozen by a takeover, a registration or another retirement used to report `headState: "retiring"` over an active head or a service instance with no head, and a retired gate reported `headState: "retired"` with no head. `blockedOp` is the gate's own op kind instead of defaulting to `registration`, and `registerServiceInstance` refuses a frozen gate observed without a valid op (a string `opId` and one of the four op kinds) as `internal`. The manager's reserved-name refusal no longer claims a head state. A client that read `headState` from a gate refusal must read `gateState`.

### Patch Changes

- a07f732: The docs now state the first process epoch. SPEC §13.7 and `docs/embedding.md` say that the first registration of an instance commits epoch 0, that epoch 0 is open and serving like any later epoch, and that each later start of the same instance commits the previous epoch plus one, so a consumer or sweeper never treats 0 as absent or not ready. `docs/embedding.md` also states that `awaitHostFence` takes any non-negative safe integer epoch, 0 included, and refuses any other value with `bad-request`. No behavior changes.
- af779f9: Core exports `registerServingInstance`, which runs `registerServiceInstance` and then authorizes the instance's serve grant and writes its `ready` status at the `processEpoch` and `registrationRevision` that registration committed, both fenced on the registration barrier's read of the issuance gate. It returns `{ registrationRevision, processEpoch, grant }`, and an optional `status` adds fields to the ready status. The auth plane's own boot registration, the manager's boot registration and `registerRemoteManagerAuthority` now call it instead of assembling the grant and status by hand, so the epoch these steps run at comes from one place. Their behavior is unchanged.
- 611b71f: `cotal auth-service` now answers a remote manager's managed-agent enrollment and retirement preparation itself instead of refusing both for a host platform to intercept. A signed-in participant running `cotal supervise` can spawn a detached user-mode agent and terminally release it against a stock host. Enrollment runs the existing door checks, writes the managed grant at a fresh host-chosen lifecycle UID under the supervising actor's delegation envelope, provisions that UID's durables, and returns the daemon's public exchange URL for the agent's bearer; a failed provision revokes the grant. A retry carrying the same token digest answers the same UID while the supervising actor's current grant still covers it, and an enrollment of a name whose grant still stands is refused with `conflict` until its retirement is prepared. Retirement preparation releases the target UID's broker footprint and then revokes its grant. Enrollment needs the daemon's public exchange face. A platform that keeps these writers in its own storage still intercepts both kinds and uses the verify-enrollment door.
- Updated dependencies [a07f732]
- Updated dependencies [be53e2d]
- Updated dependencies [658c1b8]
- Updated dependencies [af779f9]
  - @cotal-ai/core@0.66.0
  - @cotal-ai/workspace@0.66.0

## 0.65.0

### Patch Changes

- ba5468d: A platform composition that hosts the auth context can now get the host incarnation that a delegated user intent pins as its executor (SPEC 13.16). `PlatformControlInput` takes an optional `host: { endpoint, clusterDigest, artifacts }`: the reverse-DNS endpoint of the host process that runs the intent flights, the closure digest of its §13.7 cluster and every contract artifact that closure needs. The auth plane self-authorizes that one name, and a single-label name is refused at start. With it, `AuthServiceHandle` gains `registerHostIncarnation(instanceId)`, which publishes the artifacts, registers that instance through the same ceremony the auth plane runs for its own `auth` endpoint, and returns `{ instanceId, processEpoch }` with the epoch that registration committed, `observeHostGate(instanceId)`, the sweeper's point-in-time read of that endpoint's issuance gate over the context's own connection, and `awaitHostFence(instanceId, processEpoch)`, which resolves with the gate once it is no longer open at that epoch, or with null once it is absent. A host that registers its persisted instance id at every start fences its predecessor and advances the process epoch, so a restarted host reads its earlier incarnation as gone. A start whose confirming read of the gate finds that a later start of the same instance registered is refused with `conflict`. The returned epoch stays current only until the next start registers, which can happen before the call returns, so the host arms `awaitHostFence` with it before it admits or recovers any flight and stops serving when the hook resolves. `docs/embedding.md` and `docs/design/delegated-user-launch-intent.md` describe all three members. Core's KV issuance gate adapters (`serveIssuanceGateKv`, `provisionEndpointGateOpen`, `endpointRegistrationBarrier` and `readEndpointGateGeneration`) tokenized the endpoint name twice, and the registration repair cursor rebuilt its key from the token, so every reverse-DNS endpoint threw before it reached its gate or partway through its registration. They now carry the name and leave the key builders to tokenize it. Single-label endpoints are unchanged. Core's `registerServiceInstance` also returns the `processEpoch` its completing reopen committed, so a caller no longer reads the epoch back from a gate that a later registration may already have advanced; the auth plane's own registration takes it from there.
- Updated dependencies [ba5468d]
- Updated dependencies [451ffee]
- Updated dependencies [f01aa7c]
- Updated dependencies [2cef9e6]
  - @cotal-ai/core@0.65.0
  - @cotal-ai/workspace@0.65.0

## 0.64.0

### Patch Changes

- Updated dependencies [6c79419]
- Updated dependencies [d121d21]
  - @cotal-ai/core@0.64.0
  - @cotal-ai/workspace@0.64.0

## 0.63.0

### Minor Changes

- c975258: A logged-in user can now run hosted workflows on a user-auth space. The auth callout issues an interactive user's `manager-caller` view as an issuance (SPEC 13.15): it chooses the generation, records evidence whose one source is the user's actor-ledger row, and writes the accepted row under a token derived from the connection's inbox nonce, renewing that generation on a reconnect whose ceiling is unchanged. `cotal run` and the other manager calls read the generation back with the new `issuedUserCaller` and ride `ep.v1`, so `cotal run start` against a participant manager started with `cotal supervise` is admitted. The issuing host admits a run from a user caller only for the manager's registered owner, and a participant manager now forwards the served subject of every caller resume and answer, which the host checks against the run's owner and the caller's live issuance; a legacy-rail resume is refused. The issuing host subscribes to those resume and answer request subjects itself and issues for a forwarded one only when it observed that request, only once, and only for the run a resume's envelope names or the endpoint and amendment an answer's envelope names, and never for a request bound to another manager instance or epoch or declaring another class or pinning another contract than the manager registered for that command. Every answering operator issuance must carry that served subject, and an amendment's carries `answers.amend: true`, which the host accepts only for a pause settled with an accepted answer, so `cotal run amend` works on a participant manager. A user caller starts, resumes and answers runs only on the participant manager that user registered, and a static caller keeps its admission there. A managed seat's manager call keeps the legacy rail when the broker refuses its accepted-row read, which surfaces as a request error caused by the permission violation. Revoking or re-granting the actor makes its issuances dead at the next resolution. New exports: `connectionAcceptedToken`, `actorLedgerSource`, `actorLedgerSourceBucket`, `parseActorLedgerSource`, `issuedUserCaller` and `isDerivedOwner` in core, and `ledgerActorSourceIsLive` and `UserCallerIssuer` in auth. `manager-caller` joins the issuable profiles, and the `issuer` profile gains the per-key read of the accepted store. SPEC §13.15 gains a **User-auth issuance** paragraph and §14.8 a **User-auth runs** paragraph, both insertions; `docs/design/user-auth-run-start.md` records the path, and `docs/cli.md`, `docs/workflows.md` and `docs/run-a-mesh.md` describe it. `docs/run-a-mesh.md` also says the stock auth service refuses managed-agent enrollment and retirement preparation for a host platform to intercept.

### Patch Changes

- Updated dependencies [62ebc6b]
- Updated dependencies [22e210a]
- Updated dependencies [cb6a0bf]
- Updated dependencies [5738154]
- Updated dependencies [101c9b0]
- Updated dependencies [9d5cc09]
- Updated dependencies [c975258]
  - @cotal-ai/core@0.63.0
  - @cotal-ai/workspace@0.63.0

## 0.62.0

### Minor Changes

- bcf66d6: Add a delegated user intent: SPEC §13.16, a design record, and the host decisions it needs. A signed-in user admits one launch or one retirement on the host's authenticated route, and a platform control holder consumes that intent once from its current registration, epoch, assignment revision and lifecycle. `@cotal-ai/core` adds the closed request types and parsers for the user's intent and the holder's execution, `parseRemoteDelegatedUserIntentExecutionResult`, and `resolveReadAcl`, the read-list resolution `provisionAgentDurables` already used. `@cotal-ai/auth` adds `authorizeDelegatedUserIntentAdmission` and `authorizeDelegatedUserIntentExecution`, the record, pin and flight types, `delegatedUserIntentHoldsAlias` and `joinOrStartDelegatedUserIntent`, `AuthServiceHandle.observeManagerGate`, which a platform composition's handle carries so the host reads the holder's gate over the context's own connection, and `AuthServiceHandle.activateManagedLifecycle`, which activates a delegated launch's lifecycle at its pinned UID before any row or durable and mints nothing, so a launch the host compensates or the user retires reaches the terminal barrier even when its agent never exchanged. Admission derives nothing from the request: it takes the owner the host derived from the verified IdP subject, requires `spawn` on the user's own fresh ledger row, binds the account's current platform assignment and the holder's open gate, and dry-runs the envelope walk from the user's principal over the read list the writer will provision. Execution compares the request with the record and with the fresh assignment, gate epoch and registration proof, and returns the user's owner and parent for the host's writers. The holder gains no grant, no decision reads `supervise`, and the `platform-control` view's same-owner rule is unchanged. Stock dispatch refuses both kinds as `unimplemented`; a host that owns an intent store and the enrollment and retirement writers composes the decisions on its own routes. `@cotal-ai/manager` adds `remoteAuthority.executeDelegatedUserIntent`, `StartAgentOpts.delegatedIntent` and `Manager.retireDelegatedAgent`: a delegated launch takes the hosted enrollment arm with the intent's execution and refuses material under any owner but the intent's, and `retireDelegatedAgent` stops a delegated agent only after the host confirms `retired: true` for its exact target and operation id. A delegated agent's name, including one whose launch failed at any step after the host's enrollment answer, stays held until then.
- 231d226: A platform composition can now ask whether its assigned control manager is serving. With the `platformControl` input, `startAuthService` returns a handle with `platformControlReadiness(instanceId)`, which answers that manager instance's `status` reply and refuses any instance the current assignment does not name, or one whose gate another owner holds. The auth context reads over its own connection, whose grant is that instance's `describe` and `status` and its own reply rail. The connection renews in process like the context's other connections and never leaves it, so a pooled control host no longer needs a human or operator credential, a per-read control instrument, or the manager's process id to tell whether the manager is up.

### Patch Changes

- Updated dependencies [bcf66d6]
- Updated dependencies [97a2382]
- Updated dependencies [877909b]
- Updated dependencies [5ef9a67]
- Updated dependencies [565036c]
- Updated dependencies [9236a12]
- Updated dependencies [b36bebf]
  - @cotal-ai/core@0.62.0
  - @cotal-ai/workspace@0.62.0

## 0.61.0

### Minor Changes

- 1eca3e0: `startAuthService` takes an optional `publicFace` input with the CLI's public face settings (`port`, `url`, `trustedProxy`, `advertisedServer`, `agentProvisioningUrl`) and checks them by the CLI's rules. An embedded context can now serve the public exchange, JWKS and discovery bundle, and its handle carries `publicUrl`. The handle also carries the per-start `cap` that `runAuthService` writes to `auth-service.json`, so a host can call its own loopback host actions. A public face without a port refuses to start. The new `PublicFaceInput` type names the input.

### Patch Changes

- @cotal-ai/core@0.61.0
- @cotal-ai/workspace@0.61.0

## 0.60.0

### Minor Changes

- 6ca4d8e: Add the platform control authority: a closed `platform-control` view, beside the unchanged human `manager-service` view, that lets a host platform run one pooled control manager per assigned account without a human session (SPEC §13.1, §13.6, §13.9). `startAuthService` takes an optional `platformControl: { observeAssignment }` input, and the returned handle then carries `platformControlAuthority`, a typed in-process door served on no listener. It issues the existing manager-service request family under a host-derived `p_` platform owner (`platformControlOwner`), reads the backend's assignment fresh on every call, reuses the registration proof, process epoch and all-duty renewal unchanged, confines maintenance to the assigned instance, and refuses `prepare` and `activate` while a named predecessor manager is still registered. It refuses IdP tokens, another account, a stale assignment, another owner's instance, unknown fields (a nested `session` field included) and the managed-agent kinds. `@cotal-ai/core` adds the `PlatformControlAuthorityRequest`, `PlatformControlInnerRequest`, `PlatformControlAuthorityResult` and `PlatformControlAssignment` types, the `p_` owner grammar, and an opt-in `allowPlatform` on the principal owner checks and on CONNZ attribution (`principalFromConnz`). Only the platform family's own boundaries opt in: the issuance gate row, the credential holder row, the eviction and liveness sweeps with the delivery daemon's executors, the manager goal-index scanner, the run driver caller, and, for the platform holder only, the retirement target, retained-validation target and admin caller parsers. The membership feed and the message drop guards still refuse a `p_` owner. Presence has no owner check, so a platform endpoint's roster card appears under its `p_` owner. `startAuthService` also forwards a trusted-host `standingRenewableTtlSeconds` to the authority plane. The human remote-supervision path is unchanged.

### Patch Changes

- 9f22cf0: The public exchange suite (`smoke:remote-exchange:live`) now has a mutation fixture, `implementations/auth/smoke/mutations/remote-exchange.json`, for its security cells: the capless loopback 401 that pairs the public 200, the per-peer refusal throttle, a valid credential still minting from a throttled key while a refusal's reason is withheld, and the one sentence an unknown agent and a wrong secret share. Its per-peer isolation and budget-separation cells now probe with a refused exchange and require its own 401 sentence. They probed with a valid credential, which mints even from a full bucket, so they stayed green with every peer sharing one bucket and with public refusals charging the loopback budget. Service behaviour is unchanged.
- Updated dependencies [3b616a2]
- Updated dependencies [6ca4d8e]
  - @cotal-ai/core@0.60.0
  - @cotal-ai/workspace@0.60.0

## 0.59.0

### Minor Changes

- 70bcfe3: Breaking: `cotal actor grant` no longer turns an omitted ACL flag into the wide default, so a bare grant that used to succeed now needs `--full`. A grant must name `--scope`, `--allow-subscribe` and `--allow-publish`, or pass `--full` to take `spawn,role:default`, `>` and `>` for the ones left off. Otherwise it refuses, writes nothing, and prints both forms. Dropping one flag from a narrow event-plane reader grant used to mint a row that read or posted to every channel, or could spawn, with a success line as the only sign. The hints printed by `cotal login`, `cotal status`, `actor list` and the not-granted refusal now include `--full`.
- c389563: Hosted runtime create and status for managed agents. Core adds the closed `manager-managed-agent-runtime-create` and `manager-managed-agent-runtime-status` kinds on the manager-service-authority transport, with parsers that refuse any unknown top-level or target field, including `providerRef`, `handle`, and `name`. Core also adds a result builder and binder whose `state`, `readiness`, and optional `retirementPhase` come from closed sets. The auth service adds `authorizeRemoteManagedAgentRuntimeCreate` and `authorizeRemoteManagedAgentRuntimeStatus`. Each applies the enrollment door's gate, epoch, and proof checks, reads `supervise` from the manager actor's own ledger row, and returns only `{ owner, instanceId, actor, target }`. The loopback verify-enrollment door serves both kinds, and stock dispatch refuses them with `unimplemented`. The manager client adds `remoteManagedAgentRuntimeRequest` and `remoteManagedAgentRuntimeState`. The enrollment result gains an optional, display-only `runtimeIntent: { state: "reserved" }`, which older hosts omit and the manager never treats as authority.

### Patch Changes

- 5bec8b2: `cotal attach` now opens a seat's session on a user-auth mesh. The CLI presents its bearer identity together with the session grant to the auth service's exchange, which issues a `session-caller` view bearer only after it confirms, against the redeemed `session.<id>` row and the serving manager gate, that this owner and actor hold that session. The callout re-checks the same row and mints the same `session-caller` rails with the grant's expiry that the static path mints. No local seed is read or written.
- 608f5f4: Re-attach doc comments that had drifted away from the declarations they document. A `/** */` block followed directly by another one documented nothing, so editor hovers and the published type declarations showed no doc for the intended declaration (for example `Manager`, the `plane3` field and `AclResolver`). Each such block now sits above its declaration, is merged into the block it duplicated, or is removed when its declaration no longer exists. A new `pnpm check:doc-comments` check, run as part of `check:docsbundle`, refuses a doc block followed directly by another in shipped source.
- efe37a9: A remote manager whose authority request is refused by an older host, for a field that host's auth service does not know, now reports version skew. After the host's reason, the refusal names the manager's Cotal version and the field, and says the manager needs a host at that version or later. This covers every manager-authority request, including the all-duty renewal and hosted-run admission. The field is still sent.
- aa12a1a: Gate reconciliation no longer scales with credential family size. `cotal reconcile-gate`, manager boot self-heal and remote manager maintenance revoke the family's ledger rows 16 at a time, then verify-evict every distinct holder in one shared scan, KICK and verify sweep through the new `evictPrincipals` delivery-admin verb instead of one connection and one sweep per holder. The sweep keeps up to 16 KICK requests in flight, so a family whose holders are still connected no longer pays one broker round trip per connection. Holders a sweep verifies are still recorded durably when another holder is not verified, and an interrupted sweep records none.
- Updated dependencies [70bcfe3]
- Updated dependencies [1cf7f72]
- Updated dependencies [5bec8b2]
- Updated dependencies [6c01470]
- Updated dependencies [cfc3b95]
- Updated dependencies [b669a73]
- Updated dependencies [350c87b]
- Updated dependencies [608f5f4]
- Updated dependencies [43c4179]
- Updated dependencies [4a12111]
- Updated dependencies [569cb6f]
- Updated dependencies [b4c69bf]
- Updated dependencies [f485c49]
- Updated dependencies [5f13124]
- Updated dependencies [fb1bc26]
- Updated dependencies [c389563]
- Updated dependencies [06f48f4]
- Updated dependencies [eb2681e]
- Updated dependencies [fb1bc26]
- Updated dependencies [438e9ed]
- Updated dependencies [446ed23]
- Updated dependencies [15c16ff]
- Updated dependencies [8ce6be3]
- Updated dependencies [08194ec]
- Updated dependencies [aa12a1a]
- Updated dependencies [d90f9f2]
- Updated dependencies [499bd8a]
- Updated dependencies [569cb6f]
- Updated dependencies [d0b1da3]
- Updated dependencies [37075a2]
- Updated dependencies [8d8d69a]
- Updated dependencies [c7bfc2d]
- Updated dependencies [6145abc]
  - @cotal-ai/workspace@0.59.0
  - @cotal-ai/core@0.59.0

## 0.58.0

### Minor Changes

- 95ae645: The auth retirement rail is a conforming registered endpoint with a describable contract. The requester calls it through the generic client in the exact target mode. A legacy body is refused as unsupported-version.

### Patch Changes

- 274c783: Start the bootstrap membership renewal fixture with a genuinely expired credential and verify broker refusal before renewal. This avoids depending on different JWT bytes when two fresh issuances occur in the same wall-clock second. Keep the native renewed-credential, stable-identity and broker-acceptance checks, with explicit mutation controls.
- 2cb1d72: Add `startAuthService`, an account-scoped auth-service context with readiness, drain and close that installs no process signal handlers, never exits the process and never selects a root from the working directory. `openAuthAuthorityPlane` now takes its local manager identity as an explicit `localManager` input instead of reading it from the cwd-selected root.
- 7c54825: Distinguish native consumer deletion acknowledgments and observed disappearance from uniquely attributable removals. Refuse live KV CAS successors, preserve exact-target INFO grants, and propagate unknown uniqueness through Manager reconciliation. Count ACL and membership rows removed by a competing purge as observed disappearances, not prior absence or this caller's deletion.
- 397bc60: Deprovisioning returns truthful bounded resource accounting distinguishing deleted resources from absent no-ops across repeated teardown attempts. Key existence and tombstone state are verified through exact Direct Get checks before purging KV keys, ensuring repeated deprovisioning reports zero deleted entries. Partial broker failures record refused resources and raise DeprovisionError with partial accounting rather than discarding earlier progress.
- 7b3924c: Retire a lifecycle's durable membership rows through target-pinned exact-key grants. Complete inventory derives channels from validated native keys, including wildcard-covered and unnamed channels, so unreadable values cannot hide rows from cleanup. An unavailable inventory retains undiscovered rows and holds retirement pending retry. Other principals and successor lifecycles remain untouched. Retirement fixtures now use complete zero-row responses only for empty synthetic inventories, and the user-mode test verifies held retirement until genuine delivery returns.
- 59672dd: Register the remaining hosted-runtime smoke entrypoints in stable CI fragments and report native assertion counts through canonical completion markers. Refresh the explicit-TLS call-site census. Make the resume fixture retain its first successful held-slot observation or require durable completion with a new epoch, and exercise completion before the probe as a separate regression gate.
- 1721738: Support signerless manager run hosting through typed host admission, initial-attempt and renewal operations. Renew the complete standing credential family while preserving held identities, serve epochs and last-good credentials on refusal. Keep pooled managers off local PTY launch paths and enforce the execution host boundary. Update the native lifecycle and mutation checks for these paths.
- Updated dependencies [0589316]
- Updated dependencies [59a7e64]
- Updated dependencies [95ae645]
- Updated dependencies [fba1537]
- Updated dependencies [576f622]
- Updated dependencies [2457692]
- Updated dependencies [ee6de5d]
- Updated dependencies [e9ef5b3]
- Updated dependencies [7c54825]
- Updated dependencies [2c31f95]
- Updated dependencies [397bc60]
- Updated dependencies [7b3924c]
- Updated dependencies [1721738]
  - @cotal-ai/core@0.58.0
  - @cotal-ai/workspace@0.58.0

## 0.57.0

### Patch Changes

- Updated dependencies [e7c702a]
- Updated dependencies [6f64bcc]
- Updated dependencies [42448fa]
- Updated dependencies [33357d9]
  - @cotal-ai/core@0.57.0
  - @cotal-ai/workspace@0.57.0

## 0.56.1

### Patch Changes

- Updated dependencies [6b76946]
  - @cotal-ai/core@0.56.1
  - @cotal-ai/workspace@0.56.1

## 0.56.0

### Patch Changes

- ac53a09: `cotal update` no longer reads a remote user mesh's manager for continuity, since that manager runs
  under another install and its exchange's answer cannot change the local install; the mesh is named
  and skipped, and the install proceeds. A refused remote exchange that supplies no reason now says
  the face withheld it instead of presenting the HTTP status as the reason (#2158).
- Updated dependencies [e506040]
- Updated dependencies [8dc7c92]
- Updated dependencies [99cad7b]
- Updated dependencies [1218786]
- Updated dependencies [ef8889d]
  - @cotal-ai/core@0.56.0
  - @cotal-ai/workspace@0.56.0

## 0.55.0

### Minor Changes

- 92ae52c: Add a loopback door, `POST /managed-lifecycle/retire` (`MANAGED_RETIRE_PATH`), that lets a host finish a managed agent's terminal retirement when the remote manager that should request it is gone. It carries the interactive door's guards, requires the managed grant to be revoked at that lifecycle first, and runs the rail's `managedRetirementOpId(uid)` operation. The rail and the door share one in-process flight, so they never execute the same retirement twice.
- 2e13607: Let a remote participant supervisor spawn and terminally release a HOST-OWNED managed agent (#1972). A registered participant holds no ledger writer, no JetStream provisioner, and no signing seed, so `cotal spawn <actor> -d --on <instanceId>` previously failed in auth preflight and a despawn refused outright.

  `@cotal-ai/core` adds the two closed wire operations and their parsers: `manager-managed-agent-enrollment` and `manager-managed-agent-prepare-retirement`. An enrollment carries the SHA-256 digest of the agent's standing actor token and never the token, and carries no lifecycle UID at all; a prepare-retirement's `opId` must be `managedRetirementOpId(target.lifecycleUid)`.

  `@cotal-ai/auth` adds `authorizeRemoteManagedAgentEnrollment` and `authorizeRemoteManagedAgentPrepareRetirement`, which require `supervise` at the caller instance's current open manager gate with the host-issued registration proof, plus the loopback door `POST /manager-service-authority/verify-enrollment` (`VERIFY_ENROLLMENT_PATH`) that a host platform calls for the decision while it owns every write. The door derives the caller's scope from the local ledger rather than the request body. `dispatchManagerAuthorityRequest` refuses both kinds with `unimplemented`, since stock owns no such storage, and the provider gains the `enrollRemoteManagedAgent` and `prepareRemoteManagedAgentRetirement` clients.

  `@cotal-ai/manager` adds the `remoteAuthority.enrollManagedAgent` hook and takes it in `provisionUserAgent`: the participant generates the actor token, writes it at 0600 before the request, sends only the digest, adopts the HOST's chosen lifecycle UID, and launches `agent-bearer --exchange-url`. `prepareAgentRetirement` now performs the host release instead of throwing.

### Patch Changes

- 84e0175: The bare-grant default is described as `spawn,role:default` everywhere it is described, and the launch smoke asserts the full scope.
- e4f1d2d: A managed grant without a lifecycle uid is refused at the ledger instead of being minted one.
- f7f23d3: The user-spawn smoke grades the remedy's route selector in its own cell, so the two remedy mutants are held by two cells.
- Updated dependencies [888e9bc]
- Updated dependencies [810814b]
- Updated dependencies [8472dc3]
- Updated dependencies [f272f71]
- Updated dependencies [a83dd80]
- Updated dependencies [db9a969]
- Updated dependencies [d284ee6]
- Updated dependencies [4f48629]
- Updated dependencies [2e13607]
- Updated dependencies [d3d6742]
- Updated dependencies [fd58782]
- Updated dependencies [357af9f]
  - @cotal-ai/core@0.55.0
  - @cotal-ai/workspace@0.55.0

## 0.54.0

### Patch Changes

- b4317fd: Add a short-lived manager-caller view that binds user-auth control requests to one live manager instance on the instance rail.
- Updated dependencies [e6badb8]
- Updated dependencies [34beea1]
- Updated dependencies [b4317fd]
  - @cotal-ai/core@0.54.0
  - @cotal-ai/workspace@0.54.0

## 0.53.0

### Minor Changes

- 104921c: Let remote user-auth managers renew registration executors and recover stopped or frozen manager registrations through host-scoped eviction and guarded reconciliation.

### Patch Changes

- Updated dependencies [d1f9703]
- Updated dependencies [104921c]
- Updated dependencies [83617ab]
  - @cotal-ai/workspace@0.53.0
  - @cotal-ai/core@0.53.0

## 0.52.1

### Patch Changes

- 5784ec9: Bind the user-auth service readiness wait to the daemon process, not a clock alone. A same-root `cotal up` refresh run right after a broker reload killed the old auth-service daemon used to give up at a fixed 15s while the replacement daemon it launched was still binding, then a second identical `up` succeeded: a one-shot false "auth service not ready". `ensureAuthService` now passes the pid it launched (or found live) into the provider's `ready()`, which waits past the base timeout up to 60s while that pid is provably alive, ends the wait at once when the pid exits ("exited before becoming ready"), and refuses at the bound naming the live pid, the pid record, and the service log ("alive and still starting"). `AuthServiceSpec.ready` in core gains optional `pid`/`maxWaitMs` inputs; callers that pass none keep the old clock-only behavior.
- Updated dependencies [5784ec9]
- Updated dependencies [f17791d]
  - @cotal-ai/core@0.52.1
  - @cotal-ai/workspace@0.52.1

## 0.52.0

### Patch Changes

- 50998a8: `cotal status` answers for a user-auth space whose material is a remote registry entry (a discovered space or a `meshes add --from` registration) instead of a local provisioning: the bare-status login row shows the signed-in subject from the entry's pinned IdP (grant reads as "not checkable on this machine", since the ledger runs where the space was provisioned), and `status --components` probes the manager as the signed-in login — the same credential `ps` uses — instead of minting static creds or connecting with none. A user-mode components row that cannot obtain that credential states the reason on the row (verdict `refused`), never a raw Authorization Violation. In user mode the manager row grades `serving` on the manager's own typed service answer, because the manager-lease sweep is a host credential an interactive bearer does not hold. The bare-status delivery responder axis stays `unknown` in user mode, as its comment states. Status still never static-mints on a user-auth mesh, and a signed-out machine still gets the offline "not signed in" row with the exact login command and no network round trip. Refs #1832.
- Updated dependencies [5ee8eef]
- Updated dependencies [2e7558d]
- Updated dependencies [5b2c19f]
- Updated dependencies [d69aefd]
- Updated dependencies [b3db3a2]
- Updated dependencies [c44aaf8]
- Updated dependencies [fe81419]
- Updated dependencies [93b42cd]
- Updated dependencies [a069948]
- Updated dependencies [cf5a5cb]
- Updated dependencies [ab0808c]
- Updated dependencies [6b375c8]
  - @cotal-ai/core@0.52.0
  - @cotal-ai/workspace@0.52.0

## 0.51.0

### Minor Changes

- 491e923: The public user-auth exchange now mints `channel-writer` and `channel-purger` for a signed-in
  human whose ledger row carries `admin`, so a remote owner can run `cotal channels set/default`
  and a dashboard channel delete without a loopback capability. `admin`, `purger`, `deployer`, and
  `manager-service` stay loopback-only. A managed-agent secret exchange still never mints a view.
  This is not full remote channel management: `cotal web` still asks for the read-only admin view
  at startup.
- ec8649b: Preserve the closed required-events registration policy and enforce it across discovery, launch,
  grant coverage, direct connector sessions, and trusted upgrades of existing manual registrations.

### Patch Changes

- db18070: Apply a signed-in account's space catalog to the registry under the provider's catalog lock, and
  record in the cache whether the snapshot was applied in full. A command that dies or is stopped
  while applying no longer leaves a partial registry that fresh and not-modified refreshes accept:
  the next command applies the cached snapshot again first. `prepareSpaceCatalogs` and
  `syncSpaceCatalogAfterLogin` now take the consumer's `apply`.
- a0c8a59: Discover a signed-in account's advertised spaces lazily, cache validated snapshots, and add `cotal sync` for explicit refreshes.
- f178611: Preload every persisted per-space auth-callout account when a shared broker starts, and refuse incomplete user-auth state before writing its resolver config.
- 21407fd: Allow foreground seats to redeem one-time remote user-auth enrollments, bootstrap stock mesh records, and launch without a cached human login.
- Updated dependencies [db18070]
- Updated dependencies [64d723e]
- Updated dependencies [ade42d5]
- Updated dependencies [4f153ab]
- Updated dependencies [eb65c9b]
- Updated dependencies [314a12c]
- Updated dependencies [4dd4b90]
- Updated dependencies [92a8938]
- Updated dependencies [ec8649b]
- Updated dependencies [949d4d1]
- Updated dependencies [949d4d1]
- Updated dependencies [f50e20d]
- Updated dependencies [a0c8a59]
- Updated dependencies [c18c055]
- Updated dependencies [f178611]
- Updated dependencies [21407fd]
- Updated dependencies [26d864b]
  - @cotal-ai/core@0.51.0
  - @cotal-ai/workspace@0.51.0

## 0.50.1

### Patch Changes

- Updated dependencies [c499a85]
  - @cotal-ai/core@0.50.1
  - @cotal-ai/workspace@0.50.1

## 0.50.0

### Patch Changes

- Updated dependencies [ba91ad5]
- Updated dependencies [06eccc3]
- Updated dependencies [6f248ac]
- Updated dependencies [5e23b1d]
- Updated dependencies [44cdcc2]
- Updated dependencies [6cc504b]
- Updated dependencies [87dda9f]
- Updated dependencies [fc6f0b1]
- Updated dependencies [aaedc42]
- Updated dependencies [4ab8b4b]
- Updated dependencies [fe813fe]
- Updated dependencies [55dae63]
- Updated dependencies [7df3498]
- Updated dependencies [438c629]
- Updated dependencies [a211c52]
  - @cotal-ai/workspace@0.50.0
  - @cotal-ai/core@0.50.0

## 0.49.0

### Minor Changes

- 18f3df0: Validate retained remote managed agents through the authenticated host authority service

  Remote supervisors now send the retained actor token and sentinel credential only to the manager
  authority route derived from the verified exchange origin. The host fresh-checks the interactive
  operator's `supervise` grant, the host-authenticated current manager registration proof, the open
  gate and serving epoch, the target owner, and the current retained managed row. It returns only the
  non-secret authority shape.

  The manager requires the host-issued activation receipt and independently binds every response
  coordinate and authority field to the retained inventory. Missing, malformed, substituted, stale,
  redirected, cross-origin, and widened responses fail closed.

- 6fd855f: Add a target-pinned hosted manager retirement phase that preserves host release ordering, uses the existing crash-resumable auth barrier, bounds activation to the canonical contract artifacts, and keeps remote manager maintenance on fresh host-owned admin authorization without copying host ledger state to participants.

### Patch Changes

- Updated dependencies [a9c9849]
- Updated dependencies [b0aeca4]
- Updated dependencies [348b8b7]
- Updated dependencies [9a334ae]
- Updated dependencies [18f3df0]
- Updated dependencies [9ff5c22]
- Updated dependencies [cf6ced5]
- Updated dependencies [36d1779]
- Updated dependencies [e3f2d21]
- Updated dependencies [062881a]
- Updated dependencies [159c5f0]
- Updated dependencies [c9ea091]
- Updated dependencies [5079c89]
- Updated dependencies [5395c7c]
- Updated dependencies [6fd855f]
- Updated dependencies [186fc62]
- Updated dependencies [1636927]
- Updated dependencies [dd6fea0]
- Updated dependencies [6fb1d64]
- Updated dependencies [b00f3c1]
- Updated dependencies [13f29e1]
  - @cotal-ai/core@0.49.0
  - @cotal-ai/workspace@0.49.0

## 0.48.2

### Patch Changes

- @cotal-ai/core@0.48.2
- @cotal-ai/workspace@0.48.2

## 0.48.1

### Patch Changes

- @cotal-ai/core@0.48.1
- @cotal-ai/workspace@0.48.1

## 0.48.0

### Patch Changes

- Updated dependencies [b6c843f]
  - @cotal-ai/core@0.48.0
  - @cotal-ai/workspace@0.48.0

## 0.47.1

### Patch Changes

- @cotal-ai/core@0.47.1
- @cotal-ai/workspace@0.47.1

## 0.47.0

### Patch Changes

- 0855cb7: Grade each ambient `process.env` spread on its own, and strip `COTAL_` from the user-spawn auth-service child.
  - @cotal-ai/core@0.47.0
  - @cotal-ai/workspace@0.47.0

## 0.46.0

### Patch Changes

- Updated dependencies [9d745af]
- Updated dependencies [18a0024]
  - @cotal-ai/core@0.46.0
  - @cotal-ai/workspace@0.46.0

## 0.45.0

### Patch Changes

- Updated dependencies [299a353]
- Updated dependencies [38d7bb7]
  - @cotal-ai/core@0.45.0
  - @cotal-ai/workspace@0.45.0

## 0.44.0

### Patch Changes

- @cotal-ai/core@0.44.0
- @cotal-ai/workspace@0.44.0

## 0.43.0

### Patch Changes

- Updated dependencies [890d08a]
- Updated dependencies [e5412a1]
- Updated dependencies [7ff0c21]
  - @cotal-ai/core@0.43.0
  - @cotal-ai/workspace@0.43.0

## 0.42.0

### Patch Changes

- Updated dependencies [a87709c]
  - @cotal-ai/core@0.42.0
  - @cotal-ai/workspace@0.42.0

## 0.41.4

### Patch Changes

- @cotal-ai/core@0.41.4
- @cotal-ai/workspace@0.41.4

## 0.41.3

### Patch Changes

- Updated dependencies [436f7d4]
  - @cotal-ai/core@0.41.3
  - @cotal-ai/workspace@0.41.3

## 0.41.2

### Patch Changes

- @cotal-ai/core@0.41.2
- @cotal-ai/workspace@0.41.2

## 0.41.1

### Patch Changes

- @cotal-ai/core@0.41.1
- @cotal-ai/workspace@0.41.1

## 0.41.0

### Patch Changes

- Updated dependencies [de258fb]
- Updated dependencies [bac1e00]
- Updated dependencies [5ec7feb]
  - @cotal-ai/core@0.41.0
  - @cotal-ai/workspace@0.41.0

## 0.40.0

### Patch Changes

- @cotal-ai/core@0.40.0
- @cotal-ai/workspace@0.40.0

## 0.39.1

### Patch Changes

- @cotal-ai/core@0.39.1
- @cotal-ai/workspace@0.39.1

## 0.39.0

### Patch Changes

- Updated dependencies [2277e28]
  - @cotal-ai/core@0.39.0
  - @cotal-ai/workspace@0.39.0

## 0.38.0

### Patch Changes

- Updated dependencies [21d9552]
  - @cotal-ai/workspace@0.38.0
  - @cotal-ai/core@0.38.0

## 0.37.0

### Minor Changes

- 9021896: Make the runtime pid/log namespace per-space. The manager and delivery daemon now record themselves
  as `.cotal/manager.<spaceKey>.pid`, `.cotal/manager.<spaceKey>.log`,
  `.cotal/manager.<spaceKey>.delivery-aware`, `.cotal/delivery.<spaceKey>.pid` and
  `.cotal/delivery.<spaceKey>.log`, through the same `{space}` expansion `auth-service.<spaceKey>.pid`
  already used. The five names were root-scoped constants, so one workspace root hosted one manager and
  one delivery daemon by filename: a second space booting in the same root overwrote the first space's
  record, and every reader of that file then answered about the wrong process. `status`, `down`, `up`,
  `clean` and `spawn -f` take the space they are answering about.

  Existing single-space meshes keep working across the upgrade. Reads admit a pre-segmentation
  root-scoped record while it is the only spelling present, byte-exact, so a `cotal down` still finds
  and stops a daemon started by the previous build instead of orphaning it. Writes are always the
  canonical space-keyed name, and each start reclaims a provably dead pre-upgrade record first, so an
  ordinary upgrade does not leave both spellings behind. A live pre-upgrade daemon is refused rather
  than overwritten, and both spellings present is reported as ambiguous rather than guessed.

  A folder-wide command reads its space off the runtime records the folder holds. `resolveRuntimeSpace`
  decodes the space out of the record filenames and prefers a space whose record is running over dead
  residue; two spaces running under one root throws and names both. The previous read came from the
  `.cotal/auth` account records, which an open mesh (`broker: { auth: false }`) never writes, so a bare
  `cotal down` in such a folder answered with the default space and walked past its own manager once the
  records became space-keyed.

  `MANAGER_PIDFILE` and `MANAGER_DELIVERY_AWARE_MARKER` move from `pid.ts` to `local-process.ts` and
  are now `{space}` templates; both are still exported from the package index. `RESERVED_COTAL_CHILDREN`
  no longer lists the five root-scoped runtime names.

### Patch Changes

- 9ff2363: Fix the boot crash-resume so a retirement whose head terminal never landed is resumed at the next auth-service boot. A crash between the barrier's last two durable writes (the gate terminal, then the head terminal) left the gate retired by the operation while the alias head stayed `retiring` — non-current and not replaceable per SPEC 13.1 — and the boot's owed-ness check, which read the gate alone, skipped that intent on every boot. The alias could never mint and could never be replaced. Owed-ness now reads the gate AND the alias head: a retirement whose gate terminal landed by its own operation resumes exactly while that operation's uid still owns a non-terminal head, re-entering the same barrier so only the head tail is finished (nothing past the gate terminal is re-revoked or re-drained); a retired head at the uid and a successor's head are the completed cells and stay skipped. A same-op despawn retry already repaired this state through the retire-lifecycle rail; the boot path was the dead letter. Adds a mutation-proofed smoke that stages the crash window deterministically and proves both repair triggers.
- 0d45f44: Reached manager-surface smokes read count, revision, and names from the shipped cluster document. The resolve-rtt probe asserts injected-wait occupancy, not wall-clock versus count times RTT.
- Updated dependencies [e5e68ed]
- Updated dependencies [c31de91]
- Updated dependencies [d4779db]
- Updated dependencies [6926b34]
- Updated dependencies [d2c0fd3]
- Updated dependencies [7e45495]
- Updated dependencies [135ddaf]
- Updated dependencies [e703873]
- Updated dependencies [6c1cefe]
- Updated dependencies [00ac9d9]
- Updated dependencies [c09d750]
- Updated dependencies [b20644b]
- Updated dependencies [74c9a1b]
- Updated dependencies [bfd650c]
- Updated dependencies [e6c6947]
- Updated dependencies [b36bf50]
- Updated dependencies [3cc980d]
- Updated dependencies [9021896]
- Updated dependencies [d94b617]
- Updated dependencies [eb3b429]
- Updated dependencies [17046ac]
- Updated dependencies [b7b932e]
- Updated dependencies [8eff985]
- Updated dependencies [b88edd9]
- Updated dependencies [063151b]
  - @cotal-ai/core@0.37.0
  - @cotal-ai/workspace@0.37.0

## 0.36.0

### Patch Changes

- Updated dependencies [7c5995b]
  - @cotal-ai/core@0.36.0
  - @cotal-ai/workspace@0.36.0

## 0.35.0

### Patch Changes

- Updated dependencies [4919a53]
  - @cotal-ai/workspace@0.35.0
  - @cotal-ai/core@0.35.0

## 0.34.0

### Patch Changes

- de00f4a: Retire an interactive actor lifecycle through the local auth authority plane before `cotal actor grant` rotates it or `actor revoke` removes it, so copied bearers are invalidated and later grants can create a real successor.
- Updated dependencies [22c3182]
  - @cotal-ai/core@0.34.0
  - @cotal-ai/workspace@0.34.0

## 0.33.9

### Patch Changes

- @cotal-ai/core@0.33.9
- @cotal-ai/workspace@0.33.9

## 0.33.8

### Patch Changes

- @cotal-ai/core@0.33.8
- @cotal-ai/workspace@0.33.8

## 0.33.7

### Patch Changes

- Updated dependencies [576ac7d]
- Updated dependencies [7119b4c]
  - @cotal-ai/core@0.33.7
  - @cotal-ai/workspace@0.33.7

## 0.33.6

### Patch Changes

- @cotal-ai/core@0.33.6
- @cotal-ai/workspace@0.33.6

## 0.33.5

### Patch Changes

- @cotal-ai/core@0.33.5
- @cotal-ai/workspace@0.33.5

## 0.33.4

### Patch Changes

- Updated dependencies [1858932]
  - @cotal-ai/core@0.33.4
  - @cotal-ai/workspace@0.33.4

## 0.33.3

### Patch Changes

- @cotal-ai/core@0.33.3
- @cotal-ai/workspace@0.33.3

## 0.33.2

### Patch Changes

- Updated dependencies [ffdde4d]
  - @cotal-ai/core@0.33.2
  - @cotal-ai/workspace@0.33.2

## 0.33.1

### Patch Changes

- @cotal-ai/core@0.33.1
- @cotal-ai/workspace@0.33.1

## 0.33.0

### Patch Changes

- Updated dependencies [ba74c84]
  - @cotal-ai/core@0.33.0
  - @cotal-ai/workspace@0.33.0

## 0.32.0

### Patch Changes

- @cotal-ai/core@0.32.0
- @cotal-ai/workspace@0.32.0

## 0.31.0

### Patch Changes

- Updated dependencies [4ef59c3]
  - @cotal-ai/core@0.31.0
  - @cotal-ai/workspace@0.31.0

## 0.30.2

### Patch Changes

- @cotal-ai/core@0.30.2
- @cotal-ai/workspace@0.30.2

## 0.30.1

### Patch Changes

- Updated dependencies [aea08f9]
  - @cotal-ai/core@0.30.1
  - @cotal-ai/workspace@0.30.1

## 0.30.0

### Minor Changes

- ef01887: Add closed, host-issued remote manager-service authority for registered user-auth participants. It requires the dedicated `supervise` scope, restricts manager registration and credentials to one owner and opaque instance, and uses a lifecycle-bound prepare, activate, and renew flow with fail-closed renewal and same-owner descendant provisioning.

### Patch Changes

- 6d03de0: The public exchange face no longer refuses a request that would have succeeded. The
  refused-exchange throttle was enforced before the request body was read, so a full bucket denied
  every request from that peer key, including callers holding a valid IdP JWT or actor token. On
  the public face the default peer key is the socket address, so in the reverse-proxy topology the
  docs recommend, every client shares one bucket and thirty unauthenticated POSTs denied the
  public mint path for a rolling minute. The gate is now evaluated up front but enforced only on a
  genuine credential failure, so a throttled peer still mints with a valid credential while a
  failed exchange is answered 429 rather than its specific reason.
- c6db901: The auth provider name is one exported constant shared by the provider and the discovery bundle, and the seam between the served document and the consumer that registers from it is now tested live.

  The auth-service's public face serves `/.well-known/cotal-mesh`, and that document is exactly what
  `cotal meshes add --from <origin>` fetches and registers from. The document's shape was fixed
  separately; what was still held only by agreement is the provider NAME. It appeared as a bare
  `"cotal"` literal at three sites, two of which are the two ends of one contract: the name the
  registered `AuthProvider` answers to, and the name the served document advertises. A document naming
  a provider other than the one serving it parses cleanly — the consumer requires a provider name, not
  any particular one — and registers an entry that resolves to nothing. Those sites now read a single
  exported `AUTH_PROVIDER_NAME`.

  The regression guard lives at the composition root (`bin/smoke/discovery-bundle-consumable`), which
  is the only tier permitted to import both the auth daemon and the CLI's consumer — the seam the
  original defect hid behind is precisely the boundary those two packages may not cross directly. It
  starts a real auth-service against a real broker and IdP, fetches the document over the wire, and
  hands the raw bytes to the shipped `checkUserBundle`. Nothing in it constructs the shape it hopes to
  see. That crossing is the part that had never existed: both sides had passed review because each
  side's own tests build the shape that side expects, so the producer's smoke asserted the fields it
  had just written and the consumer's smoke fed itself a hand-written fixture.

  The provider-name cell compares the served name against `cotalAuthProvider.name` — the registered
  provider's own identity — rather than against a string the test also chose, so it grades the outcome
  (the two names agree) instead of the mechanism (both sites read one constant). Grading the mechanism
  would pass a tree where both sites moved together, which is the failure this is for.

  Scope, stated exactly: this unifies the provider name and proves the served document parses. It does
  not change the document's shape or its fields, and registration applies further gates after that
  parse — `checkServer`, TLS intent, and the dial policy on the bundle's `server` — so a deployment
  that cannot publish an honestly dialable broker coordinate is still not registrable, and nothing
  here weakens those gates or invents a coordinate to satisfy them.

- Updated dependencies [0e673ff]
- Updated dependencies [569f4d3]
- Updated dependencies [b282f70]
- Updated dependencies [0323f5b]
- Updated dependencies [ef01887]
- Updated dependencies [196dddb]
  - @cotal-ai/core@0.30.0
  - @cotal-ai/workspace@0.30.0

## 0.29.2

### Patch Changes

- Updated dependencies [8531c13]
  - @cotal-ai/core@0.29.2
  - @cotal-ai/workspace@0.29.2

## 0.29.1

### Patch Changes

- @cotal-ai/core@0.29.1
- @cotal-ai/workspace@0.29.1

## 0.29.0

### Minor Changes

- 1f025c3: `cotal spawn` works against a mesh registered from a remote bundle. A user-mode
  agent's credentials must be granted where the space's signer lives, so a laptop
  spawn previously refused with a message about missing local material. A mesh may
  now advertise an agent-provisioning endpoint in its discovery bundle
  (`cotal up --agent-provisioning-url <https://…>`, carried as
  `userAuth.endpoints.agentProvisioningUrl`); spawn POSTs the operator's login
  bearer there, lands the returned material 0600, and runs the same bearer
  preflight before launch. A remote mesh that advertises none now refuses by
  naming that fact and the operator's remedy, instead of blaming absent local
  state. The endpoint is https-only (it receives the login bearer) and redirects
  are refused, matching the registration fetch discipline.

  The login proof itself never crosses the CLI package: the provisioning POST is
  a new optional `AuthProvider.postAgentProvisioning` seam on core's provider
  interface, implemented by `@cotal-ai/auth` — the CLI keeps its no-auth-import
  boundary.

  Also fixes `finalizeUserBundleEndpoint`, which replaced the bundle's endpoints
  object and would have dropped any sibling field the composer set.

### Patch Changes

- Updated dependencies [1f025c3]
  - @cotal-ai/core@0.29.0
  - @cotal-ai/workspace@0.29.0

## 0.28.2

### Patch Changes

- Updated dependencies [53f66c2]
  - @cotal-ai/core@0.28.2
  - @cotal-ai/workspace@0.28.2

## 0.28.1

### Patch Changes

- Updated dependencies [2a383fe]
  - @cotal-ai/core@0.28.1
  - @cotal-ai/workspace@0.28.1

## 0.28.0

### Minor Changes

- 1f44ca6: Add an optional reverse-proxy-facing auth exchange listener with generated mesh discovery, credential-based public proof, isolated throttling, and `cotal up --user-auth` configuration.
- 716f97c: The public exchange face's /.well-known/cotal-mesh bundle is now actually consumable by
  `cotal meshes add --from`: the trust pins ride a `userAuth` arm (provider "cotal", idp pins,
  pinned exchange endpoint) exactly as `checkUserBundle` records them, instead of the flat
  idp/endpoints shape the consumer refused. New `--advertised-server <url>` on `cotal up` /
  `auth-service` (with `--exchange-public-port`) sets the broker address the bundle advertises —
  what participants dial through the reverse proxy (e.g. wss://…/mesh-ws) — instead of the
  loopback/LAN address the callout itself dials.
- e26f4d1: Allow an already-granted managed agent to refresh its bearer through a pinned HTTPS public exchange URL without local auth-service state or capability material.
- 44738b2: A remotely-registered user mesh now connects with stock cotal end to end, including over a websocket broker address.

  `cotal meshes add <space> --from <url>` already landed a complete remote trust
  position (IdP pins, public exchange URL, sentinel creds); the auth provider now
  CONSUMES it at connect when no local user-auth material exists: login session →
  fresh IdP JWT → the pinned exchange's capless public face → bearer + the
  registration-landed sentinel. Nothing is discovered at connect time, the
  transport rule (HTTPS, loopback-literal http only, names get no exception) is
  checked before the IdP round trip, and every refusal names its exact remedy.

  Brokers published through an HTTPS edge are dialable as `wss://host/path`:
  core picks the websocket transport by scheme at every dial site (endpoint,
  reachability, probe), `hostPort` defaults ws/wss to the web's ports, and
  `join-target` classifies `wss://` as TLS-bearing (the handshake is the
  transport's own) while `ws://` gets exactly the plaintext fences `nats://`
  gets. The canonical server string keeps the URL path — behind an edge the
  path is part of the broker's address.

### Patch Changes

- Updated dependencies [09b6a3b]
- Updated dependencies [b8ee849]
- Updated dependencies [9216d21]
- Updated dependencies [86f6b10]
- Updated dependencies [a84cb62]
- Updated dependencies [45db9f8]
- Updated dependencies [e377c7b]
- Updated dependencies [44738b2]
  - @cotal-ai/core@0.28.0
  - @cotal-ai/workspace@0.28.0

## 0.27.0

### Patch Changes

- Updated dependencies [900f630]
  - @cotal-ai/workspace@0.27.0
  - @cotal-ai/core@0.27.0

## 0.26.0

### Patch Changes

- Updated dependencies [aa1fe5f]
  - @cotal-ai/workspace@0.26.0
  - @cotal-ai/core@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies [636b4b8]
- Updated dependencies [c83e600]
- Updated dependencies [b501ec5]
- Updated dependencies [a087c2b]
- Updated dependencies [0b602e4]
- Updated dependencies [34caaf4]
- Updated dependencies [8e38835]
- Updated dependencies [6959679]
  - @cotal-ai/core@0.25.0
  - @cotal-ai/workspace@0.25.0

## 0.24.0

### Patch Changes

- Updated dependencies [b7cc4fa]
  - @cotal-ai/core@0.24.0
  - @cotal-ai/workspace@0.24.0

## 0.23.0

### Patch Changes

- Updated dependencies [5634356]
  - @cotal-ai/workspace@0.23.0
  - @cotal-ai/core@0.23.0

## 0.22.0

### Patch Changes

- dfad94f: Fix two refusals that told an operator to run a grant which silently widened the row

  `cotal actor grant` is an upsert of the WHOLE row. Every flag the operator does not name is filled
  from the wide default: `>` read, `>` post, `spawn,role:default` scope. Two refusals printed a
  re-grant that named `--scope` and nothing else, so following either one reset the row's channel ACLs
  to everything.

  The elevated-view refusal is the sharper of the two. Asked for a view the grant lacks, it printed
  `cotal actor grant <actor> --owner <owner> --scope <current+needed>` and called that "the upsert
  replaces the scope list". An operator adding one view to a deliberately narrow row reset that row's
  read and post sets to `>` and `>` in the same paste, and the same sentence sent them to
  `cotal actor list` to confirm, where the widened row reads as confirmation that it worked. The row
  is a human operator's, and the ACL is minted fresh at every connect, so it takes effect on the next
  one with no restart.

  The missing-spawner refusal has the longer reach. Repairing a broken delegation chain, it printed
  `cotal actor grant <actor> --owner <owner> --scope spawn` and stopped, authoring a spawner that
  reads and posts on every channel. A spawner's own ACL is the ceiling every agent beneath it is
  attenuated against, so one pasted repair set a whole-plane ceiling for everything spawned under it
  from then on.

  The two doors now differ, on purpose. The elevated-view refusal has the row in hand, so it prints
  every field it is replacing, values included. The two delegation refusals have no row to copy from,
  so they print NO runnable command at all and name the flags and the wide default in prose instead:
  a line carrying channel values would invent them, and a line short of all three flags widens on
  paste. Both say what leaving a flag off means. `docs/cli.md` no
  longer tells a reader that a re-grant adds to the current scope, the `cotal actor grant` usage line
  now states what an omitted flag defaults to, and the two remaining hints that name a bare grant say
  that it is the full envelope, matching the wording `cotal login` already used.

  Both refusals are gated by cells that parse the service's own refusal string rather than matching a
  hardcoded command, so the text and the assertion cannot drift apart, and a mutation per site reverts
  each refusal to its shipped text and reddens that cell.

  The strings are not new. Every release from v0.11.0 to v0.21.0 carries all three, which is the whole
  life of the per-user actor ledger. Nothing about the on-disk row changes here, so no migration is
  needed, but an operator who followed either refusal should check the affected rows with
  `cotal actor list`: a widened row cannot be told from a deliberately full one, since the row records
  only when it was granted, not what it held before.

- Updated dependencies [57d3a57]
  - @cotal-ai/workspace@0.22.0
  - @cotal-ai/core@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies [4cf5f72]
- Updated dependencies [219d33c]
- Updated dependencies [9c2412c]
  - @cotal-ai/core@0.21.0
  - @cotal-ai/workspace@0.21.0

## 0.20.1

### Patch Changes

- Updated dependencies [2752fe7]
  - @cotal-ai/core@0.20.1
  - @cotal-ai/workspace@0.20.1

## 0.20.0

### Patch Changes

- @cotal-ai/core@0.20.0
- @cotal-ai/workspace@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [48c6631]
- Updated dependencies [10d9cd6]
- Updated dependencies [a1bc784]
- Updated dependencies [a7267b3]
- Updated dependencies [ce1c248]
- Updated dependencies [5e95736]
- Updated dependencies [19931dd]
- Updated dependencies [6074c26]
- Updated dependencies [24687a3]
- Updated dependencies [17f14be]
- Updated dependencies [87c4130]
- Updated dependencies [cb9e1ad]
- Updated dependencies [c038730]
- Updated dependencies [758e1e3]
- Updated dependencies [be624af]
- Updated dependencies [8572a5d]
  - @cotal-ai/core@0.19.0
  - @cotal-ai/workspace@0.19.0

## 0.18.0

### Minor Changes

- 0ab9b4d: Move the auth plane's retirement rail off the retired `ctl` surface onto the endpoint subjects

  The auth plane served its generic "retire a lifecycle" operation on
  `ctl.auth-admin.<owner>.<actor>`, a rail the spec retires in full and states must
  not be handled. Rows written onto a deleted rail are defects rather than
  exceptions to it, so the rail moves to
  `ep.one.auth.retire-lifecycle.handle.<target triple>.<caller triple>.<nonce>`
  instead of the cut growing a carve-out.

  Two things get stronger on the way. The reply is now derived from the parsed
  request, so there is no argument through which a caller- or payload-supplied
  reply target could arrive; and the request and reply planes are disjoint, so the
  listener credential cannot express a request subject at all. The per-despawn
  requester credential now pins both its caller triple and exactly one target
  incarnation, so a leaked requester cannot be re-aimed at another lifecycle.

  Serve-time authorization additionally requires that the serve registration a
  request names belongs to the requesting principal. The previous two-token
  subject could not express the caller beyond a recyclable alias, so the rail
  accepted any registered instance's registration. This is alias-level binding:
  the registration is keyed by an id that is stable across restarts and carries no
  lifecycle uid, so a same-principal predecessor presenting the current epoch is
  still accepted.

  The spec rows also described an authorization mechanism the implementation had
  already replaced, and now describe what ships.

  This is a subject-plane migration, not a completed endpoint migration. The rail
  carries the endpoint subjects but still exchanges the pre-v0.4 request and reply
  bodies, registers no service record, serves no `describe`, and has no contract
  artifact — so a generic endpoint client can neither discover nor invoke the
  command. That gap is tracked separately, with the acceptance test being that a
  generic client can do both. The one acceptance-path hole is closed here rather
  than deferred: the request carries an id, the reply echoes it, and a reply that
  does not echo is refused, so a wrong-id success cannot clear a retirement hold.

  The requester's grant pins its target with the `handle` mode, which is normatively
  redemption-minted. This path is not: there is no issuer-signed artifact, no
  redemption step, and no lineage — the row is built directly from the minting
  manager's coordinates under root authority. It is used because it is the only
  target mode that can pin an exact incarnation, and the serve-time handler
  re-checks that triple against the current mapping. This is a documented
  deviation, not compliant handle semantics, and it is stated at the mint site and
  in the ownership matrix row. It resolves with the same tracked work as the
  envelope, since the mode and the envelope are one wire-conformance surface.

### Patch Changes

- Updated dependencies [0ab9b4d]
- Updated dependencies [208ad1f]
- Updated dependencies [665b378]
- Updated dependencies [4d14037]
- Updated dependencies [f6b8b27]
- Updated dependencies [d361951]
  - @cotal-ai/core@0.18.0
  - @cotal-ai/workspace@0.18.0

## 0.17.0

### Patch Changes

- 14ff831: Stop reading another user's live process as dead.

  Asking the kernel about a process has three answers, not two: it is there, it is gone, or it is
  there but not ours to signal (`EPERM`). A two-state probe folds the third into "gone", and the
  caller then acts on a running process as if it had died.

  The repo already had a tri-state contract that gets this right, documenting itself as "consumed
  everywhere". Two production files imported it. Sixteen other production call sites probed inline,
  and **seven of the fourteen files handled `EPERM` correctly on their own while seven did not**, so
  this was a coin flip repeated fourteen times rather than one broken helper.

  Fixed, with the wrong answer named at each site:

  | site                       | what the old probe did                                                                        |
  | -------------------------- | --------------------------------------------------------------------------------------------- |
  | `manager-proc.managerUp`   | reported no manager, so `ensureManager` starts a second one onto a live one                   |
  | `delivery-proc.deliveryUp` | same, for the delivery daemon: two daemons on one fanout                                      |
  | `auth` `agent-bearer`      | "the user-auth service is not running, restart it with `cotal up`" about a service that is up |
  | `auth` provider            | same misread on the readiness path                                                            |
  | `cli ext`                  | printed "stale pidfile" about a live extension, which is advice to delete it                  |

  Both `up` functions also parsed their pidfile with `Number.isFinite`, which admits fractional and
  out-of-range values `process.kill` throws on. They now use the contract's bounded parser.

  The contract moved from `implementations/cli/src/lib/pid.ts` to `@cotal-ai/workspace`, the widest
  tier that may hold a local-process concept. **"Consumed everywhere" was never reachable and the
  claim hid the gap:** `extensions/*` peer-depend `core` only, and a pid probe is not a wire concept,
  so reaching them would mean leaking a local concern into the standard. The two extension-side
  probes keep their own copies by construction, and the module now says so instead of overclaiming.

  Presence questions require PROOF (`=== "alive"`); only destructive questions preserve on doubt
  (`!== "dead"`, which is why `down.ts` is written that way and is untouched). An earlier revision of
  this change had the presence sites preserving too, and review reproduced what that buys: a permanent,
  silent, retry-proof false-up, where the control plane reports `running: true` three times over
  against an unreachable manager. The demonstrated defect was `EPERM` alone, and widening past it was
  unforced.

  Covered by a new broker-free suite, `smoke:pid-contract`. The errno-to-state mapping is a pure
  exported function tested exhaustively, so there is no fixture to skip: the first revision reached the
  `EPERM` rule only by probing pid 1 and hoping the process was unprivileged, and as root or in a
  container that cell skipped while the suite still printed a passing banner over a deliberately broken
  implementation. The suite also drives the CONVERTED CALLERS through real pidfiles, because the first
  revision tested only the primitive and a reviewer inverted all five call sites without reddening a
  single check.

  `unknown` is REACHABLE on a real kernel, not merely under a test shim. A Linux seccomp
  `SECCOMP_RET_ERRNO` filter, or an LSM policy through `security_task_kill()`, can answer
  `kill(pid, 0)` with an arbitrary errno without executing it, and libuv preserves it. Review proved
  this with a live seccomp BPF filter and no interposition. So both ways of folding the third state
  into a boolean are wrong, and both fail SILENTLY: preserving reports a control plane that is not
  there and no retry clears it, while requiring proof launches a second manager over one that may be
  live.

  `ensureManager` and `ensureDelivery` therefore REFUSE on `unknown`, loudly, naming the pid, naming
  seccomp/LSM as the expected cause inside sandboxes, and saying what to check. `managerLiveness` and
  `deliveryLiveness` expose the state the booleans cannot carry; `managerUp`/`deliveryUp` remain
  `=== "alive"` for display, with a doc note sending any caller that ACTS on the answer to the
  tri-state.

  Honest coverage limit, stated in the suite's own output rather than implied away: no cell here
  exercises `unknown`, because no `parsePid`-accepted input produces one from this process. The refusal
  is verified by a seccomp BPF harness outside the suite.

- a74a768: Sandbox the temp root in the smokes that mint a mesh fixture there, so a `.cotal` left above the temp base (`/tmp/.cotal` on Linux CI runners) can no longer capture the fixture and make a suite grade a live mesh. One shared implementation in `bin/smoke/_scratch.ts`, used by `spawn-from-anywhere`, `down-target`, and both `ps` suites. The dead-manager cells now assert that the manager was found, was alive, and is dead, instead of skipping their own kill when the pid file is missing.
- Updated dependencies [975cad1]
- Updated dependencies [c76a49d]
- Updated dependencies [fd361fe]
- Updated dependencies [2768f5b]
- Updated dependencies [019afc3]
- Updated dependencies [3539f20]
- Updated dependencies [f85ffbf]
- Updated dependencies [141c4dd]
- Updated dependencies [14ff831]
- Updated dependencies [11cd652]
- Updated dependencies [9e13648]
- Updated dependencies [185e721]
  - @cotal-ai/core@0.17.0
  - @cotal-ai/workspace@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [531d37d]
- Updated dependencies [498055c]
  - @cotal-ai/workspace@0.16.0
  - @cotal-ai/core@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [f89560a]
  - @cotal-ai/core@0.15.0
  - @cotal-ai/workspace@0.15.0

## 0.14.11

### Patch Changes

- @cotal-ai/core@0.14.11
- @cotal-ai/workspace@0.14.11

## 0.14.10

### Patch Changes

- @cotal-ai/core@0.14.10
- @cotal-ai/workspace@0.14.10

## 0.14.9

### Patch Changes

- Updated dependencies [a4c082a]
  - @cotal-ai/workspace@0.14.9
  - @cotal-ai/core@0.14.9

## 0.14.8

### Patch Changes

- Updated dependencies [84f6200]
  - @cotal-ai/core@0.14.8
  - @cotal-ai/workspace@0.14.8

## 0.14.7

### Patch Changes

- Updated dependencies [12ad5e3]
  - @cotal-ai/workspace@0.14.7
  - @cotal-ai/core@0.14.7

## 0.14.6

### Patch Changes

- Updated dependencies [ed62069]
  - @cotal-ai/workspace@0.14.6
  - @cotal-ai/core@0.14.6

## 0.14.5

### Patch Changes

- @cotal-ai/core@0.14.5
- @cotal-ai/workspace@0.14.5

## 0.14.4

### Patch Changes

- @cotal-ai/core@0.14.4
- @cotal-ai/workspace@0.14.4

## 0.14.3

### Patch Changes

- Updated dependencies [fce3199]
  - @cotal-ai/workspace@0.14.3
  - @cotal-ai/core@0.14.3

## 0.14.2

### Patch Changes

- @cotal-ai/core@0.14.2
- @cotal-ai/workspace@0.14.2

## 0.14.1

### Patch Changes

- @cotal-ai/core@0.14.1
- @cotal-ai/workspace@0.14.1

## 0.14.0

### Minor Changes

- 7a46ce5: W4 multi-space-per-broker: split broker trust from per-space accounts and harden the broker-vs-space boundary.

  Broker trust (`operator` + system account) is now persisted once per broker in `auth/broker.json`, and each space keeps only its own data account in a flat, injective, case-safe `auth/account.<key>.json` beside it (`<key>` is hex of the space name, so two case-differing spaces can never collide on a case-insensitive filesystem). Core splits the provisioning surface to match: `createBrokerAuth` mints broker trust, `createSpaceAccountAuth(broker, space)` signs one tenant's account under it, and `serverConfig(broker, spaces, opts)` (breaking signature change) renders one operator with N space accounts.

  That same injective hex key now keys EVERY tenant-keyed namespace, not just the account file: the per-space user-auth state dir (`auth/space.<key>/`, with a one-time byte-exact rename of pre-hex layouts on first touch), the auth secret-store keys built over it (callout/issuer/owner-secret/service-keys), the machine mesh registry (`~/.cotal/meshes/space.<key>.json`, with legacy records swept on write/remove), and the auth-service pid/log files. Previously each of those case-folded, so `alpha` and `Alpha` could silently share state, registry records, and owner secrets. The hex key is injective only over well-formed strings, so the one builder now rejects a space name carrying an unpaired surrogate (which UTF-8 folds to U+FFFD, collapsing distinct names) before any key is derived. The auth-service pid/log files also carry a pre-hex-name upgrade path: `down`/`status` admit the old `auth-service.<encoded>.pid` byte-exact so an upgrade across the re-key never orphans the running user-auth callout signer, failing loud if both the old and new name are present.

  Broker-wide lifecycle operations (`down`, `clean store|all`, `backup`, `up --restore`, and the `clean restore-attempt|restore-fallback` recovery verbs) refuse on a root that hosts more than one space, naming the tenants they would have taken out, since none can be scoped to a single space. The tenant list is one validated inventory shared by the guards, `cotal status`, and the target resolver: each record's authoritative `space` must round-trip against its filename, and anything else occupying the account namespace (unparseable, mismatched, or a non-regular entry such as a symlink) counts as corrupt and makes the guards refuse rather than undercount.

  The broker record write is now two-sided fail-closed. `saveBrokerAuth` still refuses a different operator over an existing record; a same-operator system-account change is guarded by a persisted GENERATION with successor semantics: `rotateSystemAccount` bumps `BrokerAuth.gen` in memory and the write is accepted only as the direct successor of the current record, so a stale pre-rotation copy can never resurrect a retired `$SYS` (including one minted within the same second, where the JWT issue time cannot order the two; equal-generation writes with a different system account are refused, and only a byte-identical re-save is the idempotent no-op). The generation is runtime-validated on both sides and at the rotate step: only true absence reads as 0 (migration), while any present malformed value, explicit null included, refuses as a corrupt record. And with `broker.json` absent it refuses any operator that did not verifiably sign every existing account record (so a lost broker file cannot be "repaired" into orphaning the tenants; a same-operator restore still passes).

  The user-auth on-disk marker no longer keys on the bare existence of a path (which a space named `broker.json` or `creds` could alias into user-mode); it requires the provider's pin inside a real state directory, and the pin check is errno-disciplined: only ENOENT reads as absent, while EACCES and friends throw instead of silently flipping a user-auth space to static mode. The pre-hex state-dir migration refuses, rather than guesses, the one genuinely ambiguous case (a space literally named `space.<hex>`, whose legacy directory name is also another space's canonical segment).

  `cotal status` never crashes on trust material it cannot read: it reports the tenant list including corrupt records on a multi-space root, and frames any account record that will not load or compose (a malformed account JWT, or one signed by a foreign operator) as an unloadable record with repair guidance, exiting 0. Target resolution fails loud with a typed error rather than silently picking one tenant or crashing: an ambiguous-target on a multi-account root, on `--server` when the named broker's root holds several tenants on disk (one registered or not), and whenever the tenant list is unreadable; an unreadable-auth when a record cannot be composed into usable trust. The tenant inventory validates each record's account shape (so a semantically empty record is corrupt, not a phantom tenant), while the broker-binding check that a record cannot be validated without a broker stays at the consumer, keeping the broker.json-missing repair path from over-classifying every account as corrupt.

### Patch Changes

- 02b3243: feat(secret-store): move SpaceAuth (the signing authority) behind the SecretStore seam

  The space trust bundle (`.cotal/auth/auth.json`) is the last and highest-blast-radius durable secret kind. It now flows through the pluggable `SecretStore` seam, so a hosted composition injects its own KMS/Vault store and no signing seed lands on the hosted disk.

  - New `@cotal-ai/workspace` API: `getSpaceAuth(store, expectedSpace?)`, `putSpaceAuth(store, auth)`, `deleteSpaceAuth(store)`, and `SPACE_AUTH_KEY` (`auth/auth.json`), byte-for-byte the current local path under `workspaceSecretStore`. `getSpaceAuth` validates via the new `@cotal-ai/core` `validateSpaceAuthForRead`, which accepts both a full trust bundle (fully chain-validated) and a stripped signer projection (the `mint --signer`/container form — account keys validated structurally), and never echoes stored seeds/JWTs/space labels in errors. `putSpaceAuth` is the single `sys.signingSeed` strip site.
  - `remintDaemonCreds(root, expectedSpace, store?, { preflight? })` reads the signer through the same resolved store as the daemon cred; `expectedSpace` is required and validated against it. It never overwrites the last-good daemon cred with an unproven one: proof is a broker `preflight` (the manager's live probe, which gates every candidate when supplied) OR authority continuity (the candidate is signed by the same account key as the current broker-accepted cred — what the offline `doctor auth --fix` relies on). A same-label alternate account (full or stripped) is neither, so it is refused rather than clobbering the last-good.
  - The manager reads its signer from the injected `ManagerOptions.secretStore` (`getSpaceAuth(this.secrets, this.space)`); `up`, `mint`, `backup`, `restore`, `doctor`, `spawn`, and the delivery dev-mint helper go through the store. `loadSpaceAuth` remains the sync FS reader for name-only/presence callers and the static-auth single-machine mint composition.
  - `cotal clean all` deletes `auth/auth.json` through the store as its absolute-last step, so a partial-failure reset re-runs against the correct space.

  Closes "no signing seed at rest on a hosted disk"; the remaining hosted gap is signer isolation (the seed is still decrypted in-process at the manager's uid), not custody.

- Updated dependencies [02b3243]
- Updated dependencies [7a46ce5]
  - @cotal-ai/core@0.14.0
  - @cotal-ai/workspace@0.14.0

## 0.13.2

### Patch Changes

- Updated dependencies [c3afdaa]
- Updated dependencies [2ed747d]
- Updated dependencies [9625ec6]
- Updated dependencies [6960658]
  - @cotal-ai/core@0.13.2
  - @cotal-ai/workspace@0.13.2

## 0.13.1

### Patch Changes

- @cotal-ai/core@0.13.1
- @cotal-ai/workspace@0.13.1

## 0.13.0

### Minor Changes

- 5491661: v0.4 endpoint control surface: a breaking wire revision (SPEC section 13).

  Adds the endpoint control surface: the `ep` request rails and grant grammar, the
  message envelope and error catalog, the callable-service verbs, and the session
  and virtual-endpoint composites. Deletes the v0.3 `ctl` rail (the hard cut).
  Requires nats-server 2.12 or newer, since the auth marker store uses native
  per-message TTL; clients read the server version from the pre-auth INFO and fail
  loud below the floor.

  Completes the agent lifecycle end to end: registration, admission, despawn,
  retirement, and safe name reuse, backed by a lifecycle registry, a credential
  ledger, and a retirement barrier. Durables are keyed by lifecycle uid, so a
  manager-resumed agent recovers its original incarnation rather than re-minting,
  and readiness is incarnation-exact. The connectors forward the lifecycle uid into
  spawned children so a child joins as its intended incarnation.

  From v0.4 an AgentCard MUST advertise `protocolVersion "0.4"`; a participant that
  omits it is treated as pre-0.4 and is not addressed on the endpoint rails.

### Patch Changes

- Updated dependencies [5491661]
  - @cotal-ai/core@0.13.0
  - @cotal-ai/workspace@0.13.0

## 0.12.0

### Minor Changes

- 4e0e641: Add the pluggable `SecretStore` seam (core `get`/`put`/`delete` contract + filesystem default) and route the durable hosted secret kinds through it: the delivery daemon creds and the auth store's callout account, issuer keys, owner secret, and service-key projection. Local `cotal up` is unchanged (the workspace `.cotal`-rooted filesystem store lands byte-for-byte on the existing paths); a hosted composition injects its own backend via `runAuthService`/`runDelivery`. `AuthProvider` methods now take a caller-composed `store`, and the new required `deprovisionSecrets` plus `clean all`'s seam-first ordering make a full local reset safe against split authority.

### Patch Changes

- Updated dependencies [be66729]
- Updated dependencies [47d2584]
- Updated dependencies [4e0e641]
  - @cotal-ai/core@0.12.0
  - @cotal-ai/workspace@0.12.0

## 0.11.6

### Patch Changes

- Updated dependencies [7b24953]
  - @cotal-ai/workspace@0.11.6
  - @cotal-ai/core@0.11.6

## 0.11.5

### Patch Changes

- @cotal-ai/core@0.11.5
- @cotal-ai/workspace@0.11.5

## 0.11.4

### Patch Changes

- Updated dependencies [1935221]
- Updated dependencies [5634ae4]
  - @cotal-ai/core@0.11.4
  - @cotal-ai/workspace@0.11.4

## 0.11.3

### Patch Changes

- @cotal-ai/core@0.11.3
- @cotal-ai/workspace@0.11.3

## 0.11.2

### Patch Changes

- @cotal-ai/core@0.11.2
- @cotal-ai/workspace@0.11.2

## 0.11.1

### Patch Changes

- Updated dependencies [5b2863a]
  - @cotal-ai/workspace@0.11.1
  - @cotal-ai/core@0.11.1

## 0.11.0

### Minor Changes

- 9061d0e: feat: per-user authentication (owner+actor identity, IdP login, credential death)

  Add per-user auth as a first-class mesh mode. A mesh brought up with `cotal up --user-auth --idp <url>`
  authenticates humans against an identity provider and issues short-lived, ledger-scoped bearers through an
  auth callout, in place of long-lived static credential files.

  - **owner+actor identity.** An instance's wire identity becomes the two-token principal `(owner, actor)`:
    every subject carries the sender as `<owner>.<actor>`, and grants, durables, presence, and `from.id`
    re-key onto the pair. Cross-owner and same-owner cross-actor forge/read isolation is enforced by the
    broker; the connection nkey survives only as the transport credential.
  - **Login and delegation.** Humans sign in with `cotal login --idp <url>` (device-code); operators grant
    access with `cotal actor grant`. Agents are spawned under the signed-in human as managed `(owner, actor)`
    children whose scope is a subset of the spawner's (the delegation envelope rule). Agent identities live in
    a separate managed-actor ledger space, exchanged via their own per-agent secret, so they outlive the
    human's login session.
  - **Credential death.** Every managed credential is now lifetime-bounded, with supervisor and delivery
    standing renewal, `$SYS` rotation-renewal, live connection eviction on revoke, and a `cotal doctor auth`
    repair surface. On a user-auth mesh, static agent creds are retired (the flip): revocation closes the live
    window at the next connect.
  - **Elevated operator surfaces.** `cotal web`, `console`, `history clear`, `channels set/default`, and
    `spawn -f` come online in user mode via server-authored elevated view bearers, minted only by the
    signed-in human exchange and gated on ledger scope (`admin` / `spawn`); `ps` and `status` are
    owner-domain scoped.
  - **Connectors.** Add the `cotal_docs` tool (version-exact Cotal docs the agent reads natively) and an
    opaque `launchOptions` raw passthrough for the Claude Code, OpenCode, and Hermes adapters.

### Patch Changes

- Updated dependencies [9061d0e]
  - @cotal-ai/core@0.11.0
  - @cotal-ai/workspace@0.11.0
