# Segmenting root-scoped material per space (P7, then P1)

APPROVED as a plan. The questions the first draft left open are settled in §7. The probe of §6 has
RUN and its finding is folded in below; series P7 commits 1 (the shared foundation) and 2
(`repairAdvice` honesty) are implemented, and nothing else here is.

P7 and P1 in [per-space-lifecycle](./per-space-lifecycle.md) §7 are one defect in two places: material
that is per-tenant in MEANING sits at a root-scoped path or store key, so a root holds one tenant's
copy of it. The two are planned together because the design questions they raise are the same
questions, and answering them twice is how the two halves drift. They ship apart, because the
material behaves differently at runtime.

The shared design is §2 and §3. The separate series are §4. What each segmentation must carry with
it is §5. §6 is the probe, now executed, and its finding is a design input to the refusal wording.

## 1. The two inventories

P7, the `$SYS`, membership and delivery material, all at `<root>/.cotal/`:

| material | today | writer | class |
| --- | --- | --- | --- |
| `membership-observer.creds` | raw FS, `SYSTEM_CREDS_FILES[0]` | `up.ts:2913`, `system-rotation.ts:126` | `$SYS`, rotation-renewed |
| `connection-evictor.creds` | raw FS, `SYSTEM_CREDS_FILES[1]` | `up.ts:2915`, `system-rotation.ts:127` | `$SYS`, rotation-renewed |
| `membership-rw.creds` | store key `MEMBERSHIP_RW_CREDS_KEY` | `up.ts:2914`, `up.ts:2886` | DATA account, remintable |
| `membership.json` | raw FS | `up.ts:2916`, `up.ts:2891` | non-secret account id |
| `delivery.creds` | store key `DELIVERY_CREDS_KEY` | `delivery-proc.ts:164` | DATA account, remintable |

`delivery.creds` is in this table by the orchestrator's decision on §3.2, which see for why the
grammar could not have covered one member of `REMINTABLE_DAEMON_CREDS` and not the other.

P1, the per-agent standing secrets, all under `agentCredsDir(root)` = `<root>/.cotal/auth/creds`
(`auth-paths.ts:241`): `<name>.creds`, `<name>.actor-token`, `<name>.sentinel.creds`, their
per-incarnation `<name>.<lifecycleUid>.*` counterparts, and the non-secret `<base>.auth-health.json`.
Store keys are `auth/creds/<basename>` (`auth-paths.ts:283-296`).

What already landed is the idiom both must copy: the split auth records are keyed
`auth/<spaceSegment>/callout.json` and siblings (`implementations/auth/src/store.ts:58-61`), through
the one guarded encoder `spaceSegment` (`auth-paths.ts:81`) and its inverse `spaceFromSegment`
(`auth-paths.ts:90`). One encoder is deliberate: the encoder's own comment records that two
independently-guarded encoders were the defect generator. Neither series adds a second one.

## 2. Migration for roots that already exist

The answer is the same for P7 and P1, and it is MOVE ON FIRST TOUCH at a single choke point, not
read-fallback.

This is not a new invention. `userAuthStateDir` (`auth-paths.ts:111`) already does it for the pre-hex
user-auth state dir: every consumer of that material obtains its path from that function, the
function renames the legacy dir to the canonical segment before returning, and the comment states
the reason read-fallback was rejected. A fallback leaves flows able to read, or worse to
`ensure*`-REGENERATE, beside material the old layout still holds. That hazard is sharper for both of
our inventories than it was there, because both have absent-means-mint writers: `up.ts:2885` and
`up.ts:2889` mint when the key or file is absent, and a fallback-less canonical read on an
unmigrated root reads absent and mints a SECOND live cred beside the one the daemons are using.

The rules, taken from that prior art and applied to both series:

1. **One choke point per kind.** A resolver function owns the path or key, performs the migration,
   and returns the canonical location. No consumer builds the location itself. For P7 this is a new
   resolver per kind; for P1 it is `agentCredsDir` and the key builders, which gain a space.
