# Claim ledger

Every substantive claim in `README.md`, labelled by what backs it. Written by the author of
those claims, so treat the labels themselves as claims.

- **M** — a cell exercises it against a live broker or real production code, and a named
  mutation reddens that cell.
- **M-nomut** — a cell exercises it, but it is a measurement of broker or grant behavior with no
  first-party logic to mutate. Its negatives rest on a positive control in the same cell.
- **A** — asserted. Reasoning from reading source, or a design or policy statement. No cell.

The **A** lines are where a review budget is best spent. Five started as **A** and became
cells while this page was being written: 7, 22, 23, 46 and 51. Each row that moved says so.

## Subject permissions

| # | Claim | | Backing |
|---|---|---|---|
| 1 | Native empty allow lists import as unrestricted, subject to denies | M | `issued-subject-permissions.smoke.ts`, native comparison cells |
| 2 | An empty requested list constructs deny-all and exports an explicit native deny | M | cell "an empty requested scope is denied and exports explicit deny-all"; mutations "empty requested scope is widened", "exported deny-all loses its native deny" |
| 3 | Deny beats allow | M | cell "denies override listed or unrestricted native allows"; mutation "native deny loses precedence" |
| 4 | Publish and subscribe are independent | M | cell "publish and subscribe are independent"; mutation "publish policy is reused for reads" |
| 5 | Caller input is snapshotted and deep-frozen | M | cell "normalization snapshots and deep-freezes caller input"; mutation "caller inputs are frozen instead of copied" |
| 6 | Dynamic reply permissions and queue-qualified subscriptions refuse rather than flatten | M | refusal cells in the same suite |
| 7 | Nothing here is exported from core or attached to issuance, registration or admission | M | census cell "no shipped source imports the prototypes"; mutation "the prototype-import scan looks for the wrong path". Was **A**; falsified by scan, found zero, then made a cell |
| 8 | Constructing a permission value does not prove an issuer granted it | A | definitional |

## Lifecycle

| # | Claim | | Backing |
|---|---|---|---|
| 72 | Release does not activate until the existing finalizer resolves | M | cell "release waits for the pending existing finalizer before activation"; mutation "existing finalizer is not awaited". The cell watches a bounded window; a single sample raced the writer and stopped discriminating when the branch was merged onto current main |
| 73 | Callout success stays private until the awaited issuer gate completes | M | cell of that name; mutation "issuer release is not awaited". Had the same single-sample shape as 72 and now watches a window too |
| 74 | No other cell in these suites samples once against a concurrent writer | A | audited after finding 72: the remaining absence assertions all sit after an awaited rejection, so nothing is in flight when they run. An audit by the person who wrote the cells |
| 9 | Activation uses the revision the prepare observed, not a re-read | M | cell "activation before the source walk is irreversibly revoked"; mutation "activation takes a fresh revision after abort" |
| 10 | An abort that wins the activation CAS prevents release | M | cells "source freeze before finalization releases nothing and aborts the attempt", "a winning source fence followed by prepared retirement loses activation" |
| 11 | Each source index ends in the generation, so a reused credential id cannot merge issuances | M | cell "two issuances of one root credential retain distinct generation indexes" |
| 12 | Resolution rechecks revocation after awaiting source authorization | M | cell of that name; mutations "resolution ignores source revocation", "resolution skips its final state check" |
| 13 | A failed attempt read is refused, never read as absence of a revocation | M | cell "an unreadable attempt row refuses instead of resolving"; mutation "an unreadable attempt row is read as active" |
| 14 | Revocation is separate from immutable evidence, so absence reads as `active` | A | design statement about the record split. Cells exercise the split; none asserts that this is the right representation |
| 15 | The second attempt read is the linearization point | A | naming of what cell 12 measures. The cell shows the recheck happens; calling it the linearization point is the contract's assertion |
| 16 | The index walk needs only the issued bucket, not operator reach | M-nomut | cell "the index walk runs on a least-privilege revoker credential, not an operator one"; positive control is the same credential being refused a read of the auth bucket |
| 17 | A revoker is trusted infrastructure, so its write-plus-raw-read pairing is acceptable | A | policy statement |
| 18 | This is not the production sealed-scanner discipline | A | read of `implementations/auth/src/ledger-scanner.ts` |
| 19 | A revocation that wins before the fence prevents release | M | cell "individual revocation between validation and finalization prevents release"; mutations "credential source touch is omitted", "credential source touch refreshes a revoked revision" |
| 20 | Released material is a synthetic marker, never a signed credential | M | visible in the fixture |
| 21 | The lost-ack cell injects an error after a real committed KV write, and does not partition a network | M | cell "lost activation acknowledgement releases nothing and retires committed state" |
| 22 | State survives a broker process kill and restart on the same file store | M | cell "issued state survives a broker process kill and restart"; mutation "activation is written to memory instead of the store". Was **A** and narrower ("object restart only"). A crash mid-write with unflushed data is still uncovered |
| 23 | Production revokers have no attachment to this fence | M | covered by the same scan as claim 7: `credential-release-fence.ts` lives under `smoke/prototypes`, and no shipped source imports that path |

## Static binding

| # | Claim | | Backing |
|---|---|---|---|
| 24 | A reference is returned only after native broker authentication | M | `connectIssuedStatic` connects before returning; cells "missing issued metadata cannot establish a static binding", "duplicate issued metadata cannot establish a static binding", "future issued metadata cannot establish a static binding", "malformed issued metadata cannot establish a static binding" |
| 25 | Metadata extraction and the authenticator share a private copy of the credential bytes | M | cell "native reconnect retains snapshotted credentials after caller-buffer mutation"; mutation "credential snapshot aliases a Buffer" |
| 26 | Replacing the credentials file takes effect only on a new explicit binding | M | cell "rewriting the credential file does not change a live connection binding" |
| 27 | A native reconnect keeps the original snapshot and generation | M | same reconnect cell |
| 28 | Two connections of one caller retain separate ceilings | M | cell of that name |
| 29 | Issued credentials carry no legacy request fallback | M | cell "new bound credentials have no legacy request fallback"; mutation "issued credentials retain legacy grants" |
| 30 | The accepted reference cannot be rewritten by the caller | M | cell of that name; mutation "accepted reference is mutable" |
| 31 | Same-credential reconnect does not prove callout remint under changed policy | A | statement of a limit |

## Discovery

| # | Claim | | Backing |
|---|---|---|---|
| 32 | `$SYS.REQ.USER.INFO` returns the server's own view including enforced allow lists, on NATS 2.14.5 | M-nomut | every discovery cell depends on parsing that response; the positive control is a conforming discovery returning the exact minted reference |
| 33 | No current profile can request its own server view | M | census cell of that name, with an in-cell positive control; mutation "the server-view detector stops matching" |
| 34 | A connection without that grant cannot discover its generation | M | static cell of that name |
| 35 | Therefore adding the grant is part of the issuance change | A | follows from 33 and 34, but is a conclusion, not a cell |
| 36 | An unrestricted publish ceiling names no generation and refuses | M | same static cell, second half |
| 37 | Two generations, a wildcard generation, or a malformed field refuse | M | cell "discovery refuses ambiguous or unbindable grant rows"; mutations "discovery accepts more than one bound generation", "discovery stops validating the parsed reference" |
| 38 | Foreign-space rows are ignored | M | same cell; mutation "discovery accepts rows from another space" |
| 39 | When a signed tag and the granted rows disagree, discovery follows the rows | M | cell "the client discovers its accepted generation from the server, not from its own credentials"; mutation "discovery reads the generation from the wrong subject position" |
| 40 | A callout client discovers the issuer's generation, not its proposal | M | cell of that name; mutation "discovery reports the client proposal instead of the accepted grants" |
| 41 | Discovery does not establish that a durable issuance record exists | A | statement of scope |
| 42 | The static discovery mints grant `_INBOX.>`, wider than production confinement | M | visible in the fixture |

## Renewal

| # | Claim | | Backing |
|---|---|---|---|
| 43 | An auto-reconnecting callout client fails closed rather than renewing in place | M | cell of that name |
| 44 | The refusal comes from the fresh-generation-only rule | M | mutation "issuance staging allows a generation to be re-prepared", which reddens the reuse cell that names that rule |
| 45 | A non-CAS staging write alone does not change the outcome, because an explicit read-then-throw refuses first | M | measured while retargeting mutation 44; the read-then-throw is visible in `stage` |
| 46 | A client observes the closure and rebinds on a fresh generation | M | cell of that name; mutations "a clean close is treated as an authority transition", "any closure reason is rebound as a transition". Was **A**. The transport-failure branch uses a hand-built closure result and says so in the cell |

## Migration