2. **The move is a rename**, so it is atomic per kind. A crash leaves each kind wholly legacy or
   wholly canonical, never half-written. This holds under the local FS composition, where a key IS a
   path. It does NOT extend to a hosted store, where the same move is a get, put and delete with no
   atomicity across the three; that is not a gap, because a hosted composition provisions these keys
   externally and re-keys by the coordinated change of §3.1 rather than by migrating in place. The
   resolver's migration path is therefore FS-composition only, and must assert that rather than
   assume it.
3. **Ambiguity refuses, loudly.** `migrateLegacyUserAuthState` refuses in two cases rather than
   guess (`auth-paths.ts:159` and `:163`): the legacy name is also another space's canonical
   segment, and both locations hold material so neither is provably current. The second applies
   directly to us and is the one that matters: canonical AND legacy both present means a partial
   migration we cannot arbitrate, and it refuses.
4. **The resolver refuses to migrate on a root holding more than one space**, loudly, naming the
   remedy. This is the rule that makes the choke point complete on its own, and it does not
   duplicate §2.1's door.

The reason rule 4 is not redundant is that migration on a multi-tenant root is worse than the defect
it is trying to end. The root-scoped copy belongs to whichever tenant booted first and nothing
records which that was, so a resolver that migrates it writes it into the segment of the tenant that
happens to be BOOTING. That LAUNDERS the inheritance squat into named authority: today the squat is
ambient and legible as a root-scoped file, afterwards it is a file whose path asserts an owner that
may be wrong. Manufacturing false attribution is a worse end state than the ambient squat, and it is
irreversible in a way the squat is not, because the evidence that the attribution was a guess is
gone once it is written.

Rule 4 also closes a hole §2.1's door cannot. A door is a check at one moment; it cannot hold
retroactively. A backup of a pre-segmentation multi-tenant root, restored after P7 ships, recreates
the population at any later date and never passes through `space add` at all. With rule 4 the
restore path lands in the same refusal at first touch, for free and with no restore-specific code.

The remedy rule 4 names was left unwritten in the draft because it must not point an operator at a
repair that itself refuses on a multi-tenant root. The §6 probe has now settled that, and the answer
is that on such a root NO repair command exists to name. So rule 4's refusal states a truth instead
of issuing an instruction: it names the tenant count, says the root-scoped copy's owner is not
recorded anywhere, says in as many words that there is no command to offer because
`up --rotate-sys` is broker-wide and refuses on this root too, and stops. An operator who reads it
learns the real state rather than being sent to a verb that will refuse them.

### 2.1 Half-segmented roots, and the two guards that cover them

A half-segmented root is the state to design against, and the useful observation is that it has two
distinct causes with different answers.

Cause one is a crash mid-migration ACROSS kinds: `membership.json` moved, `membership-rw.creds` did
not. Rule 2 makes each kind individually consistent and rule 1 makes each kind migrate on its own
first touch, so this state is self-healing on the next `up`. It needs no repair verb.

Cause two is the one with teeth: **legacy material on a root that now holds more than one tenant is
unattributable.** Segmenting means writing the owning tenant's name into the location, and on a
multi-tenant root nothing on disk records which tenant the root-scoped copy belongs to. It belongs
to whichever tenant booted first, which is P7's inheritance defect and is recorded nowhere. Guessing
would either hand tenant A's live observer to tenant B or strand it.

So the migration is only sound while the root holds ONE space, and that is enforceable at the source
rather than left as a hazard. `up` cannot create the second tenant (`ensureRootForSpace` refuses at
`up.ts:2233`), so the only door is `space add`. The rule:

> `space add` refuses on a root that still holds unmigrated legacy material for any segmented kind,
> and names the remedy: run `cotal up` for the sole tenant once, which migrates it, then add.