| # | Claim | | Backing |
|---|---|---|---|
| 47 | A legacy arrival is refused by the name `unbound-caller-authority` | M | cell "an endpoint serving both rails names the refusal for an unbound arrival"; mutation "a versioned arrival is read as legacy" |
| 48 | A malformed generation on the versioned rail throws, never demoted to legacy | M | cell "a malformed binding on the versioned rail is refused rather than read as legacy"; mutation "a malformed binding falls through to the legacy refusal" |
| 49 | Foreign-space subjects throw | M | same cell; mutation "arrivals from another space are admitted" |
| 50 | Both shapes are the ones the broker actually delivers | M | the cell waits for each subject to arrive on a live subscription before classifying |
| 51 | The generation sits one token from the tail for every rail mode | M | cell "the generation sits at one offset from the tail for every rail mode"; mutation "the generation is placed at a mode-dependent offset". Was the weaker **A** claim that the mode token is the only difference |

## Census

| # | Claim | | Backing |
|---|---|---|---|
| 52 | Every `Profile` name and every generic callout view is represented | M | cell "profile and view producers cover their declared sets"; mutations "one declared profile is omitted", "one generic callout view is omitted" |
| 53 | No current profile reaches the issued namespace | M | 42 per-variant cells plus 168 native decisions; mutation "production operator publication is widened" |
| 54 | No option combination can reach it, because no shipped builder emits `ep.v1` | M | cell "no shipped source emits an issued-rail subject, under any option combination"; mutations "the shipped-source scan skips a whole tier", "a shipped builder emits an issued-rail subject" |
| 55 | Sixteen write-plus-raw-read overlaps exist and all are trusted infrastructure or operator profiles | M | cell "the write-plus-raw-read detector finds the known trusted overlaps"; mutation "the raw-read overlap detector stops matching writes" |
| 56 | No peer-held profile holds that pairing | M | cell "no peer-held profile can both write and raw-read one stream"; mutation "a profile with a known overlap is treated as peer-held" |
| 57 | `agent` and `observer` hold raw reads on streams they cannot write, so their zero is a measurement | M | the detector reports their raw-read streams; the zero is the writability filter |
| 58 | The four profiles named peer-held are the right four | A | a judgement about which profiles reach an untrusted holder. Peer-heldness is a deployment property, so no cell in this repo can settle it |
| 71 | Every profile is classified peer-held or trusted, and a new one fails until classified | M | census cell "every profile is classified peer-held or trusted"; mutation "a new profile drifts into the trusted half" |
| 59 | A fenced serve mint adds no raw stream read | M | the composed census variant; and a read of `consumeBindRows`, which emits only `CONSUMER.INFO`, `CONSUMER.MSG.NEXT`, `$JS.ACK` |
| 60 | The fence that releases serve rows is covered by `endpoint-serve-auth.smoke.ts` | M-nomut | that suite was run in this lane: 108 passed, 0 failed |
| 61 | `CONSUMER.MSG.NEXT` is correctly out of the overlap check's scope | M | the ingress-origin matrix measured that its frame keeps the captured subject |

## Origin