This keeps cause two from being CREATED, and it costs one inventory check in a verb that is already
taking the lock and reading the inventory (the lifecycle doc's §2.1 step 1).

It does not, on its own, keep cause two from being ENCOUNTERED. The door narrows
it but does NOT empty it: "empty by construction" would hold only for roots that never bypass the
door, and two populations bypass it. Roots that were already multi-tenant when P7 lands never pass
through `space add` again, and a backup of such a root can be restored at any later date. Both boot
straight into the resolver. Rule 4 of §2 is what catches them, which is why that rule and this door
are one design and neither is sufficient alone: the door keeps NEW unattributable roots from being
created, rule 4 keeps EXISTING ones from being silently laundered.

Roots that never grow past one space are untouched by both: they migrate on first touch and see no
refusal.

## 3. The SecretStore key grammar

Three grammars are in the store today: flat kind keys where the key IS the filename under `.cotal/`
(`DELIVERY_CREDS_KEY` = `delivery.creds`, `MEMBERSHIP_RW_CREDS_KEY` = `membership-rw.creds`,
`renewal.ts:30` and `:35`), the segmented auth records `auth/<spaceSegment>/<kind>.json`, and the
agent keys `auth/creds/<basename>`. All three are relative paths under `.cotal/` that the FS
composition resolves directly, so slashes already work and a segment is a directory component.

The rule, one sentence, identical for both series:

> Insert the one `spaceSegment` as a path component at the FIRST level that is per-tenant, and never
> at a level whose contents another owner treats as opaque.

The second clause is what decides the two placements, and it is not cosmetic. `.cotal/auth/space.<hex>`
is the user-auth state dir, whose contents the auth provider owns and workspace treats as opaque
(`auth-paths.ts:98-103`). Putting either inventory inside it would place our files in a namespace
another component enumerates and may prune. So:

- **P7** goes to a NEW per-space area, `.cotal/space.<hex>/`, a sibling of `auth/` and `run/`,
  holding all five kinds. The two store keys become `space.<hex>/membership-rw.creds` and
  `space.<hex>/delivery.creds`.
- **P1** puts the segment INSIDE the existing creds dir: `.cotal/auth/creds/space.<hex>/<base>.<kind>`,
  key `auth/creds/space.<hex>/<basename>`. This keeps `auth/creds` a reserved sibling of the auth
  dir, which the encoder's collision guarantee names and which `migrateLegacyUserAuthState:133`
  excludes by that name, so neither statement has to be rewritten.

`spaceSegment`'s documented guarantee today enumerates the reserved siblings of the AUTH dir only.
P7 extends the namespace it must not collide in to the `.cotal/` children. That holds today (no
`.cotal` child begins with `space.`; the nearest is `auth-service.<spaceKey>.pid`), but it holds by
accident until a test says so, so the shared commit extends the comment and adds the guard.

### 3.1 What the re-key touches beyond the FS

`MEMBERSHIP_RW_CREDS_KEY` is not only a filename. It is an entry in `REMINTABLE_DAEMON_CREDS`
(`renewal.ts:62`), which `remintDaemonCreds` (`renewal.ts:111`) iterates for the manager and for
`doctor auth --fix`, reading and writing through an INJECTED store so a hosted composition renews
from the same store the daemon reads. Two consequences the implementation must carry:

1. `REMINTABLE_DAEMON_CREDS` is a static array of literal keys. Once a key carries a segment, the
   entries become builders of the form `(space) => key`. `remintDaemonCreds` already takes
   `expectedSpace` as a REQUIRED positional, so the space is in hand at every call site and no
   signature grows.
2. `RemintResult.file` is how a remint result is mapped back to a daemon component. The mapping is a
   literal key comparison — `manager.ts:1147` reads `r.file === DELIVERY_CREDS_KEY` to attribute a
   fingerprint to `expected.delivery` — so a `file` carrying a segment matches nothing and the
   manager silently stops attributing renewals. `file` must keep reporting the KIND, not the
   segmented key, and the same holds for the operator-facing strings in `doctor auth`, which would
   otherwise start printing hex.

A hosted composition provisions these keys externally, so the re-key is a coordinated change on that
side. That is the reason the grammar is settled once, here, before either series starts.

### 3.2 `delivery.creds` rides P7

`DELIVERY_CREDS_KEY` sits in the same `REMINTABLE_DAEMON_CREDS` list, at the same root scope, and is
space-scoped material by the same argument: `remintDaemonCreds`'s own contract validates the store's
signer against `expectedSpace` because a wrong-space signer would re-sign a cred the space's broker
rejects (`renewal.ts:89-95`). It carries the same inheritance exposure as `membership-rw.creds`.

P7's scope as briefed was the `$SYS` pair, `membership.json` and `membership-rw.creds`. The
orchestrator has widened it: **`delivery.creds` segments with P7.** One list, one grammar, one class
of live material. The alternative, naming it a known-unsegmented sibling with its own prerequisite,
is strictly worse by the argument above, because it would leave `REMINTABLE_DAEMON_CREDS` holding
one segmented and one flat key and make the `(space) => key` change of §3.1 a per-entry special case
rather than a property of the list.

Consequences carried by the P7 series rather than by this plan: the inventory table of §1 gains its
row (done), the lifecycle doc's §7 P7 entry gains `delivery.creds` alongside the pair, the account id
and the rw cred, and the removal sites of §5 include the ones that are `delivery.creds`-specific.

## 4. Two series, P7 first

P7 first, because its material is LIVE: the daemons read the observer, evictor and rw creds at
runtime, and the inheritance defect is a correctness bug on a multi-tenant root today (the second
tenant runs the first tenant's membership bundle, §5 of the lifecycle doc). P1's material is, by that
doc's own §2.2 account, broker-dead disk residue once the account leaves the resolver. Correctness
before residue, and the live series gets the idiom scrutinized under the higher stakes.

P1 second, consuming the shared foundation unchanged. If P1 needs the foundation to bend, that is a
signal the foundation was wrong for P7 too, and it comes back here rather than growing a second
idiom in the P1 series.

**Series P7**

0. The probe of §6, BEFORE the series starts (§7.3). DONE — its outcome fixed the remedy wording that
   rule 4 and §2.1 both name, so it was a precondition of commit 1 rather than a step in it.
1. Shared foundation: extend `spaceSegment`'s collision guarantee to the `.cotal/` children with a
   guard test, add the choke-point migration helper generalized from `migrateLegacyUserAuthState`
   carrying rules 1 to 4 of §2, and add the `space add` refusal from §2.1. No material moves in this
   commit.
2. `repairAdvice` honesty (§7.5). DONE. `sys-creds.ts` printed a repair its own guard refuses on
   exactly the roots that need it; it now ASKS `assertSingleSpaceBroker` whether the command would
   run and, where the guard refuses, quotes the refusal and states that no other command mints the
   pair. Asking the guard rather than counting tenants is the whole of the fix: a count is a second
   implementation of the single-space rule, and it reads "one" on the corrupt-inventory root where
   the guard fails closed. `SysCredsSource` became a union so a workstation source cannot exist
   without the root the question needs. The §6 probe is PROMOTED to a gated hermetic suite in this
   same commit as `implementations/delivery/smoke/sys-repair-honesty.smoke.ts`, reworked to assert
   the FIXED advice and the advice↔guard biconditional rather than the contradiction it was written
   to capture, with a mutation config whose corrupt-root cell is the one a count-based fix fails.
3. Segment the five P7 kinds behind their resolvers, with the removal-list changes of §5 in the SAME
   commit. `provisionMembershipCreds` (`up.ts:2903`) and `healMembershipDataCreds` (`up.ts:2881`)
   both write through the resolvers, and `REMINTABLE_DAEMON_CREDS` plus the `clean.ts:226` list take
   the `(space) => key` shape of §3.1.
4. The `space rm` step 7 reap of the now-segmented `$SYS` creds, which §2.2 step 7 of the lifecycle
   doc already promises "once those are keyed per space (P7)". `space rm` is not a command yet, so
   this lands as a GUARANTEE PLUS DOOR like commit 1's `assertNoUnsegmentedLegacyMaterial`: the verb
   cannot be written without it. It splits in TWO along §2.2's point of no return —
   `assertSpaceMaterialReapable` at step 1, where refusing is still free, and `reapSpaceMaterial` at
   step 7, which cannot refuse and cannot throw because a throw past step 5 strands the journal entry
   and recurs identically on every re-run, so the removal a crash is supposed to be able to finish
   could never finish. Seam failures are returned, per `remintDaemonCreds`'s posture. The reap is a
   DELETER (§3.1) and so addresses `segmentedKey`, never a resolver, and it removes one segment
   rather than `.cotal/space.*`, since unlike `clean` it runs on a root other tenants keep using.
5. The lifecycle doc's §7 P7 entry gains `delivery.creds`, per §3.2.

**Series P1**

1. `agentCredsDir` and the key builders take a space; `agentSecretKeysUnder` reads one level deeper;
   `agentSecretKeyForFile` needs the space to build a key and its signature changes with it. Removal
   lists in the SAME commit, per §5.
2. `space rm` reaps one tenant's agent secrets, retiring the residue paragraph at §2.2 of the
   lifecycle doc (lines 91-95) and the sentence in §7's P1 entry that records `agentCredsDir` as
   taking no space.

## 5. Removal lists land with their segmentation

A constraint, not a preference: every commit that segments a kind carries that kind's removal-list
change. Segmenting a location while a sweeper still names the old one is how material becomes
unreapable, which is the failure P1 and P7 exist to end.

The affected sweepers:

- `clean.ts:226`, the store-seam sweep, which deletes the migrated kinds through the
  `SecretStore` — a literal two-element list, `[DELIVERY_CREDS_KEY, MEMBERSHIP_RW_CREDS_KEY]`. Both
  members are now P7 material, so this list is segmented in the P7 series and is the same
  `(space) => key` change as `REMINTABLE_DAEMON_CREDS` in §3.1. It is a SEPARATE list from the raw
  one below and is easy to miss, because `clean.ts:268` explains that these two kinds deliberately do
  NOT appear there.
- `clean.ts:272-279`, the identity-derived raw removal list, which names `SYSTEM_CREDS_FILES` at
  `:276` and `membership.json` at `:277`. Both become per-space enumerations. The comment at
  `clean.ts:265-268` records a deliberate "keep in sync with `provisionMembershipCreds`" coupling and
  is updated in the same commit, because the coupling it describes is what this constraint enforces.
- `delivery-proc.ts:211` and `:214`, the daemon-stop deletes of `DELIVERY_CREDS_KEY`, which are
  `delivery.creds`-specific and are pulled in by the §3.2 widening.
- `clean.ts:243-250`, the `agentSecretKeysUnder` sweep, for P1.
- `space rm` step 7 (`per-space-lifecycle.md` §2.2, lines 77-79), which is where a per-space reap
  becomes reachable at all.
- `deleteSpaceAccountAuth` (P4) is adjacent but not blocked by either series and is not pulled in.

## 6. Probe: a multi-tenant root ends up with NO observer and NO reachable repair

**EXECUTED and CONFIRMED**, hermetically, 19 assertions with 5 positive controls. The prediction held
and the executed form is stronger than the prediction: the product does not merely lack a repair, it
PRINTS one that its own guard refuses.

The delivery daemon's workstation repair advice (`sys-creds.ts:47`) is

> re-mint it with `cotal down` then `cotal up --rotate-sys`

and the guard those two verbs run (`system-rotation.ts:96`) answers, on a two-tenant root:

> a system-account rotation (`cotal up --rotate-sys`) is broker-wide, and this broker hosts 2 spaces
> (alpha, beta) - it would apply to every one of them, and naming a single space cannot scope it; a
> per-space form does not exist yet

Both advised verbs refuse, and the refusal names the missing remedy, which is this series. The probe
also established that the `$SYS` pair has exactly TWO writers in the whole tree —
`provisionMembershipCreds` (fresh-only, one call site `up.ts:2692`) and `rotateSystemCreds`
(`system-rotation.ts:126-127`, guarded) — that the daemon REPORTS the incomplete bundle rather than
degrading silently (`loadSysPair` names both missing keys; `evict-exec.ts:101-108` throws), and that
`REMINTABLE_DAEMON_CREDS` excludes the pair by design, so the standing renewal owner can never
repair it either.

One leg was proved structurally rather than dynamically and the substitution is recorded rather than
glossed: "no `up` of either tenant mints an observer" could not be driven, because both membership
functions are module-private and the minting path needs a live broker. The exhaustive
writer-inventory above is the structural equivalent, and it is asserted from source inside the probe
so drift breaks the probe rather than silently invalidating the claim.

This is a second, distinct P7 failure mode, and it is the intersection of P7 and P8 rather than
either alone. It stays out of the lifecycle doc, whose §5 records the inheritance mode: the
advice-contradiction half is being filed upstream separately as a reachable operator-facing bug on
main today.

The reasoning that produced the hypothesis: `provisionMembershipCreds` mints the `$SYS` pair only in the
fresh-space branch (`up.ts:2903`, called once at `up.ts:2692`), because the `$SYS` signing seed
exists only there. `healMembershipDataCreds` (`up.ts:2881`) repairs the DATA half only, by
construction and by its own comment. So a root whose first tenant was provisioned before the
membership feature, or whose `$SYS` pair was swept by `clean`, has no minting path: the first tenant
is not fresh so the provisioner never runs, the second tenant is refused by `up.ts:2233` before it
could be fresh, and the documented repair `up --rotate-sys` is `assertSingleSpaceBroker`-guarded
(`system-rotation.ts:96`) and refuses on a multi-tenant root, which is P8. The predicted state was
BOTH tenants with no observer and no reachable repair.

It ran BEFORE series P7 started, not before its commit 2 (§7.3), because its outcome was an input to
the foundation commit rather than a check on it: §2 rule 4 and §2.1 both have to name a remedy to an
operator on a multi-tenant root, and `up --rotate-sys` is not that remedy, because it refuses on
exactly the roots being addressed. Writing the refusal text first and probing after would have meant
shipping advice that cannot succeed, which is the same defect `healMembershipDataCreds`'s own comment
records (`mintMembershipObserverCreds` named a rotation as its fix, and the rotation never called the
provisioner). That is why rule 4's refusal states a truth and offers no command.

The form: a two-tenant root built the way `space add` would build one, with the `$SYS` pair absent
from the start, each of five legs carrying its own positive control so a leg that reads negative
because the harness never provisioned anything is distinguishable from the finding. The probe was
promoted in commit 2 and no longer exists as a probe: it is now
`implementations/delivery/smoke/sys-repair-honesty.smoke.ts`, gated as `smoke:sys-repair-honesty`,
holding the same four-root construction turned around to assert the FIXED advice. As the probe was
written it asserted the contradiction, so it would have gone red under the fix; keeping both would
have left a red artefact in the tree asserting a defect that no longer exists.

## 7. Decisions taken

The first three were open in the first draft; 4 and 5 were opened by the §6 probe's result. All are
settled by the orchestrator.

1. **`delivery.creds` rides P7** (§3.2). One list, one grammar; the sibling-prerequisite option was
   rejected because it splits `REMINTABLE_DAEMON_CREDS` across two grammars.
2. **The `space add` refusal is confirmed** (§2.1), conditional on §2 rule 4 completing it. The
   condition is the substance of the review: the door alone was claimed to empty the
   unattributable-material population "by construction", and it does not. It keeps that population
   from being CREATED; roots already multi-tenant when P7 lands, and backups of them restored
   afterwards, bypass the door entirely and boot straight into the resolver. Rule 4 catches those,
   and without it the resolver would launder an ambient inheritance squat into false named
   attribution, which is worse and irreversible.
3. **The §6 probe runs before series P7 starts**, not before commit 2, because the remedy wording in
   rule 4 and §2.1 depends on its outcome. DONE; the outcome is recorded in §6.
4. **Rule 4's refusal states a truth, not a command.** The probe settled that on a multi-tenant root
   there is no repair verb to name, so the refusal says that segmentation must land before this
   material can be reminted here rather than sending an operator to a verb that refuses. Naming an
   unactionable command is the very defect §6 found in the product; the refusal must not repeat it.
5. **`repairAdvice` honesty is its OWN commit**, series P7 commit 2, ahead of any material move. The
   contradiction §6 found is reachable on main today and is independent of segmentation, so it is not
   held hostage to the kinds moving. The probe is promoted to a gated suite in that same commit, so
   the fix and the assertion that it holds land together and CI keeps them consistent. DONE.

Nothing in this plan is open. Series P7 commits 1 (the shared foundation) and 2 (`repairAdvice`
honesty) are implemented; commits 3 to 5, and all of series P1, are not.