| # | Claim | | Backing |
|---|---|---|---|
| 62 | A push `deliver_subject` does not reach the real wildcard queue serve shape | M-nomut | `issued-ingress-origin.smoke.ts`; positive control is a conforming request received on the same subscription |
| 63 | A pull `MSG.NEXT` reply reaches it, retaining its original captured subject, with a `$JS.ACK.` reply | M-nomut | same suite |
| 64 | A `STREAM.MSG.GET` reply reaches it under the rail subject with no marker | M-nomut | same suite |
| 65 | A `DIRECT.GET` reply reaches it under the rail subject with `Nats-` headers and raw stored bytes | M-nomut | same suite |
| 66 | Therefore no granted path delivers attacker-chosen, request-shaped bytes under the rail without a marker | A | a conclusion over 62 to 65 and over 70. Still the load-bearing assertion |
| 79 | `CONSUMER.CREATE` is its own class, because it creates a push consumer as well as answering an envelope | M | census cell "every broker grant a peer can hold has a decided delivery class"; the push path's own ground is the measured interest-gating in claim 62 |
| 80 | A stream create or update, which can carry `republish`, refuses rather than folding into an envelope class | M | same cell; mutation "a stream-configuring verb folds into an envelope class". No peer-held profile holds one today |
| 81 | Every cell and mutation this page cites resolves to a name that exists | M | census cell "every cell and mutation the claim ledger cites still exists"; mutations "a ledger citation names a cell that no longer exists", "the citation extractor reads surrounding prose as a citation". Four citations were stale when the check was added: three truncated, one collapsing a four-cell family into one unsearchable name |
| 82 | The classifier decides every stream, consumer and direct verb the installed client library can call | M | census cell "every API verb the client library can call is classified or refused"; mutations "the legacy consumer-create door is treated as an envelope", "a delivery-configuring verb is dropped from the pairing". 19 verbs read out of the library source, 8 classified and 11 refused; `CONSUMER.DURABLE.CREATE` is the legacy spelling of `CONSUMER.CREATE` and creates the same push consumer, so the delivery-configuring set is derived from the verb names rather than typed |
| 70 | Every `$JS.` or `$SYS.` grant a peer-held profile holds falls into one of five delivery classes, and an unknown verb refuses | M | census cell "every broker grant a peer can hold has a decided delivery class"; mutations "an unclassified JetStream grant is waved through", "a raw stored read is classified as an API envelope" |
| 76 | The client can read its accepted generation from an issuer-written row scoped to its own key, and another client's row is refused | M | static cell "a client can read its accepted generation from its own row instead of the server view"; mutations "the accepted read grant covers every client's row", "an accepted-row token can be redeemed twice" |
| 78 | A ceiling carrying the contract's own discovery grant introduces no write-plus-raw-read overlap | M | census cell "a ceiling carrying the contract's own grants adds no write-plus-raw-read overlap", with an in-cell control that the opposite pairing is still caught; mutation "the candidate issued stores are not modelled" |
| 77 | That read is marked and the `$SYS` response is not, so only one of the two can be refused at ingress | M-nomut | the ingress matrix measured `DIRECT.GET` arriving with `Nats-` headers and the `$SYS` response arriving with none |
| 75 | The `$SYS.REQ.USER.INFO` grant the contract adds is itself an unmarked delivery path onto the rail | M-nomut | ingress cell "the discovery grant the contract adds is itself a delivery path onto the rail": it reaches the real serve shape, under the rail subject, with no headers, carrying the connection's own ceiling |
| 67 | The condition that would break it is one credential holding a write and a raw read on one stream | M-nomut | ingress cell "the condition the census forbids does put attacker-chosen bytes on the rail": a synthetic credential with both writes a request-shaped document, reads it back with the reply naming the rail, and the frame arrives under the rail subject with exactly those bytes. Was **A**. Only the `Nats-` markers separate it from a forged request |
| 68 | Marker-based refusal cannot cover the `STREAM.MSG.GET` path | M | follows directly from 64: there is no marker to refuse on |
| 69 | The durable fix is the mediated-read rule scoped for v0.4 | A | design position |

## Where I would attack this

Claim 67 was asserted when this page was first written and is now demonstrated: the forbidden
pairing really does put caller-chosen bytes on the rail. That makes the census invariant in claim
56 a guard on a shown failure rather than a suspected one, and it makes the marker set the whole
remaining margin.

Claim 66 is the load-bearing one and it is still an **A**, but it is narrower than it was. It
used to quantify over a set of four paths I picked by hand. Claim 70 now enumerates every `$JS.`
grant a peer-held profile holds and forces each into a delivery class, so a new grant with an
unclassified verb fails rather than silently widening the set. What remains asserted is that the
four classes are exhaustive of how a grant can put bytes on a chosen subject, and that each class
fails the forgery on the ground stated for it. Claim 67 has the same shape: it names the breaking
condition from reasoning, and claim 56 then guards that condition, so a wrong 67 means the guard
protects the wrong thing.

Claim 58 decides which profiles count as peer-held, which is what makes 56 meaningful. It is
still a judgement with no cell behind it, and it cannot have one: whether a credential reaches an
untrusted holder depends on how a space is deployed, not on this repo. Claim 71 only stops the
partition from drifting silently. If you think one of the twenty-eight trusted profiles can reach
a peer, say which, because that is the shape of a real finding here.

Claim 74 is the newest **A** and the least comfortable: it is my own audit of my own cells for the
shape that claim 72 turned out to have. Two instances found, both fixed. A third would not
surprise me.

Claim 7 was an **A** when this ledger was first written, with the note that it would be cheap
to falsify and that I had not tried. I then tried: zero shipped files import the prototypes, and
it is now a cell with a mutation. That is the only claim on this page whose label has moved.
